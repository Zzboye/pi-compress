# 摘要前后对比 — thinking OFF
- 日期：2026-09-01　后端：LM Studio 直连 http://localhost:8080/v1　模型：qwen3.8-27b-uncensored
- 参数：temperature 0，无 maxTokens 上限（直连路径）；thinking 已在 LM Studio 服务端关闭（probe 实测 reasoning_tokens=0）
- 管线：serializeTurn → buildSummarizePrompt → LLM → parseLedgerOutput（verbatimCheck=true）→ renderActionLedger
- 说明：压缩比按单 turn 独立日志头计算（含固定标题/脚注行）；实际会话中多个 turn 的日志合并进同一个 <action-ledger> 块，固定开销摊薄后压缩比更高

## 总表

| # | 形态 | 摘要前 tok | 摘要后 tok | 压缩比 | 延迟 ms | 清单条目→保留 |
|---|---|---|---|---|---|---|
| 1 | A · 纯中文对话（无工具） | 54 | 56 | 1.0x | 1995 | 0→0 |
| 2 | B · read 双文件工具链 | 300 | 109 | 2.8x | 3800 | 2→2 |
| 3 | C · bash 长输出 | 178 | 56 | 3.2x | 2297 | 1→1 |
| 4 | D · edit 修改+验证链 | 108 | 79 | 1.4x | 2956 | 2→2 |

## /think 对照探针（强制开思考，max_tokens=3000 封顶）

content 223 字符，reasoning 0 字符，1885ms，finish=stop，reasoning 为空（服务端关闭优先于 /think，或模板不响应软开关）

---

## A · 纯中文对话（无工具）

**摘要前**（序列化 turn，54 tokens）：
```
[User]: pi 的 context 事件和 agent_settled 事件分别在什么时候触发？我想知道插件该在哪里做上下文重组

[Assistant]: context 事件在每次调用 LLM 之前触发，扩展可以返回替换后的消息数组，适合做上下文重组；agent_settled 在一轮回答完全落定后触发，适合做不阻塞回答流的后台工作。所以你的插件应该用 context 做重组、agent_settled 喂摘要队列。
```

**模型原始输出**（223 字符，1995ms）：
```json
{
  "userIntent": "询问 pi 的 context 和 agent_settled 事件触发时机以确定插件上下文重组位置",
  "outcome": "明确 context 事件在 LLM 调用前触发适合重组，agent_settled 在回答落定后触发适合后台工作",
  "groups": [
    {
      "phase": "discuss",
      "entries": []
    }
  ]
}
```

**摘要后**（动作日志头，56 tokens，清单 0 条 → 保留 0 条）：
```
<action-ledger>
## 会话历史（动作日志，细节已压缩）

### T1 · 用户意图：询问 pi 的 context 和 agent_settled 事件触发时机以确定插件上下文重组位置
- 结果：明确 context 事件在 LLM 调用前触发适合重组，agent_settled 在回答落定后触发适合后台工作

（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）
</action-ledger>
```

压缩比 54:56 = 1.0x（含动作日志固定头开销；多 turn 合并时摊薄）

---

## B · read 双文件工具链

**摘要前**（序列化 turn，300 tokens）：
```
[User]: 读一下 src/assembler.ts 和 src/forcepoint.ts，看窗口重组怎么处理 turn 边界、强制点怎么触发

[Assistant]: 我来看看这两个文件

[Assistant tool calls]: read(path="src/assembler.ts"); read(path="src/forcepoint.ts")

[Tool result]: export function assembleContext(entries: MessageEntry[], cache: Map<string, LedgerData>, keepRecentTokens: number) {
  const turns = splitIntoTurns(entries);
  // 窗口边界只落在 turn 边界（user 消息处），toolResult 不会与 toolCall 拆开
  const windowTurns: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = estimateTokensOf(turns[i]);
    if (total + t > keepRecentTokens) break;
    windowTurns.unshift(turns[i]); total += t;
  }
  return { windowTurns, replaced: turns.filter(t => !windowTurns.includes(t)) };
}

[Tool result]: export async function enforceForcePoint(usage, contextWindow, forceRatio, engine, timeoutMs, setStatus) {
  if (!usage || usage.tokens / contextWindow < forceRatio) return "proceed";
  setStatus("等待摘要队列清空…");
  const ok = await engine.waitIdle(timeoutMs); // ≤120s
  return ok ? "proceed" : "degraded";
}

[Assistant]: 窗口边界只落在 turn 边界（user 消息处），保证 toolResult 不会和 toolCall 被拆开；强制点在上下文用量超过 forceRatio（默认 0.76）时触发，等待摘要队列排空最多 120 秒，超时则降级交 pi 原生压缩兜底。
```

**模型原始输出**（557 字符，3800ms）：
```json
```json
{
  "userIntent": "阅读 src/assembler.ts 和 src/forcepoint.ts 以了解窗口重组处理 turn 边界及强制点触发机制",
  "outcome": "确认了窗口边界仅落在 user 消息处以保持 toolCall/toolResult 完整性，且强制点在用量超阈值时等待队列排空或超时降级",
  "groups": [
    {
      "phase": "investigate",
      "entries": [
        {
          "target": "src/assembler.ts",
          "detail": "窗口边界只落在 turn 边界（user 消息处），保证 toolResult 不会和 toolCall 被拆开"
        },
        {
          "target": "src/forcepoint.ts",
          "detail": "强制点在上下文用量超过 forceRatio 时触发，等待摘要队列排空最多 120 秒，超时则降级交 pi 原生压缩兜底"
        }
      ]
    }
  ]
}
```
```

