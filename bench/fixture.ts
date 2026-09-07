/**
 * 确定性基准夹具：生成与真实编码会话同构的 turn 流与 mock 动作日志。
 * 固定种子（mulberry32）保证可复现；turn 形态分布对齐真实开发会话。
 */
import type { AgentMessage } from "../src/types.js";
import type { LedgerData } from "../src/ledger.js";
import type { MessageEntry, Turn } from "../src/util.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE_LINES = [
  'import { useCallback, useEffect, useRef, useState } from "react";',
  "export interface SessionEntry { id: string; type: string; data?: unknown }",
  "const PATH_RE = /[\\w./\\\\-]+\\.\\w{1,4}/g; // 提取疑似路径做逐字校验",
  "export function findWindowTurns(turns: Turn[], budget: number): Turn[] {",
  "  const window: Turn[] = [];",
  "  let total = 0;",
  "  for (let i = turns.length - 1; i >= 0; i--) {",
  "    const cost = estimateTokens(turns[i].message);",
  "    if (window.length > 0 && total + cost > budget) break;",
  "    window.unshift(turns[i]);",
  "    total += cost;",
  "  }",
  "  return window;",
  "}",
  "async function drain(): Promise<void> {",
  "  while (queue.length > 0) {",
  "    const item = queue.shift()!;",
  "    await processWithRetry(item);",
  "  }",
  "}",
  "// 结论在头部保新鲜（primacy），近期窗口在尾部保时序（recency）",
  "export class LedgerStore {",
  "  private cache = new Map<string, LedgerData>();",
  "  get(key: string): LedgerData | undefined { return this.cache.get(key); }",
  "}",
];

