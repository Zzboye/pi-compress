import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { executeRecall, executeRecallDual, searchLedger } from "../src/recall.js";
import { serializeTurn, splitIntoTurns } from "../src/util.js";
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

  it("detail 纯空白字符串：视为无详情", () => {
    const store = mkDualStore();
    store.append("feedback", { text: "A", detail: "   \n\t " });
    const r = executeRecallDual(["fb-001"], [], store, 4000);
    expect(r.text).toContain("（该条目无详情）");
  });

  it("双前缀 ↩↩fb-001：剥掉全部前导 ↩ 后命中", () => {
    const store = mkDualStore();
    store.append("feedback", { text: "A", detail: "dd" });
    const r = executeRecallDual(["↩↩fb-001"], [], store, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("dd");
  });

  it("store 为 null 时 notesHits=0", () => {
    expect(executeRecallDual(["e1"], branch, null, 4000).notesHits).toBe(0);
  });
});

// ---------- recall 返回图片（混合 content）----------

describe("recall 返回图片", () => {
  const pngBlock = { type: "image", mimeType: "image/png", data: "AAAA" };
  const jpegBlock = { type: "image", mimeType: "image/jpeg", data: "BBBB" };

  const imgBranch: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "看图" }, pngBlock] } } as unknown as MessageEntry,
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "shot", arguments: {} }] } } as unknown as MessageEntry,
    { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "shot", content: [{ type: "text", text: "截图完成" }, jpegBlock] } } as unknown as MessageEntry,
  ];

  it("命中含图 entry：images 收集自身 content 的图 + 文本提示", () => {
    const r = executeRecall(["u1"], imgBranch, 4000);
    expect(r.images).toEqual([{ block: pngBlock, sourceId: "u1" }]);
    expect(r.text).toContain("[含图片 ×1，已附在结果中]");
  });

  it("recall toolCall entry：配对 toolResult 的图一并带回", () => {
    const r = executeRecall(["a1"], imgBranch, 4000);
    expect(r.images).toEqual([{ block: jpegBlock, sourceId: "a1" }]);
    expect(r.text).toContain("[含图片 ×1，已附在结果中]");
  });

  it("多图多源：按命中顺序收集，sourceId 标注来源", () => {
    const r = executeRecall(["u1", "a1"], imgBranch, 4000);
    expect(r.images.map((i) => i.sourceId)).toEqual(["u1", "a1"]);
  });

  it("无图 entry：images 为空数组、文本无提示（零变化）", () => {
    const r = executeRecall(["e1"], branch, 4000);
    expect(r.images).toEqual([]);
    expect(r.text).not.toContain("[含图片");
  });

  it("executeRecallDual 透传 images；notes 命中不产图", () => {
    const store = mkDualStore();
    store.append("prefs", { text: "偏好 X", detail: "细节", status: "有效" });
    const r = executeRecallDual(["pref-001", "u1"], imgBranch, store, 4000);
    expect(r.images.map((i) => i.sourceId)).toEqual(["u1"]);
    expect(r.notesHits).toBe(1);
  });

  it("同图去重：同一图块（同 mimeType+data）经自身+配对 toolResult 双路径只收一次", () => {
    // a1 的 toolCall 配对 r1；r1 的 content 含 jpegBlock；再把同块塞进 a1 自身 content
    // → 收集时 a1（自含+配对 toolResult）应只产一张图
    const dupBranch: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "看图" }, pngBlock] } } as unknown as MessageEntry,
      { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "shot", arguments: {} }, jpegBlock] } } as unknown as MessageEntry,
      { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "shot", content: [{ type: "text", text: "完成" }, jpegBlock] } } as unknown as MessageEntry,
    ];
    const r = executeRecall(["a1"], dupBranch, 4000);
    expect(r.images).toEqual([{ block: jpegBlock, sourceId: "a1" }]);
  });

  it("截断+图提示共存：图提示在截断后追加，不被截掉", () => {
    // imgBranch 的 u1 文本极短，改用长文本含图 entry
    const longBranch: MessageEntry[] = [
      { id: "u2", message: { role: "user", content: [{ type: "text", text: "长".repeat(9000) }, pngBlock] } } as unknown as MessageEntry,
    ];
    const r = executeRecall(["u2"], longBranch, 1000); // maxTokensPerEntry=1000 → 截断
    expect(r.text).toContain("已截断");
    expect(r.text).toContain("[含图片 ×1，已附在结果中]");
    expect(r.text.indexOf("[含图片")).toBeGreaterThan(r.text.indexOf("已截断")); // 提示在截断标记之后
    expect(r.images).toEqual([{ block: pngBlock, sourceId: "u2" }]);
  });

  it("image 块缺 mimeType → 回退 unknown（收集与标记双路）", () => {
    const noMimeBranch: MessageEntry[] = [
      { id: "u3", message: { role: "user", content: [{ type: "text", text: "看" }, { type: "image", data: "CCCC" }] } } as unknown as MessageEntry,
    ];
    // 收集路：mimeType 缺失回退 image/png（保持块可用）
    const r = executeRecall(["u3"], noMimeBranch, 4000);
    expect(r.images[0].block.mimeType).toBe("image/png");
    // 标记路：imageToTextMarkers 缺 mimeType 回退 unknown
    const turn = { startEntryId: "u3", endEntryId: "u3", entries: noMimeBranch } as any;
    const s = serializeTurn(turn);
    expect(s).toContain("[图片: unknown]");
  });
});

