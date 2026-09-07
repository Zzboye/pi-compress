# 设计：ledger 逐字引用——用户原话与最终回复机械保留

日期：2026-09-07
状态：已确认（用户批准三参数：用户消息头 200 字符；最终回复头 800 + 尾 1200；旧 ledger 原样渲染不迁移）

## 背景与动机

### 现状

turn 滑出 `keepRecentTokens` 窗口后，整轮对话被压缩为一条 ledger，其中：

- **工具动作**（groups[].entries）：`action`/`target`/`recallIds` 由 `extractToolActions` 机械提取、逐字复制；`detail` 经 PATH_RE 逐字校验，失真即剔除。保护完备。
- **用户输入**：压缩为模型生成的 `userIntent` 一句话转述。
- **最终回复**：压缩为模型生成的 `outcome` 一句话转述。

### 实测依据（本仓库会话 2026-09-07T13-01-46，9 个 turn）

| 内容 | 字符数 | 占比 | 逐字校验 | recall 句柄 |
|---|---|---|---|---|
| 用户消息 | 164 | 0.1% | ❌ | ❌ |
| 工具动作（调用+结果） | 189,299 | 87% | ✅ | ✅ |
| 最终回复 | 28,235 | 13% | ❌ | ❌ |

三个问题：

1. **`userIntent`/`outcome` 是 ledger 中仅存的模型自由生成字段**——无逐字校验、无召回手段，摘要模型幻觉直接污染下游所有 turn。
2. **纯文本内容（用户输入、最终回复）恰恰是信息密度最高的部分**，却保护最弱。纯讨论 turn（无 toolCall）压缩后原文彻底不可召回。
3. **被压缩内容体量极小**（合计 13%），换取的是压缩率 ~95%→~85% 的微小让步，性价比极高。

另：最终回复是主模型自己的蒸馏结论，再过摘要模型等于二次有损压缩。

### 目标

ledger 三段式，模型生成的自由文本字段归零：

| 段落 | 来源 | 处理 |
|---|---|---|
| 用户原话 | turn 首条 user 消息 | 机械复制 + 头 200 字符截断 |
| 工具动作 | 现有摘要链路 | 不变 |
| 最终回复 | turn 末条含 text 的 assistant 消息 | 机械复制 + 头 800/尾 1200 截断 |

### 非目标

- 不改窗口机制（`keepRecentTokens`/forcepoint/降级）。
- 不迁移历史会话文件中的旧 ledger。
- 不做截断参数的配置化（沿用 util.ts 现有硬编码常量风格，YAGNI）。
- 不动 recall 工具的取回逻辑（entryId 机制天然兼容新句柄）。

## 详细设计

### 1. 数据结构（src/ledger.ts）

```ts
/** 机械截断的逐字引用：text 已内嵌省略标记，entryId 供 recall 取回全文 */
export interface LedgerQuote {
  text: string;        // 已截断版本（含省略标记）
  entryId: string;     // 原始消息的 entry ID（recall 句柄）
  truncated: boolean;  // 是否发生了截断
}

export interface LedgerSummary {
  userIntent?: string; // 仅旧格式 ledger 存在（legacy）
  outcome?: string;    // 仅旧格式 ledger 存在（legacy）
  groups: LedgerGroup[];
}

export interface LedgerData {
  turnStartEntryId: string;
  turnEndEntryId: string;
  summary: LedgerSummary;
  userMessage?: LedgerQuote;  // 新：用户原话
  finalReply?: LedgerQuote;   // 新：最终回复
}
```

### 2. 机械提取（src/util.ts，与 extractToolActions 同层）

常量（沿用 preTruncateToolResults 的内嵌标记风格）：

```ts
const USER_MESSAGE_HEAD_CHARS = 200;
const REPLY_HEAD_CHARS = 800;
const REPLY_TAIL_CHARS = 1200;
```

**`extractUserMessage(turn: Turn): LedgerQuote | undefined`**

- 取 `turn.entries[0]`，仅当 `role === "user"` 且含非空 text 块；否则返回 undefined（异常会话开头，渲染回落 legacy）。
- 文本 = 该消息所有 text 块 join("\n")（复用 joinedText）。
- 超过 200 字符时截断：`head + "\n[... 已截断，后续 N 字符省略 ...]"`，`truncated: true`。
- `entryId` = 该消息 entry ID，恒存储（未截断也可 recall 全文，防御）。

**`extractFinalReply(turn: Turn): LedgerQuote | undefined`**

- 从 `turn.entries` **尾部反向**扫描，找第一条 `role === "assistant"` 且剥离 thinking 块后仍含 text 块的消息。
  - 纯 thinking 的 assistant 消息跳过（继续向前找）。
  - 含 text + toolCall 的混合消息：取其 text（中断 turn 的最好可用内容）。
  - 找不到任何含 text 的 assistant 消息 → undefined（如用户中途打断）。
- 超过 2000 字符（800+1200）时头尾采样：`head800 + "\n[... 中间省略 N 字符 ...]\n" + tail1200`，`truncated: true`（与 preTruncateToolResults 同构）。
- `entryId` = 该 assistant 消息 entry ID。

### 3. 摘要 prompt（src/prompts.ts）

- 移除规则 5（userIntent/outcome 概括要求），新增说明：用户消息与最终回复由系统另行逐字保存，无需概括。
- 输出 schema 缩减为 `{"groups": [...]}`。
- turnText 仍含用户消息与最终回复全文（模型需要上下文写好 detail），不变。

