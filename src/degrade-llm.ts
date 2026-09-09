import type { LedgerData } from "./ledger.js";
import { renderTurnText } from "./ledger.js";
import type { SummarizerBackend } from "./summarizer.js";
import { buildIntentOutcomePrompt, buildMergeDescriptionPrompt } from "./prompts.js";

/** 输出 JSON 解析：容错剥 ``` 围栏（同 parseLedgerOutput 风格），非对象即抛错 */
function parseJson(raw: string): any {
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("degrade output is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("degrade output not an object");
  return parsed;
}

/** L2→L3：压缩两端——用户输入→意图、最终回复→结果。失败抛错，由调用方回滚 level。 */
export async function compressEnds(
  backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal,
): Promise<{ userIntent: string; outcome: string }> {
  const userText = ledger.userMessage?.text ?? "";
  const replyText = ledger.finalReply?.text ?? "";
  const raw = await backend.complete(buildIntentOutcomePrompt(userText, replyText), signal);
  const p = parseJson(raw);
  if (typeof p.userIntent !== "string" || typeof p.outcome !== "string") {
    throw new Error("degrade output missing userIntent/outcome");
  }
  return { userIntent: p.userIntent, outcome: p.outcome };
}

/** L3→L4：多条 turn 合并为一行主题描述，形如 "调查代码结构与配置逻辑（5 条已合并）"。 */
export async function mergeDescribe(
  backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal,
): Promise<{ description: string }> {
  // turn 号在合并行中由渲染层统一编号，这里传 0 仅取正文
  const texts = ledgers.map((l) => renderTurnText(l, 0));
  const raw = await backend.complete(buildMergeDescriptionPrompt(texts), signal);
  // 容错：模型可能只回一个裸字符串（JSON string）而非对象——非 JSON string 视为缺 description
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new Error("degrade output is not valid JSON");
  }
  const p = typeof parsed === "string" ? { description: parsed } : parsed;
  if (typeof p.description !== "string" || p.description === "") {
    throw new Error("degrade output missing description");
  }
  const desc = p.description.replace(/（\d+ 条已合并）$/, "").trim();
  return { description: `${desc}（${ledgers.length} 条已合并）` };
}