describe("三档召回语义（L3/L4 turn 级、L5 拒绝）", () => {
  // branch：u1 用户原话 → a1 工具调用 → r1 工具结果 → a2 最终回复
  const branch: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] }, timestamp: 1 } as any,
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] }, timestamp: 2 } as any,
    { id: "r1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "3 passed" }] }, timestamp: 3 } as any,
    { id: "a2", message: { role: "assistant", content: [{ type: "text", text: "已修复并推送" }] }, timestamp: 4 } as any,
  ];
  const turns = splitIntoTurns(branch); // 单 turn，startEntryId=u1
  const mkCtx = (level: number) => ({
    ledgers: [{ turnStartEntryId: "u1", turnEndEntryId: "a2", level } as any],
    turns,
  });

  it("L3 的任意 ID 触发 turn 级召回：整段原文含工具过程", () => {
    const r = executeRecallDual(["r1"], branch, null, 4000, mkCtx(3));
    expect(r.text).toContain("整段原文");
    expect(r.text).toContain("修一下排序");
    expect(r.text).toContain("npm test");           // 工具过程可恢复
    expect(r.text).toContain("3 passed");           // toolResult 在
    expect(r.text).toContain("已修复并推送");         // 最终回复在
  });

  it("L4 的 ID 同样 turn 级召回", () => {
    const r = executeRecallDual(["u1"], branch, null, 4000, mkCtx(4));
    expect(r.text).toContain("整段原文");
    expect(r.text).toContain("3 passed");
  });

  it("L5 的 ID 拒绝召回：返回终态说明，不返回原文", () => {
    const r = executeRecallDual(["u1"], branch, null, 4000, mkCtx(5));
    expect(r.text).toContain("已合并为终态摘要");
    expect(r.text).not.toContain("npm test");
    expect(r.text).not.toContain("修一下排序");
  });

  it("无 degradeCtx 时行为不变（entry 级），L1/L2 同样 entry 级", () => {
    const noCtx = executeRecallDual(["a1"], branch, null, 4000);
    expect(noCtx.text).toContain("[Tool result]: 3 passed"); // 配对 toolResult 连带（既有语义；serializeForRecall 不输出 toolCall id）
    const l1 = executeRecallDual(["a1"], branch, null, 4000, mkCtx(1));
    expect(l1.text).toContain("[Tool result]: 3 passed");
    const l2 = executeRecallDual(["a1"], branch, null, 4000, mkCtx(2));
    expect(l2.text).toContain("[Tool result]: 3 passed");
  });

  it("turn 级召回受 maxTokensPerEntry 预算截断", () => {
    const r = executeRecallDual(["u1"], branch, null, 1, mkCtx(3)); // 1 token = 4 字符
    expect(r.text).toContain("已截断");
    expect(r.text.length).toBeLessThan(400);
  });

  it("多 ID 混合层级：各自路由，互不影响", () => {
    // 两个 turn：t1 (L3) 与 t2 (L5)
    const branch2: MessageEntry[] = [
      ...branch,
      { id: "u2", message: { role: "user", content: [{ type: "text", text: "下一个任务" }] }, timestamp: 5 } as any,
      { id: "a3", message: { role: "assistant", content: [{ type: "text", text: "完成" }] }, timestamp: 6 } as any,
    ];
    const ctx = {
      ledgers: [
        { turnStartEntryId: "u1", turnEndEntryId: "a2", level: 3 },
        { turnStartEntryId: "u2", turnEndEntryId: "a3", level: 5 },
      ] as any[],
      turns: splitIntoTurns(branch2),
    };
    const r = executeRecallDual(["r1", "u2"], branch2, null, 4000, ctx);
    expect(r.text).toContain("整段原文");              // r1 → turn 级
    expect(r.text).toContain("已合并为终态摘要");       // u2 → 拒绝
  });

  it("F1 去重：同 turn 多 ID 只有首个返回整段原文，后续 ID 输出一行提示", () => {
    const r = executeRecallDual(["a1", "a2"], branch, null, 4000, mkCtx(3));
    // 首个 ID（a1）正常 turn 级整段返回
    expect(r.text).toContain("修一下排序");
    expect(r.text).toContain("已随 ↩a1 返回，不重复输出");   // a2 的去重提示
    expect(r.text).not.toContain("↩a2 所在 turn");           // a2 不再重复整段原文
    // 整段原文只出现一次（旧实现按 ID 重复输出）
    expect(r.text.split("修一下排序").length - 1).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("F1 去重：同 turn 图片只 push 一次（不随重复 ID 翻倍）", () => {
    const imgBranch: MessageEntry[] = [
      { id: "u9", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "AAAA" }] }, timestamp: 1 } as any,
      { id: "a9", message: { role: "assistant", content: [{ type: "text", text: "好的" }] }, timestamp: 2 } as any,
    ];
    const ctx9 = { ledgers: [{ turnStartEntryId: "u9", turnEndEntryId: "a9", level: 3 } as any], turns: splitIntoTurns(imgBranch) };
    const r = executeRecallDual(["u9", "a9"], imgBranch, null, 4000, ctx9);
    expect(r.images).toHaveLength(1);           // 图片块仅一份
    expect(r.text).toContain("已随 ↩u9 返回");
  });
});

