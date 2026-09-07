import type { AgentMessage } from "./types.js";
import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ToolActionInfo } from "./prompts.js";
import type { LedgerQuote } from "./ledger.js";

export interface MessageEntry { id: string; message: AgentMessage }

export interface Turn { startEntryId: string; endEntryId: string; entries: MessageEntry[] }

export function splitIntoTurns(entries: MessageEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const e of entries) {
    if (e.message.role === "user" || current === null) {
      current = { startEntryId: e.id, endEntryId: e.id, entries: [e] };
      turns.push(current);
    } else {
      current.entries.push(e);
      current.endEntryId = e.id;
    }
  }
  return turns;
}

/** pi serializeConversation 对 toolResult 的截断上限；我们的预算必须落在其下，避免被二次截掉尾部 */
const TOOL_RESULT_LIMIT = 2000;
const TOOL_RESULT_HEAD_CHARS = 1400;
const TOOL_RESULT_TAIL_CHARS = 500;

function joinedText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n");
}

/**
 * 头+尾采样：开头是结构（imports/签名），结尾是结论（测试汇总/错误/exit code），
 * 中段替换为省略标记。总预算 ~1950 < pi 的 2000，pi 不会二次截断。
 */
function preTruncateToolResults(entries: MessageEntry[]): MessageEntry[] {
  return entries.map((e) => {
    if (e.message.role !== "toolResult") return e;
    const full = joinedText((e.message as any).content);
    if (full.length <= TOOL_RESULT_LIMIT) return e;
    const omitted = full.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
    const text = `${full.slice(0, TOOL_RESULT_HEAD_CHARS)}\n[... omitted ${omitted} middle characters ...]\n${full.slice(-TOOL_RESULT_TAIL_CHARS)}`;
    return { ...e, message: { ...(e.message as any), content: [{ type: "text", text }] } } as MessageEntry;
  });
}

export function serializeTurn(turn: Turn): string {
  return serializeConversation(convertToLlm(stripThinking(preTruncateToolResults(turn.entries)).map((e) => e.message)) as any);
}

/** 剥离 assistant 消息中的 thinking 块（过程噪声）：LLM 不可见、不占窗口预算、不进摘要 prompt。
 *  纯 thinking 的 assistant 消息整条丢弃（无 text/toolCall，零信息量）。toolCall 块永远保留，toolCall→toolResult 配对不受影响。 */
export function stripThinking(entries: MessageEntry[]): MessageEntry[] {
  const out: MessageEntry[] = [];
  for (const e of entries) {
    if (e.message.role !== "assistant") {
      out.push(e);
      continue;
    }
    const content = (e.message.content as any[]).filter((b) => b?.type !== "thinking");
    if (content.length === 0) continue; // 纯思考消息：整条丢弃
    out.push({ ...e, message: { ...(e.message as any), content } as MessageEntry["message"] });
  }
  return out;
}

/** 从 assistant 消息的 toolCall 块机械提取动作清单；target 逐字，不经模型 */
export function extractToolActions(turn: Turn): ToolActionInfo[] {
  const out: ToolActionInfo[] = [];
  for (const e of turn.entries) {
    if (e.message.role !== "assistant") continue;
    for (const block of e.message.content as any[]) {
      if (block?.type !== "toolCall") continue;
      const args = block.arguments ?? {};
      const target = args.path ?? args.command ?? args.url ?? block.name;
      const prev = out.find((a) => a.action === block.name && a.target === target);
      if (prev) prev.entryIds.push(e.id);
      else out.push({ action: block.name, target: String(target), entryIds: [e.id] });
    }
  }
  return out;
}

const USER_MESSAGE_HEAD_CHARS = 200;
const REPLY_HEAD_CHARS = 800;
const REPLY_TAIL_CHARS = 1200;

/** turn 首条 user 消息逐字保留；意图在开头，仅头截断 */
export function extractUserMessage(turn: Turn): LedgerQuote | undefined {
  const first = turn.entries[0];
  if (!first || first.message.role !== "user") return undefined;
  const text = joinedText((first.message as any).content);
  if (text === "") return undefined;
  if (text.length <= USER_MESSAGE_HEAD_CHARS) return { text, entryId: first.id, truncated: false };
  const omitted = text.length - USER_MESSAGE_HEAD_CHARS;
  return {
    text: `${text.slice(0, USER_MESSAGE_HEAD_CHARS)}\n[... 已截断，后续 ${omitted} 字符省略 ...]`,
    entryId: first.id,
    truncated: true,
  };
}

/** turn 内最后一条含 text 的 assistant 消息逐字保留（跳过纯 thinking）；超长时头尾采样 */
export function extractFinalReply(turn: Turn): LedgerQuote | undefined {
  for (let i = turn.entries.length - 1; i >= 0; i--) {
    const e = turn.entries[i];
    if (e.message.role !== "assistant") continue;
    const text = joinedText((e.message as any).content); // 只取 text 块，thinking 天然排除
    if (text === "") continue; // 纯思考消息：继续向前找
    if (text.length <= REPLY_HEAD_CHARS + REPLY_TAIL_CHARS) return { text, entryId: e.id, truncated: false };
    const omitted = text.length - REPLY_HEAD_CHARS - REPLY_TAIL_CHARS;
    return {
      text: `${text.slice(0, REPLY_HEAD_CHARS)}\n[... 中间省略 ${omitted} 字符 ...]\n${text.slice(-REPLY_TAIL_CHARS)}`,
      entryId: e.id,
      truncated: true,
    };
  }
  return undefined;
}
