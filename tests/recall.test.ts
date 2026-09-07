import { describe, it, expect } from "vitest";
import { executeRecall } from "../src/recall.js";
import type { MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

const branch: MessageEntry[] = [
  { id: "e1", message: { role: "user", content: [{ type: "text", text: "问题原文" }] } as unknown as AgentMessage },
  { id: "e2", message: { role: "assistant", content: [{ type: "text", text: "回答原文很长".repeat(50) }] } as unknown as AgentMessage },
];

describe("executeRecall", () => {
  it("returns serialized originals with id labels", () => {
    const r = executeRecall(["e1"], branch, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("e1");
    expect(r.text).toContain("问题原文");
  });

  it("reports missing ids", () => {
    const r = executeRecall(["e1", "nope"], branch, 4000);
    expect(r.missing).toEqual(["nope"]);
    expect(r.text).toContain("nope");
  });

  it("truncates oversized entries with hint", () => {
    const r = executeRecall(["e2"], branch, 10);
    expect(r.text).toContain("截断");
  });

  it("剥离召回原文中的 thinking 块（不再把过程噪声吐回给模型）", () => {
    const b: MessageEntry[] = [
      { id: "t1", message: { role: "assistant", content: [
        { type: "thinking", thinking: "机密推理过程".repeat(20) },
        { type: "text", text: "可见正文" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
      ] } as unknown as AgentMessage },
      { id: "t2", message: { role: "assistant", content: [{ type: "thinking", thinking: "纯思考" }] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["t1", "t2"], b, 4000);
    expect(r.text).toContain("可见正文");
    expect(r.text).toContain("read");
    expect(r.text).not.toContain("机密推理过程");
    expect(r.text).not.toContain("【t2 的原文】"); // 纯 thinking 消息整条丢弃
  });

  it("recall 带 toolCall 的条目时连带取回配对的 toolResult（否则只能看到调用、看不到结果）", () => {
    const b: MessageEntry[] = [
      { id: "a1", message: { role: "assistant", content: [
        { type: "text", text: "我读一下 package.json" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "package.json" } },
      ] } as unknown as AgentMessage },
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "{\"version\": \"0.1.0\"}" }] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["a1"], b, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("read(path="); // 调用记录
    expect(r.text).toContain("\"version\": \"0.1.0\""); // 配对结果
    expect(r.text).toContain("[Tool result]");
  });

  it("一条 assistant 多个 toolCall 时各自配对结果", () => {
    const b: MessageEntry[] = [
      { id: "a1", message: { role: "assistant", content: [
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "wc -l a.ts" } },
      ] } as unknown as AgentMessage },
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "A 的内容" }] } as unknown as AgentMessage },
      { id: "r2", message: { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "3 a.ts" }] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["a1"], b, 4000);
    expect(r.text).toContain("A 的内容");
    expect(r.text).toContain("3 a.ts");
  });

  it("没有配对结果的 toolCall 照常返回调用记录（不崩溃）", () => {
    const b: MessageEntry[] = [
      { id: "a1", message: { role: "assistant", content: [
        { type: "toolCall", id: "tcX", name: "read", arguments: { path: "gone.ts" } },
      ] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["a1"], b, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("read(path=");
  });

  it("toolResult 条目自身也可直接 recall", () => {
    const b: MessageEntry[] = [
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "结果正文" }] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["r1"], b, 4000);
    expect(r.text).toContain("结果正文");
  });

  it("截断阈值按剥离 thinking 后的有效内容计量（思考不再导致误截断）", () => {
    // 有效正文很小，但旧口径下 thinking 使 estimateTokens 远超阈值 → 会被误截断
    const b: MessageEntry[] = [
      { id: "t1", message: { role: "assistant", content: [
        { type: "thinking", thinking: "长".repeat(8000) },
        { type: "text", text: "短正文" },
      ] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["t1"], b, 100); // 阈值 400 chars，正文 3 chars
    expect(r.text).toContain("短正文");
    expect(r.text).not.toContain("截断");
  });

  it("大正文仍按有效内容截断（剥离后照旧）", () => {
    const b: MessageEntry[] = [
      { id: "t1", message: { role: "assistant", content: [{ type: "text", text: "长".repeat(1000) }] } as unknown as AgentMessage },
    ];
    const r = executeRecall(["t1"], b, 100); // 阈值 400 chars
    expect(r.text).toContain("截断");
  });
});
