import { describe, it, expect } from "vitest";
import { loadConfig, loadConfigWithReport, DEFAULT_CONFIG } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when both raws are empty", () => {
    const c = loadConfig(undefined, undefined);
    expect(c.keepRecentTokens).toBe(20000);
    expect(c.forceRatio).toBe(0.76);
    expect(c.verbatimCheck).toBe(true);
    expect(c.retry).toEqual({ maxAttempts: 3, backoffMs: 2000 });
    expect(c.backfillLimit).toBe(20);
  });

  it("accepts and clamps backfillLimit", () => {
    expect(loadConfig({ contextCompress: { backfillLimit: 5 } }, undefined).backfillLimit).toBe(5);
    expect(loadConfig({ contextCompress: { backfillLimit: 0 } }, undefined).backfillLimit).toBe(0);
    expect(loadConfig({ contextCompress: { backfillLimit: -3 } }, undefined).backfillLimit).toBe(20);
    expect(loadConfig({ contextCompress: { backfillLimit: 1e9 } }, undefined).backfillLimit).toBe(20); // 超范围回退默认（num() 约定）
  });

  it("accepts registry-style summarizer (mode 1)", () => {
    const c = loadConfig(
      { contextCompress: { summarizer: { provider: "ollama", model: "qwen3:8b" } } },
      undefined,
    );
    expect(c.summarizer).toEqual({ kind: "registry", provider: "ollama", model: "qwen3:8b" });
  });

  it("defaults summarizerFallback to undefined", () => {
    expect(loadConfig(undefined, undefined).summarizerFallback).toBeUndefined();
    expect(DEFAULT_CONFIG.summarizerFallback).toBeUndefined();
  });

  it("accepts registry-style summarizerFallback", () => {
    const c = loadConfig(
      { contextCompress: {
        summarizer: { provider: "LM Studio", model: "qwen3.8-27b-uncensored@iq4_xs" },
        summarizerFallback: { provider: "HSFZ", model: "glm-5.3-flash" },
      } },
      undefined,
    );
    expect(c.summarizerFallback).toEqual({ kind: "registry", provider: "HSFZ", model: "glm-5.3-flash" });
  });

  it("accepts openai-style summarizerFallback and lets project override global", () => {
    const c = loadConfig(
      { contextCompress: {
        summarizer: { baseUrl: "http://a/v1", model: "small" },
        summarizerFallback: { baseUrl: "http://global-fallback/v1", model: "big" },
      } },
      { contextCompress: { summarizerFallback: { baseUrl: "http://proj-fallback/v1", model: "bigger", apiKey: "k" } } },
    );
    expect(c.summarizerFallback).toEqual({ kind: "openai", baseUrl: "http://proj-fallback/v1", model: "bigger", apiKey: "k" });
  });

  it("accepts baseUrl-style summarizer (mode 2)", () => {
    const c = loadConfig(
      undefined,
      { contextCompress: { summarizer: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", apiKey: "ollama" } } },
    );
    expect(c.summarizer).toEqual({
      kind: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", apiKey: "ollama",
    });
  });

  it("project overrides global", () => {
    const c = loadConfig(
      { contextCompress: { keepRecentTokens: 30000 } },
      { contextCompress: { forceRatio: 0.8 } },
    );
    expect(c.keepRecentTokens).toBe(30000);
    expect(c.forceRatio).toBe(0.8);
  });

  it("rejects invalid summarizer shape", () => {
    expect(() => loadConfig({ contextCompress: { summarizer: { provider: "x" } } }, undefined))
      .toThrow(/summarizer/);
  });

  it("clamps invalid numbers to defaults", () => {
    const c = loadConfig({ contextCompress: { keepRecentTokens: -5, forceRatio: 2 } }, undefined);
    expect(c.keepRecentTokens).toBe(20000);
    expect(c.forceRatio).toBe(0.76);
  });

  it("projectNotes：缺省 = 关闭 + 默认路径 + maxTokens 0", () => {
    const c = loadConfig({}, {});
    expect(c.projectNotes).toEqual({ enabled: false, path: ".pi-compress/notes.json", maxTokens: 0 });
  });

  it("projectNotes：可开启、可改路径与预算；非法值回退默认", () => {
    const c = loadConfig({}, { contextCompress: { projectNotes: { enabled: true, path: "custom/notes.json", maxTokens: 2000 } } });
    expect(c.projectNotes.enabled).toBe(true);
    expect(c.projectNotes.path).toBe("custom/notes.json");
    expect(c.projectNotes.maxTokens).toBe(2000);
    const bad = loadConfig({}, { contextCompress: { projectNotes: { maxTokens: -5 } } });
    expect(bad.projectNotes.maxTokens).toBe(0);
  });
});

