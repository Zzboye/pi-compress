import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { NoteStore, renderNotes } from "../src/notes.js";

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
    const a = s.append("feedback", { text: "用 git apply --cached 暂存", detail: "详", status: "有效" });
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

  it("跨会话不复用：删除后保存重启，新条目不复用序号", () => {
    const s = mkStore(); s.load();
    s.append("feedback", { text: "a", detail: "d", status: "有效" });
    s.append("feedback", { text: "b", detail: "d", status: "有效" });
    s.remove("fb-002");
    s.save();
    const s2 = new NoteStore((s as any).filePath);
    s2.load();
    expect(s2.append("feedback", { text: "c", detail: "d", status: "有效" }).id).toBe("fb-003");
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

describe("renderNotes", () => {
  it("三表顺序：偏好→经验→任务；格式 text [状态·日期] ↩id；空表节省略", () => {
    const s = mkStore(); s.load();
    s.append("prefs", { text: "commit message 用中文", locked: true });
    s.append("feedback", { text: "用 git apply --cached 暂存", detail: "detail 内容", status: "有效", date: "2026-09-10" });
    s.append("tasks", { text: "项目记忆设计", detail: "detail 内容", status: "进行中", date: "2026-09-10" });
    const out = renderNotes(s.entries(), 0)!;
    const iP = out.indexOf("用户偏好"), iF = out.indexOf("经验表"), iT = out.indexOf("任务决策表");
    expect(iP).toBeGreaterThan(-1); expect(iF).toBeGreaterThan(iP); expect(iT).toBeGreaterThan(iF);
    expect(out).toContain("[有效·2026-09-10] ↩fb-001");
    expect(out).toContain("[进行中·2026-09-10] ↩task-001");
    expect(out).toContain("【项目记忆】"); // 注入块头部
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

  it("截断后三表顺序仍还原为 prefs→feedback→tasks；updatedAt 缺失的条目参与『其余』截断", () => {
    const s = mkStore(); s.load();
    s.append("tasks", { text: "已完成任务", detail: "d", status: "已完成", date: "2026-09-10" });
    const e = { id: "fb-099", table: "feedback" as const, text: "无时间戳经验" };
    (s.all().feedback).push(e); // 绕过 append，updatedAt 缺失
    const out = renderNotes(s.entries(), 40)!;
    expect(out).toContain("已完成任务");   // 非进行中任务走『其余』，预算内保留
    expect(out).toContain("无时间戳经验");
    expect(out.indexOf("无时间戳经验")).toBeLessThan(out.indexOf("已完成任务")); // 三表顺序还原
  });
});
