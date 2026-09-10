// scripts/_asmstats.mts
import { readFileSync } from "node:fs";
import { estimateTokens as estimateTokens2 } from "@earendil-works/pi-coding-agent";

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
  const lines = ["<action-ledger>", "## \u4F1A\u8BDD\u5386\u53F2\uFF08\u52A8\u4F5C\u65E5\u5FD7\uFF0C\u7EC6\u8282\u5DF2\u538B\u7F29\uFF09", ""];
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    if (l.userMessage) {
      const recall = l.userMessage.truncated ? ` \u21A9${l.userMessage.entryId}` : "";
      lines.push(`### T${i + 1} \xB7 \u7528\u6237\uFF1A\u300C${l.userMessage.text.replace(/\n+/g, " ")}\u300D${recall}`);
    } else {
      lines.push(`### T${i + 1} \xB7 \u7528\u6237\u610F\u56FE\uFF1A${l.summary.userIntent ?? "\uFF08\u672A\u77E5\uFF09"}`);
    }
    for (const g of l.summary.groups) {
      for (const e of g.entries) {
        const recall = e.recallIds.length ? ` \u21A9${e.recallIds.join(",\u21A9")}` : "";
        lines.push(`- ${PHASE_LABEL[g.phase]}\uFF1A${e.action} ${e.target} \u2192 ${e.detail}${recall}`);
      }
    }
    if (l.finalReply) {
      lines.push("\u6700\u7EC8\u56DE\u590D\uFF08\u539F\u6587\uFF09\uFF1A");
      lines.push(l.finalReply.text);
      if (l.finalReply.truncated) lines.push(`\uFF08\u5DF2\u622A\u65AD\uFF0C\u21A9${l.finalReply.entryId} \u53D6\u56DE\u5168\u6587\uFF09`);
    } else if (l.summary.outcome !== void 0) {
      lines.push(`- \u7ED3\u679C\uFF1A${l.summary.outcome}`);
    }
    lines.push("");
  }
  lines.push("\uFF08\u9700\u8981\u4EFB\u4F55\u6761\u76EE\u7684\u9010\u5B57\u539F\u6587\u65F6\uFF0C\u8C03\u7528 recall \u5DE5\u5177\u5E76\u4F20\u5165 \u21A9 \u540E\u7684 ID\uFF09");
  lines.push("</action-ledger>");
  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now()
  };
}

// src/util.ts
import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
function splitIntoTurns(entries) {
  const turns = [];
  let current = null;
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
function findWindowTurns(turns, keepRecentTokens) {
  const window = [];
  let total2 = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const tokens = turnTokens(turns[i]);
    if (window.length > 0 && total2 + tokens > keepRecentTokens) break;
    window.unshift(turns[i]);
    total2 += tokens;
  }
  return window;
}
function assembleContext(branch2, cache2, keepRecentTokens) {
  const turns = splitIntoTurns(branch2);
  const window = findWindowTurns(turns, keepRecentTokens);
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  const stats2 = { windowTurns: window.length, replacedTurns: 0, passthroughTurns: 0 };
  const messages2 = [];
  const ledgers = [];
  for (const turn of turns) {
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
    turns.filter((t) => !windowStartIds.has(t.startEntryId) && !cache2.has(t.startEntryId)).flatMap((t) => t.entries.map((e) => e.id))
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

// scripts/_asmstats.mts
var raw = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
var branch = raw.filter((e) => e.type === "message").map((e) => ({ id: e.id, message: e.message }));
var store = new LedgerStore();
store.rebuildFromEntries(raw);
var cache = /* @__PURE__ */ new Map();
for (const k of store.keys()) cache.set(k, store.get(k));
var { messages, stats } = assembleContext(branch, cache, 2e4);
var tok = (m) => m.content.reduce((s, b) => {
  if (b?.type === "text") return s + Math.ceil(b.text.length / 4);
  if (b?.type === "toolCall") return s + Math.ceil((b.name.length + JSON.stringify(b.arguments ?? {}).length) / 4);
  if (b?.type === "thinking") return s;
  return s + Math.ceil(JSON.stringify(b).length / 4);
}, 0);
var ledgerTok = messages.filter((m) => JSON.stringify(m.content).includes("<action-ledger>")).reduce((s, m) => s + tok(m), 0);
var total = messages.reduce((s, m) => s + tok(m), 0);
var native = branch.reduce((s, e) => s + estimateTokens2(e.message), 0);
console.log(`\u539F\u751F(\u542Bthinking) ~${native} tok | \u88C5\u914D\u540E ~${total} tok | \u5176\u4E2Dledger\u5934 ~${ledgerTok} tok | \u8282\u7701 ${Math.round((1 - total / native) * 100)}%`);
console.log(`stats: ${JSON.stringify(stats)}`);
