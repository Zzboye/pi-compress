/**
 * Real-model smoke test for the LanFeng/deepseek-v4-flash summarizer backend.
 * Skipped unless LANFENG_SMOKE=1 — run with:
 *   LANFENG_SMOKE=1 npx vitest run tests/lanfeng-smoke.test.ts
 *
 * Proves: createOpenAICompatBackend → LanFeng /chat/completions → valid JSON
 * → parseLedgerOutput (with verbatimCheck) → real LedgerSummary with the
 * mechanically-extracted action/target/recallIds. This is the only link in the
 * pipeline not covered by the mock-based unit/integration tests.
 */
import { describe, it, expect } from "vitest";
import { createOpenAICompatBackend } from "../src/summarizer.js";
import { buildSummarizePrompt } from "../src/prompts.js";
import { parseLedgerOutput } from "../src/ledger.js";
import { serializeTurn, extractToolActions, splitIntoTurns, type MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

const SMOKE = process.env.LANFENG_SMOKE === "1";
// API key 从环境变量读取，绝不硬编码进仓库
const LANFENG = {
  baseUrl: "http://127.0.0.1:8796/v1",
  model: "deepseek-v4-flash",
  apiKey: process.env.LANFENG_API_KEY ?? "",
};

// 真实形态的 turn：用户问 + assistant 调 read 工具 + toolResult 返回文件内容
const turn: MessageEntry[] = [
  { id: "u1", message: { role: "user", content: [{ type: "text", text: "读一下 src/hooks.ts 看有没有内存泄漏" }] } as AgentMessage },
  { id: "a1", message: { role: "assistant", content: [
    { type: "text", text: "我来看看 hooks.ts" },
    { type: "toolCall", toolCallId: "tc1", name: "read", arguments: { path: "src/hooks.ts" } } as any,
  ] } as AgentMessage },
  { id: "r1", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "export function useTimer() { useEffect(() => { setInterval(() => {}, 1000); }, []); } // 缺少 cleanup" }] } as AgentMessage },
  { id: "a2", message: { role: "assistant", content: [{ type: "text", text: "hooks.ts 的 useTimer 里 setInterval 没有清理函数，会内存泄漏" }] } as AgentMessage },
];

describe.skipIf(!SMOKE)("lanfeng real-model smoke", () => {
  it("summarizes a tool-calling turn via LanFeng into a valid ledger", async () => {
    const actions = extractToolActions(splitIntoTurns(turn)[0]);
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ action: "read", target: "src/hooks.ts", entryIds: ["a1"] });

    const turnText = serializeTurn(splitIntoTurns(turn)[0]);
    const prompt = buildSummarizePrompt(turnText, actions);
    const backend = createOpenAICompatBackend(LANFENG);

    const raw = await backend.complete(prompt);
    expect(raw).toBeTruthy();
    expect(raw.length).toBeGreaterThan(10);

    const summary = parseLedgerOutput(raw, actions, serializeTurn(splitIntoTurns(turn)[0]), true);
    expect(typeof summary.userIntent).toBe("string");
    expect(summary.userIntent!.length).toBeGreaterThan(0);
    expect(typeof summary.outcome).toBe("string");
    expect(summary.groups.length).toBeGreaterThan(0);

    // 找到 read 动作条目（verbatimCheck 通过 → 未被剔除）
    const readEntry = summary.groups.flatMap((g) => g.entries).find((e) => e.action === "read");
    expect(readEntry).toBeTruthy();
    expect(readEntry!.target).toBe("src/hooks.ts");       // 逐字字段来自机械清单
    expect(readEntry!.recallIds).toEqual(["a1"]);          // recallIds 指向 assistant 消息
    expect(readEntry!.detail.length).toBeGreaterThan(0);   // 模型填的结论
  }, 60_000);
});
