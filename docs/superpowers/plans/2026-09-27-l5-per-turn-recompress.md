# L5 逐条二次压缩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L5 从「多 turn 合并成一行主题描述、不可召回」改为「每个 turn 各自二次压缩成一条描述、可召回整段原文」。

**Architecture:** 删除「合并组」这一整类概念。`planDegrade` 不再产出 `mergeGroups`；`mergeDescribe`（单组一次调用）改为 `recompressBatched`（批量 N=20 逐条对应）；渲染层删除 L5 聚合分支，走与 L3/L4 相同的通用路径并加 ↩ID 锚点；召回层删除 L5 拒绝分支，与 L3/L4 走同一 turn 级路径。

**Tech Stack:** TypeScript（ESM, `.js` 后缀导入）、Vitest、Node 18+（fetch）

## Global Constraints

- **配置项零变更**：不改 `src/config.ts` 任何默认值。N=20 是模块内常量 `L5_BATCH_SIZE`，不进配置。
- **缺省路径逐字节不变**：不含 L5 的会话，装配渲染结果必须与改动前逐字节相同。
- **导入后缀**：ESM 项目，所有相对导入必须带 `.js` 后缀（如 `./degrade-llm.js`）。
- **测试命令**：`npx vitest run <file>`；类型检查 `npx tsc --noEmit`。
- **基线**：改动前 `347 passed / 1 skipped`。
- **批量上限**：N=20（探针实测稳定；N=40 亦通过但保守取 20）。
- **不新增配置项、不新增 schema 字段、不做存量数据迁移。**
- **提示词正文逐字沿用**（见 Task 2），不得改写。

---

## 文件结构

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `src/prompts.ts` | 提示词构造 | 删 `buildMergeDescriptionPrompt`，加 `buildBatchRecompressPrompt` |
| `src/degrade-llm.ts` | LLM 降级调用与解析 | 删 `mergeDescribe`，加 `recompressBatched` + `recompressOne` |
| `src/degrade.ts` | 降级计划与编排 | 删 `mergeGroups`；L5 执行段改为批量分片 |
| `src/ledger.ts` | 渲染 | L5 渲染加锚点；删聚合分支；删计数重写 |
| `src/recall.ts` | 召回与检索 | 删 L5 拒绝分支；删 `rejected`；searchLedger 删 L5 聚合 |
| `src/index.ts` | 接线与统计 | 删 `rejected` 统计与展示 |
| `README.md` | 文档 | L5 语义、已知限制 |

**待删/改写的既有测试**（行号为改动前基线，已逐个核对）：

| 文件 | 行 | 处理 |
|---|---|---|
| `tests/degrade-llm.test.ts` | 2, 28-30 | 删 `mergeDescribe` 导入与 describe 块 |
| `tests/degrade.test.ts` | 32-33, 40, 50, 81, 89, 97 | 删 `mergeGroups` 断言 |
| `tests/degrade.test.ts` | 214-223 | 删「一组一次调用 + 计数后缀」断言（改为逐条：每条各一次描述、无后缀） |
| `tests/degrade.test.ts` | 225-236 | 改写为「单条失败 → 保持 L4 + warning」（不再有「组回滚」概念） |
| `tests/ledger.test.ts` | 147-155, 193-206, 210-215, 277-291 | 删聚合/计数重写断言 |
| `tests/ledger.test.ts` | 179-180, 192 | 改写为锚点断言 |
| `tests/recall.test.ts` | 323-328 | 改写为「L5 同构取回原文」 |
| `tests/extension.test.ts` | 290-308 | 改写为「L5 不再拒绝，计入取回」 |

**依赖顺序**：Task 1（提示词）→ Task 2（LLM 层）→ Task 3（计划层）→ Task 4（编排层）→ Task 5（渲染）→ Task 6（召回）→ Task 7（接线）→ Task 8（文档）。

Task 1–4 是**生产侧**，Task 5–7 是**消费侧**，Task 8 收尾。

---

## Task 1: 提示词 — 新增 `buildBatchRecompressPrompt`

**Files:**
- Modify: `src/prompts.ts:56-66`（删 `buildMergeDescriptionPrompt`，加新函数）
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: `LedgerData`（`src/ledger.ts`，需读 `summary.userIntent` / `summary.outcome`）
- Produces: `buildBatchRecompressPrompt(items: LedgerData[]): string`

- [ ] **Step 1: 写失败测试**

在 `tests/prompts.test.ts` 末尾追加（顶部确保有 `import { buildBatchRecompressPrompt } from "../src/prompts.js";` 与 `import type { LedgerData } from "../src/ledger.js";`）：

