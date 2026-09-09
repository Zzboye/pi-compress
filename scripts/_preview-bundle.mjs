// scripts/preview-current-session.mts
import { readFileSync, writeFileSync } from "node:fs";

// src/assembler.ts
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// src/ledger.ts
var LEDGER_CUSTOM_TYPE = "context-compress:ledger";
var PHASE_LABEL = {
  investigate: "\u8C03\u67E5",
  fix: "\u4FEE\u590D",
  verify: "\u9A8C\u8BC1",
  discuss: "\u8BA8\u8BBA",
  other: "\u5176\u4ED6"
};
function renderActionLedger(ledgers) {
  const lines2 = ["<action-ledger>", "## \u4F1A\u8BDD\u5386\u53F2\uFF08\u52A8\u4F5C\u65E5\u5FD7\uFF0C\u7EC6\u8282\u5DF2\u538B\u7F29\uFF09", ""];
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    if (l.userMessage) {
      const recall = l.userMessage.truncated ? ` \u21A9${l.userMessage.entryId}` : "";
      lines2.push(`### T${i + 1} \xB7 \u7528\u6237\uFF1A\u300C${l.userMessage.text.replace(/\n+/g, " ")}\u300D${recall}`);
    } else {
      lines2.push(`### T${i + 1} \xB7 \u7528\u6237\u610F\u56FE\uFF1A${l.summary.userIntent ?? "\uFF08\u672A\u77E5\uFF09"}`);
    }
    for (const g of l.summary.groups) {
      for (const e of g.entries) {
        const recall = e.recallIds.length ? ` \u21A9${e.recallIds.join(",\u21A9")}` : "";
        lines2.push(`- ${PHASE_LABEL[g.phase]}\uFF1A${e.action} ${e.target} \u2192 ${e.detail}${recall}`);
      }
    }
    if (l.finalReply) {
      lines2.push("\u6700\u7EC8\u56DE\u590D\uFF08\u539F\u6587\uFF09\uFF1A");
      lines2.push(l.finalReply.text);
      if (l.finalReply.truncated) lines2.push(`\uFF08\u5DF2\u622A\u65AD\uFF0C\u21A9${l.finalReply.entryId} \u53D6\u56DE\u5168\u6587\uFF09`);
    } else if (l.summary.outcome !== void 0) {
      lines2.push(`- \u7ED3\u679C\uFF1A${l.summary.outcome}`);
    }
    lines2.push("");
  }
  lines2.push("\uFF08\u9700\u8981\u4EFB\u4F55\u6761\u76EE\u7684\u9010\u5B57\u539F\u6587\u65F6\uFF0C\u8C03\u7528 recall \u5DE5\u5177\u5E76\u4F20\u5165 \u21A9 \u540E\u7684 ID\uFF09");
  lines2.push("</action-ledger>");
  return {
    role: "user",
    content: [{ type: "text", text: lines2.join("\n") }],
    timestamp: Date.now()
  };
}

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

// src/assembler.ts
function turnTokens(turn) {
  return turn.entries.reduce((s, e) => {
    const m = e.message;
    if (m.role !== "assistant") return s + estimateTokens(e.message);
    let chars = 0;
    for (const b of m.content) {
      if (b?.type === "text") chars += b.text.length;
      else if (b?.type === "toolCall") chars += b.name.length + JSON.stringify(b.arguments ?? {}).length;
    }
    return s + Math.ceil(chars / 4);
  }, 0);
}
function findWindowTurns(turns2, keepRecentTokens) {
  const window = [];
  let total = 0;
  for (let i = turns2.length - 1; i >= 0; i--) {
    const tokens = turnTokens(turns2[i]);
    if (window.length > 0 && total + tokens > keepRecentTokens) break;
    window.unshift(turns2[i]);
    total += tokens;
  }
  return window;
}
function assembleContext(branch2, cache2, keepRecentTokens) {
  const turns2 = splitIntoTurns(branch2);
  const window = findWindowTurns(turns2, keepRecentTokens);
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  const stats2 = { windowTurns: window.length, replacedTurns: 0, passthroughTurns: 0 };
  const messages2 = [];
  const ledgers = [];
  for (const turn of turns2) {
    if (windowStartIds.has(turn.startEntryId)) continue;
    const cached = cache2.get(turn.startEntryId);
    if (cached) {
      ledgers.push(cached);
      stats2.replacedTurns++;
    } else {
      stats2.passthroughTurns++;
    }
  }
  const passthroughIds = new Set(
    turns2.filter((t) => !windowStartIds.has(t.startEntryId) && !cache2.has(t.startEntryId)).flatMap((t) => t.entries.map((e) => e.id))
  );
  if (ledgers.length > 0) messages2.push(renderActionLedger(ledgers));
  const strippedBranch = stripThinking(branch2);
  for (const e of strippedBranch) {
    if (passthroughIds.has(e.id)) messages2.push(e.message);
  }
  for (const t of window) for (const e of stripThinking(t.entries)) messages2.push(e.message);
  return { messages: messages2, stats: stats2 };
}

