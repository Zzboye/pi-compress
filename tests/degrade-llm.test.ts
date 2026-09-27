import { describe, it, expect } from "vitest";
import { compressEnds, recompressBatched, recompressOne, L5_BATCH_SIZE } from "../src/degrade-llm.js";
import type { LedgerData } from "../src/ledger.js";

const okBackend = (raw: string) => ({ async complete() { return raw; } });
const failBackend = { async complete() { throw new Error("boom"); } };

const l3ready: LedgerData = {
  turnStartEntryId: "e1", turnEndEntryId: "e2", level: 2,
  userMessage: { text: "帮我了解 ledger 的结构", entryId: "e1" },
  summary: { entries: [] },
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

describe("recompressBatched", () => {
  const mk = (id: string, intent: string, outcome: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4,
    summary: { entries: [], userIntent: intent, outcome },
  } as unknown as LedgerData);

  const backendOf = (responses: string[]) => {
    let i = 0;
    return { complete: async () => responses[Math.min(i++, responses.length - 1)] } as any;
  };

  it("按 index 一一映射，返回长度与入参等长", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "描述一" }, { index: 2, description: "描述二" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["描述一", "描述二"]);
  });

  it("index 乱序仍正确归位", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 2, description: "第二" }, { index: 1, description: "第一" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["第一", "第二"]);
  });

  it("缺项 → null，不抛错、不影响其他项", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2"), mk("c", "i3", "o3")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "甲" }, { index: 3, description: "丙" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["甲", null, "丙"]);
  });

  it("裸数组形态也接受", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify([{ index: 1, description: "甲" }])]);
    expect(await recompressBatched(backend, items)).toEqual(["甲"]);
  });

  it("``` 围栏被剥离", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf(["```json\n" + JSON.stringify({ items: [{ index: 1, description: "甲" }] }) + "\n```"]);
    expect(await recompressBatched(backend, items)).toEqual(["甲"]);
  });

  it("JSON 完全无法解析 → 全 null（不抛错）", async () => {
    const items = [mk("a", "i1", "o1"), mk("b", "i2", "o2")];
    const backend = backendOf(["这不是 JSON"]);
    expect(await recompressBatched(backend, items)).toEqual([null, null]);
  });

  it("空数组 → 空数组，且不调用 backend", async () => {
    let called = 0;
    const backend = { complete: async () => { called++; return "{}"; } } as any;
    expect(await recompressBatched(backend, [])).toEqual([]);
    expect(called).toBe(0);
  });

  it("index 重复时后者覆盖前者", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify({ items: [
      { index: 1, description: "先" }, { index: 1, description: "后" },
    ] })]);
    expect(await recompressBatched(backend, items)).toEqual(["后"]);
  });

  it("description 为空串视为缺失 → null", async () => {
    const items = [mk("a", "i1", "o1")];
    const backend = backendOf([JSON.stringify({ items: [{ index: 1, description: "   " }] })]);
    expect(await recompressBatched(backend, items)).toEqual([null]);
  });

  it("L5_BATCH_SIZE = 20", () => {
    expect(L5_BATCH_SIZE).toBe(20);
  });
});

describe("recompressOne", () => {
  const mk = (id: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4,
    summary: { entries: [], userIntent: "i", outcome: "o" },
  } as unknown as LedgerData);

  it("单条成功返回描述", async () => {
    const backend = { complete: async () => JSON.stringify({ items: [{ index: 1, description: "单条描述" }] }) } as any;
    expect(await recompressOne(backend, mk("a"))).toBe("单条描述");
  });

  it("失败抛错（供调用方降级为保持 L4）", async () => {
    const backend = { complete: async () => "不是 JSON" } as any;
    await expect(recompressOne(backend, mk("a"))).rejects.toThrow();
  });
});
