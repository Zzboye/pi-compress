import { describe, it, expect } from "vitest";
import { planDegrade, chooseOldestForLevel, turnRenderTokens, DegradeEngine } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";

/** 撑体积：L1/L2 渲染含 finalReply 全文，L3 渲染含 summary.outcome（全文）——按各层实际渲染字段填充 */
function ledger(id: string, level: 1 | 2 | 3, tokens: number): LedgerData {
  const pad = "x".repeat(tokens * 4);
  return {
    turnStartEntryId: id, turnEndEntryId: id, level,
    summary: { entries: [], ...(level === 3 ? { outcome: pad } : {}) },
    finalReply: level === 3 ? undefined : { text: pad, entryId: id },
  };
}

describe("planDegrade", () => {
  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("degrades oldest L1 turns preserving reserve floor when L1 exceeds threshold", () => {
    // 5 条 L1 各 ~9K = ~45K > 40K，reserve 10K → 选中最旧若干条且剩余 ≥ 10K（前 3 条，保留 18K）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 },
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
    // L2 已有 ~45K（5×9K）超阈值；L1 为空。L2 → 最旧降为 L3，剩余 ≥ 10K（前 3 条，保留 18K）
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 2, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps.filter((s) => s.toLevel === 3).length).toBe(3);
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
    expect(p.steps.filter((s) => s.toLevel === 4).length).toBe(3);
    expect(p.mergeGroups).toEqual([["t1", "t2", "t3"]]);
  });

  it("splits non-adjacent L3→L4 selections into separate groups", () => {
    // a(L3) 与 c/d(L3) 都被选中，但中间隔着 level=1 的 b（L1 未超不降）→ 两组
    const ls = [ledger("a", 3, 15000), ledger("b", 1, 30000), ledger("c", 3, 15000), ledger("d", 3, 15000)];
    const p = planDegrade(ls, 40000, 10000);
    // L1: 30K ≤ 40K 不动；L3: 45K > 40K，reserve 10K → 选 a(15K，剩30K)+c(30K，剩15K)，选 d 后剩 0 < 10K 停
    expect(p.mergeGroups).toEqual([["a"], ["c"]]);
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
    // L2: 40K > 阈值 30K，reserve 5K → 选 b（剩 20K ≥ 5K）；选 c 后剩 0 < 5K 停
    const chosen = chooseOldestForLevel(ls, 2, 30000, 5000);
    expect(chosen.map((l) => l.turnStartEntryId)).toEqual(["b"]);
  });

  it("preserves hard reserve floor: stops before an entry would break the reserve", () => {
    // 硬下界语义：选中下一条前先检查「选中后剩余是否仍 ≥ reserve」；不够则停
    // 5×9K=45K，threshold 40K，reserve 15K → target=30K，前 3 条累计 27K < 30K，
    // 但选中第 4 条后剩余 45K-36K=9K < 15K → 停在前 3 条，保留 18K
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const chosen = chooseOldestForLevel(ls, 1, 40000, 15000);
    expect(chosen.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2", "t3"]);
  });

  it("degrades at least one entry when reserve floor unsatisfiable (progress guarantee)", () => {
    // 保留区不可满足时（最旧一条就击穿 reserve）仍选第一条保证降级有进展
    // 2×6K=12K > threshold 8K，reserve 10K：选 t1 后剩余 6K < 10K → 若硬停则零进展；强制选 t1
    const ls = [ledger("t1", 1, 6000), ledger("t2", 1, 6000)];
    const chosen = chooseOldestForLevel(ls, 1, 8000, 10000);
    expect(chosen.map((l) => l.turnStartEntryId)).toEqual(["t1"]);
  });

  it("counts only same-level entries toward total", () => {
    const ls = [ledger("a", 2, 5000), ledger("b", 1, 90000), ledger("c", 2, 5000)];
    // L2 总量 10K ≤ 12K 阈值 → 不降（b 的 90K 属 L1，不计入）
    expect(chooseOldestForLevel(ls, 2, 12000, 2000)).toEqual([]);
  });
});

