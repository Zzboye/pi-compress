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

describe("renderActionLedger 双格式", () => {
  const modern: LedgerData = {
    turnStartEntryId: "e001",
    turnEndEntryId: "e018",
    summary: { groups: [] },
    userMessage: { text: "这次对话怎么没有启动摘要？", entryId: "e001", truncated: false },
    finalReply: { text: "插件正常，成功路径完全静默。", entryId: "e018", truncated: false },
  };

  function renderText(l: LedgerData[]): string {
    const msg = renderActionLedger(l);
    return ((msg as any).content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
  }

  it("新格式：用户原话 + 最终回复原文", () => {
    const text = renderText([modern]);
    expect(text).toContain("T1 · 用户：「这次对话怎么没有启动摘要？」");
    expect(text).toContain("最终回复（原文）：");
    expect(text).toContain("插件正常，成功路径完全静默。");
    expect(text).not.toContain("用户意图：");
    expect(text).not.toContain("结果：");
  });

  it("截断时附 recall 句柄", () => {
    const l: LedgerData = {
      ...modern,
      userMessage: { text: "前两百字符…\n[... 已截断，后续 3000 字符省略 ...]", entryId: "e001", truncated: true },
      finalReply: { text: "开头…\n[... 中间省略 5000 字符 ...]\n…结尾", entryId: "e018", truncated: true },
    };
    const text = renderText([l]);
    expect(text).toContain("T1 · 用户：「前两百字符… [... 已截断，后续 3000 字符省略 ...]」 ↩e001"); // \n 折叠为空格
    expect(text).toContain("（已截断，↩e018 取回全文）");
  });

  it("混合：有用户原话无最终回复 → 无结果行", () => {
    const text = renderText([{ ...modern, finalReply: undefined }]);
    expect(text).toContain("T1 · 用户：「");
    expect(text).not.toContain("最终回复");
    expect(text).not.toContain("结果：");
  });

  it("旧格式回落：userIntent/outcome 照旧渲染", () => {
    const text = renderText([sample]); // 现有 legacy fixture
    expect(text).toContain("T1 · 用户意图：修复内存泄漏");
    expect(text).toContain("- 结果：hooks.ts:34 清理函数缺失，已修复");
    expect(text).not.toContain("最终回复");
  });
});