function fileContent(rng: () => number, bytes: number): string {
  const lines: string[] = [];
  let n = 0;
  while (n < bytes) {
    const line = CODE_LINES[Math.floor(rng() * CODE_LINES.length)];
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join("\n");
}

export type TurnKind = "qa" | "read" | "edit" | "bash" | "multiread";

export interface GenOptions {
  turns: number;
  seed?: number;
  /** toolResult 内容字节数分布（累积概率 [上限, 字节]），默认对齐真实会话 */
  sizeMix?: Array<[number, number]>;
}

const DEFAULT_SIZE_MIX: Array<[number, number]> = [
  [0.3, 800],      // 小输出（编辑回执/短命令）
  [0.75, 6000],    // 中等（普通文件读取）
  [0.95, 35000],   // 大（长文件/测试输出）
  [1.0, 90000],    // 巨大（超长日志）
];

let idCounter = 0;
export function resetIds(): void { idCounter = 0; }
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${String(idCounter).padStart(5, "0")}`;
}

let tsCounter = 0;
function nextTs(): number { tsCounter += 1000; return tsCounter; }

const USER_ASKS = [
  "总结一下这个模块的设计思路",
  "读一下 src/hooks.ts 看有没有内存泄漏",
  "跑一下测试，把失败的修掉",
  "这个报错是什么意思，怎么修",
  "把 recall 的截断上限提到 6000",
  "看看 assembler 的窗口边界逻辑",
  "帮我重构这段重复代码",
  "为什么逐字校验对无扩展名路径不生效",
];

const ASSIST_STUBS = [
  "我来看一下相关代码",
  "先读文件确认现状",
  "定位到了问题，动手修",
  "改完了，跑测试验证",
];

/** 生成一个 turn 的消息序列（不包含 user 之外的起始边界处理，user 始终开头） */
export function genTurn(rng: () => number, kind: TurnKind, sizeMix: Array<[number, number]>): MessageEntry[] {
  const entries: MessageEntry[] = [];
  const push = (role: AgentMessage["role"], content: any): MessageEntry => {
    const e = { id: nextId("e"), message: { role, content, timestamp: nextTs() } as AgentMessage };
    entries.push(e);
    return e;
  };
  const text = (s: string) => [{ type: "text", text: s }];

  push("user", text(USER_ASKS[Math.floor(rng() * USER_ASKS.length)]));
  if (kind === "qa") {
    push("assistant", text("这个问题的核心在于窗口边界只落在 turn 边界上，toolCall 与 toolResult 必须成对。"));
    return entries;
  }

  const toolResultBytes = (() => {
    const r = rng();
    for (const [upper, bytes] of sizeMix) if (r < upper) return Math.floor(bytes * (0.7 + rng() * 0.6));
    return 5000;
  })();

  const makeToolCall = (name: string, args: Record<string, string>, tcId: string) => ({
    type: "toolCall", toolCallId: tcId, name, arguments: args,
  });

  if (kind === "read" || kind === "multiread") {
    const count = kind === "multiread" ? 2 : 1;
    const tcs: any[] = [];
    for (let i = 0; i < count; i++) {
      const tcId = `tc_${nextId("c")}`;
      tcs.push(tcId);
      push("assistant", [
        { type: "text", text: ASSIST_STUBS[Math.floor(rng() * ASSIST_STUBS.length)] },
        makeToolCall("read", { path: `src/module${i}/impl.ts` }, tcId),
      ]);
    }
    for (const tcId of tcs) push("toolResult", text(fileContent(rng, toolResultBytes)));
    push("assistant", text("结论：该模块的窗口逻辑与 turn 边界处理符合设计不变量，无需修改。"));
    return entries;
  }

  const toolName = kind === "edit" ? "edit" : "bash";
  const tcId = `tc_${nextId("c")}`;
  push("assistant", [
    { type: "text", text: ASSIST_STUBS[Math.floor(rng() * ASSIST_STUBS.length)] },
    makeToolCall(toolName, kind === "edit"
      ? { path: "src/assembler.ts", oldText: "return window;", newText: "return window; // 修正" }
      : { command: "npx vitest run tests/assembler.test.ts" }, tcId),
  ]);
  push("toolResult", text(kind === "edit"
    ? "Successfully replaced 1 block(s) in src/assembler.ts"
    : `✓ tests/assembler.test.ts (7 tests)\nTest Files 1 passed (1)\n${"-".repeat(Math.min(600, toolResultBytes / 8))}`));
  push("assistant", text(kind === "edit" ? "已修改，验证通过。" : "测试全部通过，健康。"));
  return entries;
}

export function pickKind(rng: () => number): TurnKind {
  const r = rng();
  if (r < 0.15) return "qa";
  if (r < 0.55) return "read";
  if (r < 0.75) return "edit";
  if (r < 0.9) return "bash";
  return "multiread";
}

/** 生成完整会话分支（turn 边界 = user 消息开头） */
export function genSession(opts: GenOptions): MessageEntry[] {
  const rng = mulberry32(opts.seed ?? 42);
  const sizeMix = opts.sizeMix ?? DEFAULT_SIZE_MIX;
  resetIds();
  const entries: MessageEntry[] = [];
  for (let i = 0; i < opts.turns; i++) {
    entries.push(...genTurn(rng, pickKind(rng), sizeMix));
  }
  return entries;
}

/** 生成与 turn 对应的 mock 动作日志（形态对齐真实小模型输出，~120-220 tok/turn） */
export function genLedgers(turns: Turn[]): Map<string, LedgerData> {
  const rng = mulberry32(1337);
  const cache = new Map<string, LedgerData>();
  const phases = ["investigate", "fix", "verify", "discuss", "other"] as const;
  for (const t of turns) {
    const actions: Array<{ action: string; target: string; recallIds: string[] }> = [];
    for (const e of t.entries) {
      if (e.message.role !== "assistant") continue;
      for (const block of e.message.content as any[]) {
        if (block?.type !== "toolCall") continue;
        const target = block.arguments?.path ?? block.arguments?.command ?? block.name;
        actions.push({ action: block.name, target: String(target), recallIds: [e.id] });
      }
    }
    const group = phases[Math.floor(rng() * phases.length)];
    cache.set(t.startEntryId, {
      turnStartEntryId: t.startEntryId,
      turnEndEntryId: t.endEntryId,
      summary: {
        userIntent: "定位窗口边界与摘要队列的衔接问题并验证",
        outcome: "确认了装配器只切 turn 边界、缺摘要原文照发的不变量",
        groups: [{
          phase: group,
          entries: actions.slice(0, 3).map((a) => ({
            action: a.action,
            target: a.target,
            detail: "读取模块实现确认窗口边界处理符合设计不变量，测试全部通过",
            recallIds: a.recallIds,
          })),
        }],
      },
    });
  }
  return cache;
}
