import fs from "node:fs";
import os from "node:os";
import { join, isAbsolute } from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type ContextCompressConfig } from "./config.js";
import { assembleContext, findWindowTurns, type AssembleStats } from "./assembler.js";
import { NoteStore, renderNotes } from "./notes.js";
import type { AgentMessage } from "./types.js";
import { LedgerStore, type SessionEntryLike } from "./store.js";
import {
  SummarizerEngine,
  createRegistryBackend,
  createOpenAICompatBackend,
  type SummarizerBackend,
} from "./summarizer.js";
import { executeRecallDual, searchLedger, formatSearchResult } from "./recall.js";
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

/**
 * 项目记忆注入：enabled 且有内容时，把 renderNotes 输出作为 user 消息 unshift 到 messages 头部
 * （ledger 头之前；全空/enabled=false/renderNotes 返回 null 均不注入）。
 * message 形状与 renderActionLedger 一致（user 角色 + text 内容块 + timestamp）。
 */
export function applyNotesInjection(
  messages: AgentMessage[],
  notesStore: NoteStore | null,
  config: ContextCompressConfig | null,
): void {
  const notesText = config?.projectNotes.enabled && notesStore
    ? renderNotes(notesStore.entries(), config.projectNotes.maxTokens)
    : null;
  if (!notesText) return;
  messages.unshift({
    role: "user",
    content: [{ type: "text", text: notesText }],
    timestamp: Date.now(),
  } as AgentMessage);
}

function toMessageEntries(branch: SessionEntry[]): MessageEntry[] {
  return branch.filter(isMessage).map((e) => ({ id: e.id, message: e.message }));
}

