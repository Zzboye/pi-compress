# 进行中超大 turn 溢出摘要 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 进行中 turn 原文超过 `keepRecentTokens` 后，把溢出部分（最旧完整 toolCall→toolResult 对）切成正常 ledger 条目提前走摘要管线与降级瀑布，turn 结束后整 turn 摘要落盘并墓碑化片段。

**Architecture:** 零新机制——片段是一等公民 LedgerData（key=片段首 entry id），经 SummarizerEngine 队列摘要、DegradeEngine 瀑布降级（L5 豁免）。装配侧对最后一个 turn 应用「裁剪视图」（去掉已被 store 中片段覆盖的前缀，user 消息保留）并把片段 ledger 追加进日志头；收敛用 `absorbed` 墓碑（session 文件不可删条目，rebuild 跳过防复活）。

**Tech Stack:** TypeScript + vitest，无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-17-inflight-turn-degrade-design.md`

## Global Constraints

- 阈值复用 `keepRecentTokens`，**不加任何新配置项**
- 用户消息（turn 的 entries[0]）**永不切进片段**；片段只含 user 之后的完整 toolCall→toolResult 对，**不拆对**（片段不得结束在带 toolCall 的 assistant 消息上）
- 片段边界**冻结**（`enqueue` 按 `startEntryId` 去重依赖此性质）；继续溢出切下一个顺序片段
- 片段 turn 结束前**最多降到 L4**（L5 豁免，裁定 7）
- 无片段、未超阈值时**所有现有行为逐字节不变**（每个任务带零变化用例）
- 测试命令：`npx vitest run`（全量）、`npx tsc --noEmit`；每个任务完成后两者必须干净
- 分支 `feat/inflight-turn-degrade`，**不合并 main**

---

### Task 1: absorbed 墓碑字段与 store.delete

**Files:**
- Modify: `src/ledger.ts`（LedgerData 接口 + normalizeLedgerData 透传）
- Modify: `src/store.ts`（delete 方法 + rebuildFromEntries 跳过 absorbed）
- Test: `tests/store.test.ts`

**Interfaces:**
- Produces: `LedgerData.absorbed?: true`；`LedgerStore.delete(turnStartEntryId: string): void`

- [ ] **Step 1: 写失败测试**

在 `tests/store.test.ts` 末尾追加：

```ts
describe("absorbed 墓碑", () => {
  const frag = (id: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id,
    summary: { entries: [] },
  });

  it("rebuild 跳过 absorbed 条目（墓碑不复活）", () => {
    const store = new LedgerStore();
    store.set(frag("f1"));
    // 模拟墓碑化后的持久化条目
    const entries: SessionEntryLike[] = [
      { id: "e1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { ...frag("f1"), absorbed: true } },
      { id: "e2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: frag("f2") },
    ];
    store.rebuildFromEntries(entries);
    expect(store.get("f1")).toBeUndefined();
    expect(store.get("f2")).toBeDefined();
  });

  it("delete 从缓存移除", () => {
    const store = new LedgerStore();
    store.set(frag("f1"));
    store.delete("f1");
    expect(store.get("f1")).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});
```

注意 import：`SessionEntryLike`、`LEDGER_CUSTOM_TYPE` 按文件现有 import 补齐（先读文件头确认已有哪些）。

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL（`delete` 不存在 / rebuild 未跳过 absorbed）

- [ ] **Step 3: 最小实现**

`src/ledger.ts` LedgerData 接口加字段（`merged` 之后）：

```ts
  /** 溢出片段被整 turn 条目吸收后的墓碑标记：rebuild 跳过，渲染侧防御性过滤 */
  absorbed?: true;
```

确认 `normalizeLedgerData` 对新 schema 是展开透传（`{ ...d, ... }` 形态）——若是逐字段挑选则补 `absorbed` 透传；加一个断言用例进 `tests/ledger.test.ts`：

```ts
it("normalizeLedgerData 透传 absorbed", () => {
  const d = normalizeLedgerData({ turnStartEntryId: "f1", turnEndEntryId: "f1", summary: { entries: [] }, absorbed: true });
  expect(d.absorbed).toBe(true);
});
```

`src/store.ts`：

```ts
  delete(turnStartEntryId: string): void { this.cache.delete(turnStartEntryId); }
```

`rebuildFromEntries` 的 if 条件加 absorbed 判断：

```ts
      if (e.type === "custom" && e.customType === LEDGER_CUSTOM_TYPE && isValidLedger(e.data)
        && !(e.data as LedgerData).absorbed) {
```

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/store.test.ts tests/ledger.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS，tsc 干净

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/store.ts tests/store.test.ts tests/ledger.test.ts
git commit -m "feat: LedgerData.absorbed 墓碑字段 + store.delete（溢出片段收敛基础）"
```

---

### Task 2: Turn.isFragment 标记与摘要器片段适配

**Files:**
- Modify: `src/util.ts:9`（Turn 接口）
- Modify: `src/summarizer.ts`（processWithRetry 片段守卫）
- Test: `tests/summarizer.test.ts`

**Interfaces:**
- Produces: `Turn.isFragment?: boolean`；片段入队摘要后 `finalReply` 为 undefined（turn 未结束）、`userMessage` 为 undefined（首条非 user）

**背景:** `extractFinalReply` 对片段会把中间 assistant 叙述误当「最终回复」渲染成「最终回复（原文）」行——语义错误，片段必须跳过。

- [ ] **Step 1: 写失败测试**

在 `tests/summarizer.test.ts` 末尾追加（沿用文件内现有 fake backend / config 构造方式——先读文件头 30 行照抄现有 helper）：

```ts
it("片段 turn：finalReply 不提取（undefined），userMessage 保持 undefined", async () => {
  // 用现有 helper 构造 entries：user 消息 + assistant(toolCall) + toolResult + assistant(带 text)
  const fragTurn: Turn = {
    startEntryId: "a1", endEntryId: "a3", isFragment: true,
    entries: [/* assistant toolCall, toolResult, assistant text —— 照现有 fixture 模式 */],
  };
  // enqueue + 等待完成（现有测试的等待模式）
  engine.enqueue(fragTurn);
  await engine.waitIdle(1000);
  const ledger = capturedLedgers.find((l) => l.turnStartEntryId === "a1");
  expect(ledger).toBeDefined();
  expect(ledger!.userMessage).toBeUndefined();
  expect(ledger!.finalReply).toBeUndefined();
  expect(ledger!.summary.entries.length).toBeGreaterThan(0); // 动作照常提取
});
```

（实现者须把注释处替换为文件内现有的 entries 构造 helper，保持一致。）

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/summarizer.test.ts`
Expected: FAIL（finalReply 被提取为中间 assistant 文本）

- [ ] **Step 3: 最小实现**

`src/util.ts:9`：

```ts
export interface Turn { startEntryId: string; endEntryId: string; entries: MessageEntry[]; /** 溢出片段伪 turn：无 userMessage/finalReply 语义 */ isFragment?: boolean }
```

`src/summarizer.ts` processWithRetry 内：

```ts
      const finalReply = turn.isFragment ? undefined : extractFinalReply(turn);
```

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/summarizer.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/util.ts src/summarizer.ts tests/summarizer.test.ts
git commit -m "feat: Turn.isFragment 标记——片段摘要跳过 finalReply 提取"
```

---

### Task 3: planInflightTrim 纯函数（覆盖推导 + 裁剪 + 切分）

**Files:**
- Modify: `src/assembler.ts`（新导出函数）
- Test: `tests/assembler.test.ts`

**Interfaces:**
- Consumes: `turnTokens`、`countTokens`（assembler/util 现有）、`LedgerData`
- Produces:

```ts
/** 进行中 turn 的溢出处理计划（纯函数，无副作用）：
 *  covered = store（cache）中属于最后 turn 且 key≠turn.startEntryId 的片段所覆盖的前缀；
 *  branch = 裁剪视图（去掉 covered 前缀条目，user 消息保留）；
 *  extraLedgers = 片段 ledger（branch 顺序追加在队尾）；
 *  fragment = 未覆盖部分仍超 keepRecentTokens 时切出的新片段伪 Turn（否则 null）。
 *  切分规则：从 user 之后按完整 toolCall→toolResult 对累计最旧若干条，直到覆盖
 *  overflow = remainingTokens - keepRecentTokens；片段不得结束在带 toolCall 的 assistant 上。 */
export function planInflightTrim(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
): { trimmedBranch: MessageEntry[]; extraLedgers: LedgerData[]; fragment: Turn | null }
```

**实现要点（全部落在本函数内）:**

1. `turns = splitIntoTurns(branch)`；`turns.length === 0` → 原样返回
2. `last = turns[turns.length - 1]`；entryId → 下标 Map
3. **覆盖推导**：遍历 `cache`，key ∈ last.entryIds 且 key ≠ last.startEntryId 的条目是片段；取其 `turnEndEntryId` 在 last.entries 中下标最大者 `coveredIdx`（无片段 → -1）
4. **裁剪**：`trimmedBranch` = branch 去掉 `last.entries[1..coveredIdx]`（保留 entries[0] 即 user 消息；coveredIdx < 1 时 branch 不变）——注意用 entry id 集合过滤，保持其余条目原顺序
5. **extraLedgers**：步骤 3 找到的片段 ledger，按其在 last.entries 中的 startEntryId 下标排序输出
6. **溢出切分**：`remaining = last.entries[coveredIdx + 1 ..]`（含 user）；`remainingTokens = Σ countTokens(e.message, { skipThinking: true })`；`remainingTokens <= keepRecentTokens` → fragment=null
7. 否则 `overflow = remainingTokens - keepRecentTokens`；从 `i = 1`（user 之后）开始累计 `countTokens`，当累计 ≥ overflow 时停；**对边界修正**：若当前末条是 assistant 消息（含 toolCall），继续向后吃直到吃进一条 `role === "toolResult"`；若已到 last.entries 末尾则吃到最后一条为止（fragment 覆盖 entries[1..end]，但 end 不得越过 coveredIdx 之后可用范围——remaining 起点即 coveredIdx+1，天然满足）
8. fragment：`{ startEntryId: remaining[i0].id, endEntryId: remaining[iEnd].id, entries: remaining[i0..iEnd], isFragment: true }`（i0 是 remaining 中下标 1）

- [ ] **Step 1: 写失败测试**

在 `tests/assembler.test.ts` 末尾追加（沿用文件内 msg fixture helper；测试消息用短文本，token 少，用很小的 `keepRecentTokens` 触发）：

```ts
describe("planInflightTrim", () => {
  // fixture：user + 4 对 toolCall→toolResult（每条 toolResult 用长文本撑 token）
  const mkInflight = () => {
    const entries: MessageEntry[] = [{ id: "u", message: { role: "user", content: [{ type: "text", text: "任务" }] } as any }];
    for (let i = 1; i <= 4; i++) {
      entries.push({ id: `a${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `cmd${i}` } }] } as any });
      entries.push({ id: `r${i}`, message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "x".repeat(2000) }] } as any });
    }
    return entries;
  };

  it("未超阈值：零变化（branch 原样、无 extraLedgers、fragment null）", () => {
    const branch = mkInflight();
    const out = planInflightTrim(branch, new Map(), 1_000_000);
    expect(out.trimmedBranch).toEqual(branch);
    expect(out.extraLedgers).toEqual([]);
    expect(out.fragment).toBeNull();
  });

  it("超阈值：切出片段含完整对（不结束在 toolCall 上），user 保留在 trimmedBranch", () => {
    const branch = mkInflight();
    const { trimmedBranch, fragment } = planInflightTrim(branch, new Map(), 200);
    expect(fragment).not.toBeNull();
    expect(fragment!.startEntryId).toBe("a1");       // 从 user 之后开始
    expect(fragment!.isFragment).toBe(true);
    const lastMsg = fragment!.entries[fragment!.entries.length - 1].message;
    expect(lastMsg.role).toBe("toolResult");          // 对边界
    // user 消息仍在裁剪视图中，片段条目已移除
    expect(trimmedBranch.some((e) => e.id === "u")).toBe(true);
    expect(trimmedBranch.some((e) => e.id === fragment!.startEntryId)).toBe(false);
  });

  it("已有片段（cache 中）：裁剪视图去掉已覆盖前缀，extraLedgers 按 branch 顺序输出", () => {
    const branch = mkInflight();
    // 手工构造覆盖 a1..r2 的片段 ledger
    const fragLedger: LedgerData = {
      turnStartEntryId: "a1", turnEndEntryId: "r2", summary: { entries: [] },
    };
    const cache = new Map([["a1", fragLedger]]);
    const { trimmedBranch, extraLedgers, fragment } = planInflightTrim(branch, cache, 200);
    expect(extraLedgers).toEqual([fragLedger]);
    expect(trimmedBranch.some((e) => e.id === "a1")).toBe(false);
    expect(trimmedBranch.some((e) => e.id === "r2")).toBe(false);
    expect(trimmedBranch.some((e) => e.id === "u")).toBe(true);
    // 剩余仍超阈值 → 继续切下一片段（F2，冻结语义：起点在已覆盖之后）
    expect(fragment).not.toBeNull();
    expect(fragment!.startEntryId).toBe("a3");
  });

  it("turn 结束后的普通多 turn 会话：最后 turn 是已完成的短 turn，零变化", () => {
    const branch = [...mkInflight(), { id: "u2", message: { role: "user", content: [{ type: "text", text: "下一问" }] } as any }];
    const out = planInflightTrim(branch, new Map(), 1_000_000);
    expect(out.fragment).toBeNull();
    expect(out.trimmedBranch).toEqual(branch);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/assembler.test.ts`
Expected: FAIL（planInflightTrim 未导出）

- [ ] **Step 3: 实现**

按「实现要点」1-8 在 `src/assembler.ts` 实现 `planInflightTrim`。实现注意：

- 复用 `splitIntoTurns` / `countTokens`（util.ts 已有）；不要用 `turnTokens`（它算整 turn）
- 覆盖推导只看 cache 中 key 命中 last turn entryIds 的条目；`absorbed` 条目理论不在 cache（Task 1 rebuild 跳过），若出现则跳过不计入覆盖（防御：`if (v.absorbed) continue`）

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/assembler.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/assembler.ts tests/assembler.test.ts
git commit -m "feat: planInflightTrim——溢出切分/覆盖推导/裁剪视图纯函数"
```

---

### Task 4: assembleContext 片段行渲染 + dump 同口径

**Files:**
- Modify: `src/assembler.ts`（assembleContext 加可选参数）
- Modify: `src/dump.ts`（dumpContext 内接入 planInflightTrim）
- Test: `tests/assembler.test.ts`、`tests/dump.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `planInflightTrim`
- Produces: `assembleContext(branch, cache, keepRecentTokens, extraLedgers?: LedgerData[])`——extraLedgers 追加在日志头 ledgers 数组**末尾**（片段属于最后 turn，branch 顺序天然在最后）

- [ ] **Step 1: 写失败测试**

`tests/assembler.test.ts` 追加：

```ts
it("assembleContext：extraLedgers 渲染进日志头且原文侧不含片段内容", () => {
  const branch = mkInflight(); // Task 3 的 helper（若不在同一 describe 作用域，复制一份或提到文件顶层）
  const cache = new Map<string, LedgerData>();
  const { trimmedBranch, extraLedgers, fragment } = planInflightTrim(branch, cache, 200);
  // 模拟片段已摘要落盘
  const fragLedger: LedgerData = { turnStartEntryId: fragment!.startEntryId, turnEndEntryId: fragment!.endEntryId, summary: { userIntent: "跑命令", outcome: "完成", entries: [] } };
  // 重新裁剪（此时片段在 cache 中）
  const plan2 = planInflightTrim(branch, new Map([[fragment!.startEntryId, fragLedger]]), 200);
  const { messages } = assembleContext(plan2.trimmedBranch, new Map([[fragment!.startEntryId, fragLedger]]), 200, plan2.extraLedgers);
  const ledgerMsg = messages.find((m) => Array.isArray(m.content) && (m.content as any[]).some((c) => c.type === "text" && (c.text as string).includes("<action-ledger>")));
  expect(ledgerMsg).toBeDefined();
  const text = (ledgerMsg!.content as any[]).map((c) => c.text ?? "").join("");
  expect(text).toContain("跑命令"); // 片段行在日志头
});
```

`tests/dump.test.ts` 追加（沿用文件内 fixture 模式）：

```ts
it("dump：进行中超大 turn 与 context 同口径——片段行可见、原文侧裁剪", () => {
  // 构造 branch（超阈值 in-flight turn）+ cache（含片段 ledger），
  // 断言 dumpContext 输出的消息中 <action-ledger> 含片段行、且片段条目不在消息原文里
});
```

（实现者按 dump.test.ts 现有 helper 补全构造与断言，口径必须与上面 assembler 用例一致。）

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/assembler.test.ts tests/dump.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/assembler.ts` assembleContext：

```ts
export function assembleContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
  extraLedgers: LedgerData[] = [],
): { messages: AgentMessage[]; stats: AssembleStats } {
```

`if (ledgers.length > 0 || extraLedgers.length > 0) messages.push(renderActionLedger([...ledgers, ...extraLedgers]));`

`src/dump.ts` dumpContext：在调用 assembleContext 前加：

```ts
  const plan = planInflightTrim(branch, cache, config.keepRecentTokens);
  // dump 是只读视图：不 enqueue fragment（那是 context 事件的副作用），只做同口径裁剪与渲染
  const { messages, stats } = assembleContext(plan.trimmedBranch, cache, config.keepRecentTokens, plan.extraLedgers);
```

（原 `assembleContext(branch, cache, config.keepRecentTokens)` 调用替换为上面；import planInflightTrim。）

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/assembler.test.ts tests/dump.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/assembler.ts src/dump.ts tests/assembler.test.ts tests/dump.test.ts
git commit -m "feat: assembleContext 支持 extraLedgers，dump 接入同口径裁剪"
```

---

### Task 5: context 事件接线（切分入队）

**Files:**
- Modify: `src/index.ts`（context 处理器）
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 3 `planInflightTrim`、Task 4 `assembleContext(..., extraLedgers)`、`SummarizerEngine.enqueue`
- 行为：context 事件中调用 `planInflightTrim(entries, cacheMap, config.keepRecentTokens)`；`fragment` 非 null 且 `!engine.failed().has(fragment.startEntryId)` 且 `store.get(fragment.startEntryId)` 不存在 → `engine.enqueue(fragment)`；装配用 `plan.trimmedBranch` + `plan.extraLedgers`。**注意**：本轮新切的 fragment 尚无 ledger，`plan.extraLedgers`/裁剪只反映 store 中已有片段——新片段内容本轮仍以原文放行（下一轮 context 事件时已落盘被裁剪），这是有意的安全窗口。

- [ ] **Step 1: 写失败测试**

`tests/extension.test.ts` 在 "extension entry wiring" describe 内追加（复用文件内 harness / fixture 模式；fixture 需要 parentId 链——见既有 compaction 测试的教训，必须成链）：

```ts
it("context：进行中 turn 超阈值 → 片段入队摘要，装配裁剪", async () => {
  // 1. 构造 branch：完整 turn（user + 巨型 toolResult 对×N，撑超 keepRecentTokens）
  // 2. 触发 context handler（现有 harness 模式）
  // 3. 断言：captured backend 收到片段摘要请求（prompt 含第一条命令文本）；
  //    摘要完成后再次触发 context → <action-ledger> 含片段行、巨型 toolResult 原文不在消息里、user 消息仍在
});

it("context：无超大 turn → 行为逐字节不变", async () => {
  // 普通 fixture，断言 messages 与不接线时完全一致（对照旧装配路径）
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/extension.test.ts -t "片段入队"`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/index.ts` context 处理器，在 `const { entries, compaction } = compactionAwareEntries(...)` 之后、`assembleContext` 调用处改造：

```ts
    const cache = new Map<string, LedgerData>();
    for (const k of store.keys()) { const v = store.get(k); if (v && !v.absorbed) cache.set(k, v); }
    // 进行中超大 turn：溢出片段提前入摘要管线（spec §4.1）；新切片本轮不裁剪（无 ledger，原文放行一轮）
    const plan = planInflightTrim(entries, cache, config.keepRecentTokens);
    if (plan.fragment && engine && !engine.failed().has(plan.fragment.startEntryId) && !store.get(plan.fragment.startEntryId)) {
      engine.enqueue(plan.fragment);
    }
    const { messages, stats } = assembleContext(plan.trimmedBranch, cache, config.keepRecentTokens, plan.extraLedgers);
```

import 补 `planInflightTrim`。注意：原代码 cache 构造在后面——把 cache 构造上移到 plan 之前（如上），并在循环里加 `!v.absorbed` 防御过滤。

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/extension.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/extension.test.ts
git commit -m "feat: context 事件接线——进行中 turn 溢出片段切分入队"
```

---

### Task 6: 降级瀑布接入片段 + L5 豁免

**Files:**
- Modify: `src/degrade.ts`（planDegrade 加 holdAt4；run 签名加参数）
- Modify: `src/index.ts`（runDegrade 收集片段 ledger 并传 holdAt4）
- Test: `tests/degrade.test.ts`、`tests/extension.test.ts`

**Interfaces:**
- Produces:
  - `planDegrade(ledgers, thresholdTokens, reserveTokens, holdAt4?: Set<string>)`——toLevel=5 且 id ∈ holdAt4 的 step 跳过（保持 L4）
  - `DegradeEngine.run(ledgers, holdAt4?: Set<string>)`
- Consumes: Task 3 的片段 ledger 收集逻辑（index.ts 内用 planInflightTrim 的 extraLedgers，或直接扫 store——实现者选扫 store：key ∈ 最后 turn entryIds 且 ≠ turn.startEntryId 且未 absorbed）

- [ ] **Step 1: 写失败测试**

`tests/degrade.test.ts` 追加：

```ts
it("L5 豁免：holdAt4 中的条目不生成 toLevel=5 step，保持 L4", () => {
  const ls: LedgerData[] = [
    { turnStartEntryId: "f1", turnEndEntryId: "f1", summary: { entries: [] }, level: 4 },   // 片段
    { turnStartEntryId: "old", turnEndEntryId: "old", summary: { entries: [] }, level: 4 }, // 普通旧条目
  ];
  // 阈值选小值确保两者都被选中升 5（参照文件内现有 planDegrade 测试的阈值取法）
  const plan = planDegrade(ls, 1, 1, new Set(["f1"]));
  expect(plan.steps.find((s) => s.turnStartEntryId === "f1" && s.toLevel === 5)).toBeUndefined();
  expect(plan.steps.find((s) => s.turnStartEntryId === "old" && s.toLevel === 5)).toBeDefined();
});
```

配套 engine 级用例：run(ledgers, holdAt4) 后 f1.level 仍为 4、old.level===5 且 merged 写入（参照现有 L5 测试的 fake backend 模式）。

`tests/extension.test.ts` 追加集成用例：长任务多片段 + 触发降级 → 片段行保持 L4 形态（意图+outcome 两行）、普通旧 turn 正常合并为 L5 行。

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: FAIL（参数不存在）

- [ ] **Step 3: 实现**

`src/degrade.ts` planDegrade 瀑布循环内，置 to 前加：

```ts
      const to = (level + 1) as 2 | 3 | 4 | 5;
      if (to === 5 && holdAt4?.has(w.l.turnStartEntryId)) continue; // 片段 L5 豁免（裁定 7）
```

（同时保证 `degraded5` 集合不含被豁免的 id——`continue` 在 `steps.push` 之前即满足。）

`run` 签名与透传：

```ts
  async run(ledgers: LedgerData[], holdAt4?: Set<string>): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens, holdAt4);
```

`src/index.ts` runDegrade：在 `const ledgers = ledgersInBranchOrder(entries, true)` 之后追加片段收集与 holdAt4：

```ts
    // 溢出片段参与降级（它们 key 不是任何 turn 的 startEntryId，ledgersInBranchOrder 查不到）
    const turns = splitIntoTurns(entries);
    const last = turns[turns.length - 1];
    const holdAt4 = new Set<string>();
    if (last) {
      const lastIds = new Set(last.entries.map((e) => e.id));
      for (const k of store.keys()) {
        if (k === last.startEntryId || !lastIds.has(k)) continue;
        const frag = store.get(k);
        if (frag && !frag.absorbed) { ledgers.push(frag); holdAt4.add(k); }
      }
    }
    await degradeEngine.run(ledgers, holdAt4);
```

（片段 push 到 ledgers 末尾 = branch 顺序正确；`if (ledgers.length === 0) return` 移到片段收集之后或改判 `ledgers.length === 0 && holdAt4.size === 0`——注意别在有空 ledgers 时白跑。）

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/degrade.test.ts tests/extension.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/degrade.ts src/index.ts tests/degrade.test.ts tests/extension.test.ts
git commit -m "feat: 片段接入降级瀑布 + L5 豁免（holdAt4，裁定 7）"
```

---

### Task 7: turn 结束收敛（墓碑化）

**Files:**
- Modify: `src/index.ts`（agent_settled 处理器 + absorb 逻辑）
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 1 `store.delete` / absorbed、Task 6 的片段判定方式
- 行为：agent_settled 对最后 turn（现 `last`）：①照常 `engine.enqueue(last)`（整 turn 摘要）；②若该 turn 存在未 absorbed 片段 → `void engine.waitIdle(WAIT_TIMEOUT_MS).then(() => absorbFragments(last))`；`absorbFragments`：若 `store.get(last.startEntryId)` 不存在（整 turn 摘要未落盘，如失败/超时）→ warn 并返回（不丢数据，下轮 agent_settled 重试）；否则对每个片段：`store.set({ ...frag, absorbed: true })` + `appendCustomEntry(LEDGER_CUSTOM_TYPE, tombstone)`（rebuild 防复活）+ `store.delete(fragKey)`（cache 内移除）。幂等：片段已 absorbed / 不在 store 时跳过。

**为什么 waitIdle 够：** 整 turn 在片段之后入队（FIFO），waitIdle 等到队列清空时整 turn ledger 与所有片段摘要都已落盘。超时或整 turn 摘要失败时守卫跳过，数据无损。

- [ ] **Step 1: 写失败测试**

`tests/extension.test.ts` 追加（复用 Task 5 的超大 turn fixture + captured backend）：

```ts
it("收敛：turn 结束后整 turn 条目落盘、片段墓碑化、重启不复活", async () => {
  // 1. context 触发切分入队（Task 5 模式）
  // 2. 触发 agent_settled → 等待队列清空与 absorb 完成（waitIdle + 微任务 flush，现有测试的等待模式）
  // 3. 断言：store.get(turnStartId) 存在（整 turn 条目）；store.get(fragStartId) 为 undefined（墓碑化后 cache 移除）
  // 4. 用 appendCustomEntry 收到的 tombstone 数据（absorbed: true）重建新 store.rebuildFromEntries → 片段不复活
});

it("收敛守卫：整 turn 摘要失败时片段不墓碑（数据无损）", async () => {
  // backend 抛错使整 turn 摘要失败 → absorb 守卫触发 → 片段仍在 store
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/extension.test.ts -t "收敛"`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/index.ts` agent_settled 处理器改造（现 `engine.enqueue(last);` 之后）：

```ts
    engine.enqueue(last);
    // 溢出片段收敛：整 turn 摘要落盘且队列清空后墓碑化片段（spec §4.5）。
    // 幂等守卫：整 turn ledger 不存在（摘要失败/超时）时不墓碑——片段仍是唯一索引，数据无损优先。
    const fragmentKeys = collectFragmentKeys(last, store);
    if (fragmentKeys.length > 0 && engine) {
      const turnStart = last.startEntryId;
      void engine.waitIdle(WAIT_TIMEOUT_MS).then(() => {
        if (!store.get(turnStart)) return; // 整 turn 摘要未落盘：不收敛，下轮重试
        for (const k of fragmentKeys) {
          const frag = store.get(k);
          if (!frag || frag.absorbed) continue;
          const tombstone = { ...frag, absorbed: true as const };
          store.set(tombstone);
          try { (ctx.sessionManager as unknown as { appendCustomEntry(t: string, d: unknown): void }).appendCustomEntry(LEDGER_CUSTOM_TYPE, tombstone); } catch { /* 同 onLedger */ }
          store.delete(k);
        }
      });
    }
```

`collectFragmentKeys` 为 index.ts 内小 helper（与 Task 6 的收集逻辑同构，返回 key 数组；实现者可抽公共函数避免两处重复——推荐抽 `fragmentKeysOfTurn(turn, store): string[]` 供 Task 6/7 共用）。

**注意**：`engine.enqueue(last)` 的既有守卫 `if (store.get(last.startEntryId) || engine.failed().has(...)) return;` 会提前 return——收敛逻辑必须放在该 return **之前**或用不早退的路径（若整 turn 已有 ledger（session_start 补摘场景）也要收敛 → 收敛检查放在守卫 return 之前）。

- [ ] **Step 4: 运行验证通过 + 全量回归**

Run: `npx vitest run tests/extension.test.ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS（全量 280+ 通过）

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/extension.test.ts
git commit -m "feat: turn 结束收敛——整 turn 落盘后片段墓碑化（幂等守卫）"
```

---

### Task 8: README 与已知限制更新

**Files:**
- Modify: `README.md`（已知限制「单 turn 超大整体保留」条目改写 + 配置表 `keepRecentTokens` 描述补一句 + 特性列表）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 改写已知限制**

找到 README 已知限制中「单 turn 超大整体保留」相关条目，改写为：

```markdown
- **进行中超大 turn**：原文超过 `keepRecentTokens` 后，溢出部分（最旧的完整工具调用对）自动切成 ledger 条目提前进入摘要管线与降级瀑布（进行中最多降到 L4，turn 结束后由整 turn 摘要吸收）；低于阈值时整体保留，行为不变。溢出切分不拆散 toolCall→toolResult 对，用户消息永不切出
```

- [ ] **Step 2: 配置表核对**

`keepRecentTokens` 行补一句：「也是进行中 turn 的溢出切分阈值」。

- [ ] **Step 3: 验证 + Commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS（文档改动不应破坏任何测试；若 README 有结构校验测试则跑之）

```bash
git add README.md
git commit -m "docs: 进行中超大 turn 溢出摘要特性说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 触发切分（T3/T5）、§4.2 片段条目（T2）、§4.3 装配裁剪（T3/T4/T5）、§4.4 覆盖推导（T3）、§4.5 收敛墓碑（T1/T7）、裁定 7 L5 豁免（T6）、§5 失败保持原文（T5 failed 守卫 + T7 守卫）、§7 测试计划各组均有对应任务 ✅
- **类型一致性**：`planInflightTrim` 返回 `{ trimmedBranch, extraLedgers, fragment }` 在 T3 定义、T4/T5 消费一致；`holdAt4?: Set<string>` T6 定义与实现一致；`Turn.isFragment` T2 定义、T3 消费一致 ✅
- **已知风险给实现者的提示**：fixture 必须 parentId 成链（extension.test.ts 的 compaction 测试踩过）；`ledgers.length === 0` 早退与片段收集的先后顺序（T6）；收敛逻辑不可放在 agent_settled 既有守卫 return 之后（T7）
