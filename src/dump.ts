/**
 * /compress-dump 转储：把「本轮实际发给 LLM 的上下文」按已确认设计（形态 A）落盘。
 * 装配复用 context 事件同款 assembleContext（单一真相），b/c 项统计直接读装配时的
 * turn 划分，不做第二次独立计算——杜绝 dump 与真实装配口径漂移。
 */
import fs from "node:fs";
import { join } from "node:path";
import { countTokens, splitIntoTurns, type MessageEntry, type Turn } from "./util.js";
import type { ContextCompressConfig } from "./config.js";
import { assembleContext, findWindowTurns, turnTokens, type AssembleStats } from "./assembler.js";
import type { LedgerData } from "./ledger.js";
import type { AgentMessage } from "./types.js";

export interface DumpMessage {
  index: number;
  role: string;
  model?: string;
  /** 各 content 块的粗粒度类型（text/toolCall 等）；thinking 已被装配剥离，不会出现 */
  blocks: string[];
  /** 正文全文的字符数（text 块拼接；toolCall 计入 name+arguments） */
  chars: number;
  /** 与 turnTokens 相同口径的估算 token（assistant 跳 thinking） */
  tokens: number;
  /** 正文全文：text 块拼接；toolCall 块序列化 name+arguments */
  text: string;
}

export interface DumpTurn {
  startEntryId: string;
  endEntryId: string;
  tokens: number;
  /** lead = 窗口内原文；replaced = 窗外已折叠进 ledger；passthrough = 窗外无摘要原文照发 */
  lead: "lead" | "replaced" | "passthrough";
  ledger?: { userIntent?: string; outcome?: string };
}

export interface ContextDump {
  generatedAt: string;
  source: "slash-command";
  config: Pick<ContextCompressConfig, "keepRecentTokens" | "forceRatio" | "summarizer" | "summarizerFallback">;
  assembled: { total: number; chars: number; tokens: number };
  stats: AssembleStats;
  turns: DumpTurn[];
  messages: DumpMessage[];
}

const CONTEXT_BLOCK_TYPES = ["text", "toolCall", "toolResultContent", "image"];

/** content 块类型粗粒度提取；未知块类型以 other: 前缀标出便于发现装配口径变化 */
function blockTypes(message: AgentMessage): string[] {
  const content = (message as any).content;
  if (!Array.isArray(content)) return [];
  return content.map((b: any) => (CONTEXT_BLOCK_TYPES.includes(b?.type) ? b.type : `other:${b?.type ?? "unknown"}`));
}

/** 与 turnTokens 相同口径的逐条 message 体积估算（CJK 感知，见 util.countTokens） */
function messageTokens(m: AgentMessage): number {
  return countTokens(m, { skipThinking: true });
}

function messageText(m: AgentMessage): string {
  const content = (m as any).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "text") parts.push(b.text ?? "");
    else if (b?.type === "toolCall") parts.push(`[toolCall] ${b.name} ${JSON.stringify(b.arguments ?? {})}`);
    else parts.push(JSON.stringify(b));
  }
  return parts.join("\n");
}

/** 与真实装配同一次 turn 划分：窗外有摘要 → replaced（附 ledger 摘要），其余按窗口归属标注 */
function dumpTurns(turns: Turn[], window: Turn[], cache: Map<string, LedgerData>): DumpTurn[] {
  const windowStartIds = new Set(window.map((t) => t.startEntryId));
  return turns.map((t) => {
    const cached = cache.get(t.startEntryId);
    const lead: DumpTurn["lead"] = windowStartIds.has(t.startEntryId)
      ? "lead"
      : cached ? "replaced" : "passthrough";
    return {
      startEntryId: t.startEntryId,
      endEntryId: t.endEntryId,
      tokens: turnTokens(t),
      lead,
      ...(cached && lead === "replaced"
        ? { ledger: { userIntent: cached.summary.userIntent, outcome: cached.summary.outcome } }
        : {}),
    };
  });
}

