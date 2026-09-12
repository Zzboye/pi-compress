import { describe, it, expect } from "vitest";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { findWindowTurns, assembleContext } from "../src/assembler.js";
import type { AgentMessage } from "../src/types.js";
import type { LedgerData } from "../src/ledger.js";

function msg(id: string, role: "user" | "assistant" | "toolResult", text: string): MessageEntry {
  return { id, message: { role, content: [{ type: "text", text }] } as AgentMessage };
}

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
});
