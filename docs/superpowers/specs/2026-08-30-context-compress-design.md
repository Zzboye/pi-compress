# pi-agent Context Compress 插件设计文档

- 日期：2026-08-30
- 状态：已确认（设计四节均经用户逐节确认）
- 目标：为 pi coding agent 编写一个用户无感的上下文压缩管理扩展

## 1. 概述

### 1.1 目标与定位

一个完全接管 pi 上下文管理的扩展插件。主 LLM 回答结束后，由本地小模型在后台对刚结束的 turn 做增量摘要，形成"动作日志（action ledger）"；历史上下文在每轮请求前被动态替换为动作日志 + 最近 20k tokens 原文窗口；LLM 需要细节时通过 recall 工具按 entry ID 取回原始消息。

核心承诺：

1. **用户无感**——前台路径（提问→LLM 开始回答）永不因插件变慢，除非撞上 76% 强制点
2. **原文永不丢失**——session 文件只追加、不改写；所有细节可 recall 取回
3. **永不卡死**——本地模型故障时重试自愈，最终降级到 pi 原生压缩兜底

### 1.2 与百万上下文的关系

百万窗口负责"单次任务吞吐"（一次读 50 个文件做重构），插件负责"历史记得住"（注意力不随窗口等比扩展、成本非线性、prefill 延迟）。原文窗口（20k）保短期工作记忆，动作日志保长期脉络，百万窗口余量留给当前任务。目标用户是长 session（几十轮、数小时）的重度用户。

### 1.3 已确认的关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 摘要后端 | 方式一：复用 pi 模型注册表（`ctx.modelRegistry.find/complete`），另支持 OpenAI 兼容直连作为可选 | 零依赖、复用 pi 连接管理；模型用户自备（Ollama/LM Studio/云端便宜 API） |
| 上下文接管路径 | 路径一：`context` 事件动态替换，session 文件不写入 compaction entry | 原文可"解冻"、插件装卸自由、每轮动态决定边界 |
| 原文窗口 | 20k tokens 按 token 滚动（可配） | token 是真实约束维度；细节可 recall，窗口只承担进行中工作的 grounding |
| 摘要节奏 | 每 turn 增量（`agent_settled` 后台异步），恒定小工作量 | 无积压补课；76% 强制点到来时不会撞上大额补摘 |
| 强制点 | 上下文 > 76% 时暂停新请求等摘要积压清空 | 用户与插件之间唯一的同步点 |
| 故障降级 | 重试队列 + 告警；76% 时清不完积压才降级 pi 原生压缩 | 日常故障自愈无感，撞墙时刻有兜底 |
| 摘要形态 | 动作日志：结构化、逐字字段、按工作阶段分组、内嵌 entry ID | 防失真是正确性命脉；ID 精确取回免向量检索 |
| recall | 显式工具，按 entry ID 批量取回 | 纯查找零模型调用；LLM 看到 `↩ID` 标记即知道可 recall |
| 摘要粒度 | 按工作阶段分组（连续同文件操作/思考-行动-验证节拍合并） | 可读性最好，recall 范围对齐自然工作单元 |

### 1.4 注意力机制依据

- U 型注意力：动作日志置顶拿 primacy，原文窗口在尾拿 recency，中间弱区自然空置
- 注意力稀释：旧工具输出（token 多、相关性低）是最大噪声源，压成动作摘要收益最大
- grounding：LLM 对"刚才发生了什么"需要逐字依据，全摘要化会导致幻觉 + 频繁回调
- pi 硬约束：tool result 必须与 tool call 成对，压缩以整块替换实现（工具调用+结果 → 合成 assistant 文本）

## 2. 整体架构