### 4. 解析（src/ledger.ts `parseLedgerOutput`）

- 必填字段仅剩 `groups`（数组）。
- 模型若仍输出 userIntent/outcome：忽略，不存储。
- `LedgerParseError` 触发条件相应放宽（缺失 groups 才报）。

### 5. 引擎装配（src/summarizer.ts）

`processWithRetry` 的 `summarize` 闭包内，与 `extractToolActions` 并列调用两个机械提取（确定性、零成本，无需重试语义），`onLedger` 回调的 LedgerData 增补 `userMessage`/`finalReply` 字段。主/备用后端路径共用同一提取结果。

### 6. 渲染（src/ledger.ts `renderActionLedger`）

```
### T3 · 用户：「这次对话怎么没有启动pi-compress摘要？」
- 调查：bash ls ~/.pi/agent/... → 检查全局配置 ↩3cc89683
- 调查：read src/index.ts → 阅读核心入口代码 ↩9dff393c
最终回复（原文）：
是的，但"摘要"和"替换上下文"是两件事……（多行原文）
（已截断，↩abc12345 取回全文）
```

规则：

- **turn 头**：有 `userMessage` → `### T{n} · 用户：「{text}」`，截断时附 ` ↩{entryId}`；无 → legacy `### T{n} · 用户意图：{userIntent ?? "（未知）"}`。头部单行渲染时将 `\n` 折叠为空格（存储文本保持逐字）。
- **turn 尾**：有 `finalReply` → `最终回复（原文）：\n{text}`，截断时尾行附 `（已截断，↩{entryId} 取回全文）`；无 → legacy `- 结果：{outcome}`。
- 工具动作行不变；尾部 recall 提示语不变。

### 7. recall 联动（无代码改动）

`executeRecall` 按 entryId 查找 branch 条目：user 消息、纯 text assistant 消息均已在 byId 覆盖范围内（stripThinking 不影响这两类）。`registerTool("recall")` 的 description 补一句"含截断的用户消息/最终回复全文"。

## 向后兼容

1. **旧 ledger（会话文件已存在）**：`store.rebuildFromEntries` 原样读入，无 `userMessage`/`finalReply` 字段 → 渲染回落 legacy（userIntent/outcome）。
2. **补摘（backfill）**：旧 turn 无 ledger 时用新 prompt 重摘 → 新格式。
3. **store 校验**：`isValidLedger` 只查 turnStartEntryId/turnEndEntryId/summary，新字段可选，无需改动。
4. **session_before_compact**：走 renderActionLedger，自动兼容。

注意：ledger 渲染产物是注入 LLM 上下文的合成 user 消息，**不落盘为会话消息条目**，故不会作为 user 消息被下一轮 splitIntoTurns/摘要捕获，无递归问题。

## 边界情况

| 场景 | 行为 |
|---|---|
| turn 无 assistant 回复（打断） | finalReply 缺省，不渲染该段 |
| 末条 assistant 纯 thinking | 反向跳过，取更早的含 text 消息 |
| 用户消息为巨型粘贴 | 头 200 + ↩句柄取回 |
| turn 首条非 user 消息（异常会话） | userMessage 缺省，回落 legacy 渲染 |
| 摘要模型输出仍带 userIntent/outcome | 解析时忽略 |
| 模型 JSON 解析失败/后端全失败 | 现有行为不变：turn 原文放行（passthrough） |

## 测试计划（TDD，先写测试）

**新增 `tests/util-extract.test.ts`**（extractUserMessage / extractFinalReply）：

- 短用户消息：无截断、逐字相等、truncated=false
- 长用户消息（>200）：头 200 + 标记、truncated=true
- 首条非 user：undefined
- 多 text 块 join
- 最终回复：末条含 thinking+text → 取 text
- 末条纯 thinking → 跳过取前一条
- 含 text+toolCall → 取 text
- 无 assistant → undefined
- >2000 字符：800 头 + 标记 + 1200 尾
- entryId 正确性

**更新 `tests/ledger.test.ts`**：

- parseLedgerOutput：groups-only JSON 合法；带 userIntent/outcome 的输出被忽略
- renderActionLedger：新格式渲染（含截断句柄）；legacy 回落；混合（有 userMessage 无 finalReply）
- LedgerQuote 字段类型

**更新 `tests/prompts.test.ts`**：schema 不含 userIntent/outcome；含"另行保存"说明。

**更新 `tests/summarizer.test.ts`**：mock 后端返回新 schema；断言 onLedger 收到机械字段；失败路径不写 ledger（回归）。

**更新 `tests/integration.test.ts` / `tests/extension.test.ts`**：涉及 LedgerData 构造的 fixture 增补字段。

## 影响文件

| 文件 | 改动 |
|---|---|
| src/ledger.ts | LedgerQuote、LedgerData/LedgerSummary 可选化、parseLedgerOutput 放宽、renderActionLedger 双格式 |
| src/util.ts | USER_MESSAGE_HEAD_CHARS、REPLY_HEAD/TAIL_CHARS、extractUserMessage、extractFinalReply |
| src/prompts.ts | 移除 userIntent/outcome 要求，schema 缩减 |
| src/summarizer.ts | summarize 闭包内机械提取 + onLedger 增补字段 |
| src/index.ts | recall 工具 description 微调 |
| README.md | ledger 格式说明更新 |
