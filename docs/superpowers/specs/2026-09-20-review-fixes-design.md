# Spec：审查发现修复（recall 截断口径 / 片段降级终态 / T 标签同源 / 工程配置）

日期：2026-09-20
分支：fix/review-findings-2026-09-20
状态：定稿待实施

## 1. 背景与动机

全项目审查（探针实证，见项目记忆 task-007）确认四项问题，其中三项是代码级缺陷，一项是工程卫生。本文档给出四项的修复裁定与设计。

| 编号 | 问题 | 性质 |
|---|---|---|
| A | recall 截断按「字符 × 4」而非 token 计量，CJK 场景实际放行 4 倍预算 | 行为缺陷 |
| B | 进行中溢出片段降到 L3 后渲染成零信息行（动作行与 ↩ID 全丢）；裁定 7 的 L5 豁免与片段 L4 渲染针对几乎不可达路径 | 行为缺陷 + 设计前提有误 |
| C | `query` 搜索的 T 编号与日志头 T 编号错位（两者 ledger 列表成员不同） | 行为缺陷 |
| D | bench 混入 `vitest run`、一次性脚本入库、无 CI | 工程卫生 |

### 1.1 A 的证据

`src/recall.ts:62` / `:90`：

```ts
if (text.length > maxTokensPerEntry * 4)          // 注释称「约 4 字符/token」
  text = text.slice(0, maxTokensPerEntry * 4) + "…（已截断…）";
```

但本项目自己的计量器是 CJK 感知的（`src/util.ts:57`，CJK 系数 1.0）。探针实测：

| 内容 | 配置预算 | 实际放行 |
|---|---|---|
| 16000 CJK 字符 | 4000 tok | **16000 tok（4 倍）** |
| 16000 ASCII 字符 | 4000 tok | 4000 tok（恰好） |

README:116 写「recall 单条召回预算（tokens）」，`README:309` 承诺「单条 4000 token 内逐字全量」——对中文场景是 4 倍失真。

### 1.2 B 的证据

探针（片段 = 20286 tok L1 渲染，阈值 40000 / reserve 10000）：

```
1 个片段 → 不降级      2 个片段 → f0 降 L2      3 个片段 → f0 降 L3, f1 降 L2
```

即每约 2 个满尺寸片段吃掉一级，长任务（持续切出多个片段）必然把最旧片段推到 L3。而 L3 渲染（`src/ledger.ts:99-110`）对没有 `userMessage` 的片段走 else 分支，输出：

```
### T1 · 用户意图：（未知） ↩f0
```

动作行（`target → detail`）与全部动作 recallIds 消失，日志头里该片段变成零信息行；recall 退回 entry 级（单条 toolResult 原文）。spec「quotes 落盘 → 细节可取回」在头部层面不成立。

连带事实：裁定 7（L5 豁免）与 `src/ledger.ts:94-96` 的片段 L4 渲染分支针对几乎不可达路径——探针实测旧 L3 条目 50/300/800 条时片段 0 次被选入 `toLevel=4`；12 个真实尺寸片段全部止步 L3。原因是片段恒为 branch 最新条目，reserve 硬下界先切断。spec §3 裁定 3/7 的论证（「L4 每片段仅 ~2 行 ~50 tok」）用的是整 turn 语义，对片段不成立。

### 1.3 C 的证据

| | 编号来源 | 成员构成 |
|---|---|---|
| 日志头 | `renderActionLedger`（`ledger.ts:160`，下标+1） | 只含「已替换」turn（窗外有 ledger）+ `extraLedgers` 追加在**末尾** |
| `query` 搜索 | `searchLedger`（`recall.ts:228`，下标+1） | `ledgersInBranchOrder(entries, false)` 全量（**含窗口内 turn 的 ledger**）+ 片段追加在其**之后** |

探针实测：同一片段在日志头标 **T8**，`query` 命中标 **T10**。`src/index.ts:322-325` 注释与 README:203 均声称「同口径」。

## 2. 裁定记录

