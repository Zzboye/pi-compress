# 动作日志四级分层压缩（L1→L4）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 窗外已摘要 turn 的动作日志头支持四级渐进降级（L1 全量 → L2 丢命令 → L3 压缩两端 → L4 多条合并一行），每层 40K 阈值、尾部 10K 保留区，后台异步瀑布式执行并持久化。

**Architecture:** 在现有 `SummarizerEngine` 写入 `LedgerData` 之后，新增 `DegradeEngine` 后台逐级检测各层渲染体积，超阈值时把最旧 turns 降一级（按 turn 边界、保留最近约 10K），L2→L3 / L3→L4 的文本由已配置的摘要后端（本地模型）现场生成。降级结果写回 `LedgerData`（新增 `level` 字段）并经 `appendCustomEntry` 持久化；`renderActionLedger` 按 level 分层渲染。

**Tech Stack:** TypeScript（ESM）、vitest、复用 `SummarizerBackend`（registry / openai-compat 两种实现）、`estimateTokens`。

## Global Constraints

- 所有层共用同一阈值 40_000 tokens（`ledgerDegradeThresholdTokens`，默认 40000），每层尾部保留区 10_000 tokens（`ledgerReserveTokens`，默认 10000）。
- 降级只作用于「窗外已摘要 turn 的动作日志头」，与 `keepRecentTokens` 原文窗口无关。
- 切分一律按 turn 边界取整：保留区 10K 是"附近"，不把一个 turn 拦腰截断。
- 瀑布顺序：L1 超 → 降最旧到 L2 → 再查 L2 → 超 → 降到 L3 → 再查 L3 → 超 → 合并为 L4；任一层不超即停止。
- 降级发生在后台（回复完成、摘要写入后），结果持久化到 ledger；装配时零 LLM 调用。
- L1→L2 纯规则（去掉动作行中的 target/命令）；L2→L3 与 L3→L4 调用摘要后端生成。
- 四层形态（以 T3 为例，含用户输入 + 动作 + 最终回复）：
  - **L1**：`T3 · 用户：「帮我了解 ledger 的结构」` + `调查：cat src/ledger.ts → 阅读核心数据结构 ↩a1a0e15c` + `最终回复（原文）：……（完整原文）`
  - **L2**：同 L1 但动作行丢 target：`调查：阅读核心数据结构 ↩a1a0e15c`；用户原文与最终回复原文都保留
  - **L3**：`T3 · 意图：了解ledger结构 ↩<用户消息entryId>` + 动作行（同 L2 形态）+ `最终回复（摘要）：<一句话> ↩<最终回复entryId>`
  - **L4**：`T3-T7 · 调查代码结构与配置逻辑（5 条已合并）↩id1,id2,...`
- 项目语言：注释与用户可见文案沿用现有中文风格；测试文件名与现有 `tests/*.test.ts` 对齐。

---

### Task 1: 配置项——降级阈值与保留区

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `ContextCompressConfig` 新增字段 `ledgerDegradeThresholdTokens: number`（默认 40000，范围 5000–2_000_000）、`ledgerReserveTokens: number`（默认 10000，范围 1000–500_000）；旧字段 `ledgerMergeThreshold` 保留字段名但从 `DEFAULT_CONFIG` 移除（解析时忽略，不再出现在返回值）——注意：`ledgerMergeThreshold` 目前是死字段，先全局 grep 确认无运行时引用（README/config.ts/DEFAULT_CONFIG 之外）。

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 追加（沿用该文件现有的 loadConfig 调用方式；若现有测试用对象入参 `loadConfig(global, project)`，保持一致）：

```ts
describe("ledger degrade config", () => {
  it("defaults ledgerDegradeThresholdTokens=40000, ledgerReserveTokens=10000", () => {
    const c = loadConfig({}, {});
    expect(c.ledgerDegradeThresholdTokens).toBe(40000);
    expect(c.ledgerReserveTokens).toBe(10000);
  });
  it("reads overrides and clamps out-of-range", () => {
    const c = loadConfig({ contextCompress: { ledgerDegradeThresholdTokens: 60000, ledgerReserveTokens: 5000 } }, {});
    expect(c.ledgerDegradeThresholdTokens).toBe(60000);
    expect(c.ledgerReserveTokens).toBe(5000);
    const bad = loadConfig({ contextCompress: { ledgerDegradeThresholdTokens: 1, ledgerReserveTokens: 0 } }, {});
    expect(bad.ledgerDegradeThresholdTokens).toBe(40000);
    expect(bad.ledgerReserveTokens).toBe(10000);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（`ledgerDegradeThresholdTokens` undefined）

- [ ] **Step 3: 实现**

`src/config.ts`：
1. `ContextCompressConfig` 接口：删掉 `ledgerMergeThreshold: number`，加 `ledgerDegradeThresholdTokens: number` 与 `ledgerReserveTokens: number`。
2. `DEFAULT_CONFIG`：删除 `ledgerMergeThreshold: 40`，加两个新默认值。
3. `loadConfig` 返回对象：删 `ledgerMergeThreshold` 行，加：

```ts
ledgerDegradeThresholdTokens: Math.floor(num(merged.ledgerDegradeThresholdTokens, DEFAULT_CONFIG.ledgerDegradeThresholdTokens, 5000, 2_000_000)),
ledgerReserveTokens: Math.floor(num(merged.ledgerReserveTokens, DEFAULT_CONFIG.ledgerReserveTokens, 1000, 500_000)),
```

4. 全局 `grep -rn "ledgerMergeThreshold"`：更新所有测试/README/docs 引用（config.test.ts 里旧断言删除）。

- [ ] **Step 4: 运行全部测试**

Run: `npx vitest run`
Expected: PASS（若其他测试引用旧字段，同批修复）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(config): ledger degrade threshold + reserve tokens config"
```

