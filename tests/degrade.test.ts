import { describe, it, expect } from "vitest";
import { planDegrade, chooseOldestForLevel, turnRenderTokens, DegradeEngine } from "../src/degrade.js";
import type { LedgerData } from "../src/ledger.js";
import type { ContextCompressConfig } from "../src/config.js";

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
  it("片段上限 L3：holdAt3 中的条目不生成 toLevel>=4 的 step，普通条目照常降级", () => {
    // 三条：f1（片段，L3，渲染仅 ~10 tok）、old（普通，L3）、l4old（普通，已是 L4，~21013 tok）
    const ls: LedgerData[] = [ledger("f1", 3, 21000), ledger("old", 3, 21000), ledger("l4old", 4, 21000)];
    (ls[0] as any).isFragment = true;
    // Task 3 后 L3 片段渲染为机械标记行（~10 tok）；L3 层 21023 > 20000 触发瀑布，
    // 随后 L4 层（l4old + 刚升上来的 old）也超阈 → 产生真实 L5 降级（f1 不得进入）
    const plan = planDegrade(ls, 20000, 0, new Set(["f1"]));
    expect(plan.steps.find((s) => s.turnStartEntryId === "f1" && s.toLevel >= 4)).toBeUndefined();
    expect(plan.steps.find((s) => s.turnStartEntryId === "old" && s.toLevel === 4)).toBeDefined();
  });

  it("no plan when every level under threshold", () => {
    const ls = [ledger("a", 1, 1000), ledger("b", 1, 2000)];
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([]);
  });

  it("degrades oldest L1 turns preserving reserve floor when L1 exceeds threshold", () => {
    const ls = [1, 2, 3, 4, 5].map((i) => ledger(`t${i}`, 1, 9000));
    const p = planDegrade(ls, 40000, 10000);
    expect(p.steps).toEqual([
      { turnStartEntryId: "t1", toLevel: 2 }, { turnStartEntryId: "t2", toLevel: 2 },
      { turnStartEntryId: "t3", toLevel: 2 },
    ]);
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
  });

  it("L4 overflow degrades oldest to L5 steps", () => {
    const ls = [1, 2, 3, 4, 5, 6].map((i) => ledger(`t${i}`, 4, 9000));
    const p = planDegrade(ls, 40000, 10000);
    // 同上：54K → 选 4 条（t5 后剩 9K < reserve）
    expect(p.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("selects non-adjacent L4→L5 steps (oldest-first, reserve floor)", () => {
    const ls2 = [ledger("a1", 4, 9000), ledger("a2", 1, 9000), ledger("a3", 4, 9000), ledger("a4", 4, 9000), ledger("a5", 4, 9000), ledger("a6", 4, 9000), ledger("a7", 4, 9000)];
    const p2 = planDegrade(ls2, 40000, 10000);
    const ids = p2.steps.filter((s) => s.toLevel === 5).map((s) => s.turnStartEntryId);
    expect(ids).toEqual(["a1", "a3", "a4", "a5"]); // a6 保留：剩余 9K < reserve 10K
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

  it("L4→L5 单条失败时保持 L4 + warning（真实失败分支）", async () => {
    const warnings: string[] = [];
    let call = 0;
    const backend: Backend = {
      complete: async () => {
        call++;
        return call === 1 ? "不是JSON" : "{ 仍不是JSON }"; // 批量缺失 → 单条重跑也失败 → recompressOne 抛错
      },
    };
    const engine = new DegradeEngine(
      backend,
      { ledgerDegradeThresholdTokens: 20000, ledgerReserveTokens: 0 } as any,
      (d) => {}, (m) => warnings.push(m),
    );
    const ls = [ledger("a", 4, 30000)];
    await engine.run(ls);
    expect(call).toBeGreaterThanOrEqual(2); // 批量 + 单条重跑都真实发生（确实经过失败分支，非中间态平凡成立）
    expect(ls[0].level).toBe(4);   // 单条失败 → 保持 L4
    expect(ls[0].merged).toBeUndefined();
    expect(warnings.some((w) => w.includes("L5"))).toBe(true);
  });

  it("片段上限 L3：holdAt3 中的片段停在 L3，同层普通条目照常升 L4", async () => {
    const log: string[] = [];
    // 只有 old 走到 L3→L4 的 compressEnds，故一条响应足够
    const engine = new DegradeEngine(
      makeBackend(['{"userIntent":"i","outcome":"o"}'], log),
      { ledgerDegradeThresholdTokens: 20000, ledgerReserveTokens: 0 } as any,
      (d) => {}, () => {},
    );
    // 两条 L3：片段渲染为机械标记行（~10 tok），old 21013 tok → L3 层 21023 > 20000 触发降级；f1 是片段被豁免
    const ls = [ledger("f1", 3, 21000), ledger("old", 3, 21000)];
    (ls[0] as any).isFragment = true;
    await engine.run(ls, new Set(["f1"]));
    expect(ls[0].level).toBe(3);           // 片段终态 L3（L4 对片段语义为空，spec 2026-09-20 §2 裁定 3）
    expect(ls[0].summary.userIntent).toBeUndefined(); // 未被 compressEnds 触碰
    expect(ls[1].level).toBe(4);           // 同层普通条目照常降级
    expect(log).toEqual(["call0"]);
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

  it("L4 层的片段被 holdAt3 豁免：不生成 toLevel>=4 的 step，停在 L4", async () => {
    const log: string[] = [];
    const engine = new DegradeEngine(
      makeBackend(['{"items":[{"index":1,"description":"old 的二次摘要"}]}'], log),
      { ledgerDegradeThresholdTokens: 40000, ledgerReserveTokens: 0 } as any,
      (d) => {}, () => {},
    );
    const ls = [ledger("f1", 4, 21000), ledger("old", 4, 21000)];
    (ls[0] as any).isFragment = true;
    // 计划层断言：豁免语义在计划阶段生效（f1 无 toLevel>=4 的 step，old 照常计划升 L5）
    // 注意须在 engine.run 之前评估——run 会把 old 写成 level=5，再对同一数组 planDegrade 将看不到 L5 step
    const plan = planDegrade(ls, 40000, 0, new Set(["f1"]));
    expect(plan.steps.find((s) => s.turnStartEntryId === "f1" && s.toLevel >= 4)).toBeUndefined();
    expect(plan.steps.find((s) => s.turnStartEntryId === "old" && s.toLevel === 5)).toBeDefined();
    await engine.run(ls, new Set(["f1"]));
    // 执行层：old 成功升 L5 并写入 merged.description；f1 因豁免停在 L4、无 merged
    expect(ls[0].level).toBe(4);
    expect(ls[0].merged).toBeUndefined();
    expect(ls[1].level).toBe(5);
    expect(ls[1].merged?.description).toBe("old 的二次摘要");
    expect(log).toEqual(["call0"]); // 仅 old 一条进入 L5 批量调用
  });
});

describe("planDegrade 不再产出 mergeGroups", () => {
  it("返回值只有 steps 字段", () => {
    const plan = planDegrade([], 40_000, 10_000);
    expect(Object.keys(plan).sort()).toEqual(["steps"]);
    expect((plan as any).mergeGroups).toBeUndefined();
  });

  it("升 L5 的条目仍出现在 steps 中（toLevel=5）", () => {
    // 构造 5 条 L4，驱动 L4 层超阈 → 至少一条升 L5
    const mk = (id: string) => ({
      turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4 as const,
      summary: { entries: [], userIntent: "i", outcome: "很长的结果".repeat(300) },
    } as unknown as LedgerData);
    const ledgers = Array.from({ length: 5 }, (_, i) => mk("t" + i));
    const plan = planDegrade(ledgers, 1_000, 200);
    expect(plan.steps.some((s) => s.toLevel === 5)).toBe(true);
  });
});

describe("DegradeEngine L5 逐条压缩", () => {
  // 注意：reserve 须为 0——brief 原值 200 在 2 条 fixture（各 ~617 tok）下会因「选第 2 条后剩余 0 < 200」
  // 只选中 1 条，批量 n=1，永远走不到「批内缺失 → 单条重跑」分支（call 恒为 1）
  const cfgOf = (): ContextCompressConfig => ({
    ledgerDegradeThresholdTokens: 1_000, ledgerReserveTokens: 0,
    keepRecentTokens: 20_000, recallMaxTokensPerEntry: 4_000,
  } as ContextCompressConfig);

  const mk = (id: string, n = 0): LedgerData => ({
    turnStartEntryId: id, turnEndEntryId: id + "-e", level: 4 as const,
    summary: { entries: [], userIntent: "意图" + n, outcome: "结果".repeat(300) },
  } as unknown as LedgerData);

  const collect = () => {
    const out: LedgerData[] = [];
    const warns: string[] = [];
    return { out, warns, onLedger: (d: LedgerData) => out.push(d), onWarning: (m: string) => warns.push(m) };
  };

  it("每条 L5 获得独立描述（不含「条已合并」后缀）", async () => {
    const ledgers = Array.from({ length: 3 }, (_, i) => mk("t" + i, i));
    const backend = { complete: async (p: string) => {
      const n = (p.match(/\[#\d+\]/g) ?? []).length;
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ index: i + 1, description: "描述" + i })) });
    } } as any;
    const { out, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    const l5 = out.filter((d) => d.level === 5);
    expect(l5.length).toBeGreaterThan(0);
    for (const d of l5) {
      expect(d.merged?.description).toBeTruthy();
      expect(d.merged!.description).not.toContain("条已合并");
    }
    // 同一批内描述各不相同（逐条对应，非组共享）
    const descs = l5.map((d) => d.merged!.description);
    expect(new Set(descs).size).toBe(descs.length);
  });

  it("批内某条缺失 → 单独重跑该条（不整批重试）", async () => {
    const ledgers = Array.from({ length: 2 }, (_, i) => mk("t" + i, i));
    let call = 0;
    const backend = { complete: async (p: string) => {
      call++;
      const n = (p.match(/\[#\d+\]/g) ?? []).length;
      if (n > 1) return JSON.stringify({ items: [{ index: 1, description: "批内第一条" }] }); // 第二条缺失
      return JSON.stringify({ items: [{ index: 1, description: "单条补跑" }] });
    } } as any;
    const { out, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    const descs = out.filter((d) => d.level === 5).map((d) => d.merged!.description);
    expect(descs).toContain("单条补跑");
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("双跳级联：L4 compressEnds 失败回滚后，同 turn 不再被 L5 提升（保持 L3）", async () => {
    // t1 起点 L3（大 finalReply）在瀑布中双跳 toLevel=4+5；t2 起点 L4 → 仅 toLevel=5。
    // compressEnds 失败回滚 t1 为 L3 → L5 批只含 t2，t1 不得以空 intent/outcome 生成描述
    const ls = [
      { turnStartEntryId: "t1", turnEndEntryId: "t1", level: 3 as const, summary: { entries: [], userIntent: "意图1", outcome: "结果".repeat(300) }, finalReply: { text: "x".repeat(120000), entryId: "t1" } },
      { turnStartEntryId: "t2", turnEndEntryId: "t2", level: 4 as const, summary: { entries: [], userIntent: "意图2", outcome: "x".repeat(120000) } },
    ] as unknown as LedgerData[];
    let call = 0;
    const backend = { complete: async (p: string) => {
      call++;
      if (p.includes("对下文做摘要")) return "不是JSON"; // compressEnds 失败
      const n = (p.match(/\[#\d+\]/g) ?? []).length;
      return JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ index: i + 1, description: "描述" + i })) });
    } } as any;
    const { out, warns, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ls, undefined);
    expect(ls[0].level).toBe(3);   // L4 失败 → 保持 L3，未被 L5 覆盖
    expect(ls[0].merged).toBeUndefined();
    expect(ls[1].level).toBe(5);   // 其他条不受影响
    expect(ls[1].merged?.description).toBe("描述0");
    expect(warns.some((w) => w.includes("L4"))).toBe(true);
  });

  it("单条重跑仍失败 → 保持 L4 + warning，其他条不受影响", async () => {
    const ledgers = Array.from({ length: 2 }, (_, i) => mk("t" + i, i));
    let call = 0;
    const backend = { complete: async () => { call++; return call === 1 ? "不是JSON" : "也不是"; } } as any;
    const { out, warns, onLedger, onWarning } = collect();
    const eng = new DegradeEngine(backend, cfgOf(), onLedger, onWarning);
    await eng.run(ledgers, undefined);
    expect(out.some((d) => d.level === 5)).toBe(false);
    expect(warns.some((w) => w.includes("L5"))).toBe(true);
  });
});
