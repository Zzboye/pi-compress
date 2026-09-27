# L5 重构：逐条二次压缩（取消合并分组）

状态：待实现
日期：2026-09-27
分支：`feat/l5-per-turn-recompress`
取代：`2026-09-21-l5-task-aggregation-design.md`（已被探针否证，见该文「状态：部分否证」）

---

## 1. 背景

L5 是当前唯一的「合并终态」层：`planDegrade` 把本轮升 L5 的相邻 L4 条目切成段，`mergeDescribe` 为每段生成**一句主题描述**（≤25 字），写入段内每个成员，渲染为一行，召回被拒绝。

三轮探针（证据见 `docs/evidence/`）否证了这个形态：

| 探针 | 证据文件 | 结论 |
|---|---|---|
| 边界标记可靠性 | （task-008 记忆） | `startsNewTask` Jaccard 0.41–0.58，**结果不可复现** → 按任务聚合否证 |
| 合并描述质量 | `l5-merge-describe-ab.txt` | 现状（≤25 字）**关键标识保留率 0%**，与 L4 的 V0 同病 |
| 四方案对比 | `l5-merge-describe-4ways.txt` | 段落/条目/流程四套提示词**无一能兼得「主题 + 定位」** |
| 逐条压缩 | `l5-promptC-per-turn.txt` | 逐条 0.625 压缩率，短 L4 近乎压不动 |
| **批量逐条** | `l5-promptC-batch.txt` | **N=20 稳定，无串位，压缩率优于单条 17–39%** |

**关键数据**（148 条真实 L4）：

| 方案 | 压缩率 | 调用次数（900 条 L4） | 正确性 |
|---|---|---|---|
| 合并（现状，步长任意） | 0.43 | ~15 | ❌ 硬合并无关轮次，标识 0% |
| 逐条 | 0.625 | 900（44 分钟） | ✅ |
| **批量逐条（N=20）** | **~0.40** | **~45** | ✅ 已逐条核对 80 条无串位 |

结论：**保留「加一层压缩」的价值（0.40 压缩率、约 45 次调用），但取消「合并成一条」的形态**——改为每条 L4 各自压缩成一条独立描述，批量提交、逐条输出。

---

## 2. 裁定记录

| # | 裁定 | 依据 |
|---|---|---|
| 1 | **取消合并分组**。L5 不再「多 turn 合一行」，改为**每条 L4 独立生成一条 L5 描述** | 探针 4ways：合并形态必然丢信息（A/D 0% 标识）或退化成拼接（B/C 平均 138 字） |
| 2 | **批量调用，逐条对应**。一次调用提交 N=20 条 L4，要求输出 N 条，index 一一对应 | `l5-promptC-batch.txt`：N=20 的 2 批 10s/52s，20/20 正确、零空值 |
| 3 | **失败兜底 = 单条重跑**。某条返回 null/空 → 该条单独调一次 | 用户裁定。避免整批重试的放大成本 |
| 4 | **步长 2 分组取消**。原 T158「固定步长 2」不再需要——逐条即天然粒度为 1 | 裁定 1 的下推结论 |
| 5 | **L5 可召回 = 与 L3/L4 完全一致，返回该 turn 的整段原文** | 用户裁定（2026-09-27）。取消合并后 L5 与 L3/L4 同为「单 turn 降级形态」，无理由区别对待；「L3 视图」是合并形态下的折中（一组含多 turn 时整段原文会爆），取消合并后该折中失去依据 |
| 6 | **L5 行渲染锚点 ↩ID**（复用 `turnStartEntryId`），使召回有入口 | 当前 L5 行无任何 ID，用户无从召回。一 turn 一行后锚点即该行的唯一 ID |
| 7 | **不做 L6+**，L5 不限制大小 | T159 原裁定，维持 |
| 8 | **只管 L4→L5**，不改 L1→L4 选择粒度 | `2026-09-21` 裁定 8，维持 |

**明确不做**（相对旧 spec 的删除项）：

- ❌ `startsNewTask` 字段（标记不可靠）
- ❌ `taskAnchorId` 字段（按任务聚合否证后无意义，改用现算的 `turnStartEntryId`）
- ❌ 按任务累加 reserve、按任务分组渲染
- ❌ `mergeGroups` 作为计划期产物

