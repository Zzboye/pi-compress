export type SummarizerRef =
  | { kind: "registry"; provider: string; model: string }
  | { kind: "openai"; baseUrl: string; model: string; apiKey?: string };

export interface ContextCompressConfig {
  summarizer: SummarizerRef | undefined; // undefined = 插件只观察不摘要（降级态）
  summarizerFallback: SummarizerRef | undefined; // 备用后端：主后端溢出/重试耗尽时接管（undefined = 不启用）
  verbatimCheck: boolean;
  keepRecentTokens: number;
  forceRatio: number;
  retry: { maxAttempts: number; backoffMs: number };
  ledgerDegradeThresholdTokens: number;
  ledgerReserveTokens: number;
  /** L1 动作行 target（命令/路径）机械截断阈值；超长或多行（heredoc）截首段 + …，全文可 recall 取回 */
  targetMaxChars: number;
  /** recall 单条召回预算（tokens）：序列化文本超过则截断；总量无上限但单次注入受控 */
  recallMaxTokensPerEntry: number;
  backfillLimit: number;
  projectNotes: { enabled: boolean; path: string; maxTokens: number };
}

export const DEFAULT_CONFIG: ContextCompressConfig = {
  summarizer: undefined,
  summarizerFallback: undefined,
  verbatimCheck: true,
  keepRecentTokens: 20000,
  forceRatio: 0.76,
  retry: { maxAttempts: 3, backoffMs: 2000 },
  ledgerDegradeThresholdTokens: 40000,
  ledgerReserveTokens: 10000,
  targetMaxChars: 230,
  recallMaxTokensPerEntry: 4000,
  backfillLimit: 20,
  projectNotes: { enabled: false, path: ".pi-compress/notes.json", maxTokens: 0 },
};

/** 用户设了但未被原样采纳的数值参数：`given` → `applied`。
 *  out-of-range = 越界（含非数字/非有限数）回退默认；rounded = 取整型字段的小数被 Math.floor */
export interface ConfigAdjustment {
  key: string;
  given: unknown;
  applied: number;
  reason: "out-of-range" | "rounded";
}

export interface ConfigReport {
  config: ContextCompressConfig;
  /** 仅含被修正的项；全部合法/缺省时为空数组 */
  adjustments: ConfigAdjustment[];
}

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

/** num() 的记账版：与 num() 判定完全一致，额外把「被修正」记入 out（缺省 undefined 不记） */
function readNum(
  key: string,
  raw: unknown,
  dflt: number,
  min: number,
  max: number,
  floor: boolean,
  out: ConfigAdjustment[],
): number {
  const v = num(raw, dflt, min, max);
  if (v === dflt && raw !== dflt) {
    // 越界（或非数字）：回退默认。raw === undefined（缺省）不算修正
    if (raw !== undefined) out.push({ key, given: raw, applied: dflt, reason: "out-of-range" });
    return v;
  }
  if (floor) {
    const applied = Math.floor(v);
    if (applied !== v) out.push({ key, given: raw, applied, reason: "rounded" });
    return applied;
  }
  return v;
}

/** 加载配置并记录被钳制的项（`/compress-status` 的「配置修正」行数据源）。
 *  布尔字段的类型强转（如 verbatimCheck: "yes" → true）与 projectNotes.path 的回退不记账——
 *  只报告数值参数的越界回退与取整。 */
export function loadConfigWithReport(globalRaw: unknown, projectRaw: unknown): ConfigReport {
  const merged: Record<string, unknown> = {};
  for (const raw of [globalRaw, projectRaw] as RawSettings[]) {
    if (raw && typeof raw === "object" && raw.contextCompress) {
      Object.assign(merged, raw.contextCompress);
    }
  }
  const adj: ConfigAdjustment[] = [];
  const config: ContextCompressConfig = {
    summarizer: merged.summarizer === undefined ? undefined : parseSummarizer(merged.summarizer),
    summarizerFallback: merged.summarizerFallback === undefined ? undefined : parseSummarizer(merged.summarizerFallback),
    verbatimCheck: merged.verbatimCheck === undefined ? DEFAULT_CONFIG.verbatimCheck : !!merged.verbatimCheck,
    keepRecentTokens: readNum("keepRecentTokens", merged.keepRecentTokens, DEFAULT_CONFIG.keepRecentTokens, 1000, 1_000_000, false, adj),
    forceRatio: readNum("forceRatio", merged.forceRatio, DEFAULT_CONFIG.forceRatio, 0.1, 0.99, false, adj),
    retry: {
      maxAttempts: readNum("retry.maxAttempts", merged.retry === undefined ? undefined : (merged.retry as any).maxAttempts, DEFAULT_CONFIG.retry.maxAttempts, 1, 100, true, adj),
      backoffMs: readNum("retry.backoffMs", merged.retry === undefined ? undefined : (merged.retry as any).backoffMs, DEFAULT_CONFIG.retry.backoffMs, 100, 600_000, true, adj),
    },
    ledgerDegradeThresholdTokens: readNum("ledgerDegradeThresholdTokens", merged.ledgerDegradeThresholdTokens, DEFAULT_CONFIG.ledgerDegradeThresholdTokens, 5000, 2_000_000, true, adj),
    ledgerReserveTokens: readNum("ledgerReserveTokens", merged.ledgerReserveTokens, DEFAULT_CONFIG.ledgerReserveTokens, 1000, 500_000, true, adj),
    targetMaxChars: readNum("targetMaxChars", merged.targetMaxChars, DEFAULT_CONFIG.targetMaxChars, 40, 10_000, true, adj),
    recallMaxTokensPerEntry: readNum("recallMaxTokensPerEntry", merged.recallMaxTokensPerEntry, DEFAULT_CONFIG.recallMaxTokensPerEntry, 500, 1_000_000, true, adj),
    backfillLimit: readNum("backfillLimit", merged.backfillLimit, 20, 0, 100_000, true, adj),
    projectNotes: {
      enabled: merged.projectNotes === undefined ? DEFAULT_CONFIG.projectNotes.enabled
        : !!(merged.projectNotes as any).enabled,
      path: merged.projectNotes && typeof (merged.projectNotes as any).path === "string"
        ? (merged.projectNotes as any).path : DEFAULT_CONFIG.projectNotes.path,
      maxTokens: readNum("projectNotes.maxTokens", (merged.projectNotes as any)?.maxTokens, 0, 0, 1_000_000, false, adj),
    },
  };
  return { config, adjustments: adj };
}

export function loadConfig(globalRaw: unknown, projectRaw: unknown): ContextCompressConfig {
  return loadConfigWithReport(globalRaw, projectRaw).config;
}
