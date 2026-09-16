# 五级降级阶梯（L1–L5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把动作日志降级从四级改为五级——L3 丢工具过程（保留两端原文）、L4 只留意图+outcome 摘要、L5 合并一行（无 IDs），并给 recall 加三档语义（entry 级 / turn 级 / L5 拒绝）。

**Architecture:** 渲染（ledger.ts）按新阶梯重写视图；降级（degrade.ts）瀑布右移一层、compressEnds 右移到 L3→L4、mergeDescribe 右移到 L4→L5；recall（recall.ts）按 ledger 层级路由三档召回。存量数据天然兼容（降级从不删 quotes，spec §5 已查证）。

**Tech Stack:** TypeScript / vitest / 无新依赖。

## Global Constraints

- spec：`docs/superpowers/specs/2026-09-16-five-level-degrade-design.md`（裁定记录 §2 是所有决策的真相源）
- 不变式：一条消息 = 一个 entry ID 全生命周期不变；无映射层；降级只改 `level`/`summary`/`merged`，从不删 quotes
- 阈值配置沿用：`ledgerDegradeThresholdTokens`（默认 40000）、`ledgerReserveTokens`（默认 10000），不新增配置项
- 不做「回复原文超长降为摘要」护栏；不动 L1/L2 语义；不动 searchLedger
- 每个 Task 完成后全量测试必须绿：`npx vitest run`（当前基线 254 passed / 1 skipped）+ `npx tsc --noEmit`
- 测试写法遵循现有文件惯例（degrade.test.ts 的 `ledger()` helper、ledger.test.ts 的 `full`/`sample` fixture、recall.test.ts 的 branch 构造）

---

### Task 1: 渲染层——renderTurnText 新阶梯 + L5 合并行无 IDs

**Files:**
- Modify: `src/ledger.ts`（renderTurnText 约 89-123 行、renderActionLedger 约 143-160 行、删除 allRecallIds 约 71-79 行）
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: 现有 `LedgerData`（`level?: 1|2|3|4` 需放宽为 `1|2|3|4|5`，`merged?: { description: string }`、`summary.userIntent`/`outcome` 均已存在）
- Produces: `renderTurnText(l: LedgerData, n: number): string`——L5 渲染 `T{n} · {merged.description}`（无 ↩IDs）；L4 渲染意图行+outcome 行（各带两端 ID）；L3 渲染用户原文+回复原文（无动作行）。`renderActionLedger` 聚合连续 `level===5` 条目为一行。

- [ ] **Step 1: 重写失败测试（levels describe 整块替换）**

替换 `tests/ledger.test.ts` 中 `describe("renderActionLedger levels", ...)` 整块为：

```ts
describe("renderActionLedger levels（五级阶梯）", () => {
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
    expect(text).toContain("最终回复（原文）：");
  });

  it("L3 drops action lines entirely, keeps user quote + final reply original", () => {
    const l3: LedgerData = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：\n我已经看完当前代码……");
    expect(text).not.toContain("调查：");      // 动作行全丢
    expect(text).not.toContain("最终回复（摘要）");
    expect(text).not.toContain("意图：");       // L3 用户侧是原文
  });

  it("L3 keeps intent fallback only when userMessage missing (legacy edge)", () => {
    const l3: LedgerData = { ...full, level: 3, userMessage: undefined, summary: { ...full.summary, userIntent: "了解ledger结构" } };
    const text = textOf(renderActionLedger([l3]));
    expect(text).toContain("T1 · 用户意图：了解ledger结构 ↩e001");
  });

  it("L4 renders intent + outcome summary lines with both-end ids only", () => {
    const l4: LedgerData = { ...full, level: 4, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认LedgerData含level字段" }, merged: { description: "旧合并描述（应被忽略）" } };
    const text = textOf(renderActionLedger([l4]));
    expect(text).toContain("T1 · 意图：了解ledger结构 ↩e001");
    expect(text).toContain("- 最终回复（摘要）：确认LedgerData含level字段 ↩e018");
    expect(text).not.toContain("用户：「");              // 两端原文不再渲染
    expect(text).not.toContain("我已经看完当前代码");
    expect(text).not.toContain("调查：");                // 动作行全丢
    expect(text).not.toContain("旧合并描述");             // merged.description 是 L5 产物，L4 忽略
  });

  it("L5 renders one merged line without any recall ids", () => {
    const mk = (id: string): LedgerData => ({ ...full, level: 5 as any, turnStartEntryId: id,
      merged: { description: "调查代码结构与配置逻辑" },
      summary: { entries: [
        { action: "bash", target: "x", detail: "d", recallIds: ["e1"], phase: "investigate" },
      ] } });
    const text = textOf(renderActionLedger([mk("a"), mk("b")]));
    expect(text).toContain("T1-T2 · 调查代码结构与配置逻辑");
    expect(text).not.toContain("↩");            // 行尾不渲染任何 IDs
    expect(text).not.toContain("用户：「");
  });

  it("legacy L4 (merged group data) renders as new L4 per-entry from intent/outcome", () => {
    // 存量旧 L4：经过旧 compressEnds，userIntent/outcome 都在；无新代码分支，直接按 L4 渲染
    const legacy: LedgerData = { ...full, level: 4, summary: { ...full.summary, userIntent: "修复降级bug", outcome: "已修复推送" }, merged: { description: "旧的组描述" } };
    const text = textOf(renderActionLedger([legacy]));
    expect(text).toContain("T1 · 意图：修复降级bug ↩e001");
    expect(text).toContain("- 最终回复（摘要）：已修复推送 ↩e018");
  });

  it("legacy L3 data renders under new L3 (user + reply original, actions dropped)", () => {
    // 存量旧 L3：渲染函数统一按新阶梯——数据里 quotes 还在，直接出原文
    const legacy: LedgerData = { ...full, level: 3, summary: { ...full.summary, userIntent: "了解ledger结构", outcome: "确认" } };
    const text = textOf(renderActionLedger([legacy]));
    expect(text).toContain("T1 · 用户：「帮我了解 ledger 的结构」");
    expect(text).toContain("最终回复（原文）：");
    expect(text).not.toContain("调查：");
  });
});
```

