import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ContextCompressConfig } from "./config.js";
import { assembleContext, type AssembleStats } from "./assembler.js";
import { LedgerStore, type SessionEntryLike } from "./store.js";
import {
  SummarizerEngine,
  createRegistryBackend,
  createOpenAICompatBackend,
  type SummarizerBackend,
} from "./summarizer.js";
import { executeRecall } from "./recall.js";
import { dumpContext, writeContextDump, defaultDumpBase } from "./dump.js";
import { enforceForcePoint } from "./forcepoint.js";
import { countTokens, splitIntoTurns, type MessageEntry } from "./util.js";
import { computeBackfillTurns } from "./backfill.js";
import { DegradeEngine } from "./degrade.js";
import { renderActionLedger, LEDGER_CUSTOM_TYPE, type LedgerData } from "./ledger.js";

const WAIT_TIMEOUT_MS = 120_000;

function readJson(path: string): unknown {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return undefined; }
}

function isMessage(e: SessionEntry): e is SessionMessageEntry { return e.type === "message"; }

function toMessageEntries(branch: SessionEntry[]): MessageEntry[] {
  return branch.filter(isMessage).map((e) => ({ id: e.id, message: e.message }));
}

export default function (pi: ExtensionAPI): void {
  let config: ContextCompressConfig | null = null;
  let store = new LedgerStore();
  let engine: SummarizerEngine | null = null;
  let degradeEngine: DegradeEngine | null = null;
  let degraded = false;
  let lastStats: AssembleStats | null = null;
  let recallStats = { calls: 0, hits: 0, missing: 0 };
  // 校准观察：最近一次装配的「估算（CJK 感知）vs 真实 usage」并排记录。
  // 差值 = system prompt + 工具定义 + 模板开销 + 估算误差；长期稳定偏差即可推出校准系数。
  let lastCalibration: { estimated: number; actual: number } | null = null;

  // 摘要与降级共用同一后端与持久化通道（onLedger：store.set + appendCustomEntry）
  const makeBackend = (ctx: ExtensionContext, ref: NonNullable<ContextCompressConfig["summarizer"]>): SummarizerBackend =>
    ref.kind === "registry" ? createRegistryBackend(ctx, ref) : createOpenAICompatBackend(ref);

  const makeEngine = (ctx: ExtensionContext): SummarizerEngine | null => {
    if (!config?.summarizer) return null;
    const backend = makeBackend(ctx, config.summarizer);
    // 备用后端：主后端溢出（prompt 超出主模型上下文）或重试耗尽时接管（典型：主用本地小模型，备用配大上下文模型）
    const fallback: SummarizerBackend | undefined =
      config.summarizerFallback ? makeBackend(ctx, config.summarizerFallback) : undefined;
    const onLedger = (d: LedgerData) => {
      store.set(d);
      try { (ctx.sessionManager as unknown as SessionManager).appendCustomEntry(LEDGER_CUSTOM_TYPE, d); } catch { /* 持久化失败不影响内存缓存 */ }
    };
    // 降级引擎：仅在摘要后端可用时构造（未配置 summarizer = 插件降级态，不降级也不摘要）
    degradeEngine = new DegradeEngine(backend, config, onLedger, (m) => ctx.ui.notify(m, "warning"));
    return new SummarizerEngine(
      backend,
      config,
      onLedger,
      (m) => ctx.ui.notify(m, "warning"),
      fallback,
    );
  };

  /** 降级流水：按 turnStartEntryId 升序取全量 ledgers，交 DegradeEngine（内部逐层瀑布，持久化走 onLedger） */
  const runDegrade = async (): Promise<void> => {
    if (!degradeEngine) return;
    const ledgers = store.keys()
      .map((k) => store.get(k)!)
      .filter(Boolean)
      .sort((a, b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId));
    if (ledgers.length === 0) return;
    await degradeEngine.run(ledgers);
  };

  /** 摘要队列 drain 完成后触发一次降级（不阻塞事件返回，fire-and-forget） */
  const degradeAfterSettle = async (): Promise<void> => {
    if (!engine) return;
    const ok = await engine.waitIdle(WAIT_TIMEOUT_MS);
    if (ok) await runDegrade();
  };
  const degradeAfterSettleSafe = (ctx: { ui: { notify(m: string, lvl?: string): void } }): void => {
    degradeAfterSettle().catch((e) => ctx.ui.notify(`context-compress: 降级失败 ${e instanceof Error ? e.message : String(e)}`, "warning"));
  };

  pi.on("session_start", async (_event, ctx) => {
    const globalRaw = readJson(join(os.homedir(), ".pi", "agent", "settings.json"));
    const projectRaw = readJson(join(ctx.cwd, ".pi", "settings.json"));
    config = loadConfig(globalRaw, projectRaw);
    store = new LedgerStore();
    store.rebuildFromEntries(ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
    engine = makeEngine(ctx);
    degraded = false;
    recallStats = { calls: 0, hits: 0, missing: 0 };
    if (engine) {
      // 补摘：历史会话恢复时，无 ledger 的旧 turn 重新入队（最旧优先，上限防雪崩）
      const turns = splitIntoTurns(toMessageEntries(ctx.sessionManager.getBranch()));
      const todo = computeBackfillTurns(turns, store, config.backfillLimit);
      for (const t of todo) engine.enqueue(t);
      if (todo.length > 0) {
        ctx.ui.notify(`context-compress: 补摘 ${todo.length} 个未摘要 turn`, "info");
        degradeAfterSettleSafe(ctx); // 补摘完成后同样触发降级（不阻塞 session_start）
      }
    }
  });

  pi.on("context", async (_event, ctx) => {
    if (degraded || !config) return;
    const branch = ctx.sessionManager.getBranch();
    const entries = toMessageEntries(branch);
    if (entries.length === 0) return;

    const usage = ctx.getContextUsage();
    const decision = await enforceForcePoint(
      usage && usage.tokens != null ? { tokens: usage.tokens } : undefined,
      usage?.contextWindow ?? 200_000,
      config.forceRatio,
      engine ?? { pending: () => 0, waitIdle: async () => true },
      WAIT_TIMEOUT_MS,
      (s) => ctx.ui.setStatus("compress", s),
    );
    if (decision === "degraded") {
      degraded = true;
      ctx.ui.notify("context-compress: 已降级，本轮交由 pi 原生压缩", "warning");
      return; // 不重组，上下文自然增长直到 pi auto-compaction
    }

    const cache = new Map<string, LedgerData>();
    for (const k of store.keys()) { const v = store.get(k); if (v) cache.set(k, v); }
    const { messages, stats } = assembleContext(entries, cache, config.keepRecentTokens);
    lastStats = stats;
    const estimated = messages.reduce((s, m) => s + countTokens(m as any, { skipThinking: true }), 0);
    lastCalibration = { estimated, actual: usage?.tokens ?? 0 };
    if (engine && engine.pending() === 0) degraded = false; // 恢复
    return { messages };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!engine) return;
    const entries = toMessageEntries(ctx.sessionManager.getBranch());
    const turns = splitIntoTurns(entries);
    if (turns.length === 0) return;
    const last = turns[turns.length - 1];
    if (store.get(last.startEntryId) || engine.failed().has(last.startEntryId)) return;
    engine.enqueue(last);
    // 摘要完成后后台降级：L1>阈值 → 最旧降 L2，逐层瀑布，不阻塞事件返回
    degradeAfterSettleSafe(ctx);
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    if (!config || !engine) return undefined; // 未接管 → pi 原生压缩
    if (engine.pending() > 0) return undefined; // 不健康 → 让位
    const ledgers = store.keys()
      .map((k) => store.get(k)!)
      .filter(Boolean)
      .sort((a, b) => a.turnStartEntryId.localeCompare(b.turnStartEntryId));
    if (ledgers.length === 0) return undefined;
    const ledgerMsg = renderActionLedger(ledgers);
    const text = ((ledgerMsg as any).content as any[]).map((c: any) => c.text ?? "").join("");
    return {
      compaction: {
        summary: text,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "取回动作日志条目的逐字原文（含截断的用户消息/最终回复全文）。参数为动作日志中 ↩ 标记后的 entry ID 列表（可批量）。",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "entry ID 列表，来自动作日志 ↩ 标记" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = toMessageEntries(ctx.sessionManager.getBranch());
      const r = executeRecall(params.ids, entries, 4000); // 单条 4k tokens 截断
      recallStats.calls += 1;
      recallStats.hits += params.ids.length - r.missing.length;
      recallStats.missing += r.missing.length;
      return { content: [{ type: "text", text: r.text }], details: undefined };
    },
  });

  pi.registerCommand("compress-dump", {
    description: "转储当前会话实际发给 LLM 的上下文原文（Markdown+JSON 双份）",
    handler: async (args, ctx) => {
      if (!config) {
        ctx.ui.notify("context-compress: 未配置（无 contextCompress.summarizer），无从转储装配口径", "warning");
        return;
      }
      const branch = toMessageEntries(ctx.sessionManager.getBranch());
      if (branch.length === 0) {
        ctx.ui.notify("context-compress: 会话为空，无上下文可转储", "warning");
        return;
      }
      const cache = new Map<string, LedgerData>();
      for (const k of store.keys()) { const v = store.get(k); if (v) cache.set(k, v); }
      const dump = dumpContext(branch, cache, config);
      const base = args.trim() ? args.trim() : defaultDumpBase(ctx.cwd);
      const [mdPath, jsonPath] = writeContextDump(dump, base);
      const d = dump.stats;
      ctx.ui.notify(
        `context-compress 转储：${dump.assembled.total} 条 messages / 窗口 ${d.windowTurns} turns / 替换 ${d.replacedTurns} / 照发 ${d.passthroughTurns} / ~${dump.assembled.tokens} tok\n${mdPath}\n${jsonPath}`,
        "info",
      );
    },
  });

  pi.registerCommand("compress-status", {
    description: "显示 context-compress 状态",
    handler: async (_args, ctx) => {
      const lines = [
        `已摘要 turn 数：${store.size()}`,
        `队列积压：${engine?.pending() ?? 0}`,
        `失败未摘：${engine?.failed().size ?? 0}`,
        `降级状态：${degraded ? "已降级（pi 原生压缩接管中）" : "正常"}`,
        `最近装配：${lastStats ? `窗口 ${lastStats.windowTurns} turns / 替换 ${lastStats.replacedTurns} / 原文放行 ${lastStats.passthroughTurns}` : "无"}`,
        `召回：调用 ${recallStats.calls} 次 / 取回 ${recallStats.hits} 条 / 未中 ${recallStats.missing} 个 ID`,
        `计量校准：${lastCalibration ? `估算 ~${lastCalibration.estimated} tok · 真实 ${lastCalibration.actual} tok（差值含 system prompt/工具定义/模板开销）` : "无记录"}`,
        `摘要后端：${config?.summarizer ? JSON.stringify(config.summarizer) : "未配置（插件未接管）"}`,
        `备用后端：${config?.summarizerFallback ? `${JSON.stringify(config.summarizerFallback)}（主后端溢出/重试耗尽时接管）` : "未配置"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
