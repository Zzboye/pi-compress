# 设计：toolResult 头+尾采样（摘要 prompt 截断策略）

日期：2026-09-05 · 状态：已实现

## 背景

`serializeTurn` 复用 pi 的 `serializeConversation`，其对 toolResult 的截断策略是
**只保留前 2000 字符**（`TOOL_RESULT_MAX_CHARS`）+ 尾部截断标记。T19 全景对比实验
（e2e/reports/2026-09-01-context-before-after.md）发现：17.9k-token 的大文件读取
turn，摘要模型只能看到开头 ≈60 行。

问题：**结论后置型输出**（vitest/tsc 失败汇总、构建错误、exit code 都在尾部）
对摘要模型完全不可见，导致 ledger 的 `detail` 字段失真。

## 影响面评估（为何此前接受、现在小改）

- ledger 的承重字段（action、target、recallIds）全部来自 `extractToolActions`
  机械提取，与摘要模型看到多少无关——截断只伤 `detail` 文案质量。
- 原文明文永不丢失（JSONL + recall 取回全文）；summary 是索引，recall 才是保真通道。
- 不采用全量送入：70KB turn 的 prompt 变 25 倍，小模型 JSON 格式可靠性随长度下降。

## 方案：预截断头+尾采样

在调用 pi 的 `serializeConversation` **之前**，由我们自己的
`preTruncateToolResults`（src/util.ts）对超限 toolResult 预截断：

```
前 1400 字符 + "\n[... omitted N middle characters ...]\n" + 后 500 字符
```

关键约束：总预算 ≈1950 字符 **必须落在 pi 的 2000 以下**，否则 pi 会对我们的
输出做二次头部截断、把尾部切掉。选用 1400/500 而非 1500/500 即为此留余量。

- 阈值：`full.length > 2000` 才采样；≤2000 逐字放行（与 pi 行为一致）。
- 实现：预截断后替换 content 为单个 text 块；pi 序列化格式零漂移。
- 摘要模型看到省略标记，知晓中段缺失，不会把局部当全文。

## 明确不做（YAGNI）

- **按动作分策略**（bash 尾偏置 / read 头偏置）：头+尾组合已同时覆盖两类场景，
  收益边际小，先不加。
- **全量送入 / 提高上限**：成本与可靠性不划算。
- **对 user/assistant 文本截断**：pi 本就不截断，turn 内用户/助手文本通常很短。

## 测试

tests/summarizer.test.ts（RED→GREEN）：

1. 长 toolResult（5000 字符）：输出同时含开头标记、结尾标记、`omitted` 标记，
   且 `[Tool result]` 段 ≤2000 字符（防 pi 二次截断）。
2. 短 toolResult：无标记、内容完整。
3. 边界：恰好 2000 逐字放行；2001 触发采样且尾部保留。
