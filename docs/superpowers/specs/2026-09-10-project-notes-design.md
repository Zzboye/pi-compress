# 项目记忆（project-notes）设计文档

- 日期：2026-09-10
- 状态：已评审（用户逐项确认）
- 分支：feat/project-notes
- 前置讨论：三表内容与格式、收集链路归属（本地模型 → 执行 LLM 的转向）、召回语义（缺陷一消解）

## 1. 目标与非目标

### 目标

为 pi-compress 增加跨会话项目记忆：插件维护一个项目级记忆文件，把「经验教训、任务决策、用户偏好」沉淀下来，在新会话中注入上下文，并提供召回详情的路径。

### 非目标（本期不做）

- 全局（跨项目）记忆、原因分析文件、跨会话提炼（`/compress-remember global` 预留参数，报「未实现」）
- 后台自动沉淀（笔记判断步骤）——已评审否决，见 §3 决策记录
- 记忆条目的语义检索（notes 条目少，全量注入即可）
- notes.md → notes.json 反向同步（手改 md 不生效，文件头注明）

### 决策记录（评审中定案的转向）

1. **记忆管理者从本地摘要模型改为执行 LLM**：本地模型只看到采样的当轮片段，无法可靠判断任务状态翻转、detail 质量差；执行模型是亲历者，信息完整度是信息论优势。本地小模型退回「历史摘要者」单一职责。
2. **召回对象从「会话原文」改为「notes 条目 detail」**：原方案 recallId 指向旧会话 branch entry，跨会话必 miss（新会话 branch 无旧 entries）。修正后 detail 自含落盘，召回 = 读文件，不依赖旧会话存活性。sessionFile 字段、JSONL 跨会话查找机制整个砍掉。
3. **maxTokens 默认不限制**（0）：文件永不因大小被拒写；防膨胀靠工具 description 的硬门槛 + 去重要求。

## 2. 数据模型

### 存储双轨

```
<项目>/.pi-compress/
  notes.json   ← 结构化真相（机械读写）
  notes.md     ← 渲染视图（人读，与注入内容同构 + ID 前缀）
```

- 单文件三数组：`{ schema: 1, nextId: N, feedback: [], tasks: [], prefs: [] }`
- `schema` 版本号供未来迁移；`nextId` 单调递增计数器，**删除条目后序号不复用**
- 渲染时间戳写在 md 尾部注释；`/compress-status` 显示 notes 路径与上次更新时间（用户可发现手改被覆盖的原因）

### 条目字段

| 字段 | 经验表 | 任务表 | 偏好表 | 说明 |
|---|---|---|---|---|
| `id` | `fb-001` | `task-001` | `pref-001` | recall 查找键，单调分配 |
| `text` | 一句话+状态+日期 | 状态+任务+日期 | 全文 | **注入上下文的唯一内容** |
| `detail` | 方法详情 | 任务+决策+修改的文件+来源 | ❌ | **不注入**，recall 返回的正文，自含（≤200 字：事件+结论+涉及文件） |
| `status` | `有效`/`纠正` | `进行中`/`已完成`/`已否决` | ❌ | |
| `date` | 创建日 | 创建日 | ❌ | 陈旧风险对策（LLM 看到「进行中·09-10」自行判断） |
| `updatedAt` | ✅ | ✅ | ❌ | 新鲜度 |
| `source` | 可选 | 可选 | ❌ | 溯源标注（日期 + 会话 turn 描述），只展示不保证可召回 |
| `locked` | ❌ | ❌ | ✅ | 用户命令写入的偏好=true，LLM 不可改删 |
| `files` | ❌ | ✅ | ❌ | 任务改动的文件列表（在 detail 内） |

- 三表顺序（注入与视图一致）：**用户偏好 → 经验表 → 任务决策表**
- 偏好表无 detail/recall 尾巴，全量注入；另两表注入 text 摘要行

## 3. notes 工具（执行 LLM 主动维护）

单工具多操作（Letta memory command 模式）：

```
notes({ action: "append", table: "feedback"|"tasks"|"prefs",
        text, detail?, status?, source? })    → 分配新 ID 落盘
notes({ action: "update", id: "task-001",
        status?/text?/detail? })              → 定点更新（任务状态翻转主路径）
notes({ action: "delete", id: "fb-003" })     → 删除
```

### 权限边界

- **偏好表 append-only（对 LLM）**：用户命令写入的条目 `locked=true`，LLM 的 update/delete 对 locked 条目返回错误文本
- LLM 可 update/delete 自己写入的经验与任务条目
- 校验失败（格式/字段缺失/ID 不存在/locked）返回错误文本给 LLM，由它自行重试——比后台静默丢弃可控

### 防滥用（写入门槛）

工具 description 写明：「仅当出现**被用户明确纠正的做法、新任务或任务状态变化、新的稳定偏好**时调用；与现有条目语义重复时用 update 合并而非 append；不要记录可从代码库推导的内容（架构、文件路径）」。注入的记忆块尾部加引导行：「有新经验或任务状态变化时，用 notes 工具更新本记忆」。

### 写路径

