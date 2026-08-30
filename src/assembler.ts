import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./types.js";
import { renderActionLedger, type LedgerData } from "./ledger.js";
import { splitIntoTurns, type MessageEntry, type Turn } from "./util.js";

/** 从尾部往前收集 turn，直到累计 token 超过预算；单 turn 超预算时整体保留 */
export function findWindowTurns(turns: Turn[], keepRecentTokens: number): Turn[] {
  const window: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i].entries.reduce((s, e) => s + estimateTokens(e.message), 0);
    if (window.length > 0 && total + turnTokens > keepRecentTokens) break;
    window.unshift(turns[i]);
    total += turnTokens;
  }
  return window;
}

export interface AssembleStats { windowTurns: number; replacedTurns: number; passthroughTurns: number }

/** 装配上下文：窗口外有摘要的 turn 用 ledger 头代表，无摘要的 turn 原文照发，窗口内 turn 原文追加。 */
export function assembleContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
): { messages: AgentMessage[]; stats: AssembleStats } {
  const turns = splitIntoTurns(branch);
  const window = findWindowTurns(turns, keepRecentTokens);
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  const stats: AssembleStats = { windowTurns: window.length, replacedTurns: 0, passthroughTurns: 0 };
  const messages: AgentMessage[] = [];
  const ledgers: LedgerData[] = [];

  for (const turn of turns) {
    if (windowStartIds.has(turn.startEntryId)) continue; // 窗口内，稍后原文追加
    const cached = cache.get(turn.startEntryId);
    if (cached) {
      ledgers.push(cached);
      stats.replacedTurns++;
    } else {
      stats.passthroughTurns++;
    }
  }

  // 无摘要的窗外 turn 原文照发（不阻塞、不丢弃）
  const passthroughIds = new Set(
    turns.filter((t) => !windowStartIds.has(t.startEntryId) && !cache.has(t.startEntryId)).flatMap((t) => t.entries.map((e) => e.id)),
  );

  if (ledgers.length > 0) messages.push(renderActionLedger(ledgers));
  for (const e of branch) {
    if (passthroughIds.has(e.id)) messages.push(e.message);
  }
  for (const t of window) for (const e of t.entries) messages.push(e.message);

  return { messages, stats };
}
