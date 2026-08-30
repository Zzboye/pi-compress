import { estimateTokens, serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { MessageEntry } from "./util.js";

export interface RecallResult { text: string; missing: string[] }

export function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number): RecallResult {
  const byId = new Map(branch.map((e) => [e.id, e]));
  const missing: string[] = [];
  const parts: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    let text = serializeConversation(convertToLlm([e.message]) as any);
    if (estimateTokens(e.message) > maxTokensPerEntry) {
      // 估算约 4 字符/token 截断
      text = text.slice(0, maxTokensPerEntry * 4) + `\n…（已截断，原消息过大；如需其余部分请用相邻 ID 分段 recall）`;
    }
    parts.push(`【${id} 的原文】\n${text}`);
  }
  if (missing.length > 0) {
    parts.push(`以下 ID 不在当前分支中（可能因 /tree 回退）：${missing.join(", ")}。可尝试 recall 相邻 turn 的 ID。`);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing };
}
