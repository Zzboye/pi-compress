import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import piExtension from "../src/index.js";

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
