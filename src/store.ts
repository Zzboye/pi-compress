import { LEDGER_CUSTOM_TYPE, normalizeLedgerData, type LedgerData } from "./ledger.js";

export interface SessionEntryLike { id: string; type: string; customType?: string; data?: unknown }

function isValidLedger(d: unknown): d is LedgerData {
  if (typeof d !== "object" || d === null) return false;
  const v = d as Record<string, unknown>;
  // level 存在时必须是 1|2|3|4（防脏数据）；缺省视为 1，兼容旧持久化数据
  const levelOk = v.level === undefined || v.level === 1 || v.level === 2 || v.level === 3 || v.level === 4;
  return levelOk && typeof v.turnStartEntryId === "string" && typeof v.turnEndEntryId === "string"
    && typeof v.summary === "object" && v.summary !== null;
}

export class LedgerStore {
  private cache = new Map<string, LedgerData>();

  rebuildFromEntries(entries: SessionEntryLike[]): void {
    this.cache.clear();
    for (const e of entries) {
      if (e.type === "custom" && e.customType === LEDGER_CUSTOM_TYPE && isValidLedger(e.data)) {
        this.cache.set(e.data.turnStartEntryId, normalizeLedgerData(e.data)); // 旧 groups schema 加载即迁移；后写覆盖先写
      }
    }
  }

  get(turnStartEntryId: string): LedgerData | undefined { return this.cache.get(turnStartEntryId); }
  set(data: LedgerData): void { this.cache.set(data.turnStartEntryId, data); }
  size(): number { return this.cache.size; }
  keys(): string[] { return [...this.cache.keys()]; }
}
