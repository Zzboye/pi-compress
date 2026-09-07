# E2E 报告：窗外替换 + recall 逐字取回（RPC 驱动，真实模型）

日期：2026-09-06　驱动：`e2e/rpc-driver.mjs`（新会话）+ `e2e/rpc-driver2.mjs`（续接会话）
摘要后端：LM Studio `qwen3.8-27b-uncensored@iq4_xs`；备用：HSFZ `deepseek-v4-flash`

## 场景

跨三个 pi 进程续接同一会话（`--session`），验证：

1. 新会话实时摘要 + 动作日志落盘（第一部分，2026-09-06 上午）
2. 重启后 ledger 从 JSONL custom entry 恢复（`rebuildFromEntries`）
3. `keepRecentTokens` 项目级覆盖（`.pi/settings.json: 3000`）把早期 turn 挤出窗口
4. 模型读动作日志真实 ↩ ID → `recall` 取回窗外逐字原文

## 结果

| 检查点 | 结果 |
|---|---|
| 续接恢复 | 已摘要 turn 数续接（2→5→8→11），无重复补摘 |
| 窗外替换 | 最近装配：窗口 7 turns / **替换 4** / 原文放行 0 |
| 动作日志注入 | 窗外 turn 以 `<action-ledger>` 头代表，模型读到真实 8 位 hex ID |
| recall 命中 | 调用 1 次 / 取回 1 条 / 未中 0 个 ID |
| 逐字正确性 | 回答 `version: "0.1.0"` 与文件一致（模型另用 grep 双重验证） |
| 摘要队列 | 每轮 agent_settled 后积压清零，全程降级状态=正常 |

## 发现并修复的缺陷

**recall 丢失工具结果**：`extractToolActions` 把 recall ID 记在含 toolCall 的 assistant 消息上，
但 `executeRecall` 只序列化该条消息 → 只能取回 `[Assistant tool calls]: read(...)`，
不含 `[Tool result]`，答不出"文件内容是什么"。

**修复**（`src/recall.ts`）：序列化含 toolCall 的 assistant 条目时，按 `toolCall.id` ↔
`toolResult.toolCallId` 配对，把结果消息一并传入 `convertToLlm`。

TDD：新增 4 个测试先红后绿；全量 `91 passed / 1 skipped`；e2e 复验命中。

## 备注

- `keepRecentTokens=20000`（全局默认）对小型测试会话永不触发窗外替换——首轮测试因此
  `替换 0` 且模型看不到动作日志、瞎猜 ID 全 miss。项目级覆盖是设计内的正确做法。
- `e2e/rpc-driver2.mjs` 可复用：`node e2e/rpc-driver2.mjs <session-file>`。
