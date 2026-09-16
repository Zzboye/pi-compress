# 五级降级阶梯（L1–L5）— 设计文档

日期：2026-09-16
状态：已评审（用户逐项确认全部裁定）

## 1. 问题

现有 L4 直接把多个 turn 合并成一行描述，压缩跳跃太快：从「有动作过程」一步到「只剩一句话」，中间缺少过渡层。信息取向也不合理——合并时丢掉动作行的同时把用户意图/回复也压没了，而这两端信息在 40k 阈值下往往还没到必须牺牲的程度。

用户目标：**逐级压缩，每级只删一类信息**，压缩曲线顺滑。

## 2. 裁定记录

| # | 决策点 | 裁定 | 理由 |
|---|---|---|---|
| 1 | L4 是否保留回复原文 | **不保留** | 用户本意是逐级压缩；L3 保留两端原文（动作行占渲染体积 90%，是压缩大头），L4 才丢两端原文 |
| 2 | 旧 L4（合并）去向 | **顺延为 L5** | 阶梯最终兜底不可删；合并输入从 L3 渲染变为 L4 渲染，描述质量更高 |
| 3 | 新 L3 内容 | **原文 / 全丢过程 / 原文** | L2→L3 变纯机械降级（0 次 LLM）；`compressEnds` 右移到 L3→L4 |
| 4 | L3/L4 召回粒度 | **turn 级** | 动作行 ID 不再可见，entry 级召回会让被丢的过程变成死数据 |
| 5 | L5 召回 | **拒绝 + 不渲染 IDs** | L5 是终态，「可召回」是假可用性；拒绝文案防止模型连环 recall 巨条 |
| 6 | 阈值配置 | **沿用** | `ledgerDegradeThresholdTokens`（40k）/ `ledgerReserveTokens`（10k）按层检查机制不变，只是每层语义更换 |
| 7 | 存量数据 | **新渲染统一处理，无新旧分支** | 降级从不删 quotes（数据/视图分离不变式），旧 L3/L4 数据天然满足新语义所需字段（见 §5） |

## 3. 五级阶梯定义

| 层级 | 用户侧 | 工具过程 | 回复侧 | 本级删除 | LLM 调用 |
|---|---|---|---|---|---|
| L1 | 原文 | 动作行 target→detail | 原文 | — | — |
| L2 | 原文 | detail（丢 target） | 原文 | 丢命令 | 机械 |
| L3 | 原文 | 全部丢掉 | 原文 | 丢过程 | 机械（0 次，原 compressEnds 在此） |
| L4 | 意图摘要 | — | outcome 摘要 | 丢两端原文 | 1 次（compressEnds 右移至此） |
| L5 | 合并描述 | — | 融入描述 | 丢条目边界 | 1 次（mergeDescribe，输入换 L4 渲染） |

信息删除单调递增：命令 → 过程 → 原文 → 边界。每级渲染语义清晰，无跳跃。

体积依据（T46 实测）：动作行约 5.7k tok（渲染体积 90%+），两端原文合计约 300 tok——L3 砍动作行即完成主要压缩，保留两端原文的体积代价可忽略。

## 4. 渲染形态

```text
L3:
### T12 · 用户：「修复降级排序 bug」
最终回复（原文）：
已修复并推送（commit 6f2b08e）……

L4:
### T12 · 意图：修复降级排序 bug ↩u-id
- 最终回复（摘要）：已修复并推送 ↩r-id

L5（合并行，无 IDs）:
### T12-T15 · 调试降级与 recall 链路（5 条已合并）
```

- L3 复用现有「用户原话行 + 最终回复（原文）」骨架，动作行循环跳过
- L4 复用现有「意图行 + outcome 行」骨架（数据字段 `userIntent`/`outcome` 已由 compressEnds 在 L3→L4 时产出）
- L5 沿用现 L4 合并逻辑：相邻同层条目成组、`mergeDescribe` 生成描述；**行尾不再渲染 ↩IDs**（allRecallIds 不再用于 L5 渲染）
- 图片占位行：L3 继续渲染（L1–L3 同款）；L4 起不渲染（并入摘要描述，与现状一致）

## 5. 存量数据兼容（无需迁移）

