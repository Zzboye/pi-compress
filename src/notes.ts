import fs from "node:fs";
import { join, dirname } from "node:path";

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

export interface NotesFile { schema: 1; nextId: number; prefs: NoteEntry[]; feedback: NoteEntry[]; tasks: NoteEntry[]; }

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
      this.reseedSeq();
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
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n");
    fs.writeFileSync(join(dirname(this.filePath), "notes.md"), renderNotesView(this.data));
  }

  all(): NotesFile { return this.data; }
  entries(): NoteEntry[] { return TABLE_KEY.flatMap((k) => this.data[k]); }
  findById(id: string): NoteEntry | undefined { return this.entries().find((e) => e.id === id); }

  append(table: NoteEntry["table"], data: { text: string; detail?: string; status?: string; source?: string; locked?: boolean }): NoteEntry {
    const today = new Date().toISOString().slice(0, 10);
    const n = ++this.seq[table];
    const e: NoteEntry = {
      id: `${PREFIX[table]}-${String(n).padStart(3, "0")}`,
      table,
      text: data.text,
      detail: data.detail,
      status: data.status,
      date: table === "prefs" ? undefined : today,
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