**摘要后**（动作日志头，109 tokens，清单 2 条 → 保留 2 条）：
```
<action-ledger>
## 会话历史（动作日志，细节已压缩）

### T1 · 用户意图：阅读 src/assembler.ts 和 src/forcepoint.ts 以了解窗口重组处理 turn 边界及强制点触发机制
- 调查：read src/assembler.ts → 窗口边界只落在 turn 边界（user 消息处），保证 toolResult 不会和 toolCall 被拆开 ↩a1
- 调查：read src/forcepoint.ts → 强制点在上下文用量超过 forceRatio 时触发，等待摘要队列排空最多 120 秒，超时则降级交 pi 原生压缩兜底 ↩a1
- 结果：确认了窗口边界仅落在 user 消息处以保持 toolCall/toolResult 完整性，且强制点在用量超阈值时等待队列排空或超时降级

（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）
</action-ledger>
```

压缩比 300:109 = 2.8x（含动作日志固定头开销；多 turn 合并时摊薄）

---

## C · bash 长输出

**摘要前**（序列化 turn，178 tokens）：
```
[User]: 跑一下测试，看看现在多少个用例

[Assistant]: 跑全套测试

[Assistant tool calls]: bash(command="npx vitest run")

[Tool result]:  ✓ tests/ledger.test.ts (3 tests) 3ms
 ✓ tests/store.test.ts (3 tests) 3ms
 ✓ tests/config.test.ts (6 tests) 4ms
 ✓ tests/forcepoint.test.ts (5 tests) 5ms
 ✓ tests/prompts.test.ts (4 tests) 6ms
 ✓ tests/assembler.test.ts (7 tests) 5ms
 ✓ tests/recall.test.ts (3 tests) 3ms
 ↓ tests/lanfeng-smoke.test.ts (1 test | 1 skipped)
 ✓ tests/summarizer.test.ts (5 tests) 10ms
 ✓ tests/integration.test.ts (3 tests) 8ms
 ✓ tests/extension.test.ts (5 tests) 6ms

 Test Files  10 passed | 1 skipped (11)
      Tests  44 passed | 1 skipped (45)

[Assistant]: 44 个用例全部通过，1 个跳过（LanFeng 真机冒烟测试，需要环境变量门控），测试套件健康。
```

**模型原始输出**（280 字符，2297ms）：
```json
{
  "userIntent": "运行测试套件以确认当前用例数量及状态",
  "outcome": "44个用例通过，1个跳过，测试健康",
  "groups": [
    {
      "phase": "verify",
      "entries": [
        {
          "target": "npx vitest run",
          "detail": "执行 npx vitest run 确认 44 passed | 1 skipped"
        }
      ]
    }
  ]
}
```

**摘要后**（动作日志头，56 tokens，清单 1 条 → 保留 1 条）：
```
<action-ledger>
## 会话历史（动作日志，细节已压缩）

### T1 · 用户意图：运行测试套件以确认当前用例数量及状态
- 验证：bash npx vitest run → 执行 npx vitest run 确认 44 passed | 1 skipped ↩a1
- 结果：44个用例通过，1个跳过，测试健康

（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）
</action-ledger>
```

压缩比 178:56 = 3.2x（含动作日志固定头开销；多 turn 合并时摊薄）

---

## D · edit 修改+验证链

**摘要前**（序列化 turn，108 tokens）：
```
[User]: 把 forceRatio 的默认值从 0.76 提到 0.80，README 的配置表也同步一下

[Assistant]: 先改代码再改文档

[Assistant tool calls]: edit(path="src/config.ts", oldText="0.76", newText="0.80"); edit(path="README.md", oldText="0.76", newText="0.80")

[Tool result]: Successfully replaced 1 block(s) in src/config.ts

[Tool result]: Successfully replaced 2 block(s) in README.md

[Assistant]: 已改：forceRatio 默认值 0.80（src/config.ts），README 配置表两处同步更新。注意已有会话需重启才生效。
```

**模型原始输出**（419 字符，2956ms）：
```json
{
  "userIntent": "将 forceRatio 默认值从 0.76 调整为 0.80 并同步更新 README",
  "outcome": "成功修改 src/config.ts 和 README.md 中的数值，完成配置与文档的同步",
  "groups": [
    {
      "phase": "fix",
      "entries": [
        {
          "target": "src/config.ts",
          "detail": "将 forceRatio 默认值从 0.76 修改为 0.80"
        },
        {
          "target": "README.md",
          "detail": "同步更新配置表中两处 0.76 为 0.80"
        }
      ]
    }
  ]
}
```

**摘要后**（动作日志头，79 tokens，清单 2 条 → 保留 2 条）：
```
<action-ledger>
## 会话历史（动作日志，细节已压缩）

### T1 · 用户意图：将 forceRatio 默认值从 0.76 调整为 0.80 并同步更新 README
- 修复：edit src/config.ts → 将 forceRatio 默认值从 0.76 修改为 0.80 ↩a1
- 修复：edit README.md → 同步更新配置表中两处 0.76 为 0.80 ↩a1
- 结果：成功修改 src/config.ts 和 README.md 中的数值，完成配置与文档的同步

（需要任何条目的逐字原文时，调用 recall 工具并传入 ↩ 后的 ID）
</action-ledger>
```

压缩比 108:79 = 1.4x（含动作日志固定头开销；多 turn 合并时摊薄）

---
