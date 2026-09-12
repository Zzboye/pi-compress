import fs from "node:fs";
import { join, dirname } from "node:path";
import { countTokensText } from "./util.js";

export interface NoteEntry {
  id: string;
  table: "prefs" | "feedback" | "tasks";
  text: string;
  detail?: string;
  status?: string;
  date?: string;
  updatedAt?: string;
  source?: string;
  locked?: boolean;
}

export interface NotesFile
{
  schema: 1;
  /** 兼容 schema 保留的全局单调计数，不参与 ID 分配 */
  nextId: number;
  prefs: NoteEntry[]; feedback: NoteEntry[]; tasks: NoteEntry[];
  /** 容错可选：每表已分配的最大序号，持久化以防删除后跨会话复用 */
  seq?: { prefs: number; feedback: number; tasks: number };
}

const PREFIX: Record<NoteEntry["table"], string> = { prefs: "pref", feedback: "fb", tasks: "task" };
const TABLE_KEY: NoteEntry["table"][] = ["prefs", "feedback", "tasks"];

export class NoteStore {
  private data: NotesFile = { schema: 1, nextId: 1, prefs: [], feedback: [], tasks: [] };
  // 每表独立序号（fb-001/task-001/pref-001 各自从 001 起）；nextId 为全局单调计数
  private seq: Record<NoteEntry["table"], number> = { prefs: 0, feedback: 0, tasks: 0 };
  constructor(readonly filePath: string) {}

  load(): void {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")); } catch { raw = undefined; }
    if (
      typeof raw === "object" && raw !== null && (raw as any).schema === 1 &&
      typeof (raw as any).nextId === "number" &&
      ["prefs", "feedback", "tasks"].every((k) => Array.isArray((raw as any)[k]))
    ) {
      this.data = raw as NotesFile;
      // 容错：条目缺 table 字段时按所在数组回填
      for (const k of TABLE_KEY) for (const e of this.data[k]) e.table = k;
      const sq = (this.data as NotesFile).seq;
      if (sq && TABLE_KEY.every((k) => typeof sq[k] === "number" && sq[k] >= 0)) {
        this.seq = { prefs: sq.prefs, feedback: sq.feedback, tasks: sq.tasks };
      } else {
        this.reseedSeq(); // 旧文件缺失 seq 字段时回退到现存条目回填
      }
    } else {
      this.data = { schema: 1, nextId: 1, prefs: [], feedback: [], tasks: [] };
      this.seq = { prefs: 0, feedback: 0, tasks: 0 };
    }
  }

  private reseedSeq(): void {
    for (const k of TABLE_KEY) {
      this.seq[k] = this.data[k].reduce((m, e) => {
        const m2 = /^(?:fb|task|pref)-(\d+)$/.exec(e.id);
        return m2 ? Math.max(m, parseInt(m2[1], 10)) : m;
      }, 0);
    }
  }

  save(): void {
    fs.mkdirSync(dirname(this.filePath), { recursive: true });
    const out: NotesFile = { ...this.data, seq: { ...this.seq } };
    fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2) + "\n");
    fs.writeFileSync(join(dirname(this.filePath), "notes.md"), renderNotesView(this.data));
  }

  all(): NotesFile { return this.data; }
  entries(): NoteEntry[] { return TABLE_KEY.flatMap((k) => this.data[k]); }
  findById(id: string): NoteEntry | undefined { return this.entries().find((e) => e.id === id); }

  append(table: NoteEntry["table"], data: { text: string; detail?: string; status?: string; source?: string; locked?: boolean; date?: string }): NoteEntry {
    const today = new Date().toISOString().slice(0, 10);
    const n = ++this.seq[table];
    const e: NoteEntry = {
      id: `${PREFIX[table]}-${String(n).padStart(3, "0")}`,
      table,
      text: data.text,
      detail: data.detail,
      status: data.status,
      date: table === "prefs" ? undefined : (data.date ?? today),
      updatedAt: new Date().toISOString(),
      source: data.source,
      locked: data.locked,
    };
    this.data[table].push(e);
    this.data.nextId = Math.max(this.data.nextId + 1, n + 1);
    return e;
  }

  update(id: string, patch: { text?: string; detail?: string; status?: string }): NoteEntry {
    const e = this.findById(id);
    if (!e) throw new Error(`条目 ${id} 不存在`);
    if (e.locked) throw new Error(`条目 ${id} 由用户记录，工具不可修改`);
    if (patch.text !== undefined) e.text = patch.text;
    if (patch.detail !== undefined) e.detail = patch.detail;
    if (patch.status !== undefined) e.status = patch.status;
    e.updatedAt = new Date().toISOString();
    return e;
  }

  remove(id: string): NoteEntry {
    const e = this.findById(id);
    if (!e) throw new Error(`条目 ${id} 不存在`);
    this.data[e.table] = this.data[e.table].filter((x) => x.id !== id);
    return e;
  }
}

