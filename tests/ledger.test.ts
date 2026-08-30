import { describe, it, expect } from "vitest";
import { renderActionLedger, type LedgerData } from "../src/ledger.js";

const sample: LedgerData = {
  turnStartEntryId: "e001",
  turnEndEntryId: "e018",
  summary: {
    userIntent: "修复内存泄漏",
    outcome: "hooks.ts:34 清理函数缺失，已修复",
    groups: [
      {
        phase: "investigate",
        entries: [
          { action: "read", target: "src/hooks.ts", detail: "发现 useEffect 清理函数缺失", recallIds: ["e003", "e005"] },
        ],
      },
      {
        phase: "verify",
        entries: [
          { action: "bash", target: "npm test", detail: "3 passed", recallIds: ["e012"] },
        ],
      },
    ],
  },
};

describe("renderActionLedger", () => {
  it("renders markdown with header, turns, actions and recall markers", () => {
    const msg = renderActionLedger([sample]);
    expect(msg.role).toBe("user");
    const text = ((msg as any).content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).toContain("<action-ledger>");
    expect(text).toContain("T1 · 用户意图：修复内存泄漏");
    expect(text).toContain("调查：read src/hooks.ts → 发现 useEffect 清理函数缺失 ↩e003,↩e005");
    expect(text).toContain("验证：bash npm test → 3 passed ↩e012");
    expect(text).toContain("recall");
  });

  it("numbers turns sequentially", () => {
    const msg = renderActionLedger([sample, sample]);
    const text = ((msg as any).content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).toContain("T1 ·");
    expect(text).toContain("T2 ·");
  });

  it("returns empty ledger message when no ledgers", () => {
    const msg = renderActionLedger([]);
    const text = ((msg as any).content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).not.toContain("T1");
  });
});
