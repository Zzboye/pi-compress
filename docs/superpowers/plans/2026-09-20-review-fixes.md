# 审查发现修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审查确认的四项问题：recall 截断按 token 计量并支持 offset 分页；进行中溢出片段的降级终态改为 L3 且渲染为保留 ↩ID 的机械标记行；`query` 搜索与日志头的 T 编号严格同源；补上工程配置（vitest 排除 bench、CI、脚本清理）。

**Architecture:** 四项改动都在既有模块内做增量修复，不新增配置项、不新增机制。截断统一走 `util.countTokensText` 计量器（与窗口/降级阈值同源）；片段识别改为显式 `LedgerData.isFragment` 字段（不从 `userMessage` 缺失推断），降级上限由 `holdAt4`（只挡 L5）收紧为 `holdAt3`（挡 L4+L5）；T 编号从「各调用点各自构造 ledger 列表」改为「公共 `planAssembly` 产出唯一列表」。

**Tech Stack:** TypeScript 5.5（ESM，`.js` 后缀导入）、vitest 2、typebox（工具 schema）、pi 扩展 API（`@earendil-works/pi-coding-agent`）

**Spec:** `docs/superpowers/specs/2026-09-20-review-fixes-design.md`

## Global Constraints

- 无新配置项：所有修复复用既有配置（`recallMaxTokensPerEntry`、`keepRecentTokens`、`ledgerDegradeThresholdTokens`、`ledgerReserveTokens`）
- 零行为变化原则：每个任务都必须有一条「缺省/未触发时逐字节不变」的测试用例
- 截断与体积计量统一用 `countTokensText` / `countTokens`（CJK 感知，`CJK_RATIO = 1.0`）；**禁止**再出现「字符数 × 4 当 token」的口径
- 导入路径带 `.js` 后缀（ESM）；测试文件放 `tests/`，命名 `*.test.ts`
- 测试命令：`npx vitest run <file>`；全量 `npm test`；类型检查 `npm run typecheck`
- 提交信息中文，前缀沿用仓库惯例（`fix:` / `feat:` / `chore:` / `docs:`）
- 分支：`fix/review-findings-2026-09-20`（已建，基线 `bd3c69a`）；**不合并 main**
- 基线：`npm test` 应为 301 passed / 1 skipped，`npm run typecheck` 干净

---

### Task 1: `truncateToTokens` 纯函数（token 口径截断）

**Files:**
- Modify: `src/util.ts`（在 `countTokensText` 之后新增导出函数）
- Test: `tests/tokens.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `countTokensText(text: string): number`（`src/util.ts`，已存在）
- Produces: `truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean }` —— Task 2 依赖此签名

- [ ] **Step 1: 写失败测试**

追加到 `tests/tokens.test.ts` 末尾（文件已导入 `countTokensText`，需补 `truncateToTokens`）：

```ts
describe("truncateToTokens", () => {
  it("CJK 文本按 token 截断（不再按 chars/4 放行 4 倍预算）", () => {
    const text = "中文内容测试".repeat(2000); // 12000 CJK 字符 = 12000 tok
    const r = truncateToTokens(text, 4000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4000); // CJK 1 字符 = 1 tok
    expect(countTokensText(r.text)).toBeLessThanOrEqual(4000);
    expect(countTokensText(r.text)).toBeGreaterThan(3900); // 二分应贴近预算而非过分保守
  });

  it("ASCII 文本保持 ≈4 字符/token", () => {
    const text = "abcdefgh".repeat(2000); // 16000 ASCII 字符 ≈ 4000 tok
    const r = truncateToTokens(text, 4000);
    expect(countTokensText(r.text)).toBeLessThanOrEqual(4000);
    expect(r.text.length).toBeGreaterThan(15000);
  });

  it("预算充足时不截断且原样返回", () => {
    const text = "短文本";
    const r = truncateToTokens(text, 4000);
    expect(r).toEqual({ text, truncated: false });
  });

  it("空字符串", () => {
    expect(truncateToTokens("", 100)).toEqual({ text: "", truncated: false });
  });

  it("极小预算仍返回非空前缀（不返回空串导致调用方误判）", () => {
    const r = truncateToTokens("中".repeat(1000), 1);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(1);
  });

  it("混合文本：截断点按 CJK 感知口径", () => {
    const text = "中".repeat(100) + "a".repeat(1000); // 100 + 250 = 350 tok
    const r = truncateToTokens(text, 200);
    expect(countTokensText(r.text)).toBeLessThanOrEqual(200);
    expect(r.text.startsWith("中".repeat(100))).toBe(true); // 全中文前缀保留
  });
});
```

同时修改该文件第 2 行的 import：

```ts
import { countTokens, countTokensText, truncateToTokens, CJK_RATIO } from "../src/util.js";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/tokens.test.ts`
Expected: FAIL — `truncateToTokens is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

在 `src/util.ts` 的 `countTokensText` 函数之后插入：

```ts
/**
 * 按 token 预算截断文本（CJK 感知口径，与窗口/降级阈值同一计量器）。
 * 二分查找最长前缀使 countTokensText(前缀) ≤ maxTokens；不做逐字符扫描。
 * maxTokens ≤ 0 时返回空串；预算充足时原样返回（truncated=false）。
 * 调用方负责在 truncated 时追加自己的截断提示。
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (text.length === 0) return { text: "", truncated: false };
  if (maxTokens <= 0) return { text: "", truncated: true };
  if (countTokensText(text) <= maxTokens) return { text, truncated: false };
  let lo = 1;                      // 已知 1 字符前缀可行（单字符 ≤ 1 tok，maxTokens ≥ 1）
  let hi = text.length;            // 已知 hi 不可行
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokensText(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), truncated: true };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/tokens.test.ts`
Expected: PASS（原有用例 + 新增 6 例）

- [ ] **Step 5: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/util.ts tests/tokens.test.ts
git commit -m "feat(util): truncateToTokens 按 token 口径截断（CJK 感知）"
```

---

### Task 2: recall 截断改 token 口径 + `offset` 分页

**Files:**
- Modify: `src/recall.ts:1`（import）、`:33`（`executeRecall` 签名）、`:62`、`:90`（两处截断）、`:127`（`executeRecallDual` 签名与透传）
- Modify: `src/index.ts:306-310`（recall 工具 schema）、`:341-343`（execute 透传）
- Test: `tests/recall.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `truncateToTokens(text, maxTokens)`（Task 1）
- Produces:
  - `executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset?: number): RecallResult`（新增第 5 参，缺省 0）
  - `executeRecallDual(ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset?: number): RecallResult`
  - recall 工具新增可选参数 `offset: number`

- [ ] **Step 1: 写失败测试**

追加到 `tests/recall.test.ts` 末尾（文件已导入 `executeRecall`、`executeRecallDual`）：

