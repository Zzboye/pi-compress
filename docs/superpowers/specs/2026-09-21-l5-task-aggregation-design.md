# Spec：L5 任务聚合（任务标记 / 按任务合并 / 任务级召回）

> **状态：部分否证（2026-09-26）**
>
> 探针结论（153 turn 真实会话，`deepseek-v4-flash`）：
> - **裁定 1/2/3/4/7 依赖的 `startsNewTask` 边界标记不可靠**——同一提示词复跑三次，边界集合 Jaccard 仅 **0.41–0.58**（结果不可复现）；以人工标注 16 个工作单元为参照，P=0.50 / R=0.44，**假阴性主导**（旧任务起点系统性漏标：T4/T12/T43/T62/T68/T92/T104/T122）。
> - 两个改进尝试（前 5 轮上下文、批量一次分段）均无效。
> - 故**按任务聚合（裁定 3/4/7）挂起**，等更可靠的边界来源（换模型 / 降精度 / 人工入口）。
>
> **裁定 6（L5 可召回 = 任务级 L3 视图 + 锚点 ID）不依赖标记**，可独立实施——但「任务级」粒度在标记不可靠时需重新定义（可能退化为「批次级」）。详见 task-009 与 T153 探针报告。
>
> 本文件自 `feat/l5-task-aggregation`（commit `e43086f`）迁入，该分支已删除。


分支：`feat/l5-task-aggregation`（基于 main `2bdf9b9`）
前置：`2026-09-16-five-level-degrade-design.md`（五级阶梯）、`2026-09-20-review-fixes-design.md`（片段终态 L3）

## 1. 背景与动机

L5 现状（`degrade.ts` / `ledger.ts` / `recall.ts`）有三个问题：

1. **聚合单位是「相邻降级批次」而非「任务」**。`planDegrade` 按「连续且都需要降级」分组（`degrade.ts:88-96`），一批可能横跨两个任务，也可能把同一任务切成两半。渲染层用 `merged.description` 逐字相等当组身份（`ledger.ts:174-183`），只是对批次边界的启发式近似。
2. **L5 不可召回**。L5 行不渲染任何 ↩ID，`executeRecall` 对 L5 一律返回拒绝文案（`recall.ts:73-79`）。而 `searchLedger` 在 L5 段照常返回 `allRecallIdsOf`（`recall.ts:186`）——「假可用性」：搜索给得出 ID，召回却一律拒绝。数据在、取不回，与本项目「原文永远可取回，只在需要时取」的哲学冲突。
3. **组身份靠描述字符串**（M4 / P3）。两个任务描述碰巧相同会被误并（P3，靠重写计数后缀打补丁）；同一任务的相邻批次描述不同会被拆成两行。

根因是**没有显式的任务身份**。本 spec 引入任务标记，把 L5 的聚合单位从「降级批次」改成「任务」，并让 L5 以任务为单位可召回。

## 2. 裁定记录

