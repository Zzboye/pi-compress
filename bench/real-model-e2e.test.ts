/**
 * 基准 ③b：真机端到端压缩（27B 单模型）——native > keepRecentTokens 的会话里，
 * 真实 ledger 替换窗外 turn 后的最终上下文规模。
 * 会话 = 8-turn 真实文件基线 + 2 个巨型读取 turn（70KB 计划文档 / 87KB 上下文转储，同 2026-09-01 e2e 场景）+ 中型 spec/lock 读取 + 收尾问答，native ≈ 43k tok ≫ 20k 窗口。
 *
 *   npx vitest run bench/real-model-e2e.test.ts
 */
import { describe, it, afterAll } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { SummarizerEngine, type SummarizerBackend } from "../src/summarizer.js";
import { renderActionLedger, type LedgerData } from "../src/ledger.js";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import { assembleContext } from "../src/assembler.js";
import type { AgentMessage } from "../src/types.js";

const results: Record<string, any> = {};
const outDir = join(process.cwd(), "e2e", "reports", "perf");
const ROOT = join(import.meta.dirname, "..");
const LMSTUDIO = { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "lm-studio" };
const MODEL = "qwen3.8-27b-uncensored";
const REQ_TIMEOUT_MS = 300_000;

async function serverUp(): Promise<boolean> {
  try { return (await fetch(`${LMSTUDIO.baseUrl}/models`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

function trimTo(t: string, b: number): string { return t.length <= b ? t : t.slice(0, b) + "\n…（截断）"; }

function msgOf(entries: MessageEntry[], role: AgentMessage["role"], content: any): MessageEntry {
  const e = { id: `e${String(entries.length + 1).padStart(4, "0")}`, message: { role, content, timestamp: 1700000000000 + entries.length * 1000 } as AgentMessage };
  entries.push(e);
  return e;
}
const text = (s: string) => [{ type: "text", text: s }];
let tc = 0;
const toolCall = (name: string, args: any) => ({ type: "toolCall", toolCallId: `tc${++tc}`, name, arguments: args });

/** 大读取 turn：一次读 2 个文件 */
function bigReadTurn(entries: MessageEntry[], ask: string, files: Array<{ path: string; text: string }>, conclude: string): void {
  msgOf(entries, "user", text(ask));
  msgOf(entries, "assistant", files.length > 1
    ? [...text("并行读这些文件"), ...files.map((f) => toolCall("read", { path: f.path }))]
    : [...text("读这个文件"), toolCall("read", { path: files[0].path })]);
  for (const f of files) msgOf(entries, "toolResult", text(f.text));
  msgOf(entries, "assistant", text(conclude));
}

function buildBigSession(): MessageEntry[] {
  const read = (p: string, cap: number) => ({ path: p, text: trimTo(readFileSync(join(ROOT, p), "utf8"), cap) });
  const readme = read("README.md", 12000);
  const assembler = read("src/assembler.ts", 6000);
  const summarizer = read("src/summarizer.ts", 8000);
  const ledger = read("src/ledger.ts", 6000);
  const recall = read("src/recall.ts", 4000);
  const store = read("src/store.ts", 4000);
  const config = read("src/config.ts", 6000);
  const forcepoint = read("src/forcepoint.ts", 3000);
  void recall; void store; void config; void forcepoint; void pkg; // 声明保留，部分未入会话
  const pkg = read("package.json", 800);

  const entries: MessageEntry[] = [];
  // 基线 8 turn（同 real-model.test.ts）
  msgOf(entries, "user", text("总结一下这个项目的压缩管线是怎么工作的"));
  msgOf(entries, "assistant", [...text("我来读 README"), toolCall("read", { path: "README.md" })]);
  msgOf(entries, "toolResult", text(readme.text));
  msgOf(entries, "assistant", text("管线分四步：agent_settled 后台摘要；动作日志落盘；context 事件 20k 窗口重组；recall 按 ID 取回原文。"));

  msgOf(entries, "user", text("窗口边界是怎么切的"));
  msgOf(entries, "assistant", [...text("看 assembler"), toolCall("read", { path: "src/assembler.ts" })]);
  msgOf(entries, "toolResult", text(assembler.text));
  msgOf(entries, "assistant", text("findWindowTurns 从尾部往前累计 token，超预算即停；单 turn 超预算整体保留。"));

  msgOf(entries, "user", text("摘要失败的重试逻辑"));
  msgOf(entries, "assistant", [...text("读 summarizer"), toolCall("read", { path: "src/summarizer.ts" })]);
  msgOf(entries, "toolResult", text(summarizer.text));
  msgOf(entries, "assistant", text("processWithRetry 指数退避重试；最终失败进 failedTurns，原文照发。"));

  msgOf(entries, "user", text("逐字校验怎么防编造"));
  msgOf(entries, "assistant", [...text("看 ledger.ts"), toolCall("read", { path: "src/ledger.ts" })]);
  msgOf(entries, "toolResult", text(ledger.text));
  msgOf(entries, "assistant", text("detail 里疑似路径必须能在 turnText 找到，否则剔除；target 只从机械清单取。"));

  // 巨型读取 turns（同 2026-09-01 e2e 报告的大文件场景）+ 中型读取 + 收尾问答
  bigReadTurn(entries, "看完整实现计划，摘要队列和强制点是怎么衔接的", [read("docs/superpowers/plans/2026-08-30-context-compress.md", 60000)], "确认 agent_settled 触发后台串行摘要队列，context 事件在超阈值时等待队列排空以执行重组。");
  bigReadTurn(entries, "把这份上下文转储里的装配统计和窗口边界分析一下", [read("e2e/reports/2026-09-05-current-context-dump.md", 60000)], "装配统计显示窗口切换符合 turn 边界不变量，窗外 turn 全部走动作日志替身。");
  bigReadTurn(entries, "设计文档里的验收标准是什么", [read("docs/superpowers/specs/2026-08-30-context-compress-design.md", 16000)], "验收围绕四个不变量：装配器永不阻塞、成对切换、target 逐字、session 只追加。");
  bigReadTurn(entries, "依赖树里有没有需要注意的包", [read("package-lock.json", 20000)], "依赖只有 vitest/typescript/pi 主包与 typebox，无传递风险。");

  // 收尾问答
  msgOf(entries, "user", text("整体看这套设计还有什么风险"));
  msgOf(entries, "assistant", text("主要风险是小模型摘要失真（已由逐字校验兜底）与 20k 窗口偏小（可配 + recall 兜底）。"));
  msgOf(entries, "user", text("v2 最该做的一件事是什么"));
  msgOf(entries, "assistant", text("动作日志合并：相邻同文件操作的 ledger 条目按阈值合并，进一步压低头部成本。"));

  return entries;
}

function tokensOf(messages: any[]): number {
  let t = 0;
  for (const m of messages) t += estimateTokens(m);
  return t;
}

describe("real-model-e2e: 真机端到端压缩（native > 窗口）", () => {
  it("14-turn 大会话 × 27B 真实 ledger → 装配后上下文", { timeout: 1_200_000 }, async () => {
    if (!(await serverUp())) {
      console.log("\n[real-model-e2e] LM Studio 不可达 → 跳过");
      results.skipped = "server unreachable";
      return;
    }
    const session = buildBigSession();
    const turns = splitIntoTurns(session);
    const nativeTokens = tokensOf(session.map((e) => e.message));
    console.log(`\n[e2e] 会话：${turns.length} turns / ${session.length} msgs / 原生 ${nativeTokens} tok（keepRecentTokens=20000）`);

    const ledgers = new Map<string, LedgerData>();
    let reqIdx = 0;
    const timedBackend: SummarizerBackend = {
      complete: async (prompt: string) => {
        reqIdx += 1;
        const t0 = performance.now();
        const res = await fetch(`${LMSTUDIO.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${LMSTUDIO.apiKey}` },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, stream: false }),
          signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        const ms = performance.now() - t0;
        const raw = json.choices?.[0]?.message?.content ?? "";
        console.log(`  req#${reqIdx} ${(prompt.length / 1000).toFixed(1)}k chars → ${ms.toFixed(0)}ms, out ${raw.length} chars`);
        return raw;
      },
    };
    const engine = new SummarizerEngine(timedBackend, {
      summarizer: { kind: "openai", baseUrl: LMSTUDIO.baseUrl, model: MODEL, apiKey: LMSTUDIO.apiKey },
      verbatimCheck: true, keepRecentTokens: 20000, forceRatio: 0.76,
      retry: { maxAttempts: 2, backoffMs: 1000 }, ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000, backfillLimit: 20,
    }, (d) => ledgers.set(d.turnStartEntryId, d), (m) => console.log(`  WARN: ${m}`));

    const t0 = performance.now();
    for (const t of turns) engine.enqueue(t);
    const drained = await engine.waitIdle(600_000);
    const catchupMs = performance.now() - t0;

    const { messages, stats } = assembleContext(session, ledgers, 20000);
    const after = tokensOf(messages);
    const ledgerTok = tokensOf([renderActionLedger([...ledgers.values()])]);
    results.e2e = {
      model: MODEL,
      turns: turns.length,
      nativeTokens,
      assembledTokens: after,
      savedPct: +(((nativeTokens - after) / nativeTokens) * 100).toFixed(1),
      ledgerTokensTotal: ledgerTok,
      summarised: ledgers.size,
      stats,
      catchupMs: +catchupMs.toFixed(0),
      drained,
    };
    console.log(`\n[e2e] 结果：${nativeTokens} → ${after} tok（省 ${results.e2e.savedPct}%）`);
    console.log(`  窗口 ${stats.windowTurns} / 替换 ${stats.replacedTurns} / 透传 ${stats.passthroughTurns}；ledger 总计 ${ledgerTok} tok`);
    console.log(`  追赶 ${catchupMs.toFixed(0)}ms（drained=${drained}）`);

    // 落盘装配后的完整上下文（LLM 实际看到的内容，可读格式）
    const ser = messages.map((m: any) => {
      const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "toolResult";
      const parts = (m.content as any[]).map((b: any) => {
        if (b.type === "text") return b.text;
        if (b.type === "toolCall") return `[toolCall] ${b.name}(${JSON.stringify(b.arguments)})`;
        return `[${b.type}]`;
      }).join("\n");
      return `<<${role}>>\n${parts}`;
    }).join("\n\n");
    const header = `# pi-compress 装配后的完整上下文（LLM 实际收到的内容）\n# 模型：${MODEL}（真实 ledger）\n# 原生 ${nativeTokens} tok → 装配后 ${after} tok（省 ${results.e2e.savedPct}%）\n# 动作日志 ${ledgers.size} turns（${ledgerTok} tok）+ 窗口 ${stats.windowTurns} turns 原文保留\n\n================================================================\n\n`;
    writeFileSync(join(outDir, "assembled-context.txt"), header + ser);
    console.log(`  装配后完整上下文已写入 ${join(outDir, "assembled-context.txt")}`);
  });
});

afterAll(() => {
  if (Object.keys(results).length === 0) return;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "real-model-e2e.json"), JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${join(outDir, "real-model-e2e.json")}`);
});
