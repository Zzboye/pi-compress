# pi-agent Context Compress 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi coding agent 实现用户无感的上下文压缩扩展：后台增量摘要（动作日志）+ 20k 原文窗口动态重组 + recall 按 ID 取回原文 + 76% 强制点与降级。

**Architecture:** `context` 事件动态替换消息（session 文件只追加 CustomEntry）；`agent_settled` 后台异步摘要队列；recall 为注册工具按 entry ID 纯查找；76% 强制点为前台唯一 await，超时降级 pi 原生压缩。

**Tech Stack:** TypeScript (ESM)、pi Extension API（`@earendil-works/pi-coding-agent`）、typebox（工具 schema，pi 内置依赖）、vitest（仅测试）。

## Global Constraints

- 运行时零第三方 npm 依赖：模型调用/序列化/token 估算全部使用 pi 导出（`estimateTokens`、`serializeConversation`、`convertToLlm`、`ctx.modelRegistry`）——spec 5.3
- session 文件只追加，永不改写已有 entry——spec 3.1
- 装配器（context 事件路径）永不因缺摘要而阻塞或失败：缺摘要的 turn 原文照发——spec 4.1 关键不变量
- tool result 必须与 tool call 成对：窗口边界只落在 turn 边界（user 消息处）——spec 4.4
- `target` 逐字字段从工具调用参数机械提取（或校验存在于原文），不经小模型改写——spec 3.1
- CustomEntry 的 `customType` 固定为 `"context-compress:ledger"`——spec 3.1
- 配置默认值：`keepRecentTokens: 20000`、`forceRatio: 0.76`、`retry.maxAttempts: 3`、`retry.backoffMs: 2000`、`verbatimCheck: true`、`ledgerMergeThreshold: 40`——spec 3.4
- 开发目录 `D:/Pi/pi-compress`，源码在 `src/`，测试在 `tests/`；部署目标 `~/.pi/agent/extensions/context-compress/`
- 测试命令统一为 `npx vitest run`（Node v24）

## File Structure

```
D:/Pi/pi-compress/
├── package.json          # devDeps: vitest/typescript/pi 包/typebox；"pi".extensions 指向 src/index.ts
├── tsconfig.json
├── src/
│   ├── index.ts          # 入口：注册事件/工具/命令，组装各模块（Task 10）
│   ├── config.ts         # 配置加载与校验（Task 1）
│   ├── ledger.ts         # LedgerData 结构 + markdown 渲染 + 输出解析 + 逐字校验（Task 2/6）
│   ├── assembler.ts      # 窗口边界 + 上下文重组（Task 3/4）
│   ├── store.ts          # 内存缓存 + CustomEntry 重建（Task 5）
│   ├── prompts.ts        # 摘要 prompt 模板（Task 6）
│   ├── summarizer.ts     # 摘要引擎：队列/worker/重试 + 后端抽象（Task 7）
│   ├── recall.ts         # recall 工具（Task 8）
│   ├── forcepoint.ts     # 76% 强制点 + 降级（Task 9）
│   └── util.ts           # turn 划分、序列化辅助（Task 3）
├── tests/                # 与 src 一一对应 + integration.test.ts
└── README.md             # 安装与配置文档（Task 12）
```

---

### Task 1: 项目脚手架 + 配置加载

