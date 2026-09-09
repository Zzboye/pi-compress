import { describe, it, expect, vi } from "vitest";
import { SummarizerEngine } from "../src/summarizer.js";
import { LedgerStore } from "../src/store.js";
import { assembleContext } from "../src/assembler.js";
import { executeRecall } from "../src/recall.js";
import { enforceForcePoint } from "../src/forcepoint.js";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { loadConfig } from "../src/config.js";
import { DegradeEngine } from "../src/degrade.js";
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "../src/ledger.js";
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
    expect(head).toContain("a".repeat(100));               // 4000 字符用户消息全量进入 L1 原文（不再截断）
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

  // 模拟 index.ts 的 runDegrade：按 turnStartEntryId 升序取全量 ledgers，交给 DegradeEngine
  it("degrades ledgers through levels after summarize completes (L1->L2 rule path)", async () => {
    const store = new LedgerStore();
    // 阈值调小触发降级：5 turn 各 ~770 tok（用户 3000 字符原文进 L1 渲染）
    // L1 总量 ~3900 > 3400 → 最旧 4 条降 L2（累计 ~3100 ≥ 总量−1200）；降级后 L2 ~3100 ≤ 3400 → 瀑布停止
    const cfg = { ...config, ledgerDegradeThresholdTokens: 3400, ledgerReserveTokens: 1200 };
    const validOutput = JSON.stringify({
      groups: [{ phase: "investigate", entries: [{ target: "src/app.ts", detail: "正常" }] }],
    });
    const backend = { complete: async () => validOutput };
    const onLedger = (d: LedgerData) => store.set(d); // 与 index.ts 同一持久化通道
    const engine = new SummarizerEngine(backend, cfg, onLedger, vi.fn());
    const degradeEngine = new DegradeEngine(backend, cfg, onLedger, vi.fn());

    const branch = [
      ...bigTurn("t1", "a".repeat(3000)), ...bigTurn("t2", "b".repeat(3000)), ...bigTurn("t3", "c".repeat(3000)),
      ...bigTurn("t4", "d".repeat(3000)), ...bigTurn("t5", "e".repeat(3000)),
    ];
    for (const t of splitIntoTurns(branch)) engine.enqueue(t);
    await engine.waitIdle(5000);
    expect(store.get("t1")?.level).toBeUndefined(); // 摘要完成时尚未降级

    const ledgers = store.keys()
      .map((k) => store.get(k)!)
      .filter(Boolean)
      .sort((x, y) => x.turnStartEntryId.localeCompare(y.turnStartEntryId));
    await degradeEngine.run(ledgers);

    expect(store.get("t1")?.level).toBe(2);          // 最旧 → L2
    expect(store.get("t4")?.level).toBe(2);
    expect(store.get("t5")?.level).toBeUndefined();  // 最新保留区 → 仍是 L1（缺省）
    // L2 渲染丢命令：detail 仍在，target/命令消失
    const head = ((assembleContext(branch, new Map([...store.keys().map((k) => [k, store.get(k)!] as const)]), 100)
      .messages[0] as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("正常");
    expect(head).not.toContain("src/app.ts");
  });

  it("L3 ledger renders intent/outcome lines in assembled action ledger", async () => {
    const bigUser = "帮我了解 ledger 的结构（完整原文内容）" + "背景".repeat(1000);
    const bigReply = "这是完整回复原文，不该出现在 L3" + "细节".repeat(1000);
    const ledger: LedgerData = {
      turnStartEntryId: "t1", turnEndEntryId: "t1-r", level: 3,
      summary: {
        userIntent: "了解ledger结构", outcome: "确认四级占位",
        groups: [{ phase: "investigate", entries: [{ action: "read", target: "src/ledger.ts", detail: "阅读核心数据结构", recallIds: ["t1-a"] }] }],
      },
      userMessage: { text: bigUser, entryId: "t1", truncated: false },
      finalReply: { text: bigReply, entryId: "t1-r", truncated: false },
    };
    const branch: MessageEntry[] = [
      { id: "t1", message: { role: "user", content: [{ type: "text", text: bigUser }] } as AgentMessage },
      { id: "t1-r", message: { role: "assistant", content: [{ type: "text", text: bigReply }] } as AgentMessage },
      { id: "t2", message: { role: "user", content: [{ type: "text", text: "q2" }] } as AgentMessage },
      { id: "t2-r", message: { role: "assistant", content: [{ type: "text", text: "a2" }] } as AgentMessage },
    ];
    const { messages } = assembleContext(branch, new Map([["t1", ledger]]), 100); // 小预算 → t1（大）窗外，t2 窗内
    const head = ((messages[0] as any).content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("意图：了解ledger结构");        // 用户输入 → 意图单行
    expect(head).toContain("调查：阅读核心数据结构");       // 动作摘要仍在
    expect(head).toContain("最终回复（摘要）：确认四级占位"); // 最终回复 → 摘要单行
    expect(head).not.toContain("帮我了解");               // 用户原文不再出现
    expect(head).not.toContain("完整回复原文");            // 回复原文不再出现
  });

  it("store rejects ledger entries with invalid level on rebuild", () => {
    const base = {
      turnStartEntryId: "a", turnEndEntryId: "a-r",
      summary: { groups: [{ phase: "other" as const, entries: [{ action: "read", target: "x", detail: "d", recallIds: ["a"] }] }] },
    };
    const store = new LedgerStore();
    store.rebuildFromEntries([
      { id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { ...base, level: 7 } }, // 脏 level → 拒绝
      { id: "x2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { ...base, turnStartEntryId: "b", level: 3 } },
      { id: "x3", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { ...base, turnStartEntryId: "c" } }, // 缺省 level → 合法（视为 L1）
    ]);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.level).toBe(3);
    expect(store.get("c")).toBeTruthy();
  });
});
