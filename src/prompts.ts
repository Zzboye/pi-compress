export interface ToolActionInfo { action: string; target: string; entryIds: string[] }

export function buildSummarizePrompt(turnText: string, actions: ToolActionInfo[]): string {
  const actionList = actions.map((a) => `- action=${a.action} target=${a.target} recallIds=${a.entryIds.join(",")}`).join("\n");
  return `你是编码会话的动作记录员。将这一轮对话压缩为结构化动作日志。

规则：
1. target 必须使用下面清单给出的值，逐字复制，禁止改写；每条必须带 phase
2. detail 一句话，写结论不写过程；detail 中出现的文件路径/命令必须能在对话原文中找到
3. phase 取 investigate（调查）/ fix（修改）/ verify（验证）/ discuss（讨论）/ other 之一
4. 输出顺序无关（系统按清单时间序机械归位），但不得遗漏、不得重复、不得编造清单外的 target
5. thinking 内容不摘要，直接忽略
6. 用户消息与最终回复由系统另行逐字保存，无需你概括；只压缩工具动作

工具动作清单（机械提取，不可修改）：
${actionList}

对话原文：
<conversation>
${turnText}
</conversation>

只输出 JSON，不要输出其他内容。schema：
{"entries": [{"target": string（必须来自清单）, "detail": string, "phase": "investigate|fix|verify|discuss|other"}]}`;
}

export function buildIntentOutcomePrompt(userText: string, replyText: string): string {
  return `压缩这一轮对话的两端为一行式摘要。

规则：
1. userIntent：用户这轮想要什么，≤20 字，动宾短语
2. outcome：模型最终达成了什么结论/结果，≤30 字，写结论不写过程
3. 不复述原文，只提炼

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

export function buildMergeDescriptionPrompt(turnTexts: string[]): string {
  return `把以下 ${turnTexts.length} 轮已压缩的动作日志合并为一行主题描述。

规则：
1. 概括这 ${turnTexts.length} 轮共同做了什么，≤25 字
2. 不输出条数（系统会追加"（N 条已合并）"）
3. 只输出 JSON：{"description": string}

各轮日志：
${turnTexts.map((t, i) => `--- 第 ${i + 1} 轮 ---\n${t}`).join("\n")}`;
}
