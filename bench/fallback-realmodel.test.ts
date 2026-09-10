/**
 * 真机冒烟：备用后端切换链路（LM Studio 在线时运行，离线自动跳过）。
 * 主后端 = LM Studio qwen3.8-27b（64k 窗口），构造超窗 prompt 触发真实 HTTP 400 溢出；
 * 备用 A = 本地 mock 大模型服务器（成功路径）；备用 B = LM Studio 自身（双失败路径）。
 *
 *   npx vitest run bench/fallback-realmodel.test.ts
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { SummarizerEngine, createOpenAICompatBackend, isContextOverflow } from "../src/summarizer.js";
import { splitIntoTurns, type MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

const LMSTUDIO = { baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.8-27b-uncensored", apiKey: "lm-studio" };

async function serverUp(): Promise<boolean> {
  try { return (await fetch(`${LMSTUDIO.baseUrl}/models`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

/** 超窗 turn：user 巨型文本（serializeConversation 不截断 user/assistant 文本）→ prompt ≈ 100k tok > 27B 的 64k 窗口 */
function oversizedTurn(): { turn: ReturnType<typeof splitIntoTurns>[number]; promptEstTokens: number } {
  const bigText = "长".repeat(400_000); // ≈100k tok（CJK ≈1 字符/token）
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: `分析这段规格：${bigText}` }] } as AgentMessage },
    { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "结论" }] } as AgentMessage },
  ];
  const turn = splitIntoTurns(entries)[0];
  return { turn, promptEstTokens: bigText.length };
}

function mockBigModelServer(): Promise<{ server: http.Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      hits += 1;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            userIntent: "备用大模型处理超大 turn",
            outcome: "大上下文模型成功摘要",
            groups: [],
          }) } }],
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as any).port, hits: () => hits }));
  });
}

describe("fallback real-model smoke", () => {
  it("overflow error classification", () => {
    expect(isContextOverflow(new Error("summarizer HTTP 400"))).toBe(true);
    expect(isContextOverflow(new Error("input length exceeds context length"))).toBe(true);
    expect(isContextOverflow(new Error("This model's maximum context length is 8192 tokens"))).toBe(true);
    expect(isContextOverflow(new Error("summarizer HTTP 500"))).toBe(false);
    expect(isContextOverflow(new Error("fetch failed"))).toBe(false);
    expect(isContextOverflow(new Error("model output is not valid JSON"))).toBe(false);
  });

  it("real overflow (LM Studio 400) → fallback mock big model succeeds on first try", { timeout: 120_000 }, async () => {
    if (!(await serverUp())) { console.log("\n[smoke] LM Studio 不可达 → 跳过"); return; }
    const { server, port, hits } = await mockBigModelServer();
    try {
      const { turn, promptEstTokens } = oversizedTurn();
      const onLedger = (d: any) => { ledgerDone = d; };
      let ledgerDone: any = null;
      const warnings: string[] = [];
      const primary = createOpenAICompatBackend(LMSTUDIO);
      const fallback = createOpenAICompatBackend({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock-big-model" });
      const engine = new SummarizerEngine(
        primary,
        { summarizer: undefined, summarizerFallback: undefined, verbatimCheck: true, keepRecentTokens: 20000, forceRatio: 0.76, retry: { maxAttempts: 3, backoffMs: 2000 }, ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000, backfillLimit: 20 },
        onLedger, (m) => warnings.push(m), fallback,
      );

      const t0 = performance.now();
      engine.enqueue(turn);
      const drained = await engine.waitIdle(110_000);
      const elapsed = performance.now() - t0;

      console.log(`\n[smoke-A] prompt ≈${(promptEstTokens / 1000).toFixed(0)}k tok → 主后端真实 400 → 备用接管`);
      console.log(`  总耗时 ${elapsed.toFixed(0)}ms（若烧完退避应 ≥2s+4s）、备用命中 ${hits()} 次、drained=${drained}、警告 ${warnings.length} 条`);
      expect(drained).toBe(true);
      expect(hits()).toBe(1);                       // 快速切换：备用第一发就上
      expect(elapsed).toBeLessThan(4000);           // 未烧退避
      expect(ledgerDone?.summary.userIntent).toContain("备用大模型");
      expect(warnings.length).toBe(0);
    } finally {
      server.close();
    }
  });

  it("real overflow + fallback also overflows (LM Studio again) → failed with dual-backend warning", { timeout: 120_000 }, async () => {
    if (!(await serverUp())) { console.log("\n[smoke] LM Studio 不可达 → 跳过"); return; }
    const { turn } = oversizedTurn();
    const onLedgerCalls: number[] = [];
    const warnings: string[] = [];
    const engine = new SummarizerEngine(
      createOpenAICompatBackend(LMSTUDIO),
      { summarizer: undefined, summarizerFallback: undefined, verbatimCheck: true, keepRecentTokens: 20000, forceRatio: 0.76, retry: { maxAttempts: 2, backoffMs: 500 }, ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000, backfillLimit: 20 },
      () => onLedgerCalls.push(1), (m) => warnings.push(m),
      createOpenAICompatBackend(LMSTUDIO), // 备用 = 同一 64k 模型 → 也溢出
    );

    const t0 = performance.now();
    engine.enqueue(turn);
    const drained = await engine.waitIdle(110_000);
    const elapsed = performance.now() - t0;

    console.log(`\n[smoke-B] 主/备双溢出 → ${elapsed.toFixed(0)}ms（含 500ms 退避 + 两次真实 400），drained=${drained}`);
    console.log(`  警告：${warnings[0]}`);
    expect(drained).toBe(true);
    expect(engine.failed().has("u1")).toBe(true);
    expect(onLedgerCalls.length).toBe(0);
    expect(warnings[0]).toContain("摘要失败");
    expect(warnings[0]).toContain("备用后端也失败");
  });
});
