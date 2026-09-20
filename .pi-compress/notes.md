# 项目记忆（pi-compress 自动维护）

> 本文件由 notes.json 渲染生成，手工修改不会生效；要修改内容请在对话中使用 notes 工具或 /compress-remember 命令。

## 用户偏好
（空）

## 经验表
（空）

## 任务决策表
- Codex 外部审查四个 P1 + 一个 P3 全部修复完成：降级恢复、动作 id 匹配、recall 全量序列化、compaction 感知装配（8f5d725）+ P3 计数重写（89ebfca） ↩task-001
- recall 分页 + 截断口径修正：offset 参数（单 ID 生效）+ truncateToTokens 二分按 token 截断（取代字符×4）；已随 fix 分支合入 main（ddf6360+fab5831） [已完成·2026-09-15] ↩task-002
- 图片透传观察（等真实含图 turn）+ 三项锦上添花（cache 量化 / LLM-judge / 图片常量）；status 钳制透明化已完成（c505e21）；全局记忆已移交新项目，不在 pi-compress 实现 [已完成·2026-09-15] ↩task-003
- 五级降级阶梯（L1–L5）实现完成：SDD 5 任务全绿（267 passed），final review 可合并，等用户选合并方式 [已完成·2026-09-16] ↩task-004
- 五级阶梯遗留 Minor：M3/M4/M9/P3 已修（b42b03a/ff9809e/89ebfca）；M7 已随 task-007 的 planAssembly 抽出解决；M5 实证存在但极苛刻维持观察；M6/M8 待顺手 [待办·2026-09-17] ↩task-005
- 新开独立项目做含全局记忆的插件（全局记忆从 pi-compress 移出） [规划中·2026-09-20] ↩task-006
- 全项目审查四项发现（recall 截断口径 / 片段降级落 L3 / T 编号错位 / 工程卫生）已全部修复，随 fix 分支合入 main [已完成·2026-09-20] ↩task-007

<!-- 渲染时间：2026-09-20T18:03:17.111Z -->
