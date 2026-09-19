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
export interface LedgerQuote {
  text: string;
  entryId: string;
  /** 用户消息中的图片元信息（仅 userMessage 提取；bytes 为 base64 估算字节） */
  images?: { mimeType: string; bytes: number }[];
}

export interface LedgerSummary { userIntent?: string; outcome?: string; entries: LedgerAction[] }

/** 降级层级：缺省视为 1（兼容旧持久化数据）；5 表示已合并为单行 */
export type LedgerLevel = 1 | 2 | 3 | 4 | 5;

export interface LedgerData {
  turnStartEntryId: string;
  turnEndEntryId: string;
  summary: LedgerSummary;
  userMessage?: LedgerQuote;  // 全量：用户原话
  finalReply?: LedgerQuote;   // 全量：最终回复
  level?: LedgerLevel;
  /** level=5 时有效：合并行描述；turn 范围由渲染时相邻 level=5 条目聚合得出 */
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

/** 图片占位行：L1–L3 渲染在用户消息行后；L4 不渲染（图片存在感靠摘要描述）。↩ 复用 userMessage.entryId */
export function renderImagesLine(l: LedgerData): string | undefined {
  const imgs = l.userMessage?.images;
  if (!imgs || imgs.length === 0) return undefined;
  const mimes = imgs.slice(0, 2).map((i) => i.mimeType).join(", ") + (imgs.length > 2 ? " …" : "");
  return `[图片 ×${imgs.length}: ${mimes} ↩${l.userMessage!.entryId}]`;
}

/** 渲染单个 turn 在其 level 下的文本块（含结尾空行）——渲染与体积计量的单一真相 */
export function renderTurnText(l: LedgerData, n: number): string {
  const lines: string[] = [];
  const lvl = l.level ?? 1;
  // L5：合并终态行，无任何 ↩IDs（拒绝召回语义，spec §7）
  if (lvl === 5) {
    const desc = l.merged?.description ?? "（已合并）";
    lines.push(`T${n} · ${desc}`);
    return lines.join("\n") + "\n";
  }
  // L4：意图 + outcome 摘要（两端 ID 仍可见，recall 走 turn 级）
  if (lvl === 4) {
    const intentId = l.userMessage?.entryId ?? l.turnStartEntryId;
    lines.push(`### T${n} · 意图：${l.summary.userIntent ?? "（未知）"} ↩${intentId}`);
    const outId = l.finalReply?.entryId ?? l.turnEndEntryId;
    lines.push(`- 最终回复（摘要）：${l.summary.outcome ?? "（无）"} ↩${outId}`);
    return lines.join("\n") + "\n";
  }
  // L1–L3 共通骨架：用户行 + 图片占位行（L3 用户侧仍是原文）
  const uq = l.userMessage;
  if (uq) {
    lines.push(`### T${n} · 用户：「${uq.text.replace(/\n+/g, " ")}」`);
  } else {
    lines.push(`### T${n} · 用户意图：${l.summary.userIntent ?? "（未知）"} ↩${l.turnStartEntryId}`);
  }
  const imagesLine = renderImagesLine(l);
  if (imagesLine) lines.push(imagesLine);
  // 动作行：L1/L2 渲染；L3 起全丢（spec §3：L3 删除的是"工具过程"这一整类信息）
  if (lvl <= 2) {
    for (const e of l.summary.entries) {
      const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
      if (lvl === 1) {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.target} → ${e.detail}${recall}`);
      } else {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.detail}${recall}`);
      }
    }
  }
  if (l.finalReply) {
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
    if ((l.level ?? 1) === 5) {
      // 聚合连续 level=5 条目为一行（终态无任何 ↩IDs，拒绝召回语义）。
      // M4 修复：组身份标记 = merged.description（同一批组的描述逐字相同）。
      // 相邻 L5 描述不同 = 不同降级批次的不同任务，必须分断各行，
      // 否则后组描述被 group[0] 覆盖而丢失（跨组行数极微，任务边界优先）。
      let end = i;
      while (
        end + 1 < ledgers.length &&
        (ledgers[end + 1].level ?? 1) === 5 &&
        ledgers[end + 1].merged?.description === l.merged?.description
      ) end++;
      const group = ledgers.slice(i, end + 1);
      // 计数重写（Codex P3）：描述后缀由 mergeDescribe 按原批次条数生成；两个条数相同的
      // 批次若模型碰巧生成同一句正文，全串相同会聚合为一行——此时旧后缀计数 < 真实范围。
      // 仅在真正聚合（>1 条）时剥旧后缀、按真实条数重写；单条保留原描述（原批次计数仍真实）。
      const rawDesc = group[0].merged?.description ?? "（已合并）";
      const desc = group.length > 1
        ? `${(rawDesc.replace(/（\d+ 条已合并）$/, "").trim() || "（已合并）")}（${group.length} 条已合并）`
        : rawDesc;
      const range = group.length > 1 ? `T${i + 1}-T${end + 1}` : `T${i + 1}`;
      lines.push(`### ${range} · ${desc}\n`);
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
  // 匹配键：优先 id 序号（同 target 不同 action 的唯一区分——纯 target 键会把
  // 先 read 后 write 同一文件的两条错配成一条混合记录，Codex P1）；无 id 时回退 target。
  const byId = new Map(actions.map((a, i) => [i, { a, order: i }]));
  const byTarget = new Map<string, Array<{ a: (typeof actions)[number]; order: number }>>();
  actions.forEach((a, i) => {
    const list = byTarget.get(a.target) ?? [];
    list.push({ a, order: i });
    byTarget.set(a.target, list);
  });
  const consumedByTarget = new Map<string, number>(); // 无 id 回退时同 target 第 n 次输出配第 n 个机械条目
  const picked: Array<LedgerAction & { _order: number }> = [];
  const seen = new Set<number>(); // 同一机械条目被模型重复输出只取首次
  const addRaw = (idOut: unknown, targetOut: unknown, detailOut: unknown, entryPhase: unknown, groupPhase: unknown) => {
    let mech: (typeof actions)[number] | undefined;
    let order: number | undefined;
    const idNum = Number(idOut);
    if (idOut !== undefined && idOut !== null && idOut !== "" && Number.isInteger(idNum) && byId.has(idNum)) {
      ({ a: mech, order } = byId.get(idNum)!);
    } else {
      // 旧格式/无 id：按 target 轮转匹配（同 target 第 n 次输出配第 n 个机械条目，不再互相吞掉）
      const list = byTarget.get(String(targetOut));
      if (!list) return;
      const used = consumedByTarget.get(String(targetOut)) ?? 0;
      if (used >= list.length) return;
      consumedByTarget.set(String(targetOut), used + 1);
      ({ a: mech, order } = list[used]);
    }
    if (seen.has(order!)) return;
    if (verbatimCheck) {
      const suspicious = String(detailOut ?? "").match(PATH_RE) ?? [];
      if (suspicious.some((p) => !turnText.includes(p) && !mech.target.includes(p))) return;
    }
    seen.add(order!);
    const p = entryPhase ?? groupPhase;
    picked.push({
      action: mech.action, target: mech.target, detail: String(detailOut ?? ""),
      recallIds: mech.entryIds,
      phase: LEDGER_PHASES.includes(p as LedgerPhase) ? (p as LedgerPhase) : "other",
      _order: order!,
    });
  };
  if (Array.isArray(parsed?.entries)) {
    for (const e of parsed.entries) addRaw(e?.id, e?.target ?? e?.id, e?.detail, e?.phase, undefined);
  }
  if (groups) {
    for (const g of groups) {
      for (const e of (g?.entries ?? []) as Array<Record<string, unknown>>) {
        addRaw(e?.id, e?.target ?? e?.id, e?.detail, e?.phase, g?.phase);
      }
    }
  }
  picked.sort((a, b) => a._order - b._order);
  const entries = picked.map(({ _order, ...rest }) => rest) as LedgerAction[];
  return { entries }; // userIntent/outcome 由系统机械保存，模型输出一律忽略
}