```ts
describe("recall 截断口径与 offset 分页", () => {
  it("CJK 长文本按 token 预算截断（4000 预算下不再放行 16000 字符）", () => {
    const text = "中文内容".repeat(4000); // 16000 CJK 字符 = 16000 tok
    const b: MessageEntry[] = [{ id: "cjk", message: { role: "assistant", content: [{ type: "text", text }] } as any }];
    const r = executeRecall(["cjk"], b, 4000);
    expect(r.text).toContain("已截断");
    // 去掉标签行后的正文长度应贴近 4000（CJK 1 字符 ≈ 1 tok），远小于旧的 16000
    expect(r.text.length).toBeLessThan(5000);
    expect(r.text.length).toBeGreaterThan(3900);
  });

  it("末段（剩余内容在预算内）不再追加截断标记", () => {
    const text = "短一些的内容".repeat(10); // 60 CJK 字符 = 60 tok
    const b: MessageEntry[] = [{ id: "s", message: { role: "assistant", content: [{ type: "text", text }] } as any }];
    const r = executeRecall(["s"], b, 4000);
    expect(r.text).not.toContain("已截断");
  });

  it("offset 续取第二段：可越过首段取到后半部分", () => {
    const text = "A".repeat(5000) + "B".repeat(5000); // 10000 ASCII ≈ 2500 tok
    const b: MessageEntry[] = [{ id: "big", message: { role: "assistant", content: [{ type: "text", text }] } as any }];
    const first = executeRecall(["big"], b, 500); // 500 tok ≈ 2000 ASCII 字符
    expect(first.text).toContain("offset=");
    expect(first.text).not.toContain("B"); // 首段全在 A 区
    const m = /传 offset=(\d+) 继续/.exec(first.text);
    expect(m).not.toBeNull();
    const next = Number(m![1]);
    const second = executeRecall(["big"], b, 500, undefined, next);
    expect(second.text).toContain("A"); // 仍在 A 区（offset 生效、未从 0 重来）
    const tail = executeRecall(["big"], b, 500, undefined, 5000); // 直接跳到 B 区
    expect(tail.text).toContain("B");
    expect(tail.text).not.toContain("A");
  });

  it("offset 超出条目长度 → 提示行，不计 missing", () => {
    const b: MessageEntry[] = [{ id: "e1", message: { role: "user", content: [{ type: "text", text: "短" }] } as any }];
    const r = executeRecall(["e1"], b, 4000, undefined, 999999);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("offset");
  });

  it("多 ID + offset → 用法提示，不召回", () => {
    const b: MessageEntry[] = [
      { id: "a", message: { role: "user", content: [{ type: "text", text: "AAA" }] } as any },
      { id: "c", message: { role: "user", content: [{ type: "text", text: "CCC" }] } as any },
    ];
    const r = executeRecall(["a", "c"], b, 4000, undefined, 10);
    expect(r.text).toContain("单 ID");
    expect(r.text).not.toContain("AAA");
    expect(r.missing).toEqual([]);
  });

  it("offset 缺省（0）行为与旧实现一致", () => {
    const r = executeRecall(["e1"], branch, 4000);
    expect(r.text).toContain("问题原文");
    expect(r.text).not.toContain("offset");
  });

  it("L3 turn 级截断提示不再指向死路「相邻 ID」，改为 offset", () => {
    const big = "中文".repeat(20000); // 40000 CJK tok
    const entries: MessageEntry[] = [
      { id: "u1", message: { role: "user", content: [{ type: "text", text: "任务" }] } as any },
      { id: "a1", message: { role: "assistant", content: [{ type: "text", text: big }] } as any },
    ];
    const l3: LedgerData = { turnStartEntryId: "u1", turnEndEntryId: "a1", level: 3, summary: { entries: [] } };
    const ctx = { ledgers: [l3], turns: [{ startEntryId: "u1", endEntryId: "a1", entries }] };
    const r = executeRecall(["u1"], entries, 4000, ctx as any);
    expect(r.text).toContain("offset=");
    expect(r.text).not.toContain("相邻 ID");
  });

  it("executeRecallDual 透传 offset（第 6 参）", () => {
    const text = "A".repeat(5000) + "B".repeat(5000);
    const b: MessageEntry[] = [{ id: "big", message: { role: "assistant", content: [{ type: "text", text }] } as any }];
    const r = executeRecallDual(["big"], b, null, 500, undefined, 5000);
    expect(r.text).toContain("B");
    expect(r.text).not.toContain("A");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/recall.test.ts`
Expected: FAIL — 首例断言 `expect(r.text.length).toBeLessThan(5000)` 失败（旧实现放行 ~16000 字符）；`offset=` 相关用例失败

- [ ] **Step 3: 改 `src/recall.ts` 的 import 与两处截断**

第 1 行 import 改为：

```ts
import { stripThinking, serializeForRecall, truncateToTokens, type MessageEntry, type Turn } from "./util.js";
```

`executeRecall` 签名（原第 33 行）改为：

```ts
export function executeRecall(ids: string[], branch: MessageEntry[], maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset = 0): RecallResult {
```

在 `const rejected = 0;` 之后插入 offset 守卫：

```ts
  // offset 分页仅支持单 ID（多 ID 各有一段文本，offset 语义歧义）：多 ID 直接给用法提示
  if (offset > 0 && ids.length !== 1) {
    return { text: "offset 分页仅支持单 ID：请一次只传一个 ID（如 recall({ ids: [\"↩id\"], offset: 12345 })）。", missing: [], notesHits: 0, images: [], rejected: 0 };
  }
```

turn 级截断（原第 62-64 行）替换为：

```ts
      // turn 级：整段原文（恢复被丢的工具过程/两端原文，spec §7）。截断按 token 预算
      // （CJK 感知，见 truncateToTokens）；offset 续取下一段（无 offset 时从 0 起）。
      const full = serializeForRecall(turn.entries.map((te) => ({ id: te.id, message: te.message as any })));
      if (offset >= full.length) {
        parts.push(`【${id}】offset ${offset} 超出该条目长度（${full.length} 字符），无可续取内容。`);
        continue;
      }
      const seg = truncateToTokens(full.slice(offset), maxTokensPerEntry);
      let text = offset > 0 ? `（从 offset ${offset} 起）\n${seg.text}` : seg.text;
      if (seg.truncated) {
        const rest = full.length - offset - seg.text.length;
        text += `\n…（已截断，剩余 ${rest} 字符；传 offset=${offset + seg.text.length} 继续）`;
      }
```

entry 级截断（原第 90-93 行）替换为：

```ts
    // serializeForRecall：与 pi 同格式但 toolResult 不截断（pi 原版纯头截 2000 字符，
    // 尾部结论丢失，超长结果无法完整 recall）。预算截断按 token（truncateToTokens），
    // 超出部分可用 offset 续取。
    const full = serializeForRecall(msgs.map((m, i) => ({ id: i === 0 ? id : `${id}-r${i}`, message: m as any })));
    if (offset >= full.length) {
      parts.push(`【${id}】offset ${offset} 超出该条目长度（${full.length} 字符），无可续取内容。`);
      continue;
    }
    const seg = truncateToTokens(full.slice(offset), maxTokensPerEntry);
    let text = offset > 0 ? `（从 offset ${offset} 起）\n${seg.text}` : seg.text;
    if (seg.truncated) {
      const rest = full.length - offset - seg.text.length;
      text += `\n…（已截断，剩余 ${rest} 字符；传 offset=${offset + seg.text.length} 继续）`;
    }
```

