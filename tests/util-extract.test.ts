import { describe, it, expect } from "vitest";
import { extractUserMessage, extractFinalReply, type Turn, type MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

function userEntry(id: string, text: string): MessageEntry {
  return { id, message: { role: "user", content: [{ type: "text", text }] } as AgentMessage };
}
function assistantEntry(id: string, blocks: any[]): MessageEntry {
  return { id, message: { role: "assistant", content: blocks } as AgentMessage };
}
function turnOf(...entries: MessageEntry[]): Turn {
  return { startEntryId: entries[0].id, endEntryId: entries[entries.length - 1].id, entries };
}

describe("extractUserMessage", () => {
  it("短消息：逐字保留，不截断", () => {
    const q = extractUserMessage(turnOf(userEntry("u1", "修内存泄漏")))!;
    expect(q).toEqual({ text: "修内存泄漏", entryId: "u1" });
  });

  it("长消息：全文保留，不截断（L1 全量原文）", () => {
    const full = "开".repeat(100) + "中".repeat(300) + "尾".repeat(100);
    const q = extractUserMessage(turnOf(userEntry("u2", full)))!;
    expect(q.text).toBe(full);
    expect(q.entryId).toBe("u2");
  });

  it("extractUserMessage keeps full text (no truncation) for L1", () => {
    const long = "x".repeat(500);
    const q = extractUserMessage(turnOf(userEntry("u5", long)))!;
    expect(q?.text).toBe(long);
  });

  it("首条非 user 消息 → undefined", () => {
    expect(extractUserMessage(turnOf(assistantEntry("a1", [{ type: "text", text: "回答" }])))).toBeUndefined();
  });

  it("无 text 块 → undefined", () => {
    expect(extractUserMessage(turnOf({ id: "u3", message: { role: "user", content: [] } as unknown as AgentMessage }))).toBeUndefined();
  });

  it("多个 text 块 join", () => {
    const e: MessageEntry = { id: "u4", message: { role: "user", content: [
      { type: "text", text: "第一段" }, { type: "text", text: "第二段" },
    ] } as AgentMessage };
    expect(extractUserMessage(turnOf(e))!.text).toBe("第一段\n第二段");
  });
});

describe("extractFinalReply", () => {
  it("末条 assistant 含 thinking+text → 取 text（thinking 剥离）", () => {
    const t = turnOf(
      userEntry("u1", "问题"),
      assistantEntry("a1", [{ type: "thinking", thinking: "推理过程" }, { type: "text", text: "最终答复" }]),
    );
    expect(extractFinalReply(t)).toEqual({ text: "最终答复", entryId: "a1" });
  });

  it("末条纯 thinking → 反向跳过取更早的 text", () => {
    const t = turnOf(
      userEntry("u1", "问题"),
      assistantEntry("a1", [{ type: "text", text: "早先回复" }]),
      assistantEntry("a2", [{ type: "thinking", thinking: "纯思考" }]),
    );
    expect(extractFinalReply(t)).toEqual({ text: "早先回复", entryId: "a1" });
  });

  it("text+toolCall 混合消息 → 取 text", () => {
    const t = turnOf(
      userEntry("u1", "问题"),
      assistantEntry("a1", [{ type: "text", text: "先看看" }, { type: "toolCall", toolCallId: "tc", name: "read", arguments: { path: "a.ts" } }]),
    );
    expect(extractFinalReply(t)!.text).toBe("先看看");
  });

  it("无 assistant → undefined", () => {
    expect(extractFinalReply(turnOf(userEntry("u1", "问题")))).toBeUndefined();
  });

  it("超长回复：全文保留，不截断（L1 全量原文）", () => {
    const body = "H>>>" + "x".repeat(3000) + "<<<T";
    const t = turnOf(userEntry("u1", "问题"), assistantEntry("a9", [{ type: "text", text: body }]));
    const q = extractFinalReply(t)!;
    expect(q.text).toBe(body);
  });

  it("边界：长回复不再按长度截断", () => {
    const mk = (n: number) => turnOf(userEntry("u1", "问题"), assistantEntry("a1", [{ type: "text", text: "y".repeat(n) }]));
    expect(extractFinalReply(mk(2000))!.text).toHaveLength(2000);
    expect(extractFinalReply(mk(2001))!.text).toHaveLength(2001);
  });

  it("extractFinalReply keeps full text (no truncation)", () => {
    const long = "y".repeat(3000);
    const q = extractFinalReply(turnOf(userEntry("u1", "问题"), assistantEntry("a2", [{ type: "text", text: long }])))!;
    expect(q?.text).toBe(long);
  });
});