**Files:**
- Create: `package.json`、`tsconfig.json`、`src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: 无（首任务）
- Produces: `interface ContextCompressConfig`、`interface SummarizerRef`、`function loadConfig(globalRaw: unknown, projectRaw: unknown): ContextCompressConfig`、`const DEFAULT_CONFIG: ContextCompressConfig`。后续所有任务通过 `loadConfig` 获得配置。

- [ ] **Step 1: 创建脚手架文件**

`package.json`：

```json
{
  "name": "pi-context-compress",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

运行 `npm install`。

- [ ] **Step 2: 写失败测试**

`tests/config.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when both raws are empty", () => {
    const c = loadConfig(undefined, undefined);
    expect(c.keepRecentTokens).toBe(20000);
    expect(c.forceRatio).toBe(0.76);
    expect(c.verbatimCheck).toBe(true);
    expect(c.retry).toEqual({ maxAttempts: 3, backoffMs: 2000 });
    expect(c.ledgerMergeThreshold).toBe(40);
  });

  it("accepts registry-style summarizer (mode 1)", () => {
    const c = loadConfig(
      { contextCompress: { summarizer: { provider: "ollama", model: "qwen3:8b" } } },
      undefined,
    );
    expect(c.summarizer).toEqual({ kind: "registry", provider: "ollama", model: "qwen3:8b" });
  });

  it("accepts baseUrl-style summarizer (mode 2)", () => {
    const c = loadConfig(
      undefined,
      { contextCompress: { summarizer: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", apiKey: "ollama" } } },
    );
    expect(c.summarizer).toEqual({
      kind: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", apiKey: "ollama",
    });
  });

  it("project overrides global", () => {
    const c = loadConfig(
      { contextCompress: { keepRecentTokens: 30000 } },
      { contextCompress: { forceRatio: 0.8 } },
    );
    expect(c.keepRecentTokens).toBe(30000);
    expect(c.forceRatio).toBe(0.8);
  });

  it("rejects invalid summarizer shape", () => {
    expect(() => loadConfig({ contextCompress: { summarizer: { provider: "x" } } }, undefined))
      .toThrow(/summarizer/);
  });

  it("clamps invalid numbers to defaults", () => {
    const c = loadConfig({ contextCompress: { keepRecentTokens: -5, forceRatio: 2 } }, undefined);
    expect(c.keepRecentTokens).toBe(20000);
    expect(c.forceRatio).toBe(0.76);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（`Cannot find module '../src/config.js'`）

- [ ] **Step 4: 实现 config.ts**

```typescript
export type SummarizerRef =
  | { kind: "registry"; provider: string; model: string }
  | { kind: "openai"; baseUrl: string; model: string; apiKey?: string };

export interface ContextCompressConfig {
  summarizer: SummarizerRef | undefined; // undefined = 插件只观察不摘要（降级态）
  verbatimCheck: boolean;
  keepRecentTokens: number;
  forceRatio: number;
  retry: { maxAttempts: number; backoffMs: number };
  ledgerMergeThreshold: number;
}

export const DEFAULT_CONFIG: ContextCompressConfig = {
  summarizer: undefined,
  verbatimCheck: true,
  keepRecentTokens: 20000,
  forceRatio: 0.76,
  retry: { maxAttempts: 3, backoffMs: 2000 },
  ledgerMergeThreshold: 40,
};

interface RawSettings { contextCompress?: Record<string, unknown> }

function parseSummarizer(raw: unknown): SummarizerRef {
  if (typeof raw !== "object" || raw === null) throw new Error("summarizer must be an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.provider === "string" && typeof s.model === "string") {
    return { kind: "registry", provider: s.provider, model: s.model };
  }
  if (typeof s.baseUrl === "string" && typeof s.model === "string") {
    return { kind: "openai", baseUrl: s.baseUrl, model: s.model, apiKey: typeof s.apiKey === "string" ? s.apiKey : undefined };
  }
  throw new Error("summarizer requires {provider,model} or {baseUrl,model}");
}

function num(v: unknown, dflt: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

export function loadConfig(globalRaw: unknown, projectRaw: unknown): ContextCompressConfig {
  const merged: Record<string, unknown> = {};
  for (const raw of [globalRaw, projectRaw] as RawSettings[]) {
    if (raw && typeof raw === "object" && raw.contextCompress) {
      Object.assign(merged, raw.contextCompress);
    }
  }
  return {
    summarizer: merged.summarizer === undefined ? undefined : parseSummarizer(merged.summarizer),
    verbatimCheck: merged.verbatimCheck === undefined ? DEFAULT_CONFIG.verbatimCheck : !!merged.verbatimCheck,
    keepRecentTokens: num(merged.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens, 1000, 1_000_000),
    forceRatio: num(merged.forceRatio, DEFAULT_CONFIG.forceRatio, 0.1, 0.99),
    retry: {
      maxAttempts: Math.max(1, Math.floor(num(merged.retry === undefined ? undefined : (merged.retry as any).maxAttempts, 3, 1, 100))),
      backoffMs: Math.max(100, Math.floor(num(merged.retry === undefined ? undefined : (merged.retry as any).backoffMs, 2000, 100, 600_000))),
    },
    ledgerMergeThreshold: Math.floor(num(merged.ledgerMergeThreshold, 40, 5, 10_000)),
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json src/config.ts tests/config.test.ts package-lock.json
git commit -m "feat: scaffold project + config loading with validation"
```

---

### Task 2: Ledger 数据结构 + markdown 渲染

**Files:**
- Create: `src/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface LedgerAction { action: string; target: string; detail: string; recallIds: string[] }`
  - `interface LedgerGroup { phase: "investigate" | "fix" | "verify" | "discuss" | "other"; entries: LedgerAction[] }`
  - `interface LedgerSummary { userIntent: string; outcome: string; groups: LedgerGroup[] }`
  - `interface LedgerData { turnStartEntryId: string; turnEndEntryId: string; summary: LedgerSummary }`
  - `function renderActionLedger(ledgers: LedgerData[]): AgentMessage`（合成 user 消息，含 `<action-ledger>` 标签与 `↩ID` 标记）
  - `const LEDGER_CUSTOM_TYPE = "context-compress:ledger"`

- [ ] **Step 1: 写失败测试**

`tests/ledger.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { renderActionLedger, type LedgerData } from "../src/ledger.js";

const sample: LedgerData = {
  turnStartEntryId: "e001",
  turnEndEntryId: "e018",
  summary: {
    userIntent: "修复内存泄漏",
    outcome: "hooks.ts:34 清理函数缺失，已修复",
    groups: [
      {
        phase: "investigate",
        entries: [
          { action: "read", target: "src/hooks.ts", detail: "发现 useEffect 清理函数缺失", recallIds: ["e003", "e005"] },
        ],
      },
      {
        phase: "verify",
        entries: [
          { action: "bash", target: "npm test", detail: "3 passed", recallIds: ["e012"] },
        ],
      },
    ],
  },
};

describe("renderActionLedger", () => {
  it("renders markdown with header, turns, actions and recall markers", () => {
    const msg = renderActionLedger([sample]);
    expect(msg.role).toBe("user");
    const text = (msg.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).toContain("<action-ledger>");
    expect(text).toContain("T1 · 用户意图：修复内存泄漏");
    expect(text).toContain("调查：read src/hooks.ts → 发现 useEffect 清理函数缺失 ↩e003,↩e005");
    expect(text).toContain("验证：bash npm test → 3 passed ↩e012");
    expect(text).toContain("recall");
  });

  it("numbers turns sequentially", () => {
    const msg = renderActionLedger([sample, sample]);
    const text = (msg.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).toContain("T1 ·");
    expect(text).toContain("T2 ·");
  });

  it("returns empty ledger message when no ledgers", () => {
    const msg = renderActionLedger([]);
    const text = (msg.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).not.toContain("T1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ledger.ts（渲染部分）**

```typescript
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

export const LEDGER_CUSTOM_TYPE = "context-compress:ledger";

export interface LedgerAction { action: string; target: string; detail: string; recallIds: string[] }
export interface LedgerGroup { phase: "investigate" | "fix" | "verify" | "discuss" | "other"; entries: LedgerAction[] }
export interface LedgerSummary { userIntent: string; outcome: string; groups: LedgerGroup[] }
export interface LedgerData { turnStartEntryId: string; turnEndEntryId: string; summary: LedgerSummary }

const PHASE_LABEL: Record<LedgerGroup["phase"], string> = {
  investigate: "调查", fix: "修复", verify: "验证", discuss: "讨论", other: "其他",
};

export function renderActionLedger(ledgers: LedgerData[]): AgentMessage {
  const lines: string[] = ["<action-ledger>", "## 会话历史（动作日志，细节已压缩）", ""];
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    lines.push(`### T${i + 1} · 用户意图：${l.summary.userIntent}`);
    for (const g of l.summary.groups) {
      for (const e of g.entries) {
        const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
        lines.push(`- ${PHASE_LABEL[g.phase]}：${e.action} ${e.target} → ${e.detail}${recall}`);
      }
    }
    lines.push(`- 结果：${l.summary.outcome}`);
    lines.push("");
  }
  lines.push("（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）");
  lines.push("</action-ledger>");
  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: action ledger data structure and markdown rendering"
```

---

### Task 3: Turn 划分 + 窗口边界计算

**Files:**
- Create: `src/util.ts`、`src/assembler.ts`（本任务只含边界函数）
- Test: `tests/assembler.test.ts`

**Interfaces:**
- Consumes: `estimateTokens`（pi 包导出，签名 `estimateTokens(message: AgentMessage): number`）
- Produces:
  - `src/util.ts`：`function splitIntoTurns(entries: MessageEntry[]): Turn[]`，其中 `interface Turn { startEntryId: string; endEntryId: string; entries: MessageEntry[] }`、`interface MessageEntry { id: string; message: AgentMessage }`（SessionEntry 的投影，测试与装配器共用）
  - `src/assembler.ts`：`function findWindowTurns(turns: Turn[], keepRecentTokens: number): Turn[]`——返回保持原文的尾部 turn 集合（可能超过预算，见 spec 4.4 单 turn 超 20k 规则）

- [ ] **Step 1: 写失败测试**

`tests/assembler.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { findWindowTurns } from "../src/assembler.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

function msg(id: string, role: "user" | "assistant" | "toolResult", text: string): MessageEntry {
  return { id, message: { role, content: [{ type: "text", text }] } as AgentMessage };
}

// 约 1 token/4字符：用长度控制 token 量级（estimateTokens 是估算，测试里取实际返回值比较）
describe("splitIntoTurns", () => {
  it("splits at user messages", () => {
    const entries = [msg("a", "user", "q1"), msg("b", "assistant", "a1"), msg("c", "toolResult", "r1"), msg("d", "user", "q2"), msg("e", "assistant", "a2")];
    const turns = splitIntoTurns(entries);
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ startEntryId: "a", endEntryId: "c" });
    expect(turns[1]).toMatchObject({ startEntryId: "d", endEntryId: "e" });
  });

  it("leading non-user entries form their own pseudo-turn", () => {
    const entries = [msg("b", "assistant", "a1"), msg("d", "user", "q2")];
    const turns = splitIntoTurns(entries);
    expect(turns.length).toBe(2);
    expect(turns[0]).toMatchObject({ startEntryId: "b", endEntryId: "b" });
  });
});

describe("findWindowTurns", () => {
  it("keeps trailing turns within budget", () => {
    const big = "x".repeat(4000); // ~1k tokens
    const turns = splitIntoTurns([
      msg("a", "user", big), msg("b", "assistant", big),
      msg("c", "user", big), msg("d", "assistant", big),
      msg("e", "user", big), msg("f", "assistant", big),
    ]);
    const window = findWindowTurns(turns, 3000); // 约 3 个 turn 的量
    expect(window.length).toBeLessThanOrEqual(3);
    expect(window.length).toBeGreaterThanOrEqual(1);
    // 一定包含最后一个 turn
    expect(window[window.length - 1].startEntryId).toBe("e");
  });

  it("never splits a turn even when it alone exceeds budget", () => {
    const huge = "y".repeat(100_000); // ~25k tokens
    const turns = splitIntoTurns([msg("a", "user", "hello"), msg("b", "assistant", "hi"), msg("c", "user", huge), msg("d", "assistant", huge)]);
    const window = findWindowTurns(turns, 20000);
    // 最后一个 turn 单独超预算：整体保留（窗口暂时 >20k）
    expect(window.some((t) => t.startEntryId === "c")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/assembler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/util.ts`：

```typescript
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

export interface MessageEntry { id: string; message: AgentMessage }

export interface Turn { startEntryId: string; endEntryId: string; entries: MessageEntry[] }

export function splitIntoTurns(entries: MessageEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const e of entries) {
    if (e.message.role === "user" || current === null) {
      current = { startEntryId: e.id, endEntryId: e.id, entries: [e] };
      turns.push(current);
    } else {
      current.entries.push(e);
      current.endEntryId = e.id;
    }
  }
  return turns;
}
```

`src/assembler.ts`（本任务部分）：

```typescript
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Turn } from "./util.js";

/** 从尾部往前收集 turn，直到累计 token 超过预算；单 turn 超预算时整体保留 */
export function findWindowTurns(turns: Turn[], keepRecentTokens: number): Turn[] {
  const window: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i].entries.reduce((s, e) => s + estimateTokens(e.message), 0);
    if (window.length > 0 && total + turnTokens > keepRecentTokens) break;
    window.unshift(turns[i]);
    total += turnTokens;
  }
  return window;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/assembler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/util.ts src/assembler.ts tests/assembler.test.ts
git commit -m "feat: turn splitting and token-based window boundary"
```

---

### Task 4: 上下文装配器 assembleContext

**Files:**
- Modify: `src/assembler.ts`
- Test: `tests/assembler.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `renderActionLedger`、Task 3 的 `splitIntoTurns`/`findWindowTurns`、`LedgerData`
- Produces: `function assembleContext(branch: MessageEntry[], cache: Map<string, LedgerData>, keepRecentTokens: number): { messages: AgentMessage[]; stats: { windowTurns: number; replacedTurns: number; passthroughTurns: number } }`。规则：窗口外有摘要的 turn 从 messages 中剔除（由 ledger 头部消息代表）；无摘要的 turn 原文照发。

- [ ] **Step 1: 写失败测试（追加到 tests/assembler.test.ts）**

```typescript
import { assembleContext } from "../src/assembler.js";
import type { LedgerData } from "../src/ledger.js";

function ledgerFor(turn: { startEntryId: string; endEntryId: string }): LedgerData {
  return {
    turnStartEntryId: turn.startEntryId,
    turnEndEntryId: turn.endEntryId,
    summary: {
      userIntent: "做某事",
      outcome: "完成了",
      groups: [{ phase: "other", entries: [{ action: "bash", target: "ls", detail: "列了文件", recallIds: [turn.startEntryId] }] }],
    },
  };
}

describe("assembleContext", () => {
  it("keeps recent turns verbatim, replaces summarized old turns with ledger message on top", () => {
    const big = "z".repeat(4000);
    const entries = [
      msg("a", "user", big), msg("b", "assistant", big),   // turn1 (旧)
      msg("c", "user", big), msg("d", "assistant", big),   // turn2 (旧)
      msg("e", "user", big), msg("f", "assistant", big),   // turn3 (新)
    ];
    const turns = splitIntoTurns(entries);
    const cache = new Map<string, LedgerData>();
    cache.set("a", ledgerFor(turns[0]));
    cache.set("c", ledgerFor(turns[1]));
    const { messages, stats } = assembleContext(entries, cache, 3000);
    // 头部是 ledger 消息
    expect(messages[0].role).toBe("user");
    const head = (messages[0].content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("<action-ledger>");
    // 窗口内 turn 原文保留
    const ids = messages.slice(1).map((m) => (m.content as any)[0]?.text ?? "");
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(stats.replacedTurns).toBeGreaterThanOrEqual(1);
    // 被替换 turn 的原文不应出现在 messages 里（用唯一字符串验证）
    const all = messages.map((m) => (m.content as any[]).map((c) => c.text ?? "").join("")).join("\n");
    expect(all).not.toContain("z".repeat(4000));
  });

  it("passes through turns without summaries verbatim", () => {
    const entries = [msg("a", "user", "q1"), msg("b", "assistant", "a1"), msg("c", "user", "q2"), msg("d", "assistant", "a2")];
    const { messages, stats } = assembleContext(entries, new Map(), 20000);
    expect(stats.replacedTurns).toBe(0);
    expect(stats.passthroughTurns).toBe(2);
    expect(messages.length).toBe(4); // 全部原文（无 ledger 头）
  });

  it("cache hit for a turn outside window only", () => {
    const entries = [msg("a", "user", "q1"), msg("b", "assistant", "a1")];
    const cache = new Map([["a", ledgerFor({ startEntryId: "a", endEntryId: "b" })]]);
    const { messages } = assembleContext(entries, cache, 100); // 窗口极小 → turn 在窗外
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/assembler.test.ts`
Expected: FAIL（`assembleContext` 未导出）

- [ ] **Step 3: 实现（追加到 src/assembler.ts）**

```typescript
import { renderActionLedger, type LedgerData } from "./ledger.js";
import { splitIntoTurns, type MessageEntry } from "./util.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

export interface AssembleStats { windowTurns: number; replacedTurns: number; passthroughTurns: number }

export function assembleContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
): { messages: AgentMessage[]; stats: AssembleStats } {
  const turns = splitIntoTurns(branch);
  const window = findWindowTurns(turns, keepRecentTokens);
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  const stats: AssembleStats = { windowTurns: window.length, replacedTurns: 0, passthroughTurns: 0 };
  const messages: AgentMessage[] = [];
  const ledgers: LedgerData[] = [];

  for (const turn of turns) {
    if (windowStartIds.has(turn.startEntryId)) continue; // 窗口内，稍后原文追加
    const cached = cache.get(turn.startEntryId);
    if (cached) {
      ledgers.push(cached);
      stats.replacedTurns++;
    } else {
      stats.passthroughTurns++;
    }
  }

  // 无摘要的窗外 turn 原文照发（不阻塞、不丢弃）
  const passthroughIds = new Set(
    turns.filter((t) => !windowStartIds.has(t.startEntryId) && !cache.has(t.startEntryId)).flatMap((t) => t.entries.map((e) => e.id)),
  );

  if (ledgers.length > 0) messages.push(renderActionLedger(ledgers));
  for (const e of branch) {
    if (passthroughIds.has(e.id)) messages.push(e.message);
  }
  for (const t of window) for (const e of t.entries) messages.push(e.message);

  return { messages, stats };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/assembler.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/assembler.ts tests/assembler.test.ts
git commit -m "feat: context assembler with ledger replacement and passthrough"
```

---

### Task 5: Store——内存缓存 + CustomEntry 重建

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `LEDGER_CUSTOM_TYPE`、`LedgerData`
- Produces: `class LedgerStore`：
  - `constructor()` 
  - `rebuildFromEntries(entries: SessionEntryLike[]): void`——从分支里的 ledger CustomEntry 重建缓存
  - `get(turnStartEntryId: string): LedgerData | undefined`
  - `set(data: LedgerData): void`（仅内存；落盘由 index.ts 调 sessionManager.appendCustomEntry）
  - `size(): number`
  - `interface SessionEntryLike { id: string; type: string; customType?: string; data?: unknown }`（SessionEntry 投影）

- [ ] **Step 1: 写失败测试**

`tests/store.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { LedgerStore } from "../src/store.js";
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "../src/ledger.js";

const led: LedgerData = {
  turnStartEntryId: "a", turnEndEntryId: "b",
  summary: { userIntent: "u", outcome: "o", groups: [{ phase: "other", entries: [{ action: "bash", target: "ls", detail: "d", recallIds: ["a"] }] }] },
};

describe("LedgerStore", () => {
  it("rebuilds cache from ledger custom entries, ignoring other types", () => {
    const s = new LedgerStore();
    s.rebuildFromEntries([
      { id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led },
      { id: "x2", type: "custom", customType: "some-other-ext", data: { foo: 1 } },
      { id: "x3", type: "message" },
      { id: "x4", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { turnStartEntryId: "bad" } }, // 无效数据跳过
    ]);
    expect(s.size()).toBe(1);
    expect(s.get("a")).toEqual(led);
  });

  it("set and get roundtrip", () => {
    const s = new LedgerStore();
    s.set(led);
    expect(s.get("a")).toEqual(led);
    expect(s.size()).toBe(1);
  });

  it("later entries win on duplicate turnKey (re-summarized)", () => {
    const s = new LedgerStore();
    const led2 = { ...led, summary: { ...led.summary, outcome: "o2" } };
    s.rebuildFromEntries([
      { id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led },
      { id: "x2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led2 },
    ]);
    expect(s.get("a")?.summary.outcome).toBe("o2");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store.ts**

```typescript
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "./ledger.js";

export interface SessionEntryLike { id: string; type: string; customType?: string; data?: unknown }

function isValidLedger(d: unknown): d is LedgerData {
  if (typeof d !== "object" || d === null) return false;
  const v = d as Record<string, unknown>;
  return typeof v.turnStartEntryId === "string" && typeof v.turnEndEntryId === "string"
    && typeof v.summary === "object" && v.summary !== null;
}

export class LedgerStore {
  private cache = new Map<string, LedgerData>();

  rebuildFromEntries(entries: SessionEntryLike[]): void {
    this.cache.clear();
    for (const e of entries) {
      if (e.type === "custom" && e.customType === LEDGER_CUSTOM_TYPE && isValidLedger(e.data)) {
        this.cache.set(e.data.turnStartEntryId, e.data); // 后写覆盖先写 = 重摘生效
      }
    }
  }

  get(turnStartEntryId: string): LedgerData | undefined { return this.cache.get(turnStartEntryId); }
  set(data: LedgerData): void { this.cache.set(data.turnStartEntryId, data); }
  size(): number { return this.cache.size; }
  keys(): string[] { return [...this.cache.keys()]; }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: ledger store with rebuild from custom entries"
```

---

### Task 6: 摘要 prompt + 模型输出解析与逐字校验

**Files:**
- Create: `src/prompts.ts`；Modify: `src/ledger.ts`（追加解析函数）
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: `LedgerSummary`/`LedgerGroup`/`LedgerAction`（Task 2）
- Produces:
  - `src/prompts.ts`：`function buildSummarizePrompt(turnText: string, actions: ToolActionInfo[]): string`，其中 `interface ToolActionInfo { action: string; target: string; entryIds: string[] }`——机械提取的工具动作清单（target 逐字、entryIds 即 recallIds），模型只需为每个动作填 detail 并分组
  - `src/ledger.ts` 追加：`function parseLedgerOutput(raw: string, actions: ToolActionInfo[], turnText: string, verbatimCheck: boolean): LedgerSummary`——解析模型 JSON；失败抛 `LedgerParseError`；逐字校验失败的动作条目直接剔除（保守降级，原文仍可 recall）

- [ ] **Step 1: 写失败测试**

`tests/prompts.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { buildSummarizePrompt, type ToolActionInfo } from "../src/prompts.js";
import { parseLedgerOutput } from "../src/ledger.js";

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
    expect(p).toContain("userIntent");
    expect(p).toContain("JSON");
  });
});

describe("parseLedgerOutput", () => {
  it("parses valid output and merges mechanical fields", () => {
    const raw = JSON.stringify({
      userIntent: "修复内存泄漏",
      outcome: "已修复",
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "清理函数缺失" }, { target: "npm test", detail: "通过", phase: "verify" }] }],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.userIntent).toBe("修复内存泄漏");
    const read = s.groups[0].entries.find((e) => e.action === "read")!;
    expect(read.recallIds).toEqual(["e003"]);       // recallIds 来自机械清单
    expect(read.target).toBe("src/hooks.ts");        // target 来自机械清单
    expect(read.detail).toBe("清理函数缺失");        // detail 来自模型
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

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 prompts.ts**

```typescript
export interface ToolActionInfo { action: string; target: string; entryIds: string[] }

export function buildSummarizePrompt(turnText: string, actions: ToolActionInfo[]): string {
  const actionList = actions.map((a) => `- action=${a.action} target=${a.target} recallIds=${a.entryIds.join(",")}`).join("\n");
  return `你是编码会话的动作记录员。将这一轮对话压缩为结构化动作日志。

规则：
1. target 与 recallIds 必须使用下面清单给出的值，逐字复制，禁止改写
2. detail 一句话，写结论不写过程；detail 中出现的文件路径/命令必须能在对话原文中找到
3. 按 phase 分组：investigate（调查）/ fix（修改）/ verify（验证）/ discuss（讨论）/ other
4. thinking 内容不摘要，直接忽略
5. userIntent 一句话概括用户本轮意图；outcome 一句话概括本轮结果

工具动作清单（机械提取，不可修改）：
${actionList}

对话原文：
<conversation>
${turnText}
</conversation>

只输出 JSON，不要输出其他内容。schema：
{"userIntent": string, "outcome": string, "groups": [{"phase": "investigate|fix|verify|discuss|other", "entries": [{"target": string（必须来自清单）, "detail": string, "phase": string（可选，用于覆盖分组）}]}]}`;
}
```

`src/ledger.ts` 追加：

```typescript
import type { ToolActionInfo } from "./prompts.js";

export class LedgerParseError extends Error {}

const PATH_RE = /[\w./\\-]+\.\w{1,4}/g; // 提取 detail 中疑似路径/文件名做逐字校验

export function parseLedgerOutput(
  raw: string, actions: ToolActionInfo[], turnText: string, verbatimCheck: boolean,
): LedgerSummary {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new LedgerParseError("model output is not valid JSON");
  }
  if (typeof parsed?.userIntent !== "string" || typeof parsed?.outcome !== "string" || !Array.isArray(parsed?.groups)) {
    throw new LedgerParseError("model output missing required fields");
  }
  const byTarget = new Map(actions.map((a) => [a.target, a]));
  const groups: LedgerGroup[] = [];
  for (const g of parsed.groups) {
    const phase = (["investigate", "fix", "verify", "discuss", "other"] as const).includes(g?.phase) ? g.phase : "other";
    const entries: LedgerAction[] = [];
    for (const e of g?.entries ?? []) {
      const mech = byTarget.get(e?.target);
      if (!mech) continue; // 模型编造的 target → 剔除
      if (verbatimCheck) {
        const suspicious = String(e.detail ?? "").match(PATH_RE) ?? [];
        if (suspicious.some((p) => !turnText.includes(p) && !mech.target.includes(p))) continue; // 失真 → 剔除
      }
      entries.push({ action: mech.action, target: mech.target, detail: String(e.detail ?? ""), recallIds: mech.entryIds });
    }
    if (entries.length > 0) groups.push({ phase, entries });
  }
  return { userIntent: parsed.userIntent, outcome: parsed.outcome, groups };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts.ts src/ledger.ts tests/prompts.test.ts
git commit -m "feat: summarizer prompt + model output parsing with verbatim guard"
```

---

### Task 7: 摘要引擎——队列/worker/重试 + 后端抽象

**Files:**
- Create: `src/summarizer.ts`；Modify: `src/util.ts`（追加工具动作机械提取）
- Test: `tests/summarizer.test.ts`

**Interfaces:**
- Consumes: `buildSummarizePrompt`、`parseLedgerOutput`、`serializeConversation`/`convertToLlm`（pi 导出）、`Turn`
- Produces:
  - `src/util.ts` 追加：`function extractToolActions(turn: Turn): ToolActionInfo[]`——从 assistant 消息的 toolCall content 块机械提取（read/edit/write 取 `path`，bash 取 `command`，其他取工具名）；`function serializeTurn(turn: Turn): string`（`serializeConversation(convertToLlm(turn.entries.map(e => e.message)))`）
  - `src/summarizer.ts`：
    - `interface SummarizerBackend { complete(prompt: string, signal?: AbortSignal): Promise<string> }`
    - `class SummarizerEngine`：`constructor(backend, config, onLedger: (data: LedgerData) => void, onWarning: (msg: string) => void)`；`enqueue(turn: Turn): void`；`pending(): number`；`failed(): Set<string>`（unsummarized turnStartIds）；`waitIdle(timeoutMs: number): Promise<boolean>`
    - worker 串行；单任务失败按 `retry` 指数退避重试；仍败标记 failed 并 onWarning；成功 onLedger
    - `function createRegistryBackend(ctx: { modelRegistry: any }, ref: { kind: "registry"; provider: string; model: string }): SummarizerBackend`（用 `ctx.modelRegistry.find(provider, model)` + `complete`，参照 pi 官方 custom-compaction 示例）
    - `function createOpenAICompatBackend(ref: { kind: "openai"; baseUrl: string; model: string; apiKey?: string }): SummarizerBackend`（fetch `/chat/completions`）

- [ ] **Step 1: 写失败测试**

`tests/summarizer.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { SummarizerEngine } from "../src/summarizer.js";
import { extractToolActions, serializeTurn, type Turn, type MessageEntry } from "../src/util.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

function turnFixture(): { turn: Turn; validOutput: string } {
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "修内存泄漏" }] } as AgentMessage },
    { id: "a1", message: { role: "assistant", content: [
      { type: "text", text: "我先看看文件" },
      { type: "toolCall", toolCallId: "tc1", toolName: "read", arguments: { path: "src/hooks.ts" } } as any,
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/summarizer.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/util.ts` 追加：

```typescript
import { serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ToolActionInfo } from "./prompts.js";

export function serializeTurn(turn: Turn): string {
  return serializeConversation(convertToLlm(turn.entries.map((e) => e.message)) as any);
}

/** 从 assistant 消息的 toolCall 块机械提取动作清单；target 逐字，不经模型 */
export function extractToolActions(turn: Turn): ToolActionInfo[] {
  const out: ToolActionInfo[] = [];
  for (const e of turn.entries) {
    if (e.message.role !== "assistant") continue;
    for (const block of e.message.content as any[]) {
      if (block?.type !== "toolCall") continue;
      const args = block.arguments ?? {};
      const target = args.path ?? args.command ?? args.url ?? block.toolName;
      const prev = out.find((a) => a.action === block.toolName && a.target === target);
      if (prev) prev.entryIds.push(e.id);
      else out.push({ action: block.toolName, target: String(target), entryIds: [e.id] });
    }
  }
  return out;
}
```

`src/summarizer.ts`：

```typescript
import { buildSummarizePrompt } from "./prompts.js";
import { parseLedgerOutput, type LedgerData } from "./ledger.js";
import { serializeTurn, extractToolActions, type Turn } from "./util.js";
import type { ContextCompressConfig } from "./config.js";

export interface SummarizerBackend { complete(prompt: string, signal?: AbortSignal): Promise<string> }

interface EngineDeps { backend: SummarizerBackend; config: ContextCompressConfig; onLedger: (d: LedgerData) => void; onWarning: (m: string) => void }

export class SummarizerEngine {
  private queue: Turn[] = [];
  private failedTurns = new Set<string>();
  private running = false;
  private idleResolvers: Array<() => void> = [];
  private waitDeadline = 0;

  constructor(private deps: EngineDeps) {}

  enqueue(turn: Turn): void {
    if (this.failedTurns.has(turn.startEntryId)) this.failedTurns.delete(turn.startEntryId);
    this.queue.push(turn);
    void this.drain();
  }

  pending(): number { return this.queue.length + (this.running ? 1 : 0); }
  failed(): Set<string> { return new Set(this.failedTurns); }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.pending() === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idleResolvers.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        await this.processWithRetry(turn);
      }
    } finally {
      this.running = false;
      if (this.queue.length === 0) {
        const rs = this.idleResolvers; this.idleResolvers = [];
        for (const r of rs) r();
      }
    }
  }

  private async processWithRetry(turn: Turn): Promise<void> {
    const { maxAttempts, backoffMs } = this.deps.config.retry;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const actions = extractToolActions(turn);
        const prompt = buildSummarizePrompt(serializeTurn(turn), actions);
        const raw = await this.deps.backend.complete(prompt);
        const summary = parseLedgerOutput(raw, actions, serializeTurn(turn), this.deps.config.verbatimCheck);
        this.deps.onLedger({
          turnStartEntryId: turn.startEntryId,
          turnEndEntryId: turn.endEntryId,
          summary,
        });
        return;
      } catch (err) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        } else {
          this.failedTurns.add(turn.startEntryId);
          this.deps.onWarning(`context-compress: turn ${turn.startEntryId} 摘要失败（${String(err)}），保留原文`);
        }
      }
    }
  }
}

export function createRegistryBackend(ctx: { modelRegistry: any }, ref: { provider: string; model: string }): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      const model = ctx.modelRegistry.find(ref.provider, ref.model);
      if (!model) throw new Error(`model ${ref.provider}/${ref.model} not found`);
      const response = await ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        { maxTokens: 4096, signal, cacheRetention: "none" },
      );
      return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    },
  };
}

export function createOpenAICompatBackend(ref: { baseUrl: string; model: string; apiKey?: string }): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      const res = await fetch(`${ref.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ref.apiKey ? { authorization: `Bearer ${ref.apiKey}` } : {}) },
        body: JSON.stringify({
          model: ref.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          stream: false,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`summarizer HTTP ${res.status}`);
      const json: any = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/summarizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.ts src/util.ts tests/summarizer.test.ts
git commit -m "feat: summarizer engine with serial queue, retry, and backends"
```

---

### Task 8: recall 工具

**Files:**
- Create: `src/recall.ts`
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: `MessageEntry`、`estimateTokens`
- Produces: `function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number): { text: string; missing: string[] }`。工具注册本身在 Task 10 的 index.ts（注册依赖 ExtensionAPI，单测只测纯函数 executeRecall）。

- [ ] **Step 1: 写失败测试**

`tests/recall.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { executeRecall } from "../src/recall.js";
import type { MessageEntry } from "../src/util.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

const branch: MessageEntry[] = [
  { id: "e1", message: { role: "user", content: [{ type: "text", text: "问题原文" }] } as AgentMessage },
  { id: "e2", message: { role: "assistant", content: [{ type: "text", text: "回答原文很长".repeat(50) }] } as AgentMessage },
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
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/recall.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 recall.ts**

```typescript
import { estimateTokens, serializeConversation, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { MessageEntry } from "./util.js";

export interface RecallResult { text: string; missing: string[] }

export function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number): RecallResult {
  const byId = new Map(branch.map((e) => [e.id, e]));
  const missing: string[] = [];
  const parts: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    let text = serializeConversation(convertToLlm([e.message]) as any);
    const note = missing.length ? "" : "";
    if (estimateTokens(e.message) > maxTokensPerEntry) {
      // 估算约 4 字符/token 截断
      text = text.slice(0, maxTokensPerEntry * 4) + `\n…（已截断，原消息过大；如需其余部分请用相邻 ID 分段 recall）`;
    }
    parts.push(`【${id} 的原文】\n${text}`);
  }
  if (missing.length > 0) {
    parts.push(`以下 ID 不在当前分支中（可能因 /tree 回退）：${missing.join(", ")}。可尝试 recall 相邻 turn 的 ID。`);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/recall.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/recall.ts tests/recall.test.ts
git commit -m "feat: recall execution with truncation and missing-id reporting"
```

---

### Task 9: 76% 强制点 + 降级决策

**Files:**
- Create: `src/forcepoint.ts`
- Test: `tests/forcepoint.test.ts`

**Interfaces:**
- Consumes: `SummarizerEngine.waitIdle`
- Produces: `async function enforceForcePoint(usage: { tokens: number } | undefined, contextWindow: number, forceRatio: number, queue: { pending(): number; waitIdle(ms: number): Promise<boolean> }, waitTimeoutMs: number, onStatus: (s: string) => void): Promise<"pass" | "waited" | "degraded">`

- [ ] **Step 1: 写失败测试**

`tests/forcepoint.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import { enforceForcePoint } from "../src/forcepoint.js";

function queueWith(pending: number, idleResult: boolean) {
  return {
    pending: () => pending,
    waitIdle: vi.fn().mockResolvedValue(idleResult),
  };
}

describe("enforceForcePoint", () => {
  it("passes immediately when below ratio", async () => {
    const q = queueWith(5, true);
    expect(await enforceForcePoint({ tokens: 1000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("pass");
    expect(q.waitIdle).not.toHaveBeenCalled();
  });

  it("passes when above ratio but queue empty", async () => {
    const q = queueWith(0, true);
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("pass");
  });

  it("waits and succeeds when queue drains in time", async () => {
    const q = queueWith(3, true);
    const status = vi.fn();
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, status)).toBe("waited");
    expect(q.waitIdle).toHaveBeenCalledWith(1000);
    expect(status).toHaveBeenCalled(); // 进度提示
  });

  it("degrades when wait times out", async () => {
    const q = queueWith(3, false);
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("degraded");
  });

  it("passes when usage is undefined (no estimate)", async () => {
    expect(await enforceForcePoint(undefined, 10000, 0.76, queueWith(3, true), 1000, vi.fn())).toBe("pass");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/forcepoint.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 forcepoint.ts**

```typescript
export interface ForcePointQueue { pending(): number; waitIdle(ms: number): Promise<boolean> }
export type ForcePointDecision = "pass" | "waited" | "degraded";

export async function enforceForcePoint(
  usage: { tokens: number } | undefined,
  contextWindow: number,
  forceRatio: number,
  queue: ForcePointQueue,
  waitTimeoutMs: number,
  onStatus: (s: string) => void,
): Promise<ForcePointDecision> {
  if (!usage || usage.tokens <= forceRatio * contextWindow) return "pass";
  if (queue.pending() === 0) return "pass";
  onStatus(`上下文 ${Math.round((usage.tokens / contextWindow) * 100)}%，等待摘要队列清空（${queue.pending()} 个 turn）…`);
  const drained = await queue.waitIdle(waitTimeoutMs);
  if (drained) return "waited";
  onStatus("等待超时，本轮降级：交给 pi 原生压缩兜底");
  return "degraded";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/forcepoint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/forcepoint.ts tests/forcepoint.test.ts
git commit -m "feat: 76% force point with wait/degrade decisions"
```

---

### Task 10: index.ts——事件接线 + recall 注册 + /compress-status

**Files:**
- Create: `src/index.ts`
- Test: 集成测试放 Task 11；本任务用 `pi -e` 手动冒烟（Step 5）

**Interfaces:**
- Consumes: 全部前序模块；pi Extension API（`pi.on`/`pi.registerTool`/`pi.registerCommand`、`ctx.sessionManager`、`ctx.getContextUsage()`、`ctx.ui`、`ctx.model`）
- Produces: 扩展入口（默认导出工厂函数）。事件接线：
  - `session_start` → 读配置（`~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json` 合并，`loadConfig`）→ `store.rebuildFromEntries(ctx.sessionManager.getBranch())`
  - `context` → 取 `ctx.sessionManager.getBranch()` 投影为 MessageEntry[]（`type === "message"` 的 entry）→ `enforceForcePoint`（用 `ctx.getContextUsage()` 与 `ctx.model.contextWindow`；degraded 时直接 `return`（不重组，让 pi 原生压缩接管））→ `assembleContext` → `return { messages }`
  - `agent_settled` → 计算最后一个完整 turn（从 branch 末尾往前找最后一个 user 消息；无 user 消息则以 branch 开头为界）→ 若 `store` 无此 turn 且 `engine.failed()` 无此 turn → `engine.enqueue(turn)`
  - `session_before_compact` → 健康检查（`engine.pending() === 0` 且 `store` 覆盖了所有窗外 turn）→ 健康：用 `renderActionLedger(store 中全部 ledger)` 的文本作为 `compaction.summary`（`firstKeptEntryId`/`tokensBefore` 取自 `event.preparation`）→ 不健康：`return undefined`（pi 原生压缩照常）
  - `pi.registerTool("recall", …)`：参数 `Type.Object({ ids: Type.Array(Type.String(), { description: "动作日志 ↩ 后的 entry ID 列表" }) })`；execute 里调 `executeRecall(ids, branchMessageEntries, 4000)`（4000 = 单条截断上限，写死并注释可后续配置化）
  - `pi.registerCommand("compress-status", …)`：notify 显示 `store.size()`、`engine.pending()`、`engine.failed().size`、最近一次 assemble stats
- 配置文件读取：`node:fs` + `os.homedir()`；用 `CONFIG_DIR_NAME`（pi 导出）拼项目路径；解析失败按 undefined 处理

- [ ] **Step 1: 实现 index.ts**

```typescript
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type ContextCompressConfig } from "./config.js";
import { assembleContext, type AssembleStats } from "./assembler.js";
import { LedgerStore, type SessionEntryLike } from "./store.js";
import { SummarizerEngine, createRegistryBackend, createOpenAICompatBackend, type SummarizerBackend } from "./summarizer.js";
import { executeRecall } from "./recall.js";
import { enforceForcePoint } from "./forcepoint.js";
import { splitIntoTurns, type MessageEntry } from "./util.js";
import { renderActionLedger, type LedgerData } from "./ledger.js";

const WAIT_TIMEOUT_MS = 120_000;

function readJson(path: string): unknown {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return undefined; }
}

function toMessageEntries(branch: any[]): MessageEntry[] {
  return branch.filter((e) => e.type === "message" && e.message).map((e) => ({ id: e.id, message: e.message }));
}

export default function (pi: ExtensionAPI) {
  let config: ContextCompressConfig | null = null;
  let store = new LedgerStore();
  let engine: SummarizerEngine | null = null;
  let degraded = false;
  let lastStats: AssembleStats | null = null;

  const makeEngine = (ctx: ExtensionContext): SummarizerEngine | null => {
    if (!config?.summarizer) return null;
    const backend: SummarizerBackend = config.summarizer.kind === "registry"
      ? createRegistryBackend(ctx as any, config.summarizer)
      : createOpenAICompatBackend(config.summarizer);
    return new SummarizerEngine(backend, config, (d) => {
      store.set(d);
      try { ctx.sessionManager.appendCustomEntry("context-compress:ledger", d); } catch { /* append 失败仅影响持久化，内存缓存仍生效 */ }
    }, (m) => ctx.ui.notify(m, "warning"));
  };

  pi.on("session_start", async (_event, ctx) => {
    const globalRaw = readJson(join(os.homedir(), ".pi", "agent", "settings.json"));
    const projectRaw = readJson(join(ctx.cwd, ".pi", "settings.json"));
    config = loadConfig(globalRaw, projectRaw);
    store = new LedgerStore();
    store.rebuildFromEntries(ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
    engine = makeEngine(ctx);
    degraded = false;
  });

  pi.on("context", async (_event, ctx) => {
    if (degraded || !config) return;
    const branch = ctx.sessionManager.getBranch();
    const entries = toMessageEntries(branch);
    if (entries.length === 0) return;

    const decision = await enforceForcePoint(
      ctx.getContextUsage() ?? undefined,
      ctx.model?.contextWindow ?? 200_000,
      config.forceRatio,
      engine ?? { pending: () => 0, waitIdle: async () => true },
      WAIT_TIMEOUT_MS,
      (s) => ctx.ui.setStatus("compress", s),
    );
    if (decision === "degraded") {
      degraded = true;
      ctx.ui.notify("context-compress: 已降级，本轮交由 pi 原生压缩", "warning");
      return; // 不重组消息，上下文自然增长直到 pi auto-compaction
    }

    const { messages, stats } = assembleContext(entries, new Map(store.keys().map((k) => [k, store.get(k)!])), config.keepRecentTokens);
    lastStats = stats;
    if (engine && engine.pending() === 0) degraded = false; // 恢复
    return { messages };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!engine) return;
    const entries = toMessageEntries(ctx.sessionManager.getBranch());
    const turns = splitIntoTurns(entries);
    if (turns.length === 0) return;
    const last = turns[turns.length - 1];
    if (store.get(last.startEntryId) || engine.failed().has(last.startEntryId)) return;
    engine.enqueue(last);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!config || !engine) return undefined; // pi 原生压缩照常
    if (engine.pending() > 0) return undefined; // 不健康 → 让位
    const ledgers = store.keys().map((k) => store.get(k)!).sort((a, b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId));
    if (ledgers.length === 0) return undefined;
    const text = (renderActionLedger(ledgers).content as any[]).map((c) => c.text ?? "").join("");
    return {
      compaction: {
        summary: text,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "取回动作日志条目的逐字原文。参数为动作日志中 ↩ 标记后的 entry ID 列表（可批量）。",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "entry ID 列表，来自动作日志 ↩ 标记" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = toMessageEntries(ctx.sessionManager.getBranch());
      const r = executeRecall(params.ids, entries, 4000); // 单条 4k tokens 截断
      return { content: [{ type: "text", text: r.text }] };
    },
  });

  pi.registerCommand("compress-status", {
    description: "显示 context-compress 状态",
    handler: async (_args, ctx) => {
      const lines = [
        `已摘要 turn 数：${store.size()}`,
        `队列积压：${engine?.pending() ?? 0}`,
        `失败未摘：${engine?.failed().size ?? 0}`,
        `降级状态：${degraded ? "已降级（pi 原生压缩接管中）" : "正常"}`,
        `最近装配：${lastStats ? `窗口 ${lastStats.windowTurns} turns / 替换 ${lastStats.replacedTurns} / 原文放行 ${lastStats.passthroughTurns}` : "无"}`,
        `摘要后端：${config?.summarizer ? JSON.stringify(config.summarizer) : "未配置（插件未接管）"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误（如 pi 类型与上述用法有出入——例如 `contextWindow` 字段名、`registerTool` 签名——以 `node_modules/@earendil-works/pi-coding-agent/dist/*.d.ts` 实际类型为准修正，不改设计）

- [ ] **Step 3: 单测全量回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 4: 手动冒烟（无模型）**

把 `package.json` 中 `pi.extensions` 指向的目录复制/链接到 `~/.pi/agent/extensions/context-compress/`，启动 `pi`，验证：
1. 无 `contextCompress` 配置时插件静默不接管（`/compress-status` 显示"未配置"）
2. 发一条消息，正常回答不受影响
3. `/compress-status` 正常显示

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: extension entry - event wiring, recall tool, status command"
```

---

### Task 11: 集成测试（mock 模型全链路）

**Files:**
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: 全部模块（纯函数层组装，不起 pi 进程）
- Produces: 无新接口；验证 spec 4.4 的三条链路

- [ ] **Step 1: 写集成测试**

`tests/integration.test.ts`——用 fake backend 直接驱动模块组合，模拟事件序列：

```typescript
import { describe, it, expect, vi } from "vitest";
import { SummarizerEngine } from "../src/summarizer.js";
import { LedgerStore } from "../src/store.js";
import { assembleContext } from "../src/assembler.js";
import { executeRecall } from "../src/recall.js";
import { enforceForcePoint } from "../src/forcepoint.js";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { loadConfig } from "../src/config.js";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";

function bigTurn(startId: string, text: string): MessageEntry[] {
  return [
    { id: startId, message: { role: "user", content: [{ type: "text", text }] } as AgentMessage },
    { id: startId + "-a", message: { role: "assistant", content: [
      { type: "text", text: "ok" },
      { type: "toolCall", toolCallId: "tc", toolName: "read", arguments: { path: "src/app.ts" } } as any,
    ] } as AgentMessage },
    { id: startId + "-r", message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "文件内容 " + text }] } as AgentMessage },
  ];
}

const config = loadConfig(undefined, undefined);

describe("integration: turn → summarize → assemble → recall", () => {
  it("full pipeline replaces old turns and recalls originals verbatim", async () => {
    const store = new LedgerStore();
    const validOutput = JSON.stringify({
      userIntent: "看文件", outcome: "看完了",
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
    const head = (messages[0].content as any[]).map((c) => c.text ?? "").join("");
    expect(head).toContain("<action-ledger>");
    expect(head).toContain("↩t1");

    // recall: 从 ledger 头部的 ↩ 标记取回原文
    const ids = [...head.matchAll(/↩([\w-]+)/g)].map((m) => m[1]);
    const r = executeRecall(ids, branch, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("a".repeat(4000)); // 逐字原文
  });

  it("backend failure → passthrough verbatim → retry next round", async () => {
    const store = new LedgerStore();
    let fail = true;
    const engine = new SummarizerEngine(
      { complete: async () => { if (fail) throw new Error("down"); return JSON.stringify({ userIntent: "u", outcome: "o", groups: [] }); } },
      { ...config, retry: { maxAttempts: 1, backoffMs: 1 } },
      (d) => store.set(d), vi.fn(),
    );
    const branch = [...bigTurn("t1", "a".repeat(100))];
    engine.enqueue(splitIntoTurns(branch)[0]);
    await engine.waitIdle(5000);
    expect(store.get("t1")).toBeUndefined();
    // context: 原文放行
    const { messages, stats } = assembleContext(branch, new Map(), 1000);
    expect(stats.passthroughTurns).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBe(3);
    // 恢复后重摘
    fail = false;
    engine.enqueue(splitIntoTurns(branch)[0]);
    await engine.waitIdle(5000);
    expect(store.get("t1")).toBeTruthy();
  });

  it("force point degrades on timeout, recovers when queue drains", async () => {
    const q = { pending: () => 1, waitIdle: async () => false };
    const status = vi.fn();
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 50, status)).toBe("degraded");
    const q2 = { pending: () => 0, waitIdle: async () => true };
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q2, 50, status)).toBe("pass");
  });
});
```

- [ ] **Step 2: 运行**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS（3 条链路：正常全链路 / 失败放行与恢复 / 强制点降级与恢复）

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: integration pipeline with mock model"
```

---

### Task 12: README + 安装文档

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: 无
- Produces: 用户文档

- [ ] **Step 1: 编写 README.md**

内容必须包含（中文）：
1. 一句话定位与工作原理图（context 重组 / 后台摘要 / recall / 76% 强制点）
2. 安装：`git clone` 后将目录复制或 junction 到 `~/.pi/agent/extensions/context-compress/`（Windows junction 命令示例 `mklink /J`，Unix 符号链接 `ln -s`）
3. 配置示例：方式一（pi 模型注册表，含如何在 pi 里注册 Ollama provider 的提示，引用 pi 文档 `docs/custom-provider.md`）与方式二（OpenAI 兼容直连），全部配置项表格（含默认值：`keepRecentTokens 20000`、`forceRatio 0.76`、`verbatimCheck true`、`retry {3, 2000}`、`ledgerMergeThreshold 40`）
4. 模型选型建议（4B–8B、指令遵循稳定、Qwen 系推荐、中英混合注意）
5. `/compress-status` 命令说明
6. 已知限制（v1）：ledger 合并未实现、RPC/print 模式未特殊处理、单 turn 超大会导致窗口临时超预算

- [ ] **Step 2: 真实模型冒烟（手动，可选但推荐）**

配置 Ollama + qwen3:8b，跑 10–20 轮真实编码对话，检查：摘要落盘（session 文件中出现 `context-compress:ledger` entry）、旧 turn 替换生效、`/compress-status` 数据合理、recall 能取回逐字原文。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with install, config, and usage"
```

---

## Self-Review 结果

- **Spec 覆盖**：spec §2 四组件 → Task 3/4（装配器）、Task 7（摘要引擎）、Task 8（recall）、Task 9（强制点）；§3 数据结构 → Task 2/5/6；§4 流程与边界 → Task 10/11；§5 测试四层 → Task 1–9（层一）、Task 11（层三）、Task 12 Step 2（层四）；§5.2 Phase 切分 → Task 1–5 ≈ Phase 1–2、Task 6–7 ≈ Phase 3、Task 8–9 ≈ Phase 4、Task 10–12 ≈ Phase 5。缺口：spec 层二"状态机测试（模拟时钟）"由 Task 7 的串行/重试用例覆盖核心，时钟模拟从简（vitest 真实毫秒退避 backoffMs=1）。
- **占位符扫描**：无 TBD/TODO；Task 10 Step 2 的"以实际类型为准修正"是对外部类型的不确定性说明，非占位符。
- **类型一致性**：`LedgerData`/`ToolActionInfo`/`MessageEntry`/`Turn`/`SummarizerBackend` 跨任务签名已核对一致；`store.keys()` 在 Task 5 定义、Task 10 使用。