注意：原 entry 级代码里 `let text = serializeForRecall(...)` 之后紧跟图片追加块（`text += "\n[含图片 …]"`），保留该块不动。

`executeRecallDual` 签名与透传（原第 127 行与第 146 行）：

```ts
export function executeRecallDual(ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number, degradeCtx?: RecallDegradeCtx, offset = 0): RecallResult {
```

```ts
    const r = executeRecall(entryIds, branch, maxTokensPerEntry, degradeCtx, offset);
```

- [ ] **Step 4: 改 `src/index.ts` 的工具 schema 与透传**

recall 工具的 `parameters`（原第 306-309 行）改为：

```ts
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "entry ID 列表，来自动作日志 ↩ 标记" })),
      query: Type.Optional(Type.String({ description: "关键词（大小写不敏感子串匹配），如文件名/函数名/命令词" })),
      offset: Type.Optional(Type.Number({ description: "续取起点（字符偏移），仅单 ID 时有效；截断提示会给出下一次的 offset 值" })),
    }),
```

`executeRecallDual` 调用（原第 341-344 行）改为：

```ts
        const r = executeRecallDual(params.ids, entries, notesStore, config?.recallMaxTokensPerEntry ?? 4_000, {
          ledgers: ledgersInBranchOrder(entries, false),
          turns: splitIntoTurns(entries),
        }, params.offset ?? 0);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/recall.test.ts tests/tokens.test.ts`
Expected: PASS

- [ ] **Step 6: 全量 + 类型检查 + 提交**

```bash
npm test          # 预期 301 + 新增用例，全绿
npm run typecheck # 若尚未加该脚本，用 npx tsc --noEmit
git add src/recall.ts src/index.ts tests/recall.test.ts
git commit -m "fix(recall): 截断按 token 口径 + offset 分页（取代死路提示）"
```

---

### Task 3: 片段显式标记 `isFragment` + 片段专用渲染

**Files:**
- Modify: `src/ledger.ts:30-40`（`LedgerData` 接口加字段）、`:84-115`（`renderTurnText` 的 L1–L3 分支）
- Modify: `src/summarizer.ts:80-86`（`onLedger` 载荷透传）
- Test: `tests/ledger.test.ts`（追加 describe 块）、`tests/summarizer.test.ts:127-152`（在既有片段用例上加一条断言）

**Interfaces:**
- Consumes: 既有 `LedgerData`、`renderTurnText(l, n)`、`Turn.isFragment`
- Produces: `LedgerData.isFragment?: true` —— Task 4 的测试 fixture 用到，Task 5 的回归用例用到

- [ ] **Step 1: 写失败测试（渲染）**

追加到 `tests/ledger.test.ts` 末尾：

```ts
describe("片段专用渲染（isFragment）", () => {
  const frag = (level: 1 | 2 | 3, entries: any[] = []): LedgerData => ({
    turnStartEntryId: "f1", turnEndEntryId: "f1-e", isFragment: true, level,
    summary: { entries },
  });

  it("L1：片段头部为「片段（进行中任务）」，动作行含 target", () => {
    const t = renderTurnText(frag(1, [
      { action: "bash", target: "npm test", detail: "12 failed", recallIds: ["a1"], phase: "verify" },
    ]), 3);
    expect(t).toContain("片段（进行中任务）");
    expect(t).not.toContain("用户意图");
    expect(t).toContain("npm test");
    expect(t).toContain("12 failed");
    expect(t).toContain("↩a1");
  });

  it("L2：丢 target 保 detail 与 ↩ID", () => {
    const t = renderTurnText(frag(2, [
      { action: "bash", target: "npm test", detail: "12 failed", recallIds: ["a1"], phase: "verify" },
    ]), 3);
    expect(t).toContain("片段（进行中任务）");
    expect(t).toContain("12 failed");
    expect(t).not.toContain("npm test");
    expect(t).toContain("↩a1");
  });

  it("L3：机械标记行（动作数 + ↩IDs），无动作行、无「用户意图」", () => {
    const t = renderTurnText(frag(3, [
      { action: "bash", target: "npm test", detail: "12 failed", recallIds: ["a1"], phase: "verify" },
      { action: "read", target: "src/x.ts", detail: "确认早退", recallIds: ["a2"], phase: "investigate" },
    ]), 3);
    expect(t).toContain("片段（2 个动作）");
    expect(t).toContain("↩a1");
    expect(t).toContain("↩a2");
    expect(t).not.toContain("12 failed");
    expect(t).not.toContain("用户意图");
    expect(t).not.toContain("（未知）");
  });

  it("L3：无动作 → 「片段（无动作记录）」，不输出 ↩", () => {
    const t = renderTurnText(frag(3, []), 3);
    expect(t).toContain("片段（无动作记录）");
    expect(t).not.toContain("↩");
  });

  it("L3：↩ID 超过 20 个 → 截前 20 + 计数提示", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      action: "bash", target: "c" + i, detail: "d", recallIds: ["r" + i], phase: "verify" as const,
    }));
    const t = renderTurnText(frag(3, entries), 3);
    expect(t).toContain("↩r0");
    expect(t).toContain("↩r19");
    expect(t).not.toContain("↩r20");
    expect(t).toContain("共 25 个 ↩ID");
  });

  it("整 turn（有 userMessage）渲染不受影响", () => {
    const t = renderTurnText({
      turnStartEntryId: "u1", turnEndEntryId: "a1", level: 1,
      userMessage: { text: "修排序", entryId: "u1" }, finalReply: { text: "已修", entryId: "a1" },
      summary: { entries: [] },
    }, 1);
    expect(t).toContain("用户：「修排序」");
    expect(t).not.toContain("片段");
  });

  it("userMessage 缺失但未标 isFragment（只含图片的用户消息）仍走整 turn 分支", () => {
    const t = renderTurnText({
      turnStartEntryId: "u1", turnEndEntryId: "a1", level: 1,
      summary: { userIntent: "看图", entries: [] },
    }, 1);
    expect(t).toContain("用户意图：看图");
    expect(t).not.toContain("片段");
  });
});
```

`tests/ledger.test.ts` 顶部需确认已导入 `renderTurnText` 与 `LedgerData`（现有文件已导入，若缺则补 `import { renderTurnText, type LedgerData } from "../src/ledger.js";`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL — 片段用例断言 `片段（进行中任务）` 失败（当前输出 `用户意图：（未知）`）

- [ ] **Step 3: 加字段与渲染分支**

`src/ledger.ts` 的 `LedgerData` 接口（在 `absorbed` 字段后）追加：

```ts
  /** 溢出片段（进行中 turn 切出）：渲染走片段专用分支；缺省 = 整 turn 条目（兼容旧数据）。
   *  不推断（userMessage 缺失 ≠ 片段：只含图片的用户消息也没有 userMessage）。 */
  isFragment?: true;
```

