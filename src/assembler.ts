import type { AgentMessage } from "./types.js";
import { renderActionLedger, type LedgerData } from "./ledger.js";
import { countTokens, splitIntoTurns, stripThinking, type MessageEntry, type Turn } from "./util.js";

/** 单个 turn 的窗口预算计量：assistant 消息跳过 thinking 块（窗口原文会剥离 thinking，
 *  预算必须与实际发给 LLM 的内容一致），其余角色沿用同一 CJK 感知口径（见 util.countTokens）。 */
export function turnTokens(turn: Turn): number {
  return turn.entries.reduce((s, e) => s + countTokens(e.message, { skipThinking: true }), 0);
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

/** 进行中 turn 的溢出处理计划（纯函数，无副作用）：
 *  covered = store（cache）中属于最后 turn 且 key≠turn.startEntryId 的片段所覆盖的前缀；
 *  branch = 裁剪视图（去掉 covered 前缀条目，user 消息保留）；
 *  extraLedgers = 片段 ledger（branch 顺序追加在队尾）；
 *  fragment = 未覆盖部分仍超 keepRecentTokens 时切出的新片段伪 Turn（否则 null）。
 *  fragment = 未覆盖部分仍超 keepRecentTokens 时切出的新片段伪 Turn（否则 null）。
 *  注意：trimmedBranch 只裁剪已落盘片段覆盖的前缀，**不移除**新 fragment 切出的条目——
 *  新片段本轮原文放行（spec §2 安全窗口）；片段落盘后下一轮覆盖推导自然接管（前缀裁剪
 *  + extraLedgers 渲染），摘要失败则片段永远原文放行（spec §5 失败语义）。fragment
 *  返回值仅供 caller 入队。
 *  切分规则：从 user 之后按完整 toolCall→toolResult 对累计最旧若干条，直到覆盖
 *  overflow = remainingTokens - keepRecentTokens；片段不得结束在带 toolCall 的 assistant 上。 */
export function planInflightTrim(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
): { trimmedBranch: MessageEntry[]; extraLedgers: LedgerData[]; fragment: Turn | null } {
  const turns = splitIntoTurns(branch);
  if (turns.length === 0) return { trimmedBranch: branch, extraLedgers: [], fragment: null };
  const last = turns[turns.length - 1];
  const idxOf = new Map(last.entries.map((e, i) => [e.id, i] as const));

  // 覆盖推导：cache 中 key 命中 last turn 且非 turn 起点的条目是已落盘片段；
  // absorbed 条目理论不在 cache（rebuild 跳过），若出现则跳过不计入覆盖（防御）
  let coveredIdx = -1;
  const frags: LedgerData[] = [];
  for (const [key, v] of cache) {
    if (v.absorbed) continue;
    if (key === last.startEntryId) continue;
    if (!idxOf.has(key)) continue;
    frags.push(v);
    const endIdx = idxOf.get(v.turnEndEntryId);
    if (endIdx !== undefined && endIdx > coveredIdx) coveredIdx = endIdx;
  }
  frags.sort((a, b) => (idxOf.get(a.turnStartEntryId) ?? 0) - (idxOf.get(b.turnStartEntryId) ?? 0));

  // 裁剪：去掉已覆盖前缀（保留 entries[0] 即 user 消息），用 id 集合过滤保持其余条目原顺序
  let trimmedBranch = branch;
  if (coveredIdx >= 1) {
    const removed = new Set(last.entries.slice(1, coveredIdx + 1).map((e) => e.id));
    trimmedBranch = branch.filter((e) => !removed.has(e.id));
  }

  // 溢出切分：只对未覆盖部分计量（coveredIdx=-1 时 remaining[0] 为 user，否则 user 已保留在 trimmedBranch）
  const remaining = last.entries.slice(coveredIdx + 1);
  let remainingTokens = 0;
  for (const e of remaining) remainingTokens += countTokens(e.message, { skipThinking: true });
  if (remainingTokens <= keepRecentTokens) return { trimmedBranch, extraLedgers: frags, fragment: null };

  const overflow = remainingTokens - keepRecentTokens;
  const i0 = remaining[0].message.role === "user" ? 1 : 0; // 片段从 user 之后开始
  let i = i0;
  let acc = 0;
  while (i < remaining.length) {
    acc += countTokens(remaining[i].message, { skipThinking: true });
    i++;
    if (acc >= overflow) break;
  }
  if (i === i0) return { trimmedBranch, extraLedgers: frags, fragment: null }; // 仅剩 user：无可切条目

  // 对边界修正：不结束在带 toolCall 的 assistant 上——继续向后吃直到吃进一条 toolResult；
  // 已到末尾则吃到最后一条为止
  const endsOnToolCall = (e: MessageEntry) =>
    e.message.role === "assistant" && (e.message.content as any[]).some((b) => b?.type === "toolCall");
  while (i < remaining.length && endsOnToolCall(remaining[i - 1])) {
    const role = remaining[i].message.role;
    acc += countTokens(remaining[i].message, { skipThinking: true });
    i++;
    if (role === "toolResult") break;
  }

  const fragment: Turn = {
    startEntryId: remaining[i0].id,
    endEntryId: remaining[i - 1].id,
    entries: remaining.slice(i0, i),
    isFragment: true,
  };
  return { trimmedBranch, extraLedgers: frags, fragment };
}

export interface AssembleStats { windowTurns: number; replacedTurns: number; passthroughTurns: number }

/** 装配上下文：窗口外有摘要的 turn 用 ledger 头代表，无摘要的 turn 原文照发，窗口内 turn 原文追加。
 *  extraLedgers（进行中 turn 的片段 ledger）追加在日志头 ledgers 数组末尾——片段属于最后
 *  turn，branch 顺序天然在最后；缺省 [] 时行为与旧签名逐字节一致。 */
export function assembleContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
  extraLedgers: LedgerData[] = [],
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

  if (ledgers.length > 0 || extraLedgers.length > 0) messages.push(renderActionLedger([...ledgers, ...extraLedgers]));
  const strippedBranch = stripThinking(branch); // passthrough 与窗口统一剥离 thinking（见 stripThinking）
  for (const e of strippedBranch) {
    if (passthroughIds.has(e.id)) messages.push(e.message);
  }
  for (const t of window) for (const e of stripThinking(t.entries)) messages.push(e.message);

  return { messages, stats };
}