```
┌─ pi 进程 ──────────────────────────────────────────────────────┐
│  用户提问 ──► before_agent_start                                │
│                 ▼                                               │
│  ┌─ 上下文装配器 (Assembler) ─────────────────────────────┐    │
│  │  context 事件：                                        │    │
│  │  1. 读 session 分支取全部消息                          │    │
│  │  2. 从尾部往前 20k tokens → 原文窗口（回退到 turn 边界）│    │
│  │  3. 窗口外 turn 查摘要缓存：有则替换，无则原文照发      │    │
│  │  4. 头部插入渲染后的「动作日志」                        │    │
│  │  5. 76% 强制点检查（唯一的 await）                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                 ▼                                               │
│  主 LLM 请求 ──► 回答（可调 recall 工具）                      │
│                 ▼                                               │
│  agent_settled ──► 摘要任务入队（异步，不阻塞）                │
│  ┌─ 摘要引擎 (Summarizer) ────────────────────────────────┐    │
│  │  串行 worker：serialize 单 turn → 本地模型 → 校验      │    │
│  │  失败 → 重试队列（指数退避）→ 仍败标记 unsummarized    │    │
│  │  成功 → CustomEntry 落盘 + 内存缓存                    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                                 │
│  76% 强制点：占用超限且队列积压 → 阻塞等队列清空（进度显示）    │
│  等待超时 → 降级 pi 原生压缩兜底 → 恢复后自动接管              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 四组件单一职责

1. **上下文装配器（assembler.ts）**——`context` 事件触发，纯内存消息重组（<10ms），不调模型、无副作用。输出即 LLM 看到的上下文。永不因缺摘要阻塞：缺摘要的 turn 原文照发。
2. **摘要引擎（summarizer.ts）**——后台单线程 worker。`agent_settled` 后将刚结束的完整 turn 入队；串行处理；失败指数退避重试。
3. **recall 工具（recall.ts）**——`registerTool` 注册，按 entry ID 批量取回原始消息，纯查找。
4. **强制点协调器（forcepoint.ts）**——读 `ctx.getContextUsage()`，决定放行/等待/降级。

### 2.2 两条数据流

- **写路径（后台）**：turn 结束 → 入队 → 摘要 → CustomEntry 持久化 + 内存缓存。session 只追加。
- **读路径（前台）**：context 事件 → 装配器（纯读缓存）→ 重组 → LLM。前台路径唯一等待是 76% 强制点。

### 2.3 后台运行的含义

插件非独立进程，是 pi 进程内的异步模块。`await fetch(ollama)` 期间主循环自由，UI/LLM 请求照常。用户连发消息时队列削峰串行消化；`agent_settled` 只在整个 run 沉淀后触发（steering/followUp 不产生半截 turn 摘要）。

## 3. 数据结构与存储

### 3.1 真相源：session 文件（只追加）

插件追加一种 CustomEntry（不进 LLM 上下文，pi 忽略）：

```json
{
  "type": "custom",
  "customType": "context-compress:ledger",
  "data": {
    "turnStartEntryId": "e001",
    "turnEndEntryId": "e018",
    "summary": {
      "userIntent": "用户要求修复内存泄漏",
      "outcome": "定位到 hooks.ts:34 清理函数缺失，已修复",
      "groups": [
        {
          "phase": "investigate",   // investigate|fix|verify|discuss|other
          "entries": [
            {
              "action": "read",
              "target": "src/hooks.ts",       // 逐字字段，机械提取
              "detail": "发现 useEffect 清理函数缺失",  // 小模型转述
              "recallIds": ["e003", "e005"]   // 指向原始消息 entry
            }
          ]
        }
      ]
    }
  }
}
```

要点：

- **`target` 逐字零失真**：从工具调用参数（`path`/`command`）直接复制，不经过小模型。小模型只负责 `detail` 转述与分组
- **`recallIds` 双向锚定**：指向原始消息 entry（非 ledger entry）
- **插件禁用/卸载后 session 完好如初**（CustomEntry 不进上下文），无感装卸

### 3.2 内存缓存

`Map<turnKey, LedgerEntryData>`，`turnKey = turnStartEntryId`。`session_start` 时从分支 CustomEntry 重建（`customType === "context-compress:ledger"`）；摘要完成时双写缓存与 session 文件；装配器只读缓存。

### 3.3 动作日志（LLM 看到的形态）

装配器将所有已摘要 turn 渲染为一段 markdown，作为**一条合成消息**插在系统提示之后、原文窗口之前：

```markdown
<action-ledger>
## 会话历史（动作日志，细节已压缩）