| # | 裁定点 | 决定 |
|---|---|---|
| 1 | A 截断计量 | 改为按 token 计量（`countTokensText` 口径），与窗口/降级阈值同一计量器 |
| 2 | A 分页 | 一并实现 task-002 的 `offset` 参数（截断标记改为「传 offset=X 继续」，不再指向死路「相邻 ID」） |
| 3 | B 片段终态 | 片段降级**上限 L3**（不再到 L4/L5）——取代原裁定 7 的「上限 L4」 |
| 4 | B 片段渲染 | 片段（无 `userMessage`）在各级用片段专用行，不再借「用户意图」骨架；L3 起渲染机械标记行（动作数 + ↩IDs） |
| 5 | C 标签同源 | 抽出公共装配计划函数，日志头与 `query` 搜索用**同一个 ledger 列表**构造 T 标签 |
| 6 | D 工程配置 | 加 `vitest.config.ts`（排除 bench）、`typecheck`/`test:bench` 脚本、最小 CI；清理重复/一次性脚本 |
| 7 | 阈值与配置 | 无新配置项；`recallMaxTokensPerEntry` 语义不变（仍是单条预算） |

裁定 3 的理由（取代原裁定 7）：片段的全部内容就是工具过程。L3 删除「工具过程」这一整类信息后，片段不再有任何实体内容，所以 L4（意图 + outcome，两端摘要）对片段**语义为空**——原设计下若真走到 L4，`compressEnds` 会拿到空的 user/reply 文本，让模型凭空编造「用户意图」。因此片段的正确终态是 L3：动作行从头部移除（体积归零），但用一行机械标记保留「这里有一段工作」与全部 ↩ID（召回入口）。

## 3. A：recall 截断按 token + offset 分页

### 3.1 截断计量

`src/util.ts` 新增：

```ts
/** 返回 text 的前缀，使其 countTokensText 估算 ≤ maxTokens；二分查找，不做逐字符扫描 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean }
```

- 用 `countTokensText`（与窗口/降级阈值同一计量器）
- 二分上界为 `text.length`；`maxTokens` 已由 config 钳制在 ≥500
- 空文本 / 预算充足 → 原样返回，`truncated=false`

`src/recall.ts` 两处截断（turn 级 `:62`、entry 级 `:90`）改用该函数。

### 3.2 offset 分页

工具 schema 增加：

```ts
offset: Type.Optional(Type.Number({ description: "续取起点（字符偏移），仅单 ID 时有效；截断提示会给出下一次的 offset" }))
```

`executeRecall(ids, branch, maxTokensPerEntry, degradeCtx?, offset = 0)`：

- **仅单 ID 生效**（与 T79 裁定 A 一致）：`offset > 0 && ids.length !== 1` → 返回一行用法提示，不做召回
- 序列化全文后 `slice(offset, offset + n)`，其中 `n` 由 `truncateToTokens(text.slice(offset), maxTokensPerEntry)` 求得
- 尾部标记：
  - 还有剩余 → `…（已截断，剩余 {rest} 字符；传 offset={offset + n} 继续）`
  - 无剩余 → 不加标记（全文已在结果中）
- `offset ≥ text.length` → 返回「（offset 超出该条目长度）」提示行，不计 missing/rejected

`executeRecallDual` 透传 `offset`；`src/index.ts` 的 recall 工具把 `params.offset` 传入。

**移除**现有两处「如需其余部分请用相邻 ID 分段 recall」提示：对 turn 级召回，「相邻 ID」在同一 turn 内会被 F1 去重拒绝；对 entry 级召回，「相邻 ID」是别的消息。两处都是死路，由 offset 取代。

### 3.3 不变量

- `offset` 缺省 0 时行为与旧实现一致，**除截断点**（按 token 后 CJK 场景更早截断——这是修复本身）
- ASCII 主导的文本截断点与旧实现基本一致（≈4 字符/token）

## 4. B：片段降级终态与渲染

### 4.1 片段识别（显式标记，不做推断）

渲染层需要知道「这是片段」才能走专用分支。**不推断**（`userMessage === undefined` 不可靠：user 消息只含图片时 `extractUserMessage` 也返回 undefined），改为显式字段：

```ts
export interface LedgerData {
  …
  /** 溢出片段（进行中 turn 切出）：渲染走片段专用分支；缺省 = 整 turn 条目（兼容旧数据） */
  isFragment?: true;
}
```

