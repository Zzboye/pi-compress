# Spec：进行中超大 turn 的溢出摘要（提前进入摘要环节）

日期：2026-09-17
分支：feat/inflight-turn-degrade
状态：定稿待实施

## 1. 背景与动机

一个 turn 从用户消息开始，到 `agent_settled` 才结束。进行中的 turn 未落盘、没有 ledger、降级瀑布管不到它，而 `findWindowTurns` 对单 turn 超预算的处理是整体保留——超大 turn（长任务，多个巨型工具结果）在其存续期间的**每一步 LLM 调用都全额携带全部工具原文**，直到 turn 结束。

代价：
- **token 成本**：50k tok 的工具结果出现后，turn 后续每步都重复付费
- **噪声稀释**：长上下文中部信息召回率下降（lost in the middle），早期工具调用噪声挤占关键上下文的注意力
- 兜底路径不理想：pi 中途压缩是响应式的（涨满才触发），且原生摘要把工具结果糊成叙述，turn 未完成细节就没了

## 2. 核心思路

**零新机制**：把现有摘要管线的作用范围从「已结束的 turn」扩展到「进行中的 turn」。进行中 turn 的原文体积超过 `keepRecentTokens` 后，把**溢出部分（最旧的完整片段）建成正常 ledger 条目**，之后一切照旧：

- 片段条目入摘要队列（前面未摘要的 turn 先入队，FIFO 自然如此）
- 片段落盘后渲染成 ledger 头行（L1 形态），原文侧不再包含
- 降级瀑布对片段与已结束 turn 完全同等待遇：L1 满 → L2 → L3 → …
- recall / search / 降级 / 注入全部免费继承，无任何特殊路径

一句话：**把降级瀑布的时间轴从「turn 结束后」提前到「turn 进行中」**。

## 3. 裁定记录（与用户逐条确认）

| # | 裁定点 | 决定 |
|---|---|---|
| 1 | 阈值 | 复用 `keepRecentTokens`（进行中 turn 不该比窗口预算更大），不加新配置 |
| 2 | 用户消息 | **永不溢出**——它是 turn 的锚，模型正在执行的就是它；溢出只从 user 消息之后的 toolCall→toolResult 对里切 |
| 3 | 片段渲染层级 | L1 起步（刚发生的事信息最全），后续降级瀑布自然逐级压 |
| 4 | 切分边界 | 完整 toolCall→toolResult 对，不拆对 |
| 5 | turn 结束收敛 | 整 turn 摘要落盘 → 队列中片段跑完 → 片段墓碑化；整 turn 从 L1 重新走瀑布 |
| 6 | 执行方式 | 独立分支，先不合并 main |

## 4. 设计细节

### 4.1 触发与切分

在 `context` 事件装配时检查：

```
last = splitIntoTurns(entries) 的最后一个 turn（进行中）
coveredEnd = 该 turn 已被片段覆盖的末 entry id（从 store 推导，见 4.4）
remaining = last 中 coveredEnd 之后的 entries（含 user 消息）
if turnTokens(remaining) > keepRecentTokens:
    overflow 目标 = turnTokens(remaining) - keepRecentTokens
    从 remaining 中 user 消息之后开始，按完整 toolCall→toolResult 对
    累计选取最旧的若干对，直到覆盖 overflow 目标（选到对边界为止）
    → 切出片段 F，冻结（边界永不前移）
    → F 以「伪 turn」入 SummarizerEngine 队列
```

- **冻结语义**：片段切出后边界不变（`enqueue` 按 `startEntryId` 去重，前移边界会被跳过）。继续溢出 → 在上一个片段之后切**下一个顺序片段**（F1、F2…），每个片段首 entry id 稳定
- 片段入队等待现有摘要管线处理，无需新队列或新等待机制

### 4.2 片段条目（LedgerData）

片段就是一等公民 ledger 条目，无新 schema 字段（除 4.5 的墓碑标记）：

- `turnStartEntryId` = 片段首 entry 的 id（≠ turn 的 user 消息 id，天然与整 turn 条目区分）
- `turnEndEntryId` = 片段末 entry 的 id（**推导覆盖范围的依据**，见 4.4）
- `userMessage` = undefined（片段内没有 user 消息），`finalReply` = undefined（turn 未结束）
- `summary.actions` = `extractToolActions(片段 entries)`，quotes 照常保留 → recall 立即可用（顺带解决了此前讨论的「turn 内细节取回」缺口，无需方案 D）

### 4.3 装配（去重视图）

片段进 store 后渲染为 ledger 头行，但窗口逻辑会把进行中 turn 整体保留为原文——原文侧会重复包含片段内容。处理：

- 装配前对**最后一个 turn**应用「裁剪视图」：从其 entries 中去掉已入片段覆盖的前缀（user 消息保留）
- 裁剪视图下重算 `findWindowTurns`，窗口数学自然成立，assembler 窗口逻辑零改动
- ledger 头行照常由 `ledgersInBranchOrder` 产出（片段在 branch 中的位置天然有序）
- dump 与 context 事件同一装配函数，口径自动一致
- recall / search / backfill 不动：仍走全量 branch

