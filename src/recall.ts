import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import { stripThinking, type MessageEntry } from "./util.js";
import type { LedgerData, LedgerLevel } from "./ledger.js";
import type { NoteStore } from "./notes.js";

export interface RecallResult { text: string; missing: string[]; notesHits: number }

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
  return { text: parts.join("\n\n") || "（无内容）", missing, notesHits: 0 };
}

// ---------- 双源 recall（notes 优先，branch 兜底）----------

const NOTE_PREFIX_RE = /^(fb|task|pref)-/;

/**
 * 双源 recall：ID 剥掉前导 ↩ 后以 fb-/task-/pref- 开头且 notes 已启用时，
 * 先查 notes（返回 detail，而非 branch 原文）；其余 ID 走现有 executeRecall 路径（行为与文案不变）。
 */
export function executeRecallDual(ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number): RecallResult {
  const entryIds: string[] = [];
  const parts: string[] = [];
  const missing: string[] = [];
  let notesHits = 0;
  for (const raw of ids) {
    const id = raw.replace(/^↩/, "");
    if (NOTE_PREFIX_RE.test(id) && notes) {
      const e = notes.findById(id);
      if (!e) { missing.push(id); parts.push(`【${id}】\n（记忆条目 ${id} 不存在或已删除）`); continue; }
      notesHits += 1;
      parts.push(e.detail ? `【${id} 的记忆详情】\n${e.detail}` : `【${id}】\n（该条目无详情）`);
      continue;
    }
    entryIds.push(raw);
  }
  if (entryIds.length > 0) {
    const r = executeRecall(entryIds, branch, maxTokensPerEntry);
    parts.unshift(r.text);
    missing.unshift(...r.missing);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing, notesHits };
}

// ---------- 关键词检索（searchLedger）----------

export interface SearchHit {
  turnLabel: string;   // "T12" 或 "T29-T33"（L4 已聚合组显示组范围，与 renderActionLedger 的 T 序号同口径：数组下标+1）
  level: 1 | 2 | 3 | 4;
  field: string;       // "用户消息" | "最终回复" | "动作" | "合并描述"
  snippet: string;     // 命中行片段（截断到 ~200 chars）
  entryIds: string[];  // 该字段关联、可直接 recall 的 ID（有序去重，与 executeRecall 同一命名空间）
}
export interface SearchResult { hits: SearchHit[]; truncated: boolean }

const SNIPPET_MAX = 200;
const SNIPPET_CONTEXT = 60;

function makeSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, idx + query.length + SNIPPET_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  let s = (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX) + "…";
  return s;
}

/** 与 ledger.ts 的 allRecallIds 同口径（不导出，此处本地实现）：动作 recallIds 在前，附两端 entryId */
function allRecallIdsOf(l: LedgerData, includeAllQuotes: boolean): string[] {
  const ids: string[] = [];
  for (const g of l.summary.groups) for (const e of g.entries) ids.push(...e.recallIds);
  if (includeAllQuotes && l.userMessage) ids.push(l.userMessage.entryId);
  if (includeAllQuotes && l.finalReply) ids.push(l.finalReply.entryId);
  return [...new Set(ids)];
}

/**
 * 关键词检索：在 LedgerData 全量字段（userMessage.text / finalReply.text / target+detail / merged.description，
 * 不受渲染层级影响）做大小写不敏感子串匹配。每个命中的「字段」产出一个 hit，entryIds 指向该字段的来源条目，
 * 召回必中（/tree 回退除外）。
 * turnLabel 按数组下标生成（renderActionLedger 同款 T 序号）；连续 level=4 聚合为一组，组内每条
 * merged.description 均可命中且共用组范围标签（如 "T3-T4"），与渲染时的聚合行对齐。
 */
export function searchLedger(query: string, ledgers: LedgerData[], maxHits: number): SearchResult {
  const q = query.trim();
  if (!q) return { hits: [], truncated: false }; // 空 query 防全量倾泻
  const lower = q.toLowerCase();
  const hits: SearchHit[] = [];
  const push = (turnLabel: string, level: LedgerLevel, field: string, text: string, ids: string[]) => {
    if (text && text.toLowerCase().includes(lower)) {
      hits.push({ turnLabel, level, field, snippet: makeSnippet(text, q), entryIds: [...new Set(ids)] });
    }
  };
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    const lvl = (l.level ?? 1) as LedgerLevel;
    if (lvl === 4) {
      // L4 组范围：向后聚合连续 level=4（renderActionLedger 同款边界）
      let end = i;
      while (end + 1 < ledgers.length && (ledgers[end + 1].level ?? 1) === 4) end++;
      const label = end > i ? `T${i + 1}-T${end + 1}` : `T${i + 1}`;
      for (let j = i; j <= end; j++) {
        const m = ledgers[j];
        if (m.merged?.description) push(label, 4, "合并描述", m.merged.description, allRecallIdsOf(m, true));
      }
      i = end;
      continue;
    }
    const label = `T${i + 1}`;
    if (l.userMessage) push(label, lvl, "用户消息", l.userMessage.text, [l.userMessage.entryId]);
    if (l.finalReply) push(label, lvl, "最终回复", l.finalReply.text, [l.finalReply.entryId]);
    for (const g of l.summary.groups) {
      for (const e of g.entries) push(label, lvl, "动作", `${e.target} → ${e.detail}`, e.recallIds);
    }
  }
  return { hits: hits.slice(0, Math.max(0, maxHits)), truncated: hits.length > maxHits };
}

/**
 * LLM 可见的命中索引文本：命中行 = turn 标签 + [层级缩写] 字段：片段 ↩ids。
 * 只给定位与 ID，不给原文；无命中时给可操作的换词建议。
 */
export function formatSearchResult(r: SearchResult): string {
  if (r.hits.length === 0) {
    return "无命中。建议：换更短或更具体的关键词（如文件名、函数名、命令词）；动作日志只覆盖窗外已摘要的 turn，近期内容可能仍在上下文窗口内。";
  }
  const lvlAbbr: Record<number, string> = { 1: "L1", 2: "L2", 3: "L3", 4: "L4" };
  const lines = r.hits.map((h) => {
    const ids = h.entryIds.length ? ` ↩${h.entryIds.join(",↩")}` : "";
    return `${h.turnLabel} [${lvlAbbr[h.level]}] ${h.field}：${h.snippet}${ids}`;
  });
  const tail = r.truncated ? `\n（命中过多，仅显示前 ${r.hits.length} 条；请换更具体的关键词缩小范围）` : "";
  return `命中 ${r.hits.length} 处：\n${lines.join("\n")}${tail}\n\n需要逐字原文时，调用 recall 并传入对应 ↩ 后的 ID。`;
}
