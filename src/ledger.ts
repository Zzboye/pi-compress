import type { AgentMessage } from "@earendil-works/pi-coding-agent";

export const LEDGER_CUSTOM_TYPE = "context-compress:ledger";

export interface LedgerAction { action: string; target: string; detail: string; recallIds: string[] }
export interface LedgerGroup { phase: "investigate" | "fix" | "verify" | "discuss" | "other"; entries: LedgerAction[] }
export interface LedgerSummary { userIntent: string; outcome: string; groups: LedgerGroup[] }
export interface LedgerData { turnStartEntryId: string; turnEndEntryId: string; summary: LedgerSummary }

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