### T3 · 用户意图：修复内存泄漏
- 调查：read src/hooks.ts → 发现 useEffect 清理函数缺失 ↩e003
- 修复：edit src/hooks.ts:34 → 补上清理函数 ↩e012
- 验证：bash npm test → 3 passed ↩e012

（需要逐字原文时调用 recall 工具并传入 ↩ 后的 ID）
</action-ledger>
```

`↩e003` 内嵌日志是 recall 可发现性的机制化方案——LLM "知道自己不知道什么"。

### 3.4 配置（`~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）

```json
{
  "contextCompress": {
    "summarizer": { "provider": "ollama", "model": "qwen3:8b" },
    "verbatimCheck": true,
    "keepRecentTokens": 20000,
    "forceRatio": 0.76,
    "retry": { "maxAttempts": 3, "backoffMs": 2000 },
    "ledgerDegradeThresholdTokens": 40000,
    "ledgerReserveTokens": 10000
  }
}
```

模型选型建议（文档推荐不强制）：4B–8B 足够（摘要低难度）；硬要求指令遵循稳定（Qwen 系最佳）；中英混合选支持中文的模型。

方式二（可选）：不经 pi 模型注册表，直连 OpenAI 兼容端点，适合不想把摘要模型注册进主列表、或用云端便宜 API 后备：

```json
{
  "contextCompress": {
    "summarizer": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen3:8b",
      "apiKey": "ollama"
    }
  }
}
```

## 4. 核心流程与边界情况

### 4.1 正常轮次

摘要：`agent_settled` → 确定 turn 范围（上个用户消息到叶子）→ 入队 → worker 串行处理 → 机械校验 → 双写。用户无感。

装配：`context` 事件 → 取分支消息 → 尾部累计 token 到 20k 定窗口（回退 turn 边界）→ 窗口外有摘要的 turn 收集 ledger、无摘要的原文照发 → 头部插入 action-ledger → 返回 messages。

**关键不变量：装配器永不因缺摘要而阻塞或失败。**

### 4.2 76% 强制点

`usage.tokens > forceRatio × contextWindow` 时：

- 队列空 → 直接放行
- 队列积压 → `await` 清空（`ctx.ui.setStatus` 显示"压缩中 N/M turns"）
- 等待超时（默认 120s 可配）→ 降级：本轮不注入 ledger，上下文自然增长直到 pi 原生 auto-compaction 接管；告警用户；队列清空后自动恢复接管

降级握手机制：`session_before_compact` 中检查自身健康（缓存是否覆盖应摘 turn）。健康 → 用已有 ledger 合成自定义摘要（主模型零成本）；不健康 → 返回 undefined 让 pi 原生压缩照常。

### 4.3 recall 调用

```
recall(ids: ["e003", "e012"])
→ 按 ID 从 session 分支查原始消息
→ 找到：serialize 合并返回（标注「e003 的原文：…」）
→ 未找到（/tree 回退后不在当前分支）：友好报错 + 相邻 turn 边界提示
→ 单条超 4k tokens 截断（可配），提示可分段 recall
```

recall 结果作为普通 tool result 进入上下文，后续同样被摘要（闭环）。

### 4.4 边界情况

| 情况 | 处理 |
|---|---|
| 单 turn 超 20k | 窗口边界回退到 turn 边界（tool call/result 不可拆），该 turn 整体原文，实际窗口暂 >20k |
| /tree 回退 | 缓存按 turnKey 索引复用；未摘过原文照发；他分支条目不渲染 |
| /fork /resume /new | shutdown 清内存 → start 从 CustomEntry 重建 |
| steering/followUp 连发 | agent_settled 对齐完整 turn，无竞态 |
| 模型 JSON 解析失败 | 严格结构化 prompt 重试；仍败标记 unsummarized，原文保留，告警 |
| 并行工具调用 | turn 内按原序合并为一组动作条目，recallIds 各自指向 |
| resume 巨型 session（开局即超 76%） | session_start 后立即补摘（最早 turn 优先），期间走强制点等待 |
| /reload 热重载 | 状态从 CustomEntry 重建；丢失的排队任务由"应摘未摘"diff 补齐 |
| 用户手动 /compact | 健康则 ledger 合成摘要（主模型零成本）；不健康则 pi 原生照常 |

