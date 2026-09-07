/**
 * 微基准 ①：纯本地路径（无模型调用）——前台装配、recall、store 重建、摘要管线框架开销。
 * 结果打印 + 写 JSON 供报告汇编。
 *
 *   npx vitest run bench/micro.test.ts
 */
import { describe, it, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assembleContext } from "../src/assembler.js";
import { splitIntoTurns, serializeTurn } from "../src/util.js";
import { executeRecall } from "../src/recall.js";
import { LedgerStore } from "../src/store.js";
import { SummarizerEngine } from "../src/summarizer.js";
import { buildSummarizePrompt } from "../src/prompts.js";
import { parseLedgerOutput, renderActionLedger } from "../src/ledger.js";
import { computeBackfillTurns } from "../src/backfill.js";
import { enforceForcePoint } from "../src/forcepoint.js";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { genSession, genLedgers } from "./fixture.js";
import { bench, fmt, heapMB } from "./stats.js";

const results: Record<string, any> = {};
const outDir = join(process.cwd(), "e2e", "reports", "perf");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const VALID_JSON = JSON.stringify({
  userIntent: "定位窗口边界问题并验证",
  outcome: "确认装配器只切 turn 边界",
  groups: [{ phase: "investigate", entries: [{ target: "src/module0/impl.ts", detail: "读取 src/module0/impl.ts 确认边界处理", phase: "investigate" }] }],
});

describe("micro: assembler 前台路径", () => {
  it("splitIntoTurns / assembleContext @ 递增会话规模", () => {
    const rows: any[] = [];
    for (const n of [50, 100, 300, 1000, 2000]) {
      const session = genSession({ turns: n, seed: 42 });
      const turns = splitIntoTurns(session);
      const cache = genLedgers(turns);

      const tSplit = bench(() => splitIntoTurns(session), 30, 3);
      const tAssembleAll = bench(() => assembleContext(session, cache, 20000), 30, 3);
      const tAssembleNone = bench(() => assembleContext(session, new Map(), 20000), 30, 3);

      const { messages, stats } = assembleContext(session, cache, 20000);
      rows.push({
        turns: n,
        messages: session.length,
        assembledMessages: messages.length,
        stats,
        splitIntoTurns_ms: tSplit,
        assemble_allSummarized_ms: tAssembleAll,
        assemble_noLedger_passthrough_ms: tAssembleNone,
      });
      console.log(`\n[assembler] ${n} turns / ${session.length} msgs:`);
      console.log(`  splitIntoTurns            ${fmt(tSplit)}`);
      console.log(`  assemble (全有摘要)        ${fmt(tAssembleAll)}`);
      console.log(`  assemble (无摘要透传)      ${fmt(tAssembleNone)}`);
      console.log(`  stats: 窗口 ${stats.windowTurns} / 替换 ${stats.replacedTurns} / 透传 ${stats.passthroughTurns}`);
    }
    results.assembler = rows;
  });

  it("renderActionLedger @ 递增已摘要 turn 数", () => {
    const rows: any[] = [];
    for (const n of [50, 200, 1000]) {
      const session = genSession({ turns: n, seed: 7 });
      const turns = splitIntoTurns(session);
      const ledgers = [...genLedgers(turns).values()];
      const s = bench(() => renderActionLedger(ledgers), 30, 3);
      rows.push({ ledgerTurns: n, render_ms: s });
      console.log(`\n[ledger-render] ${n} turns: ${fmt(s)}`);
    }
    results.ledgerRender = rows;
  });
});