- 由 `SummarizerEngine.processWithRetry` 从 `turn.isFragment` 透传写入 `onLedger` 的载荷（唯一写入点，`isFragment` 字段已存在）
- `isValidLedger` 不校验该字段（可选字段，旧数据缺省即整 turn）；`normalizeLedgerData` 的 `{...d}` 展开天然保留
- 既有 `collectFragmentEntries`（按 store 位置判定）继续用于降级与收敛，二者互不替代：位置判定回答「哪些 key 是片段」，字段回答「这条 ledger 渲染成什么」
- 升级前已落盘的片段条目缺该字段 → 按整 turn 语义渲染（即当前行为「用户意图：（未知）」），turn 结束时被墓碑化，无需迁移

### 4.2 渲染（`src/ledger.ts`）

`renderTurnText` 的 L1–L3 分支改为：

```
整 turn（有 userMessage）：
  L1/L2: ### T{n} · 用户：「原话」           ← 现状不变
  L3:    同 L1/L2 头部（用户原话）+ 最终回复原文  ← 现状不变

片段（无 userMessage）：
  L1:  ### T{n} · 片段（进行中任务）      + 图片行（若有）+ 动作行 target → detail ↩ids
  L2:  ### T{n} · 片段（进行中任务）      + 动作行 detail ↩ids
  L3:  ### T{n} · 片段（{k} 个动作） ↩id1,↩id2,…   ← 机械标记行，无动作行
```

L3 标记行规则：

- `k` = `summary.entries.length`
- ↩ID 列表 = 各动作 `recallIds` 去重后的前 20 个；超出则追加 `…（共 {N} 个 ↩ID，可用 query 检索）`（search 对片段的动作独立于 level，始终可命中）
- 无动作（`entries` 为空）→ `### T{n} · 片段（无动作记录）`，不输出 ↩

**不再出现** `用户意图：（未知）` 这类占位——那是整 turn 在缺 `userIntent` 时的兜底，片段不该借它。

### 4.3 降级上限（`src/degrade.ts`）

`planDegrade` 第 4 参由 `holdAt4` 更名为 `holdAt3`，语义：集合内条目**不生成 `toLevel ≥ 4` 的 step**（原实现只挡 `toLevel === 5`）。

```ts
if (to >= 4 && holdAt3?.has(w.l.turnStartEntryId)) continue;
```

- 片段不再进入 L4/L5，因此 `mergeGroups` 天然不含片段（`toLevel=5` 的 step 不生成），原「L5 组成员筛选跳过片段」的逻辑由上限统一覆盖
- 片段仍参与各层 total 与 reserve 计量（与现状一致，保守方向）
- `DegradeEngine.run(ledgers, holdAt3?)` 同步更名
- `src/index.ts` 的 `runDegrade` 把 `holdAt4` 改名 `holdAt3`

### 4.4 文档勘误

- 本 spec 生效后，`2026-09-17-inflight-turn-degrade-design.md` 的裁定 3、裁定 7 与 §5「片段降级到 L5 边界」行需追加勘误注记（指向本文档 §4）：裁定 3 的「L1→L2→L3→L4 常规降级」与裁定 7 的「最多降到 L4」均改为「最多降到 L3」
- README「已知限制 · 进行中超大 turn」的「片段豁免 L5 合并、最多降到 L4」改为「片段最多降到 L3（L3 起渲染为机械标记行，↩ID 保留）」

## 5. C：T 标签同源

### 5.1 抽出装配计划函数（`src/assembler.ts`）

把 `assembleContext` 内部已算出的信息抽为可复用函数：

```ts
export interface AssemblyPlan {
  turns: Turn[];
  window: Turn[];
  windowStartIds: Set<string>;
  /** 日志头顺序：窗外有 ledger 的 turn + extraLedgers（片段）追加在末尾 */
  ledgers: LedgerData[];
  passthroughIds: Set<string>;
  stats: AssembleStats;
}
export function planAssembly(
  branch: MessageEntry[], cache: Map<string, LedgerData>, keepRecentTokens: number, extraLedgers: LedgerData[] = [],
): AssemblyPlan
```

