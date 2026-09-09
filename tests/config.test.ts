import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

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
});
