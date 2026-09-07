import { describe, it, expect, vi } from "vitest";
import { SummarizerEngine } from "../src/summarizer.js";
import { LedgerStore } from "../src/store.js";
import { assembleContext } from "../src/assembler.js";
import { executeRecall } from "../src/recall.js";
import { enforceForcePoint } from "../src/forcepoint.js";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { loadConfig } from "../src/config.js";
import type { AgentMessage } from "../src/types.js";

function bigTurn(startId: string, text: string): MessageEntry[] {
  return [
    { id: startId, message: { role: "user", content: [{ type: "text", text }] } as AgentMessage },
    { id: startId + "-a", message: { role: "assistant", content: [
      { type: "text", text: "看完了文件" },
      { type: "toolCall", toolCallId: "tc", name: "read", arguments: { path: "src/app.ts" } } as any,
    ] } as AgentMessage },
    { id: startId + "-r", message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "文件内容 " + text }] } as AgentMessage },
  ];
}

const config = loadConfig(undefined, undefined);

describe("integration: turn → summarize → assemble → recall", () => {
  it("full pipeline replaces old turns and recalls originals verbatim", async () => {
    const store = new LedgerStore();
    const validOutput = JSON.stringify({
      groups: [{ phase: "investigate", entries: [{ target: "src/app.ts", detail: "正常" }] }],
    });
    const engine = new SummarizerEngine(
      { complete: async () => validOutput },
      config, (d) => store.set(d), vi.fn(),
    );

    const branch = [...bigTurn("t1", "a".repeat(4000)), ...bigTurn("t2", "b".repeat(4000)), ...bigTurn("t3", "c".repeat(4000))];
    const turns = splitIntoTurns(branch);

    // agent_settled: 摘要 t1
    engine.enqueue(turns[0]);
    await engine.waitIdle(5000);
    expect(store.get("t1")).toBeTruthy();

    // context: 重组（窗口设小让 t1 落在窗外）
    const { messages, stats } = assembleContext(branch, new Map([["t1", store.get("t1")!]]), 1000);
    expect(stats.replacedTurns).toBeGreaterThanOrEqual(1);
    const head = ((messages[0] as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("<action-ledger>");
    expect(head).toContain("↩t1"); // ledger 头含 ↩ 标记（recallIds=["t1-a"] → "↩t1-a" 含子串 "↩t1"）
    expect(head).toContain("用户：「");                    // 用户原话进入 ledger 头
    expect(head).toContain("已截断，后续");                 // 4000 字符用户消息被头截断
    expect(head).toContain("最终回复（原文）：");
    expect(head).toContain("看完了文件");                  // 最终回复逐字出现

    // recall: 从 ledger 头部的 ↩ 标记取回 assistant 工具调用原文
    const ids = [...head.matchAll(/↩([\w-]+)/g)].map((m) => m[1]);
    const r = executeRecall(ids, branch, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("看完了文件"); // assistant 文本逐字召回
    expect(r.text).toContain("src/app.ts"); // toolCall 的 path 参数逐字保留

    // 用户大内容也可按 entry ID 直接召回（↩ 指向 assistant，但 recall 支持任意 ID）
    const r2 = executeRecall(["t1"], branch, 4000);
    expect(r2.missing).toEqual([]);
    expect(r2.text).toContain("a".repeat(4000)); // user 原文逐字召回
  });

  it("backend failure → passthrough verbatim → retry next round", async () => {
    const store = new LedgerStore();
    let fail = true;
    const engine = new SummarizerEngine(
      { complete: async () => { if (fail) throw new Error("down"); return JSON.stringify({ userIntent: "u", outcome: "o", groups: [{ phase: "other", entries: [{ target: "src/app.ts", detail: "ok" }] }] }); } },
      { ...config, retry: { maxAttempts: 1, backoffMs: 1 } },
      (d) => store.set(d), vi.fn(),
    );
    // 双 turn：t1 大（窗外失败→passthrough 原文），t2 小（窗口内→原文）
    const branch = [...bigTurn("t1", "z".repeat(4000)), ...bigTurn("t2", "q")];
    engine.enqueue(splitIntoTurns(branch)[0]); // t1
    await engine.waitIdle(5000);
    expect(store.get("t1")).toBeUndefined(); // 失败未落盘
    // context: t1 窗外无 cache → 原文放行（不丢弃）；t2 窗内 → 原文
    const { messages, stats } = assembleContext(branch, new Map(), 100);
    expect(stats.passthroughTurns).toBe(1);
    expect(messages.length).toBe(6); // t1(3) + t2(3)，无 ledger 头
    expect(messages[0].role).toBe("user"); // 首条是 t1 原文，非 ledger
    // 恢复后重摘
    fail = false;
    engine.enqueue(splitIntoTurns(branch)[0]); // t1 重摘
    await engine.waitIdle(5000);
    expect(store.get("t1")).toBeTruthy(); // 恢复
  });

  it("force point degrades on timeout, recovers when queue drains", async () => {
    const q = { pending: () => 1, waitIdle: async () => false };
    const status = vi.fn();
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 50, status)).toBe("degraded");
    const q2 = { pending: () => 0, waitIdle: async () => true };
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q2, 50, status)).toBe("pass");
  });
});
