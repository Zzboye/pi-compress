import { describe, it, expect, vi } from "vitest";
import piExtension from "../src/index.js";

describe("extension entry wiring", () => {
  function harness() {
    const tools: Record<string, any> = {};
    const commands: Record<string, any> = {};
    const fakePi: any = {
      on: vi.fn(),
      registerTool: vi.fn((t: any) => { tools[t.name] = t; }),
      registerCommand: vi.fn((name: string, opts: any) => { commands[name] = opts; }),
    };
    piExtension(fakePi);
    return { tools, commands, fakePi };
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
});
