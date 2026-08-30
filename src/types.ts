import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** pi 的 AgentMessage 类型未从主包导出（在 pi-agent-core 内），但 SessionMessageEntry.message 就是它——派生得到，避免幽灵依赖。 */
export type AgentMessage = SessionMessageEntry["message"];