- 插件内单队列串行（mutex）：notes 工具调用与 `/compress-remember` 命令共用电此队列，后到后执行，无并发写损坏
- 机械执行 JSON 指令 → 写 notes.json → 重新渲染 notes.md
- 写失败（磁盘等）：返回错误文本；不影响对话主链路

## 4. 注入（装配）

```
assembleContext() 输出的 messages：
  [0] renderNotes(notes)      ← 新增：项目记忆块
  [1] renderActionLedger(...) ← 动作日志头（现状不变）
  [2..] passthrough → 窗口原文
```

渲染形态：

```
【项目记忆】（跨会话沉淀；详情可按 ↩ID 召回，有新经验或任务状态变化时用 notes 工具更新）
◈ 用户偏好：
- commit message 用中文
- subagent 派发前先给 brief
◈ 经验表：
- 用 git apply --cached 精确暂存 hunk，避免混入其他工作线改动 [有效·2026-09-10] ↩fb-001
◈ 任务决策表：
- [进行中·2026-09-10] 项目记忆三表设计 ↩task-002
```

- **条件装配**：文件不存在/三表全空/enabled=false → 不注入（空块烧 token）
- **maxTokens**（默认 0 不限制）：设正数时按 CJK 口径截断**注入块**，顺序「偏好 → 进行中任务 → 最近经验 → 其余」，截断尾注「…（已截断 N 条，详情可召回或查看 notes 文件）」；文件本身永不截断
- **cache 友好性**：notes 只在 LLM 调用 notes 工具后变化，单次回答内多次 context 重算之间稳定；跨轮变更的 cache 代价接受（ledger 头本身持续变化，notes 非首要变量），「移到上下文尾部」记为 bench 后备选优化

## 5. 召回（recall 双源）

```
recall({ ids: ["fb-001"] })   → notes 注册表命中 → 返回该条目 detail（含任务+决策+文件+来源）
recall({ ids: ["↩t42-u"] })   → 未命中 notes → 现有 branch 查找路径（动作日志原文，不变）
```

- 前缀命名空间天然隔离（`fb-/task-/pref-` vs pi entry ID）；查找顺序 notes 优先
- ID 解析宽松：`fb-001` 与 `↩fb-001` 均接受（与现有 entry ID 容错一致）
- missing 文案分叉：notes ID 捞不到（文件损坏）→「该记忆条目详情不可用」；branch ID → 现有「不在当前分支」文案
- 统计：recallStats 增加 notes 召回计数，/compress-status 同步展示

## 6. 用户命令

```
/compress-remember <内容> [global]
```

- 本期仅 project：内容直接 append 进对应表（不经模型，用户写什么记什么），写入条目 `locked=true`
- 表归属：命令不指定时默认 prefs；带 `global` 参数 → 回复「全局记忆未实现」（预留）
- 与 notes 工具共用写队列

## 7. 配置

```jsonc
"contextCompress": {
  "projectNotes": {
    "enabled": false,                     // 跨会话注入开关（默认关）；收集（工具调用）不受影响
    "path": ".pi-compress/notes.json",    // 相对项目根；notes.md 同目录自动生成
    "maxTokens": 0                        // 注入块预算，0=不限；文件大小永不限制
  }
}
```

- `enabled=false` 语义：**只关装配注入，LLM 仍可调用 notes 工具写记忆**（数据持续积累，随时开启）
- `.gitignore`：插件在写入 notes 时若项目 .gitignore 未含该路径则**不自动添加**，README 说明利弊由用户决定（偏好可能含个人信息 vs 项目事实可团队共享）

## 8. 与现有系统的关系

- **本地摘要模型**：职责不变（动作日志摘要），不再参与记忆
- **动作日志（ledger）**：notes 块位于其前，互不嵌套；ledger 的 ↩entryId 与 notes 的 ↩fb-* 共存于上下文
- **CJK 计量**：maxTokens 截断口径复用 `countTokensText`
- **/compress-status**：新增 notes 行（开关/条目数/上次更新/召回计数）

## 9. 测试策略

- **notes 工具**：append 分配单调 ID（删后不复用）、update 状态翻转、delete、locked 拒改、校验失败错误文本、写队列串行
- **渲染**：三表顺序、条件装配（空/关/全空）、maxTokens 截断顺序与尾注、schema 兼容（旧文件缺字段容错）
- **recall 双源**：notes 命中/branch 兜底/missing 文案分叉/宽松 ID 解析
- **命令**：直写 locked 条目、global 提示
- **e2e**：会话 A 写记忆 → 会话 B 注入 + 召回 detail（跨会话核心场景）

## 10. 已知限制

- LLM 可能忘调 notes 工具（缓解：工具 description 硬门槛 + 注入块引导行；接受不完美，Claude Code 同策略）
- 手改 notes.md 会被覆盖（文件头注明）
- 多会话并发写为后到后执行（单队列保证不损坏，不合并语义）
- notesQueue 跨 session_start 竞态：写操作若恰好横跨 session_start（如 /tree 回退、会话重载），新 notesStore 的内存副本可能短暂落后于磁盘最终状态（队列保证写本身串行不丢失，下次写操作后自愈）；概率极低，接受轻量陈旧