`renderTurnText` 的 L1–L3 分支（原 `// L1–L3 共通骨架` 到 `if (lvl <= 2) {...}` 结束）替换为：

```ts
  // L1–L3：整 turn 与片段两套骨架
  if (l.isFragment) {
    // 片段：无用户消息、无最终回复，内容就是工具过程（spec 2026-09-20 §4.2）
    if (lvl === 3) {
      // L3 删除「工具过程」整类信息 → 只留机械标记行，保留「这里有一段工作」与全部 ↩ID
      const ids = [...new Set(l.summary.entries.flatMap((e) => e.recallIds))];
      if (l.summary.entries.length === 0) {
        lines.push(`### T${n} · 片段（无动作记录）`);
      } else if (ids.length === 0) {
        lines.push(`### T${n} · 片段（${l.summary.entries.length} 个动作）`);
      } else {
        const head = ids.slice(0, 20).map((i) => `↩${i}`).join(",");
        const tail = ids.length > 20 ? ` …（共 ${ids.length} 个 ↩ID，可用 query 检索）` : "";
        lines.push(`### T${n} · 片段（${l.summary.entries.length} 个动作） ${head}${tail}`);
      }
      return lines.join("\n") + "\n";
    }
    lines.push(`### T${n} · 片段（进行中任务）`);
    const fragImages = renderImagesLine(l);
    if (fragImages) lines.push(fragImages);
    for (const e of l.summary.entries) {
      const recall = e.recallIds.length ? ` ↩${e.recallIds.join(",↩")}` : "";
      if (lvl === 1) {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.target} → ${e.detail}${recall}`);
      } else {
        lines.push(`- ${PHASE_LABEL[e.phase]}：${e.detail}${recall}`);
      }
    }
    return lines.join("\n") + "\n";
  }
  // 整 turn：用户行 + 图片占位行（L3 用户侧仍是原文）
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
```

- [ ] **Step 4: 摘要层透传字段**

`src/summarizer.ts` 的 `onLedger` 载荷（`processWithRetry` 内，原第 80-86 行）改为：

```ts
      this.onLedger({
        turnStartEntryId: turn.startEntryId,
        turnEndEntryId: turn.endEntryId,
        summary,
        userMessage,
        finalReply,
        ...(turn.isFragment ? { isFragment: true as const } : {}),
      });
```

- [ ] **Step 5: 追加摘要层断言**

`tests/summarizer.test.ts` 的 `describe("fragment turn (isFragment)")` 块内已有一个用例（约第 127-152 行）断言 `ledger.userMessage` / `ledger.finalReply` 为 undefined。**在该用例的现有断言之后追加一行**（不要新建用例，避免重复 fixture）：

```ts
      expect(ledger.isFragment).toBe(true); // 渲染层据此走片段专用分支（spec 2026-09-20 §4.1）
```

同时把该用例名从「片段 turn：finalReply 不提取（undefined），userMessage 保持 undefined」改为「片段 turn：finalReply 不提取（undefined）、userMessage 保持 undefined、isFragment 标记透传」。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/ledger.test.ts tests/summarizer.test.ts`
Expected: PASS（Step 2 时 ledger 用例失败、summarizer 用例因缺字段而失败；实现后全绿）

- [ ] **Step 7: 全量 + 提交**

```bash
npm test
npx tsc --noEmit
git add src/ledger.ts src/summarizer.ts tests/ledger.test.ts tests/summarizer.test.ts
git commit -m "fix(ledger): 片段显式 isFragment 标记 + 专用渲染（L3 保留 ↩ID 的机械标记行）"
```

---

### Task 4: 片段降级上限收紧为 L3（`holdAt4` → `holdAt3`）

**Files:**
- Modify: `src/degrade.ts:61-95`（`planDegrade` 签名与豁免判定）、`:107`（`DegradeEngine.run` 签名）
- Modify: `src/index.ts:139-144`（`runDegrade` 的 hold 集合构造与传参）
- Test: `tests/degrade.test.ts`（改 1 例、增 2 例）、`tests/extension.test.ts`（改 1 例断言）

**Interfaces:**
- Consumes: `LedgerData.isFragment`（Task 3，仅测试用）、既有 `planDegrade` / `DegradeEngine.run`
- Produces:
  - `planDegrade(ledgers, thresholdTokens, reserveTokens, holdAt3?: Set<string>): DegradePlan` —— 第 4 参语义：集合内条目不生成 `toLevel >= 4` 的 step
  - `DegradeEngine.run(ledgers: LedgerData[], holdAt3?: Set<string>): Promise<void>`

- [ ] **Step 1: 写失败测试**

`tests/degrade.test.ts` 中现有用例「L5 豁免：holdAt4 中的条目不生成 toLevel=5 step，保持 L4」（约第 23-34 行）替换为：

```ts
  it("片段上限 L3：holdAt3 中的条目不生成 toLevel>=4 的 step，普通条目照常降级", () => {
    const ls: LedgerData[] = [ledger("f1", 3, 21000), ledger("old", 3, 21000)];
    (ls[0] as any).isFragment = true;
    // reserve=0：两条都被选中（若不被豁免）；f1 被豁免停在 L3，old 降 L4
    const plan = planDegrade(ls, 40000, 0, new Set(["f1"]));
    expect(plan.steps.find((s) => s.turnStartEntryId === "f1" && s.toLevel >= 4)).toBeUndefined();
    expect(plan.steps.find((s) => s.turnStartEntryId === "old" && s.toLevel === 4)).toBeDefined();
    expect(plan.mergeGroups.flat()).not.toContain("f1"); // 片段不进合并组
  });
```

同文件「L5 豁免：holdAt4 中的片段保持 L4，普通旧条目正常合并为 L5」（约第 237-250 行）替换为：

```ts
  it("片段上限 L3：holdAt3 中的片段停在 L3，同层普通条目照常升 L4", async () => {
    const log: string[] = [];
    // 只有 old 走到 L3→L4 的 compressEnds，故一条响应足够
    const engine = new DegradeEngine(
      makeBackend(['{"userIntent":"i","outcome":"o"}'], log),
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 0 } as any,
      (d) => {}, () => {},
    );
    // 两条 L3（各 21000 tok，L3 层 42000 > 40000 触发降级）；f1 是片段被豁免
    const ls = [ledger("f1", 3, 21000), ledger("old", 3, 21000)];
    (ls[0] as any).isFragment = true;
    await engine.run(ls, new Set(["f1"]));
    expect(ls[0].level).toBe(3);           // 片段终态 L3（L4 对片段语义为空，spec 2026-09-20 §2 裁定 3）
    expect(ls[0].summary.userIntent).toBeUndefined(); // 未被 compressEnds 触碰
    expect(ls[1].level).toBe(4);           // 同层普通条目照常降级
    expect(log).toEqual(["call0"]);
  });