- [ ] **Step 2: 运行确认红灯**

Run: `npx vitest run tests/ledger.test.ts 2>&1 | grep -E "Tests |×"`
Expected: FAIL（新 L3/L4/L5 用例全红；旧 levels 断言已删除）

- [ ] **Step 3: 实现 renderTurnText 新阶梯**

`src/ledger.ts` 修改四处：

1. `LedgerData.level` 类型放宽（约 31 行）：`level?: 1 | 2 | 3 | 4 | 5;`

2. 删除 `allRecallIds` 函数（约 71-79 行，L4/L5 渲染不再需要动作 ID 并集；L4 只用两端 ID）。

3. `renderTurnText`（约 89 行起）整体替换为：

```ts
export function renderTurnText(l: LedgerData, n: number): string {
  const lines: string[] = [];
  const lvl = l.level ?? 1;
  // L5：合并终态行，无任何 ↩IDs（拒绝召回语义，spec §7）
  if (lvl === 5) {
    const desc = l.merged?.description ?? "（已合并）";
    lines.push(`T${n} · ${desc}`);
    return lines.join("\n") + "\n";
  }
  // L4：意图 + outcome 摘要（两端 ID 仍可见，recall 走 turn 级）
  if (lvl === 4) {
    const intentId = l.userMessage?.entryId ?? l.turnStartEntryId;
    lines.push(`### T${n} · 意图：${l.summary.userIntent ?? "（未知）"} ↩${intentId}`);
    const outId = l.finalReply?.entryId ?? l.turnEndEntryId;
    lines.push(`- 最终回复（摘要）：${l.summary.outcome ?? "（无）"} ↩${outId}`);
    return lines.join("\n") + "\n";
  }
  // L1–L3 共通骨架：用户行 + 图片占位行（L3 用户侧仍是原文）
  const uq = l.userMessage;
  if (uq) {
    lines.push(`### T${n} · 用户：「${uq.text.replace(/\n+/g, " ")}」`);
  } else {
    lines.push(`### T${n} · 用户意图：${l.summary.userIntent ?? "（未知）"} ↩${l.turnStartEntryId}`);
  }
  const imagesLine = renderImagesLine(l);
  if (imagesLine) lines.push(imagesLine);
  // 动作行：L1/L2 渲染；L3 起全丢（spec §3：L3 删除的是"工具过程"这一整类信息）
  if (lvl <= 2) {
    for (const e of l.summary.entries) {
      const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
      if (lvl === 1) {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.target} → ${e.detail}${recall}`);
      } else {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.detail}${recall}`);
      }
    }
  }
  if (l.finalReply) {
    lines.push("最终回复（原文）：");
    lines.push(l.finalReply.text);
  } else if (l.summary.outcome !== undefined) {
    lines.push(`- 结果：${l.summary.outcome}`);
  }
  return lines.join("\n") + "\n";
}
```

4. `renderActionLedger` 中聚合分支（约 149-160 行）：`=== 4` 改 `=== 5`，删除 IDs 拼接：

```ts
if ((l.level ?? 1) === 5) {
  let end = i;
  while (end + 1 < ledgers.length && (ledgers[end + 1].level ?? 1) === 5) end++;
  const group = ledgers.slice(i, end + 1);
  const desc = group[0].merged?.description ?? "（已合并）";
  const range = group.length > 1 ? `T${i + 1}-T${end + 1}` : `T${i + 1}`;
  lines.push(`### ${range} · ${desc}\n`);
  i = end;
  continue;
}
```

（原分支里的 `for (const m of group) ids.push(...allRecallIds(m, true))` 与 `uniq` 相关行全部删除。）

- [ ] **Step 4: 运行确认绿灯**

Run: `npx vitest run tests/ledger.test.ts 2>&1 | grep -E "Tests "`
Expected: PASS（「图片占位行」describe 不回归——L3 仍渲染占位行，L4/L5 不渲染由新骨架天然保证）

- [ ] **Step 5: 全量回归 + 提交**

Run: `npx vitest run 2>&1 | grep -E "Tests " && npx tsc --noEmit && echo ok`
Expected: degrade/integration 若有旧语义断言变红——**那是 Task 2 的范围**，本任务只允许 ledger.test.ts 相关失败以外全绿。若有 degrade 测试红，先记录数量（Task 2 会重写），但 integration/extension 必须绿；若 integration 红，检查是否 fixture 用了 L4 merged 语义并同步修正 fixture（改动仅限测试数据，不改断言语义）。

```bash
git add -A && git commit -m "refactor: renderTurnText 五级阶梯——L3 丢动作行保两端原文、L4 意图+outcome、L5 合并无 IDs"
```

---

### Task 2: 降级层——瀑布右移一层，L2→L3 机械降级

**Files:**
- Modify: `src/degrade.ts`（DegradeStep/DegradePlan、chooseOldestForLevel 签名、planDegrade、DegradeEngine.run）
- Test: `tests/degrade.test.ts`

**Interfaces:**
- Consumes: Task 1 的新渲染（turnRenderTokens 自动跟随）；`compressEnds`（L3→L4 用）、`mergeDescribe`（L4→L5 用，输入换 L4 渲染文本）
- Produces: `DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 | 5 }`；`DegradePlan { steps: DegradeStep[]; mergeGroups: string[][] }`（mergeGroups 语义 = 相邻 **toLevel=5** 条目分组）；`chooseOldestForLevel(ledgers, level: 1|2|3|4, threshold, reserve)`。

- [ ] **Step 1: 重写失败测试**

`tests/degrade.test.ts` 全文件替换（helper 与断言按新语义重写；原文件中仍适用的用例结构保留，如 `turnRenderTokens` 相关）：

```ts
import { describe, it, expect } from "vitest";
import { planDegrade, chooseOldestForLevel, turnRenderTokens, DegradeEngine } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";

