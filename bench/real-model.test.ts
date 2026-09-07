/**
 * 基准 ③：真机摘要性能——本地 LM Studio（http://127.0.0.1:8080/v1）。
 * 会话夹具用本仓库真实文件做 toolResult（同 2026-09-01 e2e 方法论）。
 * 单趟引擎驱动：per-turn 延迟与串行队列追赶时间一次测完；模型未加载时由 LM Studio 换模（首请求含加载时间，单独标注）。
 * 服务不可达时自动跳过。
 *
 *   npx vitest run bench/real-model.test.ts
 */
import { describe, it, afterAll } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { SummarizerEngine, type SummarizerBackend } from "../src/summarizer.js";
import { renderActionLedger, type LedgerData } from "../src/ledger.js";
import { extractToolActions, splitIntoTurns, type MessageEntry } from "../src/util.js";
import { assembleContext } from "../src/assembler.js";
import type { AgentMessage } from "../src/types.js";

const results: Record<string, any> = {};
const outDir = join(process.cwd(), "e2e", "reports", "perf");
const ROOT = join(import.meta.dirname, "..");
const LMSTUDIO = { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "lm-studio" };
const MODELS = ["qwen3.8-27b-uncensored", "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive"];
const REQ_TIMEOUT_MS = 300_000; // 单请求超时（含 LM Studio 换模时间）

