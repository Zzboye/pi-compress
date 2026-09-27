import { describe, it, expect } from "vitest";
import { buildSummarizePrompt, buildIntentOutcomePrompt, buildBatchRecompressPrompt, type ToolActionInfo } from "../src/prompts.js";
import type { LedgerData } from "../src/ledger.js";
import { parseLedgerOutput } from "../src/ledger.js";
import { splitIntoTurns, serializeTurn, type MessageEntry } from "../src/util.js";

const actions: ToolActionInfo[] = [
  { action: "read", target: "src/hooks.ts", entryIds: ["e003"] },
  { action: "bash", target: "npm test", entryIds: ["e012"] },
];
const turnText = '[User]: 修内存泄漏\n[Assistant tool calls]: read(path="src/hooks.ts")\n[Tool result]: ...\n[Assistant tool calls]: bash(command="npm test")\n[Tool result]: 3 passed';

const samePathActions: ToolActionInfo[] = [
  { action: "read", target: "src/a.ts", entryIds: ["id-read"] },
  { action: "write", target: "src/a.ts", entryIds: ["id-write"] },
];
const samePathTurnText = '[User]: 改配置\n[Assistant tool calls]: read(path="src/a.ts")\n[Tool result]: ...\n[Assistant tool calls]: write(path="src/a.ts")\n[Tool result]: ok';

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

  it("同 target 不同 action：按 id 序号匹配，不错配不丢失（Codex P1 回归）", () => {
    const p = buildSummarizePrompt(samePathTurnText, samePathActions);
    expect(p).toContain("id=0"); // 清单每条带稳定序号
    expect(p).toContain("id=1");
    const raw = JSON.stringify({
      entries: [
        { id: 0, detail: "先读配置", phase: "investigate" },
        { id: 1, detail: "再改写入", phase: "fix" },
      ],
    });
    const s = parseLedgerOutput(raw, samePathActions, samePathTurnText, true);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ action: "read", target: "src/a.ts", detail: "先读配置", recallIds: ["id-read"] });
    expect(s.entries[1]).toMatchObject({ action: "write", target: "src/a.ts", detail: "再改写入", recallIds: ["id-write"] });
  });

  it("同 target 不同 action 旧格式（无 id）：两条都能命中，不因 target 冲突去重丢失", () => {
    // 兼容模型不带 id 的输出：target 相同时第一条机械条目占位，第二条不得被 seen 去重吞掉
    const raw = JSON.stringify({
      entries: [
        { target: "src/a.ts", detail: "读了一条", phase: "investigate" },
        { target: "src/a.ts", detail: "写了改动", phase: "fix" },
      ],
    });
    const s = parseLedgerOutput(raw, samePathActions, samePathTurnText, true);
    // 两条都被接受：第一条配首个同 target 机械条目，第二条配下一个
    expect(s.entries).toHaveLength(2);
    expect(s.entries.map((e) => e.action).sort()).toEqual(["read", "write"]);
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
  it("buildIntentOutcomePrompt 不再限制字数（V6：条目化 + 保留标识）", () => {
    const p = buildIntentOutcomePrompt("用户原文", "回复原文");
    // 旧口径：硬字数上限（已弃用——实测模型不听，且砍掉关键定位信息）
    expect(p).not.toContain("≤20 字");
    expect(p).not.toContain("≤30 字");
    // V6 契约：条目化 + 保留标识 + 保留列表结构
    expect(p).toContain("关键参数与标识");
    expect(p).toContain("列表/分条目结构");
    expect(p).toContain("不要合并成一段总述");
    // V6 的剔除项（探针实测：这句是「不要退化成原文重排」的关键）
    expect(p).toContain("过程叙述");
    // 契约保留：输出仍是 userIntent/outcome 两个字段的 JSON
    expect(p).toContain('"userIntent"');
    expect(p).toContain('"outcome"');
  });
});

describe("buildBatchRecompressPrompt", () => {
  const mk = (intent: string, outcome: string): LedgerData => ({
    turnStartEntryId: "a1", turnEndEntryId: "a2", level: 4,
    summary: { entries: [], userIntent: intent, outcome },
  } as unknown as LedgerData);

  it("包含用户给定提示词正文（逐字）", () => {
    const p = buildBatchRecompressPrompt([mk("意图甲", "结果甲")]);
    expect(p).toContain("请对以下已经完成过一次摘要的内容做二次摘要。");
    expect(p).toContain("1. 剔除冗余细节（commit哈希、具体文件路径、零散函数名等），保留核心结论、关键变更、产出物、待办事项");
    expect(p).toContain("2. 按原有顺序梳理逻辑，不新增信息，不丢失主线节点");
    expect(p).toContain("3. 语言凝练，篇幅压缩到原文的1/2以内");
  });

  it("按 [#序号] 编号，逐条给出「意图：/结果：」", () => {
    const p = buildBatchRecompressPrompt([mk("意图甲", "结果甲"), mk("意图乙", "结果乙")]);
    expect(p).toContain("[#1]\n意图：意图甲\n结果：结果甲");
    expect(p).toContain("[#2]\n意图：意图乙\n结果：结果乙");
    expect(p).toContain("共 2 条");
  });

  it("JSON 契约含 index 与 description", () => {
    const p = buildBatchRecompressPrompt([mk("a", "b")]);
    expect(p).toContain('{"items": [{"index": number, "description": string}, ...]}');
  });

  it("不出现旧的字数硬上限与「条已合并」措辞", () => {
    const p = buildBatchRecompressPrompt([mk("a", "b")]);
    expect(p).not.toContain("≤25 字");
    expect(p).not.toContain("条已合并");
  });

  it("outcome 缺失时降级为空串而非 undefined", () => {
    const l = mk("只有意图", "");
    delete (l.summary as any).outcome;
    const p = buildBatchRecompressPrompt([l]);
    expect(p).toContain("意图：只有意图\n结果：");
    expect(p).not.toContain("undefined");
  });
});