---

## 3. 设计

### 3.1 数据模型

**不变**：`LedgerData.merged = { description }` 保留，语义从「组描述」变为「该 turn 自己的二次压缩描述」。仍写入单条 `LedgerData`（自包含，无需跨条目状态）。

**不再有组**：每条 L5 条目恰好对应一个 turn，`merged.description` 只属于它自己。

**兼容存量**：旧数据里一组多条共享同一 `merged.description`。**不做数据迁移** —— 旧描述与旧后缀原样保留，仅渲染形态随聚合分支的删除而改变（由「合并成一行」变为「每条各占一行，各带自己的 ↩ID」）。存量 L5 条目的 `turnStartEntryId` 一直存在，锚点无需补写。

### 3.2 计划期（`degrade.ts`）

`planDegrade` **删除 `mergeGroups` 产物**（及 82–95 行的相邻切段循环）。`toLevel=5` 的 step 保留，逐条执行。

`DegradePlan` 接口：

```ts
export interface DegradePlan {
  steps: DegradeStep[];   // mergeGroups 字段移除
}
```

`holdAt3` 豁免逻辑不变（片段不进 toLevel≥4）。

### 3.3 执行期（`DegradeEngine.run`）

L4→L5 从「逐组」改为「**先把所有 toLevel=5 的条目收集起来 → 按 20 条分片 → 每片一次 LLM 调用 → 逐条写回**」。

```
1. 收集 pending = plan.steps.filter(toLevel === 5) 的 LedgerData（保持最旧优先顺序）
2. 按 20 条切片
3. 每片：
   a. 调 compressMany(backend, batch) → string[]（长度 = 片长）
   b. 逐条：非空 → 写 merged.description + level=5 + onLedger
   c. 空/null 的条目：单独调 compressOne → 成功则写回；仍失败 → onWarning，保持 L4
4. 空片/整体失败：onWarning，该片全部保持 L4
```

**失败语义**：单条失败 → 该条保持 L4（下次 agent_settled 重试）。**不再有「整组回滚」**（因为没有组）。

**时序约束（必须遵守）**：`compressMany` 必须在写 `level = 5` **之前**调用 —— 与现状 `mergeDescribe` 同理（`degrade.ts:142` 注释）。若先置 L5，则 `summary` 输入路径会读到已降级状态，且重入时描述已被覆盖。

**输入可用性依赖**：`compressMany` 读 `summary.userIntent` / `summary.outcome`，这两个字段由 L3→L4 的 `compressEnds` 写入。`planDegrade` 可在单次调用内双跳（L3→L4→L5，`degrade.ts:73-80` 就地修改 `working`），此时**执行顺序保证** `compressEnds`（`129-140`）先于 L5（`141+`）跑完。这个保证来自代码顺序，**不是类型系统**——重构执行顺序时必须重新验证。

### 3.4 LLM 接口（`degrade-llm.ts`）

替换 `mergeDescribe` 为两个函数：

```ts
/** 批量：N 条 L4 → N 条描述，index 一一对应。缺失项为 null */
export async function compressMany(
  backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal,
): Promise<Array<string | null>>

/** 单条：失败兜底路径（也是批量大小=1 的退化） */
export async function compressOne(
  backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal,
): Promise<string>
```

`compressMany` 的解析规则：

- 剥 ``` 围栏 → `JSON.parse`
- 接受 `{ items: [{index, description}] }` 或裸数组
- 建 `Map<index, description>`，按 1..N 顺序取出，缺项 → `null`
- **不做整批抛错**（除非 JSON 完全无法解析 → 全部返回 null）

上述解析规则已由 2026-09-27 探针验证：2 批各 20 条，全部解析成功、零缺失、零重复 index（见 `docs/evidence/l5-prompt-verify.txt`）。

### 3.5 提示词（`prompts.ts`）

删除 `buildMergeDescriptionPrompt`，新增：

```ts
/** 批量二次压缩：逐条对应，不做跨条合并（见 docs/evidence/l5-prompt-verify.txt） */
export function buildBatchRecompressPrompt(items: LedgerData[]): string
```

**提示词正文（用户给定，经 2026-09-27 探针验证）**：

```
请对以下已经完成过一次摘要的内容做二次摘要。
要求：
1. 剔除冗余细节（commit哈希、具体文件路径、零散函数名等），保留核心结论、关键变更、产出物、待办事项
2. 按原有顺序梳理逻辑，不新增信息，不丢失主线节点
3. 语言凝练，篇幅压缩到原文的1/2以内
```

**批处理契约**（追加在上述正文之后）：

```
下面是 ${N} 条独立内容，每条以 "[#序号]" 开头：

