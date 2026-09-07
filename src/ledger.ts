import type { AgentMessage } from "./types.js";
import type { ToolActionInfo } from "./prompts.js";

export const LEDGER_CUSTOM_TYPE = "context-compress:ledger";

export interface LedgerAction { action: string; target: string; detail: string; recallIds: string[] }
export interface LedgerGroup { phase: "investigate" | "fix" | "verify" | "discuss" | "other"; entries: LedgerAction[] }
/** 机械截断的逐字引用：text 已内嵌省略标记，entryId 供 recall 取回全文 */
export interface LedgerQuote { text: string; entryId: string; truncated: boolean }

export interface LedgerSummary { userIntent?: string; outcome?: string; groups: LedgerGroup[] }

export interface LedgerData {
  turnStartEntryId: string;
  turnEndEntryId: string;
  summary: LedgerSummary;
  userMessage?: LedgerQuote;  // 机械：用户原话（头 200 截断）
  finalReply?: LedgerQuote;   // 机械：最终回复（头 800/尾 1200 截断）
}

const PHASE_LABEL: Record<LedgerGroup["phase"], string> = {
  investigate: "调查", fix: "修复", verify: "验证", discuss: "讨论", other: "其他",
};

export function renderActionLedger(ledgers: LedgerData[]): AgentMessage {
  const lines: string[] = ["<action-ledger>", "## 会话历史（动作日志，细节已压缩）", ""];
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    lines.push(`### T${i + 1} · 用户意图：${l.summary.userIntent}`);
    for (const g of l.summary.groups) {
      for (const e of g.entries) {
        const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
        lines.push(`- ${PHASE_LABEL[g.phase]}：${e.action} ${e.target} → ${e.detail}${recall}`);
      }
    }
    lines.push(`- 结果：${l.summary.outcome}`);
    lines.push("");
  }
  lines.push("（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）");
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
  if (typeof parsed?.userIntent !== "string" || typeof parsed?.outcome !== "string" || !Array.isArray(parsed?.groups)) {
    throw new LedgerParseError("model output missing required fields");
  }
  const byTarget = new Map(actions.map((a) => [a.target, a]));
  const groups: LedgerGroup[] = [];
  for (const g of parsed.groups) {
    const phase = (["investigate", "fix", "verify", "discuss", "other"] as const).includes(g?.phase) ? g.phase : "other";
    const entries: LedgerAction[] = [];
    for (const e of g?.entries ?? []) {
      const mech = byTarget.get(e?.target);
      if (!mech) continue; // 模型编造的 target → 剔除
      if (verbatimCheck) {
        const suspicious = String(e.detail ?? "").match(PATH_RE) ?? [];
        if (suspicious.some((p) => !turnText.includes(p) && !mech.target.includes(p))) continue; // 失真 → 剔除
      }
      entries.push({ action: mech.action, target: mech.target, detail: String(e.detail ?? ""), recallIds: mech.entryIds });
    }
    groups.push({ phase, entries }); // 空组保留：逐字校验剔除条目后组仍存在（prompts.test.ts verbatim guard 用例要求 groups[0].entries.length===0）
  }
  return { userIntent: parsed.userIntent, outcome: parsed.outcome, groups };
}