`assembleContext` 改为调用它（行为逐字节不变，含 `stats` 计数）。**T 编号的唯一来源就是 `plan.ledgers` 的数组下标 + 1。**

### 5.2 调用点统一（`src/index.ts`）

新增闭包：

```ts
/** 日志头可见 ledger 列表（与 context 事件同一构造）：query 搜索的 T 编号与日志头严格同源 */
const visibleLedgers = (entries: MessageEntry[]): { ledgers: LedgerData[]; extraLedgers: LedgerData[] } => {
  const cache = ...;                                  // 与 context 事件同款（排除 absorbed）
  const plan = planInflightTrim(entries, cache, config!.keepRecentTokens);
  return { ledgers: planAssembly(plan.trimmedBranch, cache, config!.keepRecentTokens, plan.extraLedgers).ledgers, ... };
};
```

`query` 分支改为用该函数产出的列表喂 `searchLedger`；`session_before_compact` 与 `recall` 的 ids 路由**不改**（前者提交给 pi 的是独立文本，后者按 entry/turn 路由不依赖 T 编号）。

### 5.3 语义变更（需在 README 写明）

搜索范围从「全部有 ledger 的 turn」收窄为「日志头实际渲染的 ledger（窗外已替换 turn + 片段）」：

- 窗口内 turn 的内容**原文在场**，模型无需检索；其 ledger 是未被渲染的陈旧副本，此前会产出日志头不存在的 T 编号
- `searchLedger` 的 hit 仍给出 `entryIds`，召回路径不变
- 副作用：`query` 不再命中「窗口内 turn 的 ledger」——这是刻意的，用于换取标签同源

## 6. D：工程配置与清理

### 6.1 `vitest.config.ts`（新增）

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

### 6.2 `package.json` scripts

```json
"test": "vitest run",
"test:bench": "vitest run --dir bench",
"typecheck": "tsc --noEmit"
```

### 6.3 CI（`.github/workflows/ci.yml`，新增）

`actions/checkout` + `actions/setup-node`（node 22，npm cache）→ `npm ci` → `npm run typecheck` → `npm test`。触发：push 与 pull_request。

### 6.4 清理

删除（确认重复或已被取代后）：

| 文件 | 依据 |
|---|---|
| `scripts/_turnsize.mjs` | 与 `scripts/_turnsize.mts` 同源（编译产物） |
| `scripts/_asmstats.mjs` | 与 `scripts/_asmstats.mts` 同源（编译产物） |
| `scripts-dump-context.mjs`（仓库根） | 与 `scripts/preview-current-session.mts` 职责重叠（读会话文件跑装配并落盘），根目录位置失序 |
| `e2e/rpc-driver2.mjs` | `rpc-driver.mjs` 的后继版本，二者同用途 |

保留：`scripts/_preview-bundle.mjs`、`scripts/_turnsize.mts`、`scripts/_asmstats.mts`、`scripts/preview-current-session.mts`、`e2e/rpc-driver.mjs`。删除前逐个核对内容差异，若发现 `rpc-driver2` 含 `rpc-driver` 没有的能力则改为合并而非删除（届时在提交信息里说明）。

`.gitignore` 追加 `e2e/reports/`（bench 输出目录；已有历史报告已入库，保留不动）。

## 7. 边界情况

| 情况 | 行为 |
|---|---|
| `offset` 与多 ID 同传 | 返回一行用法提示（「offset 分页仅支持单 ID」），不召回、不计数 |
| `offset` 超出条目长度 | 返回「（offset 超出该条目长度）」提示行，不计 missing / rejected |
| `offset` 与 `query` 同传 | `offset` 只作用于 ids 路径；query 结果不受影响 |
| 片段在 L3 且动作数为 0 | 标记行 `片段（无动作记录）`，无 ↩ |
| 片段在 L3 且 ↩ID > 20 | 截前 20 个 + `…（共 N 个 ↩ID，可用 query 检索）` |
| 片段有图片（userMessage 无 → 图片行来源？） | 片段的图片行不渲染（图片只在 user 消息里，片段不含 user 消息）；图片仍可通过 recall 片段内的 entry 取回 |
| 片段被降级到 L3 后 turn 结束 | 收敛墓碑化照旧（整 turn 条目从 L1 重走瀑布，覆盖片段） |
| `holdAt3` 缺省 | 无豁免，行为与旧实现一致（除渲染层片段分支） |
| 升级前落盘的片段（无 `isFragment` 字段） | 不迁移：按整 turn 语义渲染（现状行为）；turn 结束时被墓碑化收敛 |
| 旧数据中已有 L4/L5 的片段 | 渲染层按既有 L4/L5 分支渲染（意图/outcome 为空时显示占位）；降级上限生效后不再产生此类条目 |
| user 消息只含图片（无文本）的整 turn | `userMessage` 为 undefined，但 `isFragment` 未置位 → 仍走整 turn 分支（不再被误判为片段，这正是引入显式字段的原因） |