// src/store.ts
function isValidLedger(d) {
  if (typeof d !== "object" || d === null) return false;
  const v = d;
  return typeof v.turnStartEntryId === "string" && typeof v.turnEndEntryId === "string" && typeof v.summary === "object" && v.summary !== null;
}
var LedgerStore = class {
  cache = /* @__PURE__ */ new Map();
  rebuildFromEntries(entries) {
    this.cache.clear();
    for (const e of entries) {
      if (e.type === "custom" && e.customType === LEDGER_CUSTOM_TYPE && isValidLedger(e.data)) {
        this.cache.set(e.data.turnStartEntryId, e.data);
      }
    }
  }
  get(turnStartEntryId) {
    return this.cache.get(turnStartEntryId);
  }
  set(data) {
    this.cache.set(data.turnStartEntryId, data);
  }
  size() {
    return this.cache.size;
  }
  keys() {
    return [...this.cache.keys()];
  }
};

// src/config.ts
var DEFAULT_CONFIG = {
  summarizer: void 0,
  summarizerFallback: void 0,
  verbatimCheck: true,
  keepRecentTokens: 2e4,
  forceRatio: 0.76,
  retry: { maxAttempts: 3, backoffMs: 2e3 },
  ledgerMergeThreshold: 40,
  backfillLimit: 20
};
function parseSummarizer(raw2) {
  if (typeof raw2 !== "object" || raw2 === null) throw new Error("summarizer must be an object");
  const s = raw2;
  if (typeof s.provider === "string" && typeof s.model === "string") {
    return { kind: "registry", provider: s.provider, model: s.model };
  }
  if (typeof s.baseUrl === "string" && typeof s.model === "string") {
    return { kind: "openai", baseUrl: s.baseUrl, model: s.model, apiKey: typeof s.apiKey === "string" ? s.apiKey : void 0 };
  }
  throw new Error("summarizer requires {provider,model} or {baseUrl,model}");
}
function num(v, dflt, min, max) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}
function loadConfig(globalRaw, projectRaw) {
  const merged = {};
  for (const raw2 of [globalRaw, projectRaw]) {
    if (raw2 && typeof raw2 === "object" && raw2.contextCompress) {
      Object.assign(merged, raw2.contextCompress);
    }
  }
  return {
    summarizer: merged.summarizer === void 0 ? void 0 : parseSummarizer(merged.summarizer),
    summarizerFallback: merged.summarizerFallback === void 0 ? void 0 : parseSummarizer(merged.summarizerFallback),
    verbatimCheck: merged.verbatimCheck === void 0 ? DEFAULT_CONFIG.verbatimCheck : !!merged.verbatimCheck,
    keepRecentTokens: num(merged.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens, 1e3, 1e6),
    forceRatio: num(merged.forceRatio, DEFAULT_CONFIG.forceRatio, 0.1, 0.99),
    retry: {
      maxAttempts: Math.max(1, Math.floor(num(merged.retry === void 0 ? void 0 : merged.retry.maxAttempts, 3, 1, 100))),
      backoffMs: Math.max(100, Math.floor(num(merged.retry === void 0 ? void 0 : merged.retry.backoffMs, 2e3, 100, 6e5)))
    },
    ledgerMergeThreshold: Math.floor(num(merged.ledgerMergeThreshold, 40, 5, 1e4)),
    backfillLimit: Math.floor(num(merged.backfillLimit, 20, 0, 1e5))
  };
}

