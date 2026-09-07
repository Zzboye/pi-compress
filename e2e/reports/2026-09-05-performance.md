# pi-compress 性能基准报告

- 日期：2026-09-05
- 代码版本：`D:/Pi/pi-compress` @ 工作区（54 单测 + 1 跳过全绿后施测）
- 环境：Windows / Node v24.15.0 / vitest 2.1.9 / LM Studio 127.0.0.1:8080（qwen3.8-27b-uncensored 密度模型、qwen3.6-35b-a3b-uncensored MoE）
- 计量口径：token 一律用 pi 主包 `estimateTokens`（与插件 `findWindowTurns` 同口径）；延迟用 `performance.now()` 多次迭代取 p50/p95
- 夹具：确定性合成会话（`bench/fixture.ts`，mulberry32 种子）+ 本仓库真实文件会话（`bench/real-model*.test.ts`，与 2026-09-01 e2e 报告同方法论）
- 原始数据：`e2e/reports/perf/{micro,compression,real-model,real-model-e2e}.json`；复跑命令见文末

## TL;DR

| 维度 | 结论 |
|---|---|
| 前台装配延迟 | 2000 turns（7752 msgs，原生 ~441 万 tok）时 **mean ≈ 1.1ms**，远低于 10ms 设计承诺；与会话规模线性、常数极小 |
| 压缩效果 | 会话越长省得越多：100 turns 省 **89.6%**，1000 turns 省 **97.6%**；真机 ledger 端到端 41340 → 7775 tok（**省 81.2%**） |
| 摘要管线框架开销 | 每 turn **≈ 0.06ms**（墙钟几乎全在模型）；重试机制退避精确生效 |
| 真机摘要质量 | 两模型 8/8、11/11、14/14 turns 全部成功解析，逐字校验剔除 0 |
| 模型选型 | 27B 密度模型 p50 **3.7s/turn**；35B MoE（A3B）实测反而慢 **5-6 倍**（p50 21s）——本机负载下不推荐 |
| 摘要成本恒定性 | 巨型 turn（70KB/87KB toolResult）的摘要 prompt 仍 ≈2.8k chars（2000 字符截断），**摘要成本与原文大小无关** |

## ① 前台装配路径（每轮请求都要走，"永不拖慢回答"的验证）

| turns / msgs | splitIntoTurns | assemble（全有摘要） | assemble（无摘要透传） | 装配 stats |
|---|---|---|---|---|
| 50 / 206 | 0.02ms | 0.09ms | 0.05ms | 窗 2 / 替 48 |
| 100 / 404 | 0.01ms | 0.10ms | 0.09ms | 窗 3 / 替 97 |
| 300 / 1188 | 0.06ms | 0.27ms | 0.21ms | 窗 17 / 替 283 |
| 1000 / 3872 | 0.18ms | 0.86ms | 0.52ms | 窗 14 / 替 986 |
| 2000 / 7752 | 0.07ms | **1.13ms** | 0.72ms | 窗 9 / 替 1991 |

（mean，30 iters；p95 与 max 的偶发尖刺 ≤5ms，来自 JIT/GC，不影响结论）

- **装配成本 ≈ O(分支消息数)**，2000 turns 仍在 1ms 量级——`context` 事件路径的 CPU 开销可忽略。
- 无摘要降级透传（模型全挂的最坏情形）与正常装配同量级，**降级不引入额外前台成本**。
- 配套路径同样健康：ledger 渲染 1000 turns 0.39ms；store 重建（session_start）24.5k entries 0.7ms；recall 在 11.7k msgs 分支上批量 10 ID **0.7-1.2ms**；forcepoint 三分支决策 <0.001ms；补摘 diff（1000 turns）<0.01ms。
- 内存：2000-turn 会话（441 万 tok 原文）消息堆 **33.6MB**，全量 ledger 缓存堆仅 **2.6MB**（≈ 原文的 0.8%）。

## ② 压缩效果（mock ledger，keepRecentTokens=20000）

| turns | 原生 tok | 装配后 tok | 节省 | 压缩后为原来的 |
|---|---|---|---|---|
| 30 | 25,993 | 19,038 | 26.8% | 73.2% |
| 100 | 209,978 | 21,855 | **89.6%** | 10.4% |
| 300 | 658,262 | 29,194 | **95.6%** | 4.4% |
| 1000 | 2,085,153 | 50,447 | **97.6%** | 2.4% |

- 装配后规模 ≈ `keepRecentTokens（窗口）+ Σledger`，与原生规模解耦——这正是设计目标：**上下文占用不随历史无限增长**。
- 30 turns 时大部分 turn 还在窗口内，压缩自然有限；超过窗口后比率迅速趋near 95%+。
- 窗口预算敏感性（300 turns，原生 658k）：4k→省 98.0%，8k→97.4%，20k→95.6%，50k→95.1%。预算越小省得越多（窗口占比下降），但细节保留变少——`keepRecentTokens` 是「省 token vs 保细节」的直接旋钮。
- 无摘要透传验证：100 turns（210k tok）全无 ledger 时装配输出 = 原文逐条照发（209,978 → 209,978），**不丢消息、不变形**。

## ③ 摘要引擎管线（mock 后端，隔离框架成本）

| mock 模型延迟 | turns | 墙钟 | 模型时间 | 框架开销 | 每 turn 开销 |
|---|---|---|---|---|---|
| 5ms | 20 | 319.6ms | 318.2ms | 1.4ms | 0.07ms |
| 50ms | 20 | 1274.3ms | 1273.1ms | 1.2ms | 0.06ms |
| 200ms | 20 | 4147.6ms | 4146.3ms | 1.3ms | 0.06ms |

