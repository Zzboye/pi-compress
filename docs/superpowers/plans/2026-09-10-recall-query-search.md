# recall 关键词检索模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 recall 工具增加 `query` 关键词检索模式，让 LLM 在动作日志降级（L3/L4 线索稀薄）后仍能零模型调用地定位内容，再按 ID 取回逐字原文。

**Architecture:** 搜索函数 `searchLedger` 读 `LedgerStore` 的全量 `LedgerData`（userMessage/finalReply 逐字全文 + target/detail/merged.description——降级只改渲染，不改底层数据），做大小写不敏感子串匹配，输出「turn 归属 + 命中行片段 + 可直接取回的 entry ID」索引；`executeRecall` 现有 ids 路径原样保留，工具 schema 加可选 `query` 参数。搜索与取回共用同一套 session entry ID 命名空间，无映射层。

**Tech Stack:** TypeScript、vitest、typebox（工具 schema）；无新依赖。

## Global Constraints

- 所有输出面向 LLM 的文本、注释、文档使用中文（与现有代码风格一致）。
- 零新 npm 依赖；只用字符串匹配，不引入 embedding/索引。
- 搜索范围是 `LedgerData` **全量字段**（不受渲染层级影响），这是"降级可激进、检索兜底"设计的关键。
- 搜索命中的 ID 必须与 `executeRecall` 的查找键同一命名空间（`LedgerData` 内的 `recallIds` / `userMessage.entryId` / `finalReply.entryId` / `turnStartEntryId`），保证召回必中（除非 /tree 回退，由现有 missing 提示兜底）。
- 不改动装配链路（assembler/forcepoint/degrade/summarizer 一概不动）。
- 每个任务结束跑 `npx vitest run tests/recall.test.ts tests/extension.test.ts` 确认无回归，`npm test` 在最终任务跑全量。

---

### Task 1: `searchLedger` 搜索函数（TDD）

**Files:**
- Modify: `src/recall.ts`
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: `LedgerData`（`src/ledger.ts`，含 `userMessage?.text`、`finalReply?.text`、`summary.groups[].entries[].{target,detail,recallIds}`、`merged?.description`、`level?`）、`LedgerStore`（`src/store.ts`，`keys()/get()`）。
- Produces:
  ```ts
  export interface SearchHit {
    turnLabel: string;   // "T12" 或 "T29-T33"（L4 已聚合组显示组范围）
    level: 1 | 2 | 3 | 4;
    field: string;       // "用户消息" | "最终回复" | "动作" | "合并描述"
    snippet: string;     // 命中行片段（截断到 ~200 chars）
    entryIds: string[];  // 该字段关联、可直接 recall 的 ID（有序去重）
  }
  export interface SearchResult { hits: SearchHit[]; truncated: boolean }
  export function searchLedger(query: string, ledgers: LedgerData[], maxHits: number): SearchResult
  ```
  调用方传入由 `store.keys().map(k => store.get(k)!).sort((a,b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId))` 得到的有序 ledgers 数组（与 index.ts 现有排序一致），以及 `maxHits`（推荐 15）。

- [ ] **Step 1: 写失败测试**

在 `tests/recall.test.ts` 顶部补 import 并追加 describe 块：

```ts
import { executeRecall, searchLedger } from "../src/recall.js";
import type { LedgerData } from "../src/ledger.js";

function mkLedger(partial: Partial<LedgerData> & { turnStartEntryId: string }): LedgerData {
  return {
    turnEndEntryId: partial.turnStartEntryId + "-end",
    summary: { groups: [] },
    ...partial,
  } as LedgerData;
}

describe("searchLedger", () => {
  const ledgers: LedgerData[] = [
    mkLedger({
      turnStartEntryId: "t1", level: 1,
      userMessage: { text: "forceRatio 是什么？为什么默认 0.76", entryId: "t1-u" },
      finalReply: { text: "forceRatio 是触发强制点的比例", entryId: "t1-f" },
      summary: { groups: [{ phase: "investigate", entries: [
        { action: "read", target: "src/config.ts", detail: "校验 forceRatio 范围", recallIds: ["t1-a"] },
      ] }] },
    }),
    mkLedger({
      turnStartEntryId: "t2", level: 3,
      summary: { userIntent: "了解 keepRecentTokens", groups: [] },
      userMessage: { text: "keepRecentTokens 怎么配？", entryId: "t2-u" },
    }),
    mkLedger({
      turnStartEntryId: "t3", level: 4,
      merged: { description: "调整 forceRatio 并验证窗口行为" },
      summary: { groups: [{ phase: "fix", entries: [
        { action: "edit", target: "a.ts", detail: "改 forceRatio 默认值", recallIds: ["t3-a1", "t3-a2"] },
      ] }] },
    }),
  ];

  it("命中用户消息/最终回复/动作/合并描述，返回 turn 标签 + 片段 + entry ID", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    expect(r.hits.length).toBe(3); // t1 user、t1 finalReply、t1 action + t3 action + t3 merged = 5？按设计：每字段一条命中
  });
});
```

