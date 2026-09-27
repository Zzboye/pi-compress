import type { LedgerData } from "./ledger.js";
import type { SummarizerBackend } from "./summarizer.js";
import { buildIntentOutcomePrompt, buildBatchRecompressPrompt } from "./prompts.js";

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

/** L3→L4：压缩两端——用户输入→意图、最终回复→结果。失败抛错，由调用方回滚 level。 */
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

/** L5 批量大小（探针实测 N=20 稳定：2 批各 20 条，零缺失、零串位；见 docs/evidence/l5-prompt-verify.txt） */
export const L5_BATCH_SIZE = 20;

/** 剥 ``` 围栏后解析为 JSON；失败返回 undefined（不抛错） */
function parseJsonLoose(raw: string): any {
  try {
    return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return undefined;
  }
}

/**
 * L4→L5 批量二次压缩：一次调用提交 N 条，逐条输出描述，index 一一对应。
 * 返回数组**长度与入参等长**，缺失/解析失败项为 null（不抛错，由调用方决定单条重跑）。
 */
export async function recompressBatched(
  backend: SummarizerBackend, ledgers: LedgerData[], signal?: AbortSignal,
): Promise<Array<string | null>> {
  if (ledgers.length === 0) return [];
  const raw = await backend.complete(buildBatchRecompressPrompt(ledgers), signal);
  const parsed = parseJsonLoose(raw);
  const out: Array<string | null> = new Array(ledgers.length).fill(null);
  const arr = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    const idx = Number(it?.index);
    const desc = typeof it === "string" ? it : it?.description;
    if (!Number.isFinite(idx) || idx < 1 || idx > ledgers.length) continue;
    out[idx - 1] = typeof desc === "string" && desc.trim() ? desc.trim() : null; // 重复 index 后者覆盖
  }
  return out;
}

/** 单条二次压缩（批量中某条缺失时的兜底重跑）。失败抛错，由调用方回滚。 */
export async function recompressOne(
  backend: SummarizerBackend, ledger: LedgerData, signal?: AbortSignal,
): Promise<string> {
  const out = await recompressBatched(backend, [ledger], signal);
  const desc = out[0];
  if (typeof desc !== "string" || desc === "") throw new Error("degrade output missing description");
  return desc;
}