/** 撑体积 helper：L1/L2/L3 渲染含 finalReply 全文，L4 渲染 intent/outcome（短），L5 渲染 merged 行（短） */
function ledger(id: string, level: 1 | 2 | 3 | 4, tokens: number): LedgerData {
  const pad = "x".repeat(tokens * 4);
  if (level === 4) {
    return {
      turnStartEntryId: id, turnEndEntryId: id, level: 4,
      summary: { userIntent: pad.slice(0, 10), outcome: pad, entries: [] },
    };
  }
  return {
    turnStartEntryId: id, turnEndEntryId: id, level,
    summary: { entries: [] },
    finalReply: { text: pad, entryId: id },
    userMessage: { text: "u", entryId: id },
  };
}

describe("planDegrade", () => {
  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("degrades oldest L1 turns preserving reserve floor when L1 exceeds threshold", () => {
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 },
    ]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("waterfalls: L2 overflow degrades oldest to L3", () => {
    const ls = [ledger("t1", 1, 9000), ledger("t2", 1, 9000), ledger("t3", 2, 9000), ledger("t4", 2, 9000), ledger("t5", 2, 9000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 3 }, { turnStartEntryId: "t4", toLevel: 3 },
    ]);
  });

  it("waterfall feeds down: L1 overflow creates new L2 counted in L2 total", () => {
    const ls = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    // L1 总 72K：选 6 条降 L2 剩 18K ≥ reserve；L2 快照 54K → 再选 4 条降 L3 剩 18K
    expect(p.steps.filter((s) => s.toLevel === 2)).toHaveLength(6);
    expect(p.steps.filter((s) => s.toLevel === 3)).toHaveLength(4);
  });

  it("L3 overflow degrades oldest to L4 (compressEnds level), not merge groups", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 3, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 4 }, { turnStartEntryId: "t2", toLevel: 4 },
      { turnStartEntryId: "t3", toLevel: 4 },
    ]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("L4 overflow degrades to L5 and groups adjacent selections", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 4, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId)).toEqual(["t1", "t2", "t3"]);
    expect(p.mergeGroups).toEqual([["t1", "t2", "t3"]]);
  });

  it("splits non-adjacent L4→L5 selections into separate groups", () => {
    const ls2 = [ledger("a1", 4, 9000), ledger("a2", 1, 9000), ledger("a3", 4, 9000), ledger("a4", 4, 9000), ledger("a5", 4, 9000), ledger("a6", 4, 9000), ledger("a7", 4, 9000)];
    const p2 = planDegrade(ls2, 40000, 10000);
    const ids = p2.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId);
    expect(ids).toEqual(["a1", "a3", "a4", "a5"]); // a6 保留：剩余 9K < reserve 10K
    expect(p2.mergeGroups).toEqual([["a1"], ["a3", "a4", "a5"]]); // 非相邻分组
  });

  it("single oversized oldest turn still selected (progress guarantee)", () => {
    const ls = [ledger("big", 1, 50000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([{ turnStartEntryId: "big", toLevel: 2 }]);
  });

  it("does not mutate input ledgers (works on copies)", () => {
    const ls = [ledger("t1", 1, 30000), ledger("t2", 1, 30000)];
    planDegrade(ls, 40000, 10000);
    expect(ls[0].level).toBe(1);
    expect(ls[1].level).toBe(1);
  });
});

