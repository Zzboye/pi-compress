// scripts/_turnsize.mts
import { readFileSync } from "node:fs";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// src/util.ts
import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
function splitIntoTurns(entries) {
  const turns2 = [];
  let current = null;
  for (const e of entries) {
    if (e.message.role === "user" || current === null) {
      current = { startEntryId: e.id, endEntryId: e.id, entries: [e] };
      turns2.push(current);
    } else {
      current.entries.push(e);
      current.endEntryId = e.id;
    }
  }
  return turns2;
}
var TOOL_RESULT_LIMIT = 2e3;
var TOOL_RESULT_HEAD_CHARS = 1400;
var TOOL_RESULT_TAIL_CHARS = 500;
function joinedText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
}
function preTruncateToolResults(entries) {
  return entries.map((e) => {
    if (e.message.role !== "toolResult") return e;
    const full = joinedText(e.message.content);
    if (full.length <= TOOL_RESULT_LIMIT) return e;
    const omitted = full.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
    const text = `${full.slice(0, TOOL_RESULT_HEAD_CHARS)}
[... omitted ${omitted} middle characters ...]
${full.slice(-TOOL_RESULT_TAIL_CHARS)}`;
    return { ...e, message: { ...e.message, content: [{ type: "text", text }] } };
  });
}
function serializeTurn(turn) {
  return serializeConversation(convertToLlm(stripThinking(preTruncateToolResults(turn.entries)).map((e) => e.message)));
}
function stripThinking(entries) {
  const out = [];
  for (const e of entries) {
    if (e.message.role !== "assistant") {
      out.push(e);
      continue;
    }
    const content = e.message.content.filter((b) => b?.type !== "thinking");
    if (content.length === 0) continue;
    out.push({ ...e, message: { ...e.message, content } });
  }
  return out;
}

// scripts/_turnsize.mts
var raw = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
var branch = raw.filter((e) => e.type === "message").map((e) => ({ id: e.id, message: e.message }));
var turns = splitIntoTurns(branch);
turns.forEach((t, i) => {
  const st = stripThinking(t.entries);
  const full = st.reduce((s, e) => s + estimateTokens(e.message), 0);
  console.log(`Turn ${i + 1}: \u5168\u6587 ~${full} tok | \u5E8F\u5217\u5316(\u622A\u65ADtoolResult) ~${Math.ceil(serializeTurn(t).length / 4)} tok | entries=${t.entries.length}`);
});
