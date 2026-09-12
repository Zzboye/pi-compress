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
