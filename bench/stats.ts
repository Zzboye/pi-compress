/** 计时与统计辅助：预热、多次迭代、p50/p95/max */
export function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

export interface TimeStats { min: number; p50: number; p95: number; max: number; mean: number; iters: number }

export function bench(fn: () => void, iters = 30, warmup = 5): TimeStats {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) samples.push(timeMs(fn));
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((s, v) => s + v, 0);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return { min: samples[0], p50: q(0.5), p95: q(0.95), max: samples[samples.length - 1], mean: sum / samples.length, iters };
}

export function fmt(s: TimeStats): string {
  return `mean ${s.mean.toFixed(2)}ms / p50 ${s.p50.toFixed(2)} / p95 ${s.p95.toFixed(2)} / max ${s.max.toFixed(2)}`;
}

export function heapMB(): number { return process.memoryUsage().heapUsed / 1024 / 1024; }
