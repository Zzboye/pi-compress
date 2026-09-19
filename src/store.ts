import { LEDGER_CUSTOM_TYPE, normalizeLedgerData, type LedgerData } from "./ledger.js";
import type { Turn } from "./util.js";

export interface SessionEntryLike { id: string; type: string; customType?: string; data?: unknown }

function isValidLedger(d: unknown): d is LedgerData {
  if (typeof d !== "object" || d === null) return false;
  const v = d as Record<string, unknown>;
  // level 存在时必须是 1|2|3|4|5（防脏数据，5 为 L5 合并条目，Task 2 放宽）；缺省视为 1，兼容旧持久化数据
  const levelOk = v.level === undefined || v.level === 1 || v.level === 2 || v.level === 3 || v.level === 4 || v.level === 5;
  return levelOk && typeof v.turnStartEntryId === "string" && typeof v.turnEndEntryId === "string"
    && typeof v.summary === "object" && v.summary !== null;
}

export class LedgerStore {
  private cache = new Map<string, LedgerData>();

  rebuildFromEntries(entries: SessionEntryLike[]): void {
    this.cache.clear();
    for (const e of entries) {
      if (e.type !== "custom" || e.customType !== LEDGER_CUSTOM_TYPE || !isValidLedger(e.data)) continue;
      if ((e.data as LedgerData).absorbed) {
        // 墓碑（整 turn 吸收片段后写入）：append-only 会话文件里原片段条目在前、墓碑在后，
        // 单纯跳过会让原条目复活——必须删除同名缓存条目才防复活（Task 7 收敛）
        this.cache.delete(e.data.turnStartEntryId);
        continue;
      }
      this.cache.set(e.data.turnStartEntryId, normalizeLedgerData(e.data)); // 旧 groups schema 加载即迁移；后写覆盖先写
    }
  }

  get(turnStartEntryId: string): LedgerData | undefined { return this.cache.get(turnStartEntryId); }
  set(data: LedgerData): void { this.cache.set(data.turnStartEntryId, data); }
  delete(turnStartEntryId: string): void { this.cache.delete(turnStartEntryId); }
  size(): number { return this.cache.size; }
  keys(): string[] { return [...this.cache.keys()]; }
}

/**
 * 收集 turn 内已落盘的溢出片段 key（降级接入 Task 6 / 收敛墓碑化 Task 7 共用的判定基础）：
 * 片段 key = 片段 ledger 的 turnStartEntryId，落在 turn 中间条目上——≠ turn.startEntryId
 * （否则是整 turn ledger），且 ∈ turn 条目集合、未 absorbed（absorbed = 已被整 turn 吸收的墓碑）。
 * 片段 key 不是任何 turn 的起点，ledgersInBranchOrder 查不到，必须单独扫 store。
 * collectFragmentEntries 返回 key+ledger 对（单次查表，调用方免二次 get）；
 * collectFragmentKeys 只返回 key 数组。
 */
export function collectFragmentEntries(turn: Turn, store: LedgerStore): Array<{ key: string; ledger: LedgerData }> {
  const ids = new Set(turn.entries.map((e) => e.id));
  const out: Array<{ key: string; ledger: LedgerData }> = [];
  for (const k of store.keys()) {
    if (k === turn.startEntryId || !ids.has(k)) continue;
    const l = store.get(k);
    if (l && !l.absorbed) out.push({ key: k, ledger: l });
  }
  return out;
}

export function collectFragmentKeys(turn: Turn, store: LedgerStore): string[] {
  return collectFragmentEntries(turn, store).map((f) => f.key);
}
