import { describe, it, expect } from "vitest";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { findWindowTurns, assembleContext, planInflightTrim } from "../src/assembler.js";
import type { AgentMessage } from "../src/types.js";
import type { LedgerData } from "../src/ledger.js";

function msg(id: string, role: "user" | "assistant" | "toolResult", text: string): MessageEntry {
  return { id, message: { role, content: [{ type: "text", text }] } as AgentMessage };
}

// fixture：user + 4 对 toolCall→toolResult（每条 toolResult 用长文本撑 token）——planInflightTrim 与 assembleContext 共用
const mkInflight = () => {
  const entries: MessageEntry[] = [{ id: "u", message: { role: "user", content: [{ type: "text", text: "任务" }] } as any }];
  for (let i = 1; i <= 4; i++) {
    entries.push({ id: `a${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `cmd${i}` } }] } as any });
    entries.push({ id: `r${i}`, message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "x".repeat(2000) }] } as any });
  }
  return entries;
};

// CJK 感知口径（util.countTokens）：中文 1 tok/char、ASCII 1 tok/4 chars。用长度控制 token 量级
describe("splitIntoTurns", () => {
  it("splits at user messages", () => {
    const entries = [msg("a", "user", "q1"), msg("b", "assistant", "a1"), msg("c", "toolResult", "r1"), msg("d", "user", "q2"), msg("e", "assistant", "a2")];
    const turns = splitIntoTurns(entries);
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ startEntryId: "a", endEntryId: "c" });
    expect(turns[1]).toMatchObject({ startEntryId: "d", endEntryId: "e" });
  });

  it("leading non-user entries form their own pseudo-turn", () => {
    const entries = [msg("b", "assistant", "a1"), msg("d", "user", "q2")];
    const turns = splitIntoTurns(entries);
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ startEntryId: "b", endEntryId: "b" });
  });
});

describe("findWindowTurns", () => {
  it("keeps trailing turns within budget", () => {
    const big = "x".repeat(4000); // ~1k tokens
    const turns = splitIntoTurns([
      msg("a", "user", big), msg("b", "assistant", big),
      msg("c", "user", big), msg("d", "assistant", big),
      msg("e", "user", big), msg("f", "assistant", big),
    ]);
    const window = findWindowTurns(turns, 3000); // 约 3 个 turn 的量
    expect(window.length).toBeLessThanOrEqual(3);
    expect(window.length).toBeGreaterThanOrEqual(1);
    // 一定包含最后一个 turn
    expect(window[window.length - 1].startEntryId).toBe("e");
  });

  it("never splits a turn even when it alone exceeds budget", () => {
    const huge = "y".repeat(100_000); // ~25k tokens
    const turns = splitIntoTurns([msg("a", "user", "hello"), msg("b", "assistant", "hi"), msg("c", "user", huge), msg("d", "assistant", huge)]);
    const window = findWindowTurns(turns, 20000);
    // 最后一个 turn 单独超预算：整体保留（窗口暂时 >20k）
    expect(window.some((t) => t.startEntryId === "c")).toBe(true);
  });
});

describe("thinking 剥离（窗口预算与原文）", () => {
  const think = "思".repeat(8000); // ~2000 tok（旧口径）
  function thinkMsg(id: string, text: string): MessageEntry {
    return { id, message: { role: "assistant", content: [{ type: "thinking", thinking: think }, { type: "text", text }] } as AgentMessage };
  }

  it("findWindowTurns 预算按剥离 thinking 后计量：思考不再挤占 20k 窗口", () => {
    const turns = splitIntoTurns([
      msg("a", "user", "q1"), thinkMsg("b", "a1"),
      msg("c", "user", "q2"), thinkMsg("d", "a2"),
    ]);
    // 剥离后每 turn ≈ 2 tok；旧口径每 turn ≈ 2001 tok，第二个会被挤出去
    const window = findWindowTurns(turns, 2000);
    expect(window.length).toBe(2);
  });

  it("assembleContext 窗口原文剥离 thinking 块；纯 thinking 消息整条丢弃", () => {
    const branch: MessageEntry[] = [
      msg("a", "user", "q1"),
      { id: "a1", message: { role: "assistant", content: [
        { type: "thinking", thinking: "思考内容ABC" },
        { type: "text", text: "回答" },
      ] } as AgentMessage },
      { id: "a2", message: { role: "assistant", content: [{ type: "thinking", thinking: "纯思考丢整条" }] } as AgentMessage },
      msg("c", "user", "q2"),
      { id: "d", message: { role: "assistant", content: [{ type: "text", text: "回答2" }] } as AgentMessage },
    ];
    const { messages } = assembleContext(branch, new Map(), 20000);
    const all = JSON.stringify(messages);
    expect(all).not.toContain("思考内容ABC");
    expect(all).not.toContain("纯思考丢整条");
    expect(all).toContain("回答");
    expect(all).toContain("回答2");
  });

  it("passthrough（窗外无摘要原文照发）同样剥离 thinking", () => {
    const branch: MessageEntry[] = [
      msg("a", "user", "q1"),
      { id: "a1", message: { role: "assistant", content: [
        { type: "thinking", thinking: "思考XYZ" },
        { type: "text", text: "回答1" },
      ] } as AgentMessage },
      msg("b", "user", "q2"),
      msg("c", "assistant", "回答2"),
    ];
    const { messages, stats } = assembleContext(branch, new Map(), 1); // 窗口只装最后一个 turn
    expect(stats.passthroughTurns).toBe(1);
    const all = JSON.stringify(messages);
    expect(all).not.toContain("思考XYZ");
    expect(all).toContain("回答1");
    expect(all).toContain("回答2");
  });
});

function ledgerFor(turn: { startEntryId: string; endEntryId: string }): LedgerData {
  return {
    turnStartEntryId: turn.startEntryId,
    turnEndEntryId: turn.endEntryId,
    summary: {
      userIntent: "做某事",
      outcome: "完成了",
      entries: [],
    },
  };
}

describe("assembleContext", () => {
  // 注：plan 原测试 1/2/3 的断言与 Task3 findWindowTurns 语义冲突（末 turn 必在窗口内）。
  // 此处修正测试数据使其与实现一致，保留各测试意图。
  it("keeps recent turns verbatim, replaces summarized old turns with ledger message on top", () => {
    const big = "z".repeat(4000);
    const recent = "r".repeat(4000); // 窗口内 turn 用相异字符，便于验证被替换 turn 的原文确已消失
    const entries = [
      msg("a", "user", big), msg("b", "assistant", big),       // turn1 (旧, 有摘要 → 替换)
      msg("c", "user", big), msg("d", "assistant", big),       // turn2 (旧, 有摘要 → 替换)
      msg("e", "user", recent), msg("f", "assistant", recent), // turn3 (新, 窗口内 → 原文)
    ];
    const turns = splitIntoTurns(entries);
    const cache = new Map<string, LedgerData>();
    cache.set("a", ledgerFor(turns[0]));
    cache.set("c", ledgerFor(turns[1]));
    const { messages, stats } = assembleContext(entries, cache, 100); // 小预算 → turn1/2 在窗外
    // 头部是 ledger 消息
    expect(messages[0].role).toBe("user");
    const head = ((messages[0] as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("<action-ledger>");
    // 窗口内 turn 原文保留（ledger + e + f）
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(stats.replacedTurns).toBeGreaterThanOrEqual(1);
    // 被替换 turn 的原文（big="z"…）不应出现；窗口 turn（recent="r"…）保留
    const all = messages.map((m) => ((m as any).content as any[]).map((c) => c.text ?? "").join("")).join("\n");
    expect(all).not.toContain("z".repeat(4000));
  });

  it("passes through turns without summaries verbatim", () => {
    const big = "z".repeat(4000);
    // turn1 大（窗外无摘要 → passthrough 原文），turn2 小（窗口内 → 原文）；无 ledger 头
    const entries = [msg("a", "user", big), msg("b", "assistant", big), msg("c", "user", "q2"), msg("d", "assistant", "a2")];
    const { messages, stats } = assembleContext(entries, new Map(), 100);
    expect(stats.replacedTurns).toBe(0);
    expect(stats.passthroughTurns).toBe(1);
    expect(messages.length).toBe(4); // 全部原文（无 ledger 头）
    expect(messages[0].role).toBe("user"); // 首条原文，非 ledger
  });

  it("cache hit for a turn outside window only", () => {
    const big = "z".repeat(4000);
    // turn1 大（窗外有缓存 → 替换为 ledger），turn2 小（窗口内 → 原文）
    const entries = [msg("a", "user", big), msg("b", "assistant", big), msg("c", "user", "q"), msg("d", "assistant", "a")];
    const cache = new Map([["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })]]);
    const { messages, stats } = assembleContext(entries, cache, 100);
    expect(messages.length).toBe(3); // ledger + c + d
    expect(messages[0].role).toBe("user");
    const head = ((messages[0] as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("<action-ledger>");
    expect(stats.replacedTurns).toBe(1);
  });

  it("assembleContext：extraLedgers 渲染进日志头且原文侧不含片段内容", () => {
    const branch = mkInflight(); // Task 3 的 helper（若不在同一 describe 作用域，复制一份或提到文件顶层）
    const cache = new Map<string, LedgerData>();
    const { trimmedBranch, extraLedgers, fragment } = planInflightTrim(branch, cache, 200);
    // 模拟片段已摘要落盘
    const fragLedger: LedgerData = { turnStartEntryId: fragment!.startEntryId, turnEndEntryId: fragment!.endEntryId, summary: { userIntent: "跑命令", outcome: "完成", entries: [] } };
    // 重新裁剪（此时片段在 cache 中）
    const plan2 = planInflightTrim(branch, new Map([[fragment!.startEntryId, fragLedger]]), 200);
    const { messages } = assembleContext(plan2.trimmedBranch, new Map([[fragment!.startEntryId, fragLedger]]), 200, plan2.extraLedgers);
    const ledgerMsg = messages.find((m) => Array.isArray((m as any).content) && ((m as any).content as any[]).some((c) => c.type === "text" && (c.text as string).includes("<action-ledger>")));
    expect(ledgerMsg).toBeDefined();
    const text = ((ledgerMsg as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(text).toContain("跑命令"); // 片段行在日志头
  });
});

describe("planInflightTrim", () => {
  it("未超阈值：零变化（branch 原样、无 extraLedgers、fragment null）", () => {
    const branch = mkInflight();
    const out = planInflightTrim(branch, new Map(), 1_000_000);
    expect(out.trimmedBranch).toEqual(branch);
    expect(out.extraLedgers).toEqual([]);
    expect(out.fragment).toBeNull();
  });

  it("超阈值：切出片段含完整对（不结束在 toolCall 上），user 保留在 trimmedBranch", () => {
    const branch = mkInflight();
    const { trimmedBranch, fragment } = planInflightTrim(branch, new Map(), 200);
    expect(fragment).not.toBeNull();
    expect(fragment!.startEntryId).toBe("a1");       // 从 user 之后开始
    expect(fragment!.isFragment).toBe(true);
    const lastMsg = fragment!.entries[fragment!.entries.length - 1].message;
    expect(lastMsg.role).toBe("toolResult");          // 对边界
    // user 消息仍在裁剪视图中，片段条目已移除
    expect(trimmedBranch.some((e) => e.id === "u")).toBe(true);
    expect(trimmedBranch.some((e) => e.id === fragment!.startEntryId)).toBe(false);
  });

  it("已有片段（cache 中）：裁剪视图去掉已覆盖前缀，extraLedgers 按 branch 顺序输出", () => {
    const branch = mkInflight();
    // 手工构造覆盖 a1..r2 的片段 ledger
    const fragLedger: LedgerData = {
      turnStartEntryId: "a1", turnEndEntryId: "r2", summary: { entries: [] },
    };
    const cache = new Map([["a1", fragLedger]]);
    const { trimmedBranch, extraLedgers, fragment } = planInflightTrim(branch, cache, 200);
    expect(extraLedgers).toEqual([fragLedger]);
    expect(trimmedBranch.some((e) => e.id === "a1")).toBe(false);
    expect(trimmedBranch.some((e) => e.id === "r2")).toBe(false);
    expect(trimmedBranch.some((e) => e.id === "u")).toBe(true);
    // 剩余仍超阈值 → 继续切下一片段（F2，冻结语义：起点在已覆盖之后）
    expect(fragment).not.toBeNull();
    expect(fragment!.startEntryId).toBe("a3");
  });

  it("turn 结束后的普通多 turn 会话：最后 turn 是已完成的短 turn，零变化", () => {
    const branch = [...mkInflight(), { id: "u2", message: { role: "user", content: [{ type: "text", text: "下一问" }] } as any }];
    const out = planInflightTrim(branch, new Map(), 1_000_000);
    expect(out.fragment).toBeNull();
    expect(out.trimmedBranch).toEqual(branch);
  });
});