export default function (pi: ExtensionAPI): void {
  let config: ContextCompressConfig | null = null;
  let store = new LedgerStore();
  // 项目记忆：session_start 时按 config.projectNotes.path（相对 cwd 解析）构造并 load
  let notesStore: NoteStore | null = null;
  // notes 写路径专用队列：Task 5 的 notes 工具/命令经此串行写，避免并发写坏 notes.json
  let notesQueue: Promise<void> = Promise.resolve();

  /**
   * 按 branch 真实顺序（时间序）取全量 ledgers。
   * entry ID 非时间递增，localeCompare 字典序 ≠ 会话顺序（会导致降级保留区落在随机位置、
   * recall 搜索的 T 标签与 ledger 头错位）。excludeWindow 时排除 keepRecent 窗口内的 turn
   * （窗口内 turn 走原文渲染，不参与降级，也不挤占 reserve 计量口径）。
   */
  const ledgersInBranchOrder = (entries: MessageEntry[], excludeWindow: boolean): LedgerData[] => {
    const turns = splitIntoTurns(entries);
    let relevant = turns;
    if (excludeWindow && config) {
      const windowIds = new Set(findWindowTurns(turns, config.keepRecentTokens).map((t) => t.startEntryId));
      relevant = turns.filter((t) => !windowIds.has(t.startEntryId));
    }
    const out: LedgerData[] = [];
    for (const t of relevant) {
      const l = store.get(t.startEntryId);
      if (l) out.push(l);
    }
    return out;
  };
  /** 串行执行 fn 并返回其结果；异常转为「写失败：…」文本不抛出，队列继续 */
  const enqueueNotesWrite = (fn: () => Promise<string>): Promise<string> => {
    const result = notesQueue.then(fn);
    notesQueue = result.then(() => undefined, () => undefined);
    return result.catch((e: unknown) => `写失败：${e instanceof Error ? e.message : String(e)}`);
  };
  let engine: SummarizerEngine | null = null;
  let degradeEngine: DegradeEngine | null = null;
  let degraded = false;
  let lastStats: AssembleStats | null = null;
  let recallStats = { calls: 0, hits: 0, missing: 0, searches: 0, searchHits: 0, notesHits: 0 };
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
      try { (ctx.sessionManager as unknown as { appendCustomEntry(t: string, d: unknown): void }).appendCustomEntry(LEDGER_CUSTOM_TYPE, d); } catch { /* 持久化失败不影响内存缓存 */ }
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

  /** 降级流水：按 branch 真实顺序取窗外全量 ledgers，交 DegradeEngine（内部逐层瀑布，持久化走 onLedger） */
  const runDegrade = async (entries: MessageEntry[]): Promise<void> => {
    if (!degradeEngine) return;
    const ledgers = ledgersInBranchOrder(entries, true);
    if (ledgers.length === 0) return;
    await degradeEngine.run(ledgers);
  };

  /** 摘要队列 drain 完成后触发一次降级（不阻塞事件返回，fire-and-forget） */
  const degradeAfterSettle = async (ctx: { sessionManager: { getBranch(): SessionEntry[] } }): Promise<void> => {
    if (!engine) return;
    const ok = await engine.waitIdle(WAIT_TIMEOUT_MS);
    if (ok) await runDegrade(toMessageEntries(ctx.sessionManager.getBranch()));
  };
  const degradeAfterSettleSafe = (ctx: { ui: { notify(m: string, lvl?: string): void }; sessionManager: { getBranch(): SessionEntry[] } }): void => {
    degradeAfterSettle(ctx).catch((e) => ctx.ui.notify(`context-compress: 降级失败 ${e instanceof Error ? e.message : String(e)}`, "warning"));
  };

  pi.on("session_start", async (_event, ctx) => {
    const globalRaw = readJson(join(os.homedir(), ".pi", "agent", "settings.json"));
    const projectRaw = readJson(join(ctx.cwd, ".pi", "settings.json"));
    config = loadConfig(globalRaw, projectRaw);
    store = new LedgerStore();
    notesStore = new NoteStore(
      isAbsolute(config.projectNotes.path) ? config.projectNotes.path : join(ctx.cwd, config.projectNotes.path),
    );
    notesStore.load();
    store.rebuildFromEntries(ctx.sessionManager.getBranch() as unknown as SessionEntryLike[]);
    engine = makeEngine(ctx);
    degraded = false;
    recallStats = { calls: 0, hits: 0, missing: 0, searches: 0, searchHits: 0, notesHits: 0 };
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
    applyNotesInjection(messages, notesStore, config); // 项目记忆块插在 ledger 头之前
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

  pi.on("session_before_compact", async (event, ctx) => {
    if (!config || !engine) return undefined; // 未接管 → pi 原生压缩
    if (engine.pending() > 0) return undefined; // 不健康 → 让位
    const ledgers = ledgersInBranchOrder(toMessageEntries(ctx.sessionManager.getBranch()), false);
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
    description: "取回动作日志条目的逐字原文（含截断的用户消息/最终回复全文）。两种用法：① 传 ids：参数为动作日志中 ↩ 标记后的 entry ID 列表（可批量）；② 传 query：关键词检索已压缩的历史，返回命中位置 + 可召回的 ID（不返回原文，需再按 ID 取回）。",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "entry ID 列表，来自动作日志 ↩ 标记" })),
      query: Type.Optional(Type.String({ description: "关键词（大小写不敏感子串匹配），如文件名/函数名/命令词" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = toMessageEntries(ctx.sessionManager.getBranch());
      const q = params.query?.trim() ?? "";
      const parts: string[] = [];
      if (q) {
        // query 模式：关键词检索已压缩历史，返回命中索引（不消耗 calls，calls 只计逐字取回）
        // T 标签按 branch 顺序编号，与 renderActionLedger 同口径
        const ledgers = ledgersInBranchOrder(entries, false);
        const r = searchLedger(q, ledgers, 15);
        recallStats.searches += 1;
        recallStats.searchHits += r.hits.length;
        parts.push(formatSearchResult(r));
      }
      if (params.ids && params.ids.length > 0) {
        // 双源 recall：notes 条目 ID（fb-/task-/pref-）优先查项目记忆，其余走 branch 原文路径
        const r = executeRecallDual(params.ids, entries, notesStore, 4_000); // 单条 4k tokens 截断
        recallStats.calls += 1;
        recallStats.hits += params.ids.length - r.missing.length;
        recallStats.missing += r.missing.length;
        recallStats.notesHits += r.notesHits;
        parts.push(r.text);
      }
      if (parts.length === 0) {
        return { content: [{ type: "text", text: "用法：传 ids（↩ 标记后的 entry ID 列表）取回逐字原文，或传 query 关键词检索历史定位 ID。" }], details: undefined };
      }
      return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }], details: undefined };
    },
  });

  pi.registerTool({
    name: "notes",
    label: "Notes",
    description:
      "维护跨会话项目记忆（用户偏好/经验/任务决策）。三种操作：append 新增条目、update 更新（如任务状态翻转：进行中→已完成）、delete 删除。\n" +
      "【写入门槛】仅当出现被用户明确纠正的做法、新任务或任务状态变化、新的稳定偏好时调用；与现有条目语义重复时用 update 合并而非 append；不要记录可从代码库推导的内容（架构、文件路径）。\n" +
      "update/delete 对用户通过 /compress-remember 记录的条目无效。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("append"), Type.Literal("update"), Type.Literal("delete")], { description: "操作类型" }),
      table: Type.Optional(Type.Union([Type.Literal("prefs"), Type.Literal("feedback"), Type.Literal("tasks")], { description: "目标表（仅 append 需要）" })),
      id: Type.Optional(Type.String({ description: "条目 ID（update/delete 需要），如 fb-001" })),
      text: Type.Optional(Type.String({ description: "条目摘要一句话（append 需要；update 可选）" })),
      detail: Type.Optional(Type.String({ description: "详情全文（recall 按 ID 召回时返回这段）" })),
      status: Type.Optional(Type.String({ description: "任务状态，如 进行中/已完成/已废弃" })),
      source: Type.Optional(Type.String({ description: "来源说明，如用户原话或所在文件" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const store = notesStore; // 收窄到 const：闭包内使用且不因 session_start 重赋值而中途换实例
      if (!store) {
        return { content: [{ type: "text", text: "项目记忆未启用（contextCompress.projectNotes.path 未配置）" }], details: undefined };
      }
      // 写路径统一走队列串行；所有校验失败（不存在/locked）转错误文本返回，不抛异常
      const run = async (): Promise<string> => {
        if (params.action === "append") {
          if (!params.table) return "append 失败：缺少 table（prefs/feedback/tasks 三选一）";
          if (!params.text || !params.text.trim()) return "append 失败：缺少非空 text（一句话摘要）";
          const e = store.append(params.table, {
            text: params.text.trim(),
            detail: params.detail,
            status: params.status,
            source: params.source,
            locked: false, // 工具写的条目不锁定（只有 /compress-remember 命令写的才 locked=true）
          });
          store.save();
          return `已记录（${e.id}）：${e.text}`;
        }
        if (params.action === "update") {
          if (!params.id) return "update 失败：缺少 id";
          try {
            const e = store.update(params.id, { text: params.text, detail: params.detail, status: params.status });
            store.save();
            return `已更新（${e.id}）：${e.text}${e.status ? ` [${e.status}]` : ""}`;
          } catch (err) {
            return `更新失败：${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (params.action === "delete") {
          if (!params.id) return "delete 失败：缺少 id";
          const target = store.findById(params.id);
          if (!target) return `删除失败：条目 ${params.id} 不存在`;
          if (target.locked) return `删除失败：条目 ${params.id} 由用户记录（/compress-remember 写入），工具不可删除`;
          store.remove(params.id);
          store.save();
          return `已删除（${params.id}）`;
        }
        return `未知操作：${String((params as { action?: unknown }).action)}（可选 append/update/delete）`;
      };
      const text = await enqueueNotesWrite(run);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerCommand("compress-remember", {
    description: "把一条用户偏好写入项目记忆（locked=true，跨会话注入且 notes 工具不可修改）",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        ctx.ui.notify("用法：/compress-remember <内容> —— 将一条用户偏好写入项目记忆（跨会话生效，LLM 不可修改）", "warning");
        return;
      }
      if (/\s+global\s*$/i.test(raw)) {
        ctx.ui.notify("全局记忆未实现：/compress-remember 目前仅支持当前项目记忆", "warning");
        return;
      }
      if (!notesStore) {
        ctx.ui.notify("项目记忆未启用（contextCompress.projectNotes.path 未配置）", "warning");
        return;
      }
      const id = await enqueueNotesWrite(async () => {
        const e = notesStore!.append("prefs", { text: raw, locked: true });
        notesStore!.save();
        return e.id;
      });
      if (id.startsWith("写失败")) {
        ctx.ui.notify(`context-compress: ${id}`, "warning");
        return;
      }
      ctx.ui.notify(`已记住（${id}）：${raw}`, "info");
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
      const notes = config?.projectNotes.enabled && notesStore ? notesStore.all() : null;
      const lines = [
        `已摘要 turn 数：${store.size()}`,
        `队列积压：${engine?.pending() ?? 0}`,
        `失败未摘：${engine?.failed().size ?? 0}`,
        `降级状态：${degraded ? "已降级（pi 原生压缩接管中）" : "正常"}`,
        `最近装配：${lastStats ? `窗口 ${lastStats.windowTurns} turns / 替换 ${lastStats.replacedTurns} / 原文放行 ${lastStats.passthroughTurns}` : "无"}`,
        `召回：调用 ${recallStats.calls} 次 / 取回 ${recallStats.hits} 条 / 未中 ${recallStats.missing} 个 ID / 搜索 ${recallStats.searches} 次 / 记忆召回 ${recallStats.notesHits} 条`,
      // 项目记忆行：启用 = enabled 且 notesStore 已构造（enabled=false 时即使已收集条目也显示未启用，
      // 与用户预期一致：关=看不到记忆功能生效）；条目数从三表取，召回数 = notesHits
        notes
          ? `项目记忆：启用 · ${notes.prefs.length + notes.feedback.length + notes.tasks.length} 条（偏好 ${notes.prefs.length} / 经验 ${notes.feedback.length} / 任务 ${notes.tasks.length}）· 召回 ${recallStats.notesHits} 条`
          : "项目记忆：未启用",
        `计量校准：${lastCalibration ? `估算 ~${lastCalibration.estimated} tok · 真实 ${lastCalibration.actual} tok（差值含 system prompt/工具定义/模板开销）` : "无记录"}`,
        `摘要后端：${config?.summarizer ? JSON.stringify(config.summarizer) : "未配置（插件未接管）"}`,
        `备用后端：${config?.summarizerFallback ? `${JSON.stringify(config.summarizerFallback)}（主后端溢出/重试耗尽时接管）` : "未配置"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