- 串行队列的调度/序列化/解析/校验开销 **每 turn ≈ 0.06ms**，完全被模型时间淹没；后台摘要的墙钟 ≈ Σ模型延迟。
- 重试路径：20 turns、每 3 个调用第 1 次失败（backoffMs=50）→ 30 次模型调用，墙钟 1115ms = 模型 477ms + **退避 600ms + 框架 ~40ms**。指数退避按配置精确生效，无放大。
- 摘要器纯计算（serializeTurn / buildPrompt / parse+verbatim 校验）全部 <0.05ms——逐字校验不构成成本问题。

## ④ 真机摘要（LM Studio，本仓库真实文件会话）

### 逐 turn 摘要延迟与质量（8-turn 基线会话，两模型）

| 模型 | 成功/总数 | 解析失败 | 逐字剔除 | p50 | mean | max | 队列追赶（8 turns） |
|---|---|---|---|---|---|---|---|
| qwen3.8-27b-uncensored（密度） | 8/8 | 0 | 0 | **3,652ms** | 4,358ms | 13,777ms | **34.9s** |
| qwen3.6-35b-a3b（MoE） | 8/8 | 0 | 0 | 21,040ms | 23,133ms | 35,710ms | 486.1s* |

\* 35B 首请求 ≈300s（含 KV 缓存分配/换模尾流），另受本机 GPU 争用影响；排除首请求后仍 ~20s/turn，比 27B 慢 5-6 倍。

- **输出 JSON 合格率 100%**（0 解析失败、0 逐字剔除），两模型同分——`verbatimCheck` 兜底下小模型摘要质量可靠。
- 27B 在 e2e 会话（11/14 turns）复测：追赶 38.6s / 27.2s，热态（prompt 缓存生效后）降至 **~2s/req**。

### 逐 turn 压缩率（真实 ledger，两模型一致）

| turn 形态 | turn 原文 tok | ledger tok | 压缩率 |
|---|---|---|---|
| 大读取（读文件+结论，1288 tok） | 1288 | 40-68 | **3-5%** |
| 中读取（589-1123 tok） | 589-1123 | 64-87 | 6-15% |
| 编辑/验证（388 tok） | 388 | 89-90 | 23% |
| 纯问答（36-51 tok） | 36-51 | 45-64 | **105-144%（膨胀）** |

- **大 turn 是收益主体**：读文件类 turn 压到 3-5%；**小问答 turn 会被 ledger 的固定开销（userIntent+outcome+分组头 ≈ 50-60 tok）放大**。这正是「窗外才有收益 + 动作日志合并（v2）」的依据。
- 两模型 ledger 尺寸几乎相同（40-90 tok/turn）——ledger 大小由 schema 决定，与模型无关。

### 真机端到端（14-turn 大会话，27B，真实 ledger）

- 会话：8-turn 真实文件基线 + 巨型读取（70KB 实现计划 / 87KB 上下文转储）+ 中型 spec/lock 读取 + 收尾问答
- **原生 41,340 tok → 装配后 7,775 tok（省 81.2%）**；窗口 4 turns 原文保留 / 替换 6 turns / 透传 0；ledger 总计仅 465 tok
- 14 turns 摘要总耗时 27.2s（后台异步，不阻塞回答；仅撞 forceRatio 时才等待队列）
- **摘要成本恒定**：70KB/87KB 的巨型 turn，摘要 prompt 仍 ≈2.8k chars（serializeTurn 的 toolResult 2000 字符截断）——单 turn 摘要延迟不随原文大小增长

## 发现与建议

1. **`estimateTokens` 对非消息对象静默返回 0**（pi 主包行为，非插件 bug）：基准脚本初版把 `MessageEntry` 包装误传给它，得到 native=0 而不报错。插件内部全部传 `.message` 无此问题；但任何第三方统计代码都值得加一层防护。
2. **小 turn 的 ledger 膨胀是真实成本**：纯问答 turn（<60 tok）被压成 45-64 tok 的 ledger。频率高时（聊天型会话）头部成本可观 → 印证 v2 的 `ledgerMergeThreshold` 合并是正确方向；v1 可先在 README 已知限制中补一句「纯问答高频会话收益有限」。
3. **模型选型结论反转了 README 建议**：README 推荐参数量优先（4B-8B 甜点），实测本机 35B MoE 反而比 27B 密度模型慢 5-6 倍（GPU 争用 + KV 分配开销）。建议 README 补充：**MoE 大模型不一定更快，选型以实测 p50 为准**。
4. **窗口预算是体验旋钮**：4k 预算省 98% 但 recall 压力大（/compress-status 的召回计数可监控）；20k 默认在省 token 与保细节间是合理折中。
5. **降级路径零成本已验证**：模型全挂时透传与正常装配同量级（<1ms），且不丢消息。

## 复跑

> 注意：`bench/*.test.ts` 会被默认 `npx vitest run` 一并拾取（服务在线时真机项约多花 10 分钟；服务离线时自动跳过）。只要单测请 `npx vitest run tests/`。

```bash
npx vitest run bench/micro.test.ts          # ①③ 微基准（无模型，~10s）
npx vitest run bench/compression.test.ts    # ② 压缩效果（mock ledger，~2s）
npx vitest run bench/real-model.test.ts     # ④ 逐 turn 真机（需 LM Studio，~9min，含 35B）
npx vitest run bench/real-model-e2e.test.ts # ④ 端到端真机（需 LM Studio，~30s）
```
