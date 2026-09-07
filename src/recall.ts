import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import { stripThinking, type MessageEntry } from "./util.js";

export interface RecallResult { text: string; missing: string[] }

export function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number): RecallResult {
  const stripped = stripThinking(branch);
  const byId = new Map(stripped.map((e) => [e.id, e]));
  // toolCallId → toolResult：recall 含 toolCall 的 assistant 条目时，连带取回配对的工具结果，
  // 否则只能看到“调了什么”，看不到“结果是什么”（e2e 实测暴露）。
  const resultByCallId = new Map<string, MessageEntry>();
  for (const e of stripped) {
    if (e.message.role === "toolResult") resultByCallId.set((e.message as any).toolCallId, e);
  }
  const missing: string[] = [];
  const parts: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    const msgs = [e.message];
    if (e.message.role === "assistant") {
      for (const block of e.message.content as any[]) {
        if (block?.type !== "toolCall") continue;
        const r = resultByCallId.get(block.id);
        if (r) msgs.push(r.message);
      }
    }
    let text = serializeConversation(convertToLlm(msgs) as any);
    if (text.length > maxTokensPerEntry * 4) {
      // 估算约 4 字符/token 截断（入口已剥离 thinking，text 即有效内容全量）
      text = text.slice(0, maxTokensPerEntry * 4) + `\n…（已截断，原消息过大；如需其余部分请用相邻 ID 分段 recall）`;
    }
    parts.push(`【${id} 的原文】\n${text}`);
  }
  if (missing.length > 0) {
    parts.push(`以下 ID 不在当前分支中（可能因 /tree 回退）：${missing.join(", ")}。可尝试 recall 相邻 turn 的 ID。`);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing };
}
