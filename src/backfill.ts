import type { Turn } from "./util.js";

interface LedgerLookup { get(id: string): unknown }

/**
 * 补摘清单：分支上无 ledger 的 turn，按最旧优先（最旧的先退出 keepRecentTokens
 * 窗口、最先被装配器需要），最多取 limit 个（0 = 关闭补摘）。
 */
export function computeBackfillTurns(turns: Turn[], store: LedgerLookup, limit: number): Turn[] {
  if (limit <= 0) return [];
  const todo: Turn[] = [];
  for (const t of turns) {
    if (store.get(t.startEntryId)) continue;
    todo.push(t);
    if (todo.length >= limit) break;
  }
  return todo;
}
