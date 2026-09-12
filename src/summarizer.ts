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
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
    private fallback?: SummarizerBackend,
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
      const finalReply = extractFinalReply(turn);
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
      });
      this.enqueued.delete(turn.startEntryId); // 完成，允许后续新 turn 同名场景入队（防御）
    };

    // 主后端：溢出类错误（prompt 超出主模型上下文）且配有备用时立即切换，不烧完退避重试；
    // 其他错误按既有策略重试，耗尽后转备用（若有）。
    let primaryErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await summarize(this.backend);
        return;
      } catch (err) {
        primaryErr = err;
        if (this.fallback && isContextOverflow(err)) break; // 太大 → 直接换大模型
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        }
      }
    }

    if (!this.fallback) {
      this.enqueued.delete(turn.startEntryId); // 失败出队：后续 session_start 补摘可重试
      this.failedTurns.add(turn.startEntryId);
      this.onWarning(`context-compress: turn ${turn.startEntryId} 摘要失败（${String(primaryErr)}），保留原文`);
      return;
    }

    // 备用后端：同一 retry 策略；备用也失败才标记 unsummarized
    let fallbackErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await summarize(this.fallback);
        return;
      } catch (err) {
        fallbackErr = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        }
      }
    }
    this.enqueued.delete(turn.startEntryId); // 失败出队：后续 session_start 补摘可重试
    this.failedTurns.add(turn.startEntryId);
    this.onWarning(`context-compress: turn ${turn.startEntryId} 摘要失败（主后端 ${String(primaryErr)}；备用后端也失败 ${String(fallbackErr)}），保留原文`);
  }
}

export function createRegistryBackend(ctx: { modelRegistry: any }, ref: { provider: string; model: string }): SummarizerBackend {
  return {
    async complete(prompt, signal) {
      const model = ctx.modelRegistry.find(ref.provider, ref.model);
      if (!model) throw new Error(`model ${ref.provider}/${ref.model} not found`);
      const response = await ctx.modelRegistry.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
        // maxTokens 16384：大 turn 的详尽 ledger 实测 ~7.4k tok；4096 会在 finish_reason=length 处截断 JSON
        { maxTokens: 16384, signal, cacheRetention: "none" },
      );
      return response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    },
  };
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
