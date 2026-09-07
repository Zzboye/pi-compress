# Verbatim Ledger Quotes（用户原话 + 最终回复机械保留）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ledger 中用户输入与最终回复由模型转述（userIntent/outcome）改为机械逐字保留（截断 + recall 句柄），模型生成的自由文本字段归零。

**Architecture:** 三段式 ledger：用户原话（`extractUserMessage`，头 200 截断）+ 工具动作摘要（现有链路不变）+ 最终回复（`extractFinalReply`，头 800/尾 1200 截断）。摘要 prompt schema 缩为 groups-only，`parseLedgerOutput` 忽略模型仍输出的 userIntent/outcome，`renderActionLedger` 新格式优先、旧 ledger 回落 legacy 渲染。

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, 无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-07-verbatim-ledger-quotes-design.md`

## Global Constraints

- 截断常量：`USER_MESSAGE_HEAD_CHARS = 200`、`REPLY_HEAD_CHARS = 800`、`REPLY_TAIL_CHARS = 1200`，硬编码于 src/util.ts（不做配置化，沿用 TOOL_RESULT_* 常量风格）。
- 用户消息截断标记内嵌文本：`\n[... 已截断，后续 N 字符省略 ...]`；最终回复标记：`\n[... 中间省略 N 字符 ...]\n`（与 preTruncateToolResults 同构）。
- `userIntent`/`outcome` 在 `LedgerSummary` 中变为可选（legacy）；`parseLedgerOutput` 必填校验仅剩 `groups`，模型输出的 userIntent/outcome 一律忽略不存。
- 向后兼容：旧 ledger（会话文件中已存在）原样渲染 legacy 格式，不迁移；`store.ts` 的 `isValidLedger` 不改（只查 turnStartEntryId/turnEndEntryId/summary）。
- 不改动：窗口机制、forcepoint、recall 查找逻辑（src/recall.ts）、stripThinking、preTruncateToolResults、降级路径。
- 每个任务结束跑 `npx tsc --noEmit` 必须零错误。
- 测试命令统一 `npx vitest run <file>`；提交信息用中文 conventional commits。

---

### Task 1: LedgerQuote 类型 + 机械提取函数

**Files:**
- Modify: `src/ledger.ts`（LedgerQuote 接口；LedgerSummary 的 userIntent/outcome 可选化；LedgerData 增 userMessage?/finalReply?）
- Modify: `src/util.ts`（3 个常量 + extractUserMessage + extractFinalReply，置于 extractToolActions 之后）
- Create: `tests/util-extract.test.ts`

**Interfaces:**
- Consumes: 现有 `Turn`、`MessageEntry`（src/util.ts）、`joinedText`（util.ts 模块私有，同文件可直接用）。
- Produces:
  - `interface LedgerQuote { text: string; entryId: string; truncated: boolean }`（src/ledger.ts，export）
  - `extractUserMessage(turn: Turn): LedgerQuote | undefined`
  - `extractFinalReply(turn: Turn): LedgerQuote | undefined`
  - 后续任务依赖 `LedgerData.userMessage?: LedgerQuote` 与 `LedgerData.finalReply?: LedgerQuote` 字段名。

- [ ] **Step 1: Write the failing test**

创建 `tests/util-extract.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { extractUserMessage, extractFinalReply, type Turn, type MessageEntry } from "../src/util.js";
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
    expect(q).toEqual({ text: "修内存泄漏", entryId: "u1", truncated: false });
  });

  it("长消息：头 200 字符 + 省略标记", () => {
    const full = "开".repeat(100) + "中".repeat(300) + "尾".repeat(100);
    const q = extractUserMessage(turnOf(userEntry("u2", full)))!;
    expect(q.truncated).toBe(true);
    expect(q.text.startsWith("开".repeat(100))).toBe(true);
    expect(q.text).toContain("[... 已截断，后续 300 字符省略 ...]");
    expect(q.text).not.toContain("尾");
    expect(q.entryId).toBe("u2");
  });

  it("首条非 user 消息 → undefined", () => {
    expect(extractUserMessage(turnOf(assistantEntry("a1", [{ type: "text", text: "回答" }])))).toBeUndefined();
  });

  it("无 text 块 → undefined", () => {
    expect(extractUserMessage(turnOf({ id: "u3", message: { role: "user", content: [] } as AgentMessage }))).toBeUndefined();
  });

  it("多个 text 块 join", () => {
    const e: MessageEntry = { id: "u4", message: { role: "user", content: [
      { type: "text", text: "第一段" }, { type: "text", text: "第二段" },
    ] } as AgentMessage };
    expect(extractUserMessage(turnOf(e))!.text).toBe("第一段\n第二段");
  });
});