describe("DegradeEngine", () => {
  const ENGINE_CONFIG = { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any;

  function big(id: string, tokens: number, level: 1 | 2 | 3 = 1): LedgerData {
    const pad = "x".repeat(tokens * 4);
    return {
      turnStartEntryId: id, turnEndEntryId: id, level,
      summary: { entries: [], ...(level === 3 ? { outcome: pad } : {}) },
      userMessage: { text: "u".repeat(40), entryId: id + "u" },
      finalReply: level === 3 ? undefined : { text: pad, entryId: id + "r" },
    };
  }

  it("applies L1->L2 rule degradation and persists via onLedger", async () => {
    const saved: LedgerData[] = [];
    const eng = new DegradeEngine(
      { async complete() { throw new Error("should not call"); } } as any,
      ENGINE_CONFIG,
      (d) => saved.push(d), () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000));
    await eng.run(ls);
    expect(ls[0].level).toBe(2);
    expect(ls[4].level).toBe(1);
    expect(saved.some((d) => d.turnStartEntryId === "t1" && d.level === 2)).toBe(true);
  });

  it("does not call LLM when plan is empty (L1 under threshold short-circuits)", async () => {
    let llmCalls = 0;
    const backend = { async complete() { llmCalls++; return "{}"; } };
    const eng = new DegradeEngine(backend as any, ENGINE_CONFIG, () => {}, () => {});
    const ls = [1, 2].map((i) => big(`t${i}`, 1000));
    await eng.run(ls);
    expect(llmCalls).toBe(0);
  });

  it("uses backend for L2->L3 and writes intent/outcome", async () => {
    const saved: LedgerData[] = [];
    const backend = { async complete() { return '{"userIntent":"了解结构","outcome":"确认占位"}'; } };
    const eng = new DegradeEngine(backend as any, ENGINE_CONFIG, (d) => saved.push(d), () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000, 2));
    await eng.run(ls);
    expect(ls[0].level).toBe(3);
    expect(ls[0].summary.userIntent).toBe("了解结构");
    expect(ls[0].summary.outcome).toBe("确认占位");
    expect(saved.some((d) => d.turnStartEntryId === "t1" && d.summary.outcome === "确认占位")).toBe(true);
  });

  it("rolls back level on backend failure and warns without aborting the run", async () => {
    const warns: string[] = [];
    const eng = new DegradeEngine(
      { async complete() { throw new Error("boom"); } } as any,
      ENGINE_CONFIG, () => {}, (m) => warns.push(m));
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000, 2));
    await eng.run(ls);
    expect(ls[0].level).toBe(2); // 回滚：保持原层级
    expect(ls[0].summary.userIntent).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });

  it("merges L3 group and stamps description on every member", async () => {
    const backend = { async complete() { return '{"description":"调查代码结构"}'; } };
    const eng = new DegradeEngine(backend as any, ENGINE_CONFIG, () => {}, () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000, 3));
    await eng.run(ls);
    // 硬下界 reserve 10K：t1-t3 后剩 18K，选 t4 后剩 9K < 10K → 组仅 3 条
    expect(ls[0].level).toBe(4);
    expect(ls[2].merged?.description).toBe("调查代码结构（3 条已合并）");
    expect(ls[3].level).toBe(3); // 保留区内不降
    expect(ls[4].level).toBe(3);
  });

  it("rolls back merge group to L3 on backend failure", async () => {
    const warns: string[] = [];
    const eng = new DegradeEngine(
      { async complete() { throw new Error("boom"); } } as any,
      ENGINE_CONFIG, () => {}, (m) => warns.push(m));
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000, 3));
    await eng.run(ls);
    expect(ls[0].level).toBe(3);
    expect(ls[0].merged).toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });

  it("executes serially: level written before LLM call, one call at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Array<{ levelWhenCalled: number }> = [];
    const backend = {
      async complete() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const l = ls.find((x) => (x.level ?? 1) === 2)!; // 调用时该条 level 已写为 3？验证时序
        calls.push({ levelWhenCalled: ls.filter((x) => (x.level ?? 1) === 3).length });
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return '{"userIntent":"i","outcome":"o"}';
      },
    };
    const eng = new DegradeEngine(backend as any, ENGINE_CONFIG, () => {}, () => {});
    const ls = [1, 2, 3, 4, 5].map((i) => big(`t${i}`, 9000, 2));
    await eng.run(ls);
    expect(maxInFlight).toBe(1); // 串行，无并发
    expect(calls[0].levelWhenCalled).toBe(1); // 第一条调用时 level 已先写入
  });
});
