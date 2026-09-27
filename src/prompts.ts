import type { LedgerData } from "./ledger.js";

export interface ToolActionInfo { action: string; target: string; entryIds: string[] }

export function buildSummarizePrompt(turnText: string, actions: ToolActionInfo[]): string {
  const actionList = actions.map((a, i) => `- id=${i} action=${a.action} target=${a.target} recallIds=${a.entryIds.join(",")}`).join("\n");
  return `你是编码会话的动作记录员。将这一轮对话压缩为结构化动作日志。

规则：
1. 每条必须带 id（清单中的序号，逐字复制）与 phase；同一路径先读后写等多条同 target 动作靠 id 区分，禁止省略
2. detail 一句话，写结论不写过程；detail 中出现的文件路径/命令必须能在对话原文中找到
3. phase 取 investigate（调查）/ fix（修改）/ verify（验证）/ discuss（讨论）/ other 之一
4. 输出顺序无关（系统按清单时间序机械归位），但不得遗漏、不得重复、不得编造清单外的 id
5. thinking 内容不摘要，直接忽略
6. 用户消息与最终回复由系统另行逐字保存，无需你概括；只压缩工具动作

工具动作清单（机械提取，不可修改）：
${actionList}

对话原文：
<conversation>
${turnText}
</conversation>

只输出 JSON，不要输出其他内容。schema：
{"entries": [{"id": number（必须来自清单）, "detail": string, "phase": "investigate|fix|verify|discuss|other"}]}`;
}

export function buildIntentOutcomePrompt(userText: string, replyText: string): string {
  return `对下文做摘要。

摘要应包含（有则写，无则略）：
- 核心结论 / 判定（如 Approved、Needs Fix）
- 关键参数与标识（文件名、commit、测试数、配置值）
- 限制条件
- 待办 / 风险 / 遗留问题

剔除：重复描述、背景科普、举例、客套话、过程叙述。
模型回复若是列表/分条目结构，摘要保留这些条目（每条压成一句），不要合并成一段总述。
用 "；" 分隔各要点，不要写成长段落。

userIntent：用户这轮想要什么（一句话，动宾表述）
outcome：上述摘要

用户消息原文：
<user>
${userText}
</user>

模型最终回复原文：
<reply>
${replyText}
</reply>

只输出 JSON：{"userIntent": string, "outcome": string}`;
}

/**
 * 批量二次压缩（L4→L5）：一次提交 N 条 L4，逐条输出一条描述，序号一一对应。
 * 正文为用户给定提示词（2026-09-27 探针验证：2 批各 20 条，零缺失、零串位、压缩率 0.492）。
 * 见 docs/evidence/l5-prompt-verify.txt。
 */
export function buildBatchRecompressPrompt(items: LedgerData[]): string {
  const blocks = items
    .map((l, i) => `[#${i + 1}]\n意图：${l.summary.userIntent ?? ""}\n结果：${l.summary.outcome ?? ""}`)
    .join("\n\n");
  return `请对以下已经完成过一次摘要的内容做二次摘要。
要求：
1. 剔除冗余细节（commit哈希、具体文件路径、零散函数名等），保留核心结论、关键变更、产出物、待办事项
2. 按原有顺序梳理逻辑，不新增信息，不丢失主线节点
3. 语言凝练，篇幅压缩到原文的1/2以内

下面是 ${items.length} 条独立内容，每条以 "[#序号]" 开头：

${blocks}

逐条输出，每条各占一项，必须与输入条数相同（共 ${items.length} 条），序号一一对应。
只输出 JSON：{"items": [{"index": number, "description": string}, ...]}`;
}
