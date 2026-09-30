import { buildSummarizePrompt } from "./prompts.js";
import { parseLedgerOutput, type LedgerData } from "./ledger.js";
import { serializeTurn, extractToolActions, extractUserMessage, extractFinalReply, type Turn } from "./util.js";
import type { ContextCompressConfig } from "./config.js";

export interface SummarizerBackend { complete(prompt: string, signal?: AbortSignal): Promise<string> }

/** 上下文溢出类错误：主模型装不下 prompt（HTTP 400/413、exceeds context、too long 等） */
const OVERFLOW_RE = /http\s*:?\s*(400|413)|status:? ?(400|413)|exceed|too long|too many tokens|too large|context (window|length|size)|maximum context|input length/i;

export function isContextOverflow(err: unknown): boolean {
  return OVERFLOW_RE.test(String(err));
}

export class SummarizerEngine {
  private queue: Turn[] = [];
  private failedTurns = new Set<string>();
  private running = false;
  private idleResolvers: Array<() => void> = [];
  // 在队/在跑的 turnKey 去重：补摘与 agent_settled 可能对同一 turn 重复入队（烧两遍模型）
  private enqueued = new Set<string>();

  // 构造签名按测试与 index.ts/integration.test.ts 的调用约定（4 个位置参数），
  // 而非计划原稿的 `constructor(private deps: EngineDeps)`（单对象）——后者与所有调用方不匹配。
  // fallback（第 5 参，可选）：主后端溢出或重试耗尽时接管的备用后端。
  // lastResort（第 6 参，可选）：主 + 备用都重试耗尽后的最终兜底（通常为当前会话模型）。
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
    private fallback?: SummarizerBackend,
    private lastResort?: SummarizerBackend,
  ) {}

  enqueue(turn: Turn): void {
    if (this.enqueued.has(turn.startEntryId)) return; // 已在队/在跑，不重复摘要
    this.enqueued.add(turn.startEntryId);
    if (this.failedTurns.has(turn.startEntryId)) this.failedTurns.delete(turn.startEntryId);
    this.queue.push(turn);
    void this.drain();
  }

  pending(): number { return this.queue.length + (this.running ? 1 : 0); }
  failed(): Set<string> { return new Set(this.failedTurns); }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.pending() === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idleResolvers.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift()!;
        await this.processWithRetry(turn);
      }
    } finally {
      this.running = false;
      if (this.queue.length === 0) {
        const rs = this.idleResolvers; this.idleResolvers = [];
        for (const r of rs) r();
      }
    }
  }

  private async processWithRetry(turn: Turn): Promise<void> {
    const { maxAttempts, backoffMs } = this.config.retry;
    const summarize = async (backend: SummarizerBackend): Promise<void> => {
      const actions = extractToolActions(turn, this.config.targetMaxChars);
      const userMessage = extractUserMessage(turn);   // 机械提取，不依赖后端，无需重试语义
      const finalReply = turn.isFragment ? undefined : extractFinalReply(turn);
      const turnText = serializeTurn(turn);
      const prompt = buildSummarizePrompt(turnText, actions);
      const raw = await backend.complete(prompt);
      const summary = parseLedgerOutput(raw, actions, turnText, this.config.verbatimCheck);
      this.onLedger({
        turnStartEntryId: turn.startEntryId,
        turnEndEntryId: turn.endEntryId,
        summary,
        userMessage,
        finalReply,
        ...(turn.isFragment ? { isFragment: true as const } : {}),
      });
      this.enqueued.delete(turn.startEntryId); // 完成，允许后续新 turn 同名场景入队（防御）
    };

    // 三级链路（配置的主后端 → 配置的备用后端 → 当前会话模型最终兜底）：
    // 主后端溢出类错误（prompt 超出主模型上下文）时跳过剩余重试立即下一级；
    // 其他错误按既有策略重试，耗尽后转下一级。
    const stages: Array<{ backend: SummarizerBackend; label: string }> = [{ backend: this.backend, label: "主后端" }];
    if (this.fallback) stages.push({ backend: this.fallback, label: "备用后端" });
    if (this.lastResort) stages.push({ backend: this.lastResort, label: "最终兜底模型" });

    const errors: Array<{ label: string; raw: string }> = [];
    for (let s = 0; s < stages.length; s++) {
      const { backend, label } = stages[s];
      const isLast = s === stages.length - 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await summarize(backend);
          return;
        } catch (err) {
          errors.push({ label, raw: String(err) });
          // 溢出类错误且有下一级：立即切换（不烧完退避重试）
          if (!isLast && isContextOverflow(err)) break;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
          }
        }
      }
    }

    this.enqueued.delete(turn.startEntryId); // 失败出队：后续 session_start 补摘可重试
    this.failedTurns.add(turn.startEntryId);
    // 警告文案：仅主后端（无备用/无兜底）时报原始错误（与旧契约逐字一致）；
    // 多级时逐级列出（含“备用”字样，兼容旧断言）
    const detail = stages.length === 1
      ? (errors[0]?.raw ?? "")
      : errors.map((e) => `${e.label} ${e.raw}`).join("；");
    this.onWarning(`context-compress: turn ${turn.startEntryId} 摘要失败（${detail}），保留原文`);
  }
}

export function createRegistryBackend(ctx: { modelRegistry: any }, ref: { provider: string; model: string }): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      const model = ctx.modelRegistry.find(ref.provider, ref.model);
      if (!model) throw new Error(`model ${ref.provider}/${ref.model} not found`);
      return completeWithModel(ctx, model, prompt, signal);
    },
  };
}

/**
 * 直接用已解析的 Model 对象调后端（最终兜底：当前会话模型由 pi 以 ctx.model 注入，
 * 已是 Model 对象，无需再经 modelRegistry.find(provider, id) 回查）。
 */
export function createRegistryModelBackend(ctx: { modelRegistry: any }, model: any): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      return completeWithModel(ctx, model, prompt, signal);
    },
  };
}

async function completeWithModel(ctx: { modelRegistry: any }, model: any, prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await ctx.modelRegistry.complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    // maxTokens 16384：大 turn 的详尽 ledger 实测 ~7.4k tok；4096 会在 finish_reason=length 处截断 JSON
    { maxTokens: 16384, signal, cacheRetention: "none" },
  );
  return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

export function createOpenAICompatBackend(ref: { baseUrl: string; model: string; apiKey?: string }): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      const res = await fetch(`${ref.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ref.apiKey ? { authorization: `Bearer ${ref.apiKey}` } : {}) },
        body: JSON.stringify({
          model: ref.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          stream: false,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`summarizer HTTP ${res.status}`);
      const json: any = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}