| # | 裁定 | 理由 |
|---|---|---|
| 1 | 引入 `startsNewTask: boolean`（**只标开始，不标结束**） | 任务是否结束只有下一个任务出现时才知道；`compressEnds` 只看得见本 turn 的两端，标不了结束。任务 = 连续的一串 `startsNewTask=false` 的 turn，结束由下一个 `true` 隐含定义 |
| 2 | 标记在 **L3→L4 的 `compressEnds`** 里顺带产出（同一次 LLM 调用，加一个输出字段） | 该调用的输入本来就是 L3 两端**原文**（`degrade-llm.ts:24-27`），话语标记（「接下来」「先做2」「顺便」）都在，零额外成本、零 token 增加 |
| 3 | L5 合并单位 = **任务**（不是「相邻降级批次」） | 一个任务一行；跨批拆分从结构上消失 |
| 4 | 保留区边界**按任务累加**（向下取整：跨越任务**保留**） | 与 `chooseOldestForLevel` 的「保持尾部 ≥ reserve 硬下界」契约一致（`degrade.ts:31`）；跨越任务是最近被压的任务，越近越重要；「最后一个任务永不合并」自动满足，无需额外规则 |
| 5 | `mergeDescribe` **每任务一次**调用 | 沿用现有契约，零新接口；批量优化留到实测有压力再说 |
| 6 | L5 召回 = **任务级 L3 视图**（用户原文 + 回复原文，不含工具过程），行尾带**锚点 ID** | 任务级 L5 行本身就是意图+outcome 的再浓缩，返回 L4 等于没召回；L3 带回被行描述和 L4 摘要都丢掉的用户原话与结论原文，且体积小（一个 5-turn 任务约 1–2k tok，多数无需分页） |
| 7 | 渲染聚合边界从「描述相等」改为**「任务标记」**（存量回退描述相等） | 任务身份是显式数据；两个相邻任务即使描述碰巧相同也正确分行，P3 从根上消失 |
| 8 | 只管 **L4→L5**，不改 L1→L4 的选择粒度 | 任务级选择器是另一个数量级的改动；任务被切开的问题在「按任务分组 + 标记断行」下已消除（切开的两半各自成组、各带描述，不静默丢失） |

## 3. 数据模型

`src/ledger.ts` 的 `LedgerData` 新增两个字段：

```ts
export interface LedgerData {
  // ...既有字段
  /** 任务边界：本 turn 是否开启了一个新任务（L3→L4 时由 compressEnds 产出）。
   *  缺省 = 未知（存量数据）：渲染聚合与任务分组回退「相邻且描述相同」的旧行为。 */
  startsNewTask?: boolean;
  /** 任务锚点：L5 行的召回入口。写入时机 = L4→L5 合并成功时（同一任务的全部成员写同一个值）。
   *  值 = 任务首 turn 的 userMessage.entryId（缺省回退该 turn 的 turnStartEntryId）。 */
  taskAnchorId?: string;
}
```

**任务身份的定义**（贯穿本 spec）：把 branch 序的 ledger 列表按 `startsNewTask === true` 切段，每段是一个任务；**首个标记之前的条目归入第一个任务**；**无任何标记的连续段整体视为一个任务**（存量回退，不碎成 N 个单 turn 任务）。片段（`isFragment`）不参与任务分组。

**标记只在 L3→L4 时写出**：未经过 `compressEnds` 的条目（仍在 L1/L2/L3）没有标记，按「继续当前任务」处理（并入其所在段）。因此任务的「起点」由该任务首个**经过 L3→L4** 的 turn 定义。

## 4. 任务标记的产出（`prompts.ts` / `degrade-llm.ts`）

`buildIntentOutcomePrompt` 增加第三个输出字段与上一轮上下文：

```
规则：
1. userIntent：用户这轮想要什么，≤20 字，动宾短语
2. outcome：模型最终达成了什么结论/结果，≤30 字，写结论不写过程
3. startsNewTask：本轮是否开启了一个新任务（与上一轮相比是「另起一件」还是「同一件的继续」）
   - 用户消息出现「接下来」「另外」「顺便」「还有」「新问题」等转折，或目标/对象明显换了一件 → true
   - 同一目标的后续步骤、追问、修 bug 的下一轮 → false
   - 无法判断 → false（宁并勿拆：误并只损失描述精度，误拆会把一个任务切碎）
4. 不复述原文，只提炼

上一轮在做什么（仅供判断是否另起一件，首轮为空）：
<prev>${prevIntent}</prev>

用户消息原文：
<user>...</user>
模型最终回复原文：
<reply>...</reply>

只输出 JSON：{"userIntent": string, "outcome": string, "startsNewTask": boolean}
```

