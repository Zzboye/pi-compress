import { stripThinking, serializeForRecall, truncateToTokens, type MessageEntry, type Turn } from "./util.js";
import type { LedgerData, LedgerLevel } from "./ledger.js";
import type { NoteStore } from "./notes.js";

/** recall 召回的图片块：block 可直接作为 pi 工具结果的 image content，sourceId 标注来源 entry */
export interface RecallImage { block: { type: "image"; data: string; mimeType: string }; sourceId: string }
export interface RecallResult { text: string; missing: string[]; notesHits: number; images: RecallImage[]; rejected?: number }

/** recall 层级路由上下文：ledgers 按 branch 序（index.ts 的 ledgersInBranchOrder 产出） */
export interface RecallDegradeCtx { ledgers: LedgerData[]; turns: Turn[] }

/** 收集消息 content 中的 image 块（同 mimeType+data 去重）：entry 级与 turn 级路径共用 */
function collectImages(m: any, sourceId: string, imgs: RecallImage[], seen: Set<string>): void {
  if (Array.isArray(m?.content)) {
    for (const b of m.content) {
      if (b?.type === "image" && typeof b.data === "string") {
        const key = `${b.mimeType ?? "image/png"}:${b.data}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imgs.push({ block: { type: "image", data: b.data, mimeType: b.mimeType ?? "image/png" }, sourceId });
      }
    }
  }
}

export function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset = 0): RecallResult {
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
  const images: RecallImage[] = [];
  let rejected = 0;
  // offset 分页仅支持单 ID（多 ID 各有一段文本，offset 语义歧义）：多 ID 直接给用法提示
  if (offset > 0 && ids.length !== 1) {
    return { text: "offset 分页仅支持单 ID：请一次只传一个 ID（如 recall({ ids: [\"↩id\"], offset: 12345 })）。", missing: [], notesHits: 0, images: [], rejected: 0 };
  }
  // F1 去重：turnStartEntryId → 首个返回整段原文的 ID。多 ID 命中同一 L3/L4 turn 时，
  // 后续 ID 只给一行提示，不重复整段原文、不重复 push 图片。
  const seenTurns = new Map<string, string>();
  // entryId → 所属 turn；turnStartEntryId → ledger 层级（spec §7 三档路由）
  const turnOfEntry = new Map<string, Turn>();
  for (const t of degradeCtx?.turns ?? []) for (const e of t.entries) turnOfEntry.set(e.id, t);
  const levelOfTurn = new Map<string, number>();
  for (const l of degradeCtx?.ledgers ?? []) levelOfTurn.set(l.turnStartEntryId, l.level ?? 1);
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    const turn = degradeCtx ? turnOfEntry.get(id) : undefined;
    const lvl = turn ? levelOfTurn.get(turn.startEntryId) ?? 1 : 1;
    if (turn && lvl >= 3 && lvl <= 4) {
      const firstId = seenTurns.get(turn.startEntryId);
      if (firstId !== undefined) {
        // 同 turn 已随前一个 ID 返回过整段原文：不重复全文/图片（F1）
        parts.push(`【${id}】该 turn 原文已随 ↩${firstId} 返回，不重复输出。`);
        continue;
      }
      seenTurns.set(turn.startEntryId, id);
      // turn 级：整段原文（恢复被丢的工具过程/两端原文，spec §7）。截断按 token 预算
      // （CJK 感知，见 truncateToTokens）；offset 续取下一段（无 offset 时从 0 起）。
      const full = serializeForRecall(turn.entries.map((te) => ({ id: te.id, message: te.message as any })));
      if (offset >= full.length) {
        parts.push(`【${id}】offset ${offset} 超出该条目长度（${full.length} 字符），无可续取内容。`);
        continue;
      }
      const seg = truncateToTokens(full.slice(offset), maxTokensPerEntry);
      let text = offset > 0 ? `（从 offset ${offset} 起）\n${seg.text}` : seg.text;
      if (seg.truncated) {
        const rest = full.length - offset - seg.text.length;
        text += `\n…（已截断，剩余 ${rest} 字符；传 offset=${offset + seg.text.length} 继续）`;
      }
      const imgs: RecallImage[] = [];
      const seen = new Set<string>();
      for (const te of turn.entries) collectImages(te.message, id, imgs, seen);
      if (imgs.length > 0) { text += `\n[含图片 ×${imgs.length}，已附在结果中]`; images.push(...imgs); }
      parts.push(`【${id} 所在 turn（L${lvl}）的整段原文】\n${text}`);
      continue;
    }
    if (turn && lvl === 5) {
      // L5 终态：拒绝召回（防连环巨条挤爆上下文，spec §7）。
      // rejected 单独计数（M9）：不计入 hits/missing，统计口径区分「拒发」与「未中」。
      rejected += 1;
      parts.push(`【${id}】该 turn 已合并为终态摘要（L5），仅保留合并描述，细节不可恢复。`);
      continue;
    }
    const msgs = [e.message];
    if (e.message.role === "assistant") {
      for (const block of e.message.content as any[]) {
        if (block?.type !== "toolCall") continue;
        const r = resultByCallId.get(block.id);
        if (r) msgs.push(r.message);
      }
    }
    // serializeForRecall：与 pi 同格式但 toolResult 不截断（pi 原版纯头截 2000 字符，
    // 尾部结论丢失，超长结果无法完整 recall）。预算截断按 token（truncateToTokens），
    // 超出部分可用 offset 续取。
    const full = serializeForRecall(msgs.map((m, i) => ({ id: i === 0 ? id : `${id}-r${i}`, message: m as any })));
    if (offset >= full.length) {
      parts.push(`【${id}】offset ${offset} 超出该条目长度（${full.length} 字符），无可续取内容。`);
      continue;
    }
    const seg = truncateToTokens(full.slice(offset), maxTokensPerEntry);
    let text = offset > 0 ? `（从 offset ${offset} 起）\n${seg.text}` : seg.text;
    if (seg.truncated) {
      const rest = full.length - offset - seg.text.length;
      text += `\n…（已截断，剩余 ${rest} 字符；传 offset=${offset + seg.text.length} 继续）`;
    }
    // 图片召回：命中 entry 自身及配对 toolResult content 中的 image 块原样带回（sourceId 标注来源）。
    // 同图去重：同 mimeType+data 的块只收一次（assistant 自含+配对 toolResult 双路径常见重复）。
    // 提示行加在截断之后，保证不被截掉。
    const imgs: RecallImage[] = [];
    const seen = new Set<string>();
    for (const m of msgs) collectImages(m, id, imgs, seen);
    if (imgs.length > 0) {
      text += `\n[含图片 ×${imgs.length}，已附在结果中]`;
      images.push(...imgs);
    }
    parts.push(`【${id} 的原文】\n${text}`);
  }
  if (missing.length > 0) {
    parts.push(`以下 ID 不在当前分支中（可能因 /tree 回退）：${missing.join(", ")}。可尝试 recall 相邻 turn 的 ID。`);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing, notesHits: 0, images, rejected };
}

// ---------- 双源 recall（notes 优先，branch 兜底）----------

const NOTE_PREFIX_RE = /^(fb|task|pref)-/;

/**
 * 双源 recall：ID 剥掉前导 ↩ 后以 fb-/task-/pref- 开头且 notes 已启用时，
 * 先查 notes（返回 detail，而非 branch 原文）；其余 ID 走现有 executeRecall 路径（行为与文案不变）。
 */
export function executeRecallDual(ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset = 0): RecallResult {
  const entryIds: string[] = [];
  const parts: string[] = [];
  const missing: string[] = [];
  const allImages: RecallImage[] = [];
  let notesHits = 0;
  for (const raw of ids) {
    const id = raw.replace(/^[↩]+/, "");
    if (NOTE_PREFIX_RE.test(id) && notes) {
      const e = notes.findById(id);
      if (!e) { missing.push(id); parts.push(`【${id}】\n（记忆条目 ${id} 不存在或已删除）`); continue; }
      notesHits += 1;
      parts.push(e.detail?.trim() ? `【${id} 的记忆详情】\n${e.detail}` : `【${id}】\n（该条目无详情）`);
      continue;
    }
    entryIds.push(raw);
  }
  let rejected = 0;
  if (entryIds.length > 0) {
    const r = executeRecall(entryIds, branch, maxTokensPerEntry, degradeCtx, offset);
    parts.unshift(r.text);
    missing.unshift(...r.missing);
    allImages.push(...r.images);
    rejected = r.rejected ?? 0;
  }
  return { text: parts.join("\n\n") || "（无内容）", missing, notesHits, images: allImages, rejected };
}

// ---------- 关键词检索（searchLedger）----------

export interface SearchHit {
  turnLabel: string;   // "T12" 或 "T29-T33"（L5 已聚合组显示组范围，与 renderActionLedger 的 T 序号同口径：数组下标+1）
  level: LedgerLevel; // 随 LedgerLevel 放宽至 1-5；L5 拒绝召回由 executeRecall 防御（Task 3）
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

/** 旧 groups schema 兼容（recall 可能处理未经渲染层 normalize 的持久化数据） */
function legacyGroups(l: LedgerData): import("./ledger.js").LedgerAction[] {
  const out: import("./ledger.js").LedgerAction[] = [];
  for (const g of (l.summary as any).groups ?? []) {
    for (const e of g.entries ?? []) out.push({ ...e, phase: g.phase ?? "other" });
  }
  return out;
}

/** 与 ledger.ts 的 allRecallIds 同口径（不导出，此处本地实现）：动作 recallIds 在前，附两端 entryId */
function allRecallIdsOf(l: LedgerData, includeAllQuotes: boolean): string[] {
  const ids: string[] = [];
  for (const e of l.summary.entries ?? legacyGroups(l)) ids.push(...e.recallIds);
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
    if (lvl === 5) {
      // L5 组范围：向后聚合连续 level=5（renderActionLedger 同款边界）。
      // Task 2 阶梯右移：合并组从 L4 变为 L5，聚合边界随之改为 5。
      // M4 修复：与渲染层同款——描述不同 = 不同降级批次，按组分断。
      let end = i;
      while (
        end + 1 < ledgers.length &&
        (ledgers[end + 1].level ?? 1) === 5 &&
        ledgers[end + 1].merged?.description === l.merged?.description
      ) end++;
      const label = end > i ? `T${i + 1}-T${end + 1}` : `T${i + 1}`;
      for (let j = i; j <= end; j++) {
        const m = ledgers[j];
        if (m.merged?.description) push(label, 5, "合并描述", m.merged.description, allRecallIdsOf(m, true));
      }
      i = end;
      continue;
    }
    const label = `T${i + 1}`;
    if (l.userMessage) push(label, lvl, "用户消息", l.userMessage.text, [l.userMessage.entryId]);
    if (l.finalReply) push(label, lvl, "最终回复", l.finalReply.text, [l.finalReply.entryId]);
    for (const e of l.summary.entries ?? legacyGroups(l)) {
      push(label, lvl, "动作", `${e.target} → ${e.detail}`, e.recallIds);
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
  const lvlAbbr: Record<number, string> = { 1: "L1", 2: "L2", 3: "L3", 4: "L4", 5: "L5" };
  const lines = r.hits.map((h) => {
    const ids = h.entryIds.length ? ` ↩${h.entryIds.join(",↩")}` : "";
    return `${h.turnLabel} [${lvlAbbr[h.level]}] ${h.field}：${h.snippet}${ids}`;
  });
  const tail = r.truncated ? `\n（命中过多，仅显示前 ${r.hits.length} 条；请换更具体的关键词缩小范围）` : "";
  return `命中 ${r.hits.length} 处：\n${lines.join("\n")}${tail}\n\n需要逐字原文时，调用 recall 并传入对应 ↩ 后的 ID。`;
}
