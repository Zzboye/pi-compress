import { describe, it, expect } from "vitest";
import { compressEnds, mergeDescribe } from "../src/degrade-llm.js";
import type { LedgerData } from "../src/ledger.js";

const okBackend = (raw: string) => ({ async complete() { return raw; } });
const failBackend = { async complete() { throw new Error("boom"); } };

const l3ready: LedgerData = {
  turnStartEntryId: "e1", turnEndEntryId: "e2", level: 2,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e1" },
  summary: { groups: [] },
  finalReply: { text: "确认 ledgerMergeThreshold 为占位字段……", entryId: "e2" },
};

describe("compressEnds", () => {
  it("parses fenced JSON into intent/outcome", async () => {
    const r = await compressEnds(okBackend('```json\n{"userIntent":"了解ledger结构","outcome":"确认占位字段"}\n```'), l3ready);
    expect(r).toEqual({ userIntent: "了解ledger结构", outcome: "确认占位字段" });
  });
  it("throws on invalid JSON", async () => {
    await expect(compressEnds(okBackend("not json"), l3ready)).rejects.toThrow();
  });
  it("propagates backend errors", async () => {
    await expect(compressEnds(failBackend, l3ready)).rejects.toThrow("boom");
  });
});

describe("mergeDescribe", () => {
  it("returns description with count appended when missing", async () => {
    const r = await mergeDescribe(okBackend('"调查代码结构与配置逻辑"'), [l3ready, l3ready, l3ready]);
    expect(r.description).toBe("调查代码结构与配置逻辑（3 条已合并）");
  });
});
