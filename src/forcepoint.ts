export interface ForcePointQueue { pending(): number; waitIdle(ms: number): Promise<boolean> }
export type ForcePointDecision = "pass" | "waited" | "degraded";

export async function enforceForcePoint(
  usage: { tokens: number } | undefined,
  contextWindow: number,
  forceRatio: number,
  queue: ForcePointQueue,
  waitTimeoutMs: number,
  onStatus: (s: string) => void,
): Promise<ForcePointDecision> {
  if (!usage || usage.tokens <= forceRatio * contextWindow) return "pass";
  if (queue.pending() === 0) return "pass";
  onStatus(`上下文 ${Math.round((usage.tokens / contextWindow) * 100)}%，等待摘要队列清空（${queue.pending()} 个 turn）…`);
  const drained = await queue.waitIdle(waitTimeoutMs);
  if (drained) return "waited";
  onStatus("等待超时，本轮降级：交给 pi 原生压缩兜底");
  return "degraded";
}
