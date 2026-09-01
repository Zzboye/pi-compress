# Recall 使用统计（/compress-status 召回行）设计

日期：2026-08-30　状态：已实现

## 背景与目的

插件的核心闭环是「LLM 需要细节时通过 recall 工具按 ↩ID 取回逐字原文」，但此前没有任何地方能观察 recall 的实际使用频率。召回率是关键健康信号：

- **长期为 0**：LLM 在 20k 窗口内就能拿到所需细节，压缩无副作用（好）。
- **持续偏高**：`keepRecentTokens` 偏小，或动作日志 `detail` 粒度不够，LLM 被迫频繁回调（需要调参）。

## 设计

最小闭环，全部改动集中在 `src/index.ts` 入口的模块闭包状态（与 `degraded`/`lastStats` 同级）：

- **状态**：`recallStats = { calls, hits, missing }`，进程内存态，不落盘（与会话生存期对齐即可，历史统计无回溯价值）。
- **计数点**：`recall` 工具 `execute` 内，在 `executeRecall` 返回后累加——`calls += 1`；`hits += ids.length - missing.length`（单次调用可批量传多个 ID，按条计数）；`missing += missing.length`。
- **重置点**：`session_start`（新会话从零开始，与 `store` 重建同点）。
- **展示点**：`/compress-status` 新增一行：`召回：调用 N 次 / 取回 M 条 / 未中 K 个 ID`。

## 不做的事（YAGNI）

- 不持久化到 session（JSONL 只追加原则下需要新 CustomEntry 类型，无必要）。
- 不区分「截断召回」与「完整召回」（executeRecall 截断在文本内自带提示，计入 hits 即可）。
- 不做成功率阈值告警/自动调参——观察先行。

## 测试

`tests/extension.test.ts` 新增 2 例（先 RED 后 GREEN）：

1. 两次 recall（`["u1","gone"]`、`["u1"]`）后 `/compress-status` 输出含 `调用 2 / 取回 2 条 / 未中 1 个`。
2. `session_start` 重置后统计归零。

harness 顺带捕获 `pi.on` 注册的 handler（原实现仅 `vi.fn()` 记录调用，无法触发事件）。