- `compressEnds` 返回 `{ userIntent, outcome, startsNewTask }`；`startsNewTask` 严格校验 `typeof === "boolean"`，**非法/缺失回退 `false`**（宁并勿拆；且不因新字段解析失败而回滚整个 L4 降级）。
- `DegradeEngine.run` 的 L3→L4 循环把 `startsNewTask` 写进 `l.startsNewTask`（与 `userIntent/outcome` 同一次 `onLedger` 持久化）；`prevIntent` = 该条在 branch 序中**前一条 L4 条目**的 `summary.userIntent`（无则空串）。

> **前置依赖（task-008）**：标记准确率直接决定聚合正确性——假阳性（任务中间被标 `true`）会把一个任务碎成两个单元（等价于旧的拆分）；假阴性（任务起点未标出）会把两个任务并成一行（信息混叠，比拆分更糟）。**实施前先跑探针**：拿本项目真实会话，用 `compressEnds` 的输入（两端原文 + 上一轮意图）测边界判断准确率；若假阴性率偏高，需加一轮 LLM 复核边界或回退方案。探针数据记入 task-008。

## 5. 合并分组（`degrade.ts`：从计划期移到执行期）

**结构变更**：`mergeGroups` 不能再留在 `planDegrade` 里——它是纯函数，在执行前一次算完，此刻还没有任务标记（`degrade.ts:60-96`）。执行序改为：

```
planDegrade（只出 L1→L4 的 steps）
  → L1→L2 机械 → L2→L3 机械 → L3→L4 compressEnds（产出 startsNewTask）
  → planMergeGroups（新纯函数：读当前 level + startsNewTask）
  → L4→L5 mergeDescribe × 任务数
```

### 5.1 新纯函数

```ts
/** 按任务分组（branch 序）：段首 = startsNewTask===true 的条目；首个标记前归首任务；
 *  无标记的连续段整体为一个任务；片段（isFragment）不参与。 */
export function groupByTask(ledgers: LedgerData[]): LedgerData[][]

export interface MergePlan {
  /** 本次升 L5 的任务：每项含锚点与待合并成员（成员 = 该任务的全部非片段 turn，含低层成员） */
  groups: Array<{ anchorId: string; members: LedgerData[] }>;
  /** 保留后缀（未被选中合并的任务），供测试与调试断言 reserve 硬下界 */
  preserved: string[][];
}
export function planMergeGroups(
  ledgers: LedgerData[], thresholdTokens: number, reserveTokens: number,
): MergePlan
```

算法（与 `chooseOldestForLevel` 同构，单位从 turn 换成任务）：

```
total = Σ 全部 level===4 条目的 turnRenderTokens          ← 触发与 reserve 计量仍在 L4 层
if (total <= threshold) return { groups: [], preserved: [] }
tasks = groupByTask(ledgers) 中「至少含一个 level===4 成员」的任务（按 branch 序）
  —— 候选资格只看「有没有 L4 成员」；合并时吸收该任务的全部非片段成员（含 L1/L2/L3 成员）
taskTokens = Σ 该任务 level===4 成员的 turnRenderTokens
逐任务累加（最旧→最新）：选中下一任务会击穿 reserve（total - acc - taskTokens < reserve）→ 停
groups = 已选中任务（anchorId = 任务首 turn 的 userMessage?.entryId ?? turnStartEntryId）
preserved = 剩余候选任务
```

**为什么「合并整个任务」而不是「只合并任务的 L4 部分」**（关键设计点）：层内最旧优先意味着**一个任务可以跨层**——它的老半先被推到 L4、新半还留在 L3（且被 L3 的 reserve 保护）。若只合并 L4 部分，就会把一个任务切成「老半 L5 + 新半 L3」——正是本 spec 要消灭的拆分。所以：**候选资格 = 有 L4 成员；合并范围 = 整个任务**。副作用是低层成员被直接吸收（省掉它们的 L3→L4 调用），且不会出现混合层级的半行。