```ts
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL —— `buildBatchRecompressPrompt is not a function` / 导入报错

- [ ] **Step 3: 实现**

在 `src/prompts.ts` 中**删除** `buildMergeDescriptionPrompt`（56-66 行整块），替换为：

```ts
/**
 * 批量二次压缩（L4→L5）：一次提交 N 条 L4，逐条输出一条描述，序号一一对应。
 * 正文为用户给定提示词（2026-09-27 探针验证：2 批各 20 条，零缺失、零串位、压缩率 0.492）。
 * 见 docs/evidence/l5-prompt-verify.txt。
 */
export function buildBatchRecompressPrompt(items: LedgerData[]): string {
  const blocks = items
    .map((l, i) => `[#${i + 1}]\n意图：${l.summary.userIntent ?? ""}\n结果：${l.summary.outcome ?? ""}`)
    .join("\n\n");
  return `请对以下已经完成过一次摘要的内容做二次摘要。
要求：
1. 剔除冗余细节（commit哈希、具体文件路径、零散函数名等），保留核心结论、关键变更、产出物、待办事项
2. 按原有顺序梳理逻辑，不新增信息，不丢失主线节点
3. 语言凝练，篇幅压缩到原文的1/2以内

下面是 ${items.length} 条独立内容，每条以 "[#序号]" 开头：

${blocks}

逐条输出，每条各占一项，必须与输入条数相同（共 ${items.length} 条），序号一一对应。
只输出 JSON：{"items": [{"index": number, "description": string}, ...]}`;
}
```

顶部 import 若无 `LedgerData` 类型则补：`import type { LedgerData } from "./ledger.js";`

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 确认无残留引用**

Run: `grep -rn "buildMergeDescriptionPrompt" src/ tests/`
Expected: 仅 `src/degrade-llm.ts` 一处（Task 2 处理）；若 tests 中另有引用，一并删除对应用例。

- [ ] **Step 6: 提交**

```bash
git add src/prompts.ts tests/prompts.test.ts
git commit -m "feat(l5): 提示词改为批量二次压缩（buildBatchRecompressPrompt）"
```

---

## Task 2: LLM 层 — `recompressBatched` + `recompressOne`

**Files:**
- Modify: `src/degrade-llm.ts:32-52`（删 `mergeDescribe`）
- Test: `tests/degrade-llm.test.ts`

**Interfaces:**
- Consumes: `SummarizerBackend.complete(prompt, signal?): Promise<string>`；`buildBatchRecompressPrompt`（Task 1）
- Produces:
  - `export const L5_BATCH_SIZE = 20`
  - `export async function recompressBatched(backend, ledgers: LedgerData[], signal?): Promise<Array<string | null>>` —— **返回长度与入参等长**的数组，失败项为 `null`（不抛错）
  - `export async function recompressOne(backend, ledger: LedgerData, signal?): Promise<string>`

- [ ] **Step 1: 写失败测试**

在 `tests/degrade-llm.test.ts` 追加：

```ts
import { recompressBatched, recompressOne, L5_BATCH_SIZE } from "../src/degrade-llm.js";

describe("recompressBatched", () => {
  const mk = (id: string, intent: string, outcome: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4,
    summary: { entries: [], userIntent: intent, outcome },
  } as unknown as LedgerData);

  const backendOf = (responses: string[]) => {
    let i = 0;
    return { complete: async () => responses[Math.min(i++, responses.length - 1)] } as any;
  };

  it("按 index 一一映射，返回长度与入参等长", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "描述一" }, { index: 2, description: "描述二" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["描述一", "描述二"]);
  });

  it("index 乱序仍正确归位", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 2, description: "第二" }, { index: 1, description: "第一" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["第一", "第二"]);
  });

  it("缺项 → null，不抛错、不影响其他项", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2"), mk("c", "i3", "o3")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "甲" }, { index: 3, description: "丙" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["甲", null, "丙"]);
  });

  it("裸数组形态也接受", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify([{ index: 1, description: "甲" }])]);
    expect(await recompressBatched(backend, items)).toEqual(["甲"]);
  });

  it("``` 围栏被剥离", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf(["```json\n" + JSON.stringify({ items: [{ index: 1, description: "甲" }] }) + "\n```"]);
    expect(await recompressBatched(backend, items)).toEqual(["甲"]);
  });

  it("JSON 完全无法解析 → 全 null（不抛错）", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf(["这不是 JSON"]);
    expect(await recompressBatched(backend, items)).toEqual([null, null]);
  });

  it("空数组 → 空数组，且不调用 backend", async () => {
    let called = 0;
    const backend = { complete: async () => { called++; return "{}"; } } as any;
    expect(await recompressBatched(backend, [])).toEqual([]);
    expect(called).toBe(0);
  });

  it("index 重复时后者覆盖前者", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "先" }, { index: 1, description: "后" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["后"]);
  });

  it("description 为空串视为缺失 → null", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify({ items: [{ index: 1, description: "   " }] })]);
    expect(await recompressBatched(backend, items)).toEqual([null]);
  });

  it("L5_BATCH_SIZE = 20", () => {
    expect(L5_BATCH_SIZE).toBe(20);
  });
});