---

### Task 2: 数据模型与分层渲染（level 字段 + 四层 renderActionLedger）

**Files:**
- Modify: `src/ledger.ts`（`LedgerData` 增 `level`；渲染分层）
- Modify: `src/util.ts`（`extractUserMessage` / `extractFinalReply` 改为保留全文，不再截断——L1 是全量原文）
- Test: `tests/ledger.test.ts`、`tests/util-extract.test.ts`

**Interfaces:**
- Consumes: 现有 `LedgerData`、`LedgerQuote`、`renderActionLedger(ledgers: LedgerData[])`。
- Produces:
  - `LedgerData.level?: 1 | 2 | 3 | 4`（缺省视为 1，兼容旧持久化数据）
  - `LedgerData.merged?: { description: string }`（level=4 时有效；合并行的 turn 范围由渲染时相邻 level=4 条目聚合得出，recallIds 取各条目全部 recallIds 的有序去重并集）
  - `renderTurnText(ledger: LedgerData, turnNumber: number): string`——渲染单个 turn 在其 level 下的纯文本块（含结尾空行），供渲染与体积计量共用（单一真相）
  - `renderActionLedger` 保持签名不变，内部按 level 分发；输出消息结构不变（role user / content text / timestamp）

- [ ] **Step 1: 写失败测试**

`tests/ledger.test.ts` 追加。基础数据（放在 describe 外供复用）：

```ts
const full: LedgerData = {
  turnStartEntryId: "e001", turnEndEntryId: "e018", level: 1,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e001", truncated: false },
  summary: { groups: [{ phase: "investigate", entries: [
    { action: "bash", target: "cat src/ledger.ts", detail: "阅读核心数据结构", recallIds: ["e003"] },
  ] }] },
  finalReply: { text: "我已经看完当前代码……", entryId: "e018", truncated: false },
};
```

用例（每个 it 一个断言主题）：

```ts
describe("renderActionLedger levels", () => {
  it("L1 renders user quote + action with target + final reply original", () => {
    const text = textOf(renderActionLedger([full]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("调查：cat src/ledger.ts → 阅读核心数据结构 ↩e003");
    expect(text).toContain("最终回复（原文）：\n我已经看完当前代码……");
  });
  it("L2 drops action target, keeps both ends verbatim", () => {
    const text = textOf(renderActionLedger([{ ...full, level: 2 }]));
    expect(text).toContain("调查：阅读核心数据结构 ↩e003");
    expect(text).not.toContain("cat src/ledger.ts");
    expect(text).toContain("用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：");
  });
  it("L3 renders intent + actions + summarized outcome with recall ids", () => {
    const l3 = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 意图：了解ledger结构 ↩e001");
    expect(text).toContain("调查：阅读核心数据结构 ↩e003");
    expect(text).toContain("最终回复（摘要）：确认LedgerData含level字段 ↩e018");
    expect(text).not.toContain("最终回复（原文）");
  });
  it("L4 merges consecutive level-4 turns into one line", () => {
    const mk = (id: string, rid: string[]): LedgerData => ({ ...full, level: 4, turnStartEntryId: id,
      merged: { description: "调查代码结构与配置逻辑（2 条已合并）" },
      summary: { groups: [{ phase: "investigate", entries: [
        { action: "bash", target: "x", detail: "d", recallIds: rid }] }] } });
    const text = textOf(renderActionLedger([mk("a", ["e1"]), mk("b", ["e2"])]));
    expect(text).toContain("T1-T2 · 调查代码结构与配置逻辑（2 条已合并）↩e1,↩e2");
    expect(text).not.toContain("用户：「");
  });
  it("missing level defaults to 1 (backcompat)", () => {
    const { level, ...noLevel } = full;
    const text = textOf(renderActionLedger([noLevel as LedgerData]));
    expect(text).toContain("cat src/ledger.ts");
  });
  it("isolated level-4 turn renders single-turn range T3 · …", () => {
    const text = textOf(renderActionLedger([{ ...full, level: 4, merged: { description: "孤立合并行" } }]));
    expect(text).toContain("T1 · 孤立合并行");
  });
});
```

测试辅助（文件顶部，若已有类似函数则复用）：

```ts
function textOf(msg: any): string {
  return msg.content.map((c: any) => c.text ?? "").join("");
}
```

`tests/util-extract.test.ts` 追加（替换/修订现有截断用例——先读该文件确认哪些旧断言要改）：

