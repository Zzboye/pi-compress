import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { dumpContext, renderMarkdown, writeContextDump, defaultDumpBase } from "../src/dump.js";
import { DEFAULT_CONFIG } from "../src/config.js";
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