```

并在文件末尾追加一例（存量数据：片段已在 L4 层时不被合并进 L5 组）。**注意这是回归防护用例，实现前后都应通过**（旧 `holdAt4` 已保证 L4 片段不升 L5）；它的价值是防止 `holdAt3` 实现时把存量 L4 片段误降回 L3：

```ts
  it("L4 层的片段被 holdAt3 豁免，不与普通 L4 条目合并成组", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"description":"旧任务描述"}'], log),
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 0 } as any,
      (d) => {}, () => {},
    );
    const ls = [ledger("f1", 4, 21000), ledger("old", 4, 21000)];
    (ls[0] as any).isFragment = true;
    await engine.run(ls, new Set(["f1"]));
    expect(ls[0].level).toBe(4);           // 存量片段停在 L4（豁免 toLevel>=4，不继续降）
    expect(ls[0].merged).toBeUndefined();
    expect(ls[1].level).toBe(5);
    expect(ls[1].merged?.description).toBe("旧任务描述（1 条已合并）");
  });
```

`tests/extension.test.ts` 的「降级瀑布接入片段」用例（约第 180-258 行）：该 fixture 里两个片段由 `mkL4(...)` 构造，**起点已是 level 4**；`holdAt3` 生效后它们停在 4（不会降到 3）。把该用例的片段断言段（约第 246-254 行）替换为：

```ts
      // 片段：参与降级但被 holdAt3 豁免 → 不进 L4→L5 合并（fixture 起点已是 L4，故停在 4；
      // 真实片段从 L1 起步，上限 L3）
      expect(writes.some((d) => (d.turnStartEntryId === "a_n1" || d.turnStartEntryId === "a_n2") && d.level === 5)).toBe(false);
      for (const f of ["lg_f1", "lg_f2"]) {
        const frag = branch.find((e) => e.id === f).data;
        expect([3, 4]).toContain(frag.level);
        expect(frag.merged).toBeUndefined(); // 未被合并
      }
```

并把该用例名从「降级瀑布接入片段：片段保持 L4 形态（L5 豁免），普通旧 turn 合并为 L5 行」改为「降级瀑布接入片段：片段豁免 L4→L5（holdAt3），普通旧 turn 合并为 L5 行」。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/degrade.test.ts`
Expected: 第 1 例 FAIL（旧豁免只挡 `toLevel === 5`，`f1` 会拿到 `toLevel: 4` 的 step）；第 2 例 FAIL（`f1` 被 compressEnds 触碰 → `summary.userIntent` 被写入、`log` 长度 2 而非 1）；第 3 例 PASS（回归防护，见上）。

已用探针核对过 fixture 数学：`ledger(id, 3, 21000)` 的 L3 渲染为 21013 tok，两条合计 42026 > 40000 触发降级；L4 渲染仅 ~30 tok，故 L4 层不会超线（这正是片段降级路径不可达的原因）

- [ ] **Step 3: 改 `src/degrade.ts`**

`planDegrade` 的 JSDoc 与签名（原第 45-67 行）替换为：

```ts
/**
 * 逐层瀑布：L1→L2→L3→L4→L5。L1 降级产生的新 L2 条目立即计入 L2 的 total
 * （下层计量基于降级后快照）。holdAt3 中的条目豁免 L4 与 L5（进行中 turn 的溢出片段：
 * L3 起片段已无实体内容——L4 的意图/outcome 对片段语义为空，L5 的合并收益为零而拒绝
 * 召回是实害；spec 2026-09-20 §2 裁定 3）→ 不生成 toLevel>=4 的 step、不入合并组，
 * 终态 L3。被豁免的片段仍参与各层 total 与 reserve 计量（保守方向：只少选不超降）。
 * 不修改入参（在副本上推演），每轮 agent_settled 只做一遍瀑布，超量部分下一轮自然收敛。
 */
export function planDegrade(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
  holdAt3?: Set<string>,
): DegradePlan {
```

瀑布循环内的豁免判定改为：

```ts
        if (to >= 4 && holdAt3?.has(w.l.turnStartEntryId)) continue; // 片段上限 L3（spec 2026-09-20 §2 裁定 3）
```

`DegradeEngine.run` 签名（原第 107 行）与内部调用：

```ts
  async run(ledgers: LedgerData[], holdAt3?: Set<string>): Promise<void> {
    const plan = planDegrade(ledgers, this.config.ledgerDegradeThresholdTokens, this.config.ledgerReserveTokens, holdAt3);
```

- [ ] **Step 4: 改 `src/index.ts` 的 `runDegrade`**

原第 130-148 行替换为：

```ts
  /** 降级流水：按 branch 真实顺序取窗外全量 ledgers，交 DegradeEngine（内部逐层瀑布，持久化走 onLedger）。
   *  溢出片段（key ∈ 末 turn 中间条目，ledgersInBranchOrder 查不到）push 到末尾（= branch 顺序）参与降级，
   *  并作为 holdAt3 豁免 L4/L5（spec 2026-09-20 §2 裁定 3：L4 的意图/outcome 对片段语义为空，
   *  L5 合并收益为零而拒绝召回是实害；片段终态 L3）。 */
  const runDegrade = async (entries: MessageEntry[]): Promise<void> => {
    if (!degradeEngine) return;
    const ledgers = ledgersInBranchOrder(entries, true);
    const turns = splitIntoTurns(entries);
    const last = turns[turns.length - 1];
    const holdAt3 = new Set<string>();
    if (last) {
      for (const { key, ledger } of collectFragmentEntries(last, store)) {
        ledgers.push(ledger);
        holdAt3.add(key);
      }
    }
    if (ledgers.length === 0) return; // 早退在片段收集之后：无 ledgers 也无片段才白跑
    await degradeEngine.run(ledgers, holdAt3);
  };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/degrade.test.ts tests/extension.test.ts`
Expected: PASS

- [ ] **Step 6: 全量 + 提交**

```bash
npm test
npx tsc --noEmit
git add src/degrade.ts src/index.ts tests/degrade.test.ts tests/extension.test.ts
git commit -m "fix(degrade): 片段降级上限收紧为 L3（holdAt4 → holdAt3）"
```

---

### Task 5: T 标签同源（`planAssembly` + `visibleLedgers`）

**Files:**
- Modify: `src/assembler.ts:104-145`（抽出 `planAssembly`，`assembleContext` 复用）
- Modify: `src/index.ts:317-331`（query 分支改用 `visibleLedgers`）
- Test: `tests/assembler.test.ts`（追加 `planAssembly` 用例）、`tests/extension.test.ts`（追加同源用例）

**Interfaces:**
- Consumes: `splitIntoTurns`、`findWindowTurns`、`stripThinking`、`renderActionLedger`（均既有）
- Produces:
  - `interface AssemblyPlan { turns: Turn[]; window: Turn[]; windowStartIds: Set<string>; ledgers: LedgerData[]; passthroughIds: Set<string>; stats: AssembleStats }`
  - `planAssembly(branch: MessageEntry[], cache: Map<string, LedgerData>, keepRecentTokens: number, extraLedgers?: LedgerData[]): AssemblyPlan`
  - `assembleContext(branch, cache, keepRecentTokens, extraLedgers?)` 签名不变（内部复用 `planAssembly`）