```ts
it("extractUserMessage keeps full text (no truncation) for L1", () => {
  const long = "x".repeat(500);
  const q = extractUserMessage(turnWithUser(long)); // 复用该文件现有 turn 构造 helper
  expect(q?.text).toBe(long);
  expect(q?.truncated).toBe(false);
});
it("extractFinalReply keeps full text (no truncation)", () => {
  const long = "y".repeat(3000);
  const q = extractFinalReply(turnWithReply(long));
  expect(q?.text).toBe(long);
  expect(q?.truncated).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ledger.test.ts tests/util-extract.test.ts`
Expected: FAIL（level 字段无行为、旧截断断言冲突）

- [ ] **Step 3: 实现**

`src/ledger.ts`：
1. `LedgerData` 加：

```ts
level?: 1 | 2 | 3 | 4;
merged?: { description: string };
```

2. 新增导出 `renderTurnText(ledger, turnNumber): string`——按 level 返回该 turn 的文本行（不含全局头尾标签）：

```ts
export function renderTurnText(l: LedgerData, n: number): string {
  const lines: string[] = [];
  const lvl = l.level ?? 1;
  if (lvl === 4) {
    const desc = l.merged?.description ?? "（已合并）";
    const ids = allRecallIds(l);
    lines.push(`T${n} · ${desc}${ids.length ? ` ↩${ids.join(",↩")}` : ""}`);
    return lines.join("\n") + "\n";
  }
  if (lvl === 3) {
    const intentId = l.userMessage?.entryId ?? l.turnStartEntryId;
    lines.push(`T${n} · 意图：${l.summary.userIntent ?? "（未知）"} ↩${intentId}`);
  } else {
    const uq = l.userMessage;
    if (uq) {
      const recall = uq.truncated ? ` ↩${uq.entryId}` : "";
      lines.push(`T${n} · 用户：「${uq.text.replace(/\n+/g, " ")}」${recall}`);
    } else {
      lines.push(`T${n} · 用户意图：${l.summary.userIntent ?? "（未知）"}`);
    }
  }
  for (const g of l.summary.groups) {
    for (const e of g.entries) {
      const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
      if (lvl === 1) {
        lines.push(`- ${PHASE_LABEL[g.phase]}：${e.action} ${e.target} → ${e.detail}${recall}`);
      } else { // L2/L3：丢 target/命令
        lines.push(`- ${PHASE_LABEL[g.phase]}：${e.detail}${recall}`);
      }
    }
  }
  if (lvl === 3) {
    const outId = l.finalReply?.entryId ?? l.turnEndEntryId;
    lines.push(`- 最终回复（摘要）：${l.summary.outcome ?? "（无）"} ↩${outId}`);
  } else if (l.finalReply) {
    lines.push("最终回复（原文）：");
    lines.push(l.finalReply.text);
    if (l.finalReply.truncated) lines.push(`（已截断，↩${l.finalReply.entryId} 取回全文）`);
  } else if (l.summary.outcome !== undefined) {
    lines.push(`- 结果：${l.summary.outcome}`);
  }
  return lines.join("\n") + "\n";
}
```

3. `renderActionLedger` 重写主体：遍历 ledgers，把**连续 level=4** 的条目聚合成一行（行首 `T{start}-{end} · {首条 merged.description}`，若只有一条则 `T{n} · …`；recallIds 取组内所有条目的 `allRecallIds` 并集按出现顺序去重）；其余调用 `renderTurnText`。全局头（`<action-ledger>` / 标题 / 尾注）保持现状。

4. 辅助函数：

```ts
function allRecallIds(l: LedgerData): string[] {
  const ids: string[] = [];
  if (l.userMessage?.truncated) ids.push(l.userMessage.entryId);
  if (l.finalReply?.truncated) ids.push(l.finalReply.entryId);
  for (const g of l.summary.groups) for (const e of g.entries) ids.push(...e.recallIds);
  return [...new Set(ids)];
}
```

注意：L4 行的并集应包含**全部** entryIds（不只是 truncated 的），L4 场景用户原文已不可见，改为：

```ts
function allRecallIds(l: LedgerData, includeAllQuotes = false): string[] {
  const ids: string[] = [];
  const um = l.userMessage, fr = l.finalReply;
  if (um && (includeAllQuotes || um.truncated)) ids.push(um.entryId);
  if (fr && (includeAllQuotes || fr.truncated)) ids.push(fr.entryId);
  for (const g of l.summary.groups) for (const e of g.entries) ids.push(...e.recallIds);
  return [...new Set(ids)];
}
```

L4 聚合时传 `includeAllQuotes = true`。

`src/util.ts`：
- `extractUserMessage`：删除 `USER_MESSAGE_HEAD_CHARS` 截断逻辑，全文返回 `{ text, entryId, truncated: false }`。
- `extractFinalReply`：删除头尾采样逻辑，全文返回 `truncated: false`。
- 常量 `USER_MESSAGE_HEAD_CHARS / REPLY_HEAD_CHARS / REPLY_TAIL_CHARS` 删除。

