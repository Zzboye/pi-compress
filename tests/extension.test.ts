import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
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

  it("registers recall tool and compress-status command", () => {
    const { tools, commands } = harness();
    expect(tools.recall).toBeTruthy();
    expect(tools.recall.parameters).toBeTruthy();
    expect(commands["compress-status"]).toBeTruthy();
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
