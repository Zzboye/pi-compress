/**
 * 基准 ②：压缩效果——原生上下文 token vs 装配后 token（与 findWindowTurns 同口径 estimateTokens）。
 * mock 动作日志（形态对齐真实小模型输出）。真实模型的端到端见 real-model.test.ts。
 *
 *   npx vitest run bench/compression.test.ts
 */
import { describe, it, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { assembleContext } from "../src/assembler.js";
import { splitIntoTurns } from "../src/util.js";
import { genSession, genLedgers } from "./fixture.js";

const results: Record<string, any> = {};
const outDir = join(process.cwd(), "e2e", "reports", "perf");

function tokensOf(entries: Array<{ message: any }>): number {
  let t = 0;
  for (const e of entries) t += estimateTokens(e.message);
  return t;
}

describe("compression: token 压缩比 @ 递增会话规模（keepRecentTokens=20000）", () => {
  it("30 / 100 / 300 / 1000 turns", () => {
    const rows: any[] = [];
    for (const n of [30, 100, 300, 1000]) {
      const session = genSession({ turns: n, seed: 42 });
      const turns = splitIntoTurns(session);
      const cache = genLedgers(turns);
      const native = tokensOf(session);
      const { messages, stats } = assembleContext(session, cache, 20000);
      const after = tokensOf(messages.map((m) => ({ message: m })));
      let ledgerTokens = 0;
      for (const d of cache.values()) ledgerTokens += estimateTokens(renderActionLedger([d]));
      rows.push({
        turns: n,
        messages: session.length,
        nativeTokens: native,
        assembledTokens: after,
        savedTokens: native - after,
        ratio: +(after / native).toFixed(4),
        savedPct: +(((native - after) / native) * 100).toFixed(1),
        stats,
        ledgerRenderTokensApprox: ledgerTokens,
      });
      console.log(`\n[compression] ${n} turns / ${session.length} msgs:`);
      console.log(`  原生 ${native} tok → 装配后 ${after} tok（节省 ${native - after} tok，${rows[rows.length - 1].savedPct}%，压缩后为原来的 ${(rows[rows.length - 1].ratio * 100).toFixed(1)}%）`);
      console.log(`  窗口 ${stats.windowTurns} turns 原文保留 / 替换 ${stats.replacedTurns} turns / 透传 ${stats.passthroughTurns}`);
    }
    results.compression = rows;
  });

  it("窗口预算敏感性：keepRecentTokens ∈ {4k, 8k, 20k, 50k} @ 300 turns", () => {
    const session = genSession({ turns: 300, seed: 42 });
    const turns = splitIntoTurns(session);
    const cache = genLedgers(turns);
    const native = tokensOf(session);
    const rows: any[] = [];
    for (const budget of [4000, 8000, 20000, 50000]) {
      const { messages, stats } = assembleContext(session, cache, budget);
      const after = tokensOf(messages.map((m) => ({ message: m })));
      rows.push({ keepRecentTokens: budget, nativeTokens: native, assembledTokens: after, savedPct: +(((native - after) / native) * 100).toFixed(1), stats });
      console.log(`\n[budget=${budget}] 原生 ${native} → ${after} tok（省 ${rows[rows.length - 1].savedPct}%）；窗口 ${stats.windowTurns} / 替换 ${stats.replacedTurns} / 透传 ${stats.passthroughTurns}`);
    }
    results.budgetSensitivity = { nativeTokens: native, rows };
  });

  it("无摘要降级透传：窗口外 turn 无 ledger 时的上下文形状（应≈原生）", () => {
    const session = genSession({ turns: 100, seed: 42 });
    const native = tokensOf(session);
    const { messages, stats } = assembleContext(session, new Map(), 20000);
    const after = tokensOf(messages.map((m) => ({ message: m })));
    results.passthrough = { nativeTokens: native, assembledTokens: after, stats, note: "全无摘要 = 原样透传，只损失 user 边界外的少量重组开销" };
    console.log(`\n[passthrough] 原生 ${native} → 透传 ${after} tok（窗口 ${stats.windowTurns} / 替换 0 / 透传 ${stats.passthroughTurns}）`);
  });
});

// ledger 渲染 token 的近似计量（复用 renderActionLedger）
import { renderActionLedger, type LedgerData } from "../src/ledger.js";
function renderTokens(d: LedgerData): number {
  const msg = renderActionLedger([d]);
  return estimateTokens(msg);
}

afterAll(() => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "compression.json"), JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${join(outDir, "compression.json")}`);
});
