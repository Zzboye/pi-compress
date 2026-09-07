export interface ToolActionInfo { action: string; target: string; entryIds: string[] }

export function buildSummarizePrompt(turnText: string, actions: ToolActionInfo[]): string {
  const actionList = actions.map((a) => `- action=${a.action} target=${a.target} recallIds=${a.entryIds.join(",")}`).join("\n");
  return `你是编码会话的动作记录员。将这一轮对话压缩为结构化动作日志。

规则：
1. target 与 recallIds 必须使用下面清单给出的值，逐字复制，禁止改写
2. detail 一句话，写结论不写过程；detail 中出现的文件路径/命令必须能在对话原文中找到
3. 按 phase 分组：investigate（调查）/ fix（修改）/ verify（验证）/ discuss（讨论）/ other
4. thinking 内容不摘要，直接忽略
5. 用户消息与最终回复由系统另行逐字保存，无需你概括；只压缩工具动作

工具动作清单（机械提取，不可修改）：
${actionList}

对话原文：
<conversation>
${turnText}
</conversation>

只输出 JSON，不要输出其他内容。schema：
{"groups": [{"phase": "investigate|fix|verify|discuss|other", "entries": [{"target": string（必须来自清单）, "detail": string, "phase": string（可选，用于覆盖分组）}]}]}`;
}