function mkLedger(partial: Partial<LedgerData> & { turnStartEntryId: string }): LedgerData {
  return {
    turnEndEntryId: partial.turnStartEntryId + "-end",
    summary: { entries: [] },
    ...partial,
  } as LedgerData;
}

describe("searchLedger", () => {
  const ledgers: LedgerData[] = [
    mkLedger({
      turnStartEntryId: "t1", level: 1,
      userMessage: { text: "forceRatio 是什么？为什么默认 0.76", entryId: "t1-u" },
      finalReply: { text: "forceRatio 是触发强制点的比例", entryId: "t1-f" },
      summary: { entries: [
        { action: "read", target: "src/config.ts", detail: "校验 forceRatio 范围", recallIds: ["t1-a"], phase: "investigate" },
      ] },
    }),
    mkLedger({
      turnStartEntryId: "t2", level: 3,
      summary: { userIntent: "了解 keepRecentTokens", entries: [] },
      userMessage: { text: "keepRecentTokens 怎么配？", entryId: "t2-u" },
    }),
    mkLedger({
      turnStartEntryId: "t3", level: 5, // Task 2：合并组右移为 L5
      merged: { description: "调整 forceRatio 并验证窗口行为" },
      summary: { entries: [
        { action: "edit", target: "a.ts", detail: "改 forceRatio 默认值", recallIds: ["t3-a1", "t3-a2"], phase: "fix" },
      ] },
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

  it("命中 L5 merged.description → turnLabel 显示组内 turn 范围", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3");
    expect(h.level).toBe(5);
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

  it("L5 连续组 turnLabel 显示范围（多 ledger L5 相邻且同描述时合并为 T3-T4）", () => {
    const t4 = mkLedger({
      turnStartEntryId: "t4", level: 5,
      merged: { description: "调整 forceRatio 并验证窗口行为" }, // 同批同描述
      summary: { entries: [] },
    });
    const r = searchLedger("forceRatio", [...ledgers, t4], 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3-T4");
    // 组内每条 merged.description 均可命中，且都标同一组范围
    const mergedHits = r.hits.filter((x) => x.field === "合并描述");
    expect(mergedHits.length).toBe(2);
    expect(mergedHits.every((x) => x.turnLabel === "T3-T4")).toBe(true);
  });

  it("L5 相邻但描述不同 → 聚合按组分断，各组标各自范围（M4）", () => {
    // t3(描述X) + t4(描述Y) + t5(描述Y)：同描述的 t4/t5 一组，t3 独立
    const t4 = mkLedger({
      turnStartEntryId: "t4", level: 5,
      merged: { description: "另一批任务也涉及 forceRatio" },
      summary: { entries: [] },
    });
    const t5 = mkLedger({
      turnStartEntryId: "t5", level: 5,
      merged: { description: "另一批任务也涉及 forceRatio" },
      summary: { entries: [] },
    });
    const r = searchLedger("forceRatio", [...ledgers, t4, t5], 15);
    const hits = r.hits.filter((x) => x.field === "合并描述");
    const t3hit = hits.find((x) => x.turnLabel === "T3");
    const t45hit = hits.find((x) => x.turnLabel === "T4-T5");
    expect(t3hit).toBeDefined();
    expect(t45hit).toBeDefined();
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
