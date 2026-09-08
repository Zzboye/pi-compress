import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./types.js";
import { renderActionLedger, type LedgerData } from "./ledger.js";
import { splitIntoTurns, stripThinking, type MessageEntry, type Turn } from "./util.js";

/** 单个 turn 的窗口预算计量：assistant 消息跳过 thinking 块（窗口原文会剥离 thinking，
 *  预算必须与实际发给 LLM 的内容一致），其余角色沿用 pi 的 estimateTokens。 */
export function turnTokens(turn: Turn): number {
  return turn.entries.reduce((s, e) => {
    const m = e.message as any;
    if (m.role !== "assistant") return s + estimateTokens(e.message);
    let chars = 0;
    for (const b of m.content as any[]) {
      if (b?.type === "text") chars += b.text.length;
      else if (b?.type === "toolCall") chars += b.name.length + JSON.stringify(b.arguments ?? {}).length;
    }
    return s + Math.ceil(chars / 4);
  }, 0);
}

/** 从尾部往前收集 turn，直到累计 token 超过预算；单 turn 超预算时整体保留 */
export function findWindowTurns(turns: Turn[], keepRecentTokens: number): Turn[] {
  const window: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const tokens = turnTokens(turns[i]);
    if (window.length > 0 && total + tokens > keepRecentTokens) break;
    window.unshift(turns[i]);
    total += tokens;
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
  const strippedBranch = stripThinking(branch); // passthrough 与窗口统一剥离 thinking（见 stripThinking）
  for (const e of strippedBranch) {
    if (passthroughIds.has(e.id)) messages.push(e.message);
  }
  for (const t of window) for (const e of stripThinking(t.entries)) messages.push(e.message);

  return { messages, stats };
}
