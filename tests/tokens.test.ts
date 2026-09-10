import { describe, it, expect } from "vitest";
import { countTokens, countTokensText, CJK_RATIO } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function msg(m: Record<string, unknown>): AgentMessage {
  return m as unknown as AgentMessage;
}

describe("countTokensText", () => {
  it("pure ASCII: chars/4 (same as pi estimateTokens)", () => {
    // 40 个 ASCII 字符 → ceil(40/4) = 10
    expect(countTokensText("x".repeat(40))).toBe(10);
  });

  it("pure CJK: 1 token per char", () => {
    // 26 个中文字符 → 26 tokens（旧口径 chars/4 只给 7）
    expect(countTokensText("这是一段纯中文文本用来测量每个字符消耗多少token".replace("token", ""))).toBe(21);
  });

  it("mixed: CJK chars count 1.0, others chars/4", () => {
    // 8 CJK + 2 ASCII → 8 + ceil(2/4) = 9
    expect(countTokensText("你好世界你好世界" + "ab")).toBe(9);
  });

  it("empty string is 0", () => {
    expect(countTokensText("")).toBe(0);
  });

  it("CJK_RATIO exposes the coefficient", () => {
    expect(CJK_RATIO).toBe(1.0);
  });
});

describe("countTokens", () => {
  it("user text message: CJK-aware counting", () => {
    // 20 CJK + 16 ASCII → 20 + 4 = 24
    const m = userMsg("修".repeat(20) + "a".repeat(16));
    expect(countTokens(m)).toBe(24);
  });

  it("assistant with thinking: counted by default, skipped with skipThinking", () => {
    const m = msg({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "让".repeat(100) }, // 100 CJK chars
        { type: "text", text: "答".repeat(40) },           // 40 CJK chars
      ],
    });
    expect(countTokens(m)).toBe(140);
    expect(countTokens(m, { skipThinking: true })).toBe(40);
  });

  it("assistant toolCall: name + arguments counted", () => {
    const m = msg({
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "src/util.ts" } }],
    });
    // name 4 chars + JSON.stringify(arguments) 25 chars，全 ASCII
    const argsJson = JSON.stringify({ path: "src/util.ts" });
    expect(countTokens(m)).toBe(Math.ceil((4 + argsJson.length) / 4));
  });

  it("toolResult content counted like user", () => {
    const m = msg({ role: "toolResult", content: [{ type: "text", text: "结果".repeat(10) }] });
    expect(countTokens(m)).toBe(20);
  });

  it("image block counts as 1200 tokens (pi ESTIMATED_IMAGE_CHARS=4800/4)", () => {
    const m = msg({ role: "user", content: [{ type: "image", data: "..." }] });
    expect(countTokens(m)).toBe(1200);
  });

  it("bashExecution: command + output", () => {
    const m = msg({ role: "bashExecution", command: "ls", output: "文件".repeat(8) });
    expect(countTokens(m)).toBe(Math.ceil(2 / 4) + 16);
  });

  it("compactionSummary: summary text", () => {
    const m = msg({ role: "compactionSummary", summary: "总结".repeat(10) });
    expect(countTokens(m)).toBe(20);
  });

  it("unknown role: 0 (same as pi estimateTokens fallback)", () => {
    expect(countTokens(msg({ role: "unknown-role" }))).toBe(0);
  });
});
