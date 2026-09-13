# 图片 turn 的降级策略 — 设计文档

日期：2026-09-12
状态：已评审（用户确认 3 项裁定：recall 回真图 / 占位符全层级 / 复用 entry ID）

## 1. 问题

图片内容在压缩链路中存在三个缺口：

1. **窗外已摘要 turn：图片静默消失。** `extractUserMessage` 的 `joinedText` 只取 text 块，图片块被丢弃，ledger 无任何痕迹；摘要模型自身也看不到图（`serializeConversation` 只取 text 块），摘要里连"用户发了截图"都不提。
2. **窗外未摘要 turn（passthrough）：图片每轮重复发送**，直到摘要落定；unsummarized 卡死时永久重复。
3. **recall 取不回图**：`executeRecall` 走 text-only 序列化，图片一旦被摘要/掉出窗口，对模型而言永远消失——违背"原文永远可 recall"的核心承诺。

## 2. 裁定记录

| # | 决策点 | 裁定 | 理由 |
|---|---|---|---|
| 1 | recall 是否返回真图 | **返回真图** | 图片可见性只有这条路；~1200 tok 按需付费符合 recall 哲学 |
| 2 | 占位符是否随层级降级 | **L1–L4 全层级同一占位** | 占位符仅几十 tok，信息密度极高；降级断掉 recall 线索。与"recallId 永不消失"同一哲学 |
| 3 | 图片召回 ID | **复用现有 entry ID，不造合成 ID** | 维持"一条消息 = 一个 entry ID、无映射层"不变式；图寄居在 entry 内 |

## 3. 设计

### 3.1 数据模型（types + util.ts）

`LedgerQuote` 增加可选字段：

```ts
images?: { mimeType: string; bytes: number }[]
```

- `extractUserMessage`：提取 content 中 image 块元信息（mimeType + `data.length × 3/4` 估字节），text 照旧。`bytes` 仅供人读/dump 参考，不参与渲染。
- `extractFinalReply`：不变（assistant content 类型上不含 image）。
- **toolResult 的图片不进 quote**：靠既有动作 recallIds（指向 toolCall，配对 toolResult）覆盖，零新数据结构。

### 3.2 渲染（ledger.ts）

`renderTurnText` 在用户消息行之后追加占位行，L1–L3 同款：

```
### T12 · 用户：「帮我看下这个报错」
[图片 ×2: image/png, image/png ↩t12-u]
- 调查：…
```

- ↩id 为用户消息的既有 entryId（`userMessage.entryId`），复用不新造。
- L4 **不渲染占位行**：合并行 description 由摘要模型生成，图片存在感经 3.3 的 `[图片]` 标记自然融入。
- `turnRenderTokens` 自动计入占位行文本，无需特殊处理。

### 3.3 摘要输入（util.ts）

发送给摘要模型前（`serializeConversation` 之前的转换步骤），把 image 块替换为文本标记 `[图片: image/png]`。摘要模型至少知道"用户发了图"，userIntent / outcome / merged.description 不再丢图的存在感。

### 3.4 recall 回真图（recall.ts + index.ts）

`executeRecall` 扩展：

- 文本照旧（现有序列化路径零改动）。
- 同时收集该 entry content 及其配对 toolResult content 中的 image 块，作为 image 块追加到工具结果的 content 数组：

```ts
return {
  content: [
    { type: "text", text: parts.join(...) },
    ...imageBlocks,  // { type: "image", data, mimeType }，从会话文件原始 data 直取
  ],
};
```

- `【id 的原文】`文本内加提示行：`[含图片 ×1，已附在结果中]`。
- **风险控制（实现计划第一步）**：先写验证测试确认 pi 工具链路透传工具结果中的 image 块（fixture 直测）。若不透传，降级为文本提示"图片存在但无法显示"，占位符与摘要标记不受影响。

### 3.5 明确边界（不修）

- **passthrough turn 的图片**：仍原样发送（"原文照发"语义不破坏），摘要落定后自然被 ledger+占位符接管。unsummarized 卡死时图片重复发送属既有降级态行为，不在本次扩展。
- **窗口内图片**：不动，正常计 1200 tok（`IMAGE_TOKENS` 口径沿用）。
- **单 entry 多图的子集召回**：不做，全量带回（裁定 3 的自然推论）。

## 4. 测试

| 类别 | 用例 |
|---|---|
| extract | 含图 user 消息提取出 mimeType/bytes；纯文本行为零变化 |
| 渲染 | L1/L2/L3 占位行 + ↩id；L4 无占位行；`turnRenderTokens` 含占位行 |
| 摘要输入 | image 块 → `[图片: mime]` 文本标记；无图消息不受影响 |
| recall | 命中含图 entry 返回 image 块 + 文本提示；配对 toolResult 的图带回；无图 entry 行为零变化 |
| 透传验证 | pi 工具结果 image 块进入后续请求上下文（实现前置验证步骤） |
