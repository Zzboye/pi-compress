import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when both raws are empty", () => {
    const c = loadConfig(undefined, undefined);
    expect(c.keepRecentTokens).toBe(20000);
    expect(c.forceRatio).toBe(0.76);
    expect(c.verbatimCheck).toBe(true);
    expect(c.retry).toEqual({ maxAttempts: 3, backoffMs: 2000 });
    expect(c.ledgerMergeThreshold).toBe(40);
  });

  it("accepts registry-style summarizer (mode 1)", () => {
    const c = loadConfig(
      { contextCompress: { summarizer: { provider: "ollama", model: "qwen3:8b" } } },
      undefined,
    );
    expect(c.summarizer).toEqual({ kind: "registry", provider: "ollama", model: "qwen3:8b" });
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