（设计决策：**每个命中的「字段」产出一个 hit**——同 turn 多字段命中会返回多条，`entryIds` 指向该字段的来源条目，模型取回时目标明确。断言值请在实现后按此口径修正为 5，再细拆为下列分例。）

- [ ] **Step 2: 把上面的粗断言拆成精确断言（仍然失败）**

```ts
  it("命中用户消息 → field=用户消息，entryIds 含 userMessage.entryId", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "用户消息")!;
    expect(h.turnLabel).toBe("T1");
    expect(h.entryIds).toContain("t1-u");
    expect(h.snippet).toContain("forceRatio");
  });

  it("命中动作 detail → entryIds 用 recallIds（不是 turnStartEntryId）", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "动作")!;
    expect(h.entryIds).toEqual(["t1-a"]);
  });

  it("命中 L4 merged.description → turnLabel 显示组内 turn 范围", () => {
    const r = searchLedger("forceRatio", ledgers, 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3");
  });

  it("大小写不敏感", () => {
    const r = searchLedger("FORCERATIO", ledgers, 15);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("maxHits 截断 + truncated 标记", () => {
    const r = searchLedger("forceRatio", ledgers, 2);
    expect(r.hits.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("L4 连续组 turnLabel 显示范围（多 ledger L4 相邻时合并为 T3-T4）", () => {
    const t4 = mkLedger({
      turnStartEntryId: "t4", level: 4,
      merged: { description: "继续验证 forceRatio" },
      summary: { groups: [] },
    });
    const r = searchLedger("forceRatio", [...ledgers, t4], 15);
    const h = r.hits.find((x) => x.field === "合并描述")!;
    expect(h.turnLabel).toBe("T3-T4");
  });

  it("无命中返回空 hits 且不 truncated", () => {
    const r = searchLedger("zzz不存在", ledgers, 15);
    expect(r.hits).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("空 query 或纯空白 query 返回空结果（防全量倾泻）", () => {
    expect(searchLedger("", ledgers, 15).hits).toEqual([]);
    expect(searchLedger("   ", ledgers, 15).hits).toEqual([]);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/recall.test.ts`
Expected: FAIL（`searchLedger` 未导出）

- [ ] **Step 4: 实现 `searchLedger`**

`src/recall.ts` 追加：

