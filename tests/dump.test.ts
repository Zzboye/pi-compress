import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { dumpContext, renderMarkdown, writeContextDump, defaultDumpBase } from "../src/dump.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { NoteStore } from "../src/notes.js";
import type { AgentMessage } from "../src/types.js";
import type { LedgerData } from "../src/ledger.js";

function msg(id: string, role: "user" | "assistant" | "toolResult", text: string): MessageEntry {
  return { id, message: { role, content: [{ type: "text", text }] } as AgentMessage };
}

function ledgerFor(turn: { startEntryId: string; endEntryId: string }): LedgerData {
  return {
    turnStartEntryId: turn.startEntryId,
    turnEndEntryId: turn.endEntryId,
    summary: { userIntent: "旧问题意图", outcome: "旧问题已解决", entries: [] },
  };
}

describe("dumpContext", () => {
  it("turns 标注窗口归属：窗外有摘要 replaced（附 ledger 摘要），窗口内 lead", () => {
    const big = "z".repeat(4000);
    const branch = [
      msg("a", "user", big), msg("b", "assistant", big), // turn1：大 → 窗外，有摘要 → replaced
      msg("c", "user", "q2"), msg("d", "assistant", "a2"), // turn2：窗口内 → lead
    ];
    const cache = new Map([["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })]]);
    const dump = dumpContext(branch, cache, { ...DEFAULT_CONFIG, keepRecentTokens: 100 });
    expect(dump.turns.length).toBe(2);
    expect(dump.turns[0]).toMatchObject({ startEntryId: "a", endEntryId: "b", lead: "replaced" });
    expect(dump.turns[0].ledger?.userIntent).toBe("旧问题意图");
    expect(dump.turns[1]).toMatchObject({ startEntryId: "c", lead: "lead" });
    expect(dump.turns[1].ledger).toBeUndefined();
    // stats 与 assembleContext 同源：替换 1、窗口 1
    expect(dump.stats).toEqual({ windowTurns: 1, replacedTurns: 1, passthroughTurns: 0 });
  });

  it("窗外无摘要 → passthrough 标注，原文照发进 messages", () => {
    const big = "z".repeat(4000);
    const branch = [msg("a", "user", big), msg("b", "assistant", big), msg("c", "user", "q2"), msg("d", "assistant", "a2")];
    const dump = dumpContext(branch, new Map(), { ...DEFAULT_CONFIG, keepRecentTokens: 100 });
    expect(dump.turns[0].lead).toBe("passthrough");
    expect(dump.stats.passthroughTurns).toBe(1);
    const all = dump.messages.map((m) => m.text).join("\n");
    expect(all).toContain(big); // passthrough 原文可见
  });

  it("messages 与装配结果一致：ledger 头在首、thinking 剥离、含全文与逐条体积", () => {
    const branch: MessageEntry[] = [
      msg("a", "user", `q1 ${"z".repeat(4000)}`), // turn1 大 → 窗外，有摘要 → replaced
      msg("b", "assistant", "旧回答"),
      msg("c", "user", "q2"),
      { id: "d", message: { role: "assistant", content: [
        { type: "thinking", thinking: "思考过程应被剥离" },
        { type: "text", text: "回答正文" },
      ] } as AgentMessage }, // turn2 窗口内
    ];
    const cache = new Map([["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })]]);
    const dump = dumpContext(branch, cache, { ...DEFAULT_CONFIG, keepRecentTokens: 100 }); // 只留最后 turn
    const all = dump.messages.map((m) => m.text).join("\n");
    expect(all).toContain("<action-ledger>"); // replaced turn → ledger 头
    expect(all).not.toContain("q1");          // replaced turn 的用户原话不出现在装配结果
    expect(all).not.toContain("旧回答");
    expect(all).not.toContain("思考过程应被剥离"); // thinking 剥离
    expect(all).toContain("回答正文");          // 窗口内原文
    // 逐条体积
    const assistant = dump.messages.find((m) => m.role === "assistant" && m.text.includes("回答正文"))!;
    expect(assistant.model).toBeUndefined(); // fixture 无 model 字段
    expect(assistant.chars).toBeGreaterThan(0);
    expect(assistant.tokens).toBeGreaterThan(0);
    expect(assistant.blocks).toEqual(["text"]);
    // 汇总与逐条一致
    expect(dump.assembled.total).toBe(dump.messages.length);
    expect(dump.assembled.chars).toBe(dump.messages.reduce((s, m) => s + m.chars, 0));
  });

  it("meta 记录 config 与来源", () => {
    const dump = dumpContext([msg("a", "user", "q")], new Map(), DEFAULT_CONFIG);
    expect(dump.source).toBe("slash-command");
    expect(dump.config.keepRecentTokens).toBe(DEFAULT_CONFIG.keepRecentTokens);
    expect(dump.generatedAt).toBeTruthy();
  });

  it("dump：进行中超大 turn 与 context 同口径——片段行可见、原文侧裁剪", () => {
    // 构造 branch：单个进行中超大 turn（user + 4 对 toolCall→toolResult，同 assembler 用例 fixture）
    const branch: MessageEntry[] = [msg("u", "user", "任务")];
    for (let i = 1; i <= 4; i++) {
      branch.push({ id: `a${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `cmd${i}` } }] } as any });
      branch.push({ id: `r${i}`, message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "x".repeat(2000) }] } as any });
    }
    // cache（含片段 ledger）：片段 a1..r4 已摘要落盘，口径与 assembler 用例一致
    const fragLedger: LedgerData = { turnStartEntryId: "a1", turnEndEntryId: "r4", summary: { userIntent: "跑命令", outcome: "完成", entries: [] } };
    const cache = new Map([["a1", fragLedger]]);
    const dump = dumpContext(branch, cache, { ...DEFAULT_CONFIG, keepRecentTokens: 200 });
    const all = dump.messages.map((m) => m.text).join("\n");
    expect(all).toContain("<action-ledger>");
    expect(all).toContain("跑命令");          // 片段行在日志头
    expect(all).not.toContain("cmd1");        // 片段条目不在消息原文里
    expect(all).not.toContain("x".repeat(2000));
    expect(all).toContain("任务");            // user 消息保留
  });

  it("turns 表与 messages 同源（trimmedBranch）：两 turn 场景 lead 标注与消息实际内容一致", () => {
    const big = "z".repeat(4000); // ~1k tok：turn1 在窗外
    const branch: MessageEntry[] = [
      msg("a", "user", big), msg("b", "assistant", big), // turn1：窗外有摘要 → replaced
      msg("u2", "user", "任务"),
    ];
    for (let i = 1; i <= 4; i++) {
      branch.push({ id: `a${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `cmd${i}` } }] } as any });
      branch.push({ id: `r${i}`, message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "x".repeat(2000) }] } as any });
    }
    // turn1 ledger（窗外 replaced）+ 片段 ledger（覆盖 turn2 的 a1..r2，已落盘）
    const cache = new Map<string, LedgerData>([
      ["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })],
      ["a1", { turnStartEntryId: "a1", turnEndEntryId: "r2", summary: { userIntent: "跑命令", outcome: "完成", entries: [] } }],
    ]);
    // keep=1500：剩余部分（u2+a3..r4 ≈1k tok）不再切新片段；窗口只装 turn2 → turn1 replaced
    const dump = dumpContext(branch, cache, { ...DEFAULT_CONFIG, keepRecentTokens: 1500 });
    // turns 表（基于 trimmedBranch）与 messages 同源：replaced turn 的原文不在 messages，
    // lead turn 的裁剪后条目在 messages——不再出现「标 replaced 却原文可见」的矛盾
    expect(dump.turns.map((t) => t.lead)).toEqual(["replaced", "lead"]);
    expect(dump.turns[0].ledger?.userIntent).toBe("旧问题意图");
    expect(dump.stats).toEqual({ windowTurns: 1, replacedTurns: 1, passthroughTurns: 0 });
    const all = dump.messages.map((m) => m.text).join("\n");
    expect(all).not.toContain(big);    // replaced turn 原文不在 messages
    expect(all).not.toContain("cmd1"); // 已覆盖片段前缀不在 messages
    expect(all).not.toContain("cmd2");
    expect(all).toContain("cmd3");     // lead turn 未覆盖条目在 messages
    expect(all).toContain("跑命令");    // 片段行在日志头（extraLedgers）
    expect(all).toContain("任务");      // user 消息保留
  });
});

describe("renderMarkdown / writeContextDump", () => {
  it("Markdown 含元信息、turn 表与 messages 原文段", () => {
    const big = "z".repeat(4000);
    const branch = [msg("a", "user", big), msg("b", "assistant", big), msg("c", "user", "q2"), msg("d", "assistant", "a2")];
    const cache = new Map([["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })]]);
    const dump = dumpContext(branch, cache, { ...DEFAULT_CONFIG, keepRecentTokens: 100 });
    const md = renderMarkdown(dump);
    expect(md).toContain("# context-compress 上下文转储");
    expect(md).toContain(`keepRecentTokens：100`);
    expect(md).toContain("replaced");
    expect(md).toContain("旧问题意图");
    expect(md).toContain("### #0");
    expect(md).toContain("q2"); // 原文段
  });

  it("writeContextDump 双份落盘且 JSON 可回读", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-dump-"));
    try {
      const dump = dumpContext([msg("a", "user", "q1"), msg("b", "assistant", "a1")], new Map(), DEFAULT_CONFIG);
      const [mdPath, jsonPath] = writeContextDump(dump, path.join(dir, "dump-base"));
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(true);
      expect(mdPath.endsWith(".md")).toBe(true);
      expect(jsonPath.endsWith(".json")).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      expect(parsed.messages.length).toBe(dump.messages.length);
      expect(parsed.config.keepRecentTokens).toBe(DEFAULT_CONFIG.keepRecentTokens);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultDumpBase 落在 cwd/e2e/reports 下", () => {
    expect(defaultDumpBase("/some/cwd")).toMatch(/[/\\]some[/\\]cwd[/\\]e2e[/\\]reports[/\\]\d+-context-dump$/);
  });
});

// splitIntoTurns 仍被 dump 间接使用，防止 tree-shaking 误删导致类型漂移
void splitIntoTurns;

describe("dumpContext 与 context 事件口径一致（notes 注入）", () => {
  it("传 notesStore 时 dump 首条消息为项目记忆块（unshift 到 ledger 头之前）", () => {
    const branch = [msg("a", "user", "q"), msg("b", "assistant", "a")];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dump-notes-"));
    const store = new NoteStore(path.join(dir, "notes.json"));
    store.append("tasks", { text: "测试任务：验证 dump 注入", detail: "详情" });
    try {
      const dump = dumpContext(branch, new Map(), { ...DEFAULT_CONFIG, projectNotes: { enabled: true, path: "x.json", maxTokens: 0 } }, new Date(), store);
      expect(dump.messages.length).toBe(3); // notes + 窗口原文×2
      const first = dump.messages[0].text;
      expect(first).toContain("【项目记忆】");
      expect(first).toContain("测试任务");
      expect(dump.messages[1].text).toContain("q"); // 窗口原文跟在 notes 后
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled=false 时 dump 不注入（口径与 context 事件一致）", () => {
    const branch = [msg("a", "user", "q"), msg("b", "assistant", "a")];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dump-notes-"));
    const store = new NoteStore(path.join(dir, "notes.json"));
    store.append("tasks", { text: "不应出现的任务", detail: "" });
    try {
      const dump = dumpContext(branch, new Map(), { ...DEFAULT_CONFIG, projectNotes: { enabled: false, path: "x.json", maxTokens: 0 } }, new Date(), store);
      expect(dump.messages.length).toBe(2);
      expect(dump.messages.some((m) => m.text.includes("不应出现的任务"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不传 notesStore（缺省参数）行为不变", () => {
    const branch = [msg("a", "user", "q"), msg("b", "assistant", "a")];
    const dump = dumpContext(branch, new Map(), { ...DEFAULT_CONFIG, projectNotes: { enabled: true, path: "x.json", maxTokens: 0 } });
    expect(dump.messages.length).toBe(2);
  });
});
