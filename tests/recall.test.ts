import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { executeRecall, executeRecallDual, searchLedger } from "../src/recall.js";
import { NoteStore } from "../src/notes.js";
import type { MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";
import type { LedgerData } from "../src/ledger.js";

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
    // 有效正文很小，但 thinking 不剥离时 countTokens 远超阈值 → 会被误截断（旧口径回归参照）
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

// ---------- executeRecallDual（notes 双源）----------

const dualDirs: string[] = [];
function mkDualStore(): NoteStore {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "recall-dual-test-"));
  dualDirs.push(dir);
  const s = new NoteStore(join(dir, "notes.json"));
  s.load();
  return s;
}
afterEach(() => { for (const d of dualDirs) fs.rmSync(d, { recursive: true, force: true }); dualDirs.length = 0; });

function userEntry(id: string, text: string): MessageEntry {
  return { id, message: { role: "user", content: [{ type: "text", text }] } } as unknown as MessageEntry;
}

describe("executeRecallDual", () => {
  it("notes ID 命中：返回 detail 而非 branch 原文", () => {
    const store = mkDualStore();
    store.append("feedback", { text: "摘要行", detail: "方法详情全文", status: "有效" });
    const r = executeRecallDual(["fb-001"], [], store, 4000);
    expect(r.text).toContain("记忆详情");
    expect(r.text).toContain("方法详情全文");
    expect(r.missing).toEqual([]);
  });

  it("带 ↩ 前缀与带 entry 前缀混传：各走各的源", () => {
    const store = mkDualStore();
    store.append("tasks", { text: "T", detail: "任务详情", status: "进行中" });
    const b = [userEntry("u1", "你好")];
    const r = executeRecallDual(["↩task-001", "u1"], b, store, 4000);
    expect(r.text).toContain("任务详情");
    expect(r.text).toContain("u1");            // entry 原文路径照常
    expect(r.missing).toEqual([]);
  });

  it("notes ID 条目不存在：missing 计入 + 专用文案", () => {
    const store = mkDualStore();
    const r = executeRecallDual(["fb-042"], [], store, 4000);
    expect(r.missing).toEqual(["fb-042"]);
    expect(r.text).toContain("不存在或已删除");
  });

  it("store 为 null（未启用）：entry ID 行为与现有 executeRecall 完全一致", () => {
    const r = executeRecallDual(["e1"], branch, null, 4000);
    const r2 = executeRecall(["e1"], branch, 4000);
    expect(r.text).toBe(r2.text);
    expect(r.missing).toEqual(r2.missing);
  });

  it("notes ID 命中但 detail 为空：输出无详情提示", () => {
    const store = mkDualStore();
    store.append("prefs", { text: "P" });
    const r = executeRecallDual(["pref-001"], [], store, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("（该条目无详情）");
  });

  it("notesHits 计数：命中 notes 源的条目数（不存在的 notes ID 计入 missing 而非 notesHits）", () => {
    const store = mkDualStore();
    store.append("feedback", { text: "A", detail: "da" });
    store.append("feedback", { text: "B", detail: "db" });
    const r = executeRecallDual(["fb-001", "fb-002", "u1", "fb-009"], [userEntry("u1", "hi")], store, 4000);
    expect(r.notesHits).toBe(2);
    expect(r.missing).toContain("fb-009");
  });

  it("executeRecall 恒返回 notesHits=0（单源无 notes 概念）", () => {
    expect(executeRecall(["e1"], branch, 4000).notesHits).toBe(0);
  });

  it("store 为 null 时 notesHits=0", () => {
    expect(executeRecallDual(["e1"], branch, null, 4000).notesHits).toBe(0);
  });
});

function mkLedger(partial: Partial<LedgerData> & { turnStartEntryId: string }): LedgerData {
  return {
    turnEndEntryId: partial.turnStartEntryId + "-end",
    summary: { groups: [] },
    ...partial,
  } as LedgerData;
}

describe("searchLedger", () => {
  const ledgers: LedgerData[] = [
    mkLedger({
      turnStartEntryId: "t1", level: 1,
      userMessage: { text: "forceRatio 是什么？为什么默认 0.76", entryId: "t1-u" },
      finalReply: { text: "forceRatio 是触发强制点的比例", entryId: "t1-f" },
      summary: { groups: [{ phase: "investigate", entries: [
        { action: "read", target: "src/config.ts", detail: "校验 forceRatio 范围", recallIds: ["t1-a"] },
      ] }] },
    }),
    mkLedger({
      turnStartEntryId: "t2", level: 3,
      summary: { userIntent: "了解 keepRecentTokens", groups: [] },
      userMessage: { text: "keepRecentTokens 怎么配？", entryId: "t2-u" },
    }),
    mkLedger({
      turnStartEntryId: "t3", level: 4,
      merged: { description: "调整 forceRatio 并验证窗口行为" },
      summary: { groups: [{ phase: "fix", entries: [
        { action: "edit", target: "a.ts", detail: "改 forceRatio 默认值", recallIds: ["t3-a1", "t3-a2"] },
      ] }] },
    }),
  ];

  it("命中用户消息 → field=用户消息，entryIds 含 userMessage.entryId", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "用户消息")!;
    expect(h.turnLabel).toBe("T1");
    expect(h.level).toBe(1);
    expect(h.entryIds).toContain("t1-u");
    expect(h.snippet).toContain("forceRatio");
  });

  it("命中动作 detail → entryIds 用 recallIds（不是 turnStartEntryId）", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "动作")!;
    expect(h.entryIds).toEqual(["t1-a"]);
    expect(h.snippet).toContain("forceRatio");
  });

  it("命中 L4 merged.description → turnLabel 显示组内 turn 范围", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3");
    expect(h.level).toBe(4);
  });

  it("大小写不敏感", () => {
    const r = searchLedger("FORCERATIO", ledgers, 15);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.find((x) => x.field === "用户消息")).toBeDefined();
  });

  it("maxHits 截断 + truncated 标记", () => {
    const r = searchLedger("forceRatio", ledgers, 2);
    expect(r.hits.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("L4 连续组 turnLabel 显示范围（多 ledger L4 相邻时合并为 T3-T4）", () => {
    const t4 = mkLedger({
      turnStartEntryId: "t4", level: 4,
      merged: { description: "继续验证 forceRatio" },
      summary: { groups: [] },
    });
    const r = searchLedger("forceRatio", [...ledgers, t4], 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3-T4");
    // 组内每条 merged.description 均可命中，且都标同一组范围
    const mergedHits = r.hits.filter((x) => x.field === "合并描述");
    expect(mergedHits.length).toBe(2);
    expect(mergedHits.every((x) => x.turnLabel === "T3-T4")).toBe(true);
  });

  it("无命中返回空 hits 且不 truncated", () => {
    const r = searchLedger("zzz不存在", ledgers, 15);
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("空 query 或纯空白 query 返回空结果（防全量倾泻）", () => {
    expect(searchLedger("", ledgers, 15).hits).toEqual([]);
    expect(searchLedger("   ", ledgers, 15).hits).toEqual([]);
    expect(searchLedger("   ", ledgers, 15).truncated).toBe(false);
  });
});
