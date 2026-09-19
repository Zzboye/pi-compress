import { countTokens } from "./util.js";
import { renderTurnText, type LedgerData } from "./ledger.js";
import type { AgentMessage } from "./types.js";
import type { SummarizerBackend } from "./summarizer.js";
import type { ContextCompressConfig } from "./config.js";
import { compressEnds, mergeDescribe } from "./degrade-llm.js";

export interface DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 | 5 }

export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, toLevel) 列表，最旧优先 */
  steps: DegradeStep[];
  /** L5 合并组：每组为一段连续需合并的 turnStartEntryId（相邻即同组，描述由 mergeDescribe 生成） */
  mergeGroups: string[][];
}

/** 单个 turn 在其 level 下渲染后的估算 tokens（与装配渲染同一文本来源） */
export function turnRenderTokens(ledger: LedgerData, index: number): number {
  const text = renderTurnText(ledger, index + 1);
  return countTokens({ role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage);
}

/**
 * 层内从最旧开始选中条目：保持尾部 ≥ reserve 的硬下界（选中下一条前先检查剩余是否仍达标）。
 * 按条整体选中，不拦腰截断；若保留区不可满足（选任何一条都击穿 reserve），
 * 仍强制选最旧一条保证降级有进展。total ≤ threshold 时返回空。
 */
export function chooseOldestForLevel(
  ledgers: LedgerData[], level: 1 | 2 | 3 | 4, threshold: number, reserve: number,
): LedgerData[] {
  const inLevel: Array<{ l: LedgerData; tokens: number }> = [];
  let total = 0;
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    if ((l.level ?? 1) !== level) continue;
    const tokens = turnRenderTokens(l, i);
    inLevel.push({ l, tokens });
    total += tokens;
  }
  if (total <= threshold) return [];
  const chosen: LedgerData[] = [];
  let acc = 0;
  for (let i = 0; i < inLevel.length; i++) {
    const { l, tokens } = inLevel[i];
    if (chosen.length > 0 && total - acc - tokens < reserve) break; // 选中会击穿保留区 → 硬下界生效
    chosen.push(l);
    acc += tokens;
  }
  return chosen;
}

/**
 * 逐层瀑布：L1→L2→L3→L4→L5（Task 2 右移一层）。L1 降级产生的新 L2 条目立即计入 L2 的 total
 * （下层计量基于降级后快照）。holdAt4 中的条目豁免 L5（进行中 turn 的溢出片段：L5 合并收益
 * 为零而拒绝召回是实害，spec 裁定 7）→ 不生成 toLevel=5 step、不入合并组，终态 L4。
 * 被豁免的片段仍参与各层 total 与 reserve 计量（保守方向：只少选不超降——豁免只挡
 * toLevel=5 step，不影响选中量，保留区不会因此被超卖）。
 * 不修改入参（在副本上推演），每轮 agent_settled 只做一遍瀑布，
 * 超量部分下一轮自然收敛。
 */
export function planDegrade(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
  holdAt4?: Set<string>,
): DegradePlan {
  const steps: DegradeStep[] = [];
  const working: Array<{ l: LedgerData; level: 1 | 2 | 3 | 4 | 5 }> = ledgers.map((l) => ({ l, level: l.level ?? 1 }));
  const levels: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4];   // 瀑布右移一层：L1→2→3→4→5
  for (const level of levels) {
    const selected = chooseOldestForLevel(
      working.map((w) => ({ ...w.l, level: w.level as 1 | 2 | 3 | 4 })),
      level, thresholdTokens, reserveTokens,
    );
    const chosen = new Set(selected.map((s) => s.turnStartEntryId));
    for (const w of working) {
      if (w.level === level && chosen.has(w.l.turnStartEntryId)) {
        const to = (level + 1) as 2 | 3 | 4 | 5;
        if (to === 5 && holdAt4?.has(w.l.turnStartEntryId)) continue; // 片段 L5 豁免（裁定 7）
        w.level = to;
        steps.push({ turnStartEntryId: w.l.turnStartEntryId, toLevel: to });
      }
    }
  }
  // L5 组：toLevel=5 的条目按原 ledgers 顺序相邻分组
  const degraded5 = new Set(steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId));
  const mergeGroups: string[][] = [];
  let cur: string[] = [];
  for (const l of ledgers) {
    if (degraded5.has(l.turnStartEntryId)) {
      cur.push(l.turnStartEntryId);
    } else if (cur.length) {
      mergeGroups.push(cur);
      cur = [];
    }
  }
  if (cur.length) mergeGroups.push(cur);
  return { steps, mergeGroups };
}

/**
 * 降级编排引擎：planDegrade 得计划 → 机械降级（L1→L2、L2→L3，零 LLM）与 LLM 降级
 * （L3→L4 compressEnds、L4→L5 mergeDescribe）→ onLedger 持久化。
 * 串行执行（不并发，避免本地模型过载）；每条降级 turn 先写 level 再做 LLM 压缩；
 * LLM 失败的 turn 回滚 level；合并组失败时 level 从未改动（先 mergeDescribe 后置 L5），
 * onWarning 告警但整体不中断。
 */
export class DegradeEngine {
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
  ) {}

  async run(ledgers: LedgerData[], holdAt4?: Set<string>): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens, holdAt4);
    const byId = new Map(ledgers.map((l) => [l.turnStartEntryId, l]));

    for (const step of plan.steps.filter((s) => s.toLevel === 2)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 2;
      this.onLedger(l);
    }
    // L2→L3 纯机械：丢动作行（渲染层视图切换），零 LLM（spec 裁定 #3）
    for (const step of plan.steps.filter((s) => s.toLevel === 3)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 3;
      this.onLedger(l);
    }
    // L3→L4：compressEnds 压两端原文为 intent/outcome（原 L2→L3 逻辑右移）
    for (const step of plan.steps.filter((s) => s.toLevel === 4)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 4; // 先写 level：持久化与 LLM 压缩同一时序
      try {
        const ends = await compressEnds(this.backend, l);
        l.summary = { ...l.summary, userIntent: ends.userIntent, outcome: ends.outcome };
        this.onLedger(l);
      } catch (err) {
        l.level = 3; // 回滚：保持原层级
        this.onWarning(`context-compress: turn ${l.turnStartEntryId} L4 压缩失败（${String(err)}），保持 L3`);
      }
    }
    // L4→L5：合并组描述（原 toLevel=4 组逻辑右移）。上游裁定 #1：先对仍为 L4 的 members 调
    // mergeDescribe（其内部用 renderTurnText 渲染输入，必须在置 L5 前调用，否则输入变成
    // 「（已合并）」垃圾文本）→ 成功后才置 level=5 + 写 merged + 逐条 onLedger；
    // 失败时 level 从未被改，无需回滚。
    for (const group of plan.mergeGroups) {
      const members = group.map((id) => byId.get(id)!);
      try {
        const { description } = await mergeDescribe(this.backend, members);
        for (const m of members) {
          m.level = 5;
          // 描述写到组内每个成员：ledger 单条目自包含，渲染/重建无需跨条目状态
          m.merged = { description };
          this.onLedger(m);
        }
      } catch (err) {
        this.onWarning(`context-compress: L5 合并失败（${String(err)}），保持 L4`);
      }
    }
  }
}