describe("recompressOne", () => {
  const mk = (id: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4,
    summary: { entries: [], userIntent: "i", outcome: "o" },
  } as unknown as LedgerData);

  it("单条成功返回描述", async () => {
    const backend = { complete: async () => JSON.stringify({ items: [{ index: 1, description: "单条描述" }] }) } as any;
    expect(await recompressOne(backend, mk("a"))).toBe("单条描述");
  });

  it("失败抛错（供调用方降级为保持 L4）", async () => {
    const backend = { complete: async () => "不是 JSON" } as any;
    await expect(recompressOne(backend, mk("a"))).rejects.toThrow();
  });
});
```

顶部补 import：`import type { LedgerData } from "../src/ledger.js";`（若已有则复用）。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/degrade-llm.test.ts`
Expected: FAIL —— 导出不存在

- [ ] **Step 3: 实现**

在 `src/degrade-llm.ts` 中**删除** `mergeDescribe`（32-52 行整块），替换为：

```ts
/** L5 批量大小（探针实测 N=20 稳定：2 批各 20 条，零缺失、零串位；见 docs/evidence/l5-prompt-verify.txt） */
export const L5_BATCH_SIZE = 20;

/** 剥 ``` 围栏后解析为 JSON；失败返回 undefined（不抛错） */
function parseJsonLoose(raw: string): any {
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return undefined;
  }
}

/**
 * L4→L5 批量二次压缩：一次调用提交 N 条，逐条输出描述，index 一一对应。
 * 返回数组**长度与入参等长**，缺失/解析失败项为 null（不抛错，由调用方决定单条重跑）。
 */
export async function recompressBatched(
  backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal,
): Promise<Array<string | null>> {
  if (ledgers.length === 0) return [];
  const raw = await backend.complete(buildBatchRecompressPrompt(ledgers), signal);
  const parsed = parseJsonLoose(raw);
  const out: Array<string | null> = new Array(ledgers.length).fill(null);
  const arr = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    const idx = Number(it?.index);
    const desc = typeof it === "string" ? it : it?.description;
    if (!Number.isFinite(idx) || idx < 1 || idx > ledgers.length) continue;
    out[idx - 1] = typeof desc === "string" && desc.trim() ? desc.trim() : null; // 重复 index 后者覆盖
  }
  return out;
}

/** 单条二次压缩（批量中某条缺失时的兜底重跑）。失败抛错，由调用方回滚。 */
export async function recompressOne(
  backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal,
): Promise<string> {
  const out = await recompressBatched(backend, [ledger], signal);
  const desc = out[0];
  if (typeof desc !== "string" || desc === "") throw new Error("degrade output missing description");
  return desc;
}
```

更新顶部 import：删 `buildMergeDescriptionPrompt`，改为 `buildBatchRecompressPrompt`：

```ts
import { buildIntentOutcomePrompt, buildBatchRecompressPrompt } from "./prompts.js";
```

同时**删除** `renderTurnText` 的导入（`mergeDescribe` 是唯一使用者；用 `grep -n "renderTurnText" src/degrade-llm.ts` 确认后删除该 import 行）。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/degrade-llm.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/degrade-llm.ts tests/degrade-llm.test.ts
git commit -m "feat(l5): mergeDescribe 改为 recompressBatched/recompressOne（批量逐条、失败返回 null）"
```

---

## Task 3: 计划层 — 删除 `mergeGroups`

**Files:**
- Modify: `src/degrade.ts:9-12`（接口）、`src/degrade.ts:82-95`（分组生成）
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: 无新增
- Produces: `DegradePlan` 不再含 `mergeGroups`；`DegradeStep.toLevel` 类型放宽为 `2 | 3 | 4 | 5`（不变）

- [ ] **Step 1: 写失败测试**

在 `tests/degrade.test.ts` 追加：

