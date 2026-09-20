# 项目记忆（pi-compress 自动维护）

> 本文件由 notes.json 渲染生成，手工修改不会生效；要修改内容请在对话中使用 notes 工具或 /compress-remember 命令。

## 用户偏好
（空）

## 经验表
（空）

## 任务决策表
- Codex 外部审查四个 P1 + 一个 P3 全部修复完成：降级恢复、动作 id 匹配、recall 全量序列化、compaction 感知装配（8f5d725）+ P3 计数重写（89ebfca） ↩task-001
- recall 分页（B 方案）：offset 参数，单 ID 时生效 [待办·2026-09-15] ↩task-002
- 图片透传观察（等真实含图 turn）+ 四项锦上添花（cache 量化 / status 钳制透明化 / LLM-judge / 图片常量）；全局记忆已移交新项目，不在 pi-compress 实现 [已完成·2026-09-15] ↩task-003
- 五级降级阶梯（L1–L5）实现完成：SDD 5 任务全绿（267 passed），final review 可合并，等用户选合并方式 [已完成·2026-09-16] ↩task-004
- 五级阶梯遗留 Minor 清单：M4 已修（ff9809e）；M3+M9 已修（b42b03a）；P3 计数重写已修（89ebfca）；M5 实证存在但极苛刻维持观察；M7 挂 task-002；M6/M8 顺手 [待办·2026-09-17] ↩task-005
- 新开独立项目做含全局记忆的插件（全局记忆从 pi-compress 移出） [规划中·2026-09-20] ↩task-006

<!-- 渲染时间：2026-09-20T09:15:02.999Z -->
