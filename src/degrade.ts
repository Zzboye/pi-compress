import { countTokens } from "./util.js";
import { renderTurnText, type LedgerData } from "./ledger.js";
import type { AgentMessage } from "./types.js";
import type { SummarizerBackend } from "./summarizer.js";
import type { ContextCompressConfig } from "./config.js";
import { compressEnds, mergeDescribe } from "./degrade-llm.js";

export interface DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 }

export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, toLevel) 列表，最旧优先 */
  steps: DegradeStep[];
  /** L4 合并组：每组为一段连续需合并的 turnStartEntryId（描述由 Task 4 生成） */
  mergeGroups: string[][];
}

/** 单个 turn 在其 level 下渲染后的估算 tokens（与装配渲染同一文本来源） */
export function turnRenderTokens(ledger: LedgerData, index: number): number {
  const text = renderTurnText(ledger, index + 1);
  return countTokens({ role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage);
}

/**
 * 层内从最旧开始选中条目，直到累计 tokens ≥ total − reserve（保留尾部约 reserve）。
 * 按条整体选中，不拦腰截断；若单条就超过也选中它（最旧优先，保证有进展）。
 * total ≤ threshold 时返回空。
 */
export function chooseOldestForLevel(
  ledgers: LedgerData[], level: 1 | 2 | 3, threshold: number, reserve: number,
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
  const target = total - reserve;
  const chosen: LedgerData[] = [];
  let acc = 0;
  for (const { l, tokens } of inLevel) {
    chosen.push(l);
    acc += tokens;
    if (acc >= target) break;
  }
  return chosen;
}

/**
 * 逐层瀑布：L1→L2→L3。L1 降级产生的新 L2 条目立即计入 L2 的 total（下层计量基于降级后快照）。
 * 不修改入参（在副本上推演），每轮 agent_settled 只做一遍瀑布，超量部分下一轮自然收敛。
 */
export function planDegrade(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
): DegradePlan {
  const steps: DegradeStep[] = [];
  // 工作副本：降级立即生效供下层计量（level 拷贝为可变字段）
  const working: Array<{ l: LedgerData; level: 1 | 2 | 3 | 4 }> = ledgers.map((l) => ({ l, level: l.level ?? 1 }));
  const levels: Array<1 | 2 | 3> = [1, 2, 3];
  for (const level of levels) {
    const selected = chooseOldestForLevel(
      working.map((w) => ({ ...w.l, level: w.level })),
      level, thresholdTokens, reserveTokens,
    );
    const chosen = new Set(selected.map((s) => s.turnStartEntryId));
    for (const w of working) {
      if (w.level === level && chosen.has(w.l.turnStartEntryId)) {
        const to = (level + 1) as 2 | 3 | 4;
        w.level = to;
        steps.push({ turnStartEntryId: w.l.turnStartEntryId, toLevel: to });
      }
    }
  }
  // L4 组：toLevel=4 的条目按原 ledgers 顺序相邻分组（相邻即同组，非相邻分别成组）
  const degraded4 = new Set(steps.filter((s) => s.toLevel === 4).map((s) => s.turnStartEntryId));
  const mergeGroups: string[][] = [];
  let cur: string[] = [];
  for (const l of ledgers) {
    if (degraded4.has(l.turnStartEntryId)) {
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
 * 降级编排引擎：planDegrade 得计划 → 规则降级（L1→L2）与 LLM 降级（L2→L3、L3→L4）→ onLedger 持久化。
 * 串行执行（不并发，避免本地模型过载）；每条降级 turn 先写 level 再做 LLM 压缩；
 * LLM 失败的 turn/组回滚 level（保持原层级），onWarning 告警但整体不中断。
 */
export class DegradeEngine {
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
  ) {}

  async run(ledgers: LedgerData[]): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens);
    const byId = new Map(ledgers.map((l) => [l.turnStartEntryId, l]));

    for (const step of plan.steps.filter((s) => s.toLevel === 2)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 2;
      this.onLedger(l);
    }
    for (const step of plan.steps.filter((s) => s.toLevel === 3)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 3; // 先写 level：持久化与 LLM 压缩同一时序
      try {
        const ends = await compressEnds(this.backend, l);
        l.summary = { ...l.summary, userIntent: ends.userIntent, outcome: ends.outcome };
        this.onLedger(l);
      } catch (err) {
        l.level = 2; // 回滚：保持原层级
        this.onWarning(`context-compress: turn ${l.turnStartEntryId} L3 压缩失败（${String(err)}），保持 L2`);
      }
    }
    for (const group of plan.mergeGroups) {
      const members = group.map((id) => byId.get(id)!);
      for (const m of members) m.level = 4;
      try {
        const { description } = await mergeDescribe(this.backend, members);
        // 描述写到组内每个成员：ledger 单条目自包含，渲染/重建无需跨条目状态
        for (const m of members) {
          m.merged = { description };
          this.onLedger(m);
        }
      } catch (err) {
        for (const m of members) m.level = 3; // 回滚：保持原层级
        this.onWarning(`context-compress: L4 合并失败（${String(err)}），保持 L3`);
      }
    }
  }
}