- **`mergeDescribe` 输入**：每个成员按**当前层级**渲染，但低层成员用 L3 视图（`renderTurnL3View`，两端原文）而非 L1/L2 视图（避免冗长动作行灌进 prompt）。即：L4 成员 → `renderTurnText`（意图+outcome）；<L4 成员 → `renderTurnL3View`。
- **进展守卫**：与 `chooseOldestForLevel` 的 `chosen.length > 0` 等价——若第一个任务就击穿 reserve，仍强制压它（保证降级有进展，避免死循环）。
- **M5 结构性消失**：候选资格要求「至少一个 L4 成员」，且 `compressEnds` 失败回滚到 L3 的条目本身不构成候选；同一遍瀑布中失败的条目不会再被单独升 L5。task-005 的 M5 条目从「观察到再修」改为「已修（结构性消失）」。

### 5.2 执行

`DegradeEngine.run` 的 L4→L5 段改为：

```ts
const plan = planMergeGroups(ledgers, threshold, reserve);
for (const { anchorId, members } of plan.groups) {
  try {
    const { description } = await mergeDescribe(this.backend, members);   // 成员按当前层级渲染
    for (const m of members) {
      m.level = 5;
      m.merged = { description };
      m.taskAnchorId = anchorId;   // 锚点与合并同一时序写入，全部成员同一值
      this.onLedger(m);
    }
  } catch (err) { this.onWarning(`...L5 合并失败（${String(err)}），保持原层级`); }
}
```
- **删除 `DegradePlan.mergeGroups` 字段**（接口变更；`degrade.test.ts` 有若干用例断言它，需同步）。
- 合并失败保持「level 从未被改」的既有语义（先 `mergeDescribe` 后置 5）——此时锚点也未写，无残留。
- 低层成员被吸收进 L5 时，其 L3→L4 的 `compressEnds` 调用被跳过（省调用）。

## 6. 渲染（`ledger.ts`）

### 6.1 聚合边界按任务标记

`renderActionLedger` 的 L5 聚合循环（`ledger.ts:174-183`）边界改为：

| 相邻两条 L5 | 聚合 |
|---|---|
| 后者 `startsNewTask === true` | **断行**（新任务） |
| 后者 `startsNewTask === false` 且 `merged.description` 相等 | 合并 |
| 后者 `startsNewTask === false` 且描述不同 | 断行（防御：标记异常） |
| 后者无标记（存量） | 描述相等则合并，否则断行（现状） |

- 计数后缀重写（`ledger.ts:181-184`）保留：聚合 >1 条时剥旧后缀、按 `group.length` 重写。
- **P3 从根上消失**：不同任务描述碰巧相同 → 后者带 `startsNewTask=true` → 正确分行。
- `recall.ts` 的 `searchLedger` L5 聚合段（`recall.ts:228-240`）**同步同款边界**，保证命中行的 T 范围与渲染行一致。

### 6.2 L5 行渲染带锚点 ID

```
### T12-T15 · 调查修复降级排序 bug（4 条已合并） ↩u-abc123
```

- 锚点 = `group[0].taskAnchorId`；缺省（存量）→ 行尾不带 ID（保持现状）。
- 只在**真正聚合（`group.length > 1`）或单条 L5 行**都渲染锚点（单条时它是某任务的唯一代表行，同样需要召回入口）。

### 6.3 L3 视图渲染助手

抽出 `renderTurnL3View(l, n)`：L3 语义 = `### T{n} · 用户：「原文」` + 图片占位行（`renderImagesLine`）+ `最终回复（原文）：…`。`renderTurnText` 的 `lvl === 3` 整 turn 分支改为调用它（行为逐字不变），recall 的任务级视图复用它（强制按 L3 渲染，与 `l.level` 无关）。

## 7. 召回（`recall.ts` / `index.ts`）

### 7.1 三档改为：entry 级 / turn 级 / **任务级**

