import { describe, it, expect } from "vitest";
import { renderActionLedger, type LedgerData } from "../src/ledger.js";

function textOf(msg: any): string {
  return msg.content.map((c: any) => c.text ?? "").join("");
}

const full: LedgerData = {
  turnStartEntryId: "e001", turnEndEntryId: "e018", level: 1,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e001" },
  summary: { groups: [{ phase: "investigate", entries: [
    { action: "bash", target: "cat src/ledger.ts", detail: "阅读核心数据结构", recallIds: ["e003"] },
  ] }] },
  finalReply: { text: "我已经看完当前代码……", entryId: "e018" },
};

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
    expect(text).toContain("调查：src/hooks.ts → 发现 useEffect 清理函数缺失 ↩e003,↩e005");
    expect(text).toContain("验证：npm test → 3 passed ↩e012");
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
    userMessage: { text: "这次对话怎么没有启动摘要？", entryId: "e001" },
    finalReply: { text: "插件正常，成功路径完全静默。", entryId: "e018" },
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

  it("多行用户消息：换行折叠为空格，全文保留", () => {
    const l: LedgerData = {
      ...modern,
      userMessage: { text: "第一行\n第二行\n第三行", entryId: "e001" },
    };
    const text = renderText([l]);
    expect(text).toContain("T1 · 用户：「第一行 第二行 第三行」"); // \n 折叠为空格
    expect(text).not.toContain("↩e001"); // 不再附 recall 句柄
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

describe("renderActionLedger levels", () => {
  it("L1 renders user quote + action with target + final reply original", () => {
    const text = textOf(renderActionLedger([full]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("调查：cat src/ledger.ts → 阅读核心数据结构 ↩e003");
    expect(text).toContain("最终回复（原文）：\n我已经看完当前代码……");
  });

  it("L2 drops action target, keeps both ends verbatim", () => {
    const text = textOf(renderActionLedger([{ ...full, level: 2 }]));
    expect(text).toContain("调查：阅读核心数据结构 ↩e003");
    expect(text).not.toContain("cat src/ledger.ts");
    expect(text).toContain("用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：");
  });

  it("L3 renders intent + actions + summarized outcome with recall ids", () => {
    const l3: LedgerData = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 意图：了解ledger结构 ↩e001");
    expect(text).toContain("调查：阅读核心数据结构 ↩e003");
    expect(text).toContain("最终回复（摘要）：确认LedgerData含level字段 ↩e018");
    expect(text).not.toContain("最终回复（原文）");
  });

  it("L4 merges consecutive level-4 turns into one line", () => {
    // L4 形态下两端原文已压缩不可见，fixture 同样剥去 userMessage/finalReply
    const mk = (id: string, rid: string[]): LedgerData => ({ ...full, level: 4, turnStartEntryId: id,
      userMessage: undefined, finalReply: undefined,
      merged: { description: "调查代码结构与配置逻辑（2 条已合并）" },
      summary: { groups: [{ phase: "investigate", entries: [
        { action: "bash", target: "x", detail: "d", recallIds: rid }] }] } });
    const text = textOf(renderActionLedger([mk("a", ["e1"]), mk("b", ["e2"])]));
    expect(text).toContain("T1-T2 · 调查代码结构与配置逻辑（2 条已合并）↩e1,↩e2");
    expect(text).not.toContain("用户：「");
  });

  it("missing level defaults to 1 (backcompat)", () => {
    const noLevel = { ...full } as Partial<LedgerData>;
    delete noLevel.level;
    const text = textOf(renderActionLedger([noLevel as LedgerData]));
    expect(text).toContain("cat src/ledger.ts");
  });

  it("isolated level-4 turn renders single-turn range T3 · …", () => {
    const text = textOf(renderActionLedger([{ ...full, level: 4, merged: { description: "孤立合并行" } }]));
    expect(text).toContain("T1 · 孤立合并行");
  });

  it("L4 union dedupes recall ids in order across merged turns", () => {
    const mk = (id: string, rid: string[]): LedgerData => ({ ...full, level: 4, turnStartEntryId: id,
      userMessage: undefined, finalReply: undefined,
      merged: { description: "调查（2 条已合并）" },
      summary: { groups: [{ phase: "investigate", entries: [
        { action: "bash", target: "x", detail: "d", recallIds: rid }] }] } });
    const text = textOf(renderActionLedger([mk("a", ["e1", "e9"]), mk("b", ["e9", "e2"])]));
    expect(text).toContain("↩e1,↩e9,↩e2");
  });

  it("L4 union appends quote entryIds when quotes are still present", () => {
    // L4 条目若仍带两端引用（如刚合并后），其 entryId 也要进并集供 recall
    const text = textOf(renderActionLedger([{ ...full, level: 4, merged: { description: "调查" },
      summary: { groups: [] } }]));
    expect(text).toContain("↩e001,↩e018");
  });

  it("renderTurnText matches per-level rendering (single source of truth)", async () => {
    const { renderTurnText } = await import("../src/ledger.js");
    expect(renderTurnText(full, 1)).toContain("调查：cat src/ledger.ts → 阅读核心数据结构 ↩e003");
    expect(renderTurnText({ ...full, level: 2 }, 1)).toContain("调查：阅读核心数据结构 ↩e003");
    expect(renderTurnText({ ...full, level: 2 }, 1)).not.toContain("cat src/ledger.ts");
  });
});