```ts
import type { LedgerData } from "./ledger.js";

export interface SearchHit {
  turnLabel: string;
  level: 1 | 2 | 3 | 4;
  field: string;
  snippet: string;
  entryIds: string[];
}
export interface SearchResult { hits: SearchHit[]; truncated: boolean }

const SNIPPET_MAX = 200;

function snippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, idx - 60);
  const raw = text.slice(start, idx + query.length + 60);
  const s = (start > 0 ? "…" : "") + raw.replace(/\s+/g, " ") + (start + raw.length < text.length ? "…" : "");
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "…" : s;
}

function mkHit(level: LedgerData["level"], field: string, text: string, query: string, ids: string[]): SearchHit {
  return { turnLabel: "", level: level ?? 1, field, snippet: snippet(text, query), entryIds: [...new Set(ids)] };
}

/**
 * 关键词检索：在 LedgerData 全量字段（不受渲染层级影响）做大小写不敏感子串匹配。
 * 返回可 recall 的 entry ID（与 executeRecall 同一命名空间，召回必中，/tree 回退除外）。
 * turnLabel 由调用方按数组下标生成（renderActionLedger 同款 T 序号），此处占位由 decorate 填充。
 */
export function searchLedger(query: string, ledgers: LedgerData[], maxHits: number): SearchResult {
  const q = query.trim();
  if (!q) return { hits: [], truncated: false };
  const hits: SearchHit[] = [];
  const lower = q.toLowerCase();
  for (let i = 0; i < ledgers.length; i++) {
    const l = ledgers[i];
    const lvl = l.level ?? 1;
    // L4 组范围：向后聚合连续 level=4（renderActionLedger 同款逻辑）
    let groupEnd = i;
    if (lvl === 4) { while (groupEnd + 1 < ledgers.length && (ledgers[groupEnd + 1].level ?? 1) === 4) groupEnd++; }
    const label = groupEnd > i ? `T${i + 1}-T${groupEnd + 1}` : `T${i + 1}`;
    const push = (field: string, text: string, ids: string[]) => {
      if (text && text.toLowerCase().includes(lower)) hits.push({ ...mkHit(lvl, field, text, q, ids), turnLabel: label });
    };
    if (l.userMessage) push("用户消息", l.userMessage.text, [l.userMessage.entryId]);
    if (l.finalReply) push("最终回复", l.finalReply.text, [l.finalReply.entryId]);
    for (const g of l.summary.groups) {
      for (const e of g.entries) push("动作", `${e.target} → ${e.detail}`, e.recallIds);
    }
    if (l.merged?.description) push("合并描述", l.merged.description, allRecallIdsOf(l, true));
    if (hits.length >= maxHits) { i = groupEnd; break; }
  }
  const truncated = hits.length > maxHits;
  return { hits: hits.slice(0, maxHits), truncated };
}

function allRecallIdsOf(l: LedgerData, includeQuotes: boolean): string[] {
  const ids: string[] = [];
  for (const g of l.summary.groups) for (const e of g.entries) ids.push(...e.recallIds);
  if (includeQuotes && l.userMessage) ids.push(l.userMessage.entryId);
  if (includeQuotes && l.finalReply) ids.push(l.finalReply.entryId);
  return ids;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/recall.test.ts`
Expected: PASS（含 Task 1 Step 2 的全部分例；若 turnLabel 分例失败，检查 L4 组聚合边界）

- [ ] **Step 6: Commit**

```bash
git add src/recall.ts tests/recall.test.ts
git commit -m "feat: searchLedger 关键词检索函数（LedgerData 全量字段，大小写不敏感）"
```

---

### Task 2: recall 工具接入 query 参数（TDD）

**Files:**
- Modify: `src/index.ts`（recall registerTool 块，约 152-170 行）
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `searchLedger(query, ledgers, maxHits): SearchResult`、`SearchHit`；`LedgerStore`（`store.keys()/get()`）；现有排序 `store.keys().map(k => store.get(k)!).sort((a,b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId))`。
- Produces: recall 工具 schema 变为 `ids?` + `query?`（二者至少传一个）；LLM 可见输出格式 `formatSearchResult`；`recallStats` 增加 `searches` 计数并在 `/compress-status` 展示「搜索 N 次 / 命中 M 条」。

- [ ] **Step 1: 写失败测试**

`tests/extension.test.ts` 在现有 recall 计数用例后追加（沿用该文件的 fakeCtx/sessionManager 模式；`t1` 等为该文件已注入的 ledger——若 fixture 无 ledger，先看 `tests/extension.test.ts` 现有 setup 补一个 `appendCustomEntry(LEDGER_CUSTOM_TYPE, {...})`）：

