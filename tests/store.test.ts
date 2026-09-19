import { describe, it, expect } from "vitest";
import { LedgerStore } from "../src/store.js";
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "../src/ledger.js";
import type { SessionEntryLike } from "../src/store.js";

const led: LedgerData = {
  turnStartEntryId: "a", turnEndEntryId: "b",
  summary: { userIntent: "u", outcome: "o", entries: [] },
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

describe("absorbed 墓碑", () => {
  const frag = (id: string): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id,
    summary: { entries: [] },
  });

  it("rebuild 删除同名条目（墓碑压制 append-only 文件中先前同名条目，不复活）", () => {
    const store = new LedgerStore();
    store.set(frag("f1"));
    // 模拟墓碑化后的持久化条目
    const entries: SessionEntryLike[] = [
      { id: "e1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: { ...frag("f1"), absorbed: true } },
      { id: "e2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: frag("f2") },
    ];
    store.rebuildFromEntries(entries);
    expect(store.get("f1")).toBeUndefined();
    expect(store.get("f2")).toBeDefined();
  });

  it("delete 从缓存移除", () => {
    const store = new LedgerStore();
    store.set(frag("f1"));
    store.delete("f1");
    expect(store.get("f1")).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe("LedgerStore 旧 groups schema 兼容", () => {
  it("rebuild 时把 groups 嵌套 flatten 为扁平 entries 并继承 phase", () => {
    const legacy = {
      turnStartEntryId: "a", turnEndEntryId: "b",
      summary: {
        userIntent: "u",
        groups: [
          { phase: "investigate", entries: [{ action: "read", target: "x.ts", detail: "读文件", recallIds: ["e1"] }] },
          { phase: "verify", entries: [{ action: "bash", target: "npm test", detail: "通过", recallIds: ["e2"] }] },
        ],
      },
    };
    const s = new LedgerStore();
    s.rebuildFromEntries([{ id: "x1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: legacy }]);
    const got = s.get("a")!;
    expect(got.summary.entries.map((e) => e.target)).toEqual(["x.ts", "npm test"]);
    expect(got.summary.entries.map((e) => e.phase)).toEqual(["investigate", "verify"]);
    expect((got.summary as any).groups).toBeUndefined();
    expect(got.summary.userIntent).toBe("u");
  });
});
