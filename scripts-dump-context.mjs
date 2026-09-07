// 直接调用插件的 assembleContext，拿到真实发给 LLM 的 messages，原样打印
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const { loadConfig } = await import("./src/config.ts");
const { LedgerStore } = await import("./src/store.ts");
const { assembleContext } = await import("./src/assembler.ts");

const SESSION = process.argv[2];
const entriesAll = readFileSync(SESSION, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// 只保留 message 类型的 entry（与 toMessageEntries 一致），按文件顺序即分支顺序
const branch = entriesAll.filter((e) => e.type === "message").map((e) => ({ id: e.id, message: e.message }));

// 载入配置（全局+项目）
const globalRaw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
let projectRaw;
try { projectRaw = JSON.parse(readFileSync(".pi/settings.json", "utf8")); } catch {}
const config = loadConfig(globalRaw, projectRaw);

// 从会话文件重建 ledger store
const store = new LedgerStore();
store.rebuildFromEntries(entriesAll);

const cacheMap = new Map();
for (const k of store.keys()) { const v = store.get(k); if (v) cacheMap.set(k, v); }
const { messages, stats } = assembleContext(branch, cacheMap, config.keepRecentTokens);

console.error(`[stats] 窗口 ${stats.windowTurns} turns / 替换 ${stats.replacedTurns} / 原文放行 ${stats.passthroughTurns} | keepRecentTokens=${config.keepRecentTokens}`);
console.log(JSON.stringify(messages, null, 1));
