import { readFileSync } from "node:fs";
import { countTokens } from "../src/util.js";
import { splitIntoTurns, stripThinking, serializeTurn, type MessageEntry } from "../src/util.js";
const raw = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const branch: MessageEntry[] = raw.filter((e: any) => e.type === "message").map((e: any) => ({ id: e.id, message: e.message }));
const turns = splitIntoTurns(branch);
turns.forEach((t, i) => {
  const st = stripThinking(t.entries);
  const full = st.reduce((s: number, e) => s + countTokens(e.message as any), 0);
  console.log(`Turn ${i + 1}: 全文 ~${full} tok | 序列化(截断toolResult) ~${Math.ceil(serializeTurn(t).length / 4)} tok | entries=${t.entries.length}`);
});
