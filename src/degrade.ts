import { countTokens } from "./util.js";
import { renderTurnText, type LedgerData } from "./ledger.js";
import type { AgentMessage } from "./types.js";
import type { SummarizerBackend } from "./summarizer.js";
import type { ContextCompressConfig } from "./config.js";
import { compressEnds, recompressBatched, recompressOne, L5_BATCH_SIZE } from "./degrade-llm.js";

export interface DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 | 5 }

export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, toLevel) 列表，最旧优先 */
  steps: DegradeStep[];
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
 * 逐层瀑布：L1→L2→L3→L4→L5。L1 降级产生的新 L2 条目立即计入 L2 的 total
 * （下层计量基于降级后快照）。holdAt3 中的条目豁免 L4 与 L5（进行中 turn 的溢出片段：
 * L3 起片段已无实体内容——L4 的意图/outcome 对片段语义为空，L5 的合并收益为零而拒绝
 * 召回是实害；spec 2026-09-20 §2 裁定 3）→ 不生成 toLevel>=4 的 step，
 * 终态 L3（起点已 ≥4 的存量片段停在原层，不回落）。被豁免的片段仍参与各层 total 与 reserve 计量（保守方向：只少选不超降）。
 * 不修改入参（在副本上推演），每轮 agent_settled 只做一遍瀑布，超量部分下一轮自然收敛。
 */
export function planDegrade(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
  holdAt3?: Set<string>,
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
        if (to >= 4 && holdAt3?.has(w.l.turnStartEntryId)) continue; // 片段上限 L3（spec 2026-09-20 §2 裁定 3）
        w.level = to;
        steps.push({ turnStartEntryId: w.l.turnStartEntryId, toLevel: to });
      }
    }
  }
  return { steps };
}

/**
 * 降级编排引擎：planDegrade 得计划 → 机械降级（L1→L2、L2→L3，零 LLM）与 LLM 降级
 * （L3→L4 compressEnds；L4→L5 recompressBatched 批量逐条，N=L5_BATCH_SIZE）。
 * 串行执行（不并发，避免本地模型过载）；每条降级 turn 先写 level 再做 LLM 压缩；
 * L4 失败的 turn 回滚 level；L5 单条失败保持 L4 + warning，不中断整体；onWarning 告警但整体不中断。
 */
export class DegradeEngine {
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
  ) {}

  async run(ledgers: LedgerData[], holdAt3?: Set<string>): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens, holdAt3);
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
    // L4→L5：逐条二次压缩（不再有合并组）。按 L5_BATCH_SIZE 分片，一次调用产出 N 条描述；
    // 某条缺失 → 该条单独重跑；仍失败 → 保持 L4 + warning（不整批重试）。
    // 时序约束：必须在写 level=5 之前取描述（输入读 summary.userIntent/outcome）。
    const l5Steps = plan.steps.filter((s) => s.toLevel === 5);
    for (let i = 0; i < l5Steps.length; i += L5_BATCH_SIZE) {
      const slice = l5Steps.slice(i, i + L5_BATCH_SIZE).map((s) => byId.get(s.turnStartEntryId)!);
      const descs = await recompressBatched(this.backend, slice);
      for (let j = 0; j < slice.length; j++) {
        const m = slice[j];
        let desc = descs[j];
        if (desc === null) {
          try {
            desc = await recompressOne(this.backend, m);
          } catch (err) {
            this.onWarning(`context-compress: turn ${m.turnStartEntryId} L5 压缩失败（${String(err)}），保持 L4`);
            continue;
          }
        }
        m.level = 5;
        m.merged = { description: desc };
        this.onLedger(m);
      }
    }
  }
}