- [ ] **Step 1: 写失败测试（`planAssembly`）**

追加到 `tests/assembler.test.ts` 末尾（文件已导入 `findWindowTurns`、`assembleContext`、`planInflightTrim`，需补 `planAssembly`）：

```ts
describe("planAssembly（T 编号的唯一来源）", () => {
  const msg = (id: string, text: string): MessageEntry => ({ id, message: { role: "user", content: [{ type: "text", text }] } as any });
  const led = (k: string): LedgerData => ({ turnStartEntryId: k, turnEndEntryId: k + "-e", summary: { entries: [] } });

  it("ledgers = 窗外有 ledger 的 turn + extraLedgers 追加在末尾（顺序即 T 编号）", () => {
    // 三个 turn 各 100 tok（400 ASCII 字符）；预算 100 → 窗口只剩 t3；t1 有 ledger、t2 无（passthrough）
    const branch = [msg("t1", "a".repeat(400)), msg("t2", "b".repeat(400)), msg("t3", "c".repeat(400))];
    const cache = new Map<string, LedgerData>([["t1", led("t1")], ["t3", led("t3")]]);
    const plan = planAssembly(branch, cache, 100, [led("frag")]);
    expect(plan.window.map((t) => t.startEntryId)).toEqual(["t3"]);
    expect(plan.ledgers.map((l) => l.turnStartEntryId)).toEqual(["t1", "frag"]); // t3 在窗口内、t2 无 ledger
    expect(plan.passthroughIds).toEqual(new Set(["t2"]));
    expect(plan.stats).toEqual({ windowTurns: 1, replacedTurns: 1, passthroughTurns: 1 });
  });

  it("窗口内 turn 不进 ledgers（原文在场，不参与 T 编号）", () => {
    const branch = [msg("t1", "a".repeat(400)), msg("t2", "b".repeat(400)), msg("t3", "c".repeat(400))];
    const cache = new Map<string, LedgerData>([["t1", led("t1")], ["t2", led("t2")], ["t3", led("t3")]]);
    const plan = planAssembly(branch, cache, 110); // 窗口只留 t3
    expect(plan.window.map((t) => t.startEntryId)).toEqual(["t3"]);
    expect(plan.ledgers.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2"]);
  });

  it("无 ledger、无 extraLedgers 时 ledgers 为空（日志头不渲染）", () => {
    const branch = [msg("t1", "a".repeat(400))];
    const plan = planAssembly(branch, new Map(), 1_000_000);
    expect(plan.ledgers).toEqual([]);
  });

  it("stats 与 assembleContext 一致（复用同一计算）", () => {
    const branch = [msg("t1", "a"), msg("t2", "b")];
    const cache = new Map<string, LedgerData>([["t1", led("t1")]]);
    const plan = planAssembly(branch, cache, 1_000_000);
    const { stats } = assembleContext(branch, cache, 1_000_000);
    expect(plan.stats).toEqual(stats);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/assembler.test.ts`
Expected: FAIL — `planAssembly is not a function`

- [ ] **Step 3: 实现 `planAssembly` 并让 `assembleContext` 复用**

`src/assembler.ts` 的 `assembleContext`（原第 104-145 行）整体替换为：

```ts
export interface AssemblyPlan {
  turns: Turn[];
  window: Turn[];
  windowStartIds: Set<string>;
  /** 日志头顺序 = 窗外有 ledger 的 turn（branch 序）+ extraLedgers（片段，追加末尾）。
   *  T 编号的唯一来源：数组下标 + 1。日志头渲染与 query 搜索必须共用本列表（spec 2026-09-20 §5）。 */
  ledgers: LedgerData[];
  /** 窗外无 ledger 的 turn 条目 id（原文照发） */
  passthroughIds: Set<string>;
  stats: AssembleStats;
}

/** 装配计划（纯计算）：窗口划分、日志头 ledger 列表、原文照发集合、统计。
 *  assembleContext 与 recall query 共用本函数，保证 T 编号严格同源。 */
export function planAssembly(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
  extraLedgers: LedgerData[] = [],
): AssemblyPlan {
  const turns = splitIntoTurns(branch);
  const window = findWindowTurns(turns, keepRecentTokens);
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  const stats: AssembleStats = { windowTurns: window.length, replacedTurns: 0, passthroughTurns: 0 };
  const ledgers: LedgerData[] = [];

  for (const turn of turns) {
    if (windowStartIds.has(turn.startEntryId)) continue; // 窗口内，原文追加
    const cached = cache.get(turn.startEntryId);
    if (cached) {
      ledgers.push(cached);
      stats.replacedTurns++;
    } else {
      stats.passthroughTurns++;
    }
  }
  ledgers.push(...extraLedgers);

  const passthroughIds = new Set(
    turns
      .filter((t) => !windowStartIds.has(t.startEntryId) && !cache.has(t.startEntryId))
      .flatMap((t) => t.entries.map((e) => e.id)),
  );
  return { turns, window, windowStartIds, ledgers, passthroughIds, stats };
}

/** 装配上下文：窗口外有摘要的 turn 用 ledger 头代表，无摘要的 turn 原文照发，窗口内 turn 原文追加。
 *  extraLedgers（进行中 turn 的片段 ledger）追加在日志头 ledgers 数组末尾——片段属于最后
 *  turn，branch 顺序天然在最后；缺省 [] 时行为与旧签名逐字节一致。 */
export function assembleContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  keepRecentTokens: number,
  extraLedgers: LedgerData[] = [],
): { messages: AgentMessage[]; stats: AssembleStats } {
  const plan = planAssembly(branch, cache, keepRecentTokens, extraLedgers);
  const messages: AgentMessage[] = [];
  if (plan.ledgers.length > 0) messages.push(renderActionLedger(plan.ledgers));
  const strippedBranch = stripThinking(branch); // passthrough 与窗口统一剥离 thinking（见 stripThinking）
  for (const e of strippedBranch) {
    if (plan.passthroughIds.has(e.id)) messages.push(e.message);
  }
  for (const t of plan.window) for (const e of stripThinking(t.entries)) messages.push(e.message);
  return { messages, stats: plan.stats };
}
```

注意：`plan.ledgers.length > 0` 与旧条件 `ledgers.length > 0 || extraLedgers.length > 0` 等价（`ledgers` 已含 `extraLedgers`），因此缺省路径行为不变。

- [ ] **Step 4: 改 `src/index.ts` 的 query 分支**

原第 317-331 行（query 分支内）替换为：

