import { describe, it, expect } from "vitest";
import { planDegrade, chooseOldestForLevel, turnRenderTokens } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";

/** 撑体积：L1/L2 渲染含 finalReply 全文，L3 渲染含 summary.outcome（全文）——按各层实际渲染字段填充 */
function ledger(id: string, level: 1 | 2 | 3, tokens: number): LedgerData {
  const pad = "x".repeat(tokens * 4);
  return {
    turnStartEntryId: id, turnEndEntryId: id, level,
    summary: { groups: [], ...(level === 3 ? { outcome: pad } : {}) },
    finalReply: level === 3 ? undefined : { text: pad, entryId: id, truncated: false },
  };
}

describe("planDegrade", () => {
  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("degrades oldest L1 turns beyond reserve when L1 exceeds threshold", () => {
    // 5 条 L1 各 ~9K = ~45K > 40K → 选中最旧若干条直至累计 ≥ 45K-10K=35K（前 4 条，保留 ~10K）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 }, { turnStartEntryId: "t4", toLevel: 2 },
    ]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("does not degrade when level total equals threshold exactly (<= not <)", () => {
    // 边界：total ≤ threshold 时不降级（用小阈值精确控制）
    const ls = [ledger("a", 1, 100), ledger("b", 1, 100)];
    const total = ls.reduce((s, l, i) => s + turnRenderTokens(l, i), 0);
    const p = planDegrade(ls, total, 50);
    expect(p.steps).toEqual([]);
  });

  it("waterfalls: L2 overflow degrades oldest to L3 (L1 under threshold untouched)", () => {
    // L2 已有 ~45K（5×9K）超阈值；L1 为空。L2 → 最旧降为 L3 直至保留 ~10K（前 4 条，累计 ~36K ≥ 35K）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 2, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 3).length).toBe(4);
    expect(p.steps.filter((s) => s.toLevel === 2).length).toBe(0);
    expect(p.mergeGroups).toEqual([]);
  });

  it("waterfall feeds down: L1 overflow creates new L2 counted in L2 total", () => {
    // L1 5×9K 超 → 前 4 条降 L2；此时 L2 共 4×9K=36K ≤ 40K → 不再往下
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 3).length).toBe(0);
  });

  it("groups consecutive L3→L4 selections into one merge group", () => {
    // L3 体积撑在 summary.outcome（L3 渲染含 outcome 全文，不含 finalReply 原文）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 3, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 4).length).toBe(4);
    expect(p.mergeGroups).toEqual([["t1", "t2", "t3", "t4"]]);
  });

  it("splits non-adjacent L3→L4 selections into separate groups", () => {
    // a(L3) 与 c/d(L3) 都被选中，但中间隔着 level=1 的 b（L1 未超不降）→ 两组
    const ls = [ledger("a", 3, 15000), ledger("b", 1, 30000), ledger("c", 3, 15000), ledger("d", 3, 15000)];
    const p = planDegrade(ls, 40000, 10000);
    // L1: 30K ≤ 40K 不动；L3: 45K > 40K，target=35K → 选 a(15K)+c(30K)+d(45K≥35K)
    expect(p.mergeGroups).toEqual([["a"], ["c", "d"]]);
  });

  it("single oversized oldest turn still selected (progress guarantee)", () => {
    const ls = [ledger("a", 1, 50000), ledger("b", 1, 100)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toContainEqual({ turnStartEntryId: "a", toLevel: 2 });
    expect(p.steps).not.toContainEqual({ turnStartEntryId: "b", toLevel: 2 });
  });

  it("does not mutate input ledgers (works on copies)", () => {
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    planDegrade(ls, 40000, 10000);
    expect(ls.every((l) => (l.level ?? 1) === 1)).toBe(true);
  });
});

describe("chooseOldestForLevel", () => {
  it("returns empty when level under threshold", () => {
    const ls = [ledger("a", 2, 1000)];
    expect(chooseOldestForLevel(ls, 2, 40000, 10000)).toEqual([]);
  });

  it("selects only entries of the requested level", () => {
    const ls = [ledger("a", 1, 100), ledger("b", 2, 20000), ledger("c", 2, 20000), ledger("d", 3, 100)];
    // L2: 40K > 阈值 30K → target = 40K-5K = 35K → 选 b+c
    const chosen = chooseOldestForLevel(ls, 2, 30000, 5000);
    expect(chosen.map((l) => l.turnStartEntryId)).toEqual(["b", "c"]);
  });

  it("counts only same-level entries toward total", () => {
    const ls = [ledger("a", 2, 5000), ledger("b", 1, 90000), ledger("c", 2, 5000)];
    // L2 总量 10K ≤ 12K 阈值 → 不降（b 的 90K 属 L1，不计入）
    expect(chooseOldestForLevel(ls, 2, 12000, 2000)).toEqual([]);
  });
});
