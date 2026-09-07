/**
 * pi-compress RPC 驱动器 #2：续已有会话，撑破 keepRecentTokens(20k) 窗口，
 * 触发「窗外 turn → 动作日志头替换」+「recall 工具取回逐字原文」。
 *
 *   node e2e/rpc-driver2.mjs <session-file>
 */
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const sessionFile = process.argv[2];
if (!sessionFile) { console.error("usage: node e2e/rpc-driver2.mjs <session-file>"); process.exit(1); }

const PI_ARGS = `--mode rpc --no-extensions -e D:/Pi/pi-compress/src/index.ts --session ${sessionFile}`;

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(ts(), ...a);
const preview = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

console.log(`\n🚀 [${ts()}] 续会话: pi ${PI_ARGS}\n`);
const child = spawn("pi", PI_ARGS.split(" "), { shell: true, stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiters = new Map();
const settledWaiters = [];
const notifies = [];
let lastStatus = "";

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handle(ev);
  }
});
const stderrTail = [];
child.stderr.on("data", (d) => { stderrTail.push(d.toString()); if (stderrTail.length > 30) stderrTail.shift(); });
child.on("exit", (code) => log(`\n🛑 pi 进程退出 code=${code}`));

function handle(ev) {
  switch (ev.type) {
    case "response": {
      if (!ev.success) log(`❌ 命令失败: ${ev.command} ${preview(JSON.stringify(ev.error ?? ""), 200)}`);
      const w = waiters.get(ev.id);
      if (w) { waiters.delete(ev.id); w(ev); }
      break;
    }
    case "agent_start": log("▶️  agent 开始"); break;
    case "agent_settled": log("✅ agent 落定 → 本 turn 入后台摘要队列"); for (const r of settledWaiters.splice(0)) r(); break;
    case "message_end": {
      const m = ev.message ?? ev;
      if (m.role === "user") log(`👤 用户: ${preview(textOf(m), 160)}`);
      else if (m.role === "assistant") log(`🤖 助手: ${preview(textOf(m), 260)}`);
      break;
    }
    case "tool_execution_start": log(`🔧 工具: ${ev.toolName ?? "?"} ${preview(JSON.stringify(ev.args ?? ""), 110)}`); break;
    case "tool_execution_end": log(`   ↳ ${preview(typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? ""), 110)}`); break;
    case "extension_ui_request": {
      if (ev.method === "notify") {
        notifies.push(ev.message);
        log(`📣 [扩展通知]\n${String(ev.message).split("\n").map((l) => "│  " + l).join("\n")}`);
      } else if (ev.method === "setStatus" && ev.statusText !== lastStatus) {
        lastStatus = ev.statusText; log(`⏱  [状态栏 compress] ${ev.statusText}`);
      }
      break;
    }
    case "extension_error": log(`❗ 扩展错误: ${preview(JSON.stringify(ev), 300)}`); break;
    case "turn_end": break;
    default: break;
  }
}
function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c) => c.text ?? "").join(" ");
}

let reqId = 0;
function send(cmd) { const id = `req-${++reqId}`; child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); return id; }
function request(cmd, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = send(cmd);
    const t = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout ${cmd.type}`)); }, timeoutMs);
    waiters.set(id, (ev) => { clearTimeout(t); resolve(ev); });
  });
}
function waitSettled(timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout agent_settled")), timeoutMs);
    settledWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}
async function statusOnce(label) {
  const before = notifies.length;
  send({ type: "prompt", message: "/compress-status" });
  for (let i = 0; i < 40; i++) { await sleep(250); if (notifies.length > before) break; }
  const text = notifies.length > before ? notifies[notifies.length - 1] : "(无)";
  if (label) {
    const g = (re) => (text.match(re) ?? [])[1] ?? "?";
    log(`   [${label}] 已摘要=${g(/已摘要 turn 数：(\d+)/)} 积压=${g(/队列积压：(\d+)/)} | 装配: ${/最近装配：(.*)/.exec(text)?.[1] ?? "?"} | 召回: ${/召回：(.*)/.exec(text)?.[1] ?? "?"}`);
  }
  return text;
}

/** 跑一轮 prompt → 等 agent 落定 → 等摘要追平 */
async function round(message, label) {
  log(`\n━━━ ${label} ━━━`);
  send({ type: "prompt", message });
  await waitSettled();
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const before = notifies.length;
    const text = await statusOnce();
    const done = Number((text.match(/已摘要 turn 数：(\d+)/) ?? [])[1] ?? 0);
    const pending = Number((text.match(/队列积压：(\d+)/) ?? [])[1] ?? 1);
    if (pending === 0) { log(`   [摘要] 已摘要=${done} 积压=0 ✔`); return; }
    void before;
  }
}

try {
  await sleep(3000);
  const st = await request({ type: "get_state" });
  log(`📦 会话就绪: ${st.data?.sessionFile ?? "?"}`);
  await statusOnce("续接时状态");

  await round("用 read 工具读取 D:/Pi/pi-compress/e2e/reports/perf/assembled-context.txt，只要告诉我它是什么、大概多少行，不要引用大段原文。", "第 3 轮：读 40KB 大文件（把窗口撑起来）");
  await round("再用 read 工具读 D:/Pi/pi-compress/e2e/reports/2026-09-01-summary-before-after.md，概括它前 30 行讲了什么。", "第 4 轮：再读一个大文件（把早期 turn 挤出窗口）");

  const st4 = await statusOnce("挤破窗口后");

  await round("不要使用 read 工具。之前我们读过 package.json，请用 recall 工具取回那条 read 动作的逐字原文（动作日志里 ↩ 后面的 ID），然后告诉我 version 字段的值。", "第 5 轮：recall 取回窗外逐字原文");

  const final = await statusOnce("最终");
  log(`\n📊 最终状态:\n${final.split("\n").map((l) => "│  " + l).join("\n")}`);
} catch (e) {
  log(`❌ 驱动器异常: ${e.message}`);
} finally {
  log("\n结束，关闭 pi 进程…");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
  await sleep(1000);
  if (stderrTail.length) log("stderr 尾部:\n" + stderrTail.join("").split("\n").slice(-10).join("\n"));
}