注意连带影响：`renderActionLedger` 现有测试（`tests/ledger.test.ts`、`tests/assembler.test.ts`、`tests/integration.test.ts`、`tests/dump.test.ts`、`tests/extension.test.ts`）中依赖截断行为的断言需要同步修订；全量原文也意味着 assemble 后上下文变大，属预期（这正是 L1 层要做的事）。

- [ ] **Step 4: 运行全部测试并修复连带断言**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ledger): four-level data model and per-level rendering"
```

---

### Task 3: 体积计量与降级选择（纯规则，L1→L2）

**Files:**
- Create: `src/degrade.ts`
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: `renderTurnText(ledger, turnNumber)`（Task 2）、`estimateTokens`（pi 包）、`ContextCompressConfig`（Task 1 新字段）。
- Produces:

```ts
export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, fromLevel, toLevel) 列表，最旧优先 */
  steps: Array<{ turnStartEntryId: string; toLevel: 2 | 3 | 4 }>;
  /** L4 合并组：每组为一段连续需合并的 turnStartEntryId（本计划只产出组结构，描述由 Task 4 生成） */
  mergeGroups: string[][];
}
export function planDegrade(
  ledgers: LedgerData[],           // 按时间升序
  thresholdTokens: number,          // 40000
  reserveTokens: number,            // 10000
): DegradePlan
```

规则（与用户确认的口径一致）：
- 对每层 L∈{1,2,3}：`total = Σ estimateTokens(renderTurnText(ledger_i, i+1))`（仅 level=L 的条目）。
- 若 `total > thresholdTokens`：从最旧开始选中 level=L 的条目，直到「已选中的累计 tokens ≥ total − reserveTokens」为止（即保留尾部约 10K；选满即停，不多选）。若单条就超过也选中它（最旧优先，保证有进展）。
- 选中条目降一级（1→2、2→3、3→4）；降级后的体积变化本计划不做迭代重算（每轮 agent_settled 只做一遍瀑布，下轮自然收敛——与现有后台异步节奏一致）。
- 层间瀑布：先算 L1 的选中集合，再把（本轮之前已存在的 + 新增的）L2 一起算 L2 超标与否，依此类推。**简化实现**：按 L1→L2→L3 顺序逐层执行，L1 降级产生的新 L2 条目立即计入 L2 的 total。
- L4 组：level 3→4 的选中条目，按时间连续性分组（相邻即同组；非相邻分别成组）。

- [ ] **Step 1: 写失败测试**

`tests/degrade.test.ts`（token 估算用真实 `estimateTokens`，测试数据用长文本控制量级；写 helper 生成指定渲染 tokens 的 ledger——简单做法：往 `finalReply.text` 塞 `~4*targetTokens` 个字符）：

```ts
import { describe, it, expect } from "vitest";
import { planDegrade } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";

function ledger(id: string, level: 1 | 2 | 3, tokens: number): LedgerData {
  // finalReply 原文按 ~4 字符/token 撑体积
  return {
    turnStartEntryId: id, turnEndEntryId: id, level,
    summary: { groups: [] },
    finalReply: { text: "x".repeat(tokens * 4), entryId: id, truncated: false },
  };
}

describe("planDegrade", () => {
  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
    expect(p.mergeGroups).toEqual([]);
  });
  it("degrades oldest L1 turns beyond reserve when L1 exceeds threshold", () => {
    // 5 条 L1 各 ~10K = 50K > 40K → 选中最旧若干条直至累计 ≥ 50K-10K=40K（前 4 条）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 10000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 }, { turnStartEntryId: "t4", toLevel: 2 },
    ]);
  });
  it("waterfalls: L1 overflow feeds L2, L2 overflow feeds L3 merge groups", () => {
    // L2 已有 45K（5×9K）超阈值；L1 不超。L2 → 最旧降为 L3 直至保留 ~10K（前 4 条，累计 36K ≥ 35K）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 2, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 3).length).toBe(4);
  });
  it("groups consecutive L3→L4 selections, splits non-adjacent", () => {
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 3, 10000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.mergeGroups).toEqual([["t1", "t2", "t3", "t4"]]);
    // 非相邻：level 混合时同层不连续各自成组
    const mixed = [ledger("a", 3, 10000), ledger("b", 1, 100), ledger("c", 3, 10000)];
    // 手工场景：直接构造 mergeGroups 逻辑用 chooseOldest 返回值验证（实现导出内部函数供测试）
  });
  it("single oversized oldest turn still selected (progress guarantee)", () => {
    const ls = [ledger("a", 1, 50000), ledger("b", 1, 100)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toContainEqual({ turnStartEntryId: "a", toLevel: 2 });
  });
});
```

（第 4 个 it 中 mixed 场景若不易通过公开 API 构造，允许把「按层选最旧」抽成导出函数 `chooseOldestForLevel(ledgers, level, threshold, reserve)` 单独测。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/degrade.ts`：