## 8. 明确不做

- 不为片段引入 LLM 描述（如 `mergeDescribe` 式的片段摘要）——那会新增调用与配置，且 L3 标记行 + query + recall 已覆盖信息需求
- 不改 `findWindowTurns` 的「单 turn 超预算整体保留」语义
- 不改 `session_before_compact` 提交给 pi 的摘要列表构造（独立文本，T 编号自洽）
- 不做 recall 的「总量预算」（多 ID 仍各享单条预算）

## 9. 测试计划（TDD）

1. **A 截断**：CJK 文本按 token 截断（16000 中文字符 + 4000 预算 → ≈4000 字符）；ASCII 保持 ≈4 字符/token；预算充足不截断；`truncateToTokens` 纯函数单测（空串/极小预算/恰好等于）
2. **A 分页**：单 ID + offset 续取得到第二段且与首段无重叠；末段无截断标记；offset 超长返回提示；多 ID + offset 返回用法提示；offset 缺省行为不变
3. **B 渲染**：片段 L1/L2 渲染为「片段（进行中任务）」+ 动作行（含 target / 不含 target）；片段 L3 渲染为机械标记行（动作数 + ↩IDs），**不含**「用户意图」字样；动作数为 0；↩ID 超 20 截断；user 消息只含图片（`userMessage` undefined 但 `isFragment` 未置位）的整 turn 仍走整 turn 分支
4. **B 上限**：`planDegrade` 对 `holdAt3` 中的条目不生成 `toLevel ≥ 4`；片段不进 `mergeGroups`；普通条目照常到 L5；零豁免时行为不变
5. **C 同源**：同一 branch + cache 下，日志头 T 编号集合与 `query` 命中行的 T 编号一致（含片段场景、含窗口内 turn 有 ledger 的场景）；无片段/无窗口内 ledger 时逐字节不变
6. **D**：`npm test` 不含 bench（断言文件数）；`npm run typecheck` 通过；CI 文件存在且语法可解析（本地不跑 workflow）
7. **回归**：全量测试通过；`assembleContext` 抽函数后行为不变（既有 assembler 用例全绿）

## 10. 实施影响面

| 位置 | 改动 |
|---|---|
| `src/util.ts` | `truncateToTokens` |
| `src/recall.ts` | 两处截断改 token 口径 + `offset` 分页 + 标记文案 |
| `src/ledger.ts` | `LedgerData.isFragment` 字段 + 片段专用渲染（L1/L2 头部、L3 标记行） |
| `src/summarizer.ts` | `onLedger` 载荷透传 `turn.isFragment` |
| `src/degrade.ts` | `holdAt4` → `holdAt3`，上限 `toLevel ≥ 4` |
| `src/assembler.ts` | 抽出 `planAssembly`，`assembleContext` 复用 |
| `src/index.ts` | recall 工具 `offset` 透传；`visibleLedgers` 供 query；`holdAt3` 更名 |
| `vitest.config.ts` / `.github/workflows/ci.yml` / `package.json` | 新增 / 修改 |
| `scripts/`、`e2e/`、仓库根 | 删除 4 个重复脚本 |
| `docs/.../2026-09-17-inflight-turn-degrade-design.md` | 裁定 3/7 与 §5 勘误注记 |
| `README.md` | 配置表（offset 说明）、召回路由（分页）、已知限制（片段 L3）、搜索范围说明 |