关键事实：降级引擎从不删除 quotes——`userMessage.text`、`finalReply.text`、动作 recallIds 在任何 `level` 下都完整保留在数据中（渲染是视图，数据/视图分离是既有不变式）。逐一核对：

- **旧 L3**（intent + 动作行 + outcome）：数据中两端原文仍在 → 新渲染规则直接套用 = 新 L3，零损失
- **旧 L4**（合并组）：组内每条都经过 compressEnds，`userIntent`/`outcome` 均在 → 渲染为逐条新 L4，信息反而变好；丢弃的 `merged.description` 是 L5 产物，下次降级到 L5 时重新生成
- **旧 L1/L2**：语义未变，直接兼容

结论：`renderTurnText` 统一按新阶梯实现，无新旧标记、无混合渲染。

## 6. 降级机制调整（degrade.ts）

- **瀑布右移一层**：L1→L2（机械丢 target，不变）→ L2→L3（机械丢动作行，新）→ L3→L4（compressEnds，右移）→ L4→L5（mergeDescribe，右移）
- `planDegrade` 的 per-level 检查、硬下界、相邻分组合并逻辑结构不变；`mergeGroups` 语义变为「相邻 L4 条目成组」
- `compressEnds` 失败回滚机制不变（回滚到 L3）；`mergeDescribe` 失败保持 L4（原「保持 L3」对应顺延）
- LLM 调用总次数不变：每次降级经过仍是 1 次（原 L2→L3 或 L3→L4 合并，现 L3→L4 或 L4→L5）

## 7. recall 三档语义（recall.ts）

现状缺口：`executeRecallDual` 未接收 ledger 层级信息。需将 `ledgersInBranchOrder` 结果（或 `id → level` 映射）传入。

| 层级 | 可见 ID | recall 行为 |
|---|---|---|
| L1/L2 | 动作行 + 两端 | entry 级（现状不变：toolCall 连带配对 toolResult） |
| L3/L4 | 两端 ID | **turn 级**：`splitIntoTurns` 定位边界 → `serializeForRecall` 整段返回（用户原话、每个 toolCall→toolResult、最终回复） |
| L5 | 无可见 ID | 不可达（行尾无 IDs）；防御：若模型持旧上下文中的旧 ID 召回，返回说明文本「已合并为终态摘要，细节不可恢复」 |

- turn 级召回受 `recallMaxTokensPerEntry` 预算约束（超长截断，提示分页待办 task-002）
- entry 级返回原文量约 2k、turn 级约数 k——按需付费，符合 recall 哲学
- L5 拒绝文案是正向设计：终止模型的召回尝试，防连环巨条挤爆上下文

## 8. 明确不做

- 不做「回复原文超长降为摘要」护栏：L4→L5 兜住极端，多一个阈值多一套口径不值
- 不动 L1/L2 语义与渲染
- 不动 `searchLedger`：搜的是底层全量数据，层级变化不影响其正确性；L4 合并行已验证可命中
  - 实现时勘误：searchLedger 的合并组聚合边界由 4 调整为 5（阶梯右移的必要连带，否则 L5 组描述成为检索死区），匹配机制本身未变。
- 不加新配置项：阈值沿用，无新参数

## 9. 测试计划

- 渲染：L1–L5 每级形态快照（L3 无动作行、L4 意图+outcome、L5 无 IDs）；存量旧 L3/L4 fixture 渲染为新语义
- 降级：瀑布右移后 per-level 触发、硬下界、相邻分组、compressEnds/mergeDescribe 失败回滚到正确层级
- recall：L3/L4 的 ID 触发 turn 级整段返回（含 toolCall→toolResult）；L1/L2 保持 entry 级；L5 防御文案
- 存量：旧 L4 组数据不经过 mergeDescribe 直接渲染为逐条 L4

## 10. 实施顺序建议（TDD，5 任务）

1. 渲染层：renderTurnText 新阶梯 + 存量兼容（先红后绿）
2. 降级层：planDegrade 右移 + 机械 L2→L3 + compressEnds/mergeDescribe 接线
3. recall 层：层级信息传入 + turn 级召回 + L5 防御
4. /compress-status 与统计适配
5. README 同步（阶梯表、召回语义、配置说明）
