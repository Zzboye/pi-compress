import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import piExtension from "../src/index.js";
import { assembleContext } from "../src/assembler.js";
import { compactionAwareEntries } from "../src/util.js";
import { LEDGER_CUSTOM_TYPE, renderTurnText, type LedgerData, type LedgerLevel } from "../src/ledger.js";
import { LedgerStore } from "../src/store.js";
import { NoteStore } from "../src/notes.js";

function mkLedger(partial: Partial<LedgerData> & { turnStartEntryId: string }): LedgerData {
  return {
    turnEndEntryId: partial.turnStartEntryId + "-end",
    summary: { entries: [] },
    ...partial,
  } as LedgerData;
}

describe("extension entry wiring", () => {
  function harness() {
    const tools: Record<string, any> = {};
    const commands: Record<string, any> = {};
    const handlers: Record<string, any> = {};
    const fakePi: any = {
      on: vi.fn((name: string, fn: any) => { handlers[name] = fn; }),
      registerTool: vi.fn((t: any) => { tools[t.name] = t; }),
      registerCommand: vi.fn((name: string, opts: any) => { commands[name] = opts; }),
    };
    piExtension(fakePi);
    return { tools, commands, fakePi, handlers };
  }

  it("registers recall tool and compress-status/compress-dump commands", () => {
    const { tools, commands } = harness();
    expect(tools.recall).toBeTruthy();
    expect(tools.recall.parameters).toBeTruthy();
    expect(commands["compress-status"]).toBeTruthy();
    expect(commands["compress-dump"]).toBeTruthy();
  });

  it("compress-dump writes Markdown+JSON pair and echoes one-line summary", async () => {
    const { commands, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-dumpcmd-"));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-dumpcfg-"));
    try {
      const notifyCalls: string[] = [];
      const branch = [
        { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
        { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
        sessionManager: { getBranch: () => branch },
      };
      // 未配置 → 明确拒绝（不用默认配置冒充真实装配）
      await commands["compress-dump"].handler("", fakeCtx);
      expect(notifyCalls.at(-1)).toContain("未配置");
      expect(fs.readdirSync(dir)).toEqual([]);

      // session_start 载入真实配置（registry summarizer；modelRegistry 缺失只会令补摘异步失败，不影响 dump）
      fs.mkdirSync(path.join(cfgDir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, ".pi", "settings.json"),
        JSON.stringify({ contextCompress: { summarizer: { provider: "FakeProv", model: "fake-model" } } }),
      );
      await handlers.session_start({}, { ...fakeCtx, cwd: cfgDir });
      fakeCtx.cwd = cfgDir;
      await commands["compress-dump"].handler("", fakeCtx);
      // dump 通知与补摘失败通知存在竞态：轮询等“转储”出现
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !notifyCalls.some((m) => m.includes("转储："))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const reports = fs.readdirSync(path.join(cfgDir, "e2e", "reports"));
      expect(reports.length).toBe(2); // .md + .json
      expect(reports.some((f) => f.endsWith(".md"))).toBe(true);
      expect(reports.some((f) => f.endsWith(".json"))).toBe(true);
      const dumpNotify = notifyCalls.find((m) => m.includes("转储："));
      expect(dumpNotify).toContain("窗口");
      expect(dumpNotify).toContain("e2e");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it("compress-status handler reports unconfigured state", async () => {
    const { commands } = harness();
    const notifyCalls: string[] = [];
    const fakeCtx: any = {
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
    };
    // session_start 未触发 → config=null → 但 handler 用了模块状态；直接调 handler 看降级输出
    await commands["compress-status"].handler("", fakeCtx);
    const out = notifyCalls.join("\n");
    expect(out).toContain("已摘要 turn 数");
    expect(out).toContain("未配置"); // 无 summarizer 配置
    expect(out).toContain("降级状态");
  });

  it("runDegrade: 按 branch 时间序降级，硬下界保留区覆盖最新 turn，窗口内不参与降级", async () => {
    // 回归背景：entry ID 非时间递增，旧实现按 localeCompare 字典序取 ledgers，
    // 导致保留区落在随机位置、最新 turn 反被降级。此处 entry ID 字典序与时间序完全相反，
    // 旧排序会把保留区留在最旧的 z1/y2 上（bug 行为），新实现必须按时间序保留 v5/u6。
    const { handlers } = harness();
    const notifyCalls: string[] = [];
    const writes: any[] = [];   // 捕获 onLedger → appendCustomEntry 的持久化写入
    // 6 个窗外 turn，各 ~1.2K tok 渲染（user 600 CJK + reply 600 CJK），总 ~6K > 阈值 5K（config 下限 5000）
    // 时间序: z1(最旧) → y2 → x3 → w4 → v5 → u6(最新窗外)
    const timeOrder = ["z1", "y2", "x3", "w4", "v5", "u6"];
    const mkL1 = (start: string) => ({
      turnStartEntryId: start, turnEndEntryId: start + "-a", level: 1,
      summary: { entries: [] },
      userMessage: { text: "字".repeat(600), entryId: start },
      finalReply: { text: "复".repeat(600), entryId: start + "-a" },
    });
    const branch: any[] = [];
    for (const id of timeOrder) {
      branch.push({ id, type: "message", message: { role: "user", content: [{ type: "text", text: "字".repeat(600) }] } });
      branch.push({ id: id + "-a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "复".repeat(600) }] } });
      branch.push({ id: id + "-l", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkL1(id) });
    }
    // 窗口内：最新 turn（字典序又是最小，旧 bug 会拿它当「最旧」降级）
    branch.push({ id: "n9", type: "message", message: { role: "user", content: [{ type: "text", text: "窗口内最新" }] } });
    branch.push({ id: "n9-a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-degrade-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({
      contextCompress: {
        summarizer: { kind: "registry", provider: "FakeBig", model: "big" },
        keepRecentTokens: 1000,             // 仅最新 turn（n9，~10 tok）在窗口内
        ledgerDegradeThresholdTokens: 5000, // L1 总量 ~6K > 5K → 触发降级（config 下限 5000）
        ledgerReserveTokens: 1500,          // 硬下界：剩余 ≥ 1.5K 才继续降
        backfillLimit: 10,
      },
    }));
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: {
        getBranch: () => branch,
        appendCustomEntry: (_t: string, d: any) => writes.push(d),
      },
      modelRegistry: {
        find: () => ({ provider: "FakeBig", model: "big" }),
        complete: async () => ({ content: [{ type: "text", text: JSON.stringify({
          entries: [
            { target: "z1", detail: "d1", phase: "other" },
            { target: "y2", detail: "d2", phase: "other" },
            { target: "x3", detail: "d3", phase: "other" },
            { target: "w4", detail: "d4", phase: "other" },
          ],
        }) }] }),
      },
    };
    try {
      await handlers.session_start({}, fakeCtx);   // backfill n9 → 完成后触发 runDegrade
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !writes.some((d) => d.level === 2)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const lvl = (id: string) => branch.find((e) => e.id === id + "-l").data.level;
      // 窗口外 ledger 是 session_start 重建的独立对象，检查 store 内最新 level —— 通过再触发一次 dump 校验太重，
      // 直接断言持久化写入：降级目标按时间序应是最旧的 z1..w4，保留 v5/u6
      const degraded = writes.filter((d) => d.level === 2).map((d) => d.turnStartEntryId);
      // keepRecent=1000 → 窗口={n9}；窗外 6 条共 ~7.3K > 阈值 5K；
      // 硬下界 1500：z1..v5 降级后剩 ~1.2K < 1.5K 停 → 降最旧 4 条（z1..w4），v5/u6 保留
      expect(degraded.sort()).toEqual(["v5", "w4", "x3", "y2", "z1"].filter((x) => x !== "v5")); // 时间序最旧 4 条降级（非字典序尾部）
      expect(lvl("v5")).toBe(1);  // 硬下界保留区（时间序靠新）
      expect(lvl("u6")).toBe(1);
      expect(notifyCalls.join("")).not.toContain("摘要失败");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("降级瀑布接入片段：片段保持 L4 形态（L5 豁免），普通旧 turn 合并为 L5 行", async () => {
    // 长任务多片段：进行中 turn（u_n）已有两个落盘片段（key 落在中间条目 a_n1/a_n2，≠ turn 起点）；
    // 它们参与降级计量（否则溢出部分永远不降），但被 holdAt4 豁免 L5——片段 L5 合并收益为
    // 零而拒绝召回是实害（裁定 7），终态 L4。旧 turn（o1/o2，L4）照常合并为 L5 行。
    const { handlers } = harness();
    const notifyCalls: string[] = [];
    const writes: any[] = [];
    const CJK = (n: number) => "查".repeat(n);
    const mkL4 = (start: string, end: string) => ({
      turnStartEntryId: start, turnEndEntryId: end, level: 4 as const,
      summary: { userIntent: CJK(700), outcome: CJK(700), entries: [] }, // 渲染 ~1.4K tok/条
    });
    const branch: any[] = [];
    // 旧 turn ×2（窗外；消息各 ~1.2K tok > keepRecent 1000，窗口只剩末 turn）
    for (const id of ["o1", "o2"]) {
      branch.push({ id, type: "message", message: { role: "user", content: [{ type: "text", text: CJK(600) }] } });
      branch.push({ id: id + "-a", type: "message", message: { role: "assistant", content: [{ type: "text", text: CJK(600) }] } });
      branch.push({ id: id + "-lg", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkL4(id, id + "-a") });
    }
    // 进行中 turn：u_n 起点（无整 turn ledger）→ a_n1/r_n1（片段 1）→ a_n2（片段 2）
    branch.push({ id: "u_n", type: "message", message: { role: "user", content: [{ type: "text", text: "继续" }] } });
    branch.push({ id: "a_n1", type: "message", message: { role: "assistant", content: [{ type: "text", text: CJK(10) }] } });
    branch.push({ id: "r_n1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ok" }] } });
    branch.push({ id: "lg_f1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkL4("a_n1", "r_n1") });
    branch.push({ id: "a_n2", type: "message", message: { role: "assistant", content: [{ type: "text", text: CJK(10) }] } });
    branch.push({ id: "lg_f2", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkL4("a_n2", "a_n2") });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-frag-degrade-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({
      contextCompress: {
        summarizer: { kind: "registry", provider: "FakeBig", model: "big" },
        keepRecentTokens: 1000,             // 窗口 = 末 turn（u_n）
        ledgerDegradeThresholdTokens: 5000, // L4 总量 4×~1.4K ≈ 5.7K > 5K → 触发降级
        ledgerReserveTokens: 1000,          // 硬下界：o1/o2/frag1 被选中（frag2 保留）
        backfillLimit: 10,
      },
    }));
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: {
        getBranch: () => branch,
        appendCustomEntry: (_t: string, d: any) => writes.push(d),
      },
      modelRegistry: {
        find: () => ({ provider: "FakeBig", model: "big" }),
        // 按 prompt 路由：整 turn 摘要（动作记录员）与 L5 合并描述走不同 schema
        complete: async (_model: any, req: any) => {
          const prompt: string = req.messages[0].content[0].text;
          if (prompt.includes("合并为一行主题描述")) {
            return { content: [{ type: "text", text: JSON.stringify({ description: "早期排查与修复" }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ entries: [] }) }] };
        },
      },
    };
    try {
      await handlers.session_start({}, fakeCtx);   // backfill u_n → 完成后触发 runDegrade
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !writes.some((d) => d.level === 5)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // 普通 old turn：正常合并为 L5 行
      const l5 = writes.filter((d) => d.level === 5).map((d) => d.turnStartEntryId).sort();
      expect(l5).toEqual(["o1", "o2"]);
      expect(writes.find((d) => d.turnStartEntryId === "o1")?.merged?.description).toContain("（2 条已合并）");
      // 片段：参与降级（frag1 被选中升 5），但被 holdAt4 豁免 → 终态 L4，无 L5 写入
      expect(writes.some((d) => (d.turnStartEntryId === "a_n1" || d.turnStartEntryId === "a_n2") && d.level === 5)).toBe(false);
      for (const f of ["lg_f1", "lg_f2"]) {
        const frag = branch.find((e) => e.id === f).data;
        expect(frag.level).toBe(4);
        const text = renderTurnText(frag, 3); // L4 形态：意图 + outcome 两行
        expect(text).toContain("意图：");
        expect(text).toContain("最终回复（摘要）：");
      }
      expect(notifyCalls.join("")).not.toContain("摘要失败");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers 4 event handlers (session_start/context/agent_settled/session_before_compact)", () => {
    const { fakePi } = harness();
    const events = fakePi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_start");
    expect(events).toContain("context");
    expect(events).toContain("agent_settled");
    expect(events).toContain("session_before_compact");
    expect(fakePi.on.mock.calls.length).toBe(4);
  });

  it("counts recall tool usage and shows it in compress-status", async () => {
    const { tools, commands } = harness();
    const notifyCalls: string[] = [];
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "原文内容" }] } },
    ];
    const fakeCtx: any = {
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await tools.recall.execute("tc1", { ids: ["u1", "gone"] }, undefined, undefined, fakeCtx);
    await tools.recall.execute("tc2", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    await commands["compress-status"].handler("", fakeCtx);
    const out = notifyCalls.join("\n");
    expect(out).toContain("调用 2");      // 2 次 recall 调用
    expect(out).toContain("取回 2 条");  // u1 命中两次
    expect(out).toContain("未中 1 个");  // gone 未命中
  });

  it("compress-status 统计口径：L5 拒绝计入「L5 拒绝」不计入取回（M9）", async () => {
    const { tools, handlers, commands } = harness();
    const notifyCalls: string[] = [];
    // 复用 recall 路由测试的 withLedger 形状：branch + L5 ledger → session_start 重建 store →
    // recall 走 L5 拒绝路径，随后 status 应显示「L5 拒绝 1 个」且取回不含该 ID
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
      { id: "lg1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({ turnStartEntryId: "u1", level: 5 as any }) },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await handlers.session_start({}, fakeCtx);
    await tools.recall.execute("tc1", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    await commands["compress-status"].handler("", fakeCtx);
    const out = notifyCalls.join("\n");
    expect(out).toContain("L5 拒绝 1 个");
    expect(out).not.toContain("取回 1 条"); // 旧行为：拒绝被计入取回
  });

  it("compress-status 显示项目记忆行（启用含三表计数与召回数；未启用含未启用）", async () => {
    // ① enabled：三表各预置一条，recall 命中一条记忆 → 状态行含计数与「/ 记忆召回」
    const { tools, commands, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-status-notes-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: true, path: "notes.json", maxTokens: 0 } } }),
    );
    const seed = new NoteStore(path.join(dir, "notes.json"));
    seed.load();
    seed.append("prefs", { text: "commit message 用中文" });
    seed.append("feedback", { text: "摘要行", detail: "详情全文" });
    seed.append("tasks", { text: "任务决策", status: "进行中" });
    seed.save();
    const notifyCalls: string[] = [];
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx);
      await tools.recall.execute("tc1", { ids: ["fb-001"] }, undefined, undefined, fakeCtx);
      await commands["compress-status"].handler("", fakeCtx);
      const out = notifyCalls.join("\n");
      expect(out).toContain("项目记忆：启用 · 3 条（偏好 1 / 经验 1 / 任务 1）· 召回 1 条");
      // 召回行末尾追加记忆召回统计（既有文案不动）
      expect(out).toContain("/ 记忆召回 1 条");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // ② 未配置（session_start 未触发 → notesStore=null）
    const h2 = harness();
    const notify2: string[] = [];
    await h2.commands["compress-status"].handler("", { ui: { notify: (m: string) => notify2.push(m), setStatus: () => {} } });
    expect(notify2.join("\n")).toContain("项目记忆：未启用");
  });

  it("compress-status：enabled=false 时即使 notesStore 已构造且有条目，项目记忆行仍显示未启用", async () => {
    const { commands, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-status-off-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: false, path: "notes.json", maxTokens: 0 } } }),
    );
    const seed = new NoteStore(path.join(dir, "notes.json"));
    seed.load();
    seed.append("prefs", { text: "commit message 用中文" });
    seed.save();
    const notifyCalls: string[] = [];
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx); // notesStore 已构造并 load（enabled 只关注入不关收集）
      await commands["compress-status"].handler("", fakeCtx);
      const out = notifyCalls.join("\n");
      expect(out).toContain("项目记忆：未启用");
      expect(out).not.toContain("项目记忆：启用");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("context 事件记录估算与真实 usage，compress-status 并排显示（校准观察）", async () => {
    const { handlers, commands } = harness();
    const notifyCalls: string[] = [];
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一".repeat(50) }] } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答".repeat(50) }] } },
      { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "第二".repeat(50) }] } },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答".repeat(50) }] } },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => ({ tokens: 12345, contextWindow: 200_000 }),
    };
    await handlers.session_start({}, fakeCtx);
    await handlers.context({}, fakeCtx);
    await commands["compress-status"].handler("", fakeCtx);
    const out = notifyCalls.join("\n");
    expect(out).toMatch(/估算 ~\d+ tok · 真实 12345 tok/); // 并排显示
  });

  it("resets recall stats on session_start", async () => {
    const { tools, commands, handlers } = harness();
    const notifyCalls: string[] = [];
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "原文内容" }] } },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await tools.recall.execute("tc1", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    await handlers.session_start({}, fakeCtx);
    await commands["compress-status"].handler("", fakeCtx);
    const out = notifyCalls.join("\n");
    expect(out).toContain("调用 0");
  });

  it("recall 支持 query：返回命中索引（含 turn 标签/片段/↩ID）且计入 searches 统计", async () => {
    const { tools, commands, handlers } = harness();
    const notifyCalls: string[] = [];
    const ledger = mkLedger({
      turnStartEntryId: "u1", level: 1,   // 与 branch 首条 user 消息同 ID（真实会话口径）
      userMessage: { text: "forceRatio 是什么？为什么默认 0.76", entryId: "t1-u" },
      finalReply: { text: "forceRatio 是触发强制点的比例", entryId: "t1-f" },
      summary: { userIntent: "了解强制点", entries: [] },
    });
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
      { id: "c1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: ledger },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await handlers.session_start({}, fakeCtx); // store 重建：ledger 落入缓存
    const out = await tools.recall.execute("tc1", { query: "forceRatio" }, undefined, undefined, fakeCtx);
    const text = out.content[0].text;
    expect(text).toContain("T1");          // turn 标签
    expect(text).toContain("↩t1-u");       // 可 recall 的 ID
    expect(text).toContain("forceRatio");  // 命中片段
    await commands["compress-status"].handler("", fakeCtx);
    const status = notifyCalls.join("\n");
    expect(status).toContain("搜索 1");
    // query 模式不计入 calls（calls 只计逐字取回）
    expect(status).toContain("调用 0");
  });

  it("recall 工具返回混合 content（文本 + image 块）", async () => {
    const { tools } = harness();
    const pngBlock = { type: "image", mimeType: "image/png", data: "AAAA" };
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "看图" }, pngBlock] } },
    ];
    const fakeCtx: any = {
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    const out = await tools.recall.execute("tc1", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    expect(out.content.length).toBe(2);              // 文本 + image 块
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("看图");
    expect(out.content[0].text).toContain("[含图片 ×1，已附在结果中]");
    expect(out.content[1]).toEqual(pngBlock);        // 第二块为原样 image 块
  });

  it("recall 只传 query、只传 ids 均合法；都不传返回用法提示", async () => {
    const { tools, handlers } = harness();
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
      { id: "c1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({
        turnStartEntryId: "t1", level: 1,
        userMessage: { text: "forceRatio 是什么", entryId: "t1-u" },
      }) },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await handlers.session_start({}, fakeCtx);
    const q = await tools.recall.execute("tc1", { query: "forceRatio" }, undefined, undefined, fakeCtx);
    expect(q.content[0].text).toContain("命中");
    const ids = await tools.recall.execute("tc2", { ids: ["u1"] }, undefined, undefined, fakeCtx);
    expect(ids.content[0].text).toContain("第一问");
    const neither = await tools.recall.execute("tc3", {}, undefined, undefined, fakeCtx);
    expect(neither.content[0].text).toContain("用法");
  });

  it("无命中时返回可操作的提示（建议换关键词）", async () => {
    const { tools, handlers } = harness();
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
      { id: "c1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({
        turnStartEntryId: "t1", level: 1,
        userMessage: { text: "forceRatio 是什么", entryId: "t1-u" },
      }) },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await handlers.session_start({}, fakeCtx);
    const out = await tools.recall.execute("tc1", { query: "绝不存在的词zzz" }, undefined, undefined, fakeCtx);
    expect(out.content[0].text).toContain("无命中");
  });

  it("notes 注入：enabled 时项目记忆块插在 ledger 头之前；disabled 时不注入", async () => {
    const mkCase = async (enabled: boolean) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-notes-"));
      try {
        // 用 NoteStore 生成真实 notes.json（含偏好+进行中任务）
        const store = new NoteStore(path.join(dir, "notes.json"));
        store.load();
        store.append("prefs", { text: "commit message 用中文", locked: true });
        store.append("tasks", { text: "写注入集成测试", detail: "d", status: "进行中" });
        store.save();
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, ".pi", "settings.json"),
          JSON.stringify({
            contextCompress: {
              projectNotes: { enabled, path: "notes.json", maxTokens: 0 }, // 相对 cwd 解析
              keepRecentTokens: 1000, // 最小值；第一 turn 塞到 600 汉字（>1000 tok）使其落在窗外、由 ledger 头替代
            },
          }),
        );
        const { handlers } = harness();
        const ledger = mkLedger({ turnStartEntryId: "u1", level: 1, summary: { entries: [] } });
        const branch = [
          { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "问".repeat(1200) }] } },
          { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
          { id: "c1", parentId: "a1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: ledger },
          { id: "u2", parentId: "c1", type: "message", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
          { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二答" }] } },
        ];
        const fakeCtx: any = {
          cwd: dir,
          ui: { notify: () => {}, setStatus: () => {} },
          sessionManager: { getBranch: () => branch },
          getContextUsage: () => ({ tokens: 100, contextWindow: 200_000 }),
        };
        await handlers.session_start({}, fakeCtx); // notesStore 按 config.projectNotes.path（相对 cwd）构造并 load
        const res = await handlers.context({}, fakeCtx);
        return res?.messages ?? [];
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    // enabled：messages[0] 为项目记忆块，ledger 头在其后
    const messages = await mkCase(true);
    expect(messages.length).toBeGreaterThan(1);
    const notesText = JSON.stringify(messages[0]);
    expect(notesText).toContain("项目记忆");
    expect(notesText).toContain("commit message 用中文");
    expect(notesText).toContain("↩pref-001");
    const ledgerIdx = messages.findIndex((m: any) => JSON.stringify(m).includes("<action-ledger>"));
    expect(ledgerIdx).toBeGreaterThan(0); // notes 块插在 ledger 头之前

    // disabled：不注入
    const messagesOff = await mkCase(false);
    expect(messagesOff.some((m: any) => JSON.stringify(m).includes("项目记忆"))).toBe(false);
  });

  it("notes 工具 append→update→delete 全链路；locked 条目拒绝改删，工具写的 prefs 不锁定", async () => {
    const { tools, commands, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-notes-tool-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: true, path: "notes.json", maxTokens: 0 } } }),
    );
    const notesPath = path.join(dir, "notes.json");
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx);
      const r1 = await tools.notes.execute("tc", { action: "append", table: "feedback", text: "T", detail: "D", status: "有效" }, undefined, undefined, fakeCtx);
      expect(r1.content[0].text).toContain("fb-001");
      const r2 = await tools.notes.execute("tc", { action: "update", id: "fb-001", status: "纠正" }, undefined, undefined, fakeCtx);
      expect(r2.content[0].text).toContain("纠正");
      const r3 = await tools.notes.execute("tc", { action: "append", table: "prefs", text: "P" }, undefined, undefined, fakeCtx);
      expect(r3.content[0].text).toContain("pref-001");
      // 工具写 prefs 的条目 locked=false（只有 /compress-remember 命令写的才 locked=true）
      let j = JSON.parse(fs.readFileSync(notesPath, "utf8"));
      expect(j.prefs[0].locked).toBeFalsy();
      // /compress-remember 写入的条目 locked=true，工具改/删被拒（含「用户记录」）
      await commands["compress-remember"].handler("用户偏好甲", fakeCtx);
      j = JSON.parse(fs.readFileSync(notesPath, "utf8"));
      expect(j.prefs[1].locked).toBe(true);
      const ru = await tools.notes.execute("tc", { action: "update", id: "pref-002", status: "x" }, undefined, undefined, fakeCtx);
      expect(ru.content[0].text).toContain("用户记录");
      const r4 = await tools.notes.execute("tc", { action: "delete", id: "pref-002" }, undefined, undefined, fakeCtx);
      expect(r4.content[0].text).toContain("用户记录");
      const r5 = await tools.notes.execute("tc", { action: "delete", id: "fb-001" }, undefined, undefined, fakeCtx);
      expect(r5.content[0].text).toContain("已删除");
      // notes.json 落盘校验
      expect(JSON.parse(fs.readFileSync(notesPath, "utf8")).feedback).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notes 工具校验失败返回错误文本（不抛异常）", async () => {
    const { tools, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-notes-tool-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: true, path: "notes.json", maxTokens: 0 } } }),
    );
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx);
      const r = await tools.notes.execute("tc", { action: "update", id: "task-999", status: "已完成" }, undefined, undefined, fakeCtx);
      expect(r.content[0].text).toContain("不存在");
      expect(r.content[0].text).not.toContain("throw");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未启用时 notes 工具返回提示；/compress-remember 直写 prefs locked 条目；global 提示未实现；空参数提示用法", async () => {
    // ① 未启用（session_start 未触发 → notesStore=null）→ 工具返回「未启用」且不抛异常
    const h1 = harness();
    const r = await h1.tools.notes.execute("tc", { action: "append", table: "prefs", text: "X" }, undefined, undefined, {
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
    });
    expect(r.content[0].text).toContain("未启用");

    // ② 命令用例：enabled=true 的 projectNotes 指向 tmpdir
    const { commands, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-remember-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: true, path: "notes.json", maxTokens: 0 } } }),
    );
    const notesPath = path.join(dir, "notes.json");
    const notifyCalls: string[] = [];
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx);
      await commands["compress-remember"].handler("commit message 用中文", fakeCtx);
      expect(notifyCalls.at(-1)).toContain("已记住");
      const j = JSON.parse(fs.readFileSync(notesPath, "utf8"));
      expect(j.prefs).toHaveLength(1);
      expect(j.prefs[0].locked).toBe(true);
      // ③ 末尾带 global → 全局记忆未实现
      await commands["compress-remember"].handler("记录A global", fakeCtx);
      expect(notifyCalls.at(-1)).toContain("未实现");
      expect(JSON.parse(fs.readFileSync(notesPath, "utf8")).prefs).toHaveLength(1); // 未写入
      // ④ 无参数 → 用法提示
      await commands["compress-remember"].handler("", fakeCtx);
      expect(notifyCalls.at(-1)).toContain("用法");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall 接线双源：notes ID 返回记忆详情（executeRecallDual）", async () => {
    const { tools, handlers } = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-recall-dual-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({ contextCompress: { projectNotes: { enabled: true, path: "notes.json", maxTokens: 0 } } }),
    );
    // 预置一条带 detail 的经验条目
    const seed = new NoteStore(path.join(dir, "notes.json"));
    seed.load();
    seed.append("feedback", { text: "摘要行", detail: "方法详情全文", status: "有效" });
    seed.save();
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
    };
    try {
      await handlers.session_start({}, fakeCtx);
      const out = await tools.recall.execute("tc1", { ids: ["fb-001"] }, undefined, undefined, fakeCtx);
      expect(out.content[0].text).toContain("记忆详情");
      expect(out.content[0].text).toContain("方法详情全文");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wires fallback backend: overflow error hits primary once, registry fallback takes over", async () => {
    // 主后端：本地 HTTP 服务器返回 400 溢出错误并计数 → 验证不烧重试、立即转备用
    let primaryHits = 0;
    const server = http.createServer((_req, res) => {
      primaryHits += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "prompt too long, exceeds context window" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-fallback-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({
        contextCompress: {
          summarizer: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "small" },
          summarizerFallback: { provider: "FakeBig", model: "big-model" },
          retry: { maxAttempts: 3, backoffMs: 100 },
        },
      }),
    );
    try {
      const { handlers, commands } = harness();
      const notifyCalls: string[] = [];
      const branch = [
        { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "这一轮原文很长" }] } },
        { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
        sessionManager: { getBranch: () => branch, appendCustomEntry: () => {} },
        modelRegistry: {
          find: (provider: string, model: string) => ({ provider, model }),
          complete: async () => ({ content: [{ type: "text", text: JSON.stringify({
            userIntent: "验证备用接线", outcome: "备用后端成功产出 ledger",
            entries: [],
          }) }] }),
        },
      };
      await handlers.session_start({}, fakeCtx);
      await handlers.agent_settled({}, fakeCtx);
      const deadline = Date.now() + 5000;
      let out = "";
      while (Date.now() < deadline) {
        await commands["compress-status"].handler("", fakeCtx);
        out = notifyCalls.join("\n");
        if (out.includes("已摘要 turn 数：1")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(out).toContain("已摘要 turn 数：1");   // 备用接管成功，ledger 落入 store
      expect(primaryHits).toBe(1);                    // 溢出错误不烧重试（maxAttempts=3 但只调 1 次）
      expect(out).not.toContain("摘要失败");          // 备用成功 → 不告警
      expect(out).toContain("备用");                  // 状态面板显示备用后端
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills unsummarized turns on session_start", async () => {
    // 项目级 settings 覆盖：指向不可达端口 → 摘要快速失败（maxAttempts:1）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-backfill-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({
        contextCompress: {
          summarizer: { baseUrl: "http://127.0.0.1:9/v1", model: "x" },
          retry: { maxAttempts: 1, backoffMs: 100 },
          backfillLimit: 5,
        },
      }),
    );
    try {
      const { handlers } = harness();
      const notifyCalls: string[] = [];
      const branch = [
        { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
        { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
        { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
        { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二答" }] } },
        { id: "u3", type: "message", message: { role: "user", content: [{ type: "text", text: "第三问" }] } },
        { id: "a3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第三答" }] } },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
        sessionManager: { getBranch: () => branch },
      };
      await handlers.session_start({}, fakeCtx);
      expect(notifyCalls.join("\n")).toContain("补摘 3 个未摘要 turn");
      // 引擎真的开始工作：3 个 turn 相继失败（端口不可达）→ 失败 warning
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !notifyCalls.some((m) => m.includes("摘要失败"))) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(notifyCalls.filter((m) => m.includes("摘要失败")).length).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("降级后队列清空自动恢复（不等到 session_start）", async () => {
    // 回归：degraded 置位后 context 早退在恢复代码之前，队列清空也无人检查——
    // 一旦 120s 超时，整个会话剩余时间插件停摆（Codex P1）。
    // 构造：摘要后端挂起（pending>0）→ context 超限等待 → 释放 backend →
    // 队列清空 → 下一轮 context 必须恢复重组（旧行为：永远早退）。
    const { handlers } = harness();
    const notifyCalls: string[] = [];
    const branch = [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "问" }] } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "答" }] } },
    ];
    // 可控 deferred：pending 的摘要请求，手动释放
    let release: (() => void) | null = null;
    const gated = new Promise<{ content: { type: "text"; text: string }[] }>((r) => { release = () => r({ content: [{ type: "text", text: JSON.stringify({ entries: [] }) }] }); });
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000 }), // 0.9 > 0.76 → 走等待分支
      modelRegistry: {
        find: () => ({ provider: "FakeBig", model: "big" }),
        complete: () => gated,
      },
    };
    await handlers.session_start({}, fakeCtx);
    // agent_settled 入队末 turn → drain 启动 → complete 挂起（pending ≥1）
    const settle = handlers.agent_settled({}, fakeCtx);
    await new Promise((r) => setTimeout(r, 50));
    // context：usage 超限 + pending>0 → enforceForcePoint 等待 120s。
    // fake timers 推进让 waitIdle 的 setTimeout 立刻超时（不真等 120s）
    vi.useFakeTimers();
    try {
      const p1 = handlers.context({}, fakeCtx);
      await vi.advanceTimersByTimeAsync(120_001);
      await p1;
      expect(notifyCalls.join("\n")).toContain("已降级");
      // 释放挂起的摘要请求 → drain 完成 → 队列清空。
      // 退回真实 timers 等 drain 收尾（onLedger 落盘在下一微任务轮）。
      vi.useRealTimers();
      release!();
      await settle;
      await new Promise((r) => setTimeout(r, 20)); // drain 收尾
      // 恢复轮：旧行为在这里早退（不重组、无恢复）→ 新行为恢复重组
      await handlers.context({}, fakeCtx);
      expect(notifyCalls.join("\n")).toContain("恢复正常重组");
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------- recall 三档语义集成（Task 4：层级上下文接线） ----------
  // branch 惯例：u1 用户原话 → a1 工具调用 → r1 工具结果 → a2 最终回复（同 turn，startEntryId=u1）
  describe("recall 接线层级上下文：三档路由集成生效", () => {
    const mkBranch = (extra: any[] = []) => [
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "3 passed" }] } },
      { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "已修复并推送" }] } },
      ...extra,
    ];
    const mkCtx = (branch: any[]) => ({
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    });
    const withLedger = (branch: any[], level: LedgerLevel, startId = "u1") => [
      ...branch,
      { id: "lg1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: mkLedger({ turnStartEntryId: startId, level }) },
    ];

    it("recall 按 ledger 层级路由：L3 turn 的 ID 返回整段原文（含工具过程）", async () => {
      const { tools, handlers } = harness();
      const branch = withLedger(mkBranch(), 3);
      const fakeCtx: any = mkCtx(branch);
      await handlers.session_start({}, fakeCtx); // store 重建：ledger 落入缓存
      const out = await tools.recall.execute("tc1", { ids: ["r1"] }, undefined, undefined, fakeCtx);
      const text = out.content[0].text;
      expect(text).toContain("整段原文");        // turn 级而非 entry 级
      expect(text).toContain("修一下排序");      // 用户原文
      expect(text).toContain("npm test");        // 工具过程整段可见
      expect(text).toContain("3 passed");        // 工具结果文本
      expect(text).toContain("已修复并推送");    // 最终回复
      expect(text).not.toContain("【r1 的原文】"); // 不再是 entry 级头
    });

    it("L5 的 ID 拒绝召回：返回终态说明，不泄原文", async () => {
      const { tools, handlers } = harness();
      const branch = withLedger(mkBranch(), 5);
      const fakeCtx: any = mkCtx(branch);
      await handlers.session_start({}, fakeCtx);
      const out = await tools.recall.execute("tc1", { ids: ["u1"] }, undefined, undefined, fakeCtx);
      const text = out.content[0].text;
      expect(text).toContain("已合并为终态摘要");
      expect(text).not.toContain("修一下排序");
      expect(text).not.toContain("3 passed");
    });

    it("L1/L2 与无 ledger（未摘要 turn）均回退 entry 级不变", async () => {
      const { tools, handlers } = harness();
      for (const branch of [withLedger(mkBranch(), 1), withLedger(mkBranch(), 2), mkBranch()]) {
        const fakeCtx: any = mkCtx(branch);
        await handlers.session_start({}, fakeCtx);
        const out = await tools.recall.execute("tc1", { ids: ["a1"] }, undefined, undefined, fakeCtx);
        const text = out.content[0].text;
        expect(text).toContain("【a1 的原文】");          // entry 级头
        expect(text).toContain("[Tool result]: 3 passed"); // 配对 toolResult 连带（既有语义）
        expect(text).not.toContain("整段原文");
      }
    });

    it("错位防御：ledger 的 turnStartEntryId 不在任何 turn 起点上（分支回退残留）→ 回退 entry 级，不误路由相邻 turn", async () => {
      // 恒等对齐验证：ledgersInBranchOrder 与 splitIntoTurns 同源（同一 branch entries），
      // 但持久化 ledger 可能指向已不在 branch 的旧起点。此时该 turn 必须按 entry 级召回。
      const { tools, handlers } = harness();
      // startId=r1：r1 是 turn 中间条目（turn 真实起点是 u1），任何 turn 的 startEntryId 都不是 r1
      const branch = withLedger(mkBranch(), 3, "r1");
      const fakeCtx: any = mkCtx(branch);
      await handlers.session_start({}, fakeCtx);
      const out = await tools.recall.execute("tc1", { ids: ["a1"] }, undefined, undefined, fakeCtx);
      const text = out.content[0].text;
      expect(text).toContain("【a1 的原文】");           // 回退 entry 级
      expect(text).toContain("[Tool result]: 3 passed");
      expect(text).not.toContain("整段原文");            // 不误路由到 turn 级
      expect(text).not.toContain("修一下排序");          // 不误带出相邻/所在 turn 的其它条目
    });

    it("F1 集成：同 turn 多 ID 整段原文只返回一次，后续 ID 给提示且图片不重复 push", async () => {
      const { tools, handlers } = harness();
      const branch = withLedger([
        { id: "u9", type: "message", message: { role: "user", content: [{ type: "text", text: "看图修排序" }, { type: "image", data: "AAAA" }] } },
        { id: "a9", type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
      ], 3, "u9");
      const fakeCtx: any = mkCtx(branch);
      await handlers.session_start({}, fakeCtx);
      const out = await tools.recall.execute("tc1", { ids: ["a9", "u9"] }, undefined, undefined, fakeCtx);
      const text = out.content[0].text;
      expect(text).toContain("已随 ↩a9 返回，不重复输出");
      expect(text.split("看图修排序").length - 1).toBe(1); // 整段原文仅一份
      expect(out.content.filter((c: any) => c.type === "image")).toHaveLength(1); // 图片不重复
    });
  });
  // ---------- pi 原生压缩感知：context/dump 装配数据源与 compaction 摘要恢复 ----------
  describe("pi 原生 compaction 感知（Codex P1：原生压缩结果被覆盖）", () => {
    const mkCompactedBranch = () => {
      // 模拟 pi 原生压缩后的分支：旧历史（u1/a1，无 ledger）→ compaction entry → 保留条目（u2/a2）
      // parentId 链必需：buildContextEntries 从叶子沿 parentId 回溯重建路径
      return [
        { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "被压缩掉的旧历史提问".repeat(20) }] } },
        { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "被压缩掉的旧历史回答".repeat(20) }] } },
        { id: "c1", parentId: "a1", type: "compaction", summary: "旧历史摘要：用户问过排序问题并已解决", firstKeptEntryId: "u2", tokensBefore: 5000 },
        { id: "u2", parentId: "c1", type: "message", message: { role: "user", content: [{ type: "text", text: "压缩后的新提问" }] } },
        { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "压缩后的新回答" }] } },
      ] as any[];
    };

    it("context 事件：压缩掉的旧历史不回归，compaction 摘要以 user 消息恢复在最前", async () => {
      const { handlers } = harness();
      const notifyCalls: string[] = [];
      const fakeCtx: any = {
        cwd: "/nonexistent-pi-compress-test",
        ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: { getBranch: () => mkCompactedBranch() },
      };
      await handlers.session_start({}, fakeCtx);
      const result = await handlers.context({}, fakeCtx);
      const messages = result!.messages!;
      const texts = messages.map((m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join(""));
      const joined = texts.join("\n---\n");
      // 旧历史原文不得回归
      expect(joined).not.toContain("被压缩掉的旧历史提问");
      expect(joined).not.toContain("被压缩掉的旧历史回答");
      // compaction 摘要恢复在最前（pi 同款包裹文案；notes 空态提示可能占 texts[0]）
      const compactionText = texts.find((t: string) => t.includes("compacted into the following summary"));
      expect(compactionText).toBeTruthy();
      expect(compactionText).toContain("旧历史摘要：用户问过排序问题并已解决");
      // 保留条目照常在
      expect(joined).toContain("压缩后的新提问");
    });

    it("compress-dump 与 context 事件同口径（含 compaction）", async () => {
      const { handlers, commands } = harness();
      const notifyCalls: string[] = [];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-compaction-"));
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: (m: string) => notifyCalls.push(m), setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: { getBranch: () => mkCompactedBranch() },
      };
      try {
        fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, ".pi", "settings.json"),
          JSON.stringify({ contextCompress: { summarizer: { provider: "FakeProv", model: "fake-model" } } }),
        );
        await handlers.session_start({}, fakeCtx);
        await commands["compress-dump"].handler("", fakeCtx);
        const jsonPath = path.join(dir, "e2e", "reports");
        const files = fs.readdirSync(jsonPath).filter((f) => f.endsWith(".json"));
        const dump = JSON.parse(fs.readFileSync(path.join(jsonPath, files[0]), "utf8"));
        const joined = dump.messages.map((m: any) => m.text).join("\n");
        expect(joined).not.toContain("被压缩掉的旧历史提问");
        expect(joined).toContain("旧历史摘要：用户问过排序问题并已解决");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("无 compaction 的普通会话：行为不变（回归防护）", async () => {
      const { handlers } = harness();
      const fakeCtx: any = {
        cwd: "/nonexistent-pi-compress-test",
        ui: { notify: () => {}, setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: { getBranch: () => [
          { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "普通提问" }] } },
          { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "普通回答" }] } },
        ] },
      };
      await handlers.session_start({}, fakeCtx);
      const result = await handlers.context({}, fakeCtx);
      const joined = result!.messages!.map((m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join("")).join("\n");
      expect(joined).toContain("普通提问");
      expect(joined).not.toContain("compacted into the following summary");
    });
  });

    // ---------- context 事件接线：进行中 turn 溢出切分入队（Task 5） ----------
    it("context：进行中 turn 超阈值 → 片段入队摘要，装配裁剪", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-inflight-"));
    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "settings.json"),
        JSON.stringify({
          contextCompress: {
            summarizer: { kind: "registry", provider: "FakeBig", model: "big" },
            keepRecentTokens: 1000, // 最小值；末 turn 的巨型 toolResult（~1500 tok）必然溢出
            backfillLimit: 0,       // 关闭补摘：隔离被测路径（context 事件的溢出切分入队）
            retry: { maxAttempts: 1, backoffMs: 100 },
          },
        }),
      );
      const { handlers } = harness();
      const prompts: string[] = [];
      // parentId 成链（compaction 测试教训）：user → toolCall → 巨型 toolResult，单 turn 无 assistant 终答
      const branch: any[] = [
        { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
        { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
        { id: "r1", parentId: "a1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "果".repeat(1500) }] } },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: () => {}, setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: {
          getBranch: () => branch,
          appendCustomEntry: (_t: string, d: any) => {
            branch.push({ id: `lg${branch.length}`, parentId: branch[branch.length - 1].id, type: "custom", customType: LEDGER_CUSTOM_TYPE, data: d });
          },
        },
        modelRegistry: {
          find: () => ({ provider: "FakeBig", model: "big" }),
          complete: async (_model: any, msgs: any) => {
            prompts.push(msgs.messages[0].content[0].text);
            return { content: [{ type: "text", text: JSON.stringify({ entries: [{ id: 0, target: "npm test", detail: "执行了测试命令" }] }) }] };
          },
        },
      };
      await handlers.session_start({}, fakeCtx);
      // 第一轮 context：切分入队；新片段本轮原文放行（trimmedBranch 只裁剪已落盘覆盖前缀，
      // spec §2 安全窗口），片段未落盘 → extraLedgers 为空、不渲染 ledger 头
      const first = await handlers.context({}, fakeCtx);
      const firstJoined = first!.messages!.map((m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join("")).join("\n");
      expect(firstJoined).toContain("修一下排序");
      expect(firstJoined).toContain("果果果果");   // 新切片段条目本轮原文在场（fragment≠null 且未落盘）
      expect(firstJoined).not.toContain("<action-ledger>"); // extraLedgers 为空：新片段行不渲染
      // captured backend 收到片段摘要请求（prompt 含第一条命令文本）
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !prompts.some((p) => p.includes("npm test"))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(prompts.some((p) => p.includes("npm test"))).toBe(true);
      // 摘要完成 → ledger 落入 branch（onLedger → appendCustomEntry）
      while (Date.now() < deadline && !branch.some((e) => e.type === "custom")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(branch.some((e) => e.type === "custom")).toBe(true);
      // 第二轮 context：片段已落盘 → <action-ledger> 含片段行，覆盖推导裁剪前缀 → 原文消失，user 消息仍在
      const second = await handlers.context({}, fakeCtx);
      const joined = second!.messages!.map((m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join("")).join("\n");
      expect(joined).toContain("<action-ledger>");
      expect(joined).toContain("npm test");
      expect(joined).not.toContain("果果果果");
      expect(joined).toContain("修一下排序");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    });

  // ---------- agent_settled 收敛：整 turn 落盘后片段墓碑化（Task 7） ----------
  // 复用 Task 5 超大 turn fixture：u1(user) → a1(toolCall) → r1(巨型 toolResult ~1.5K tok)，
  // context 事件切出片段（key=a1，≠ turn 起点 u1）→ 片段摘要落盘 → agent_settled 整 turn
  // 入队 → 队列清空且整 turn 条目落盘后墓碑化片段（absorbed: true + store.delete）。
  const mkAbsorbHarness = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-absorb-"));
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "settings.json"),
      JSON.stringify({
        contextCompress: {
          summarizer: { kind: "registry", provider: "FakeBig", model: "big" },
          keepRecentTokens: 1000, // 巨型 toolResult 必然溢出 → 切片段
          backfillLimit: 0,       // 关闭补摘：隔离被测路径
          retry: { maxAttempts: 1, backoffMs: 100 },
        },
      }),
    );
    const { handlers } = harness();
    const writes: any[] = [];   // 捕获 onLedger/absorb → appendCustomEntry 的持久化写入
    const prompts: string[] = [];
    const branch: any[] = [
      { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
      { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
      { id: "r1", parentId: "a1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "果".repeat(1500) }] } },
    ];
    const fakeCtx: any = {
      cwd: dir,
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
      sessionManager: {
        getBranch: () => branch,
        appendCustomEntry: (_t: string, d: any) => {
          writes.push(d);
          branch.push({ id: `lg${branch.length}`, parentId: branch[branch.length - 1].id, type: "custom", customType: LEDGER_CUSTOM_TYPE, data: d });
        },
      },
      modelRegistry: {
        find: () => ({ provider: "FakeBig", model: "big" }),
        complete: async (_model: any, msgs: any) => {
          prompts.push(msgs.messages[0].content[0].text);
          return { content: [{ type: "text", text: JSON.stringify({ entries: [{ id: 0, target: "npm test", detail: "执行了测试命令" }] }) }] };
        },
      },
    };
    return { dir, handlers, writes, prompts, branch, fakeCtx };
  };

  it("收敛：turn 结束后整 turn 条目落盘、片段墓碑化、重启不复活", async () => {
    const { dir, handlers, writes, prompts, branch, fakeCtx } = mkAbsorbHarness();
    try {
      await handlers.session_start({}, fakeCtx);
      // 1. context 触发切分入队；等片段摘要落盘（onLedger 先 store.set 后 appendCustomEntry，
      //    branch 出现 custom entry ⇒ store 已有条目）
      await handlers.context({}, fakeCtx);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !branch.some((e) => e.type === "custom")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(prompts.some((p) => p.includes("npm test"))).toBe(true); // 片段摘要请求已发生
      // 2. agent_settled：整 turn 入队（FIFO 在片段后）→ waitIdle 队列清空 → 收敛墓碑化
      await handlers.agent_settled({}, fakeCtx);
      while (Date.now() < deadline && !writes.some((d) => d.absorbed)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // 3. 整 turn 条目落盘（turnStartEntryId=u1）+ 片段墓碑写入（absorbed: true）
      expect(writes.some((d) => d.turnStartEntryId === "u1" && !d.absorbed)).toBe(true);
      const tombstone = writes.find((d) => d.turnStartEntryId === "a1" && d.absorbed);
      expect(tombstone).toBeTruthy();
      // 4. 重启不复活：branch 持久化条目重建新 store——整 turn 在、片段（absorbed 被跳过）不在
      const fresh = new LedgerStore();
      fresh.rebuildFromEntries(branch as any);
      expect(fresh.get("u1")).toBeTruthy();
      expect(fresh.get("a1")).toBeUndefined();
      // 幂等：重复 agent_settled 不报错、不重复墓碑化
      await handlers.agent_settled({}, fakeCtx);
      await new Promise((r) => setTimeout(r, 50));
      expect(writes.filter((d) => d.absorbed)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("收敛守卫：整 turn 摘要失败时片段不墓碑（数据无损）", async () => {
    const { dir, handlers, writes, prompts, branch, fakeCtx } = mkAbsorbHarness();
    // 整 turn 摘要（prompt 含 user 消息「修一下排序」）→ 抛错；片段摘要（不含 user 消息）照常成功
    const notifyCalls: string[] = [];
    fakeCtx.ui.notify = (m: string) => notifyCalls.push(m);
    fakeCtx.modelRegistry.complete = async (_model: any, msgs: any) => {
      prompts.push(msgs.messages[0].content[0].text);
      if (msgs.messages[0].content[0].text.includes("修一下排序")) {
        throw new Error("整 turn 摘要失败");
      }
      return { content: [{ type: "text", text: JSON.stringify({ entries: [{ id: 0, target: "npm test", detail: "执行了测试命令" }] }) }] };
    };
    try {
      await handlers.session_start({}, fakeCtx);
      await handlers.context({}, fakeCtx);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !prompts.some((p) => p.includes("npm test"))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await handlers.agent_settled({}, fakeCtx);
      // 等「摘要失败」warning 落地（整 turn 走完重试）
      while (Date.now() < deadline && !notifyCalls.some((m) => m.includes("摘要失败"))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(notifyCalls.some((m) => m.includes("摘要失败"))).toBe(true);
      await new Promise((r) => setTimeout(r, 50)); // absorb 微任务 flush
      // 守卫：整 turn 条目不存在 → 不墓碑化（无 absorbed 写入），片段仍无损保留在 store
      expect(writes.some((d) => d.absorbed)).toBe(false);
      const fresh = new LedgerStore();
      fresh.rebuildFromEntries(branch as any);
      expect(fresh.get("a1")).toBeTruthy();  // 片段无损
      expect(fresh.get("u1")).toBeUndefined(); // 整 turn 摘要未落盘
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------- I-1 回归：重启中途——陈旧整 turn ledger 不满足收敛守卫 ----------
  // 场景：中途重启 → backfill 对进行中 turn 补摘落盘整 turn ledger（turnEndEntryId = 重启时刻
  // 的 turn 末尾 a1）→ 用户继续任务切出新片段落盘（key=a1，覆盖到 r1）→ agent_settled：
  // needSettle=false（store.get(u1) 成立）但陈旧整 turn ledger 不覆盖完整 turn——
  // 守卫必须拦截：墓碑化会把新片段埋进不覆盖它们的陈旧摘要（内容不可见也不可检索）。
  it("I-1 回归：陈旧整 turn ledger（重启补摘落盘）不覆盖完整 turn → 片段不墓碑化", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-stale-"));
    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "settings.json"),
        JSON.stringify({
          contextCompress: {
            summarizer: { kind: "registry", provider: "FakeBig", model: "big" },
            keepRecentTokens: 1000,
            backfillLimit: 0,
            retry: { maxAttempts: 1, backoffMs: 100 },
          },
        }),
      );
      const { handlers } = harness();
      const writes: any[] = [];
      // 重启前持久化的两条 ledger：陈旧整 turn（补摘落盘，turnEndEntryId=重启时刻的 turn 末尾 a1）
      // + 重启后切出并落盘的新片段（key=a1，覆盖 a1..r1）
      const staleTurn = mkLedger({ turnStartEntryId: "u1", turnEndEntryId: "a1", level: 1 });
      const fragment = mkLedger({ turnStartEntryId: "a1", turnEndEntryId: "r1", level: 1 });
      const branch: any[] = [
        { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
        { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
        { id: "r1", parentId: "a1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "果".repeat(1500) }] } },
        { id: "lg1", parentId: "r1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: staleTurn },
        { id: "lg2", parentId: "lg1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: fragment },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: () => {}, setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: {
          getBranch: () => branch,
          appendCustomEntry: (_t: string, d: any) => {
            writes.push(d);
            branch.push({ id: `lg${branch.length}`, parentId: branch[branch.length - 1].id, type: "custom", customType: LEDGER_CUSTOM_TYPE, data: d });
          },
        },
        modelRegistry: {
          find: () => ({ provider: "FakeBig", model: "big" }),
          complete: async () => { throw new Error("不应发起摘要调用（needSettle=false）"); },
        },
      };
      await handlers.session_start({}, fakeCtx);
      await handlers.agent_settled({}, fakeCtx);
      await new Promise((r) => setTimeout(r, 100)); // waitIdle 微任务 flush
      // 守卫拦截：无墓碑写入，新片段不被埋进陈旧摘要
      expect(writes.some((d) => d.absorbed)).toBe(false);
      const fresh = new LedgerStore();
      fresh.rebuildFromEntries(branch as any);
      expect(fresh.get("a1")).toBeTruthy();                 // 片段仍在（内容可 recall）
      expect(fresh.get("u1")?.turnEndEntryId).toBe("a1");   // 陈旧整 turn ledger 原样保留
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------- I-2 回归：两处调用点不含片段 ledger ----------
  it("I-2 回归：recall query 检索命中片段摘要（T 编号与 renderActionLedger 对齐）", async () => {
    const { handlers, tools } = harness();
    const turnLedger = mkLedger({ turnStartEntryId: "u0", turnEndEntryId: "b0", level: 1 });
    const fragment = mkLedger({
      turnStartEntryId: "a1", turnEndEntryId: "r1", level: 1,
      summary: { entries: [{ action: "exec", target: "npm test", detail: "执行了测试命令", recallIds: ["a1"], phase: "verify" }] },
    } as Partial<LedgerData> & { turnStartEntryId: string });
    const branch: any[] = [
      { id: "u0", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
      { id: "b0", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
      { id: "lg0", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: turnLedger },
      { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
      { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
      { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "果".repeat(1500) }] } },
      { id: "lg1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: fragment },
    ];
    const fakeCtx: any = {
      cwd: "/nonexistent-pi-compress-test",
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch },
    };
    await handlers.session_start({}, fakeCtx); // store 重建：整 turn + 片段 ledger 均入缓存
    const out = await tools.recall.execute("tc1", { query: "执行了测试命令" }, undefined, undefined, fakeCtx);
    const text = out.content[0].text;
    expect(text).toContain("命中");
    expect(text).toContain("执行了测试命令");
    expect(text).toContain("↩a1");
    expect(text).toContain("T2"); // 片段按 branch 顺序排整 turn ledger 之后
  });

  it("I-2 回归：session_before_compact 提交给 pi 的摘要文本含片段行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-compactfrag-"));
    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "settings.json"),
        JSON.stringify({ contextCompress: { summarizer: { kind: "registry", provider: "FakeBig", model: "big" }, backfillLimit: 0 } }),
      );
      const { handlers } = harness();
      const turnLedger = mkLedger({ turnStartEntryId: "u0", turnEndEntryId: "b0", level: 1 });
      const fragment = mkLedger({
        turnStartEntryId: "a1", turnEndEntryId: "r1", level: 1,
        summary: { entries: [{ action: "exec", target: "npm test", detail: "执行了测试命令", recallIds: ["a1"], phase: "verify" }] },
      } as Partial<LedgerData> & { turnStartEntryId: string });
      const branch: any[] = [
        { id: "u0", type: "message", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
        { id: "b0", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
        { id: "lg0", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: turnLedger },
        { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "修一下排序" }] } },
        { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } }] } },
        { id: "r1", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "果".repeat(1500) }] } },
        { id: "lg1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: fragment },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: () => {}, setStatus: () => {} },
        sessionManager: { getBranch: () => branch },
      };
      await handlers.session_start({}, fakeCtx);
      const result = await handlers.session_before_compact(
        { preparation: { firstKeptEntryId: "u0", tokensBefore: 1000 } },
        fakeCtx,
      );
      expect(result).toBeTruthy();
      expect(result!.compaction!.summary).toContain("执行了测试命令"); // 片段行不丢
      expect(result!.compaction!.summary).toContain("↩a1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

    it("context：无超大 turn → 行为逐字节不变", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compress-noinflight-"));
    try {
      fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".pi", "settings.json"),
        JSON.stringify({ contextCompress: { keepRecentTokens: 1000, projectNotes: { enabled: false, path: "notes.json", maxTokens: 0 } } }),
      );
      const { handlers } = harness();
      const ledger = mkLedger({ turnStartEntryId: "u1", level: 1, summary: { entries: [] } });
      const branch: any[] = [
        { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "问".repeat(1200) }] } },
        { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
        { id: "c1", parentId: "a1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: ledger },
        { id: "u2", parentId: "c1", type: "message", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
        { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二答" }] } },
      ];
      const fakeCtx: any = {
        cwd: dir,
        ui: { notify: () => {}, setStatus: () => {} },
        getContextUsage: () => ({ tokens: 5000, contextWindow: 200_000 }),
        sessionManager: { getBranch: () => branch },
      };
      await handlers.session_start({}, fakeCtx);
      const actual = await handlers.context({}, fakeCtx);
      // 对照旧装配路径（无切分）：cache 与 handler 同构（经 store 重建路径 + 同款 !absorbed 过滤），
      // 同 entries/cache/keepRecentTokens 直接组装，逐字节一致
      const { entries } = compactionAwareEntries(branch);
      const cacheStore = new LedgerStore();
      cacheStore.rebuildFromEntries(branch as any);
      const cache = new Map<string, LedgerData>();
      for (const k of cacheStore.keys()) { const v = cacheStore.get(k); if (v && !v.absorbed) cache.set(k, v); }
      const { messages: expected } = assembleContext(entries, cache, 1000);
      const norm = (ms: any[]) => ms.map((m: any) => JSON.stringify({ ...m, timestamp: 0 }));
      expect(norm(actual!.messages!)).toEqual(norm(expected));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