describe("extractFinalReply", () => {
  it("末条 assistant 含 thinking+text → 取 text（thinking 剥离）", () => {
    const t = turnOf(
      userEntry("u1", "问题"),
      assistantEntry("a1", [{ type: "thinking", thinking: "推理过程" }, { type: "text", text: "最终答复" }]),
    );
    expect(extractFinalReply(t)).toEqual({ text: "最终答复", entryId: "a1", truncated: false });
  });

  it("末条纯 thinking → 反向跳过取更早的 text", () => {
    const t = turnOf(
      userEntry("u1", "问题"),
      assistantEntry("a1", [{ type: "text", text: "早先回复" }]),
      assistantEntry("a2", [{ type: "thinking", thinking: "纯思考" }]),
    );
    expect(extractFinalReply(t)).toEqual({ text: "早先回复", entryId: "a1", truncated: false });
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

  it("超长回复：头 800 + 标记 + 尾 1200", () => {
    const body = "H>>>" + "x".repeat(3000) + "<<<T";
    const t = turnOf(userEntry("u1", "问题"), assistantEntry("a9", [{ type: "text", text: body }]));
    const q = extractFinalReply(t)!;
    expect(q.truncated).toBe(true);
    expect(q.text.startsWith("H>>>")).toBe(true);
    expect(q.text).toContain("[... 中间省略 1008 字符 ...]"); // 3008 - 2000
    expect(q.text.endsWith("<<<T")).toBe(true);
  });

  it("边界：恰好 2000 不截断，2001 截断", () => {
    const mk = (n: number) => turnOf(userEntry("u1", "问题"), assistantEntry("a1", [{ type: "text", text: "y".repeat(n) }]));
    expect(extractFinalReply(mk(2000))!.truncated).toBe(false);
    expect(extractFinalReply(mk(2001))!.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/util-extract.test.ts`
Expected: FAIL — `extractUserMessage`/`extractFinalReply` 不存在（import 报错）。

- [ ] **Step 3: Write minimal implementation**

`src/ledger.ts` 类型区（替换现有 LedgerSummary/LedgerData 两行，新增 LedgerQuote）：

```ts
/** 机械截断的逐字引用：text 已内嵌省略标记，entryId 供 recall 取回全文 */
export interface LedgerQuote { text: string; entryId: string; truncated: boolean }

export interface LedgerSummary { userIntent?: string; outcome?: string; groups: LedgerGroup[] }

export interface LedgerData {
  turnStartEntryId: string;
  turnEndEntryId: string;
  summary: LedgerSummary;
  userMessage?: LedgerQuote;  // 机械：用户原话（头 200 截断）
  finalReply?: LedgerQuote;   // 机械：最终回复（头 800/尾 1200 截断）
}
```

`src/util.ts` 顶部 import 增加：

```ts
import type { LedgerQuote } from "./ledger.js";
```

`src/util.ts` 文件末尾（extractToolActions 之后）追加：

```ts
const USER_MESSAGE_HEAD_CHARS = 200;
const REPLY_HEAD_CHARS = 800;
const REPLY_TAIL_CHARS = 1200;

/** turn 首条 user 消息逐字保留；意图在开头，仅头截断 */
export function extractUserMessage(turn: Turn): LedgerQuote | undefined {
  const first = turn.entries[0];
  if (!first || first.message.role !== "user") return undefined;
  const text = joinedText((first.message as any).content);
  if (text === "") return undefined;
  if (text.length <= USER_MESSAGE_HEAD_CHARS) return { text, entryId: first.id, truncated: false };
  const omitted = text.length - USER_MESSAGE_HEAD_CHARS;
  return {
    text: `${text.slice(0, USER_MESSAGE_HEAD_CHARS)}\n[... 已截断，后续 ${omitted} 字符省略 ...]`,
    entryId: first.id,
    truncated: true,
  };
}

/** turn 内最后一条含 text 的 assistant 消息逐字保留（跳过纯 thinking）；超长时头尾采样 */
export function extractFinalReply(turn: Turn): LedgerQuote | undefined {
  for (let i = turn.entries.length - 1; i >= 0; i--) {
    const e = turn.entries[i];
    if (e.message.role !== "assistant") continue;
    const text = joinedText((e.message as any).content); // 只取 text 块，thinking 天然排除
    if (text === "") continue; // 纯思考消息：继续向前找
    if (text.length <= REPLY_HEAD_CHARS + REPLY_TAIL_CHARS) return { text, entryId: e.id, truncated: false };
    const omitted = text.length - REPLY_HEAD_CHARS - REPLY_TAIL_CHARS;
    return {
      text: `${text.slice(0, REPLY_HEAD_CHARS)}\n[... 中间省略 ${omitted} 字符 ...]\n${text.slice(-REPLY_TAIL_CHARS)}`,
      entryId: e.id,
      truncated: true,
    };
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/util-extract.test.ts`
Expected: PASS（11 个用例全绿）。

- [ ] **Step 5: 类型检查 + 全量回归（类型可选化波及旧用例，须确认不破坏）**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错误；全部测试通过（旧 fixture 仍带 userIntent/outcome，可选化不破坏编译与断言；renderActionLedger 对 undefined userIntent 仅在 `?? ` 兜底落地前由旧 fixture 覆盖，Task 4 处理）。

- [ ] **Step 6: Commit**

```bash
git add src/ledger.ts src/util.ts tests/util-extract.test.ts
git commit -m "feat: LedgerQuote 类型 + extractUserMessage/extractFinalReply 机械提取"
```

---

### Task 2: parseLedgerOutput 放宽为 groups-only

**Files:**
- Modify: `src/ledger.ts`（parseLedgerOutput 的必填校验与返回值）
- Modify: `tests/prompts.test.ts`（parseLedgerOutput describe 块）

**Interfaces:**
- Consumes: Task 1 的 `LedgerSummary`（userIntent/outcome 已可选）。
- Produces: `parseLedgerOutput` 返回值不再含 userIntent/outcome（仅 `{ groups }`）；必填校验仅 `Array.isArray(parsed?.groups)`。

- [ ] **Step 1: Write the failing test**

`tests/prompts.test.ts` 的 `parseLedgerOutput` describe 块改为：

```ts
describe("parseLedgerOutput", () => {
  it("parses valid output and merges mechanical fields", () => {
    const raw = JSON.stringify({
      userIntent: "修复内存泄漏",
      outcome: "已修复",
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "清理函数缺失" }, { target: "npm test", detail: "通过", phase: "verify" }] }],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.userIntent).toBeUndefined();          // 模型输出的 userIntent 被忽略
    expect(s.outcome).toBeUndefined();             // 模型输出的 outcome 被忽略
    const read = s.groups[0].entries.find((e) => e.action === "read")!;
    expect(read.recallIds).toEqual(["e003"]);       // recallIds 来自机械清单
    expect(read.target).toBe("src/hooks.ts");        // target 来自机械清单
    expect(read.detail).toBe("清理函数缺失");        // detail 来自模型
  });

  it("accepts groups-only output（新 schema 无 userIntent/outcome）", () => {
    const raw = JSON.stringify({
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "清理函数缺失" }] }],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.groups[0].entries[0].detail).toBe("清理函数缺失");
  });

  it("throws LedgerParseError when groups missing", () => {
    expect(() => parseLedgerOutput(JSON.stringify({ userIntent: "u", outcome: "o" }), actions, turnText, true)).toThrow();
  });

  it("drops entries whose model detail contains a target-like path not in source (verbatim guard)", () => {
    const raw = JSON.stringify({
      userIntent: "u", outcome: "o",
      groups: [{ phase: "other", entries: [{ target: "src/hooks.ts", detail: "见 src/other.ts" }] }],
    });
    // src/other.ts 不在 turnText 中 → 该条目被剔除
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.groups[0].entries.length).toBe(0);
  });

  it("throws LedgerParseError on invalid JSON", () => {
    expect(() => parseLedgerOutput("not json", actions, turnText, true)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — groups-only 输出触发 "missing required fields"；`s.userIntent` 为 "修复内存泄漏" 而非 undefined。

- [ ] **Step 3: Write minimal implementation**

`src/ledger.ts` 中两处修改：

必填校验（原三字段校验）：

```ts
  if (!Array.isArray(parsed?.groups)) {
    throw new LedgerParseError("model output missing required fields");
  }
```

返回值（原 `return { userIntent: parsed.userIntent, outcome: parsed.outcome, groups };`）：

```ts
  return { groups }; // userIntent/outcome 由系统机械保存（Task 1），模型输出一律忽略
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（summarizer/integration/extension 的模型输出 fixture 仍带 userIntent/outcome —— 被忽略不报错；store/assembler fixture 是 LedgerData 直构，userIntent/outcome 仍合法存储）。

- [ ] **Step 6: Commit**

```bash
git add src/ledger.ts tests/prompts.test.ts
git commit -m "feat: parseLedgerOutput 放宽为 groups-only，忽略模型输出的意图/结果字段"
```

---

### Task 3: buildSummarizePrompt 缩减 schema

**Files:**
- Modify: `src/prompts.ts`
- Modify: `tests/prompts.test.ts`（buildSummarizePrompt describe 块）

**Interfaces:**
- Consumes: 无（纯文本变更）。
- Produces: prompt 不再要求 userIntent/outcome；新增说明"用户消息与最终回复由系统另行逐字保存"。

- [ ] **Step 1: Write the failing test**

`tests/prompts.test.ts` 的 buildSummarizePrompt 用例改为：

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — prompt 仍含 "userIntent"/"outcome"，不含 "另行逐字保存"。

- [ ] **Step 3: Write minimal implementation**

`src/prompts.ts` 规则 5 与 schema 行替换（其余不动）：

```ts
5. 用户消息与最终回复由系统另行逐字保存，无需你概括；只压缩工具动作
```

末行 schema 替换为：

```
{"groups": [{"phase": "investigate|fix|verify|discuss|other", "entries": [{"target": string（必须来自清单）, "detail": string, "phase": string（可选，用于覆盖分组）}]}]}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat: 摘要 prompt schema 缩为 groups-only，注明意图/结果由系统机械保存"
```

---

### Task 4: renderActionLedger 双格式渲染

**Files:**
- Modify: `src/ledger.ts`（renderActionLedger 的 turn 头/尾渲染）
- Modify: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LedgerQuote` 与 `LedgerData.userMessage/finalReply`。
- Produces: 渲染格式——
  - 新头：`### T{n} · 用户：「{text}」`（截断时尾附 ` ↩{entryId}`；渲染时 `\n+` 折叠为空格，存储文本不动）
  - legacy 头：`### T{n} · 用户意图：{userIntent ?? "（未知）"}`
  - 新尾：`最终回复（原文）：\n{text}`（截断时追加行 `（已截断，↩{entryId} 取回全文）`）
  - legacy 尾：`- 结果：{outcome}`（仅当 outcome !== undefined）

- [ ] **Step 1: Write the failing test**

`tests/ledger.test.ts` 追加（sample 及现有用例不动）：

```ts
describe("renderActionLedger 双格式", () => {
  const modern: LedgerData = {
    turnStartEntryId: "e001",
    turnEndEntryId: "e018",
    summary: { groups: [] },
    userMessage: { text: "这次对话怎么没有启动摘要？", entryId: "e001", truncated: false },
    finalReply: { text: "插件正常，成功路径完全静默。", entryId: "e018", truncated: false },
  };

  function renderText(l: LedgerData[]): string {
    const msg = renderActionLedger(l);
    return ((msg as any).content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
  }

  it("新格式：用户原话 + 最终回复原文", () => {
    const text = renderText([modern]);
    expect(text).toContain("T1 · 用户：「这次对话怎么没有启动摘要？」");
    expect(text).toContain("最终回复（原文）：");
    expect(text).toContain("插件正常，成功路径完全静默。");
    expect(text).not.toContain("用户意图：");
    expect(text).not.toContain("结果：");
  });

  it("截断时附 recall 句柄", () => {
    const l: LedgerData = {
      ...modern,
      userMessage: { text: "前两百字符…\n[... 已截断，后续 3000 字符省略 ...]", entryId: "e001", truncated: true },
      finalReply: { text: "开头…\n[... 中间省略 5000 字符 ...]\n…结尾", entryId: "e018", truncated: true },
    };
    const text = renderText([l]);
    expect(text).toContain("T1 · 用户：「前两百字符…[... 已截断，后续 3000 字符省略 ...]」 ↩e001"); // \n 折叠为空格
    expect(text).toContain("（已截断，↩e018 取回全文）");
  });

  it("混合：有用户原话无最终回复 → 无结果行", () => {
    const text = renderText([{ ...modern, finalReply: undefined }]);
    expect(text).toContain("T1 · 用户：「");
    expect(text).not.toContain("最终回复");
    expect(text).not.toContain("结果：");
  });

  it("旧格式回落：userIntent/outcome 照旧渲染", () => {
    const text = renderText([sample]); // 现有 legacy fixture
    expect(text).toContain("T1 · 用户意图：修复内存泄漏");
    expect(text).toContain("- 结果：hooks.ts:34 清理函数缺失，已修复");
    expect(text).not.toContain("最终回复");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL — 新格式用例（用户：「 / 最终回复）不存在该渲染。

- [ ] **Step 3: Write minimal implementation**

`src/ledger.ts` renderActionLedger 的 turn 循环体替换为：

```ts
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    if (l.userMessage) {
      const recall = l.userMessage.truncated ? ` ↩${l.userMessage.entryId}` : "";
      lines.push(`### T${i + 1} · 用户：「${l.userMessage.text.replace(/\n+/g, " ")}」${recall}`);
    } else {
      lines.push(`### T${i + 1} · 用户意图：${l.summary.userIntent ?? "（未知）"}`);
    }
    for (const g of l.summary.groups) {
      for (const e of g.entries) {
        const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
        lines.push(`- ${PHASE_LABEL[g.phase]}：${e.action} ${e.target} → ${e.detail}${recall}`);
      }
    }
    if (l.finalReply) {
      lines.push("最终回复（原文）：");
      lines.push(l.finalReply.text);
      if (l.finalReply.truncated) lines.push(`（已截断，↩${l.finalReply.entryId} 取回全文）`);
    } else if (l.summary.outcome !== undefined) {
      lines.push(`- 结果：${l.summary.outcome}`);
    }
    lines.push("");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS（新旧用例全绿）。

- [ ] **Step 5: 全量回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（assembler.test.ts 的 ledgerFor fixture 是 legacy 直构 → 回落渲染，`- 结果：完成了` 不再断言于测试则无影响；若有断言 `结果：` 的用例失败，确认 fixture 属 legacy 即符合预期，不改实现）。

- [ ] **Step 6: Commit**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: renderActionLedger 双格式——用户原话/最终回复逐字渲染，旧 ledger 回落 legacy"
```

---

### Task 5: SummarizerEngine 装配机械字段

**Files:**
- Modify: `src/summarizer.ts`（summarize 闭包）
- Modify: `tests/summarizer.test.ts`（turnFixture 输出 + onLedger 断言）
- Modify: `tests/integration.test.ts`（模型输出 groups-only + 头部断言）

**Interfaces:**
- Consumes: Task 1 的 `extractUserMessage`/`extractFinalReply`。
- Produces: `onLedger` 回调的 LedgerData 含 `userMessage?`/`finalReply?`（turn 无对应消息时为 undefined，仍照常落盘）。

- [ ] **Step 1: Write the failing test**

`tests/summarizer.test.ts` 的 `turnFixture` 中 `validOutput` 改为 groups-only（模型输出不再带意图/结果）：

```ts
    validOutput: JSON.stringify({
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "发现清理函数缺失" }] }],
    }),
```

`SummarizerEngine` describe 的第一个用例增加机械字段断言：

```ts
    expect(onLedger.mock.calls[0][0]).toMatchObject({ turnStartEntryId: "u1" });
    expect(onLedger.mock.calls[0][0]).toMatchObject({
      userMessage: { text: "修内存泄漏", entryId: "u1", truncated: false },
      finalReply: { text: "修好了", entryId: "t2", truncated: false },
    });
```

（fixture 的 turn 末条 assistant 为 `t2`，text "修好了"；首条 user 为 `u1`，text "修内存泄漏"。）

`tests/integration.test.ts` 第一个用例中 `validOutput` 同样改为 groups-only，并在 `head` 断言区追加：

```ts
    expect(head).toContain("用户：「");                    // 用户原话进入 ledger 头
    expect(head).toContain("已截断，后续");                 // 4000 字符用户消息被头截断
    expect(head).toContain("最终回复（原文）：");
    expect(head).toContain("看完了文件");                  // 最终回复逐字出现
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summarizer.test.ts tests/integration.test.ts`
Expected: FAIL — onLedger payload 无 userMessage/finalReply；integration head 无用户原话/最终回复渲染。

- [ ] **Step 3: Write minimal implementation**

`src/summarizer.ts` summarize 闭包替换为：

```ts
    const summarize = async (backend: SummarizerBackend): Promise<void> => {
      const actions = extractToolActions(turn);
      const userMessage = extractUserMessage(turn);   // 机械提取，不依赖后端，无需重试语义
      const finalReply = extractFinalReply(turn);
      const turnText = serializeTurn(turn);
      const prompt = buildSummarizePrompt(turnText, actions);
      const raw = await backend.complete(prompt);
      const summary = parseLedgerOutput(raw, actions, turnText, this.config.verbatimCheck);
      this.onLedger({
        turnStartEntryId: turn.startEntryId,
        turnEndEntryId: turn.endEntryId,
        summary,
        userMessage,
        finalReply,
      });
      this.enqueued.delete(turn.startEntryId); // 完成，允许后续新 turn 同名场景入队（防御）
    };
```

`src/summarizer.ts` 顶部 import 改为：

```ts
import { serializeTurn, extractToolActions, extractUserMessage, extractFinalReply, type Turn } from "./util.js";
```

（validOutput 的 groups-only 改动已在 Step 1 落盘，本步只改 src/summarizer.ts。）

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/summarizer.test.ts tests/integration.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（extension.test.ts 的模型输出仍带 userIntent/outcome → 被忽略，断言"已摘要 turn 数：1"不受影响；backfill.test.ts 直构 LedgerData，不受影响）。

- [ ] **Step 6: Commit**

```bash
git add src/summarizer.ts tests/summarizer.test.ts tests/integration.test.ts
git commit -m "feat: 引擎装配机械字段——onLedger 载荷携带用户原话与最终回复逐字引用"
```

---

### Task 6: recall 描述更新 + README + 全量回归

**Files:**
- Modify: `src/index.ts:151`（recall 工具 description）
- Modify: `README.md`（架构图两行 + 核心思想段）

**Interfaces:**
- Consumes: 无。
- Produces: 文档与工具描述与新行为一致。

- [ ] **Step 1: 更新 recall description**

`src/index.ts` 中：

```ts
    description: "取回动作日志条目的逐字原文（含截断的用户消息/最终回复全文）。参数为动作日志中 ↩ 标记后的 entry ID 列表（可批量）。",
```

- [ ] **Step 2: 更新 README**

架构图中这一行：

```
   ┌─────────────── 窗外旧 turn → 动作日志头（结论 + ↩ID，细节已压缩）
```

改为：

```
   ┌─────────────── 窗外旧 turn → 动作日志头（用户原话 + 工具动作 + 最终回复原文，细节 ↩ID 可召回）
```

"核心思想"段落（`思考内容直接丢弃（过程噪声），工具调用的 target/路径逐字保留。`）后追加一句：

```
用户原话与最终回复由系统机械逐字保留（截断时附 ↩ 句柄），不经摘要模型转述——ledger 中模型生成的自由文本字段为零。
```

- [ ] **Step 3: 全量回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs: recall 描述与 README 同步逐字引用机制"
```