describe("chooseOldestForLevel", () => {
  it("returns empty when level under threshold", () => {
    expect(chooseOldestForLevel([ledger("a", 1, 1000)], 1, 40000, 10000)).toEqual([]);
  });

  it("selects only entries of the requested level", () => {
    const ls = [ledger("a", 1, 9000), ledger("b", 2, 9000), ledger("c", 1, 9000)];
    const got = chooseOldestForLevel(ls, 1, 12000, 5000);
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["a"]);
  });

  it("preserves hard reserve floor: stops before an entry would break the reserve", () => {
    const ls = [1, 2, 3, 4].map((i) => ledger(`t${i}`, 3, 9000));
    const got = chooseOldestForLevel(ls, 3, 20000, 10000);
    // 选 t1(9K)、t2(18K) 后剩 18K ≥ 10K；选 t3 会剩 9K < 10K → 停
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2"]);
  });

  it("degrades at least one entry when reserve floor unsatisfiable (progress guarantee)", () => {
    const ls = [ledger("big", 4, 50000)];
    const got = chooseOldestForLevel(ls, 4, 40000, 10000);
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["big"]);
  });

  it("accepts level 4 (L4→L5 selection)", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 4, 9000));
    const got = chooseOldestForLevel(ls, 4, 40000, 10000);
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("DegradeEngine", () => {
  type Backend = { complete(prompt: string, signal?: AbortSignal): Promise<string> };
  function makeBackend(responses: string[], log: string[]): Backend {
    let i = 0;
    return {
      complete: async (_p, _s) => {
        log.push(`call${i}`);
        return responses[i++] ?? "{}";
      },
    };
  }
  const config = { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any;

  it("applies L1->L2 rule degradation and persists via onLedger", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(makeBackend([], log), config, (d) => {}, () => {});
    const ls = [ledger("t1", 1, 30000), ledger("t2", 1, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(2);
    expect(log).toEqual([]); // 机械层零 LLM
  });

  it("L2->L3 is mechanical: no LLM call, no intent/outcome generation", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(makeBackend([], log), config, (d) => {}, () => {});
    const ls = [ledger("t1", 2, 30000), ledger("t2", 2, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(3);
    expect(log).toEqual([]); // spec 裁定 #3：L2→L3 零 LLM
  });

  it("uses backend compressEnds for L3->L4 and writes intent/outcome", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"userIntent":"修复排序","outcome":"已推送"}'], log),
      config, (d) => {}, () => {},
    );
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(4);
    expect(ls[0].summary.userIntent).toBe("修复排序");
    expect(ls[0].summary.outcome).toBe("已推送");
    expect(log).toEqual(["call0"]); // 单 turn 一条一次调用
  });

  it("rolls back L3->L4 to level 3 on backend failure and warns", async () => {
    const warnings: string[] = [];
    const backend: Backend = { complete: async () => { throw new Error("boom"); } };
    const engine = new DegradeEngine(backend, config, (d) => {}, (m) => warnings.push(m));
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it("merges L4→L5 group and stamps description on every member", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"description":"调查代码结构"}'], log),
      config, (d) => {}, () => {},
    );
    const ls = [ledger("a", 4, 30000), ledger("b", 4, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(5);
    expect(ls[1].level).toBe(5);
    expect(ls[0].merged?.description).toBe("调查代码结构");
    expect(ls[1].merged?.description).toBe("调查代码结构");
    expect(log).toEqual(["call0"]); // 一组一次调用
  });

  it("rolls back L5 merge group to L4 on backend failure", async () => {
    const warnings: string[] = [];
    const backend: Backend = { complete: async () => { throw new Error("boom"); } };
    const engine = new DegradeEngine(backend, config, (d) => {}, (m) => warnings.push(m));
    const ls = [ledger("a", 4, 30000), ledger("b", 4, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(4);
    expect(ls[1].level).toBe(4);
    expect(warnings).toHaveLength(1);
  });

  it("executes serially: level written before LLM call, one call at a time", async () => {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const backend: Backend = {
      complete: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        log.push("call");
        return '{"userIntent":"i","outcome":"o"}';
      },
    };
    const engine = new DegradeEngine(backend, config, (d) => {}, () => {});
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000), ledger("t3", 3, 30000)];
    await engine.run(ls);
    expect(maxInFlight).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认红灯**

Run: `npx vitest run tests/degrade.test.ts 2>&1 | grep -E "Tests |×"`
Expected: FAIL（L3→L4/L4→L5、机械 L2→L3 等新断言全红）

- [ ] **Step 3: 实现 degrade.ts**

1. 类型与常量：

```ts
export interface DegradeStep { turnStartEntryId: string; toLevel: 2 | 3 | 4 | 5 }

export interface DegradePlan {
  /** 本次需要降级的 (turnStartEntryId, toLevel) 列表，最旧优先 */
  steps: DegradeStep[];
  /** L5 合并组：每组为一段连续需合并的 turnStartEntryId（相邻即同组，描述由 mergeDescribe 生成） */
  mergeGroups: string[][];
}
```

2. `chooseOldestForLevel` 签名放宽（函数体不变）：

```ts
export function chooseOldestForLevel(
  ledgers: LedgerData[], level: 1 | 2 | 3 | 4, threshold: number, reserve: number,
): LedgerData[] {
```

3. `planDegrade`：levels 数组与 working 类型、mergeGroups 来源：

```ts
export function planDegrade(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
): DegradePlan {
  const steps: DegradeStep[] = [];
  const working: Array<{ l: LedgerData; level: 1 | 2 | 3 | 4 | 5 }> = ledgers.map((l) => ({ l, level: l.level ?? 1 }));
  const levels: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4];   // 瀑布右移一层：L1→2→3→4→5
  for (const level of levels) {
    const selected = chooseOldestForLevel(
      working.map((w) => ({ ...w.l, level: w.level as 1 | 2 | 3 | 4 })),
      level, thresholdTokens, reserveTokens,
    );
    const chosen = new Set(selected.map((s) => s.turnStartEntryId));
    for (const w of working) {
      if (w.level === level && chosen.has(w.l.turnStartEntryId)) {
        const to = (level + 1) as 2 | 3 | 4 | 5;
        w.level = to;
        steps.push({ turnStartEntryId: w.l.turnStartEntryId, toLevel: to });
      }
    }
  }
  // L5 组：toLevel=5 的条目按原 ledgers 顺序相邻分组
  const degraded5 = new Set(steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId));
  const mergeGroups: string[][] = [];
  let cur: string[] = [];
  for (const l of ledgers) {
    if (degraded5.has(l.turnStartEntryId)) {
      cur.push(l.turnStartEntryId);
    } else if (cur.length) {
      mergeGroups.push(cur);
      cur = [];
    }
  }
  if (cur.length) mergeGroups.push(cur);
  return { steps, mergeGroups };
}
```

4. `DegradeEngine.run`：toLevel=3 段改为机械、toLevel=4 段走 compressEnds：

```ts
    for (const step of plan.steps.filter((s) => s.toLevel === 2)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 2;
      this.onLedger(l);
    }
    // L2→L3 纯机械：丢动作行（渲染层视图切换），零 LLM（spec 裁定 #3）
    for (const step of plan.steps.filter((s) => s.toLevel === 3)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 3;
      this.onLedger(l);
    }
    // L3→L4：compressEnds 压两端原文为 intent/outcome（原 L2→L3 逻辑右移）
    for (const step of plan.steps.filter((s) => s.toLevel === 4)) {
      const l = byId.get(step.turnStartEntryId)!;
      l.level = 4; // 先写 level：持久化与 LLM 压缩同一时序
      try {
        const ends = await compressEnds(this.backend, l);
        l.summary = { ...l.summary, userIntent: ends.userIntent, outcome: ends.outcome };
        this.onLedger(l);
      } catch (err) {
        l.level = 3; // 回滚：保持原层级
        this.onWarning(`context-compress: turn ${l.turnStartEntryId} L4 压缩失败（${String(err)}），保持 L3`);
      }
    }
```

5. 合并组段（原 toLevel=4 组逻辑右移为 L4→L5）：

```ts
    for (const group of plan.mergeGroups) {
      const members = group.map((id) => byId.get(id)!);
      for (const m of members) m.level = 5;
      try {
        const { description } = await mergeDescribe(this.backend, members);
        for (const m of members) {
          m.merged = { description };
          this.onLedger(m);
        }
      } catch (err) {
        for (const m of members) m.level = 4; // 回滚：保持原层级
        this.onWarning(`context-compress: L5 合并失败（${String(err)}），保持 L4`);
      }
    }
```

- [ ] **Step 4: 运行确认绿灯 + 修联级失败**

Run: `npx vitest run 2>&1 | grep -E "Tests |×" | head -12`
Expected: degrade 绿；integration（tests/integration*.test.ts）可能红——fixture 的期望值编码了旧瀑布（如「L4 合并」字样）。逐个修：期望层级右移一层、合并行断言改为无 IDs。extension.test.ts 的降级相关用例同理。**只允许改测试期望值与 fixture，不允许改实现来迁就旧断言。**

- [ ] **Step 5: 全绿 + tsc + 提交**

```bash
npx vitest run 2>&1 | grep -E "Tests " && npx tsc --noEmit && echo ok
git add -A && git commit -m "refactor: 降级瀑布右移一层——L2→L3 机械、compressEnds 至 L3→L4、mergeDescribe 至 L4→L5"
```

---

### Task 3: recall 三档语义——L3/L4 turn 级召回、L5 拒绝

**Files:**
- Modify: `src/recall.ts`（executeRecall 签名与主循环、executeRecallDual 透传）
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: `splitIntoTurns`（util.ts 已导出）、`serializeForRecall`（util.ts 已导出）、`LedgerData`（Task 1 的 level 5 类型）
- Produces: `executeRecall(ids, branch, maxTokensPerEntry, degradeCtx?: RecallDegradeCtx): RecallResult`，其中 `interface RecallDegradeCtx { ledgers: LedgerData[]; turns: Turn[] }`（`Turn` 从 util.ts 导入）；`executeRecallDual(ids, branch, notes, maxTokensPerEntry, degradeCtx?)` 同步加第 5 参。degradeCtx 缺省 = 现行为（entry 级），零破坏。

- [ ] **Step 1: 写失败测试**

`tests/recall.test.ts` 末尾追加（文件头补导入 `splitIntoTurns`、`MessageEntry` 若未导入）：

```ts
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
    expect(noCtx.text).toContain("tc1");            // 配对 toolResult 连带（既有语义）
    const l1 = executeRecallDual(["a1"], branch, null, 4000, mkCtx(1));
    expect(l1.text).toContain("tc1");
    const l2 = executeRecallDual(["a1"], branch, null, 4000, mkCtx(2));
    expect(l2.text).toContain("tc1");
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
});
```

- [ ] **Step 2: 运行确认红灯**

Run: `npx vitest run tests/recall.test.ts 2>&1 | grep -E "Tests |×"`
Expected: FAIL（三档用例红：turn 级不生效、L5 返回原文）

- [ ] **Step 3: 实现 recall.ts**

1. 类型（文件头部 `RecallResult` 附近）：

```ts
import { splitIntoTurns, serializeForRecall, stripThinking, type MessageEntry, type Turn } from "./util.js";
import type { LedgerData } from "./ledger.js";

/** recall 层级路由上下文：ledgers 按 branch 序（index.ts 的 ledgersInBranchOrder 产出） */
export interface RecallDegradeCtx { ledgers: LedgerData[]; turns: Turn[] }
```

2. 把现有主循环内的 `collectImages` 闭包提取为模块级函数（turn 级路径要复用）：

```ts
function collectImages(m: any, sourceId: string, imgs: RecallImage[], seen: Set<string>): void {
  if (Array.isArray(m?.content)) {
    for (const b of m.content) {
      if (b?.type === "image" && typeof b.data === "string") {
        const key = `${b.mimeType ?? "image/png"}:${b.data}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imgs.push({ block: { type: "image", data: b.data, mimeType: b.mimeType ?? "image/png" }, sourceId });
      }
    }
  }
}
```

（entry 级路径中原来的局部闭包改为调用此函数：`for (const m of msgs) collectImages(m, id, imgs, seen);`——行为零变化。）

3. `executeRecall` 加第 4 参并在主循环 id 分支开头插入路由：

```ts
export function executeRecall(
  ids: string[], branch: MessageEntry[], maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx,
): RecallResult {
  // ……现有 stripped/byId 构造不变……
  // entryId → 所属 turn；turnStartEntryId → ledger 层级（spec §7 三档路由）
  const turnOfEntry = new Map<string, Turn>();
  for (const t of degradeCtx?.turns ?? []) for (const e of t.entries) turnOfEntry.set(e.id, t);
  const levelOfTurn = new Map<string, number>();
  for (const l of degradeCtx?.ledgers ?? []) levelOfTurn.set(l.turnStartEntryId, l.level ?? 1);
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) { missing.push(id); continue; }
    const turn = degradeCtx ? turnOfEntry.get(id) : undefined;
    const lvl = turn ? levelOfTurn.get(turn.startEntryId) ?? 1 : 1;
    if (turn && lvl >= 3 && lvl <= 4) {
      // turn 级：整段原文（恢复被丢的工具过程/两端原文，spec §7）
      let text = serializeForRecall(turn.entries.map((te) => ({ id: te.id, message: te.message as any })));
      if (text.length > maxTokensPerEntry * 4) {
        text = text.slice(0, maxTokensPerEntry * 4) + `\n…（已截断，原 turn 过大；如需其余部分请用相邻 ID 分段 recall）`;
      }
      const imgs: RecallImage[] = [];
      const seen = new Set<string>();
      for (const te of turn.entries) collectImages(te.message, id, imgs, seen);
      if (imgs.length > 0) { text += `\n[含图片 ×${imgs.length}，已附在结果中]`; images.push(...imgs); }
      parts.push(`【${id} 所在 turn（L${lvl}）的整段原文】\n${text}`);
      continue;
    }
    if (turn && lvl === 5) {
      // L5 终态：拒绝召回（防连环巨条挤爆上下文，spec §7）
      parts.push(`【${id}】该 turn 已合并为终态摘要（L5），仅保留合并描述，细节不可恢复。`);
      continue;
    }
    // ……以下现有 entry 级路径原样保留……
  }
