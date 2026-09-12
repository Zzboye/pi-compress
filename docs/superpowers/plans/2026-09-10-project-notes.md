# Project Notes（跨会话项目记忆）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 pi-compress 增加 LLM 主动维护的跨会话项目记忆：notes 工具写入三表（偏好/经验/任务）、装配时注入 ledger 头前、recall 双源召回 detail。

**Architecture:** 单文件 `notes.json`（结构化真相）+ `notes.md`（渲染视图）；`NoteStore` 管理内存状态与写队列（mutex 串行化工具与命令两条写路径）；执行 LLM 通过 `notes` 工具（append/update/delete）主动维护；注入在 `assembleContext` 之外由 index.ts 拼接（renderNotes 产出 custom message 插在 ledger 头前），不改动 assembler 内部。recall 扩展为双源：notes 前缀 ID 优先，branch 兜底。

**Tech Stack:** TypeScript + vitest（与现有代码一致）；无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-10-project-notes-design.md`（字段表、格式、语义均以此为准）

## Global Constraints

- 无新 npm 依赖；token 计量一律用 `util.countTokensText`（CJK 口径），禁止 chars/4
- ID 命名空间：`fb-`/`task-`/`pref-` 前缀 + 单调序号；`nextId` 存于 notes.json，**删除不复用**
- 三表顺序：**用户偏好 → 经验表 → 任务决策表**（注入与 md 视图一致）
- `enabled=false` 只关装配注入，notes 工具与命令照常可写
- `maxTokens` 默认 0 = 注入块不限制；**文件本身永不因大小截断/拒写**
- 偏好表对 LLM append-only：用户命令写入的条目 `locked=true`，工具 update/delete 拒绝
- 校验失败返回错误文本给 LLM（工具）/ notify（命令），**不抛异常、不阻塞主链路**
- 全部用户可见文案使用中文；commit message 中文
- 测试命令：`npx vitest run <file>`；全量回归 `npx vitest run`（基线 183 passed / 1 skipped）
- /compress-status 现有行文案不得改动（既有测试断言），notes 信息**追加新行**

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/notes.ts` | 新建：NoteStore（读写/写队列/ID 分配/locked 校验）、NoteTypes（NoteEntry 等）、renderNotes（注入块）、renderNotesView（md 视图） |
| `tests/notes.test.ts` | 新建：NoteStore 单元测试 |
| `src/config.ts` | 增加 `projectNotes` 配置块 |
| `src/index.ts` | 注册 notes 工具、recall 双源接入、装配注入拼接、/compress-remember 命令、status 行 |
| `tests/extension.test.ts` | 工具/命令/注入的集成测试 |
| `tests/recall.test.ts` | recall 双源用例 |
| `README.md` | 配置项与用法文档 |

---

### Task 1: NoteStore 与 notes.json 读写

**Files:**
- Create: `src/notes.ts`, `tests/notes.test.ts`

**Interfaces:**
- Consumes: `countTokensText` 不在本任务使用；纯数据层无外部依赖。
- Produces（后续任务依赖，签名固定）:
  ```ts
  export interface NoteEntry {
    id: string;            // "fb-001" | "task-001" | "pref-001"
    table: "prefs" | "feedback" | "tasks";
    text: string;          // 注入上下文的唯一内容
    detail?: string;       // 不注入；recall 返回正文（tasks 含决策+文件+来源）
    status?: string;       // prefs 无；feedback: 有效/纠正；tasks: 进行中/已完成/已否决
    date?: string;         // "YYYY-MM-DD"
    updatedAt?: string;    // ISO
    source?: string;       // 溯源标注（可选，只展示不保证可召回）
    locked?: boolean;      // prefs 用户命令写入 = true
  }
  export interface NotesFile { schema: 1; nextId: number; prefs: NoteEntry[]; feedback: NoteEntry[]; tasks: NoteEntry[]; }
  export class NoteStore {
    constructor(filePath: string)
    load(): void                                   // 文件不存在/损坏 → 空库（schema≠1 同样视为损坏置空）
    save(): void                                   // 写 notes.json + 同步渲染 notes.md（同目录）
    all(): NotesFile                               // 返回内部状态引用（只读约定）
    entries(): NoteEntry[]                         // prefs→feedback→tasks 顺序扁平
    append(table, data: { text, detail?, status?, source?, locked? }): NoteEntry   // 分配单调 ID（nextId++），updatedAt=now
    update(id, patch: { text?, detail?, status? }): NoteEntry   // 未找到或 locked → throw Error（中文消息）
    remove(id): NoteEntry                          // 未找到 → throw；删除后 nextId 不回退
    findById(id): NoteEntry | undefined
  }
  ```
