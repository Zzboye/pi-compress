import type { AgentMessage } from "@earendil-works/pi-coding-agent";

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