```ts
describe("planDegrade 不再产出 mergeGroups", () => {
  it("返回值只有 steps 字段", () => {
    const plan = planDegrade([], 40_000, 10_000);
    expect(Object.keys(plan).sort()).toEqual(["steps"]);
    expect((plan as any).mergeGroups).toBeUndefined();
  });

  it("升 L5 的条目仍出现在 steps 中（toLevel=5）", () => {
    // 构造 5 条 L4，驱动 L4 层超阈 → 至少一条升 L5
    const mk = (id: string) => ({
      turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4 as const,
      summary: { entries: [], userIntent: "i", outcome: "很长的结果".repeat(300) },
    } as unknown as LedgerData);
    const ledgers = Array.from({ length: 5 }, (_, i) => mk("t" + i));
    const plan = planDegrade(ledgers, 1_000, 200);
    expect(plan.steps.some((s) => s.toLevel === 5)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: FAIL —— `mergeGroups` 仍存在（`Object.keys` 断言失败）

- [ ] **Step 3: 实现**

`src/degrade.ts` 中：

1. 删除 `DegradePlan.mergeGroups` 字段（9-12 行的接口定义改为只留 `steps`）：

```ts
export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, toLevel) 列表，最旧优先 */
  steps: DegradeStep[];
}
```

2. 删除 `planDegrade` 末尾的分组生成（82-95 行），改为直接返回：

```ts
  return { steps };
```

3. 更新 `planDegrade` 的 JSDoc：删除其中「→ 不生成 toLevel>=4 的 step、不入合并组」里的「不入合并组」措辞，改为「不生成 toLevel>=4 的 step」。

4. 此时 `DegradeEngine.run` 会因引用 `plan.mergeGroups` 编译失败 —— **这是预期的**，Task 4 修复。为保持本任务可独立提交，`run` 中临时把 L5 段改为空循环：

```ts
    // L4→L5 执行段由 Task 4 重写（批量分片）；此处暂空以保持编译通过
    void plan.steps.filter((s) => s.toLevel === 5); // 占位，避免未使用变量告警
```

（注意：本任务提交后 L5 功能暂时失效，Task 4 立即恢复。若执行者希望避免中间态，可将 Task 3+4 合并为一次提交。）

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/degrade.test.ts`

Expected: PASS。

**必须处理的既有用例**（断言的是被本设计废止的行为）：
- `tests/degrade-llm.test.ts:2,28-30` —— `import { compressEnds, mergeDescribe }` 与 `describe("mergeDescribe")` 整块：**删除**（Task 2 已用新用例取代）
- `tests/degrade.test.ts:32-33` —— 片段不进合并组断言：**删除**
- `tests/degrade.test.ts:40,50,81` —— `expect(p.mergeGroups).toEqual([])`：**删除**
- `tests/degrade.test.ts:89` —— `mergeGroups` 相邻分组断言：**删除**
- `tests/degrade.test.ts:97` —— 非相邻分组断言：**删除**
- `tests/degrade.test.ts:214-223` —— 「一组一次调用 + `（2 条已合并）` 后缀」：**删除**（Task 4 的逐条用例取代）
- `tests/degrade.test.ts:225-236` —— 「L5 合并组失败回滚」：**改写**为「单条失败 → 保持 L4 + warning」（不再有「组」概念）

- [ ] **Step 5: 提交**

```bash
git add src/degrade.ts tests/degrade.test.ts
git commit -m "refactor(l5): planDegrade 删除 mergeGroups（合并组概念废止）"
```

---

## Task 4: 编排层 — L5 执行段改为批量分片

**Files:**
- Modify: `src/degrade.ts`（`DegradeEngine.run` 的 L5 段 + 类 JSDoc）
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: `recompressBatched` / `recompressOne` / `L5_BATCH_SIZE`（Task 2）；`DegradeStep.toLevel === 5`（Task 3）
- Produces: `DegradeEngine.run(ledgers, holdAt3?)` 行为 —— L5 条目获得 `level = 5` 与 `merged = { description }`

- [ ] **Step 1: 写失败测试**

在 `tests/degrade.test.ts` 追加：

