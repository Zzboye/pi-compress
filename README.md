# pi-context-compress

一个 [pi](https://github.com/badlogic/pi-mono) 扩展，**接管 pi 的上下文管理**：用本地小模型在每轮回答之后**异步**压缩对话历史，把旧 turn 整理成动作日志；LLM 需要细节时用内置的 **recall 工具**按 ID 取回逐字原文。

对用户无感——不打断回答流，仅在上下文逼近上限的强制点才可能短暂等待。

## 为什么需要它

长会话中对话历史会吃满上下文窗口，pi 原生 auto-compaction 只能做一次性的全文总结，历史细节就此丢失。本插件换一种思路：

- **结论保新鲜**：最终回复由系统机械逐字保留在日志头部（primacy），不经摘要模型转述
- **近期保时序**：默认最近 20k tokens 的 turn 原文保留在窗口尾部（recency）
- **细节按需取回**：窗外的工具调用、用户原话、最终回复都落盘为动作日志，LLM 传 `↩entryId` 即可召回逐字原文——**零模型调用**

摘要模型只负责整理「思考与工具调用 → 动作摘要」，且模型生成的自由文本字段为零：思考内容直接丢弃（过程噪声），工具调用的 target/路径逐字保留，用户原话与最终回复由系统机械提取。

## 工作原理

```
用户提问 ──────────────────────→ LLM 回答展示（不阻塞）
                  │ agent_settled 事件
                  ▼
        本地模型后台摘要（异步）  ── 失败 → 重试队列（指数退避）
                  │ onLedger              │ 溢出/重试耗尽 → 备用大模型接管（若配置）
                  │ 持续失败 → 保留原文（passthrough）
                  ▼
        动作日志落盘（CustomEntry，不进 LLM 上下文，↩entryId 标记可召回）
                  │ 下次 context 事件
                  ▼
   ┌─────────────── 窗外旧 turn → 动作日志头（用户原话 + 工具动作 + 最终回复原文，细节 ↩ID 可召回）
   │                 窗内近 turn → 原文保留（默认 20k tokens）
   │                  │ 上下文 ≥ 76%（forceRatio）
   │                  ▼
   │              强制点：等摘要队列清空（≤120s）→ 重组
   │                       超时 → 降级，交 pi 原生 auto-compaction 兜底
   │
   └─→ LLM 需要某条细节 → recall 工具，传入 ↩ 后的 ID → 取回逐字原文（单条截断 4k tokens）
```

## 安装

```bash
git clone <this-repo> /path/to/pi-compress
cd /path/to/pi-compress
npm install            # 安装类型与运行时依赖
```

把目录链接到 pi 的扩展目录（pi 读取 `package.json` 的 `pi.extensions` 字段，直接加载 `./src/index.ts`，无需构建）：

```bash
# Unix（macOS/Linux）
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-compress ~/.pi/agent/extensions/context-compress

# Windows（管理员 cmd）
mklink /J "C:\Users\You\.pi\agent\extensions\context-compress" "D:\Pi\pi-compress"
```

配置写入 pi 的 settings.json（见下节），重启 pi 生效。**不配置 `summarizer` 时插件静默观察不接管**——`/compress-status` 显示「未配置」。

## 配置

在 `~/.pi/agent/settings.json`（全局）或项目根 `.pi/settings.json`（项目级，覆盖全局）的 `contextCompress` 字段配置：

```jsonc
{
  "contextCompress": {
    // 方式一：复用 pi 模型注册表（推荐——与主模型统一管理）
    "summarizer": { "provider": "ollama", "model": "qwen3:8b" },

    // 方式二：OpenAI 兼容直连（baseUrl 指向本地/远端兼容端点）
    // "summarizer": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" },

    // 备用后端（可选）：主后端装不下（prompt 超出主模型上下文）或重试耗尽时接管。
    // 典型配置：主用本地小模型，备用配大上下文模型（本地大模型或云端 API）。
    // "summarizerFallback": { "provider": "HSFZ", "model": "glm-5.3-flash" },

    "verbatimCheck": true,
    "keepRecentTokens": 20000,
    "forceRatio": 0.76,
    "retry": { "maxAttempts": 3, "backoffMs": 2000 },
    "ledgerDegradeThresholdTokens": 40000,
    "ledgerReserveTokens": 10000
  }
}
```

### 配置项

| 字段 | 默认值 | 范围 | 说明 |
|---|---|---|---|
| `summarizer` | `undefined` | — | 摘要后端。`undefined` = 插件只观察不压缩。`{provider,model}` 用 pi 注册表；`{baseUrl,model[,apiKey]}` 用 OpenAI 兼容直连 |
| `summarizerFallback` | `undefined` | — | 备用摘要后端，形态与 `summarizer` 相同。主后端报**上下文溢出类错误**（HTTP 400/413、exceeds context 等，即 turn 太大主模型装不下）时**立即切换**（不烧退避重试）；其他错误重试耗尽后也转备用。备用也失败才标记 unsummarized（原文照发）。**选型注意：必须选大窗口且可关闭思考的模型**——强制思考型模型（如 ark 上的 glm-5.3-flash）的思考会吃满 `maxTokens` 输出预算导致 JSON 恒定截断；deepseek 系需在 `models.json` 给模型加 `"compat": {"thinkingFormat": "deepseek"}` 才会随请求发送 `thinking: {type:"disabled"}` |
| `verbatimCheck` | `true` | bool | 逐字校验：摘要条目里的路径/命令必须在对话原文中出现，否则剔除（防小模型编造） |
| `keepRecentTokens` | `20000` | 1000–1000000 | 近期窗口大小（tokens），窗口内 turn 原文保留。**计量口径**：CJK 感知估算（中文/日文/韩文字符 ≈ 1 tok/字，其余 ≈ 1 tok/4 字符，见 `util.countTokens`）；assistant 消息剥离 thinking 块后计（窗口发给 LLM 时同样剥离，纯 thinking 消息整条丢弃）——思考是过程噪声，不挤占有效输出预算 |

### 计量校准

所有 token 阈值（窗口预算、ledger 降级阈值、保留区）均用内置的 CJK 感知估算器计量，不用 pi 的 `chars/4`（后者对中文低估约 2 倍）。估算器偏保守（系数 1.0，实测 tokenizer 中文 ≈ 0.65 tok/字）：窗口偏小的代价是多一次 recall，偏大的代价是挤爆上下文触发原生压缩。

运行 `/compress-status` 可看到最近一次装配的「估算 vs 真实 usage」并排对比（`计量校准` 行）。差值 = system prompt + 工具定义 + 模板开销 + 估算误差；长期稳定偏差即可推出校准系数，供后续自动校准参考。
| `forceRatio` | `0.76` | 0.1–0.99 | 上下文用量超过此比例触发强制点（等待队列清空后重组） |
| `retry.maxAttempts` | `3` | 1–100 | 单 turn 摘要失败重试次数 |
| `retry.backoffMs` | `2000` | 100–600000 | 指数退避基数（第 n 次等待 `backoffMs * 2^(n-1)`） |
| `ledgerDegradeThresholdTokens` | `40000` | 5000–2000000 | 动作日志 L1 区渲染体积阈值（tokens）：超过时最旧 turns 降级为 L2（保留尾部约 `ledgerReserveTokens`），逐级瀑布 L1→L2→L3→L4 |
| `ledgerReserveTokens` | `10000` | 1000–500000 | 每层降级时尾部的保留区大小（tokens），按 turn 边界取整 |
| `backfillLimit` | `20` | 0–100000 | `session_start` 时补摘未摘要 turn 的上限（最旧优先），0 = 关闭。会话恢复/崩溃重启后自动补齐历史缺口 |

### 动作日志四级分层（L1–L4）

窗外已摘要 turn 的动作日志头按四级渐进压缩，每层超过 `ledgerDegradeThresholdTokens`（默认 40K tokens）时，最旧 turns 降级到下一层（保留尾部约 `ledgerReserveTokens`，按 turn 边界取整），后台异步瀑布执行（每轮回复落盘后 L1→L2→L3→L4 逐级检测，任一层不超标即停止），降级结果持久化到 ledger，装配时直接读取：

- **L1** 用户原文 + 动作（命令+摘要+↩ID）+ 最终回复原文
- **L2** 丢动作中的命令，两端原文保留
- **L3** 意图（↩ID）+ 动作摘要 + 最终回复摘要（↩ID）——本地模型生成
- **L4** 多 turn 合并一行 `T3-T7 · 描述（N 条已合并）↩id1,id2,...`——本地模型生成

```jsonc
{ "contextCompress": { "ledgerDegradeThresholdTokens": 40000, "ledgerReserveTokens": 10000 } }
```

### 方式一：pi 模型注册表

`summarizer: { provider, model }` 让插件复用 pi 的 `modelRegistry`（与主对话模型统一管理 provider/凭据）。以 Ollama 为例，先在 pi 注册 Ollama provider（参见 pi 文档 `docs/custom-provider.md`），然后：

```jsonc
{ "contextCompress": { "summarizer": { "provider": "ollama", "model": "qwen3:8b" } } }
```

### 方式二：OpenAI 兼容直连

`summarizer: { baseUrl, model, apiKey? }` 直接走 OpenAI 兼容 `/chat/completions`，不经 pi 注册表。适合本地 Ollama（`http://localhost:11434/v1`）或任何兼容端点：

```jsonc
{ "contextCompress": { "summarizer": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" } } }
```

## 模型选型建议

- **参数量 4B–8B**：摘要任务量小，本地推理要快；过小（<4B）指令遵循不稳，过大（>13B）本地延迟高、拖慢回答后整理。
- **指令遵循稳定优先于推理力**：摘要只做「结构化复述 + 路径逐字复制」，不需要强推理，但必须严格遵守 JSON schema 与「target 来自清单」约束。
- **Qwen 系推荐**：中文表达自然、JSON 输出稳定。`qwen3:8b` 是甜点档；显存紧用 `qwen3:4b`。
- **中英混合注意**：代码路径/标识符多为英文，prompt 已要求「detail 中路径必须能在原文找到」，但小模型偶有改写——`verbatimCheck: true` 会自动剔除失真条目。

## `/compress-status` 命令

在 pi 里运行 `/compress-status` 查看插件运行状态：

```
已摘要 turn 数：12
队列积压：0
失败未摘：0
降级状态：正常
最近装配：窗口 3 turns / 替换 2 / 原文放行 0
召回：调用 4 次 / 取回 6 条 / 未中 0 个 ID
计量校准：估算 ~15340 tok · 真实 18920 tok（差值含 system prompt/工具定义/模板开销）
摘要后端：{"kind":"registry","provider":"ollama","model":"qwen3:8b"}
备用后端：{"kind":"registry","provider":"HSFZ","model":"glm-5.3-flash"}（主后端溢出/重试耗尽时接管）
```

- **已摘要 turn 数** / **队列积压** / **失败未摘**：摘要进度与健康度。
- **降级状态**：`正常` 或 `已降级（pi 原生压缩接管中）`——后者表示强制点等待超时，本轮上下文不重组，交 pi 原生 auto-compaction 兜底；队列恢复后自动回到正常。
- **最近装配**：上一次 context 事件重组的统计（窗口/替换/原文放行 turn 数）。
- **召回**：LLM 通过 recall 工具取回原文的统计——`调用` 为工具调用次数（可批量传多个 ID），`取回` 为命中并返回的条目数，`未中` 为不在当前分支的 ID 数（可能因 /tree 回退）。全 0 表示 LLM 在窗口内就能拿到所需细节（健康信号）；持续高召回率说明 `keepRecentTokens` 偏小或动作日志 detail 粒度不够。
- **计量校准**：最近一次装配的「估算（CJK 感知）vs 真实 usage」并排对比。差值 = system prompt + 工具定义 + 模板开销 + 估算误差；长期稳定偏差即可推出校准系数，供后续自动校准参考。
- **摘要后端** / **备用后端**：当前生效的后端配置；未配置时显示 `未配置`。

## `/compress-dump` 命令

在 pi 里运行 `/compress-dump [输出基路径]` 把「本轮实际发给 LLM 的上下文」完整落盘，用于审计装配口径与排查压缩问题：

```
context-compress 转储：14 条 messages / 窗口 3 turns / 替换 2 / 照发 0 / ~15340 tok
D:\Pi\pi-compress\e2e\reports\1788865118781-context-dump.md
D:\Pi\pi-compress\e2e\reports\1788865118781-context-dump.json
```

- **单一真相**：复用 context 事件同款 `assembleContext`，所见即本轮真实装配结果（含 ledger 头、thinking 剥离、窗外原文照发）。
- **Markdown**：人读审阅稿——配置元信息、装配统计、turn 归属表（lead / replaced / passthrough）、messages 原文全文。
- **JSON**：机器可复现的结构化数据（逐条体积、turn 归属、ledger 摘要），供后续对比脚本使用。
- **输出路径**：缺省写 `<cwd>/e2e/reports/<时间戳>-context-dump.{md,json}`，参数可指定基路径（自动补 .md/.json 两个扩展名）。
- **边界**：未配置 `contextCompress.summarizer` 时插件未接管装配，无从转储真实口径，命令会明确拒绝；转储的是装配后的 messages（thinking 已剥离），非会话文件原文。

## 项目结构

```
src/
├── index.ts        扩展入口：事件接线、recall 工具注册、/compress-status 与 /compress-dump 命令
├── dump.ts         /compress-dump 转储：Markdown+JSON 渲染与写盘（复用 assembleContext）
├── config.ts       配置解析（全局 + 项目级合并，字段校验与默认值）
├── summarizer.ts   摘要后端调用（registry / OpenAI 兼容直连）、重试、备用切换、thinking 剥离
├── prompts.ts      摘要 prompt 与 JSON schema（groups-only：意图/结果由系统机械保存）
├── ledger.ts       动作日志渲染（用户原话/最终回复逐字引用 + 工具动作摘要）
├── assembler.ts    上下文重组：近期窗口 + 动作日志头
├── forcepoint.ts   强制点：等待摘要队列清空，超时降级
├── backfill.ts     session_start 补摘历史缺口
├── recall.ts       recall 工具实现：按 ID 取回逐字原文（含配对 toolResult）
├── store.ts        状态持久化
└── util.ts         消息提取、thinking 剥离、路径抽取等
```

## 开发

```bash
npm test        # vitest 单测（tests/）
```

`bench/` 内含压缩率基准、真实模型 e2e 与统计工具；`e2e/` 内含 RPC 驱动脚本，可驱动真实 pi 会话验证端到端行为。

## 已知限制（v1）

- **动作日志降级（四级分层）依赖本地模型**：L2→L3 的意图/摘要与 L3→L4 的合并描述由 `summarizer` 现场生成，降级触发瞬间可能增加一次后台模型调用；L1→L2 为纯规则（去命令），无模型成本。
- **补摘仅在 session_start 触发**：历史缺口在会话恢复时补齐；会话中途关闭摘要器再开启需重启会话才会补摘。补摘受 `backfillLimit` 上限约束，超出部分（更旧的 turn）保持原文放行。
- **RPC/print 模式未特殊处理**：插件在 `tui` 模式下完整工作；`rpc`/`json`/`print` 模式下事件仍触发，但 `ctx.ui.notify`/`setStatus` 可能无可见输出。
- **单 turn 超大**：单个 turn 超过 `keepRecentTokens` 时，按设计仍整体保留在窗口内（不拆分），会导致窗口临时超过预算，直到下一轮 pi 原生压缩兜底。
- **逐字校验依赖路径正则**：`verbatimCheck` 用 `/[\w./\\-]+\.\w{1,4}/g` 提取疑似路径，对无扩展名的命令/参数不做校验。
- **摘要只见 toolResult 的头+尾**：超过 2000 字符的 toolResult 在摘要 prompt 中按「前 1400 + 后 500 + 中段省略标记」采样；中段内容对摘要模型不可见（逐字内容仍可通过 recall 取回）。

## 许可

MIT
