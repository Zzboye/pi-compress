import { describe, it, expect } from "vitest";
import { planDegrade, chooseOldestForLevel, turnRenderTokens, DegradeEngine } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";

/** 撑体积 helper：L1/L2/L3 渲染含 finalReply 全文，L4 渲染 intent/outcome（短），L5 渲染 merged 行（短） */
function ledger(id: string, level: 1 | 2 | 3 | 4, tokens: number): LedgerData {
  const pad = "x".repeat(tokens * 4);
  if (level === 4) {
    return {
      turnStartEntryId: id, turnEndEntryId: id, level: 4,
      summary: { userIntent: pad.slice(0, 10), outcome: pad, entries: [] },
    };
  }
  return {
    turnStartEntryId: id, turnEndEntryId: id, level,
    summary: { entries: [] },
    finalReply: { text: pad, entryId: id },
    userMessage: { text: "u", entryId: id },
  };
}

describe("planDegrade", () => {
  it("L5 豁免：holdAt4 中的条目不生成 toLevel=5 step，保持 L4", () => {
    const ls: LedgerData[] = [
      { turnStartEntryId: "f1", turnEndEntryId: "f1", summary: { entries: [] }, level: 4 },   // 片段
      { turnStartEntryId: "old", turnEndEntryId: "old", summary: { entries: [] }, level: 4 }, // 普通旧条目
    ];
    // brief 原 fixture（threshold=1, reserve=1）永不选中第二条（选 old 会剩 0 < reserve 1）→
    // 按用例意图（两者都被选中升 5）修正 reserve=0
    const plan = planDegrade(ls, 1, 0, new Set(["f1"]));
    expect(plan.steps.find((s) => s.turnStartEntryId === "f1" && s.toLevel === 5)).toBeUndefined();
    expect(plan.steps.find((s) => s.turnStartEntryId === "old" && s.toLevel === 5)).toBeDefined();
  });

  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("degrades oldest L1 turns preserving reserve floor when L1 exceeds threshold", () => {
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 },
    ]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("waterfalls: L2 overflow degrades oldest to L3", () => {
    // brief 原 fixture（L2 仅 3×9K=27K ≤ 40K）永不触发；按用例意图修正 fixture：
    // L1 2×9K=18K 未超阈不动；L2 5×9K=45K > 40K → 最旧 3 条降 L3（剩 18K ≥ reserve 10K）
    const ls = [ledger("t1", 1, 9000), ledger("t2", 1, 9000),
      ...[3, 4, 5, 6, 7].map((i) => ledger(`t${i}`, 2, 9000))];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t3", toLevel: 3 }, { turnStartEntryId: "t4", toLevel: 3 },
      { turnStartEntryId: "t5", toLevel: 3 },
    ]);
  });

  it("waterfall feeds down: L1 overflow creates new L2 counted in L2 total", () => {
    const ls = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    // L1 总 72K：选 6 条降 L2 剩 18K ≥ reserve；L2 快照 54K → 再选 4 条降 L3 剩 18K
    expect(p.steps.filter((s) => s.toLevel === 2)).toHaveLength(6);
    expect(p.steps.filter((s) => s.toLevel === 3)).toHaveLength(4);
  });

  it("L3 overflow degrades oldest to L4 (compressEnds level), not merge groups", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 3, 9000));
    const p = planDegrade(ls, 40000, 10000);
    // 6×9K=54K：选 t1-t4 后剩 18K ≥ 10K，选 t5 会剩 9K < 10K → 停在 4 条（与 splits 用例同口径）
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 4 }, { turnStartEntryId: "t2", toLevel: 4 },
      { turnStartEntryId: "t3", toLevel: 4 }, { turnStartEntryId: "t4", toLevel: 4 },
    ]);
    expect(p.mergeGroups).toEqual([]);
  });

  it("L4 overflow degrades to L5 and groups adjacent selections", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 4, 9000));
    const p = planDegrade(ls, 40000, 10000);
    // 同上：54K → 选 4 条（t5 后剩 9K < reserve）
    expect(p.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(p.mergeGroups).toEqual([["t1", "t2", "t3", "t4"]]);
  });

  it("splits non-adjacent L4→L5 selections into separate groups", () => {
    const ls2 = [ledger("a1", 4, 9000), ledger("a2", 1, 9000), ledger("a3", 4, 9000), ledger("a4", 4, 9000), ledger("a5", 4, 9000), ledger("a6", 4, 9000), ledger("a7", 4, 9000)];
    const p2 = planDegrade(ls2, 40000, 10000);
    const ids = p2.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId);
    expect(ids).toEqual(["a1", "a3", "a4", "a5"]); // a6 保留：剩余 9K < reserve 10K
    expect(p2.mergeGroups).toEqual([["a1"], ["a3", "a4", "a5"]]); // 非相邻分组
  });

  it("single oversized oldest turn still selected (progress guarantee)", () => {
    const ls = [ledger("big", 1, 50000)];
    const p = planDegrade(ls, 40000, 10000);
    // 单条超大 turn 在同一遍瀑布中逐层右移：L2/L3 渲染仍含 finalReply 全文（持续超阈）→
    // 一路降到 L4；L4 渲染只剩 intent/outcome 短行（~50 tok）→ 不再降 L5
    expect(p.steps).toEqual([
      { turnStartEntryId: "big", toLevel: 2 },
      { turnStartEntryId: "big", toLevel: 3 },
      { turnStartEntryId: "big", toLevel: 4 },
    ]);
  });

  it("does not mutate input ledgers (works on copies)", () => {
    const ls = [ledger("t1", 1, 30000), ledger("t2", 1, 30000)];
    planDegrade(ls, 40000, 10000);
    expect(ls[0].level).toBe(1);
    expect(ls[1].level).toBe(1);
  });
});

