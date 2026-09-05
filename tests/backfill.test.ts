import { describe, it, expect } from "vitest";
import { computeBackfillTurns } from "../src/backfill.js";
import type { Turn } from "../src/util.js";

function turn(id: string): Turn {
  return { startEntryId: id, endEntryId: id, entries: [] };
}
function storeWith(...summarized: string[]) {
  return { get: (id: string) => (summarized.includes(id) ? ({} as any) : undefined) };
}

describe("computeBackfillTurns", () => {
  it("returns only unsummarized turns, oldest-first (input order)", () => {
    const turns = [turn("t1"), turn("t2"), turn("t3")];
    const r = computeBackfillTurns(turns, storeWith("t2"), 20);
    expect(r.map((t) => t.startEntryId)).toEqual(["t1", "t3"]);
  });

  it("respects the cap, keeping the oldest", () => {
    const turns = [turn("t1"), turn("t2"), turn("t3"), turn("t4")];
    const r = computeBackfillTurns(turns, storeWith(), 2);
    expect(r.map((t) => t.startEntryId)).toEqual(["t1", "t2"]);
  });

  it("returns empty when limit is 0 (disabled)", () => {
    const turns = [turn("t1"), turn("t2")];
    expect(computeBackfillTurns(turns, storeWith(), 0)).toEqual([]);
  });

  it("returns empty when everything is summarized", () => {
    const turns = [turn("t1"), turn("t2")];
    expect(computeBackfillTurns(turns, storeWith("t1", "t2"), 20)).toEqual([]);
  });

  it("handles no turns", () => {
    expect(computeBackfillTurns([], storeWith(), 20)).toEqual([]);
  });
});