### 4.5 摘要 prompt 骨架

```
你是编码会话的动作记录员。将这一轮对话压缩为结构化动作日志。
规则：
1. target 字段必须从原文逐字复制（工具调用的 path/command 参数）
2. detail 一句话，写结论不写过程
3. 每个动作标注对应的 recallIds
4. 按 phase 分组（investigate/fix/verify/discuss/other）
5. thinking 内容不摘要，直接忽略
输出 JSON（schema 固定）
```

thinking 丢弃、动作保留、结论保留——思考是过程性噪声，其结论已体现在动作与回答文本中。

## 5. 测试策略与实现切分

### 5.1 四层测试

1. **纯函数单测**：装配器输出形状（窗口边界/ledger 位置/未摘 turn 保留/配对完整）、token 估算、降级三分支、逐字校验器（中英混合/转义/近似路径）、ledger 渲染
2. **状态机测试（模拟时钟）**：队列入队/串行/退避重试/unsummarized；76% 等待与放行；生命周期重建与补摘 diff
3. **集成测试（mock 模型注入延迟/失败/畸形输出）**：失败→保留→重摘→替换全链路；降级与恢复；recall 取回与跨分支报错
4. **真实模型冒烟（手动）**：Ollama + qwen3:8b 跑 20 轮真实对话，人工审阅摘要；埋点指标：recall 次数、失真率（校验器标红比例）、强制点频率、等待时长——数据决定 v2 调参

### 5.2 实现切分（依赖序，每步独立验收）

```
Phase 1  地基：配置加载 + session 钩子 + CustomEntry 读写 + 缓存重建
Phase 2  装配器：context 事件 + token 窗口 + ledger 渲染（手工假摘要）
         验收：/compress-status 显示窗口边界与替换效果
Phase 3  摘要引擎：队列 + worker + 重试 + 逐字校验 + prompt
         验收：真实模型跑通单 turn → CustomEntry 落盘
Phase 4  recall 工具 + 76% 强制点 + 降级握手
         验收：第三层集成测试全绿
Phase 5  打磨：/compress-status 面板、设置文档、真实模型校准
```

### 5.3 文件结构（`~/.pi/agent/extensions/context-compress/`，目录式扩展）

```
context-compress/
├── index.ts          # 入口：注册事件/工具/命令
├── config.ts         # 配置加载与校验（含模型解析）
├── assembler.ts      # 上下文装配器（纯函数核心）
├── summarizer.ts     # 摘要引擎：队列/worker/重试
├── ledger.ts         # ActionLedger 结构 + 渲染 + 逐字校验
├── recall.ts         # recall 工具
├── forcepoint.ts     # 76% 强制点 + 降级协调
├── store.ts          # CustomEntry 读写 + 内存缓存
├── prompts.ts        # 摘要 prompt 模板
└── package.json      # pi 扩展入口（零第三方依赖）
```

零 npm 依赖：模型调用/序列化/token 估算全用 pi 内置（`ExtensionAPI`/`ctx.modelRegistry`/`serializeConversation`/`convertToLlm`）。

### 5.4 v1 刻意不做

- ledger 旧条目自动合并（配置占位，等真实数据定策略）
- 向量检索 recall（按 ID 已够用）
- 多 provider 负载均衡
- RPC/print 模式特殊处理（TUI 优先，其他模式不破坏即可）

## 6. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 小模型摘要失真导致 LLM 错误决策 | 致命 | 逐字字段机械提取 + `verbatimCheck` 机械校验（target 不在原文出现即标红/重摘） |
| LLM 不勤调 recall | 中 | `↩ID` 内嵌日志 + 必要时系统提示引导（prompt 工程） |
| 20k 窗口偏小 | 中 | 可配 + `/compress-status` 埋点数据校准 |
| 76% 等待体验差 | 低 | 超时可配 + 进度显示 |
| 两套压缩切换上下文形状突变 | 低 | 健康握手自然过渡，不硬拼 |

预期：机制层好用概率高（80%+），体验层需 1–2 轮迭代。v1 目标"能用且省心"，v2 目标"离不开"。