describe("ledger degrade config", () => {
  it("defaults ledgerDegradeThresholdTokens=40000, ledgerReserveTokens=10000", () => {
    const c = loadConfig({}, {});
    expect(c.ledgerDegradeThresholdTokens).toBe(40000);
    expect(c.ledgerReserveTokens).toBe(10000);
  });
  it("reads overrides and clamps out-of-range", () => {
    const c = loadConfig({ contextCompress: { ledgerDegradeThresholdTokens: 60000, ledgerReserveTokens: 5000 } }, {});
    expect(c.ledgerDegradeThresholdTokens).toBe(60000);
    expect(c.ledgerReserveTokens).toBe(5000);
    const bad = loadConfig({ contextCompress: { ledgerDegradeThresholdTokens: 1, ledgerReserveTokens: 0 } }, {});
    expect(bad.ledgerDegradeThresholdTokens).toBe(40000);
    expect(bad.ledgerReserveTokens).toBe(10000);
  });
  it("ignores legacy ledgerMergeThreshold (no longer in output)", () => {
    const c = loadConfig({ contextCompress: { ledgerMergeThreshold: 40 } }, {});
    expect((c as any).ledgerMergeThreshold).toBeUndefined();
  });

  it("recallMaxTokensPerEntry：默认 4000，可覆盖；越界回退默认（沿用 num 惯例）", () => {
    const d = loadConfig({}, {});
    expect(d.recallMaxTokensPerEntry).toBe(4000);
    const c = loadConfig({ contextCompress: { recallMaxTokensPerEntry: 16000 } }, {});
    expect(c.recallMaxTokensPerEntry).toBe(16000);
    const lo = loadConfig({ contextCompress: { recallMaxTokensPerEntry: 10 } }, {});
    expect(lo.recallMaxTokensPerEntry).toBe(4000);
    const hi = loadConfig({ contextCompress: { recallMaxTokensPerEntry: 999_999_999 } }, {});
    expect(hi.recallMaxTokensPerEntry).toBe(4000);
  });
});

describe("loadConfigWithReport：钳制透明化（只报告用户设了但被修正的项）", () => {
  it("全部缺省或全部在范围内 → 无修正记录", () => {
    expect(loadConfigWithReport(undefined, undefined).adjustments).toEqual([]);
    const ok = loadConfigWithReport(
      { contextCompress: { keepRecentTokens: 30000, forceRatio: 0.5, backfillLimit: 7 } },
      { contextCompress: { recallMaxTokensPerEntry: 8000 } },
    );
    expect(ok.adjustments).toEqual([]);
    expect(ok.config.keepRecentTokens).toBe(30000);
  });

  it("越界 → 回退默认并记录 配置值 → 生效值", () => {
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { recallMaxTokensPerEntry: 10 } },
      undefined,
    );
    expect(config.recallMaxTokensPerEntry).toBe(4000);
    expect(adjustments).toEqual([
      { key: "recallMaxTokensPerEntry", given: 10, applied: 4000, reason: "out-of-range" },
    ]);
  });

  it("上越界与非数字同样记录（given 原样保留）", () => {
    const { adjustments } = loadConfigWithReport(
      { contextCompress: { targetMaxChars: 999999, forceRatio: "high" } },
      undefined,
    );
    expect(adjustments).toEqual([
      { key: "forceRatio", given: "high", applied: 0.76, reason: "out-of-range" },
      { key: "targetMaxChars", given: 999999, applied: 230, reason: "out-of-range" },
    ]);
  });

  it("取整型字段的小数 → rounded（生效值已取整）", () => {
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { backfillLimit: 3.7 } },
      undefined,
    );
    expect(config.backfillLimit).toBe(3);
    expect(adjustments).toEqual([{ key: "backfillLimit", given: 3.7, applied: 3, reason: "rounded" }]);
  });

  it("非取整字段的小数原样生效 → 不记录（行为与旧实现一致）", () => {
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { keepRecentTokens: 20000.5 } },
      undefined,
    );
    expect(config.keepRecentTokens).toBe(20000.5);
    expect(adjustments).toEqual([]);
  });

  it("projectNotes.maxTokens 非取整（沿用 num 惯例）——小数原样生效，不报告取整", () => {
    // 回归：差分验证发现此处若加 Math.floor 会改变既有行为（旧实现不取整）
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { projectNotes: { maxTokens: 1500.5 } } },
      undefined,
    );
    expect(config.projectNotes.maxTokens).toBe(1500.5);
    expect(adjustments).toEqual([]);
  });

  it("嵌套字段（retry.* / projectNotes.maxTokens）按路径报告", () => {
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { retry: { maxAttempts: 200, backoffMs: 50 }, projectNotes: { maxTokens: -1 } } },
      undefined,
    );
    expect(config.retry).toEqual({ maxAttempts: 3, backoffMs: 2000 });
    expect(config.projectNotes.maxTokens).toBe(0);
    expect(adjustments).toEqual([
      { key: "retry.maxAttempts", given: 200, applied: 3, reason: "out-of-range" },
      { key: "retry.backoffMs", given: 50, applied: 2000, reason: "out-of-range" },
      { key: "projectNotes.maxTokens", given: -1, applied: 0, reason: "out-of-range" },
    ]);
  });

  it("项目级覆盖全局后按最终值判定（项目越界覆盖全局合法值）", () => {
    const { config, adjustments } = loadConfigWithReport(
      { contextCompress: { ledgerReserveTokens: 5000 } },
      { contextCompress: { ledgerReserveTokens: 1 } },
    );
    expect(config.ledgerReserveTokens).toBe(10000);
    expect(adjustments).toEqual([
      { key: "ledgerReserveTokens", given: 1, applied: 10000, reason: "out-of-range" },
    ]);
  });

  it("loadConfig 行为不变（等价于 loadConfigWithReport().config）", () => {
    const raw = { contextCompress: { recallMaxTokensPerEntry: 10, backfillLimit: 3.7 } };
    expect(loadConfig(raw, undefined)).toEqual(loadConfigWithReport(raw, undefined).config);
  });
});
