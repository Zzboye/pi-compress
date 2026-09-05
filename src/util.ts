import type { AgentMessage } from "./types.js";
import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ToolActionInfo } from "./prompts.js";

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
  return serializeConversation(convertToLlm(preTruncateToolResults(turn.entries).map((e) => e.message)) as any);
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
