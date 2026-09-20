# bench/fixtures

bench 的**输入数据**（与 `e2e/reports/` 的产物相反——那些是运行输出，已 gitignore）。

## 2026-09-05-current-context-dump.md（87KB）

一次真实 `/compress-dump` 的快照（会话文件、生成时间等元信息见文件头）。用作
`bench/real-model-e2e.test.ts` 的巨型读取输入：它足够大（≈22k tok），单条就能把
`keepRecentTokens` 窗口撑破，从而复现「巨型 toolResult → 窗外 turn → 动作日志替换」
的装配场景。

**为什么放在版本控制里**：它是 bench 的输入而非输出。放在 `e2e/reports/`（已
gitignore）会导致新克隆/CI 上 bench 因缺文件而失败——bench 的输入必须随仓库走。

**来源**：`/compress-dump` 于 2026-09-05 在 pi-compress 自身会话上生成；内容为当时
的上下文装配结果（ledger 头 + 窗口原文 + 统计）。原路径
`e2e/reports/2026-09-05-current-context-dump.md`，2026-09-21 迁至此处。
