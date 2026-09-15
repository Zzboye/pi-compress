import { describe, it, expect } from "vitest";
import { extractUserMessage, extractFinalReply, extractImages, serializeTurn, serializeForRecall, type Turn, type MessageEntry } from "../src/util.js";
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

describe("extractImages / extractUserMessage images", () => {
  const img = (mime: string, dataLen: number) => ({ type: "image", mimeType: mime, data: "A".repeat(dataLen) });

  it("extractImages 提取 mimeType 与估算字节", () => {
    const blocks = [img("image/png", 4800), { type: "text", text: "x" }];
    expect(extractImages(blocks)).toEqual([{ mimeType: "image/png", bytes: 3600 }]);
  });

  it("extractUserMessage 携带 images 元信息", () => {
    const e: MessageEntry = {
      id: "u-img",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这个报错" },
          img("image/png", 4800),
          img("image/jpeg", 8000),
        ],
      },
    } as unknown as MessageEntry;
    const q = extractUserMessage(turnOf(e))!;
    expect(q.text).toBe("看这个报错");
    expect(q.entryId).toBe("u-img");
    expect(q.images).toEqual([
      { mimeType: "image/png", bytes: 3600 },
      { mimeType: "image/jpeg", bytes: 6000 },
    ]);
  });

  it("纯文本消息 images 为 undefined（零变化不变式）", () => {
    const q = extractUserMessage(turnOf(userEntry("u-plain", "没有图")))!;
    expect(q.images).toBeUndefined();
  });

  it("无 text 但有图：仍返回 quote（text 空串不成立时才 undefined）——现状 text='' 返回 undefined，图随 turn 丢失", () => {
    // 维持现状：text 为空 → undefined（占位渲染走 userIntent 兜底）。
    // 此用例锁定现状行为，防止实现时意外改变分支条件。
    const e: MessageEntry = { id: "u-only-img", message: { role: "user", content: [img("image/png", 100)] } } as unknown as MessageEntry;
    expect(extractUserMessage(turnOf(e))).toBeUndefined();
  });
});

describe("serializeTurn 图片标记", () => {
  it("user content 中的 image 块替换为 [图片: mime] 文本", () => {
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: "AAAA" }] } } as unknown as MessageEntry,
      { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as unknown as MessageEntry,
    ];
    const out = serializeTurn({ startEntryId: "u1", endEntryId: "a1", entries });
    expect(out).toContain("[图片: image/png]");
    expect(out).toContain("看图");
    expect(out).not.toContain("AAAA");
  });

  it("toolResult content 中的 image 块同样替换", () => {
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "截个图" }] } } as unknown as MessageEntry,
      { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "shot", arguments: {} }] } } as unknown as MessageEntry,
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "shot", content: [{ type: "image", mimeType: "image/png", data: "BBBB" }] } } as unknown as MessageEntry,
    ];
    const out = serializeTurn({ startEntryId: "u1", endEntryId: "r1", entries });
    expect(out).toContain("[图片: image/png]");
    expect(out).not.toContain("BBBB");
  });

  it("无图 turn 输出不含标记（零变化）", () => {
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "纯文本" }] } } as unknown as MessageEntry,
    ];
    expect(serializeTurn({ startEntryId: "u1", endEntryId: "u1", entries })).not.toContain("[图片");
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

describe("serializeForRecall（recall 全量序列化，绕开 pi 的 toolResult 2000 截断）", () => {
  const toolBranch = (resultText: string): MessageEntry[] => [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "跑一下" }] }, timestamp: 1 } as any,
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "cat big.log" } }] }, timestamp: 2 } as any,
    { id: "r1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: resultText }] }, timestamp: 3 } as any,
  ];

  it("20000 字符 toolResult 全量保留（Codex P1 回归：pi serializeConversation 只留 2000）", () => {
    const big = "HEAD".repeat(500) + "M".repeat(18000) + "TAIL".repeat(125);
    const text = serializeForRecall(toolBranch(big).map((e) => ({ id: e.id, message: e.message })));
    expect(text.length).toBeGreaterThan(19000);
    expect(text).toContain("TAILTAILTAIL");   // 尾部在（pi 截断会把尾吃掉）
    expect(text).not.toContain("truncated");  // 自身无 pi 截断标记
  });

  it("输出格式与 pi serializeConversation 同款（[User]/[Assistant tool calls]/[Tool result]）", () => {
    const text = serializeForRecall(toolBranch("ok output"));
    expect(text).toContain("[User]: 跑一下");
    expect(text).toContain('[Assistant tool calls]: bash(command="cat big.log")');
    expect(text).toContain("[Tool result]: ok output");
  });

  it("2000 字符边界：恰好 2000 不截，2001 起全量保留（pi 原版会截）", () => {
    const exact = serializeForRecall(toolBranch("z".repeat(2000)));
    expect(exact).toContain("z".repeat(2000));
    const over = serializeForRecall(toolBranch("z".repeat(2001)));
    expect(over).toContain("z".repeat(2001));
  });

  it("thinking 剥离与图片标记照常生效（与摘要路径同一管道口径）", () => {
    const branch: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "看图" }] }, timestamp: 1 } as any,
      { id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "答复" }] }, timestamp: 2 } as any,
    ];
    const text = serializeForRecall(branch.map((e) => ({ id: e.id, message: e.message })));
    expect(text).not.toContain("内部推理");
    expect(text).toContain("[图片: image/png]");
    expect(text).toContain("看图");
  });
});