```ts
      if (q) {
        // query 模式：关键词检索，返回命中索引（不消耗 calls，calls 只计逐字取回）。
        // 检索范围 = 日志头实际渲染的 ledger 列表（planAssembly 产出，与 renderActionLedger 同一数组）
        // → T 编号与日志头严格同源。窗口内 turn 的内容原文在场，模型无需检索其陈旧 ledger 副本。
        const cache = new Map<string, LedgerData>();
        for (const k of store.keys()) { const v = store.get(k); if (v && !v.absorbed) cache.set(k, v); }
        const plan = planInflightTrim(entries, cache, config.keepRecentTokens);
        const ledgers = planAssembly(plan.trimmedBranch, cache, config.keepRecentTokens, plan.extraLedgers).ledgers;
        const r = searchLedger(q, ledgers, 15);
        recallStats.searches += 1;
        recallStats.searchHits += r.hits.length;
        parts.push(formatSearchResult(r));
      }
```

`src/index.ts` 的 import（第 12 行）补上 `planAssembly`：

```ts
import { assembleContext, findWindowTurns, planAssembly, planInflightTrim, type AssembleStats } from "./assembler.js";
```

- [ ] **Step 5: 写同源回归测试**

追加到 `tests/extension.test.ts` 的 `describe("extension entry wiring")` 内：

```ts
  it("T 标签同源：query 命中行的 T 编号与日志头一致（含片段与窗口内 ledger）", async () => {
    const { tools, handlers } = harness();
    const CJK = (n: number) => "内".repeat(n);
    const branch: any[] = [];
    // 4 个已完成 turn，各自有 ledger（turnStartEntryId = user 消息 id）
    for (let i = 1; i <= 4; i++) {
      branch.push({ id: `t${i}`, type: "message", message: { role: "user", content: [{ type: "text", text: `需求${i}` }] } });
      branch.push({ id: `t${i}r`, type: "message", message: { role: "assistant", content: [{ type: "text", text: CJK(200) }] } });
      branch.push({ id: `lg${i}`, type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({
        turnStartEntryId: `t${i}`, turnEndEntryId: `t${i}r`, level: 1,
        userMessage: { text: `需求${i}`, entryId: `t${i}` },
        summary: { entries: [{ action: "exec", target: `cmd${i}`, detail: `第${i}步`, recallIds: [`t${i}r`], phase: "verify" }] },
      }) });
    }
    // 进行中 turn（t5）带一个已落盘片段
    branch.push({ id: "t5", type: "message", message: { role: "user", content: [{ type: "text", text: "继续" }] } });
    branch.push({ id: "a5", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { command: "cmdFrag" } }] } });
    branch.push({ id: "r5", type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "片段结果" }] } });
    branch.push({ id: "lgF", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({
      turnStartEntryId: "a5", turnEndEntryId: "r5", level: 1, isFragment: true,
      summary: { entries: [{ action: "exec", target: "cmdFrag", detail: "片段结果", recallIds: ["r5"], phase: "verify" }] },
    }) });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-label-"));
    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({
        contextCompress: {
          keepRecentTokens: 100,
          summarizer: { kind: "registry", provider: "Fake", model: "m" },
          backfillLimit: 0, // 关掉补摘：本用例只验证标签，不需要后台摘要（避免触发真实 backend 调用）
        },
      }));
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: () => {}, setStatus: () => {} },
        sessionManager: { getBranch: () => branch, appendCustomEntry: () => {} },
        modelRegistry: {
          find: () => ({ provider: "Fake", model: "m" }),
          complete: async () => ({ content: [{ type: "text", text: '{"entries":[]}' }] }),
        },
        getContextUsage: () => ({ tokens: 1, contextWindow: 100000 }),
      };
      await handlers.session_start({}, fakeCtx);
      // 日志头：走 context 事件同一构造
      const out = await handlers.context({}, fakeCtx);
      const header = (out.messages as any[]).find((m) => JSON.stringify(m.content).includes("<action-ledger>"));
      const headerText = ((header.content as any[]).map((c) => c.text ?? "").join("")) as string;
      const headerLabels = [...headerText.matchAll(/^### T(\d+)/gm)].map((m) => m[1]);
      // query 命中行
      const res = await tools.recall.execute("tc", { query: "片段结果" }, undefined, undefined, fakeCtx);
      const hitLabel = /T(\d+)/.exec(res.content[0].text)![1];
      expect(headerLabels).toContain(hitLabel); // 命中的 T 编号必须出现在日志头中
      // 片段在日志头是最后一节（extraLedgers 追加在末尾）——回归「片段追加位置」这个错位根因
      expect(headerLabels[headerLabels.length - 1]).toBe(hitLabel);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/assembler.test.ts tests/extension.test.ts`
Expected: PASS

- [ ] **Step 7: 全量 + 提交**

```bash
npm test
npx tsc --noEmit
git add src/assembler.ts src/index.ts tests/assembler.test.ts tests/extension.test.ts
git commit -m "fix(assembler): planAssembly 抽出，query 与日志头 T 编号同源"
```

---

### Task 6: 工程配置（vitest 排除 bench / CI / 脚本清理）

