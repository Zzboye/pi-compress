import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { renderTurnText, type LedgerData } from "./ledger.js";
import type { AgentMessage } from "./types.js";

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
  return estimateTokens({ role: "user", content: [{ type: "text", text }] } as AgentMessage);
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
