import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import piExtension from "../src/index.js";
import { LEDGER_CUSTOM_TYPE, type LedgerData } from "../src/ledger.js";
import { NoteStore } from "../src/notes.js";

function mkLedger(partial: Partial<LedgerData> & { turnStartEntryId: string }): LedgerData {
  return {
    turnEndEntryId: partial.turnStartEntryId + "-end",
    summary: { groups: [] },
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
      turnStartEntryId: "t1", level: 1,
      userMessage: { text: "forceRatio 是什么？为什么默认 0.76", entryId: "t1-u" },
      finalReply: { text: "forceRatio 是触发强制点的比例", entryId: "t1-f" },
      summary: { userIntent: "了解强制点", groups: [
        { phase: "investigate", entries: [
          { action: "read", target: "src/config.ts", detail: "校验 forceRatio 范围", recallIds: ["t1-a"] },
        ] },
      ] },
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
        const ledger = mkLedger({ turnStartEntryId: "u1", level: 1, summary: { groups: [] } });
        const branch = [
          { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "问".repeat(1200) }] } },
          { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } },
          { id: "c1", type: "custom", customType: LEDGER_CUSTOM_TYPE, data: ledger },
          { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "第二问" }] } },
          { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二答" }] } },
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
            groups: [],
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
});
