import { buildSummarizePrompt } from "./prompts.js";
import { parseLedgerOutput, type LedgerData } from "./ledger.js";
import { serializeTurn, extractToolActions, type Turn } from "./util.js";
import type { ContextCompressConfig } from "./config.js";

export interface SummarizerBackend { complete(prompt: string, signal?: AbortSignal): Promise<string> }

export class SummarizerEngine {
  private queue: Turn[] = [];
  private failedTurns = new Set<string>();
  private running = false;
  private idleResolvers: Array<() => void> = [];

  // 构造签名按测试与 index.ts/integration.test.ts 的调用约定（4 个位置参数），
  // 而非计划原稿的 `constructor(private deps: EngineDeps)`（单对象）——后者与所有调用方不匹配。
  constructor(
    private backend: SummarizerBackend,
    private config: ContextCompressConfig,
    private onLedger: (d: LedgerData) => void,
    private onWarning: (m: string) => void,
  ) {}

  enqueue(turn: Turn): void {
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
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const actions = extractToolActions(turn);
        const prompt = buildSummarizePrompt(serializeTurn(turn), actions);
        const raw = await this.backend.complete(prompt);
        const summary = parseLedgerOutput(raw, actions, serializeTurn(turn), this.config.verbatimCheck);
        this.onLedger({
          turnStartEntryId: turn.startEntryId,
          turnEndEntryId: turn.endEntryId,
          summary,
        });
        return;
      } catch (err) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        } else {
          this.failedTurns.add(turn.startEntryId);
          this.onWarning(`context-compress: turn ${turn.startEntryId} 摘要失败（${String(err)}），保留原文`);
        }
      }
    }
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
        { maxTokens: 4096, signal, cacheRetention: "none" },
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