```ts
describe("DegradeEngine L5 逐条压缩", () => {
  const mk = (id: string, n = 0): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4 as const,
    summary: { entries: [], userIntent: "意图" + n, outcome: "结果".repeat(300) },
  } as unknown as LedgerData);

  const collect = () => {
    const out: LedgerData[] = [];
    const warns: string[] = [];
    return { out, warns, onLedger: (d: LedgerData) => out.push(d), onWarning: (m: string) => warns.push(m) };
  };

  it("每条 L5 获得独立描述（不含「条已合并」后缀）", async () => {
    const ledgers = Array.from({ length: 3 }, (_, i) => mk("t" + i, i));
    const backend = { complete: async (p: string) => {
      const n = (p.match(/\[#\d+\]/g) ?? []).length;
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ index: i + 1, description: "描述" + i })) });
    } } as any;
    const { out, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    const l5 = out.filter((d) => d.level === 5);
    expect(l5.length).toBeGreaterThan(0);
    for (const d of l5) {
      expect(d.merged?.description).toBeTruthy();
      expect(d.merged!.description).not.toContain("条已合并");
    }
    // 同一批内描述各不相同（逐条对应，非组共享）
    const descs = l5.map((d) => d.merged!.description);
    expect(new Set(descs).size).toBe(descs.length);
  });

  it("批内某条缺失 → 单独重跑该条（不整批重试）", async () => {
    const ledgers = Array.from({ length: 2 }, (_, i) => mk("t" + i, i));
    let call = 0;
    const backend = { complete: async (p: string) => {
      call++;
      const n = (p.match(/\[#\d+\]/g) ?? []).length;
      if (n > 1) return JSON.stringify({ items: [{ index: 1, description: "批内第一条" }] }); // 第二条缺失
      return JSON.stringify({ items: [{ index: 1, description: "单条补跑" }] });
    } } as any;
    const { out, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    const descs = out.filter((d) => d.level === 5).map((d) => d.merged!.description);
    expect(descs).toContain("单条补跑");
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("单条重跑仍失败 → 保持 L4 + warning，其他条不受影响", async () => {
    const ledgers = Array.from({ length: 2 }, (_, i) => mk("t" + i, i));
    let call = 0;
    const backend = { complete: async () => { call++; return call === 1 ? "不是JSON" : "也不是"; } } as any;
    const { out, warns, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    expect(out.some((d) => d.level === 5)).toBe(false);
    expect(warns.some((w) => w.includes("L5"))).toBe(true);
  });
});
```

`cfgOf()` 是辅助函数（若文件中已有等价物则复用；否则在 describe 内定义）：

```ts
const cfgOf = (): ContextCompressConfig => ({
  ledgerDegradeThresholdTokens: 1_000, ledgerReserveTokens: 200,
  keepRecentTokens: 20_000, recallMaxTokensPerEntry: 4_000,
} as ContextCompressConfig);
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: FAIL —— L5 段当前为空占位，`level === 5` 条目数为 0

- [ ] **Step 3: 实现**

`src/degrade.ts`：把 Task 3 留下的占位注释替换为真实的 L5 执行段：

```ts
    // L4→L5：逐条二次压缩（不再有合并组）。按 L5_BATCH_SIZE 分片，一次调用产出 N 条描述；
    // 某条缺失 → 该条单独重跑；仍失败 → 保持 L4 + warning（不整批重试）。
    // 时序约束：必须在写 level=5 之前取描述（输入读 summary.userIntent/outcome）。
    const l5Steps = plan.steps.filter((s) => s.toLevel === 5);
    for (let i = 0; i < l5Steps.length; i += L5_BATCH_SIZE) {
      const slice = l5Steps.slice(i, i + L5_BATCH_SIZE).map((s) => byId.get(s.turnStartEntryId)!);
      const descs = await recompressBatched(this.backend, slice);
      for (let j = 0; j < slice.length; j++) {
        const m = slice[j];
        let desc = descs[j];
        if (desc === null) {
          try {
            desc = await recompressOne(this.backend, m);
          } catch (err) {
            this.onWarning(`context-compress: turn ${m.turnStartEntryId} L5 压缩失败（${String(err)}），保持 L4`);
            continue;
          }
        }
        m.level = 5;
        m.merged = { description: desc };
        this.onLedger(m);
      }
    }