```ts
  it("recall 支持 query：返回命中索引（含 turn 标签/片段/ID）且计入 searches 统计", async () => {
    // setup: 确保至少一个 ledger 含关键词
    const out = await tools.recall.execute("tc1", { query: "测试关键词" }, undefined, undefined, fakeCtx);
    const text = out.content[0].text;
    expect(text).toContain("T");        // turn 标签
    expect(text).toContain("↩");        // 可 recall 的 ID
    // searches 统计
    const status = /* 调用 compress-status handler 后截取文本 */;
    expect(status).toContain("搜索 1");
  });

  it("recall 只传 query 无 ids、只传 ids 无 query 均合法；都不传返回用法提示", async () {
    await tools.recall.execute("tc1", { query: "x" }, undefined, undefined, fakeCtx);
    await tools.recall.execute("tc1", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    const neither = await tools.recall.execute("tc1", {}, undefined, undefined, fakeCtx);
    expect(neither.content[0].text).toContain("用法");
  });

  it("无命中时返回可操作的提示（建议换关键词）", async () {
    const out = await tools.recall.execute("tc1", { query: "绝不存在的词zzz" }, undefined, undefined, fakeCtx);
    expect(out.content[0].text).toContain("无命中");
  });
```

注意：`tests/extension.test.ts` 现有用例（如 `counts recall tool usage`）对 recall stats 文案的断言 `expect(out).toContain("调用 2")` 在 status 行文案变化后仍需通过——status 召回行改为：
`召回：调用 ${n} 次 / 取回 ${m} 条 / 未中 ${k} 个 ID / 搜索 ${s} 次`
（原「调用 N 次 / 取回 M 条 / 未中 K 个 ID」子串保持不变，追加搜索计数，不破坏现有断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/extension.test.ts`
Expected: FAIL（schema 无 query，统计无搜索计数）

- [ ] **Start 3: 实现**

`src/index.ts` 三处修改：

**a) import 增加 `formatSearchResult`（新增小函数，放 `src/recall.ts` 底部，Task 2 一并实现）：**

```ts
import { executeRecall, searchLedger, formatSearchResult } from "./recall.js";
```

`src/recall.ts` 追加：

```ts
/** LLM 可见的命中索引文本：命中行 = turn 标签 + [层级缩写] 字段：片段 ↩ids */
export function formatSearchResult(r: SearchResult): string {
  if (r.hits.length === 0) {
    return "无命中。建议：换更短或更具体的关键词（如文件名、函数名、命令词）；动作日志只覆盖窗外已摘要的 turn，近期内容可能仍在上下文窗口内。";
  }
  const lvlAbbr: Record<number, string> = { 1: "L1", 2: "L2", 3: "L3",  lvlAbbr[4] = "L4" }; // 实现时写成完整字面量
  const lines = r.hits.map((h) => {
    const ids = h.entryIds.length ? ` ↩${h.entryIds.join(",↩")}` : "";
    return `${h.turnLabel} [${lvlAbbr[h.level]}] ${h.field}：${h.snippet}${ids}`;
  });
  const tail = r.truncated ? `\n（命中过多，仅显示前 ${r.hits.length} 条；请换更具体的关键词缩小范围）` : "";
  return `命中 ${r.hits.length} 处：\n${lines.join("\n")}${tail}\n\n需要逐字原文时，调用 recall 并传入对应 ↩ 后的 ID。`;
}
```

（上面 `lvlAbbr` 行是示意伪码——实现时写正常字面量 `{ 1: "L1", 2: "L2", 3: "L3", 4: "L4" }`。）

**b) 工具 schema 与 execute：**

```ts
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "取回动作日志条目的逐字原文（含截断的用户消息/最终回复全文）。两种用法：① 传 ids：参数为动作日志中 ↩ 标记后的 entry ID 列表（可批量）；② 传 query：关键词检索已压缩的历史，返回命中位置 + 可召回的 ID（不返回原文，需再按 ID 取回）。",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "entry ID 列表，来自动作日志 ↩ 标记" })),
      query: Type.Optional(Type.String({ description: "关键词（大小写不敏感子串匹配），如文件名/函数名/命令词" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const q = params.query?.trim();
      if (!params.ids && !q) {
        return { content: [{ type: "text", text: "用法：传 ids（↩ 标记后的 entry ID 列表）取回逐字原文，或传 query 关键词检索历史定位 ID。" }] };
      }
      if (q && (!params.ids || params.ids.length ===  prioritized as search)) { /* 见下 */ }
      // query 优先：先搜索后取回，一次调用可两步合一
      ...
    },
  });
