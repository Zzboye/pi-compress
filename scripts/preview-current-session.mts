/**
 * 对当前会话文件跑一次真实装配（复用 pi-compress 的 assembleContext），
 * 把 LLM 实际收到的上下文原文 + 统计写到文件，供用户审阅。
 *
 *   node scripts/preview-current-session.mjs <session.jsonl> <out.md>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { assembleContext } from "../src/assembler.js";
import { LedgerStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { renderActionLedger } from "../src/ledger.js";
import { splitIntoTurns, serializeTurn, type MessageEntry } from "../src/util.js";

const [sessionPath, outPath] = process.argv.slice(2);

// 1. 读会话文件：message entries 进 branch，custom ledger 进 store
const raw = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const messageEntries = raw.filter((e) => e.type === "message");
const branch = messageEntries.map((e) => ({ id: e.id, message: e.message }));

const store = new LedgerStore();
store.rebuildFromEntries(raw);
const cache = new Map();
for (const k of store.keys()) cache.set(k, store.get(k));

// 2. 用插件默认配置装配
const config = loadConfig(undefined, undefined);
const { messages, stats } = assembleContext(branch, cache, config.keepRecentTokens);

// 3. 统计
const turns = splitIntoTurns(branch);
const charLen = (m) => m.content.filter((b) => b?.type === "text").map((b) => b.text).join("").length;
const totalChars = messages.reduce((s, m) => s + charLen(m), 0);
const nativeChars = (() => {
  // 原生（无插件）上下文 = 全部 message 剥 thinking 后原文
  let s = 0;
  for (const m of branch.map((e) => e.message)) s += charLen(m);
  return s;
})();

// 4. 输出
const lines = [];
lines.push("# 当前会话 · 装配后上下文预览");
lines.push("");
lines.push(`- 会话文件: ${sessionPath}`);
lines.push(`- 会话 turns 总数: ${turns.length}（message entries: ${branch.length}）`);
lines.push(`- 已有 ledger 摘要: ${store.size()} 条`);
lines.push(`- 配置: keepRecentTokens=${config.keepRecentTokens}, ledgerMergeThreshold=${config.ledgerMergeThreshold}（未实现）`);
lines.push(`- 装配统计: 窗口内 ${stats.windowTurns} turns / ledger 替换 ${stats.replacedTurns} / 原文透传 ${stats.passthroughTurns}`);
lines.push(`- 装配后总字符: ${totalChars}（约 ${Math.ceil(totalChars / 4)} tokens 估算）`);
lines.push(`- 原生上下文字符（剥 thinking 后）: ${nativeChars}（约 ${Math.ceil(nativeChars / 4)} tokens）`);
lines.push(`- 装配消息条数: ${messages.length}`);
lines.push("");
lines.push("---");
lines.push("");
lines.push("## 以下为 LLM 实际收到的上下文原文（按装配顺序）");
lines.push("");
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  const text = m.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  const isLedger = text.includes("<action-ledger>");
  const approxTok = Math.ceil(text.length / 4);
  lines.push(`### [${i}] role=${m.role} · ~${approxTok} tok${isLedger ? " · ← 动作日志（压缩替换段）" : ""}`);
  lines.push("");
  lines.push("```");
  lines.push(text);
  lines.push("```");
  lines.push("");
}
lines.push("---");
lines.push("");
lines.push("## 附：被 ledger 替换的 turn 的原生原文（即上下文中已看不到的部分）");
lines.push("");
for (let i = 0; i < turns.length; i++) {
  const t = turns[i];
  if (cache.has(t.startEntryId)) {
    // 该 turn 在窗外且有摘要 → 已被替换。打印其原生序列化文本供对照。
    lines.push(`### Turn ${i + 1}（startEntryId=${t.startEntryId}）· 原生 ~${Math.ceil(serializeTurn(t).length / 4)} tok`);
    lines.push("");
    lines.push("```");
    lines.push(serializeTurn(t));
    lines.push("```");
    lines.push("");
  }
}

writeFileSync(outPath, lines.join("\n"));
console.log(`written: ${outPath}`);
console.log(`turns=${turns.length} ledgers=${store.size()} stats=${JSON.stringify(stats)} assembledChars=${totalChars} nativeChars=${nativeChars}`);
