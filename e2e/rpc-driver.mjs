/**
 * pi-compress RPC 驱动器：开一个全新的 pi 会话（仅加载 pi-compress 扩展），
 * 发出真实提问，把整个过程（回答流 / 后台摘要 / /compress-status）实时打印。
 *
 *   node e2e/rpc-driver.mjs
 */
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PI_ARGS =
  '--mode rpc --no-extensions -e D:/Pi/pi-compress/src/index.ts ' +
  '--session-dir D:/Pi/pi-compress/e2e/rpc-sessions -n pi-compress-rpc-test';

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(ts(), ...a);
const preview = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

console.log(`\n🚀 [${ts()}] 启动全新会话: pi ${PI_ARGS}\n`);
const child = spawn("pi", PI_ARGS.split(" "), { shell: true, stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiters = new Map();      // id -> resolve (responses)
const settledWaiters = [];      // resolve on agent_settled
let lastStatus = "";
const notifies = [];            // {at, text}

child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    handle(ev);
  }
});
const stderrTail = [];
child.stderr.on("data", (d) => {
  stderrTail.push(d.toString());
  if (stderrTail.length > 30) stderrTail.shift();
});
child.on("exit", (code) => log(`\n🛑 pi 进程退出 code=${code}`));

function handle(ev) {
  switch (ev.type) {
    case "response": {
      if (!ev.success) log(`❌ 命令失败: ${ev.command} ${JSON.stringify(ev.error ?? "")}`.slice(0, 300));
      const w = waiters.get(ev.id);
      if (w) { waiters.delete(ev.id); w(ev); }
      break;
    }
    case "agent_start":     log("▶️  agent 开始"); break;
    case "agent_settled":   log("✅ agent 完全落定（agent_settled）→ 插件此时把本 turn 送入后台摘要队列");
      for (const r of settledWaiters.splice(0)) r(); break;
    case "message_end": {
      const m = ev.message ?? ev;
      const role = m.role;
      if (role === "user") log(`👤 用户: ${preview(textOf(m), 160)}`);
      else if (role === "assistant") log(`🤖 助手: ${preview(textOf(m), 300)}`);
      break;
    }
    case "tool_execution_start":
      log(`🔧 工具开始: ${ev.toolName ?? "?"} ${preview(JSON.stringify(ev.args ?? ""), 120)}`); break;
    case "tool_execution_end":
      log(`   ↳ 工具完成: ${preview(ev.output ?? ev.result ?? "", 120)}`); break;
    case "extension_ui_request": {
      if (ev.method === "notify") {
        notifies.push({ at: Date.now(), text: ev.message });
        log(`📣 [扩展通知]\n${String(ev.message).split("\n").map((l) => "│  " + l).join("\n")}`);
      } else if (ev.method === "setStatus") {
        if (ev.statusText !== lastStatus) {
          lastStatus = ev.statusText;
          log(`⏱  [状态栏 compress] ${ev.statusText}`);
        }
      }
      break;
    }
    case "extension_error":
      log(`❗ 扩展错误: ${preview(JSON.stringify(ev), 300)}`); break;
    case "auto_retry_start": log(`🔁 自动重试开始: ${preview(JSON.stringify(ev), 150)}`); break;
    case "compaction_start": log("🗜️  压缩开始"); break;
    case "compaction_end":   log("🗜️  压缩结束"); break;
    case "turn_end":         log("— turn 结束 —"); break;
    default: break; // message_update / streaming 噪声不打印，保持输出干净
  }
}

function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c) => c.text ?? "").join(" ");
}

let reqId = 0;
function send(cmd) {
  const id = `req-${++reqId}`;
  child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
  return id;
}
function request(cmd, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = send(cmd);
    const t = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout waiting ${cmd.type}`)); }, timeoutMs);
    waiters.set(id, (ev) => { clearTimeout(t); resolve(ev); });
  });
}
function waitSettled(timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting agent_settled")), timeoutMs);
    settledWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

/** 发送 /compress-status 并取回紧随其后的第一条扩展通知文本 */
async function runStatusCommand() {
  const before = notifies.length;
  send({ type: "prompt", message: "/compress-status" });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (notifies.length > before) return notifies[notifies.length - 1].text;
  }
  return "(无通知返回)";
}

async function pollCompressed(minTurns, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(i === 0 ? 6000 : 6000);
    const text = await runStatusCommand();
    const done = Number((text.match(/已摘要 turn 数：(\d+)/) ?? [])[1] ?? 0);
    const pending = Number((text.match(/队列积压：(\d+)/) ?? [])[1] ?? 1);
    log(`   [${label}] 已摘要=${done} 积压=${pending}`);
    if (done >= minTurns && pending === 0) return text;
  }
  return await runStatusCommand();
}

try {
  await sleep(3000); // 等 pi 启动、扩展加载
  const st = await request({ type: "get_state" });
  log(`📦 会话就绪: model=${st.data?.model?.id ?? "?"} sessionFile=${st.data?.sessionFile ?? "?"}\n`);

  // ── 第 1 轮：无工具的普通问答 ─────────────────────────────
  log("━━━ 第 1 轮：普通问答（验证回答流 + 后台摘要） ━━━");
  send({ type: "prompt", message: "用一句话介绍你自己，然后随便说一个有趣的数字。不要使用任何工具。" });
  await waitSettled();
  log("");
  log("⏳ 等待后台摘要追平（本地 qwen3.8-27b 异步整理中）…");
  await pollCompressed(1, "摘要进度");

  // ── 第 2 轮：带工具调用（验证动作/路径进动作日志） ────────
  log("\n━━━ 第 2 轮：带工具调用（验证动作日志记录 target/路径） ━━━");
  send({ type: "prompt", message: "用 read 工具读取 D:/Pi/pi-compress/package.json，告诉我这个项目的名字和用途。" });
  await waitSettled();
  log("");
  log("⏳ 等待后台摘要追平…");
  const finalStatus = await pollCompressed(2, "摘要进度");

  const st2 = await request({ type: "get_state" });
  log(`\n📦 最终会话文件: ${st2.data?.sessionFile ?? "?"}`);
  log(`📊 最终状态:\n${finalStatus.split("\n").map((l) => "│  " + l).join("\n")}`);
} catch (e) {
  log(`❌ 驱动器异常: ${e.message}`);
} finally {
  log("\n结束，关闭 pi 进程…");
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
  await sleep(1000);
  if (stderrTail.length) log("stderr 尾部:\n" + stderrTail.join("").split("\n").slice(-10).join("\n"));
}
