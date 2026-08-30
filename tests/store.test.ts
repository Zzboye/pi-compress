import { describe, it, expect } from "vitest";
import { LedgerStore } from "../src/store.js";
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "../src/ledger.js";

const led: LedgerData = {
  turnStartEntryId: "a", turnEndEntryId: "b",
  summary: { userIntent: "u", outcome: "o", groups: [{ phase: "other", entries: [{ action: "bash", target: "ls", detail: "d", recallIds: ["a"] }] }] },
};

describe("LedgerStore", () => {
  it("rebuilds cache from ledger custom entries, ignoring other types", () => {
    const s = new LedgerStore();
    s.rebuildFromEntries([
      { id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led },
      { id: "x2", type: "custom", customType: "some-other-ext", data: { foo: 1 } },
      { id: "x3", type: "message" },
      { id: "x4", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { turnStartEntryId: "bad" } }, // 无效数据跳过
    ]);
    expect(s.size()).toBe(1);
    expect(s.get("a")).toEqual(led);
  });

  it("set and get roundtrip", () => {
    const s = new LedgerStore();
    s.set(led);
    expect(s.get("a")).toEqual(led);
    expect(s.size()).toBe(1);
  });

  it("later entries win on duplicate turnKey (re-summarized)", () => {
    const s = new LedgerStore();
    const led2 = { ...led, summary: { ...led.summary, outcome: "o2" } };
    s.rebuildFromEntries([
      { id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led },
      { id: "x2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: led2 },
    ]);
    expect(s.get("a")?.summary.outcome).toBe("o2");
  });
});
