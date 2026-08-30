import { describe, it, expect } from "vitest";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { findWindowTurns } from "../src/assembler.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

function msg(id: string, role: "user" | "assistant" | "toolResult", text: string): MessageEntry {
  return { id, message: { role, content: [{ type: "text", text }] } as AgentMessage };
}

// 约 1 token/4字符：用长度控制 token 量级（estimateTokens 是估算，测试里取实际返回值比较）
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