describe("micro: 摘要器纯计算路径", () => {
  it("serializeTurn / prompt 构建 / parse+verbatim 校验", () => {
    const session = genSession({ turns: 30, seed: 42 });
    const turns = splitIntoTurns(session);
    const big = turns.reduce((a, b) => (b.entries.length > a.entries.length ? b : a));
    const sSer = bench(() => serializeTurn(turns[1]), 50, 5);
    const sSerBig = bench(() => serializeTurn(big), 50, 5);

    const turnText = serializeTurn(turns[1]);
    const actions = turns[1].entries.flatMap((e) =>
      (e.message.role === "assistant" ? (e.message.content as any[]).filter((b) => b.type === "toolCall") : [])
        .map((b) => ({ action: b.name, target: String(b.arguments?.path ?? b.name), entryIds: [e.id] })));
    const sPrompt = bench(() => buildSummarizePrompt(turnText, actions), 50, 5);
    const sParse = bench(() => parseLedgerOutput(VALID_JSON, actions, turnText, true), 50, 5);

    results.summarizerPure = { serialize_small_ms: sSer, serialize_bigTurn_ms: sSerBig, buildPrompt_ms: sPrompt, parseVerbatim_ms: sParse };
    console.log(`\n[summarizer-pure]`);
    console.log(`  serializeTurn(普通turn)   ${fmt(sSer)}`);
    console.log(`  serializeTurn(最大turn)   ${fmt(sSerBig)}`);
    console.log(`  buildSummarizePrompt      ${fmt(sPrompt)}`);
    console.log(`  parseLedgerOutput+校验    ${fmt(sParse)}`);
  });

  it("SummarizerEngine 端到端队列（mock 模型）：框架开销 = 墙钟 - 模型时间", async () => {
    const rows: any[] = [];
    for (const latency of [5, 50, 200]) {
      let modelMs = 0;
      const backend = {
        complete: async () => { const t0 = performance.now(); await sleep(latency); modelMs += performance.now() - t0; return VALID_JSON; },
      };
      const engine = new SummarizerEngine(backend, mockConfig(), () => {}, () => {});
      const session = genSession({ turns: 20, seed: 99 });
      const turns = splitIntoTurns(session);

      const t0 = performance.now();
      modelMs = 0;
      for (const t of turns) engine.enqueue(t);
      const ok = await engine.waitIdle(60000);
      const wall = performance.now() - t0;
      const overhead = wall - modelMs;
      rows.push({ latency, turns: turns.length, wallMs: wall, modelMs, overheadMs: overhead, drained: ok });
      console.log(`\n[engine] mock 模型延迟 ${latency}ms × ${turns.length} turns:`);
      console.log(`  墙钟 ${wall.toFixed(1)}ms = 模型 ${modelMs.toFixed(1)} + 框架 ${overhead.toFixed(1)}ms（每 turn ${(overhead / turns.length).toFixed(2)}ms）  drained=${ok}`);
    }
    results.enginePipeline = rows;
  }, 60_000);

  it("SummarizerEngine 重试路径：约 1/3 首试失败，退避计入墙钟", async () => {
    let modelMs = 0;
    let calls = 0;
    const backend = {
      complete: async () => {
        calls += 1;
        const t0 = performance.now(); await sleep(10); modelMs += performance.now() - t0;
        if (calls % 3 === 1) return "not-json"; // 每 3 次调用第 1 次失败 → 单 turn 首试必败
        return VALID_JSON;
      },
    };
    const engine = new SummarizerEngine(backend, { ...mockConfig(), retry: { maxAttempts: 3, backoffMs: 50 } }, () => {}, () => {});
    const session = genSession({ turns: 20, seed: 99 });
    const turns = splitIntoTurns(session);
    const t0 = performance.now();
    for (const t of turns) engine.enqueue(t);
    await engine.waitIdle(60000);
    const wall = performance.now() - t0;
    results.engineRetry = { turns: turns.length, modelCalls: calls, wallMs: wall, modelMs, note: "backoffMs=50，失败的 turn 退避 50ms 后重试成功" };
    console.log(`\n[engine-retry] 20 turns，backoffMs=50:`);
    console.log(`  模型调用 ${calls} 次，墙钟 ${wall.toFixed(0)}ms（模型 ${modelMs.toFixed(0)}ms + 退避+框架）`);
  }, 60_000);
});

