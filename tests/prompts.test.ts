import { describe, it, expect } from "vitest";
import { buildSummarizePrompt, type ToolActionInfo } from "../src/prompts.js";
import { parseLedgerOutput } from "../src/ledger.js";

const actions: ToolActionInfo[] = [
  { action: "read", target: "src/hooks.ts", entryIds: ["e003"] },
  { action: "bash", target: "npm test", entryIds: ["e012"] },
];
const turnText = '[User]: 修内存泄漏\n[Assistant tool calls]: read(path="src/hooks.ts")\n[Tool result]: ...\n[Assistant tool calls]: bash(command="npm test")\n[Tool result]: 3 passed';

describe("buildSummarizePrompt", () => {
  it("contains serialized turn, verbatim action list with entry ids, and JSON schema", () => {
    const p = buildSummarizePrompt(turnText, actions);
    expect(p).toContain("[User]: 修内存泄漏");
    expect(p).toContain('src/hooks.ts');
    expect(p).toContain("e003");
    expect(p).toContain("userIntent");
    expect(p).toContain("JSON");
  });
});

describe("parseLedgerOutput", () => {
  it("parses valid output and merges mechanical fields", () => {
    const raw = JSON.stringify({
      userIntent: "修复内存泄漏",
      outcome: "已修复",
      groups: [{ phase: "investigate", entries: [{ target: "src/hooks.ts", detail: "清理函数缺失" }, { target: "npm test", detail: "通过", phase: "verify" }] }],
    });
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.userIntent).toBe("修复内存泄漏");
    const read = s.groups[0].entries.find((e) => e.action === "read")!;
    expect(read.recallIds).toEqual(["e003"]);       // recallIds 来自机械清单
    expect(read.target).toBe("src/hooks.ts");        // target 来自机械清单
    expect(read.detail).toBe("清理函数缺失");        // detail 来自模型
  });

  it("drops entries whose model detail contains a target-like path not in source (verbatim guard)", () => {
    const raw = JSON.stringify({
      userIntent: "u", outcome: "o",
      groups: [{ phase: "other", entries: [{ target: "src/hooks.ts", detail: "见 src/other.ts" }] }],
    });
    // src/other.ts 不在 turnText 中 → 该条目被剔除
    const s = parseLedgerOutput(raw, actions, turnText, true);
    expect(s.groups[0].entries.length).toBe(0);
  });

  it("throws LedgerParseError on invalid JSON", () => {
    expect(() => parseLedgerOutput("not json", actions, turnText, true)).toThrow();
  });
});
