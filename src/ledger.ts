import type { AgentMessage } from "./types.js";
import type { ToolActionInfo } from "./prompts.js";

export const LEDGER_CUSTOM_TYPE = "context-compress:ledger";

export type LedgerPhase = "investigate" | "fix" | "verify" | "discuss" | "other";
export const LEDGER_PHASES: readonly LedgerPhase[] = ["investigate", "fix", "verify", "discuss", "other"];

/** 扁平动作条目：phase 为每条自带标签；顺序 = 机械时间序（模型不可重排，parse 时机械归位） */
export interface LedgerAction {
  action: string;
  target: string;
  detail: string;
  recallIds: string[];
  phase: LedgerPhase;
}

/** 逐字引用（L1 起为全量原文）；entryId 供 recall 取回原文 */
export interface LedgerQuote { text: string; entryId: string }

export interface LedgerSummary { userIntent?: string; outcome?: string; entries: LedgerAction[] }

/** 降级层级：缺省视为 1（兼容旧持久化数据）；4 表示已合并为单行 */
export type LedgerLevel = 1 | 2 | 3 | 4;

export interface LedgerData {
  turnStartEntryId: string;
  turnEndEntryId: string;
  summary: LedgerSummary;
  userMessage?: LedgerQuote;  // 全量：用户原话
  finalReply?: LedgerQuote;   // 全量：最终回复
  level?: LedgerLevel;
  /** level=4 时有效：合并行描述；turn 范围由渲染时相邻 level=4 条目聚合得出 */
  merged?: { description: string };
}

const PHASE_LABEL: Record<LedgerPhase, string> = {
  investigate: "调查", fix: "修复", verify: "验证", discuss: "讨论", other: "其他",
};

/** 旧 schema（groups 嵌套）→ 扁平 entries；新数据原样返回 */
interface LegacyGroup { phase?: unknown; entries?: unknown[] }
interface LegacySummary { userIntent?: string; outcome?: string; groups?: LegacyGroup[]; entries?: LedgerAction[] }
export function normalizeLedgerData(d: LedgerData): LedgerData {
  const s = d.summary as unknown as LegacySummary;
  if (Array.isArray(s.entries)) return d;
  const entries: LedgerAction[] = [];
  for (const g of s.groups ?? []) {
    const phase: LedgerPhase = LEDGER_PHASES.includes(g?.phase as LedgerPhase) ? (g.phase as LedgerPhase) : "other";
    for (const raw of g?.entries ?? []) {
      const e = raw as Partial<LedgerAction>;
      if (!e) continue;
      entries.push({
        action: String(e.action ?? ""),
        target: String(e.target ?? ""),
        detail: String(e.detail ?? ""),
        recallIds: Array.isArray(e.recallIds) ? e.recallIds.map(String) : [],
        phase,
      });
    }
  }
  return { ...d, summary: { userIntent: s.userIntent, outcome: s.outcome, entries } };
}

/** 条目全部 recall IDs：动作 recallIds 在前，随后附两端 entryId（includeAllQuotes 供 L4 用，原文已不可见仍可 recall）；有序去重 */
function allRecallIds(l: LedgerData, includeAllQuotes = false): string[] {
  const ids: string[] = [];
  for (const e of l.summary.entries) ids.push(...e.recallIds);
  const um = l.userMessage, fr = l.finalReply;
  if (um && includeAllQuotes) ids.push(um.entryId);
  if (fr && includeAllQuotes) ids.push(fr.entryId);
  return [...new Set(ids)];
}

/** 渲染单个 turn 在其 level 下的文本块（含结尾空行）——渲染与体积计量的单一真相 */
export function renderTurnText(l: LedgerData, n: number): string {
  const lines: string[] = [];
  const lvl = l.level ?? 1;
  if (lvl === 4) {
    const desc = l.merged?.description ?? "（已合并）";
    const ids = allRecallIds(l, true);
    lines.push(`T${n} · ${desc}${ids.length ? `↩${ids.join(",↩")}` : ""}`);
    return lines.join("\n") + "\n";
  }
  if (lvl === 3) {
    const intentId = l.userMessage?.entryId ?? l.turnStartEntryId;
    lines.push(`### T${n} · 意图：${l.summary.userIntent ?? "（未知）"} ↩${intentId}`);
  } else {
    const uq = l.userMessage;
    if (uq) {
      lines.push(`### T${n} · 用户：「${uq.text.replace(/\n+/g, " ")}」`);
    } else {
      lines.push(`### T${n} · 用户意图：${l.summary.userIntent ?? "（未知）"}`);
    }
  }
  for (const e of l.summary.entries) {
    const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
    if (lvl === 1) {
      lines.push(`- ${PHASE_LABEL[e.phase]}：${e.target} → ${e.detail}${recall}`);
    } else { // L2/L3：丢 target/命令
      lines.push(`- ${PHASE_LABEL[e.phase]}：${e.detail}${recall}`);
    }
  }
  if (lvl === 3) {
    const outId = l.finalReply?.entryId ?? l.turnEndEntryId;
    lines.push(`- 最终回复（摘要）：${l.summary.outcome ?? "（无）"} ↩${outId}`);
  } else if (l.finalReply) {
    lines.push("最终回复（原文）：");
    lines.push(l.finalReply.text);
  } else if (l.summary.outcome !== undefined) {
    lines.push(`- 结果：${l.summary.outcome}`);
  }
  return lines.join("\n") + "\n";
}

