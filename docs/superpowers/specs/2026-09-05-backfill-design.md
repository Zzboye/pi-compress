# 未摘要 turn 补摘队列（backfill）设计

日期：2026-09-05　状态：已实现

## 背景

插件 v1 只在 `agent_settled` 对**最新** turn 摘要：会话恢复（重启 pi、崩溃恢复、/tree 切分支）后，历史上未摘要的 turn 永远没有 ledger。后果：

- 装配器对这些 turn 只能原文放行（passthrough）→ 压缩率虚低
- 缺口随会话寿命累积（此前体检发现 22 turn 仅 9 个有摘要，覆盖率 41%）

## 设计

**触发点**：`session_start`——store 重建 + engine 创建之后，扫描当前分支：

```
turns = splitIntoTurns(branch)
todo = computeBackfillTurns(turns, store, config.backfillLimit)   // 新纯函数
for (t of todo) engine.enqueue(t)
if (todo.length) notify(`补摘 ${todo.length} 个未摘要 turn`)
```

**排序**：最旧优先——最旧的 turn 先退出 `keepRecentTokens` 窗口、最先被装配器需要 ledger；新增 turn 的正常摘要由 `agent_settled` 继续负责。

**上限**：新配置项 `backfillLimit`（默认 20，范围 0–100000，超范围回退默认，0=关闭）。防止恢复超大历史会话时雪崩（数百 turn 连续打满本地摘要模型、挤占 76% 强制点的 waitIdle 预算）。

**与失败路径的交互**：engine 新建于每次 session_start，`failedTurns` 为空 → 补摘天然给上一进程周期里摘要失败的 turn 第二次机会（后端恢复后 resume 会话即自愈）。补摘 turn 再失败仍走原路径（重试→failedTurns→warning toast→原文放行）。

**双入队防护**：session_start 时队列为空（engine 刚新建），补摘集合与后续 agent_settled 的新 turn 集合不重叠，无需额外去重。

## 不做的事（YAGNI）

- 不做窗口感知过滤（跳过当前 20k 窗口内的 turn）：省不了几个本地调用，反而留下"未来退出窗口时无 ledger"的缺口
- 不做 context 事件中的动态补摘触发：v1 只在 session_start 补，缺口有限时足够
- 不做失败 warning 聚合：toast 数量受 backfillLimit 天然上限约束

## 测试（TDD）

1. `config.test.ts`：backfillLimit 默认 20 / 接受自定义 / 0 / 超范围回退（对齐 num() 既有约定）
2. `backfill.test.ts`（新，纯函数）：只返回无 ledger 的 turn 且保序、上限截断保最旧、limit=0 空、全摘要空、无 turn 空
3. `extension.test.ts`（接线集成）：临时目录项目级 settings 钉住不可达后端（`127.0.0.1:9`，maxAttempts:1 快速失败）→ session_start → 断言「补摘 3 个未摘要 turn」notify + 引擎真实发起 3 次失败 warning