/** 单一真相：dump 与 context 事件调用完全相同的 assembleContext + findWindowTurns */
export function dumpContext(
  branch: MessageEntry[],
  cache: Map<string, LedgerData>,
  config: ContextCompressConfig,
  now: Date = new Date(),
): ContextDump {
  const { messages, stats } = assembleContext(branch, cache, config.keepRecentTokens);
  const turns = splitIntoTurns(branch);
  const window = findWindowTurns(turns, config.keepRecentTokens);
  return {
    generatedAt: now.toISOString(),
    source: "slash-command",
    config: {
      keepRecentTokens: config.keepRecentTokens,
      forceRatio: config.forceRatio,
      summarizer: config.summarizer,
      summarizerFallback: config.summarizerFallback ? { ...config.summarizerFallback } : undefined,
    },
    assembled: {
      total: messages.length,
      chars: messages.reduce((s, m) => s + messageText(m).length, 0),
      tokens: messages.reduce((s, m) => s + messageTokens(m), 0),
    },
    stats,
    turns: dumpTurns(turns, window, cache),
    messages: messages.map((m, i) => ({
      index: i,
      role: (m as any).role,
      ...((m as any).model ? { model: (m as any).model } : {}),
      blocks: blockTypes(m),
      chars: messageText(m).length,
      tokens: messageTokens(m),
      text: messageText(m),
    })),
  };
}

/** Markdown 渲染：b 项元信息 + c 项统计 + a 项 messages 原文 */
export function renderMarkdown(d: ContextDump): string {
  const lines: string[] = [];
  lines.push(`# context-compress 上下文转储`);
  lines.push("");
  lines.push(`- 生成时间：${d.generatedAt}`);
  lines.push(`- 来源：斜杠命令 /compress-dump（装配口径与 context 事件完全一致）`);
  lines.push(`- keepRecentTokens：${d.config.keepRecentTokens} ｜ forceRatio：${d.config.forceRatio}`);
  lines.push(`- 摘要后端：${d.config.summarizer ? JSON.stringify(d.config.summarizer) : "未配置"}`);
  lines.push(`- 备用后端：${d.config.summarizerFallback ? JSON.stringify(d.config.summarizerFallback) : "未配置"}`);
  lines.push("");
  lines.push(`## 装配结果`);
  lines.push("");
  lines.push(`- messages 条数：${d.assembled.total}，字符数：${d.assembled.chars}，估算 token：${d.assembled.tokens}`);
  lines.push(`- 窗口 ${d.stats.windowTurns} turns ｜ 替换为 ledger ${d.stats.replacedTurns} turns ｜ 窗外原文照发 ${d.stats.passthroughTurns} turns`);
  lines.push("");
  lines.push(`## turns`);
  lines.push("");
  lines.push(`| # | startEntryId | lead | tokens | ledger 摘要 |`);
  lines.push(`|---|---|---|---|---|`);
  d.turns.forEach((t, i) => {
    const ledger = t.ledger
      ? [t.ledger.userIntent, t.ledger.outcome].filter(Boolean).join(" / ")
      : (t.lead === "passthrough" ? "（窗外无摘要 → 原文照发）" : "");
    lines.push(`| ${i + 1} | ${t.startEntryId} | ${t.lead} | ${t.tokens} | ${ledger} |`);
  });
  lines.push("");
  lines.push(`## messages 原文`);
  lines.push("");
  for (const m of d.messages) {
    lines.push(`### #${m.index} ${m.role}${m.model ? ` (${m.model})` : ""} — ${m.chars} chars / ~${m.tokens} tok ｜ blocks: ${m.blocks.join(", ")}`);
    lines.push("");
    lines.push("```");
    lines.push(m.text);
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

/** 双份落盘：<base>.md + <base>.json（父目录不存在则递归创建），返回实际写入的绝对路径 */
export function writeContextDump(d: ContextDump, base: string): string[] {
  const mdPath = `${base}.md`;
  const jsonPath = `${base}.json`;
  fs.mkdirSync(join(base, ".."), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(d), "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(d, null, 2), "utf8");
  return [mdPath, jsonPath];
}

export function defaultDumpBase(cwd: string = process.cwd()): string {
  return join(cwd, "e2e", "reports", `${Date.now()}-context-dump`);
}
