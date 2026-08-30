import { describe, it, expect, vi } from "vitest";
import { enforceForcePoint } from "../src/forcepoint.js";

function queueWith(pending: number, idleResult: boolean) {
  return {
    pending: () => pending,
    waitIdle: vi.fn().mockResolvedValue(idleResult),
  };
}

describe("enforceForcePoint", () => {
  it("passes immediately when below ratio", async () => {
    const q = queueWith(5, true);
    expect(await enforceForcePoint({ tokens: 1000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("pass");
    expect(q.waitIdle).not.toHaveBeenCalled();
  });

  it("passes when above ratio but queue empty", async () => {
    const q = queueWith(0, true);
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("pass");
  });

  it("waits and succeeds when queue drains in time", async () => {
    const q = queueWith(3, true);
    const status = vi.fn();
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, status)).toBe("waited");
    expect(q.waitIdle).toHaveBeenCalledWith(1000);
    expect(status).toHaveBeenCalled(); // 进度提示
  });

  it("degrades when wait times out", async () => {
    const q = queueWith(3, false);
    expect(await enforceForcePoint({ tokens: 9000 }, 10000, 0.76, q, 1000, vi.fn())).toBe("degraded");
  });

  it("passes when usage is undefined (no estimate)", async () => {
    expect(await enforceForcePoint(undefined, 10000, 0.76, queueWith(3, true), 1000, vi.fn())).toBe("pass");
  });
});