describe("micro: recall / store / backfill / forcepoint", () => {
  it("executeRecall：大规模分支上的 Map 构建与批量取回", () => {
    const rows: any[] = [];
    for (const n of [300, 1000, 3000]) {
      const session = genSession({ turns: n, seed: 42 });
      const ids = session.filter((_, i) => i % 50 === 0).slice(0, 10).map((e) => e.id);
      const s = bench(() => executeRecall(ids, session, 4000), 30, 3);
      const r = executeRecall(ids, session, 4000);
      rows.push({ branchMessages: session.length, batchIds: ids.length, recall_ms: s, missing: r.missing.length, outChars: r.text.length });
      console.log(`\n[recall] 分支 ${session.length} 条消息，批量 ${ids.length} ID: ${fmt(s)}  未中 ${r.missing.length}`);
    }
    results.recall = rows;
  });

  it("LedgerStore.rebuildFromEntries（session_start 恢复路径）@ 递增规模", () => {
    const rows: any[] = [];
    for (const n of [500, 2000, 5000]) {
      const turns = splitIntoTurns(genSession({ turns: n, seed: 42 }));
      const ledgers = genLedgers(turns);
      const customEntries = [...ledgers.values()].map((d) => ({ id: `cust_${d.turnStartEntryId}`, type: "custom", customType: "context-compress:ledger", data: d }));
      const messageEntries = turns.flatMap((t) => t.entries.map((e) => ({ id: e.id, type: "message", message: e.message })));
      const all: any[] = [...messageEntries, ...customEntries];
      const store = new LedgerStore();
      const s = bench(() => store.rebuildFromEntries(all), 20, 3);
      rows.push({ branchEntries: all.length, rebuild_ms: s, storeSize: store.size() });
      console.log(`\n[store-rebuild] ${all.length} entries: ${fmt(s)}  恢复 ${store.size()} 条 ledger`);
    }
    results.storeRebuild = rows;
  });

  it("computeBackfillTurns（补摘 diff）@ 1000 turns", () => {
    const turns = splitIntoTurns(genSession({ turns: 1000, seed: 42 }));
    const partial = new Map([...genLedgers(turns).entries()].filter((_, i) => i % 3 === 0));
    const lookup = { get: (k: string) => partial.get(k) };
    const s = bench(() => computeBackfillTurns(turns, lookup, 20), 30, 3);
    results.backfill = { turns: turns.length, diff_ms: s };
    console.log(`\n[backfill] 1000 turns（1/3 已摘，limit=20）: ${fmt(s)}`);
  });

  it("enforceForcePoint 三分支决策", async () => {
    const queuePass = { pending: () => 0, waitIdle: async () => true };
    const queueWait = { pending: () => 3, waitIdle: async () => true };
    const queueTimeout = { pending: () => 3, waitIdle: async () => false };
    const tPass = bench(() => enforceForcePoint({ tokens: 100 }, 200000, 0.76, queuePass, 100, () => {}));
    const tWait = bench(() => enforceForcePoint({ tokens: 180000 }, 200000, 0.76, queueWait, 100, () => {}));
    const t0 = performance.now();
    const d = await enforceForcePoint({ tokens: 180000 }, 200000, 0.76, queueTimeout, 100, () => {});
    const tTimeout = performance.now() - t0;
    results.forcepoint = { pass_ms: tPass, wait_ms: tWait, timeout_ms: tTimeout, timeoutDecision: d };
    console.log(`\n[forcepoint] pass ${tPass.mean.toFixed(3)}ms / waited ${tWait.mean.toFixed(3)}ms / 降级=${d}（等待 ${tTimeout.toFixed(0)}ms 超时）`);
  });

  it("内存足迹：2000-turn 会话 + 全量 ledger 缓存", () => {
    const before = heapMB();
    const session = genSession({ turns: 2000, seed: 42 });
    const afterSession = heapMB();
    const turns = splitIntoTurns(session);
    const ledgers = genLedgers(turns);
    const afterLedgers = heapMB();
    let nativeTokens = 0;
    for (const e of session) nativeTokens += estimateTokens(e.message);
    results.memory = {
      sessionMessages: session.length,
      sessionHeapMB: +(afterSession - before).toFixed(1),
      ledgersHeapMB: +(afterLedgers - afterSession).toFixed(1),
      nativeTokens,
    };
    console.log(`\n[memory] 2000-turn 会话：消息堆 ${results.memory.sessionHeapMB}MB，ledger 缓存堆 ${results.memory.ledgersHeapMB}MB，原生总 token ≈ ${nativeTokens}`);
  });
});

afterAll(() => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "micro.json"), JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${join(outDir, "micro.json")}`);
});

function mockConfig() {
  return { summarizer: undefined, verbatimCheck: true, keepRecentTokens: 20000, forceRatio: 0.76, retry: { maxAttempts: 3, backoffMs: 2000 }, ledgerMergeThreshold: 40, backfillLimit: 20 };
}