// scripts/preview-current-session.mts
var [sessionPath, outPath] = process.argv.slice(2);
var raw = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
var messageEntries = raw.filter((e) => e.type === "message");
var branch = messageEntries.map((e) => ({ id: e.id, message: e.message }));
var store = new LedgerStore();
store.rebuildFromEntries(raw);
var cache = /* @__PURE__ */ new Map();
for (const k of store.keys()) cache.set(k, store.get(k));
var config = loadConfig(void 0, void 0);
var { messages, stats } = assembleContext(branch, cache, config.keepRecentTokens);
var turns = splitIntoTurns(branch);
var charLen = (m) => m.content.filter((b) => b?.type === "text").map((b) => b.text).join("").length;
var totalChars = messages.reduce((s, m) => s + charLen(m), 0);
var nativeChars = (() => {
  let s = 0;
  for (const m of branch.map((e) => e.message)) s += charLen(m);
  return s;
})();
var lines = [];
lines.push("# \u5F53\u524D\u4F1A\u8BDD \xB7 \u88C5\u914D\u540E\u4E0A\u4E0B\u6587\u9884\u89C8");
lines.push("");
lines.push(`- \u4F1A\u8BDD\u6587\u4EF6: ${sessionPath}`);
lines.push(`- \u4F1A\u8BDD turns \u603B\u6570: ${turns.length}\uFF08message entries: ${branch.length}\uFF09`);
lines.push(`- \u5DF2\u6709 ledger \u6458\u8981: ${store.size()} \u6761`);
lines.push(`- \u914D\u7F6E: keepRecentTokens=${config.keepRecentTokens}, ledgerMergeThreshold=${config.ledgerMergeThreshold}\uFF08\u672A\u5B9E\u73B0\uFF09`);
lines.push(`- \u88C5\u914D\u7EDF\u8BA1: \u7A97\u53E3\u5185 ${stats.windowTurns} turns / ledger \u66FF\u6362 ${stats.replacedTurns} / \u539F\u6587\u900F\u4F20 ${stats.passthroughTurns}`);
lines.push(`- \u88C5\u914D\u540E\u603B\u5B57\u7B26: ${totalChars}\uFF08\u7EA6 ${Math.ceil(totalChars / 4)} tokens \u4F30\u7B97\uFF09`);
lines.push(`- \u539F\u751F\u4E0A\u4E0B\u6587\u5B57\u7B26\uFF08\u5265 thinking \u540E\uFF09: ${nativeChars}\uFF08\u7EA6 ${Math.ceil(nativeChars / 4)} tokens\uFF09`);
lines.push(`- \u88C5\u914D\u6D88\u606F\u6761\u6570: ${messages.length}`);
lines.push("");
lines.push("---");
lines.push("");
lines.push("## \u4EE5\u4E0B\u4E3A LLM \u5B9E\u9645\u6536\u5230\u7684\u4E0A\u4E0B\u6587\u539F\u6587\uFF08\u6309\u88C5\u914D\u987A\u5E8F\uFF09");
lines.push("");
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  const text = m.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  const isLedger = text.includes("<action-ledger>");
  const approxTok = Math.ceil(text.length / 4);
  lines.push(`### [${i}] role=${m.role} \xB7 ~${approxTok} tok${isLedger ? " \xB7 \u2190 \u52A8\u4F5C\u65E5\u5FD7\uFF08\u538B\u7F29\u66FF\u6362\u6BB5\uFF09" : ""}`);
  lines.push("");
  lines.push("```");
  lines.push(text);
  lines.push("```");
  lines.push("");
}
lines.push("---");
lines.push("");
lines.push("## \u9644\uFF1A\u88AB ledger \u66FF\u6362\u7684 turn \u7684\u539F\u751F\u539F\u6587\uFF08\u5373\u4E0A\u4E0B\u6587\u4E2D\u5DF2\u770B\u4E0D\u5230\u7684\u90E8\u5206\uFF09");
lines.push("");
for (let i = 0; i < turns.length; i++) {
  const t = turns[i];
  if (cache.has(t.startEntryId)) {
    lines.push(`### Turn ${i + 1}\uFF08startEntryId=${t.startEntryId}\uFF09\xB7 \u539F\u751F ~${Math.ceil(serializeTurn(t).length / 4)} tok`);
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