```

更新 import：

```ts
import { compressEnds, recompressBatched, recompressOne, L5_BATCH_SIZE } from "./degrade-llm.js";
```

更新 `DegradeEngine` 类的 JSDoc（`degrade.ts` 类定义上方），把「L4→L5 mergeDescribe」改为「L4→L5 recompressBatched（批量逐条）」，「合并组失败时 level 从未改动」改为「单条失败保持 L4 + warning，不中断整体」。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/degrade.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 干净

- [ ] **Step 5: 提交**

```bash
git add src/degrade.ts tests/degrade.test.ts
git commit -m "feat(l5): 执行段改为批量分片逐条压缩（缺失单条重跑）"
```

---

## Task 5: 渲染层 — L5 加锚点 + 删除聚合分支

**Files:**
- Modify: `src/ledger.ts:89-93`（L5 单条渲染）、`src/ledger.ts:169-192`（聚合分支）
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `LedgerData.merged.description`、`turnStartEntryId`
- Produces: `renderTurnText(l, n)` 对 `lvl === 5` 输出 `T{n} · {desc} ↩{turnStartEntryId}\n`；`renderActionLedger` 中 L5 走通用路径

- [ ] **Step 1: 写失败测试**

在 `tests/ledger.test.ts` 追加：

```ts
describe("L5 渲染：单条 + 锚点", () => {
  const mk5 = (id: string, desc: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 5,
    merged: { description: desc }, summary: { entries: [] },
  } as unknown as LedgerData);

  it("renderTurnText 输出含 ↩锚点", () => {
    const t = renderTurnText(mk5("abc123", "重构压缩管线"), 7);
    expect(t).toContain("T7 · 重构压缩管线");
    expect(t).toContain("↩abc123");
  });

  it("无 merged 时用占位描述，仍带锚点", () => {
    const l = mk5("abc123", "");
    delete (l as any).merged;
    const t = renderTurnText(l, 1);
    expect(t).toContain("（已合并）");
    expect(t).toContain("↩abc123");
  });

  it("相邻 L5 描述相同也不再聚合（各占一行、各带自己的锚点）", () => {
    const msg = renderActionLedger([mk5("id1", "同一描述"), mk5("id2", "同一描述")]);
    const text = (msg.content as any[])[0].text as string;
    expect(text).toContain("↩id1");
    expect(text).toContain("↩id2");
    expect(text).not.toContain("（2 条已合并）");
    expect(text).not.toContain("T1-T2");
  });

  it("L5 行不再出现「N 条已合并」计数后缀", () => {
    const msg = renderActionLedger([mk5("id1", "旧格式描述（3 条已合并）")]);
    const text = (msg.content as any[])[0].text as string;
    expect(text).toContain("旧格式描述（3 条已合并）"); // 存量原样保留
    expect(text).not.toContain("（3 条已合并）（3 条已合并）"); // 不重复追加
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL —— 无 `↩abc123`；聚合分支把两条并成一行

- [ ] **Step 3: 实现**

1. `renderTurnText` 的 L5 分支（89-93 行）改为：

```ts
  // L5：单 turn 的二次压缩描述，带 ↩锚点供召回（与 L3/L4 同为可召回层）
  if (lvl === 5) {
    const desc = l.merged?.description ?? "（已合并）";
    lines.push(`T${n} · ${desc} ↩${l.turnStartEntryId}`);
    return lines.join("\n") + "\n";
  }
```

2. `renderActionLedger` 中**整块删除** L5 聚合分支（169-192 行），使 L5 落入通用路径（193 行的 `renderTurnText(l, i + 1)`）：

```ts
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    lines.push(renderTurnText(l, i + 1).trimEnd());
    lines.push("");
  }
```

（即删除 `if ((l.level ?? 1) === 5) { ... continue; }` 整块。注意保留循环体的两行与循环外代码不变。）

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/ledger.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 干净

**必须删除的既有用例**（全部断言「聚合为一行 / 组范围标签 / 计数重写」，均为本设计废止的行为）：
- `tests/ledger.test.ts:147-155` —— `T1-T2 · 调查代码结构与配置逻辑` 聚合断言：**删除**
- `tests/ledger.test.ts:193-206` —— 两组聚合分别成行 + 同描述聚合：**删除**
- `tests/ledger.test.ts:210-215` —— 描述相同聚合 / 描述不同分断：**删除**
- `tests/ledger.test.ts:277-291` —— 计数重写（Codex P3）相关三条断言：**删除**
- `tests/ledger.test.ts:179-180` —— 单条 L5 渲染：**改写**为断言含 `↩` 锚点（新行为）
- `tests/ledger.test.ts:192` 的注释（提到 `mergeDescribe` 生成后缀）：**更新措辞**

- [ ] **Step 5: 提交**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat(l5): 渲染加 ↩锚点，删除聚合分支与计数重写（一 turn 一行）"
```

---

## Task 6: 召回层 — L5 并入 turn 级 + 删 rejected + searchLedger 去聚合

**Files:**
- Modify: `src/recall.ts:9`（`RecallResult.rejected`）、`src/recall.ts:59-91`（L5 拒绝分支）、`src/recall.ts:239-256`（searchLedger L5 段）
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: `levelOfTurn`（现有）、`serializeForRecall`、`truncateToTokens`
- Produces:
  - `RecallResult` 不再含 `rejected`（保留 `skipped`）
  - `executeRecall` 对 `lvl >= 3` 一律走 turn 级整段原文
  - `searchLedger` 对 L5 走与 L1–L4 相同的逐条路径

- [ ] **Step 1: 写失败测试**

在 `tests/recall.test.ts` 追加：

```ts
describe("L5 召回：与 L3/L4 同构", () => {
  const entry = (id: string, role: string, text: string): MessageEntry => ({
    id, message: { role, content: [{ type: "text", text }] },
  } as unknown as MessageEntry);

  it("L5 turn 返回整段原文（含工具过程），不再拒绝", () => {
    const entries = [entry("u1", "user", "用户原话内容"), entry("a1", "assistant", "回复正文内容")];
    const ctx = {
      ledgers: [{ turnStartEntryId: "u1", level: 5, summary: { entries: [] } } as unknown as LedgerData],
      turns: [{ startEntryId: "u1", endEntryId: "a1", entries }] as unknown as Turn[],
    };
    const r = executeRecall(["u1"], entries, 4_000, ctx);
    expect(r.text).toContain("用户原话内容");
    expect(r.text).not.toContain("不可恢复");
    expect(r.rejected).toBeUndefined();
  });

  it("L5 截断时给出 offset 续取提示（与 L3/L4 同款）", () => {
    const long = "很长内容".repeat(5_000);
    const entries = [entry("u1", "user", long)];
    const ctx = {
      ledgers: [{ turnStartEntryId: "u1", level: 5, summary: { entries: [] } } as unknown as LedgerData],
      turns: [{ startEntryId: "u1", endEntryId: "u1", entries }] as unknown as Turn[],
    };
    const r = executeRecall(["u1"], entries, 100, ctx);
    expect(r.text).toContain("已截断");
    expect(r.text).toContain("offset=");
  });

  it("searchLedger 命中 L5 时逐条返回，不再聚合成组范围标签", () => {
    const l5 = (id: string, desc: string): LedgerData => ({
      turnStartEntryId: id, turnEndEntryId: id + "-e", level: 5,
      merged: { description: desc },
      userMessage: { entryId: id + "-u", text: "用户消息" + id },
      summary: { entries: [] },
    } as unknown as LedgerData);
    const r = searchLedger("同一关键词", [l5("a", "同一关键词甲"), l5("b", "同一关键词乙")], 10);
    const labels = r.hits.map((h) => h.turnLabel);
    expect(labels).toContain("T1");
    expect(labels).toContain("T2");
    expect(labels.some((x) => x.includes("-"))).toBe(false); // 无组范围标签
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/recall.test.ts`
Expected: FAIL —— 出现「不可恢复」；`rejected` 仍存在；searchLedger 返回 `T1-T2`

- [ ] **Step 3: 实现**

1. `RecallResult` 接口（第 9 行）删除 `rejected?: number`：

```ts
export interface RecallResult { text: string; missing: string[]; notesHits: number; images: RecallImage[]; skipped?: number }
```

2. `executeRecall` 内：删除 `let rejected = 0;` 声明、`lvl === 5` 拒绝分支整块、返回值中的 `rejected`，并把 turn 级条件放宽：

```ts
    if (turn && lvl >= 3) {
```

（原为 `lvl >= 3 && lvl <= 4`。分支体内部**零改动**。）

3. 同上，把 `offset > 0 && ids.length !== 1` 的提前返回里的 `rejected: 0` 删除。

4. 返回语句改为：

```ts
  return { text: parts.join("\n\n") || "（无内容）", missing, notesHits: 0, images };
```

5. `executeRecallDual`：删除 `let rejected = 0;`、`rejected = r.rejected ?? 0;`、返回对象中的 `rejected`（保留 `skipped`）。

6. `searchLedger`：删除 L5 专属分支（239-256 行整块），使 L5 走通用路径：

```ts
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    const lvl = (l.level ?? 1) as LedgerLevel;
    const label = `T${i + 1}`;
    if (lvl === 5) {
      if (l.merged?.description) push(label, 5, "合并描述", l.merged.description, allRecallIdsOf(l, true));
      continue;
    }
    if (l.userMessage) push(label, lvl, "用户消息", l.userMessage.text, [l.userMessage.entryId]);
    if (l.finalReply) push(label, lvl, "最终回复", l.finalReply.text, [l.finalReply.entryId]);
    for (const e of l.summary.entries ?? legacyGroups(l)) {
      push(label, lvl, "动作", `${e.target} → ${e.detail}`, e.recallIds);
    }
  }
```

更新 `SearchHit.level` 与 `searchLedger` 的 JSDoc：删除「连续 level=4 聚合为一组」「L5 拒绝召回」等表述，改为「每 turn 独立成组（一 turn 一行，与渲染层同口径）」。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/recall.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 干净

**必须删除/改写的既有用例**：
- `tests/recall.test.ts:323-328` —— 「L5 的 ID 拒绝召回…rejected 单独计数（M9）」整块：**改写**为「L5 与 L3/L4 同构，返回整段原文」（新用例已覆盖，可直接删除旧块）

- [ ] **Step 5: 提交**

```bash
git add src/recall.ts tests/recall.test.ts
git commit -m "feat(l5): 召回并入 turn 级路径，删除 rejected 与检索聚合"
```

---

## Task 7: 接线与统计 — 删除 rejected

**Files:**
- Modify: `src/index.ts:103`、`177`、`361`、`365`、`505`
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: `RecallResult`（Task 6，已无 `rejected`）
- Produces: `recallStats` 无 `rejected` 字段；`/compress-status` 不再显示「L5 拒绝」

- [ ] **Step 1: 改写失败测试**

**改写**既有用例 `tests/extension.test.ts:290-308`（「compress-status 统计口径：L5 拒绝计入「L5 拒绝」不计入取回（M9）」）。改为：同一场景下，**L5 的 ID 现在正常取回**，status 输出**不含**「L5 拒绝」，且取回数含该 ID。

```ts
it("compress-status：L5 不再拒绝，正常计入取回", async () => {
  // 沿用该用例原有的 harness 与 L5 fixture 构造方式
  // ... 触发一次对 L5 ID 的 recall ...
  expect(out).not.toContain("L5 拒绝");
  // 取回计数包含该 ID（不再从 hits 中扣除）
});
```

执行者需按该用例原有结构改写，保留其 fixture 与 harness 调用方式。

- [ ] **Step 2: 运行，确认失败**

Run: `npx vitest run tests/extension.test.ts`
Expected: FAIL —— 旧用例断言「L5 拒绝 1 个」，改写后该断言被移除、新断言未满足

- [ ] **Step 3: 实现**

`src/index.ts`：

1. 第 103 行与第 177 行：从 `recallStats` 初始化对象中删除 `rejected: 0`。
2. 第 361 行：改为 `recallStats.hits += params.ids.length - r.missing.length - skipped;`
3. 第 365 行：删除 `recallStats.rejected += r.rejected ?? 0;` 整行。
4. 第 505 行：从状态行中删除 ` / L5 拒绝 ${recallStats.rejected}` 片段。

- [ ] **Step 4: 运行，确认通过**

Run: `npx vitest run tests/extension.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 干净（tsc 会捕获任何遗漏的 `rejected` 引用）

- [ ] **Step 5: 全量回归**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿，tsc 干净。基线 347 → 预期约 370+。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts tests/extension.test.ts
git commit -m "refactor(l5): 删除 rejected 统计与状态展示"
```

---

## Task 8: 文档 — README 与已知限制

**Files:**
- Modify: `README.md`

**Interfaces:** 无代码接口

- [ ] **Step 1: 定位待改处**

Run: `grep -n "L5\|合并\|已合并\|不可恢复\|拒绝" README.md`

- [ ] **Step 2: 改写**

1. **阶梯描述**：把 L5 从「多 turn 合并为一行主题描述」改为「每条 L4 逐条二次压缩为一条描述（批量调用，N=20）」。
2. **召回说明**：把三档路由（L1/L2 entry、L3/L4 turn、L5 拒绝）改为两档（**L1/L2 entry 级、L3/L4/L5 turn 级**）。
3. **删除**任何「L5 细节不可恢复」「拒绝召回」的表述。
4. **新增已知限制**：「L5 层体积比旧合并形态更大（压缩率约 0.49）；存量旧 L5 数据不做迁移，与新数据混排时视觉上「旧的粗、新的细」会并存」。
5. **`merged` 字段说明**：语义为「该 turn 自己的二次压缩描述」（字段名未改，兼容存量）。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 L5 逐条压缩语义与两档召回"
```

---

## 收尾检查

- [ ] **全量测试**：`npx vitest run` → 全绿
- [ ] **类型检查**：`npx tsc --noEmit` → 干净
- [ ] **残留引用**：`grep -rn "mergeDescribe\|mergeGroups\|buildMergeDescriptionPrompt\|rejected\|条已合并" src/` → 仅剩存量兼容相关（如 ledger 渲染对旧后缀的原样透传）
- [ ] **工作区干净**：`git status --porcelain`
- [ ] **缺省路径防护**：确认 `tests/ledger.test.ts` 中「不含 L5 的会话渲染逐字节不变」用例仍通过
- [ ] **合并方式**：待用户裁定（不合并 main 执行本计划）

---

## Self-Review 记录

**Spec 覆盖**：R1（Task 1/2/3/4）、R2（Task 2/4）、R3（Task 6）、R4（Task 5）、R5（无代码，仅文档 Task 8）——全覆盖。
**占位符扫描**：无 TODO/TBD；所有代码步骤含实际代码。
**类型一致性**：`recompressBatched` 返回 `Array<string | null>`（Task 2 定义 → Task 4 消费）；`L5_BATCH_SIZE`（Task 2 → Task 4）；`RecallResult` 去 `rejected`（Task 6 → Task 7）；`DegradePlan` 去 `mergeGroups`（Task 3 → Task 4/6）。
**已识别的中间态**：Task 3 提交后 L5 功能暂失效，Task 4 恢复（已在该任务中标注，执行者可合并两者）。
**既有测试改写清单**：已在「文件结构」表后列出全部 7 个文件、14 处，行号均已对照基线核对。
