import { describe, it, expect } from "vitest";
import { buildSummarizePrompt, buildIntentOutcomePrompt, buildMergeDescriptionPrompt, type ToolActionInfo } from "../src/prompts.js";
import { parseLedgerOutput } from "../src/ledger.js";
import { splitIntoTurns, serializeTurn, type MessageEntry } from "../src/util.js";

const actions: ToolActionInfo[] = [
  { action: "read", target: "src/hooks.ts", entryIds: ["e003"] },
  { action: "bash", target: "npm test", entryIds: ["e012"] },
];
const turnText = '[User]: 修内存泄漏\n[Assistant tool calls]: read(path="src/hooks.ts")\n[Tool result]: ...\n[Assistant tool calls]: bash(command="npm test")\n[Tool result]: 3 passed';

describe("buildSummarizePrompt", () => {
  it("contains serialized turn, verbatim action list with entry ids, and JSON schema", () => {
    const p = buildSummarizePrompt(turnText, actions);
    expect(p).toContain("[User]: 修内存泄漏");
    expect(p).toContain('src/hooks.ts');
    expect(p).toContain("e003");
    expect(p).toContain("JSON");
    expect(p).toContain("另行逐字保存");   // 新：说明用户消息/最终回复不经模型
    expect(p).not.toContain("userIntent"); // 旧：不再要求生成意图字段
    expect(p).not.toContain("outcome");    // 旧：不再要求生成结果字段
  });
});

describe("serializeTurn（thinking 剥离）", () => {
  it("剥离 assistant 的 thinking 块：思考噪声不进摘要 prompt，text/toolCall/toolResult 保留", () => {
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "读一下文件" }], timestamp: 1 } as any },
      { id: "a1", message: { role: "assistant", content: [
        { type: "thinking", thinking: "机密内部推理".repeat(50) },
        { type: "text", text: "好的，我来读" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
      ], timestamp: 2 } as any },
      { id: "r1", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "文件内容xyz" }], timestamp: 3 } as any },
      { id: "a2", message: { role: "assistant", content: [{ type: "thinking", thinking: "纯思考无正文" }], timestamp: 4 } as any },
    ];
    const turn = splitIntoTurns(entries)[0];
    const text = serializeTurn(turn);
    expect(text).not.toContain("机密内部推理");
    expect(text).not.toContain("纯思考无正文");
    expect(text).toContain("好的，我来读");
    expect(text).toContain("read");
    expect(text).toContain("文件内容xyz");
  });
});

describe("parseLedgerOutput", () => {
  it("parses valid output and merges mechanical fields", () => {
    const raw = JSON.stringify({
      userIntent: "修复内存泄漏",
      outcome: "已修复",
      entries: [
        { target: "src/hooks.ts", detail: "清理函数缺失", phase: "investigate" },
        { target: "npm test", detail: "通过", phase: "verify" },
      ],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.userIntent).toBeUndefined();          // 模型输出的 userIntent 被忽略
    expect(s.outcome).toBeUndefined();             // 模型输出的 outcome 被忽略
    const read = s.entries.find((e) => e.action === "read")!;
    expect(read.recallIds).toEqual(["e003"]);       // recallIds 来自机械清单
    expect(read.target).toBe("src/hooks.ts");        // target 来自机械清单
    expect(read.detail).toBe("清理函数缺失");        // detail 来自模型
    expect(read.phase).toBe("investigate");
  });

  it("entries-only output：缺失的 phase 落为 other，机械时间序", () => {
    const raw = JSON.stringify({
      entries: [{ target: "src/hooks.ts", detail: "清理函数缺失" }],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.entries[0].detail).toBe("清理函数缺失");
    expect(s.entries[0].phase).toBe("other");
  });

  it("throws LedgerParseError when entries missing", () => {
    expect(() => parseLedgerOutput(JSON.stringify({ userIntent: "u", outcome: "o" }), actions, turnText, true)).toThrow();
  });

  it("drops entries whose model detail contains a target-like path not in source (verbatim guard)", () => {
    const raw = JSON.stringify({
      userIntent: "u", outcome: "o",
      entries: [{ target: "src/hooks.ts", detail: "见 src/other.ts", phase: "other" }],
    });
    // src/other.ts 不在 turnText 中 → 该条目被剔除
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.entries.length).toBe(0);
  });

  it("throws LedgerParseError on invalid JSON", () => {
    expect(() => parseLedgerOutput("not json", actions, turnText, true)).toThrow();
  });
});

describe("degrade prompts", () => {
  it("buildIntentOutcomePrompt embeds both texts and JSON schema", () => {
    const p = buildIntentOutcomePrompt("用户原文", "回复原文");
    expect(p).toContain("用户原文");
    expect(p).toContain("回复原文");
    expect(p).toContain('"userIntent"');
    expect(p).toContain('"outcome"');
  });
  it("buildMergeDescriptionPrompt embeds each turn text", () => {
    const p = buildMergeDescriptionPrompt(["T1 块", "T2 块"]);
    expect(p).toContain("T1 块");
    expect(p).toContain("T2 块");
    expect(p).toContain("2 轮"); // schema 中的条数说明字段
  });
});