[#1]
意图：...
结果：...

[#2]
...

逐条输出，每条各占一项，必须与输入条数相同（共 ${N} 条），序号一一对应。
只输出 JSON：{"items": [{"index": number, "description": string}, ...]}
```

**输入文本格式**：`意图：{summary.userIntent}\n结果：{summary.outcome}`，**不用 `renderTurnText`**。

**验证状态（2026-09-27 已完成）**：两批各 20 条真实 L4，`deepseek-v4-flash`，temperature=0。

| 项 | 结果 |
|---|---|
| JSON 解析 | 2/2 成功 |
| 返回条数 | 20/20、20/20 |
| index 缺失 | 0 |
| index 重复 | 0 |
| **串位** | **0**（人工逐条核对 40 条） |
| 耗时 | 31.0s / 69.1s |
| 压缩率 | 6466 → 3184 字符 = **0.492** |
| 变长条数 | 0 |

证据：`docs/evidence/l5-prompt-verify.txt`（241 行，40 条完整对照）。

**⚠️ 一处仍需在实施时确认的偏离**：现状 `mergeDescribe`（`degrade-llm.ts:37`）喂的是 `renderTurnText(l, 0)`，输出形如：

```
### T0 · 意图：xxx ↩abc123
- 最终回复（摘要）：yyy ↩def456
```

而本次验证用的是**干净字段**（`意图：…\n结果：…`，无 `T0` 前缀、无 ↩ID）。**验证结论只对干净字段成立**。选干净字段的理由：输入语义是「已完成的摘要」，`T0` 与 ↩ID 是渲染噪声（`T0` 编号本身是占位符）。实施时按本 spec 的干净字段实现即可，无需再喂 `renderTurnText`。

### 3.6 渲染（`ledger.ts`）

**一个 turn = 一条 L5 行 = 一条描述**（裁定 1 的直接结果）。

**渲染单条**（`renderTurnText` 的 `lvl === 5` 分支）：加锚点 ↩ID。

```ts
// 旧：lines.push(`T${n} · ${desc}`);
lines.push(`T${n} · ${desc} ↩${l.turnStartEntryId}`);
```

**聚合渲染**（`renderActionLedger` 的 L5 段，`ledger.ts:170-192`）：**整块删除**。

删掉的依据：

- 聚合条件是「相邻 + `merged.description` 相同」。新数据**每条描述各不相同** → 循环永远只切出 1 条 → 永远走 `group.length === 1` 路径
- 而 `group.length === 1` 的输出是 `### T{n} · {desc}`，与 `renderTurnText` 的 `T{n} · {desc} ↩{id}` **只差一个 `### ` 前缀** —— 而新方案要的正是带 ↩ID 的形态，聚合分支成了纯负担
- 删除后 L5 条目走通用路径（`renderTurnText(l, i+1)`），与 L3/L4 一致

**「（N 条已合并）」后缀取消**：`compressMany` / `compressOne` 不再追加此后缀（现状 `degrade-llm.ts:51` 会加）。一个 turn 一条描述，「N 条」无意义。**存量旧数据的后缀保留原样**（不回溯改写）。

**连带消失**：Codex P3 的计数重写逻辑（`ledger.ts:181-187`）一并删除 —— 它修的问题（两个批次碰巧生成同一描述而被误聚合）在「一 turn 一描述」下不存在。

### 3.7 召回（`recall.ts`）

**删除 L5 拒绝分支**（86–91 行），并把上界打开——L5 与 L3/L4 走**同一条 turn 级路径**：

```ts
// 旧：if (turn && lvl >= 3 && lvl <= 4)
// 新：if (turn && lvl >= 3)
```

**改动只有一个边界条件**。分支内部逻辑零改动：`serializeForRecall(turn.entries)` 本来就取该 turn 的全部原始 entries（含工具过程与两端原文），与 level 无关——L3/L4 是这样，L5 也必然是这样。

- 无渲染层介入（不需要 renderTurnText，不需要覆写 level）——这是相对上一版「L3 视图」方案的简化
- `seenTurns` 去重（F1）自动生效：多 ID 命中同一 L5 turn 只返回一次
- 截断 / `offset` 续取 / 图片收集全部复用

`rejected` 计数随之**失去意义**（不再有拒发）→ 删除该字段及 `index.ts` 中的相关统计（M9 引入的机制回退）。

**为什么不是 L3 视图**：2026-09-21 裁定 6 选 L3 视图，理由是「一组含多 turn，整段原文会爆上下文」。取消合并后一条 L5 = 一个 turn，与 L3/L4 同构，该理由消失。

### 3.8 配置

**无新增配置项**。批量大小 20 硬编码为模块常量（`L5_BATCH_SIZE = 20`），附注释指向探针证据。

---

## 4. 影响面

| 文件 | 改动 |
|---|---|
| `src/degrade.ts` | `DegradePlan.mergeGroups` 删除；`planDegrade` 切段循环删除；`DegradeEngine.run` 的 L5 段重写为分片批量 |
| `src/degrade-llm.ts` | `mergeDescribe` → `compressMany` + `compressOne` |
| `src/prompts.ts` | `buildMergeDescriptionPrompt` → `buildBatchRecompressPrompt` |
| `src/ledger.ts` | L5 渲染加锚点 ID（1 行）；删除 `renderActionLedger` 的 L5 聚合分支（`170-192`，含 P3 计数重写逻辑） |
| `src/recall.ts` | L5 拒绝分支删除，分支条件 `lvl >= 3 && lvl <= 4` → `lvl >= 3`（1 处）；`rejected` 字段删除 |
| `src/index.ts` | recall 统计去掉 rejected |
| `README.md` | L5 描述、召回行为、已知限制 |
| `docs/superpowers/specs/2026-09-21-*.md` | 加勘误：裁定 6 由本文档取代 |

---

## 5. 边界情况

| 情况 | 处理 |
|---|---|
| 批量某条返回 null | 单条重跑（裁定 3）；仍失败 → 保持 L4 + warning |
| 整批 JSON 解析失败 | 该批全部按 null 处理 → 逐条重跑 |
| 批量返回条数少于 N | 缺项按 null（不因数量不符而整批废弃） |
| 批量返回 index 越界/重复 | 非法项忽略；缺失位按 null |
| 片长 < 20（余数片） | 正常处理（1..20 均可） |
| 只有 1 条待降级 | 走 `compressMany` 长度=1（即退化单条），无需分支 |
| 该 turn 无 `userMessage`/`finalReply` | 输入为空串；模型可能返回空 → 单条重跑 → 仍空则保持 L4 |
| L5 turn 被 recall | 返回该 turn 整段原文（同 L3/L4） |
| L5 turn 无 userMessage（纯图片 turn） | 整段原文路径不依赖 userMessage，正常返回 |
| 新数据描述碰巧与相邻旧 L5 相同 | 聚合分支已删除 → 不可能误聚合（该风险随 3.6 一并消失） |
| 存量旧 L5（一组多条共享描述） | 聚合分支已删除 → 每条各占一行（含自己的 ↩ID 与旧后缀）；召回按 turn 级，各自返回整段原文 |

---

## 6. 非目标

- 不引入 L6+（裁定 7）
- 不改 L1→L4 的选择粒度与阈值（裁定 8）
- 不恢复 `startsNewTask` / `taskAnchorId` / 按任务聚合（已被否证）
- 不为 L5 描述加字数硬限制（L4 探针已证明硬限制会砍掉关键信息）
- 不为存量旧 L5 做数据迁移（描述与旧后缀原样保留，仅渲染形态改变）
- 不改 `searchLedger` 的检索字段（当前只检索 `userMessage.text` / `finalReply.text` / 动作 target+detail / `merged.description`，L5 描述仍可被检索到）

---

## 7. 测试计划

| # | 用例 | 类型 |
|---|---|---|
| 1 | `planDegrade` 不再返回 `mergeGroups`；toLevel=5 的 steps 逐条存在 | 单元（改既有） |
| 2 | `compressMany`：N 条输入 → N 条输出，index 一一对应 | 单元（新） |
| 3 | `compressMany`：某 index 缺失 → 该位为 null，其余正常 | 单元（新） |
| 4 | `compressMany`：JSON 完全不可解析 → 全 null | 单元（新） |
| 5 | `compressMany`：裸数组 / 带围栏 / `{items}` 三种形态均能解析 | 单元（新） |
| 6 | `DegradeEngine`：一批 20 条 → 调用 1 次，20 条全升 L5 | 单元（新） |
| 7 | `DegradeEngine`：批内 1 条返回 null → 该条单条重跑，其余不重复调用 | 单元（新） |
| 8 | `DegradeEngine`：单条重跑仍失败 → 该条保持 L4 + warning，其余升 L5 | 单元（新） |
| 9 | `DegradeEngine`：25 条待降级 → 2 次调用（20 + 5） | 单元（新） |
| 10 | 渲染：L5 单条行含 `↩{turnStartEntryId}` | 单元（新） |
| 11 | 渲染：存量旧 L5（多条共享描述）→ 各占一行，不再聚合 | 单元（改既有） |
| 12 | 渲染：L5 行含 ↩ID；不再出现 `（N 条已合并）` 新后缀 | 单元（新） |
| 13 | 召回：L5 的 ID → 返回该 turn 整段原文（含工具过程，与 L3/L4 一致） | 单元（新） |
| 14 | 召回：L5 的 ID → 不再返回「不可恢复」文案 | 单元（改既有） |
| 15 | 召回：L5 turn 整段原文超预算 → 截断 + offset 续取 | 单元（新） |
| 16 | 召回：多 ID 命中同一 L5 turn → 去重提示（F1 行为） | 单元（新） |
| 17 | 统计：`rejected` 字段移除后 calls/hits 计数正确 | 单元（改既有） |
| 18 | 提示词：`buildBatchRecompressPrompt` 含逐条对应契约与条数声明 | 单元（新） |
| 19 | 缺省路径：不含 L5 的会话，装配渲染逐字节不变 | 单元（防护） |
| 20 | ~~前置探针：用 `renderTurnText` 格式重跑 N=20~~ → **已由 2026-09-27 验证取代**（干净字段，2 批 20 条，零串位；见 `l5-prompt-verify.txt`）。改为：实现后跑一次真实降级，确认线上路径与验证一致 | 探针（改为实施后复核） |

---

## 8. 遗留与风险

| 项 | 说明 |
|---|---|
| **成本** | 900 条 L4 → 约 45 次调用（N=20）。实测 N=20 两批 **31.0s / 69.1s**，取中位约 50s → **约 35 分钟后台**（乐观 20 分钟、悲观 70 分钟）。比现状（约 15 次）贵 3 倍，换来标识保留与正确性 |
| **耗时波动** | 实测同规模同批量下 31s vs 69s（2.2 倍）；历史 N=40 观测 39s vs 99s（2.5 倍）。reasoning 模型固有特性，无法控制 |
| **未测更大批量** | N=40 通过（8/8），N=80/100 未测。本次又验 N=20 × 2 批（31s/69s），保守取 20 |
| **L5 层增长** | L5 现在是逐条压缩，实测压缩率 **0.492**（6466→3184 字符），L5 层体积比现状（合并形态，组共享一行）**更大**。这是换取信息保留的代价 |
| **存量旧数据** | 旧 L5 的合并描述保留原样，与新数据混排。渲染层已兼容，但视觉上「旧的粗、新的细」会并存一段时间 |
| **`merged` 字段语义漂移** | 从「组描述」变「单 turn 描述」。字段名未改（改名会碰存量兼容），README 需说明 |