- `save()` 同时写两个文件：`<path>`（json）与 `<同目录>/notes.md`（视图，见 Task 3 格式）；目录不存在自动创建（`fs.mkdirSync(recursive)`）

- [ ] **Step 1: 写失败测试**（`tests/notes.test.ts`，用 `os.tmpdir()` 临时目录，afterEach 清理）

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { NoteStore } from "../src/notes.js";

const dirs: string[] = [];
function mkStore(): NoteStore {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "notes-test-"));
  dirs.push(dir);
  return new NoteStore(join(dir, "notes.json"));
}
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

describe("NoteStore", () => {
  it("空库：文件不存在时 load 得到空三表 + nextId=1", () => {
    const s = mkStore();
    s.load();
    expect(s.all()).toEqual({ schema: 1, nextId: 1, prefs: [], feedback: [], tasks: [] });
  });

  it("append 分配单调 ID：fb-001、fb-002；save 后文件存在且 load 可还原", () => {
    const s = mkStore();
    s.load();
    const a = s.append("feedback", { text: "用 git apply --cached 暂存", detail: "详", status: "有效", date: "2026-09-10" });
    const b = s.append("feedback", { text: "第二条", detail: "详2", status: "纠正" });
    expect(a.id).toBe("fb-001");
    expect(b.id).toBe("fb-002");
    s.save();
    const s2 = mkStore(); // 同目录新实例
    (s2 as any).filePath = (s as any).filePath;
    s2.load();
    expect(s2.findById("fb-001")?.text).toBe("用 git apply --cached 暂存");
    expect(s2.all().nextId).toBe(3);
  });

  it("task 与 pref 前缀正确；entries() 按 prefs→feedback→tasks 排序", () => {
    const s = mkStore(); s.load();
    s.append("tasks", { text: "T", detail: "d", status: "进行中" });
    s.append("prefs", { text: "P", locked: true });
    s.append("feedback", { text: "F", detail: "d", status: "有效" });
    expect(s.findById("task-001")).toBeDefined();
    expect(s.findById("pref-001")).toBeDefined();
    expect(s.entries().map((e) => e.table)).toEqual(["prefs", "feedback", "tasks"]);
  });

  it("remove 后 nextId 不复用：删 fb-002 后新条目是 fb-003", () => {
    const s = mkStore(); s.load();
    s.append("feedback", { text: "a", detail: "d", status: "有效" });
    s.append("feedback", { text: "b", detail: "d", status: "有效" });
    s.remove("fb-002");
    expect(s.append("feedback", { text: "c", detail: "d", status: "有效" }).id).toBe("fb-003");
  });

  it("update 修改字段并刷新 updatedAt；未找到/locked 抛中文错误", () => {
    const s = mkStore(); s.load();
    s.append("tasks", { text: "T", detail: "d", status: "进行中" });
    const u = s.update("task-001", { status: "已完成" });
    expect(u.status).toBe("已完成");
    expect(u.updatedAt).toBeTruthy();
    s.append("prefs", { text: "P", locked: true });
    expect(() => s.update("pref-001", { text: "x" })).toThrow(/用户记录/);
    expect(() => s.update("task-999", { status: "已完成" })).toThrow(/不存在/);
  });

  it("损坏文件（非法 JSON / schema≠1）→ 置空库而非抛异常", () => {
    const s = mkStore();
    fs.writeFileSync((s as any).filePath, "{oops");
    s.load();
    expect(s.all().nextId).toBe(1);
    fs.writeFileSync((s as any).filePath, JSON.stringify({ schema: 2 }));
    s.load();
    expect(s.all().nextId).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/notes.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/notes.ts`**

```ts
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
    } else {
      this.data = { schema: 1, nextId: 1, prefs: [], feedback: [], tasks: [] };
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
    const e: NoteEntry = {
      id: `${PREFIX[table]}-${String(this.data.nextId++).padStart(3, "0")}`,
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
```

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/notes.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/notes.ts tests/notes.test.ts
git commit -m "feat: NoteStore 与 notes.json/notes.md 读写（三表、单调 ID、locked）"
```

---

### Task 2: projectNotes 配置块

**Files:**
- Modify: `src/config.ts`（接口、DEFAULT_CONFIG、loadConfig）
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ContextCompressConfig 增加：
  projectNotes: { enabled: boolean; path: string; maxTokens: number };
  // DEFAULT_CONFIG.projectNotes = { enabled: false, path: ".pi-compress/notes.json", maxTokens: 0 };
  // loadConfig 解析：enabled=!!v（默认 false）；path=typeof v==="string" ? v : 默认；maxTokens=num(v, 0, 0, 1_000_000)
  ```

- [ ] **Step 1: 写失败测试**（`tests/config.test.ts` 追加）

```ts
  it("projectNotes：缺省 = 关闭 + 默认路径 + maxTokens 0", () => {
    const c = loadConfig({}, {});
    expect(c.projectNotes).toEqual({ enabled: false, path: ".pi-compress/notes.json", maxTokens: 0 });
  });

  it("projectNotes：可开启、可改路径与预算；非法值回退默认", () => {
    const c = loadConfig({}, { contextCompress: { projectNotes: { enabled: true, path: "custom/notes.json", maxTokens: 2000 } } });
    expect(c.projectNotes.enabled).toBe(true);
    expect(c.projectNotes.path).toBe("custom/notes.json");
    expect(c.projectNotes.maxTokens).toBe(2000);
    const bad = loadConfig({}, { contextCompress: { projectNotes: { maxTokens: -5 } } });
    expect(bad.projectNotes.maxTokens).toBe(0);
  });
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/config.test.ts` → FAIL

- [ ] **Step 3: 实现**——`config.ts` 三处：

```ts
// 接口加：
projectNotes: { enabled: boolean; path: string; maxTokens: number };
// DEFAULT_CONFIG 加：
projectNotes: { enabled: false, path: ".pi-compress/notes.json", maxTokens: 0 },
// loadConfig 返回对象加：
projectNotes: {
  enabled: merged.projectNotes === undefined ? DEFAULT_CONFIG.projectNotes.enabled
    : !!(merged.projectNotes as any).enabled,
  path: merged.projectNotes && typeof (merged.projectNotes as any).path === "string"
    ? (merged.projectNotes as any).path : DEFAULT_CONFIG.projectNotes.path,
  maxTokens: num((merged.projectNotes as any)?.maxTokens, 0, 0, 1_000_000),
},
```

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/config.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: projectNotes 配置块（enabled/path/maxTokens，默认关闭且不限制）"
```

---

### Task 3: recall 双源（notes 优先，branch 兜底）

**Files:**
- Modify: `src/recall.ts`（executeRecall 签名扩展或新增包装函数）
- Test: `tests/recall.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `NoteStore.findById(id): NoteEntry | undefined`、`NoteEntry.detail`
- Produces:
  ```ts
  export function executeRecallDual(
    ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number,
  ): RecallResult   // 复用 RecallResult { text, missing }
  ```
  行为：每个 ID 先查 `notes?.findById(裸 ID)`（剥掉前导 `↩` 再查；以 `fb-/task-/pref-` 开头才视为 notes ID）→ 命中且 `detail` 非空 → 输出 `【fb-001 的记忆详情】\n<detail>`；notes ID 命中但 detail 空 → 输出 `【fb-001】\n（该条目无详情）`；notes ID 但条目不存在 → 文案 `（记忆条目 fb-xxx 不存在或已删除）` 且计入 missing；非 notes ID → 走现有 `executeRecall` 路径（原文/配对 toolResult/4k 截断/missing 文案不变）。

- [ ] **Step 1: 写失败测试**（`tests/recall.test.ts` 追加，构造 NoteStore 用 tmpdir，模式同 Task 1 测试）

```ts
describe("executeRecallDual", () => {
  it("notes ID 命中：返回 detail 而非 branch 原文", () => {
    const store = mkStore(); store.load();
    store.append("feedback", { text: "摘要行", detail: "方法详情全文", status: "有效" });
    const r = executeRecallDual(["fb-001"], [], store, 4000);
    expect(r.text).toContain("记忆详情");
    expect(r.text).toContain("方法详情全文");
    expect(r.missing).toEqual([]);
  });

  it("带 ↩ 前缀与带 entry 前缀混传：各走各的源", () => {
    const store = mkStore(); store.load();
    store.append("tasks", { text: "T", detail: "任务详情", status: "进行中" });
    const branch = [userEntry("u1", "你好")];  // 该文件现有 helper，若无则内联构造
    const r = executeRecallDual(["↩task-001", "u1"], branch, store, 4000);
    expect(r.text).toContain("任务详情");
    expect(r.text).toContain("u1");            // entry 原文路径照常
    expect(r.missing).toEqual([]);
  });

  it("notes ID 条目不存在：missing 计入 + 专用文案", () => {
    const store = mkStore(); store.load();
    const r = executeRecallDual(["fb-042"], [], store, 4000);
    expect(r.missing).toEqual(["fb-042"]);
    expect(r.text).toContain("不存在或已删除");
  });

  it("store 为 null（未启用）：entry ID 行为与现有 executeRecall 完全一致", () => {
    const branch = [/* 现有 recall.test.ts 的 fixture */];
    const r = executeRecallDual(["u1"], branch, null, 4000);
    const r2 = executeRecall(["u1"], branch, 4000);
    expect(r.text).toBe(r2.text);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**（`src/recall.ts` 追加）

```ts
import { NoteStore } from "./notes.js";
const NOTE_PREFIX_RE = /^(fb|task|pref)-/;

export function executeRecallDual(ids: string[], branch: MessageEntry[], notes: NoteStore | null, maxTokensPerEntry: number): RecallResult {
  const entryIds: string[] = [];
  const parts: string[] = [];
  const missing: string[] = [];
  for (const raw of ids) {
    const id = raw.replace(/^↩/, "");
    if (NOTE_PREFIX_RE.test(id) && notes) {
      const e = notes.findById(id);
      if (!e) { missing.push(id); parts.push(`【${id}】\n（记忆条目 ${id} 不存在或已删除）`); continue; }
      parts.push(e.detail ? `【${id} 的记忆详情】\n${e.detail}` : `【${id}】\n（该条目无详情）`);
      continue;
    }
    entryIds.push(raw);
  }
  if (entryIds.length > 0) {
    const r = executeRecall(entryIds, branch, maxTokensPerEntry);
    parts.unshift(r.text);
    missing.unshift(...r.missing);
  }
  return { text: parts.join("\n\n") || "（无内容）", missing };
}
```

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/recall.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/recall.ts tests/recall.test.ts
git commit -m "feat: recall 双源——notes 条目 ID 优先返回 detail，branch entry 兜底"
```

---

### Task 4: 装配注入（renderNotes + context 事件拼接）

**Files:**
- Modify: `src/notes.ts`（加 `renderNotes`）、`src/index.ts`（context 事件、session_start）
- Test: `tests/notes.test.ts`（renderNotes）、`tests/extension.test.ts`（注入）

**Interfaces:**
- Consumes: Task 1 `NoteStore.entries(): NoteEntry[]`；Task 2 `config.projectNotes`；`countTokensText`（util.ts）
- Produces:
  ```ts
  // src/notes.ts 追加：
  export function renderNotes(entries: NoteEntry[], maxTokens: number): string | null
  // 三表顺序 prefs→feedback→tasks；返回 null = 不注入（全空或截断后为空）
  // maxTokens>0 时超预算截断（顺序：偏好 → 进行中任务 → 最近经验 → 其余，countTokensText 口径），尾注「…（已截断 N 条，详情可按 ↩ID 召回或查看 notes 文件）」；maxTokens=0 不截断
  ```
  index.ts：
  ```ts
  let notesStore: NoteStore | null = null;      // session_start 时按 config.projectNotes.path（相对 cwd 解析）构造并 load
  notesStore 写路径专用队列：let notesQueue: Promise<void> = Promise.resolve();
  function enqueueNotesWrite(fn: () => Promise<string>): Promise<string>  // 串行执行 fn，返回其结果；异常转为「写失败：…」文本不抛出
  ```
  context 事件处理器内（现有 `const { messages, stats } = assembleContext(...)` 之后）：
  ```ts
  const notesText = config.projectNotes.enabled && notesStore
    ? renderNotes(notesStore.entries(), config.projectNotes.maxTokens) : null;
  if (notesText) messages.unshift({ role: "custom", content: notesText } as any);
  // 注：custom message 具体形状以 renderActionLedger 的返回结构为准（实现者对照 src/ledger.ts 现有 custom message 构造方式，保持一致）
  ```

- [ ] **Step 1: 写失败测试**

`tests/notes.test.ts` 追加（renderNotes 纯函数测试）：

```ts
describe("renderNotes", () => {
  it("三表顺序：偏好→经验→任务；格式 text [状态·日期] ↩id；空表节省略", () => {
    const s = mkStore(); s.load();
    s.append("prefs", { text: "commit message 用中文", locked: true });
    s.append("feedback", { text: "用 git apply --cached 暂存", detail: "d", status: "有效", date: "2026-09-10" });
    s.append("tasks", { text: "项目记忆设计", detail: "d", status: "进行中", date: "2026-09-10" });
    const out = renderNotes(s.entries(), 0)!;
    const iP = out.indexOf("用户偏好"), iF = out.indexOf("经验表"), iT = out.indexOf("任务决策表");
    expect(iP).toBeLessThan(iF); expect(iF).toBeLessThan(iT);
    expect(out).toContain("[有效·2026-09-10] ↩fb-001");
    expect(out).toContain("[进行中·2026-09-10] ↩task-001");
    expect(out).not.toContain("detail 内容"); // detail 不注入
  });

  it("全空 → null（不注入）", () => {
    const s = mkStore(); s.load();
    expect(renderNotes(s.entries(), 0)).toBeNull();
  });

  it("maxTokens>0：超预算按 偏好→进行中任务→最近经验→其余 截断并带尾注", () => {
    const s = mkStore(); s.load();
    s.append("prefs", { text: "偏好甲", locked: true });
    s.append("feedback", { text: "旧经验".repeat(50), detail: "d", status: "有效", date: "2026-09-01" });
    s.append("feedback", { text: "新经验", detail: "d", status: "纠正", date: "2026-09-10" });
    s.append("tasks", { text: "进行中任务", detail: "d", status: "进行中", date: "2026-09-10" });
    const out = renderNotes(s.entries(), 60)!;
    expect(out).toContain("偏好甲");
    expect(out).toContain("进行中任务");
    expect(out).toContain("新经验");
    expect(out).toContain("已截断");
    expect(out).not.toContain("旧经验");
  });

  it("maxTokens=0 永不截断", () => {
    const s = mkStore(); s.load();
    s.append("feedback", { text: "长".repeat(5000), detail: "d", status: "有效" });
    const out = renderNotes(s.entries(), 0)!;
    expect(out).toContain("长".repeat(5000));
  });
});
```

`tests/extension.test.ts` 追加（注入集成，harness 模式与现有 recall 用例一致；`mkLedger` 已存在于该文件）：

```ts
  it("notes 注入：enabled 时项目记忆块插在 ledger 头之前", async () => {
    const { tools, commands, handlers } = harness();
    // 用 tmpdir 建一个带内容的 notes 文件，settings 传 projectNotes={enabled:true, path:<tmp>/notes.json}
    // handlers.session_start 后：notesStore 已 load
    // tools 上下文触发 context 事件（若 harness 无 context 事件触发能力，直接测 context handler 内联逻辑——
    //   退而求其次：断言 assembleContext 调用点之前的 messages[0] 为 notes 块，方式由实现者按 harness 能力选择，
    //   但至少断言：session_start 后 notesStore 非空 + renderNotes 输出含「项目记忆」头）
    // 断言装配结果 messages[0] 含「项目记忆」、messages[1] 为 ledger 头（若 ledger 存在）
  });
```

> **实现者注意**：上面 integration 测试是**行为规格**而非逐行代码——harness 若无法触发 context 事件，允许把注入逻辑抽为 `src/index.ts` 内可导出的小函数（如 `applyNotesInjection(messages, notesStore, config)`）做纯函数测试，context 事件里只调用它。抽函数是首选（可测性好）。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**（renderNotes 按 Interfaces 规格；index.ts 按 Interfaces 代码块 + applyNotesInjection 抽函数方案）

renderNotes 参考实现（截断顺序逻辑核心）：

```ts
export function renderNotes(entries: NoteEntry[], maxTokens: number): string | null {
  const prefs = entries.filter((e) => e.table === "prefs");
  const feedback = entries.filter((e) => e.table === "feedback");
  const tasks = entries.filter((e) => e.table === "tasks");
  if (entries.length === 0) return null;

  const line = (e: NoteEntry) => {
    const bits = [e.text];
    if (e.status) bits.push(`[${e.status}${e.date ? "·" + e.date : ""}]`);
    bits.push(`↩${e.id}`);
    return `- ${bits.join(" ")}`;
  };
  const section = (title: string, list: NoteEntry[]) =>
    list.length ? `◈ ${title}：\n${list.map(line).join("\n")}` : null;

  let picked: NoteEntry[] = [];
  let dropped = 0;
  if (maxTokens > 0) {
    const budget = maxTokens;
    const take = (list: NoteEntry[]) => {
      for (const e of list) {
        const t = countTokensText(line(e));
        if (budget - countTokensText(renderNotesHeader()) - countTokensText([...picked, e].map(line).join("\n")) >= 0) {
          picked.push(e);
        } else dropped++;
      }
    };
    take(prefs);
    take(tasks.filter((t) => t.status === "进行中"));
    take([...feedback].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
    take(tasks.filter((t) => t.status !== "进行中"));
    // picked 顺序需还原为 prefs→feedback(原序)→tasks(原序) 以符合三表顺序
    picked = prefs.filter((e) => picked.includes(e))
      .concat(feedback.filter((e) => picked.includes(e)))
      .concat(tasks.filter((e) => picked.includes(e)));
  } else {
    picked = entries;
  }

  const body = [section("用户偏好", picked.filter((e) => e.table === "prefs")),
    section("经验表", picked.filter((e) => e.table === "feedback")),
    section("任务决策表", picked.filter((e) => e.table === "tasks"))].filter(Boolean).join("\n");
  if (!body) return null;
  const tail = dropped > 0 ? `\n…（已截断 ${dropped} 条，详情可按 ↩ID 召回或查看 notes 文件）` : "";
  return `【项目记忆】（跨会话沉淀；详情可按 ↩ID 召回，有新经验或任务状态变化时用 notes 工具更新）\n${body}${tail}`;
}
```

> 实现者可重构上面截断逻辑（伪码性质的预算判断较绕），但**行为必须与测试断言一致**：截断顺序偏好→进行中任务→最近经验→其余、三表顺序还原、尾注格式、maxTokens=0 不截断。

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/notes.test.ts tests/extension.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/notes.ts src/index.ts tests/notes.test.ts tests/extension.test.ts
git commit -m "feat: 装配注入项目记忆块（ledger 头前，enabled/maxTokens 控制）"
```

---

### Task 5: notes 工具与 /compress-remember 命令

**Files:**
- Modify: `src/index.ts`（registerTool + registerCommand + status 行）
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 1 `NoteStore.append/update/remove/entries`（update/remove 抛中文 Error）、Task 2 `config.projectNotes.enabled`
- Produces:
  ```ts
  pi.registerTool({ name: "notes", ... })
  // schema: Type.Object({ action: Type.Union([Type.Literal("append"), Type.Literal("update"), Type.Literal("delete")]),
  //   table: Type.Optional(Type.Union([Type.Literal("prefs"), Type.Literal("feedback"), Type.Literal("tasks")])),
  //   id: Type.Optional(Type.String()), text: Type.Optional(Type.String()),
  //   detail: Type.Optional(Type.String()), status: Type.Optional(Type.String()), source: Type.Optional(Type.String()) })
  pi.registerCommand("compress-remember", { ... })
  // /compress-remember <内容> [global]：无参数 → 用法提示；含 global →「全局记忆未实现」；
  // 否则 append 进 prefs（locked=true），notify 确认「已记住（pref-001）」
  // recallStats 增加 notesHits 计数（Task 3 双源命中 notes 的条数），status 行追加「/ 记忆召回 N 条」
  ```
- 写路径统一走 Task 4 的 `enqueueNotesWrite`；工具 execute 内：调用前若 `!notesStore` → 返回「项目记忆未启用（contextCompress.projectNotes.path 未配置）」；执行后 `save()` 并返回确认文本（含新 ID）

- [ ] **Step 1: 写失败测试**（extension.test.ts 追加；tmpdir notes 文件 + settings 传 projectNotes）

```ts
  it("notes 工具 append→update→delete 全链路，locked 偏好拒绝改删", async () => {
    // setup: enabled=true 的 projectNotes 指向 tmpdir
    const r1 = await tools.notes.execute("tc", { action: "append", table: "feedback", text: "T", detail: "D", status: "有效" }, undefined, undefined, fakeCtx);
    expect(r1.content[0].text).toContain("fb-001");
    const r2 = await tools.notes.execute("tc", { action: "update", id: "fb-001", status: "纠正" }, undefined, undefined, fakeCtx);
    expect(r2.content[0].text).toContain("纠正");
    const r3 = await tools.notes.execute("tc", { action: "append", table: "prefs", text: "P" }, undefined, undefined, fakeCtx);
    expect(r3.content[0].text).toContain("pref-001");
    const r4 = await tools.notes.execute("tc", { action: "delete", id: "pref-001" }, undefined, undefined, fakeCtx);
    expect(r4.content[0].text).toContain("用户记录");   // locked 拒绝
    const r5 = await tools.notes.execute("tc", { action: "delete", id: "fb-001" }, undefined, undefined, fakeCtx);
    expect(r5.content[0].text).toContain("已删除");
    // notes.json 落盘校验
    expect(JSON.parse(fs.readFileSync(notesPath, "utf8")).feedback).toHaveLength(0);
  });

  it("notes 工具校验失败返回错误文本（不抛异常）", async () => {
    const r = await tools.notes.execute("tc", { action: "update", id: "task-999", status: "已完成" }, undefined, undefined, fakeCtx);
    expect(r.content[0].text).toContain("不存在");
    expect(r.content[0].text).not.toContain("throw");
  });

  it("未启用时 notes 工具返回提示；/compress-remember 直写 prefs locked 条目；global 提示未实现", async () => {
    // 未启用用例：无 projectNotes 配置 → 工具返回「未启用」
    // 命令用例：await commands["compress-remember"].handler("commit message 用中文", fakeCtx)
    //   → notify 含「已记住」；json 里该条 locked=true
    //   → handler("记录A global", fakeCtx) → notify 含「未实现」
    //   → handler("", fakeCtx) → notify 含「用法」
  });
```

> 测试是行为规格；`tools.notes` 的获取方式、fakeCtx 构造、notify 捕获均沿用该文件现有模式（参考 recall query 用例）。save() 在测试中真实落盘到 tmpdir。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**（index.ts）：

notes 工具 description（防滥用门槛，按 spec §3）：

```
维护跨会话项目记忆（用户偏好/经验/任务决策）。三种操作：append 新增条目、update 更新（如任务状态翻转：进行中→已完成）、delete 删除。
【写入门槛】仅当出现被用户明确纠正的做法、新任务或任务状态变化、新的稳定偏好时调用；与现有条目语义重复时用 update 合并而非 append；不要记录可从代码库推导的内容（架构、文件路径）。
update/delete 对用户通过 /compress-remember 记录的条目无效。
```

- [ ] **Step 4: 跑测试确认通过**：`npx vitest run tests/extension.test.ts` → PASS

- [ ] **Step 5: 全量回归 + Commit**

```bash
npx vitest run   # 预期 ≥ 183+新增 全 passed / 1 skipped
git add src/index.ts tests/extension.test.ts
git commit -m "feat: notes 工具（LLM 主动维护三表）与 /compress-remember 命令"
```

---

### Task 6: README 与 /compress-status 收尾

**Files:**
- Modify: `README.md`、`src/index.ts`（status 追加行）
- Test: `tests/extension.test.ts`（status 行追加断言）

**Interfaces:**
- Consumes: 前五个任务全部产出

- [ ] **Step 1: status 追加行**（现有行文案不动，追加在「召回」行之后）：

```
项目记忆：<启用/未启用> · <N> 条（偏好 X / 经验 Y / 任务 Z）· 召回 N 条
```

测试：

```ts
  it("compress-status 显示项目记忆行", async () => {
    // enabled 时 notify 含「项目记忆：启用 · 3 条」；未配置时含「项目记忆：未启用」
  });
```

- [ ] **Step 2: README 更新**（三处）：配置表加 `projectNotes` 三行（enabled/path/maxTokens，注明默认值与「enabled 只关注入不关收集」）；新增「项目记忆」小节（三表说明、notes 工具用法、/compress-remember、recall 双源示例 `recall({ids:["fb-001"]})`）；文件树加 `notes.ts` 行

- [ ] **Step 3: 全量回归**：`npx vitest run` → 全绿（1 skipped 正常）

- [ ] **Step 4: Commit**

```bash
git add README.md src/index.ts tests/extension.test.ts
git commit -m "docs: README 项目记忆文档 + status 记忆行"
```

---

## Self-Review 记录

- **Spec 覆盖**：数据模型（T1）、配置（T2）、召回双源（T3）、注入（T4）、工具+命令+写队列（T5）、status/README（T6）——spec §1-§9 全覆盖；§2 的 notes.md 视图格式在 T1 renderNotesView、§8 status 行在 T6
- **Placeholder 扫描**：T4/T5 的集成测试为行为规格式（harness 能力未知，实现者按现有模式落地），已内联注明首选方案（applyNotesInjection 抽函数）；无 TBD/TODO
- **类型一致性**：`NoteEntry/NotesFile/NoteStore/renderNotes/renderNotesView/executeRecallDual/enqueueNotesWrite` 签名在 Interfaces 块中前后一致；`recallStats.notesHits` 仅 T5 定义、T6 消费