```

4. `executeRecallDual` 加透传（第 5 参，内部 `executeRecall(entryIds, branch, maxTokensPerEntry, degradeCtx)`）。

- [ ] **Step 4: 运行确认绿灯**

Run: `npx vitest run tests/recall.test.ts 2>&1 | grep -E "Tests "`
Expected: PASS（既有 36 用例零回归——degradeCtx 缺省路径不变）

- [ ] **Step 5: 全量 + 提交**

```bash
npx vitest run 2>&1 | grep -E "Tests " && npx tsc --noEmit && echo ok
git add -A && git commit -m "feat: recall 三档语义——L3/L4 turn 级整段召回、L5 终态拒绝、L1/L2 entry 级不变"
```

---

### Task 4: index.ts 接线——recall 传入层级上下文

**Files:**
- Modify: `src/index.ts`（recall 工具 execute 内约 266 行）
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `RecallDegradeCtx`；本文件已有的 `ledgersInBranchOrder(entries, false)`、`splitIntoTurns`
- Produces: recall 工具实际路由三档语义（集成生效）

- [ ] **Step 1: 写失败集成测试**

先读 `tests/extension.test.ts` 现有 recall 集成测试的 harness/fixture 构造方式（如何建 branch、如何让 store 落 ledger、如何调 recall 工具），按其惯例写用例。核心断言（语义固定，写法跟随现有 harness）：

```ts
it("recall 按 ledger 层级路由：L3 turn 的 ID 返回整段原文", async () => {
  // 构造：branch 含 user→toolCall→toolResult→reply 一个 turn；store 中该 turn ledger level=3
  // 动作行任一 ID 召回应得整段原文（含工具过程），而非单 entry 文本
  const out = await <现有 harness 方式调用 recall>({ ids: [<toolResult entry id>] });
  expect(out).toContain("整段原文");
  expect(out).toContain("<工具结果文本>");   // 工具过程整段可见
});
```

- [ ] **Step 2: 运行确认红灯**

Run: `npx vitest run tests/extension.test.ts -t "整段原文" 2>&1 | grep -E "Tests |×"`
Expected: FAIL（index.ts 未接线，返回 entry 级文本）

- [ ] **Step 3: 实现**

`src/index.ts` recall 工具 execute（约 266 行）：

```ts
      if (params.ids && params.ids.length > 0) {
        // 双源 recall：notes 条目 ID 优先查项目记忆，其余走 branch 原文路径；
        // 层级上下文驱动三档路由（L3/L4 turn 级、L5 拒绝、L1/L2 entry 级，spec §7）
        const r = executeRecallDual(params.ids, entries, notesStore, config?.recallMaxTokensPerEntry ?? 4_000, {
          ledgers: ledgersInBranchOrder(entries, false),
          turns: splitIntoTurns(entries),
        });
```

（`splitIntoTurns` 已在 import 列表则不动，若无则补。）

- [ ] **Step 4: 运行确认绿灯 + 全量**

```bash
npx vitest run tests/extension.test.ts 2>&1 | grep -E "Tests " && npx vitest run 2>&1 | grep -E "Tests " && npx tsc --noEmit && echo ok
```

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: recall 工具接线层级上下文，三档召回语义集成生效"
```

---

### Task 5: README 同步

**Files:**
- Modify: `README.md`（约 128-136 行「动作日志四级分层」小节、约 13 行细节取回描述、约 113 行配置表瀑布说明）
- Test: 无新测试（纯文档）；全量回归防误伤

**Interfaces:**
- Consumes: Task 1-4 的最终行为
- Produces: 文档与新行为一致

- [ ] **Step 1: 更新分层小节**

README 约 128 行起的小节标题与层级列表替换为：

```markdown
### 动作日志五级分层（L1–L5）

窗外已摘要 turn 的动作日志头按五级渐进压缩，每层超过 `ledgerDegradeThresholdTokens`（默认 40K tokens）时，最旧 turns 降级到下一层（保留尾部约 `ledgerReserveTokens`，按 turn 边界取整），后台异步瀑布执行（每轮回复落盘后逐级检测，任一层不超标即停止），降级结果持久化到 ledger，装配时直接读取。每级只删一类信息：命令 → 工具过程 → 两端原文 → 条目边界：

- **L1** 用户原文 + 动作（命令+摘要+↩ID）+ 最终回复原文
- **L2** 丢动作中的命令，两端原文保留
- **L3** 丢全部动作行（工具过程），用户原文与最终回复原文保留——纯机械降级，零 LLM 调用
- **L4** 用户意图（↩ID）+ 最终回复摘要（↩ID）——本地模型生成（compressEnds）
- **L5** 多 turn 合并一行 `T3-T7 · 描述（N 条已合并）`——本地模型生成（mergeDescribe）；**行尾无 ↩ID，细节不可召回**
- **图片**：用户消息中的图片在 L1–L3 渲染占位行 `[图片 ×N: mime1, mime2 ↩entryId]`（不随层级降级）；L4 起不渲染占位行，图片存在感由摘要描述承载。
```

- [ ] **Step 2: 更新召回语义说明**

约 13 行的项目符号追加召回路由说明（或在该行后新增一条）：

```markdown
- **召回按层级路由**：L1/L2 条目的 ↩ID 返回该 entry 逐字原文（toolCall 连带配对 toolResult）；L3/L4 的 ↩ID 返回**所在 turn 的整段原文**（被压缩丢弃的工具过程完整恢复）；L5 无 ↩ID 可见，持旧 ID 召回会得到「已合并为终态摘要」说明。整段召回同样受 `recallMaxTokensPerEntry` 预算约束。
```

- [ ] **Step 3: 更新配置表瀑布描述**

约 113 行配置表 `ledgerDegradeThresholdTokens` 行的说明里 `逐级瀑布 L1→L2→L3→L4` 改为 `逐级瀑布 L1→L2→L3→L4→L5`。

- [ ] **Step 4: 全文一致性扫描**

Run: `grep -n "L4" README.md`
逐一核对残留的「L4」字样：旧「合并一行」的描述应已全部指向 L5；「四级分层」「L1→L2→L3→L4」等字样全部替换。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npx vitest run 2>&1 | grep -E "Tests " && npx tsc --noEmit && echo ok
git add -A && git commit -m "docs: README 同步五级阶梯（L1–L5）与三档召回语义"
```

---

## Self-Review 结论

- **Spec 覆盖**：§3 阶梯→Task 1/2；§4 渲染→Task 1；§5 存量兼容→Task 1（legacy 两个用例）；§6 降级→Task 2；§7 召回→Task 3/4；§9 测试计划→各任务步骤；§10 顺序→任务排布一致；§8「不做」无对应任务（正确）。
- **占位符扫描**：Task 4 Step 1 的 harness 以「读现有测试再按断言语义写」为指引——这是有意的（harness 形状以文件现状为准），断言语义已完整给出，非占位符。
- **类型一致性**：`DegradeStep.toLevel: 2|3|4|5`（Task 2 定义并消费）；`RecallDegradeCtx { ledgers: LedgerData[]; turns: Turn[] }`（Task 3 定义、Task 4 消费）；`level?: 1|2|3|4|5`（Task 1 定义、Task 2/3 依赖）；`executeRecallDual` 第 5 参（Task 3 定义、Task 4 消费）。链路核对无名称漂移。