| 层级 | 可见 ID | recall 行为 |
|---|---|---|
| L1/L2 | 动作行 + 两端 | entry 级（现状不变） |
| L3/L4 | 两端 ID | turn 级（现状不变，整段原文 + 分页） |
| **L5** | **行尾锚点 ID** | **任务级**：返回该任务**全部 turn 的 L3 视图**（用户原文 + 回复原文，不含工具过程） |

**实现**：`RecallDegradeCtx` 增加 `anchorOf: Map<string, string>`（`entryId → taskAnchorId`，由 `index.ts` 从 `ledgersInBranchOrder(entries, false)` 构造）。L5 分支：

```
anchor = anchorOf.get(id)（该 ID 本身即锚点，或所属 turn 的某成员）
if (!anchor) → 走「无锚点存量」提示文本（保持现状的不可达语义）
members = ledgers.filter(l => l.taskAnchorId === anchor)，按 branch 序
输出 = members 逐条 renderTurnL3View(m, n) 拼接，前缀一行说明
预算 = 整体受 maxTokensPerEntry 约束（truncateToTokens + offset 续取，与 turn 级同款）
```

- **不再拒绝**：删除 `rejected` 计数路径与拒绝文案（`recall.ts:73-79` 的 L5 分支整体替换）。
- **无锚点的存量 L5 行**：行尾无 ID → 不可达；`searchLedger` 命中行仍返回 `allMembersIds`（保持现状，模型可逐 entry recall）。
- 输出前缀示例：`【↩u-abc123 所在任务（L5）的 L3 视图，共 4 轮】`。
- 图片：v1 只给 `renderImagesLine` 的文本占位，**不**回传 image 块（任务级可能聚合大量图，v1 保守；residual 记录在案）。

### 7.2 统计

- `RecallResult.rejected` 字段删除；`index.ts` 的 `recallStats.rejected` 与 `/compress-status` 的「L5 拒绝 N 个」删除。
- 任务级召回同样计 `hits`（「取回 1 条」），不新增口径。

## 8. 明确不做

- **不改 L1→L4 的选择粒度**（裁定 8）：`chooseOldestForLevel` 仍按 turn 选。
- **不做跨批重合并**：按任务累加 + 标记断行后，同一任务不会跨批拆成两行。
- **不做「按任务整体降级」**：一个任务的不同 turn 可以停在不同 level；但**合并**以任务为单位（候选 = 含 L4 成员的任务，合并时吸收其低层成员，§5.1）。
- **不改 `searchLedger` 的匹配范围**：仍搜 `LedgerData` 全量字段（不受 level 影响）；只改 L5 聚合段边界（§6.1）。
- **片段（`isFragment`）不参与任务分组**：不写 `taskAnchorId`，`startsNewTask` 不适用；片段终态 L3（`holdAt3`）不变。
- **不做批量 `mergeDescribe`**（裁定 5）。
- **不迁移存量 L5 数据**：无标记 → 回退旧行为；`taskAnchorId` 缺失 → 行尾无 ID。

## 9. 边界情况

| 情况 | 行为 |
|---|---|
| 首个标记之前的条目 | 归入第一个任务（该任务起点 = 列表首条） |
| 连续无标记（存量） | 整段视为一个任务（不碎成 N 个单 turn 任务） |
| 跨越 reserve 的任务 | 整任务保留（向下取整，裁定 4）；「最后一个任务永不合并」自动满足 |
| 第一个任务就击穿 reserve | 强制压它（进展守卫） |
| 任务有成员不是 L4（compressEnds 失败 / 尚未升到） | **仍可合并**（候选资格只看「有 L4 成员」）——合并范围 = 整个任务，低层成员被吸收；`mergeDescribe` 输入中低层成员用 L3 视图 |
| `mergeDescribe` 失败 | 整组保持原层级，warning；锚点未写（与 level 同一时序） |
| `startsNewTask` 非布尔/缺失 | 回退 `false`（宁并勿拆）；不因解析失败回滚 L4 |
| `taskAnchorId` 缺失（存量 L5） | 行尾无 ID；recall 给「不可任务级召回」提示；search 命中行照常返回成员 ID |
| 相邻两个任务描述碰巧相同 | 后者带 `startsNewTask=true` → 正确分行（P3 消失） |
| 无 `startsNewTask` 的相邻 L5 描述相同 | 合并（存量回退，现状行为） |
| 任务含片段 + 整 turn | 片段不计入任务成员；锚点取任务首个整 turn |