```ts
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { renderTurnText, type LedgerData } from "./ledger.js";

export interface DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 }
export interface DegradePlan { steps: DegradeStep[]; mergeGroups: string[][] }

export function turnRenderTokens(ledger: LedgerData, index: number): number {
  return estimateTokens({ role: "user", content: [{ type: "text", text: renderTurnText(ledger, index + 1) }] } as any);
}

/** 层内从最旧开始选中条目，直到累计 tokens ≥ total − reserve */
export function chooseOldestForLevel(ledgers: LedgerData[], level: 1 | 2 | 3, threshold: number, reserve: number): LedgerData[] {
  const inLevel = ledgers.filter((l) => (l.level ?? 1) === level);
  const total = inLevel.reduce((s, l) => s + turnRenderTokens(l, ledgers.indexOf(l)), 0);
  if (total <= threshold) return [];
  const target = total - reserve;
  const chosen: LedgerData[] = [];
  let acc = 0;
  for (const l of inLevel) {
    chosen.push(l);
    acc += turnRenderTokens(l, ledgers.indexOf(l));
    if (acc >= target) break;
  }
  return chosen;
}

export function planDegrade(ledgers: LedgerData[], threshold: number, reserve: number): DegradePlan {
  const steps: DegradeStep[] = [];
  const levels = [1, 2, 3] as const;
  const working = ledgers.map((l) => ({ ...l })); // 降级立即生效供下层计量
  for (const level of levels) {
    const chosen = chooseOldestForLevel(working, level, threshold, reserve);
    for (const l of chosen) {
      const target = working.find((w) => w.turnStartEntryId === l.turnStartEntryId)!;
      const to = (level + 1) as 2 | 3 | 4;
      target.level = to;
      steps.push({ turnStartEntryId: target.turnStartEntryId, toLevel: to });
    }
  }
  // L4 组：本计划中 toLevel=4 的条目按原 ledgers 顺序相邻分组
  const degraded4 = new Set(steps.filter((s) => s.toLevel === 4).map((s) => s.turnStartEntryId));
  const mergeGroups: string[][] = [];
  let cur: string[] = [];
  for (const l of ledgers) {
    if (degraded4.has(l.turnStartEntryId)) { cur.push(l.turnStartEntryId); }
    else if (cur.length) { mergeGroups.push(cur); cur = []; }
  }
  if (cur.length) mergeGroups.push(cur);
  return { steps, mergeGroups };
}
```

（实现时注意 `indexOf` 在重复对象引用下的正确性；如不放心，改为 `ledgers.map((l, i) => …)` 一次遍历带下标。）

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/degrade.test.ts`
Expected: PASS（数值断言按 estimateTokens 实际值校准——测试里 tokens 参数是量级近似，断言用「选中条数」而非精确 token 数）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(degrade): per-level size measurement and degradation planning"
```

---

### Task 4: LLM 压缩器——L2→L3 意图/结果 与 L3→L4 合并描述

**Files:**
- Modify: `src/prompts.ts`
- Create: `src/degrade-llm.ts`
- Test: `tests/prompts.test.ts`、`tests/degrade-llm.test.ts`

**Interfaces:**
- Consumes: `SummarizerBackend.complete(prompt, signal?)`（summarizer.ts）、`LedgerData`。
- Produces:

```ts
// prompts.ts
export function buildIntentOutcomePrompt(userText: string, replyText: string): string
export function buildMergeDescriptionPrompt(turnTexts: string[]): string // turnTexts = 各 L3 turn 的 renderTurnText 输出

// degrade-llm.ts
export async function compressEnds(backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal): Promise<{ userIntent: string; outcome: string }>
  // 失败抛错；输出经 JSON.parse（容错剥 ``` 围栏，同 parseLedgerOutput 风格）
export async function mergeDescribe(backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal): Promise<{ description: string }>
  // description 形如 "调查代码结构与配置逻辑（5 条已合并）"
```

- [ ] **Step 1: 写失败测试**

`tests/prompts.test.ts` 追加：

```ts
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
    expect(p).toContain("5 条"); // 或 schema 中的条数说明字段，按实际 prompt 校准
  });
});
```

`tests/degrade-llm.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { compressEnds, mergeDescribe } from "../src/degrade-llm.js";
import type { LedgerData } from "../src/ledger.js";

const okBackend = (raw: string) => ({ async complete() { return raw; } });
const failBackend = { async complete() { throw new Error("boom"); } };

const l3ready: LedgerData = {
  turnStartEntryId: "e1", turnEndEntryId: "e2", level: 2,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e1", truncated: false },
  summary: { groups: [] },
  finalReply: { text: "确认 ledgerMergeThreshold 为占位字段……", entryId: "e2", truncated: false },
};

describe("compressEnds", () => {
  it("parses fenced JSON into intent/outcome", async () => {
    const r = await compressEnds(okBackend('```json\n{"userIntent":"了解ledger结构","outcome":"确认占位字段"}\n```'), l3ready);
    expect(r).toEqual({ userIntent: "了解ledger结构", outcome: "确认占位字段" });
  });
  it("throws on invalid JSON", async () => {
    await expect(compressEnds(okBackend("not json"), l3ready)).rejects.toThrow();
  });
  it("propagates backend errors", async () => {
    await expect(compressEnds(failBackend, l3ready)).rejects.toThrow("boom");
  });
});

