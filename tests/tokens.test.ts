import { describe, it, expect } from "vitest";
import { countTokens, countTokensText, truncateToTokens, CJK_RATIO } from "../src/util.js";
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

describe("truncateToTokens", () => {
  it("CJK 文本按 token 截断（不再按 chars/4 放行 4 倍预算）", () => {
    const text = "中文内容测试".repeat(2000); // 12000 CJK 字符 = 12000 tok
    const r = truncateToTokens(text, 4000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4000); // CJK 1 字符 = 1 tok
    expect(countTokensText(r.text)).toBeLessThanOrEqual(4000);
    expect(countTokensText(r.text)).toBeGreaterThan(3900); // 二分应贴近预算而非过分保守
  });

  it("ASCII 文本保持 ≈4 字符/token", () => {
    const text = "abcdefgh".repeat(2000); // 16000 ASCII 字符 ≈ 4000 tok
    const r = truncateToTokens(text, 3000); // 预算低于全文 → 真实走截断路径
    expect(r.truncated).toBe(true);
    expect(countTokensText(r.text)).toBeLessThanOrEqual(3000);
    expect(r.text.length).toBeGreaterThan(11000); // ≈ 4 字符/token（3000 tok ≈ 12000 字符）
  });

  it("预算恰好等于全文 → 不截断", () => {
    const text = "中文内容测试".repeat(100); // 600 CJK 字符 = 600 tok
    expect(truncateToTokens(text, 600)).toEqual({ text, truncated: false });
  });

  it("非整数/非正预算 → 空串且 truncated（不返回超预算前缀）", () => {
    for (const bad of [0, -1, 0.5, NaN]) {
      expect(truncateToTokens("中".repeat(100), bad)).toEqual({ text: "", truncated: true });
    }
  });

  it("预算充足时不截断且原样返回", () => {
    const text = "短文本";
    const r = truncateToTokens(text, 4000);
    expect(r).toEqual({ text, truncated: false });
  });

  it("空字符串", () => {
    expect(truncateToTokens("", 100)).toEqual({ text: "", truncated: false });
  });

  it("极小预算仍返回非空前缀（不返回空串导致调用方误判）", () => {
    const r = truncateToTokens("中".repeat(1000), 1);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(1);
  });

  it("混合文本：截断点按 CJK 感知口径", () => {
    const text = "中".repeat(100) + "a".repeat(1000); // 100 + 250 = 350 tok
    const r = truncateToTokens(text, 200);
    expect(countTokensText(r.text)).toBeLessThanOrEqual(200);
    expect(r.text.startsWith("中".repeat(100))).toBe(true); // 全中文前缀保留
  });
});
