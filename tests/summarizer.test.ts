import { describe, it, expect, vi } from "vitest";
import { SummarizerEngine } from "../src/summarizer.js";
import { extractToolActions, serializeTurn, type Turn, type MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

function turnFixture(): { turn: Turn; validOutput: string } {
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "修内存泄漏" }] } as AgentMessage },
    { id: "a1", message: { role: "assistant", content: [
      { type: "text", text: "我先看看文件" },
      { type: "toolCall", toolCallId: "tc1", name: "read", arguments: { path: "src/hooks.ts" } } as any,
    ] } as AgentMessage },
    { id: "t1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "文件内容…" }] } as AgentMessage },
    { id: "t2", message: { role: "assistant", content: [{ type: "text", text: "修好了" }] } as AgentMessage },
  ];
  return {
    turn: { startEntryId: "u1", endEntryId: "t2", entries },
    validOutput: JSON.stringify({
      userIntent: "修复内存泄漏", outcome: "已修复",
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "发现清理函数缺失" }] }],
    }),
  };
}

describe("extractToolActions", () => {
  it("extracts read path mechanically", () => {
    const { turn } = turnFixture();
    const actions = extractToolActions(turn);
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ action: "read", target: "src/hooks.ts", entryIds: ["a1"] });
  });
});

describe("serializeTurn", () => {
  it("produces text containing user message", () => {
    const { turn } = turnFixture();
    expect(serializeTurn(turn)).toContain("修内存泄漏");
  });
});

describe("serializeTurn head+tail sampling", () => {
  const HEAD = "HEAD>>>";
  const TAIL = "<<<TAIL";

  function toolResultTurn(body: string): Turn {
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "跑测试" }] } as AgentMessage },
      { id: "t1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: body }] } as AgentMessage },
    ];
    return { startEntryId: "u1", endEntryId: "t1", entries };
  }

  it("keeps both head and tail of a long toolResult", () => {
    const body = HEAD + "a".repeat(5000 - HEAD.length - TAIL.length) + TAIL;
    const out = serializeTurn(toolResultTurn(body));
    expect(out).toContain(HEAD);
    expect(out).toContain(TAIL);
    expect(out).toContain("omitted");
    // [Tool result] 段必须落在 pi 的 2000 字符预算内，否则尾巴会被 pi 二次截掉
    const seg = out.split("[Tool result]: ")[1] ?? "";
    expect(seg.length).toBeLessThanOrEqual(2000);
  });

  it("leaves short toolResults untouched", () => {
    const body = HEAD + "b".repeat(400) + TAIL;
    const out = serializeTurn(toolResultTurn(body));
    expect(out).not.toContain("omitted");
    expect(out).toContain(TAIL);
  });

  it("boundary: exactly 2000 chars untouched, 2001 sampled", () => {
    const at2000 = HEAD + "c".repeat(2000 - HEAD.length - TAIL.length) + TAIL;
    expect(serializeTurn(toolResultTurn(at2000))).not.toContain("omitted");
    const at2001 = at2000 + "d";
    const out = serializeTurn(toolResultTurn(at2001));
    expect(out).toContain("omitted");
    expect(out).toContain(TAIL);
  });
});

describe("SummarizerEngine", () => {
  it("processes queued turn and emits ledger via onLedger", async () => {
    const { turn, validOutput } = turnFixture();
    const onLedger = vi.fn();
    const backend = { complete: vi.fn().mockResolvedValue(validOutput) };
    const engine = new SummarizerEngine(backend, { retry: { maxAttempts: 3, backoffMs: 1 }, verbatimCheck: true } as any, onLedger, vi.fn());
    engine.enqueue(turn);
    await engine.waitIdle(2000);
    expect(onLedger).toHaveBeenCalledTimes(1);
    expect(onLedger.mock.calls[0][0]).toMatchObject({ turnStartEntryId: "u1" });
    expect(engine.pending()).toBe(0);
  });

  it("retries on failure then marks failed and warns", async () => {
    const { turn } = turnFixture();
    const onLedger = vi.fn(); const onWarning = vi.fn();
    const backend = { complete: vi.fn().mockRejectedValue(new Error("ollama down")) };
    const engine = new SummarizerEngine(backend, { retry: { maxAttempts: 2, backoffMs: 1 }, verbatimCheck: true } as any, onLedger, onWarning);
    engine.enqueue(turn);
    await engine.waitIdle(5000);
    expect(backend.complete.mock.calls.length).toBe(2); // 1 次 + 1 重试
    expect(onLedger).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalled();
    expect(engine.failed().has("u1")).toBe(true);
  });

  it("processes turns serially (queue drains in order)", async () => {
    const { turn, validOutput } = turnFixture();
    const order: string[] = [];
    let resolveFirst: (v: string) => void;
    const backend = {
      complete: vi.fn().mockImplementationOnce(() => new Promise<string>((r) => { resolveFirst = r; }))
        .mockImplementationOnce(() => { order.push("second"); return Promise.resolve(validOutput); }),
    };
    const engine = new SummarizerEngine(backend, { retry: { maxAttempts: 1, backoffMs: 1 }, verbatimCheck: true } as any, vi.fn(), vi.fn());
    engine.enqueue({ ...turn, startEntryId: "t-a" });
    engine.enqueue({ ...turn, startEntryId: "t-b" });
    expect(engine.pending()).toBe(2);
    resolveFirst!("ok-but-invalid"); // 第一个失败（非 JSON）不阻塞第二个
    await engine.waitIdle(5000);
    expect(engine.pending()).toBeLessThanOrEqual(1);
  });
});
