import { describe, it, expect } from "vitest";
import { renderActionLedger, renderTurnText, type LedgerData } from "../src/ledger.js";

function textOf(msg: any): string {
  return msg.content.map((c: any) => c.text ?? "").join("");
}

const full: LedgerData = {
  turnStartEntryId: "e001", turnEndEntryId: "e018", level: 1,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e001" },
  summary: { entries: [
    { action: "bash", target: "cat src/ledger.ts", detail: "阅读核心数据结构", recallIds: ["e003"], phase: "investigate" },
  ] },
  finalReply: { text: "我已经看完当前代码……", entryId: "e018" },
};

const sample: LedgerData = {
  turnStartEntryId: "e001",
  turnEndEntryId: "e018",
  summary: {
    userIntent: "修复内存泄漏",
    outcome: "hooks.ts:34 清理函数缺失，已修复",
    entries: [
      { action: "read", target: "src/hooks.ts", detail: "发现 useEffect 清理函数缺失", recallIds: ["e003", "e005"], phase: "investigate" },
      { action: "bash", target: "npm test", detail: "3 passed", recallIds: ["e012"], phase: "verify" },
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
    summary: { entries: [] },
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

describe("renderActionLedger levels（五级阶梯）", () => {
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
    expect(text).toContain("最终回复（原文）：");
  });

  it("L3 drops action lines entirely, keeps user quote + final reply original", () => {
    const l3: LedgerData = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：\n我已经看完当前代码……");
    expect(text).not.toContain("调查：");      // 动作行全丢
    expect(text).not.toContain("最终回复（摘要）");
    expect(text).not.toContain("意图：");       // L3 用户侧是原文
  });

  it("L3 keeps intent fallback only when userMessage missing (legacy edge)", () => {
    const l3: LedgerData = { ...full, level: 3, userMessage: undefined, summary: { ...full.summary, userIntent: "了解ledger结构" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 用户意图：了解ledger结构 ↩e001");
  });

  it("L4 renders intent + outcome summary lines with both-end ids only", () => {
    const l4: LedgerData = { ...full, level: 4, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" }, merged: { description: "旧合并描述（应被忽略）" } };
    const text = textOf(renderActionLedger([l4]));
    expect(text).toContain("T1 · 意图：了解ledger结构 ↩e001");
    expect(text).toContain("- 最终回复（摘要）：确认LedgerData含level字段 ↩e018");
    expect(text).not.toContain("用户：「");              // 两端原文不再渲染
    expect(text).not.toContain("我已经看完当前代码");
    expect(text).not.toContain("调查：");                // 动作行全丢
    expect(text).not.toContain("旧合并描述");             // merged.description 是 L5 产物，L4 忽略
  });

  it("L5 renders one merged line without any recall ids", () => {
    const mk = (id: string): LedgerData => ({ ...full, level: 5 as any, turnStartEntryId: id,
      merged: { description: "调查代码结构与配置逻辑" },
      summary: { entries: [
        { action: "bash", target: "x", detail: "d", recallIds: ["e1"], phase: "investigate" },
      ] } });
    const text = textOf(renderActionLedger([mk("a"), mk("b")]));
    expect(text).toContain("T1-T2 · 调查代码结构与配置逻辑");
    // 行尾不渲染任何 IDs：断言限定在合并行内（RECALL_HINT 本身含 ↩ 字样，不能对全文断言）
    const mergedLine = text.split("\n").find((l) => l.includes("T1-T2 · 调查代码结构与配置逻辑"));
    expect(mergedLine).toBeDefined();
    expect(mergedLine!).not.toContain("↩");
    expect(text).not.toContain("用户：「");
  });

  it("legacy L4 (merged group data) renders as new L4 per-entry from intent/outcome", () => {
    // 存量旧 L4：经过旧 compressEnds，userIntent/outcome 都在；无新代码分支，直接按 L4 渲染
    const legacy: LedgerData = { ...full, level: 4, summary: { ...full.summary, userIntent: "修复降级bug", outcome: "已修复推送" }, merged: { description: "旧的组描述" } };
    const text = textOf(renderActionLedger([legacy]));
    expect(text).toContain("T1 · 意图：修复降级bug ↩e001");
    expect(text).toContain("- 最终回复（摘要）：已修复推送 ↩e018");
  });

  it("legacy L3 data renders under new L3 (user + reply original, actions dropped)", () => {
    // 存量旧 L3：渲染函数统一按新阶梯——数据里 quotes 还在，直接出原文
    const legacy: LedgerData = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认" } };
    const text = textOf(renderActionLedger([legacy]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：");
    expect(text).not.toContain("调查：");
  });

  it("孤立 L5 单条渲染：单行 T1 · 描述，无组范围也无 ↩IDs", () => {
    // Task 1 审查移交：单条 level=5 不与任何相邻 L5 聚合 → 渲染为 T1 · 描述（无 T1-T2 式组范围）
    const l5: LedgerData = { ...full, level: 5 as any, merged: { description: "调查代码结构" } };
    const text = textOf(renderActionLedger([l5]));
    expect(text).toContain("T1 · 调查代码结构");
    expect(text).not.toContain("T1-T");
    const line = text.split("\n").find((l) => l.includes("调查代码结构"));
    expect(line).toBeDefined();
    expect(line!).not.toContain("↩");
  });

  it("跨组 L5 渲染：相邻 L5 描述不同时按组分断，各组显示各自描述（M4）", () => {
    // 两批降级产生的两个组（描述 A/B 不同）相邻：旧行为聚合为一行只显 group[0] 描述；
    // 新行为：组身份标记 = merged.description，描述不同即断行，各组渲染各自的范围与描述
    // （后缀由 mergeDescribe 生成时写入 description，fixture 同形状）
    const g1a: LedgerData = { ...full, level: 5 as any, merged: { description: "调查修复降级排序 bug（2 条已合并）" } };
    const g1b: LedgerData = { ...full, turnStartEntryId: "e101", level: 5 as any, merged: { description: "调查修复降级排序 bug（2 条已合并）" } };
    const g2a: LedgerData = { ...full, turnStartEntryId: "e201", level: 5 as any, merged: { description: "重构 recall 召回路由（2 条已合并）" } };
    const g2b: LedgerData = { ...full, turnStartEntryId: "e301", level: 5 as any, merged: { description: "重构 recall 召回路由（2 条已合并）" } };
    const text = textOf(renderActionLedger([g1a, g1b, g2a, g2b]));
    expect(text).toContain("T1-T2 · 调查修复降级排序 bug（2 条已合并）");
    expect(text).toContain("T3-T4 · 重构 recall 召回路由（2 条已合并）");
  });

  it("跨组 L5 渲染：相邻 L5 描述碰巧相同则仍聚为一行（无损）", () => {
    const g1a: LedgerData = { ...full, level: 5 as any, merged: { description: "同主题（2 条已合并）" } };
    const g1b: LedgerData = { ...full, turnStartEntryId: "e101", level: 5 as any, merged: { description: "同主题（2 条已合并）" } };
    const text = textOf(renderActionLedger([g1a, g1b]));
    expect(text).toContain("T1-T2 · 同主题（2 条已合并）");
  });

  it("跨组 L5 渲染：L5 组与 L4 条目相邻不互相影响", () => {
    const l5a: LedgerData = { ...full, level: 5 as any, merged: { description: "描述甲" } };
    const l5b: LedgerData = { ...full, turnStartEntryId: "e101", level: 5 as any, merged: { description: "描述甲" } };
    const l4: LedgerData = { ...sample, turnStartEntryId: "e201", level: 4 as any };
    const l5c: LedgerData = { ...full, turnStartEntryId: "e301", level: 5 as any, merged: { description: "描述乙" } };
    const text = textOf(renderActionLedger([l5a, l5b, l4, l5c]));
    expect(text).toContain("T1-T2 · 描述甲");
    expect(text).toContain("T4 · 描述乙"); // L4 在中间打断聚合，T4 是孤立 L5
  });
});

describe("图片占位行", () => {
  const withImgs = (level: 1 | 2 | 3 | 4, imgs?: { mimeType: string; bytes: number }[]): LedgerData => ({
    turnStartEntryId: "u1", turnEndEntryId: "a1", level,
    summary: { userIntent: "看报错", outcome: "ok", entries: [] },
    userMessage: { text: "帮我看下这个报错", entryId: "u1", ...(imgs ? { images: imgs } : {}) },
    finalReply: { text: "好的", entryId: "a1" },
    ...(level === 4 ? { merged: { description: "调试会话" } } : {}),
  } as LedgerData);

  it("L1 用户消息行后渲染占位行，↩ 指向 userMessage.entryId", () => {
    const out = renderTurnText(withImgs(1, [{ mimeType: "image/png", bytes: 100 }, { mimeType: "image/png", bytes: 100 }]), 7);
    expect(out).toContain("[图片 ×2: image/png, image/png ↩u1]");
    // 占位行在用户消息行之后、动作行之前
    const iUser = out.indexOf("### T7");
    const iImg = out.indexOf("[图片 ×2");
    expect(iImg).toBeGreaterThan(iUser);
  });

  it("单图渲染", () => {
    const out = renderTurnText(withImgs(2, [{ mimeType: "image/jpeg", bytes: 100 }]), 3);
    expect(out).toContain("[图片 ×1: image/jpeg ↩u1]");
  });

  it("超过 2 张：mime 列表截断为前两个 + …", () => {
    const imgs = Array.from({ length: 4 }, () => ({ mimeType: "image/png", bytes: 1 }));
    const out = renderTurnText(withImgs(1, imgs), 1);
    expect(out).toContain("[图片 ×4: image/png, image/png … ↩u1]");
  });

  it("L2/L3 同样渲染占位行", () => {
    expect(renderTurnText(withImgs(2, [{ mimeType: "image/png", bytes: 1 }]), 2)).toContain("[图片 ×1");
    expect(renderTurnText(withImgs(3, [{ mimeType: "image/png", bytes: 1 }]), 2)).toContain("[图片 ×1");
  });

  it("L4 不渲染占位行", () => {
    const out = renderTurnText(withImgs(4, [{ mimeType: "image/png", bytes: 1 }]), 5);
    expect(out).not.toContain("[图片");
    // 新 L4 渲染意图+outcome；merged.description 是 L5 产物，L4 忽略
    expect(out).toContain("意图：看报错");
    expect(out).not.toContain("调试会话");
  });

  it("无图：不渲染占位行（零变化不变式）", () => {
    expect(renderTurnText(withImgs(1), 1)).not.toContain("[图片");
  });

  it("占位行计入 turnRenderTokens", async () => {
    const { turnRenderTokens } = await import("../src/degrade.js");
    const noImg = turnRenderTokens(withImgs(1) as any, 0);
    const hasImg = turnRenderTokens(withImgs(1, [{ mimeType: "image/png", bytes: 1 }]) as any, 0);
    expect(hasImg).toBeGreaterThan(noImg);
  });
});