/** 召回使用提示：日志头首尾各放一次（开头建立 ↩ 语义，末尾就近提醒） */
export const RECALL_HINT = "（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）";

export function renderActionLedger(rawLedgers: LedgerData[]): AgentMessage {
  const ledgers = rawLedgers.map(normalizeLedgerData); // 旧 groups 数据惰性转换
  const lines: string[] = ["<action-ledger>", "## 会话历史（动作日志，细节已压缩）", "", RECALL_HINT];
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    if ((l.level ?? 1) === 4) {
      // 聚合连续 level=4 条目为一行（turn 范围 + 全部条目 recallIds 有序去重并集）
      let end = i;
      while (end + 1 < ledgers.length && (ledgers[end + 1].level ?? 1) === 4) end++;
      const group = ledgers.slice(i, end + 1);
      const ids: string[] = [];
      for (const m of group) ids.push(...allRecallIds(m, true));
      const uniq = [...new Set(ids)];
      const desc = group[0].merged?.description ?? "（已合并）";
      const range = group.length > 1 ? `T${i + 1}-T${end + 1}` : `T${i + 1}`;
      lines.push(`### ${range} · ${desc}${uniq.length ? `↩${uniq.join(",↩")}` : ""}\n`);
      i = end;
      continue;
    }
    lines.push(renderTurnText(l, i + 1).trimEnd());
    lines.push("");
  }
  lines.push(RECALL_HINT);
  lines.push("</action-ledger>");
  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}

export class LedgerParseError extends Error {}

const PATH_RE = /[\w./\\-]+\.\w{1,4}/g; // 提取 detail 中疑似路径/文件名做逐字校验

export function parseLedgerOutput(
  raw: string, actions: ToolActionInfo[], turnText: string, verbatimCheck: boolean,
): LedgerSummary {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new LedgerParseError("model output is not valid JSON");
  }
  // 兼容旧 groups schema；新 schema 为扁平 entries（每条自带可选 phase）
  const groups: LegacyGroup[] | undefined = Array.isArray(parsed?.groups) ? parsed.groups : undefined;
  if (!Array.isArray(parsed?.entries) && !groups) {
    throw new LedgerParseError("model output missing required fields");
  }
  const byTarget = new Map(actions.map((a) => [a.target, a]));
  // 机械时间序位置：模型只能标注 phase，不能决定顺序（分组归并曾导致 5/57 逆序）
  const order = new Map(actions.map((a, i) => [a.target, i]));
  const picked: Array<LedgerAction & { _order: number }> = [];
  const seen = new Set<string>(); // 同一机械条目被模型重复输出（新旧 schema 交叠）只取首次
  const addRaw = (targetOut: unknown, detailOut: unknown, entryPhase: unknown, groupPhase: unknown) => {
    const mech = byTarget.get(String(targetOut));
    if (!mech) return;
    if (seen.has(mech.target)) return;
    if (verbatimCheck) {
      const suspicious = String(detailOut ?? "").match(PATH_RE) ?? [];
      if (suspicious.some((p) => !turnText.includes(p) && !mech.target.includes(p))) return;
    }
    seen.add(mech.target);
    const p = entryPhase ?? groupPhase;
    picked.push({
      action: mech.action, target: mech.target, detail: String(detailOut ?? ""),
      recallIds: mech.entryIds,
      phase: LEDGER_PHASES.includes(p as LedgerPhase) ? (p as LedgerPhase) : "other",
      _order: order.get(mech.target)!,
    });
  };
  if (Array.isArray(parsed?.entries)) {
    for (const e of parsed.entries) addRaw(e?.target, e?.detail, e?.phase, undefined);
  }
  if (groups) {
    for (const g of groups) {
      for (const e of (g?.entries ?? []) as Array<Record<string, unknown>>) {
        addRaw(e?.target, e?.detail, e?.phase, g?.phase);
      }
    }
  }
  picked.sort((a, b) => a._order - b._order);
  const entries = picked.map(({ _order, ...rest }) => rest) as LedgerAction[];
  return { entries }; // userIntent/outcome 由系统机械保存，模型输出一律忽略
}
