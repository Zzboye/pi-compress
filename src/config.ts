export type SummarizerRef =
  | { kind: "registry"; provider: string; model: string }
  | { kind: "openai"; baseUrl: string; model: string; apiKey?: string };

export interface ContextCompressConfig {
  summarizer: SummarizerRef | undefined; // undefined = 插件只观察不摘要（降级态）
  verbatimCheck: boolean;
  keepRecentTokens: number;
  forceRatio: number;
  retry: { maxAttempts: number; backoffMs: number };
  ledgerMergeThreshold: number;
  backfillLimit: number;
}

export const DEFAULT_CONFIG: ContextCompressConfig = {
  summarizer: undefined,
  verbatimCheck: true,
  keepRecentTokens: 20000,
  forceRatio: 0.76,
  retry: { maxAttempts: 3, backoffMs: 2000 },
  ledgerMergeThreshold: 40,
  backfillLimit: 20,
};

interface RawSettings { contextCompress?: Record<string, unknown> }

function parseSummarizer(raw: unknown): SummarizerRef {
  if (typeof raw !== "object" || raw === null) throw new Error("summarizer must be an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.provider === "string" && typeof s.model === "string") {
    return { kind: "registry", provider: s.provider, model: s.model };
  }
  if (typeof s.baseUrl === "string" && typeof s.model === "string") {
    return { kind: "openai", baseUrl: s.baseUrl, model: s.model, apiKey: typeof s.apiKey === "string" ? s.apiKey : undefined };
  }
  throw new Error("summarizer requires {provider,model} or {baseUrl,model}");
}

function num(v: unknown, dflt: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

export function loadConfig(globalRaw: unknown, projectRaw: unknown): ContextCompressConfig {
  const merged: Record<string, unknown> = {};
  for (const raw of [globalRaw, projectRaw] as RawSettings[]) {
    if (raw && typeof raw === "object" && raw.contextCompress) {
      Object.assign(merged, raw.contextCompress);
    }
  }
  return {
    summarizer: merged.summarizer === undefined ? undefined : parseSummarizer(merged.summarizer),
    verbatimCheck: merged.verbatimCheck === undefined ? DEFAULT_CONFIG.verbatimCheck : !!merged.verbatimCheck,
    keepRecentTokens: num(merged.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens, 1000, 1_000_000),
    forceRatio: num(merged.forceRatio, DEFAULT_CONFIG.forceRatio, 0.1, 0.99),
    retry: {
      maxAttempts: Math.max(1, Math.floor(num(merged.retry === undefined ? undefined : (merged.retry as any).maxAttempts, 3, 1, 100))),
      backoffMs: Math.max(100, Math.floor(num(merged.retry === undefined ? undefined : (merged.retry as any).backoffMs, 2000, 100, 600_000))),
    },
    ledgerMergeThreshold: Math.floor(num(merged.ledgerMergeThreshold, 40, 5, 10_000)),
    backfillLimit: Math.floor(num(merged.backfillLimit, 20, 0, 100_000)),
  };
}