describe("chooseOldestForLevel", () => {
  it("returns empty when level under threshold", () => {
    expect(chooseOldestForLevel([ledger("a", 1, 1000)], 1, 40000, 10000)).toEqual([]);
  });

  it("selects only entries of the requested level", () => {
    const ls = [ledger("a", 1, 9000), ledger("b", 2, 9000), ledger("c", 1, 9000)];
    const got = chooseOldestForLevel(ls, 1, 12000, 5000);
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["a"]);
  });

  it("preserves hard reserve floor: stops before an entry would break the reserve", () => {
    const ls = [1, 2, 3, 4].map((i) => ledger(`t${i}`, 3, 9000));
    const got = chooseOldestForLevel(ls, 3, 20000, 10000);
    // 选 t1(9K)、t2(18K) 后剩 18K ≥ 10K；选 t3 会剩 9K < 10K → 停
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2"]);
  });

  it("degrades at least one entry when reserve floor unsatisfiable (progress guarantee)", () => {
    const ls = [ledger("big", 4, 50000)];
    const got = chooseOldestForLevel(ls, 4, 40000, 10000);
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["big"]);
  });

  it("accepts level 4 (L4→L5 selection)", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 4, 9000));
    const got = chooseOldestForLevel(ls, 4, 40000, 10000);
    // 54K → 选 4 条（硬下界：t5 会剩 9K < 10K）
    expect(got.map((l) => l.turnStartEntryId)).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("DegradeEngine", () => {
  type Backend = { complete(prompt: string, signal?: AbortSignal): Promise<string> };
  function makeBackend(responses: string[], log: string[]): Backend {
    let i = 0;
    return {
      complete: async (_p, _s) => {
        log.push(`call${i}`);
        return responses[i++] ?? "{}";
      },
    };
  }
  const config = { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 10000 } as any;

  it("applies L1->L2 rule degradation and persists via onLedger", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(makeBackend([], log), config, (d) => {}, () => {});
    const ls = [ledger("t1", 1, 30000), ledger("t2", 1, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(2);
    expect(log).toEqual([]); // 机械层零 LLM
  });

  it("L2->L3 is mechanical: no LLM call, no intent/outcome generation", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(makeBackend([], log), config, (d) => {}, () => {});
    const ls = [ledger("t1", 2, 30000), ledger("t2", 2, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(3);
    expect(log).toEqual([]); // spec 裁定 #3：L2→L3 零 LLM
  });

  it("uses backend compressEnds for L3->L4 and writes intent/outcome", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"userIntent":"修复排序","outcome":"已推送"}'], log),
      config, (d) => {}, () => {},
    );
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(4);
    expect(ls[0].summary.userIntent).toBe("修复排序");
    expect(ls[0].summary.outcome).toBe("已推送");
    expect(log).toEqual(["call0"]); // 单 turn 一条一次调用
  });

  it("rolls back L3->L4 to level 3 on backend failure and warns", async () => {
    const warnings: string[] = [];
    const backend: Backend = { complete: async () => { throw new Error("boom"); } };
    const engine = new DegradeEngine(backend, config, (d) => {}, (m) => warnings.push(m));
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(3);
    expect(warnings).toHaveLength(1);
  });

  it("merges L4→L5 group and stamps description on every member", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"description":"调查代码结构"}'], log),
      config, (d) => {}, () => {},
    );
    // brief 原 fixture（a、b 各 30K）只选得动 a（选 b 会剩 0 < reserve 10K）→ 组仅 1 条；
    // 补 c 使 a+b 成组（c 保留在硬下界内），才能验证「一组一次调用、逐成员盖章」
    const ls = [ledger("a", 4, 30000), ledger("b", 4, 30000), ledger("c", 4, 30000)];
    await engine.run(ls);
    expect(ls[0].level).toBe(5);
    expect(ls[1].level).toBe(5);
    expect(ls[2].level).toBe(4); // 硬下界保留区，不降
    expect(ls[0].merged?.description).toBe("调查代码结构（2 条已合并）"); // mergeDescribe 契约：附计数后缀
    expect(ls[1].merged?.description).toBe("调查代码结构（2 条已合并）");
    expect(log).toEqual(["call0"]); // 一组一次调用
  });

  it("rolls back L5 merge group to L4 on backend failure", async () => {
    const warnings: string[] = [];
    const backend: Backend = { complete: async () => { throw new Error("boom"); } };
    const engine = new DegradeEngine(backend, config, (d) => {}, (m) => warnings.push(m));
    const ls = [ledger("a", 4, 30000), ledger("b", 4, 30000)];
    await engine.run(ls);
    // 上游裁定 #1：合并失败时 level 从未被改（先 mergeDescribe 后置 L5），断言语义等价调整
    expect(ls[0].level).toBe(4);
    expect(ls[1].level).toBe(4);
    expect(ls[0].merged).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("L5 豁免：holdAt4 中的片段保持 L4，普通旧条目正常合并为 L5", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"description":"旧任务描述"}'], log),
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 0 } as any, // reserve=0：两条都被选中升 5（brief fixture 同款意图）
      (d) => {}, () => {},
    );
    const ls = [ledger("f1", 4, 21000), ledger("old", 4, 21000)];
    await engine.run(ls, new Set(["f1"]));
    expect(ls[0].level).toBe(4); // 片段终态 L4（L5 合并收益为零而拒绝召回是实害，裁定 7）
    expect(ls[0].merged).toBeUndefined();
    expect(ls[1].level).toBe(5);
    expect(ls[1].merged?.description).toBe("旧任务描述（1 条已合并）");
    expect(log).toEqual(["call0"]); // 仅旧条目所在组一次调用
  });

  it("executes serially: level written before LLM call, one call at a time", async () => {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const backend: Backend = {
      complete: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        log.push("call");
        return '{"userIntent":"i","outcome":"o"}';
      },
    };
    const engine = new DegradeEngine(backend, config, (d) => {}, () => {});
    const ls = [ledger("t1", 3, 30000), ledger("t2", 3, 30000), ledger("t3", 3, 30000)];
    await engine.run(ls);
    expect(maxInFlight).toBe(1);
  });
});