### 4.4 覆盖范围推导（无内存状态）

重启会话中途恢复时，从 store 即可重建状态：遍历 store 中 `turnStartEntryId ∈ 当前 turn entry ids` 且 ≠ `turn.startEntryId` 的条目，其 `turnEndEntryId` 的最大值即 coveredEnd。无需会话内存。

### 4.5 turn 结束收敛（墓碑）

`agent_settled`（turn 正常结束）：

1. 照常生成整 turn 摘要（含全部动作行、quotes），key = `turn.startEntryId`，从 L1 起步
2. 识别该 turn 的片段条目（同 4.4 的判定）
3. 队列中还在等待/进行中的片段摘要**让它跑完**（白跑一次但幂等、逻辑简单；竞态窗口小）
4. 对每个片段条目执行**墓碑化**：`set({...fragment, absorbed: true})`

墓碑机制（必须）：session 文件不能删条目，`rebuildFromEntries` 会复活已删除的片段——所以删除实现为终态覆盖：

- `LedgerData` 新增可选字段 `absorbed?: true`
- `rebuildFromEntries` 跳过 absorbed 条目（不出现在 cache）
- 渲染/装配侧防御性过滤（cache 中本不会有，双保险）
- 被墓碑的片段已无增量信息：整 turn 条目的 quotes 覆盖全部原文，且最终回复（结论载体）进了 ledger

### 4.6 收敛的账（为什么接受整 turn 重走 L1）

- 浪费：片段存活期间已发生的降级工作。机械层（L1→L2→L3）零成本重走；真浪费是片段已降到 L4 的那次 `compressEnds`——但片段通常只存活一个 turn 时长，降到 L4 概率很低
- 回升：删除瞬间渲染体积短暂回升（L2/L3 片段行 → L1 全量动作行），下一轮降级瀑布自然压回（机械层免费）
- 换来：store 数据形态统一——一个 turn 一条条目，recall/降级/渲染语义与所有其他 turn 完全一致，无双份动作行

## 5. 边界情况

| 情况 | 行为 |
|---|---|
| 片段摘要失败 | 保持原文放行（与现有失败语义一致）；`failed()` 记录，session_start 补摘机制照常覆盖片段 key |
| turn 结束时片段仍在队列 | 跑完再墓碑（幂等） |
| 重启会话时 turn 仍在进行 | 4.4 推导 coveredEnd，继续切下一片段，无内存依赖 |
| turn 中含图片 | 片段条目走既有图片占位符与 recall 返图链路，无特殊处理 |
| 进行中 turn 从未超阈值 | 零行为变化（不切、不建、不删） |
| 片段与整 turn 条目共存窗口（队列未跑完时） | 渲染短暂重复，墓碑后消失；enqueue 去重保证不重复摘要 |

## 6. 明确不做

- 不做注意力/质量的量化测试（成本侧收益已成立；后续可用 bench 观察摘要调用频次）
- 不裁用户消息、不裁 assistant 推理文本（只切工具对）
- 不为片段引入新配置项、新队列、新等待机制
- 不改 pi 原生压缩的交互（8f5d725 机制原样，超大 turn 涨爆窗口时 pi 中途压缩仍是最终兜底）

## 7. 测试计划（TDD）

1. **切分**：超阈值触发切分；user 消息保留原文侧；对边界不拆对；片段冻结（多次装配不重复切同一片段）；连续溢出切出 F1、F2
2. **摘要与瀑布**：片段入队→落盘→渲染为 L1 行；瀑布对片段与普通 turn 同待遇；失败保持原文
3. **装配去重**：片段渲染为 ledger 行且原文侧不含片段内容；窗口数学正确；无片段时装配逐字节不变（零变化用例）
4. **收敛**：turn 结束 → 整 turn 条目 L1 落盘 → 队列跑完 → 片段墓碑；重启后 rebuild 不复活墓碑；墓碑前共存窗口的渲染
5. **恢复**：重启中途 turn 推导 coveredEnd 继续切分
6. **回归**：`/compress-dump` 同口径（片段行可见）；recall 片段条目返回片段原文

## 8. 实施影响面预估

| 位置 | 改动 |
|---|---|
| `src/util.ts` | 片段切分函数（伪 Turn 构造）+ 覆盖范围推导 |
| `src/ledger.ts` | `LedgerData.absorbed` 字段 + normalize/isValid + 渲染过滤 |
| `src/store.ts` | rebuild 跳过 absorbed |
| `src/index.ts` | context 事件：切分检查 + 裁剪视图 + 入队；agent_settled：收敛墓碑 |
| 测试 | 上述 6 组 |
| README | 已知限制「单 turn 超大整体保留」条目改写 |
