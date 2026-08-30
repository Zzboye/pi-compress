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

export function serializeTurn(turn: Turn): string {
  return serializeConversation(convertToLlm(turn.entries.map((e) => e.message)) as any);
}

/** 从 assistant 消息的 toolCall 块机械提取动作清单；target 逐字，不经模型 */
export function extractToolActions(turn: Turn): ToolActionInfo[] {
  const out: ToolActionInfo[] = [];
  for (const e of turn.entries) {
    if (e.message.role !== "assistant") continue;
    for (const block of e.message.content as any[]) {
      if (block?.type !== "toolCall") continue;
      const args = block.arguments ?? {};
      const target = args.path ?? args.command ?? args.url ?? block.toolName;
      const prev = out.find((a) => a.action === block.toolName && a.target === target);
      if (prev) prev.entryIds.push(e.id);
      else out.push({ action: block.toolName, target: String(target), entryIds: [e.id] });
    }
  }
  return out;
}