/** 注入块头部（装配时与项目记忆 body 拼接） */
export const NOTES_HEADER = "【项目记忆】（跨会话沉淀；详情可按 ↩ID 召回，有新经验或任务状态变化时用 notes 工具更新）";

/** 注入条目行格式：- <text> [<status>·<date>] ↩<id>（detail/source/updatedAt/locked 不进注入块） */
function noteLine(e: NoteEntry): string {
  const bits = [e.text];
  if (e.status) bits.push(`[${e.status}${e.date ? "·" + e.date : ""}]`);
  bits.push(`↩${e.id}`);
  return `- ${bits.join(" ")}`;
}

/**
 * 渲染项目记忆注入块；返回 null = 不注入（全空或截断后为空）。
 * 三表顺序：用户偏好 → 经验表 → 任务决策表。
 * maxTokens>0 时按 偏好 → 进行中任务 → 最近经验（updatedAt 降序）→ 其余 优先级截断
 * （预算按条目行计，countTokensText 口径）；maxTokens=0 永不截断。
 */
export function renderNotes(entries: NoteEntry[], maxTokens: number): string | null {
  if (entries.length === 0) return null;
  const prefs = entries.filter((e) => e.table === "prefs");
  const feedback = entries.filter((e) => e.table === "feedback");
  const tasks = entries.filter((e) => e.table === "tasks");

  let picked: NoteEntry[];
  let dropped = 0;
  if (maxTokens > 0) {
    const budget = maxTokens;
    const chosen = new Set<NoteEntry>();
    const currentCost = () => countTokensText(entries.filter((e) => chosen.has(e)).map(noteLine).join("\n"));
    const take = (list: NoteEntry[]) => {
      for (const e of list) {
        if (chosen.has(e)) continue;
        if (budget - currentCost() - countTokensText(noteLine(e)) >= 0) chosen.add(e);
        else dropped++;
      }
    };
    take(prefs);
    take(tasks.filter((t) => t.status === "进行中"));
    take([...feedback].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
    take(tasks.filter((t) => t.status !== "进行中"));
    // 还原三表顺序 prefs→feedback→tasks（entries() 已按此序）
    picked = entries.filter((e) => chosen.has(e));
  } else {
    picked = entries;
  }

  const body = [
    picked.some((e) => e.table === "prefs") ? `◈ 用户偏好：\n${picked.filter((e) => e.table === "prefs").map(noteLine).join("\n")}` : null,
    picked.some((e) => e.table === "feedback") ? `◈ 经验表：\n${picked.filter((e) => e.table === "feedback").map(noteLine).join("\n")}` : null,
    picked.some((e) => e.table === "tasks") ? `◈ 任务决策表：\n${picked.filter((e) => e.table === "tasks").map(noteLine).join("\n")}` : null,
  ].filter(Boolean).join("\n");
  if (!body) return null;
  const tail = dropped > 0 ? `\n…（已截断 ${dropped} 条，详情可按 ↩ID 召回或查看 notes 文件）` : "";
  return `${NOTES_HEADER}\n${body}${tail}`;
}

export function renderNotesView(data: NotesFile): string {
  const line = (e: NoteEntry) => {
    const bits = [e.text];
    if (e.status) bits.push(`[${e.status}${e.date ? "·" + e.date : ""}]`);
    bits.push(`↩${e.id}`);
    return `- ${bits.join(" ")}`;
  };
  const sec = (title: string, list: NoteEntry[]) =>
    `## ${title}\n${list.length ? list.map(line).join("\n") : "（空）"}`;
  return [
    "# 项目记忆（pi-compress 自动维护）",
    "",
    "> 本文件由 notes.json 渲染生成，手工修改不会生效；要修改内容请在对话中使用 notes 工具或 /compress-remember 命令。",
    "",
    sec("用户偏好", data.prefs),
    "",
    sec("经验表", data.feedback),
    "",
    sec("任务决策表", data.tasks),
    "",
    `<!-- 渲染时间：${new Date().toISOString()} -->`,
    "",
  ].join("\n");
}