```

（上面 b) 的 execute 主体是骨架示意——最终行为：**query 与 ids 同传时先搜索再取回，两段结果拼接**；纯 ids 走现有 `executeRecall` 路径不变；统计字段 `recallStats` 增加 `searches` 与 `searchHits`。）

最终 execute 实现全文：

```ts
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = toMessageEntries(ctx.sessionManager.getBranch());
      const q = params.query?.trim() ?? "";
      const parts: string[] = [];
      if (q) {
        const ledgers = store.keys().map((k) => store.get(k)!).filter(Boolean)
          .sort((a, b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId));
        const r = searchLedger(q, ledgers, 15);
        recallStats.searches = (recallStats.searches ?? 0) + 1;
        recallStats.searchHits = (recallStats.searchHits ?? 0) + r.hits.length;
        parts.push(formatSearchResult(r));
      }
      if (params.ids && params.ids.length > 0) {
        const r = executeRecall(params.ids, entries, 4000); // 单条 4k tokens 戕断 → 实现时写 4_000
        recallStats.calls += 1;
        recallStats.hits += params.ids.length - r.missing.length;
        recallStats.missing += r.missing.length;
        parts.push(r.text);
      }
      return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }], details: undefined };
    },
```

**c) `/compress-status` 召回行追加搜索计数：**

```ts
        `召回：调用 ${recallStats.calls} 次 / 取回 ${recallStats.hits} 条 / 未中 ${recallStats.missing} 个 ID / 搜索 ${(recallStats as any).searches ?? 0} 次`,
```

（实现时把 `recallStats` 初始化改为 `{ calls: 0, hits: 0, missing: 0, searches: 0, searchHits: 0 }` 并在 session_start 重置处同步，去掉 `as any`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/extension.test.ts tests/recall.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/recall.ts tests/extension.test.ts
git commit -m "feat: recall 工具接入 query 检索模式（searchLedger + formatSearchResult + 统计）"
```

---

### Task 3: 文档与全量回归

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1/2 的最终行为（query 优先拼接、maxHits=15、无命中提示、统计行）。
- Produces: README 的 `/compress-status` 示例与 recall 描述同步。

- [ ] **Step 1: 更新 README 三处**

a) 「`/compress-status` 命令」示例块中召回行更新为：

```
召回：调用 4 次 / 取回 6 条 / 未中 0 个 ID / 搜索 1 次
```

b) recall 相关描述增加一段（放在「`/compress-status` 命令」一节之前，作为 recall 用法说明）：

```markdown
## recall 工具

两种用法：

```bash
recall({ query: "forceRatio" })   # 关键词检索：返回命中位置（turn + 片段）+ 可召回的 ID
recall({ ids: ["↩a3f2"] })        # 按 ID 取回逐字原文（含配对 toolResult，单条截断 4k tokens）
```

- **搜索范围是全量 `LedgerData`**（用户原话/最终回复逐字全文 + 动作 target/detail + L4 合并描述），不受 L1–L4 渲染降级影响——日志降级得再狠，可检索的原文永远在底层。
- **query 与 ids 可同传**：先返回命中索引，再附上所传 ID 的原文，一次调用两步合一。
- 搜索为大小写不敏感子串匹配，最多返回 15 条命中；无命中时提示换关键词。
- 搜索命中的 ID 与 recall 取回端同一命名空间，召回必中（/tree 回退裁掉的 ID 由 missing 提示兜底）。
```

c) 「项目结构」`src/` 树中 recall.ts 的描述更新为：

```
├── recall.ts       recall 工具实现：按 ID 取回逐字原文（含配对 toolResult）+ query 关键词检索
```

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补 recall query 检索用法与状态行"
```

---

## Self-Review 结论

- **覆盖**：搜索函数（Task 1）→ 工具接入与统计（Task 2）→ 文档（Task 3），与讨论一致（ID 语义经用户确认：一条消息一个 ID 全生命周期不变，L4 合并行是并集不是新 ID）。
- **类型一致性**：`SearchHit/SearchResult` 在 Task 1 定义、Task 2 消费，签名一致；`recallStats` 扩展字段在 Task 2 内自洽。
- **已知留白**：Task 2 测试步骤中标注了「若 fixture 无 ledger 需补 setup」，实现者需读 `tests/extension.test.ts` 现有 setup 后落地；`formatSearchResult` 中 lvlAbbr 伪码已注明实现方式。