## 10. 测试计划（TDD）

1. **`prompts.ts`**：`buildIntentOutcomePrompt` 含 `startsNewTask` 规则与 `prevIntent` 槽位；首轮 `prevIntent=""`。
2. **`degrade-llm.ts`**：`compressEnds` 返回 `startsNewTask`；非布尔/缺失 → `false`；`userIntent/outcome` 缺失仍抛错（现有行为不变）。
3. **`groupByTask`**：标记切段；首标记前归首任务；无标记整段一个任务；片段被排除；空输入。
4. **`planMergeGroups`**：
   - L4 总量 ≤ threshold → 空
   - 按任务累加、跨越任务保留（**含边界落在任务内部的多 turn 任务用例**，断言该任务在 `preserved` 而非 `groups`）
   - 保留后缀 ≥ reserve（硬下界）
   - 首个任务击穿 reserve → 强制压（进展）
   - **跨层任务**：一个任务含 L4 + L3 成员 → 整任务合并，`members` 含全部非片段 turn（低层成员被吸收）
   - 无 L4 成员的任务不进候选（M5 回归防护）
5. **`DegradeEngine.run`**：L3→L4 写 `startsNewTask`；L4→L5 按任务分组、锚点与 level 同批写入；失败保持 L4 且无锚点。
6. **`renderTurnL3View` / `renderActionLedger`**：L3 视图与旧 L3 渲染逐字一致；任务标记断行；无标记回退描述相等；计数重写仍生效；L5 行尾锚点 ID；无锚点不带 ID。
7. **`searchLedger`**：L5 聚合段与渲染同边界（含两任务描述相同 → 分行）。
8. **`executeRecall`**：L5 → 任务级 L3 视图（含多轮原文，**不含** toolResult）；超预算截断 + offset；无锚点 → 提示文本；`rejected` 字段移除后旧调用方编译通过。
9. **`index.ts`**：`/compress-status` 不再显示「L5 拒绝」；recall 统计口径不变。
10. **零变化防护**：无 `startsNewTask` / 无 `taskAnchorId` 的输入，渲染输出与改动前**逐字节一致**（存量兼容）。

## 11. 实施影响面

| 文件 | 改动 |
|---|---|
| `src/ledger.ts` | `LedgerData` +2 字段；`renderTurnL3View` 抽出；`renderActionLedger` 聚合边界 + 锚点渲染 |
| `src/prompts.ts` | `buildIntentOutcomePrompt` 加 `startsNewTask` + `prevIntent` |
| `src/degrade-llm.ts` | `compressEnds` 返回 + 校验 `startsNewTask` |
| `src/degrade.ts` | 删 `DegradePlan.mergeGroups`；新增 `groupByTask` / `planMergeGroups`；`run` 分两段 + 锚点写入 |
| `src/recall.ts` | L5 任务级召回；删 `rejected`；`RecallDegradeCtx.anchorOf`；`searchLedger` L5 边界 |
| `src/index.ts` | 构造并传 `anchorOf`；`recallStats.rejected` 与 status 行删除 |
| `README.md` | 五级阶梯表（L5 = 任务级）、召回三档（L5 任务级 L3 视图）、删「细节不可恢复」表述 |
| 旧 spec | `2026-09-16-five-level-degrade-design.md` §7 加勘误注记（L5 从「拒绝召回」改为「任务级 L3 视图」） |
| 测试 | `degrade.test.ts`（mergeGroups 断言重写）、`degrade-llm.test.ts`、`ledger`/`recall`/`extension.test.ts` 新增用例 |
