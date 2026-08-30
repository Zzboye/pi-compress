import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Turn } from "./util.js";

/** 从尾部往前收集 turn，直到累计 token 超过预算；单 turn 超预算时整体保留 */
export function findWindowTurns(turns: Turn[], keepRecentTokens: number): Turn[] {
  const window: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = turns[i].entries.reduce((s, e) => s + estimateTokens(e.message), 0);
    if (window.length > 0 && total + turnTokens > keepRecentTokens) break;
    window.unshift(turns[i]);
    total += turnTokens;
  }
  return window;
}