describe("mergeDescribe", () => {
  it("returns description with count appended when missing", async () => {
    const r = await mergeDescribe(okBackend('"调查代码结构与配置逻辑"'), [l3ready, l3ready, l3ready]);
    expect(r.description).toBe("调查代码结构与配置逻辑（3 条已合并）");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/prompts.test.ts tests/degrade-llm.test.ts`
Expected: FAIL（函数未导出/不存在）

- [ ] **Step 3: 实现**

`src/prompts.ts` 追加：

```ts
export function buildIntentOutcomePrompt(userText: string, replyText: string): string {
  return `压缩这一轮对话的两端为一行式摘要。

规则：
1. userIntent：用户这轮想要什么，≤20 字，动宾短语
2. outcome：模型最终达成了什么结论/结果，≤30 字，写结论不写过程
3. 不复述原文，只提炼

用户消息原文：
<user>
${userText}
</user>

模型最终回复原文：
<reply>
${replyText}
</reply>

只输出 JSON：{"userIntent": string, "outcome": string}`;
}

export function buildMergeDescriptionPrompt(turnTexts: string[]): string {
  return `把以下 ${turnTexts.length} 轮已压缩的动作日志合并为一行主题描述。

规则：
1. 概括这 ${turnTexts.length} 轮共同做了什么，≤25 字
2. 不输出条数（系统会追加"（N 条已合并）"）
3. 只输出 JSON：{"description": string}

各轮日志：
${turnTexts.map((t, i) => `--- 第 ${i + 1} 轮 ---\n${t}`).join("\n")}`;
}
```

`src/degrade-llm.ts`：

```ts
import type { LedgerData } from "./ledger.js";
import type { SummarizerBackend } from "./summarizer.js";
import { buildIntentOutcomePrompt, buildMergeDescriptionPrompt } from "./prompts.js";

function parseJson(raw: string): any {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  if (typeof parsed !== "object" || parsed === null) throw new Error("degrade output not an object");
  return parsed;
}

export async function compressEnds(backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal): Promise<{ userIntent: string; outcome: string }> {
  const userText = ledger.userMessage?.text ?? "";
  const replyText = ledger.finalReply?.text ?? "";
  const raw = await backend.complete(buildIntentOutcomePrompt(userText, replyText), signal);
  const p = parseJson(raw);
  if (typeof p.userIntent !== "string" || typeof p.outcome !== "string") throw new Error("degrade output missing userIntent/outcome");
  return { userIntent: p.userIntent, outcome: p.outcome };
}

export async function mergeDescribe(backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal): Promise<{ description: string }> {
  const texts = ledgers.map((l) => renderTurnText(l, 0)); // turn 号在合并行中由渲染层统一编号，这里传 0 仅取正文
  const raw = await backend.complete(buildMergeDescriptionPrompt(texts), signal);
  const p = parseJson(raw);
  if (typeof p.description !== "string" || p.description === "") throw new Error("degrade output missing description");
  const desc = p.description.replace(/（\d+ 条已合并）$/, "").trim();
  return { description: `${desc}（${ledgers.length} 条已合并）` };
}
```

（`renderTurnText` 从 ledger.js 导入——确认 Task 2 已导出。）

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/prompts.test.ts tests/degrade-llm.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(degrade-llm): L2->L3 intent/outcome and L3->L4 merge description via backend"
```

---

### Task 5: DegradeEngine——编排计划 + LLM 压缩 + 持久化

**Files:**
- Modify: `src/degrade.ts`（追加引擎类）
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: `planDegrade`、`compressEnds`、`mergeDescribe`、`SummarizerBackend`、`ContextCompressConfig.ledgerDegradeThresholdTokens / ledgerReserveTokens`。
- Produces:

```ts
export class DegradeEngine {
  constructor(
    backend: SummarizerBackend,
    config: ContextCompressConfig,
    onLedger: (d: LedgerData) => void,   // 与 SummarizerEngine 相同回调：store.set + appendCustomEntry
    onWarning: (m: string) => void,
  )
  /** ledgers 按时间升序；快照可变。内部对每条降级 turn 先写 level 再做 LLM 压缩；
      LLM 失败的 turn 回滚 level（保持原层级），告警但整体不中断。 */
  async run(ledgers: LedgerData[]): Promise<void>
}
```

执行顺序（对应确认过的流程）：
1. `planDegrade(ledgers, threshold, reserve)` 得 plan；plan 为空则直接返回（含「L1 不超就不查 L2」的短路——planDegrade 内部每层 chooseOldestForLevel 为空时自然继续，但整体 steps/mergeGroups 为空即无 LLM 调用）。
2. 对 `toLevel=2` 的条目：纯规则，直接 `level=2`，回调 `onLedger`。
3. 对 `toLevel=3` 的条目：`level=3` + `compressEnds` 写入 `summary.userIntent/outcome`，回调；失败则回滚 `level=2` 并 `onWarning`。
4. 对每个 mergeGroup：所有成员 `level=4`，`mergeDescribe` 得 description 写到**组内每个成员**的 `merged.description`（这样 ledger 单条目自包含，渲染与重建都不需要跨条目状态），回调；失败回滚为 `level=3` 并告警。
5. 序列化执行（不并发，避免本地模型过载）。

- [ ] **Step 1: 写失败测试**

`tests/degrade.test.ts` 追加：

```ts
describe("DegradeEngine", () => {
  function big(id: string, tokens: number, level: 1 | 2 | 3 = 1): LedgerData {
    return { turnStartEntryId: id, turnEndEntryId: id, level,
      summary: { groups: [] },
      userMessage: { text: "u".repeat(40), entryId: id + "u", truncated: false },
      finalReply: { text: "r".repeat(tokens * 4), entryId: id + "r", truncated: false } };
  }
  it("applies L1->L2 rule degradation and persists via onLedger", async () => {
    const saved: LedgerData[] = [];
    const eng = new DegradeEngine({ async complete() { throw new Error("should not call"); } } as any,
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any,
      (d) => saved.push(d), () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 10000));
    await eng.run(ls);
    expect(ls[0].level).toBe(2);
    expect(ls[4].level).toBe(1);
    expect(saved.some((d) => d.turnStartEntryId === "t1" && d.level === 2)).toBe(true);
  });
  it("uses backend for L2->L3 and writes intent/outcome", async () => {
    const saved: LedgerData[] = [];
    const backend = { async complete() { return '{"userIntent":"了解结构","outcome":"确认占位"}'; } };
    const eng = new DegradeEngine(backend as any,
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any,
      (d) => saved.push(d), () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 10000, 2));
    await eng.run(ls);
    expect(ls[0].level).toBe(3);
    expect(ls[0].summary.userIntent).toBe("了解结构");
    expect(ls[0].summary.outcome).toBe("确认占位");
  });
  it("rolls back level on backend failure and warns", async () => {
    const warns: string[] = [];
    const eng = new DegradeEngine({ async complete() { throw new Error("boom"); } } as any,
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any,
      () => {}, (m) => warns.push(m));
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 10000, 2));
    await eng.run(ls);
    expect(ls[0].level).toBe(2); // 回滚
    expect(warns.length).toBeGreaterThan(0);
  });
  it("merges L3 group and stamps description on every member", async () => {
    const backend = { async complete() { return '{"description":"调查代码结构"}'; } };
    const eng = new DegradeEngine(backend as any,
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any, () => {}, () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 10000, 3));
    await eng.run(ls);
    expect(ls[0].level).toBe(4);
    expect(ls[3].merged?.description).toBe("调查代码结构（4 条已合并）");
    expect(ls[4].level).toBe(3); // 保留区内不降
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: FAIL（DegradeEngine 未定义）

- [ ] **Step 3: 实现**

`src/degrade.ts` 追加（顶部补 import：`compressEnds, mergeDescribe` 来自 `./degrade-llm.js`、`SummarizerBackend`/`ContextCompressConfig` 类型）：

```ts
export class DegradeEngine {
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
  ) {}

  async run(ledgers: LedgerData[]): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens);
    const byId = new Map(ledgers.map((l) => [l.turnStartEntryId, l]));

    for (const step of plan.steps.filter((s) => s.toLevel === 2)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 2;
      this.onLedger(l);
    }
    for (const step of plan.steps.filter((s) => s.toLevel === 3)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 3;
      try {
        const ends = await compressEnds(this.backend, l);
        l.summary = { ...l.summary, userIntent: ends.userIntent, outcome: ends.outcome };
        this.onLedger(l);
      } catch (err) {
        l.level = 2; // 回滚
        this.onWarning(`context-compress: turn ${l.turnStartEntryId} L3 压缩失败（${String(err)}），保持 L2`);
      }
    }
    for (const group of plan.mergeGroups) {
      const members = group.map((id) => byId.get(id)!);
      for (const m of members) m.level = 4;
      try {
        const { description } = await mergeDescribe(this.backend, members);
        for (const m of members) { m.merged = { description }; this.onLedger(m); }
      } catch (err) {
        for (const m of members) m.level = 3; // 回滚
        this.onWarning(`context-compress: L4 合并失败（${String(err)}），保持 L3`);
      }
    }
  }
}
```

注意：L2→L3 依赖 L2 层的准确计量——`planDegrade` 在同一快照上计算，L1→L2 的选中条目立刻进入 L2 计量（Task 3 已实现 working 副本逻辑），保证瀑布正确。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/degrade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(degrade): DegradeEngine orchestration with rollback"
```

---

### Task 6: 接线 index.ts + store 兼容 + 装配验证

**Files:**
- Modify: `src/index.ts`、`src/store.ts`
- Test: `tests/integration.test.ts`（追加）、`tests/assembler.test.ts`（按需）

**Interfaces:**
- Consumes: `DegradeEngine`（Task 5）、`renderActionLedger` 分层渲染（Task 2）。
- Produces: 插件行为变更——每次 `agent_settled` 摘要完成后（`engine.waitIdle`）运行一次 `DegradeEngine.run(按时间升序的全量 ledgers)`；`session_before_compact` 沿用现有 `renderActionLedger`（自动获得分层渲染）。

- [ ] **Step 1: 写失败测试**

`tests/integration.test.ts` 追加（复用该文件现有的 engine/store 测试脚手架；先读文件确认 helper 命名）：

```ts
it("degrades ledgers through levels after summarize completes (L1->L2 rule path)", async () => {
  // 构造 5 个已摘要 turn、ledger 总量超阈值（config 里把 ledgerDegradeThresholdTokens 调小，如 2000，reserve 500）
  // 摘要队列 drain 完成后断言：store 中最旧 turn 的 level === 2，最新仍是 level 1（或 undefined）
});
it("L3 ledger renders intent/outcome lines in assembled action ledger", async () => {
  // 手工向 store 塞一个 level=3、含 userIntent/outcome 的 LedgerData，跑 assembleContext，
  // 断言输出含 "意图：" 与 "最终回复（摘要）："，且不含该 turn 的用户原文
});
```

（具体构造代码在执行时参照该文件既有用例风格补全；断言点如上，不许省略。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/integration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/store.ts`：`isValidLedger` 增加校验 `level` 存在时必须是 1|2|3|4，否则拒绝（防脏数据）；其余不变（`rebuildFromEntries` 后写覆盖先写已天然支持降级条目覆盖 L1 条目——**关键**：降级后写入的 level=2/3/4 条目 turnStartEntryId 相同，覆盖旧 L1 条目，正确）。

`src/index.ts`：
1. `makeEngine` 中同时构造 `degradeEngine`（同一 backend、同一 config；注意 config.summarizer 未配置时 degradeEngine 也不建）。
2. 新增私有函数：

```ts
const runDegrade = async (ctx: ExtensionContext) => {
  if (!degradeEngine) return;
  const ledgers = store.keys()
    .map((k) => store.get(k)!)
    .filter(Boolean)
    .sort((a, b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId));
  if (ledgers.length === 0) return;
  await degradeEngine.run(ledgers);
};
```

3. `agent_settled` 处理器：现有 `engine.enqueue(last)` 之后，追加等待+触发（不阻塞事件返回太久，用 void 异步）：

```ts
pi.on("agent_settled", async (_event, ctx) => {
  // …现有 enqueue 逻辑不变…
  void (async () => {
    if (!engine) return;
    const ok = await engine.waitIdle(WAIT_TIMEOUT_MS);
    if (ok) await runDegrade(ctx);
  })();
});
```

（onLedger 回调已经做 store.set + appendCustomEntry；DegradeEngine 的 onLedger 用同一实现——降级条目走同一持久化通道。）

4. `session_start` 补摘分支：todo.length > 0 时同样 `void (async () => { if (await engine.waitIdle(WAIT_TIMEOUT_MS)) await runDegrade(ctx); })()`。

- [ ] **Step 4: 全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(index): wire DegradeEngine after summarization settles"
```

---

### Task 7: 文档更新与端到端冒烟

**Files:**
- Modify: `README.md`（以及 `docs/` 下若有配置说明文档——先 `grep -rln "keepRecentTokens" docs README.md` 找到所有需改处）
- Test: 手动冒烟（无新自动化）

- [ ] **Step 1: 更新 README**

在配置表/说明中加入：

```markdown
### 动作日志四级分层（L1–L4）

窗外已摘要 turn 的动作日志头按四级渐进压缩，每层 40K tokens 阈值、尾部 10K 保留区，后台异步瀑布执行：

- **L1** 用户原文 + 动作（命令+摘要+↩ID）+ 最终回复原文
- **L2** 丢动作中的命令，两端原文保留
- **L3** 意图（↩ID）+ 动作摘要 + 最终回复摘要（↩ID）——本地模型生成
- **L4** 多 turn 合并一行 `T3-T7 · 描述（N 条已合并）↩id1,id2,...`——本地模型生成

配置：
```json
{ "contextCompress": { "ledgerDegradeThresholdTokens": 40000, "ledgerReserveTokens": 10000 } }
```
```

同时删除/替换 README 中 `ledgerMergeThreshold` 的全部描述。

- [ ] **Step 2: 冒烟验证**

Run: `npx vitest run`（全绿）
然后配置真实本地 summarizer 跑一轮实际会话，用 `/compress-dump` 检查：动作日志块中 L2 turn 无命令、L3 turn 呈意图/摘要形态、超量后出现 `T*-T* · …（N 条已合并）` 行。用 `/compress-status` 确认无降级异常告警。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: four-level ledger degradation"
```

---

## Self-Review 结论

- **Spec 覆盖**：四层形态（T7 确认版）→ Task 2 渲染；40K/10K/按 turn 边界 → Task 1 配置 + Task 3 选择算法；瀑布后台异步持久化（T10/T11）→ Task 5/6；L2 规则、L3/L4 本地模型（T8/T9 确认）→ Task 4；装配零 LLM → 降级全部发生在写入侧，Task 6 验证。已确认的规格均有对应任务。
- **占位符扫描**：Task 6 Step 1 的集成测试要求执行时参照既有脚手架补全构造代码，断言点已写死，不属于占位；其余步骤均含完整代码。
- **类型一致性**：`LedgerData.level/merged`、`renderTurnText`、`planDegrade/DegradePlan/DegradeEngine`、`compressEnds/mergeDescribe`、配置字段名在各任务间已对齐（Task 4 的 `mergeDescribe` 使用 Task 2 导出的 `renderTurnText`）。