**Files:**
- Create: `vitest.config.ts`（单元/集成：只收 `tests/`）
- Create: `vitest.bench.config.ts`（基准：只收 `bench/`）
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`（scripts）
- Modify: `.gitignore`（追加 `e2e/reports/`）
- Delete: `scripts/_turnsize.mjs`、`scripts/_asmstats.mjs`、`scripts-dump-context.mjs`、`e2e/rpc-driver2.mjs`
- Test: `tests/tooling.test.ts`（新增）

> 说明：用**两个配置文件**而不是给 bench 传 CLI 参数——vitest 的 `--dir` 会让 `include` 相对新目录解析，`--include` 不存在；用环境变量前缀则不可跨平台（本机为 Windows）。两份配置各自显式 `include`，`npm run test:bench` 指定 `--config`。

**Interfaces:**
- Consumes: 无
- Produces: `npm test`（仅 tests/）、`npm run test:bench`、`npm run typecheck`

- [ ] **Step 1: 核对待删文件确实重复**

```bash
cd D:/Pi/pi-compress
diff scripts/_turnsize.mts scripts/_turnsize.mjs | head -20
diff scripts/_asmstats.mts scripts/_asmstats.mjs | head -20
head -5 e2e/rpc-driver.mjs; echo ---; head -5 e2e/rpc-driver2.mjs
```

Expected: `.mjs` 是 `.mts` 的编译产物（或等价旧版）；`rpc-driver2.mjs` 是 `rpc-driver.mjs` 的后继。**若 `rpc-driver2.mjs` 含 `rpc-driver.mjs` 没有的能力**，改为保留两者并把差异写进提交信息，不要删除。

- [ ] **Step 2: 写失败测试**

创建 `tests/tooling.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("工程配置", () => {
  it("vitest.config.ts 只收 tests/ 下的用例（bench 不混入 npm test）", () => {
    const cfg = fs.readFileSync(join(root, "vitest.config.ts"), "utf8");
    expect(cfg).toContain("tests/**/*.test.ts");
  });

  it("vitest.bench.config.ts 只收 bench/ 下的用例", () => {
    const cfg = fs.readFileSync(join(root, "vitest.bench.config.ts"), "utf8");
    expect(cfg).toContain("bench/**/*.test.ts");
  });

  it("package.json 提供 test / test:bench / typecheck", () => {
    const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:bench"]).toContain("bench");
    expect(pkg.scripts.typecheck).toContain("tsc");
  });

  it("CI workflow 存在且含 typecheck 与 test 步骤", () => {
    const wf = fs.readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(wf).toContain("npm ci");
    expect(wf).toContain("npm run typecheck");
    expect(wf).toContain("npm test");
  });

  it("重复/一次性脚本已清理", () => {
    for (const p of ["scripts/_turnsize.mjs", "scripts/_asmstats.mjs", "scripts-dump-context.mjs", "e2e/rpc-driver2.mjs"]) {
      expect(fs.existsSync(join(root, p)), `${p} 应已删除`).toBe(false);
    }
  });

  it("e2e/reports 已 gitignore（bench 输出不脏工作区）", () => {
    expect(fs.readFileSync(join(root, ".gitignore"), "utf8")).toContain("e2e/reports/");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/tooling.test.ts`
Expected: FAIL — `vitest.config.ts` 不存在（ENOENT）

- [ ] **Step 4: 创建配置与脚本**

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只跑单元/集成用例；bench/*.test.ts 是基准脚本（会写 e2e/reports），用 npm run test:bench 单独跑
    include: ["tests/**/*.test.ts"],
  },
});
```

`vitest.bench.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bench/**/*.test.ts"],
    testTimeout: 600_000, // 基准含真实模型/长会话路径
  },
});
```

`package.json` 的 `scripts` 替换为：

```json
  "scripts": {
    "test": "vitest run",
    "test:bench": "vitest run --config vitest.bench.config.ts",
    "typecheck": "tsc --noEmit"
  },
```

`.gitignore` 末尾追加一行：

```
e2e/reports/
```

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 5: 清理脚本**

```bash
git rm scripts/_turnsize.mjs scripts/_asmstats.mjs scripts-dump-context.mjs e2e/rpc-driver2.mjs
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/tooling.test.ts && npm test && npm run typecheck`
Expected: 全绿。`npm test` 的文件数从 23 降到 **19**（`tests/` 原有 18 个 + 新增 `tooling.test.ts`；`bench/` 的 5 个文件不再计入）。用 `npm test 2>&1 | grep "Test Files"` 确认输出中不含 `bench/`

- [ ] **Step 7: 提交**

```bash
git add vitest.config.ts vitest.bench.config.ts .github/workflows/ci.yml package.json .gitignore tests/tooling.test.ts
git commit -m "chore: vitest 排除 bench + CI + 脚本清理"
```

---

### Task 7: 文档同步（README + 旧 spec 勘误）

**Files:**
- Modify: `README.md:113-116`（配置表）、`:189-207`（recall 用法与召回路由）、`:128-137`（五级分层 L3/L5 说明）、`:306`（已知限制 · 进行中超大 turn）
- Modify: `docs/superpowers/specs/2026-09-17-inflight-turn-degrade-design.md`（裁定 3、裁定 7、§5 勘误注记）

**Interfaces:**
- Consumes: Task 1-6 的实现语义
- Produces: 无代码接口

- [ ] **Step 1: 改 README 配置表（`recallMaxTokensPerEntry` 行）**

原第 116 行替换为：

```
| `recallMaxTokensPerEntry` | `4000` | 500–1000000 | recall 单条召回预算（tokens，CJK 感知口径：中文约 1 tok/字）：单个 ID 序列化后的文本超过此值则按 token 截断并提示；提示给出下一次的 `offset` 值用于续取。不设总量限制（多 ID 各享独立预算）。recall 用专用全量序列化器，toolResult 不经 pi 的 2000 字符截断 |
```

- [ ] **Step 2: 改 README 的 recall 用法段**

原第 189-207 行中：

1. 用法示例块追加 offset 一行：

```
recall({ ids: ["↩id"], offset: 12345 })     → 单 ID 续取：从字符偏移 12345 继续（截断提示会给出该值）
```

2. 「召回按层级路由」bullet 的结尾「整段召回同样受 `recallMaxTokensPerEntry` 预算约束。」替换为：

```
整段召回同样受 `recallMaxTokensPerEntry` 预算约束；超预算时截断提示给出 `offset`，可续取剩余部分（`offset` 仅单 ID 时有效）。
```

3. 「`query` 与 `ids` 可同传」段末尾追加一句：

```
检索范围 = 日志头实际渲染的 ledger（窗外已替换 turn + 进行中片段），因此命中行的 `T` 编号与日志头严格一致；窗口内 turn 的内容原文在场，模型无需检索其陈旧 ledger 副本。
```

- [ ] **Step 3: 改 README 的五级分层与已知限制**

「**L3** 丢全部动作行（工具过程），用户原文与最终回复原文保留——纯机械降级，零 LLM 调用」之后追加：

```
  - 进行中 turn 的溢出片段在 L3 渲染为机械标记行 `### T{n} · 片段（{k} 个动作） ↩id1,↩id2,…`（保留召回入口，动作行移除）；片段降级上限即 L3（L4 的意图/outcome 对片段语义为空）
```

「已知限制 · 进行中超大 turn」条目里的「片段豁免 L5 合并、最多降到 L4」替换为「片段降级上限 L3（L3 起渲染为机械标记行，动作 ↩ID 保留）」。

- [ ] **Step 4: 旧 spec 勘误注记**

在 `docs/superpowers/specs/2026-09-17-inflight-turn-degrade-design.md` 的 §3 裁定表之后插入：

```markdown
> **勘误（2026-09-20）**：本表裁定 3 与裁定 7 已被 `2026-09-20-review-fixes-design.md` §4 取代。
> 探针实测表明片段被推到 L4/L5 的路径几乎不可达（片段恒为 branch 最新条目，reserve 硬下界先切断），
> 而实际发生的 L3 渲染会丢掉全部动作行与 ↩ID，产生零信息行。现行语义：**片段降级上限 L3**，
> L3 渲染为机械标记行（动作数 + ↩ID）；`holdAt4` 已更名为 `holdAt3`（挡 toLevel ≥ 4）。
```

§5 的「片段降级到 L5 边界」行替换为：

```markdown
| 片段降级到 L4/L5 边界 | **已由勘误取代**：片段上限 L3（引擎 `holdAt3` 挡 toLevel ≥ 4）；L3 渲染机械标记行，↩ID 保留 |
```

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm test && npm run typecheck
git add README.md docs/superpowers/specs/2026-09-17-inflight-turn-degrade-design.md
git commit -m "docs: 同步 recall 分页/片段 L3 终态/T 编号同源说明与旧 spec 勘误"
```

---

## 交付检查（全部任务完成后执行）

- [ ] `npm test` 全绿，`npm run typecheck` 干净
- [ ] `npx vitest run 2>&1 | grep "Test Files"` 不含 `bench/`
- [ ] `git status --short` 干净（`.pi-compress/` 除外）
- [ ] 抽查一个真实会话：`/compress-dump` 的 turns 表与 messages 的 T 编号一致（人工核对）
- [ ] 汇总最终交付说明：改动清单 + 每项验证证据 + 未做的事（不合并 main，等用户裁定）