async function loadedModels(): Promise<Map<string, boolean>> {
  try {
    const res = await fetch("http://127.0.0.1:8080/api/v0/models", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return new Map();
    const state = new Map<string, boolean>();
    for (const m of (await res.json() as any).data ?? []) {
      if (MODELS.includes(m.id)) state.set(m.id, m.state === "loaded");
    }
    return state;
  } catch { return new Map(); }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LMSTUDIO.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

function trimTo(text: string, bytes: number): string {
  return text.length <= bytes ? text : text.slice(0, bytes) + "\n…（截断）";
}

/** 用本仓库真实文件构造 8-turn 真实形态会话 */
function buildRealSession(): MessageEntry[] {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const files: Array<[string, number]> = [
    ["README.md", 12000],
    ["src/assembler.ts", 6000],
    ["src/summarizer.ts", 8000],
    ["src/ledger.ts", 6000],
    ["src/recall.ts", 4000],
    ["package.json", 800],
  ];
  const contents = files.map(([p, cap]) => ({ path: p, text: trimTo(read(p), cap) }));

  const entries: MessageEntry[] = [];
  let n = 0;
  const push = (role: AgentMessage["role"], content: any): MessageEntry => {
    n += 1;
    const e = { id: `e${String(n).padStart(4, "0")}`, message: { role, content, timestamp: 1700000000000 + n * 1000 } as AgentMessage };
    entries.push(e);
    return e;
  };
  const text = (s: string) => [{ type: "text", text: s }];
  let tcId = 0;
  const toolCall = (name: string, args: any) => ({ type: "toolCall", toolCallId: `tc${++tcId}`, name, arguments: args });

  push("user", text("总结一下这个项目的压缩管线是怎么工作的"));
  push("assistant", [...text("我来读 README"), toolCall("read", { path: "README.md" })]);
  push("toolResult", text(contents[0].text));
  push("assistant", text("管线分四步：agent_settled 触发后台摘要；动作日志经 CustomEntry 落盘；context 事件用 20k 窗口重组上下文；LLM 用 recall 按 ↩ID 取回原文。"));

  push("user", text("窗口边界是怎么切的？超预算的单 turn 怎么处理"));
  push("assistant", [...text("看 assembler 的实现"), toolCall("read", { path: "src/assembler.ts" })]);
  push("toolResult", text(contents[1].text));
  push("assistant", text("findWindowTurns 从尾部往前累计 token，超预算即停；单 turn 超预算时整体保留（window.length > 0 的守卫保证至少放一个 turn）。"));

  push("user", text("摘要失败的重试逻辑是什么"));
  push("assistant", [...text("读 summarizer"), toolCall("read", { path: "src/summarizer.ts" })]);
  push("toolResult", text(contents[2].text));
  push("assistant", text("processWithRetry 按 maxAttempts 指数退避重试；最终失败进 failedTurns，原文照发不阻塞。"));

  push("user", text("逐字校验是怎么防小模型编造的"));
  push("assistant", [...text("看 ledger.ts"), toolCall("read", { path: "src/ledger.ts" })]);
  push("toolResult", text(contents[3].text));
  push("assistant", text("parseLedgerOutput 把 detail 里疑似路径拿到 turnText 里查；查不到即剔除该条目；target 只从机械清单取，模型改写无效。"));

  push("user", text("把 recall 单条截断从 4000 提到 6000"));
  push("assistant", [...text("改 recall.ts 的调用点"), toolCall("edit", { path: "src/recall.ts", oldText: "4000", newText: "6000" })]);
  push("toolResult", text("Successfully replaced 1 block(s) in src/recall.ts"));
  push("assistant", text("已改：recall 单条截断上限 6000 tokens。"));

  push("user", text("跑一下全套测试确认没破坏"));
  push("assistant", [...text("跑 vitest"), toolCall("bash", { command: "npx vitest run" })]);
  push("toolResult", text("✓ tests/ledger.test.ts (3 tests)\n✓ tests/store.test.ts (3 tests)\nTest Files 11 passed | 1 skipped (12)\nTests 54 passed | 1 skipped (55)"));
  push("assistant", text("54 通过 1 跳过，全部健康。"));

  push("user", text("recall 现在的实现和依赖情况一起看下"));
  push("assistant", [...text("并行读两个文件"), toolCall("read", { path: "src/recall.ts" }), toolCall("read", { path: "package.json" })]);
  push("toolResult", text(contents[4].text));
  push("toolResult", text(contents[5].text));
  push("assistant", text("recall 是纯查找：Map 索引 + 4k 截断 + 未中提示；依赖只有 pi 主包与 typebox。"));

  push("user", text("为什么摘要只看 toolResult 的头尾采样？"));
  push("assistant", text("preTruncateToolResults 按前 1400 + 后 500 采样，总预算 1950 < pi 的 2000，避免 pi 二次截断；结论通常在尾部，结构在头部，中段噪声对摘要无增益。逐字原文仍可 recall。"));

  return entries;
}

function tokensOf(messages: any[]): number {
  let t = 0;
  for (const m of messages) t += estimateTokens(m);
  return t;
}

describe("real-model: LM Studio 本地摘要基准", () => {
  it("引擎单趟：per-turn 延迟/质量 + 队列追赶 + 端到端压缩", { timeout: 1_800_000 }, async () => {
    if (!(await serverUp())) {
      console.log("\n[real-model] LM Studio (127.0.0.1:8080) 不可达 → 跳过");
      results.skipped = "server unreachable";
      return;
    }
    const loadState = await loadedModels();
    // 已加载的模型先测，减少换模
    const ordered = [...MODELS].sort((a, b) => Number(loadState.get(b) ?? false) - Number(loadState.get(a) ?? false));

    const session = buildRealSession();
    const turns = splitIntoTurns(session);
    const nativeTokens = tokensOf(session.map((e) => e.message));
    results.session = { turns: turns.length, messages: session.length, nativeTokens };
    console.log(`\n[real-model] 真实会话夹具：${turns.length} turns / ${session.length} msgs / 原生 ${nativeTokens} tok`);
    console.log(`[real-model] 测序（已加载优先）：${ordered.map((m) => `${m.split("-")[1]}${loadState.get(m) ? "(已加载)" : "(需换模)"}`).join(" → ")}`);

    const perModel: any[] = [];
    for (const model of ordered) {
      console.log(`\n[real-model] === ${model} ===`);
      const ledgers = new Map<string, LedgerData>();
      const rows: any[] = [];
      let reqIdx = 0;
      let parseFail = 0;
      let verbatimDropped = 0;
      let lastPromptChars = 0;

      // 计时后端：per-turn 延迟在此采集（引擎串行调用）
      const timedBackend: SummarizerBackend = {
        complete: async (prompt: string) => {
          reqIdx += 1;
          lastPromptChars = prompt.length;
          const t0 = performance.now();
          const res = await fetch(`${LMSTUDIO.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${LMSTUDIO.apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, stream: false }),
            signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json: any = await res.json();
          const latency = performance.now() - t0;
          const raw = json.choices?.[0]?.message?.content ?? "";
          rows.push({
            req: reqIdx,
            promptChars: prompt.length,
            promptTokensEst: Math.round(prompt.length / 3.5),
            latencyMs: +latency.toFixed(0),
            outChars: raw.length,
            outTokensEst: Math.round(raw.length / 3.5),
          });
          console.log(`  req#${reqIdx} prompt ${(prompt.length / 1000).toFixed(1)}k chars → ${latency.toFixed(0)}ms, out ${raw.length} chars`);
          return raw;
        },
      };

      const onLedger = (d: LedgerData) => {
        const turn = turns.find((t) => t.startEntryId === d.turnStartEntryId);
        if (!turn) return;
        const turnTok = turn.entries.reduce((s, e) => s + estimateTokens(e.message), 0);
        const ledgerTok = estimateTokens(renderActionLedger([d]));
        ledgers.set(d.turnStartEntryId, d);
        rows[rows.length - 1].turnTokens = turnTok;
        rows[rows.length - 1].ledgerTokens = ledgerTok;
        rows[rows.length - 1].perTurnRatio = +(ledgerTok / turnTok).toFixed(4);
      };
      const onWarning = (m: string) => { parseFail += 1; console.log(`  WARN: ${m}`); };

      const engine = new SummarizerEngine(timedBackend, {
        summarizer: { kind: "openai", baseUrl: LMSTUDIO.baseUrl, model, apiKey: LMSTUDIO.apiKey },
        verbatimCheck: true, keepRecentTokens: 20000, forceRatio: 0.76,
        retry: { maxAttempts: 2, backoffMs: 1000 }, ledgerMergeThreshold: 40, backfillLimit: 20,
      }, onLedger, onWarning);

      // 摘要后逐 turn 复核逐字校验剔除情况
      const t0 = performance.now();
      for (const t of turns) engine.enqueue(t);
      const drained = await engine.waitIdle(600_000);
      const catchupMs = performance.now() - t0;

      // 逐字校验质量复核：ledger target 全部来自机械清单（parse 已过滤，此处守卫确认）
      for (const t of turns) {
        const actions = extractToolActions(t);
        const d = ledgers.get(t.startEntryId);
        if (!d) continue;
        const mechTargets = new Set(actions.map((a) => a.target));
        const outTargets = d.summary.groups.flatMap((g) => g.entries.map((e) => e.target));
        if (outTargets.some((tg) => !mechTargets.has(tg))) verbatimDropped += 1; // 理论不可能，作守卫
      }

      const { messages, stats } = assembleContext(session, ledgers, 20000);
      const after = tokensOf(messages);
      const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
      const ok = ledgers.size;
      perModel.push({
        model,
        loadedBefore: loadState.get(model) ?? false,
        summarisedTurns: ok,
        totalTurns: turns.length,
        parseFail,
        verbatimDropped,
        latency: lat.length ? { min: lat[0], p50: lat[Math.floor(lat.length / 2)], max: lat[lat.length - 1], mean: +(lat.reduce((s, v) => s + v, 0) / lat.length).toFixed(0) } : null,
        catchupMs: +catchupMs.toFixed(0),
        catchupDrained: drained,
        endToEnd: { nativeTokens, assembledTokens: after, savedPct: +(((nativeTokens - after) / nativeTokens) * 100).toFixed(1), stats },
        rows,
      });
      console.log(`  ⇒ 摘要 ${ok}/${turns.length} turns（解析失败 ${parseFail}），延迟 p50 ${perModel[perModel.length - 1].latency?.p50 ?? "-"}ms / mean ${perModel[perModel.length - 1].latency?.mean ?? "-"}ms`);
      console.log(`  ⇒ 队列追赶 ${catchupMs.toFixed(0)}ms（drained=${drained}）；端到端 ${nativeTokens} → ${after} tok（省 ${perModel[perModel.length - 1].endToEnd.savedPct}%）`);
    }

    results.perModel = perModel;
  });
});

afterAll(() => {
  if (Object.keys(results).length === 0) return;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "real-model.json"), JSON.stringify(results, null, 2));
  console.log(`\n结果已写入 ${join(outDir, "real-model.json")}`);
});
