import { describe, it, expect } from "vitest";
import { executeRecall } from "../src/recall.js";
import type { MessageEntry } from "../src/util.js";
import type { AgentMessage } from "../src/types.js";

const branch: MessageEntry[] = [
  { id: "e1", message: { role: "user", content: [{ type: "text", text: "问题原文" }] } as AgentMessage },
  { id: "e2", message: { role: "assistant", content: [{ type: "text", text: "回答原文很长".repeat(50) }] } as AgentMessage },
];

describe("executeRecall", () => {
  it("returns serialized originals with id labels", () => {
    const r = executeRecall(["e1"], branch, 4000);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("e1");
    expect(r.text).toContain("问题原文");
  });

  it("reports missing ids", () => {
    const r = executeRecall(["e1", "nope"], branch, 4000);
    expect(r.missing).toEqual(["nope"]);
    expect(r.text).toContain("nope");
  });

  it("truncates oversized entries with hint", () => {
    const r = executeRecall(["e2"], branch, 10);
    expect(r.text).toContain("截断");
  });
});
