// Real-time pacing for the fixed-step sim. Each frame owes rate * real sim seconds; ticks run until that is paid or the
// frame's sim budget is spent. Whatever does not fit is dropped, so a busy machine runs steadily slower instead of
// piling up a backlog, and the tick count per frame stays even (it only changes when the tick cost clearly moves).
export const SPEEDS = [0.5, 1, 2, 4, 8];
export const FRAME_MS = 21, TOP_FRAME_MS = 22;

export const baseSpeed = (cfg) => { const b = +(cfg && cfg.sim && cfg.sim.baseSpeed); return b > 0 ? b : 1; };

// Sim milliseconds a frame may use, given what drawing it costs. FRAME_MS keeps a sim-bound frame near 48-50 fps; the
// top speed step (top = true) gets TOP_FRAME_MS, about 45 fps, so it never runs fewer ticks than the step below it.
export function simBudgetMs(renderMs = 0, otherMs = 0, top = false) {
  const f = top ? TOP_FRAME_MS : FRAME_MS;
  return Math.max(4, Math.min(f - 3, f - renderMs - otherMs - 1));
}

// Ticks a frame may run within budgetMs, with hysteresis so jitter in the tick cost does not flip it every frame.
export function tickCap(prev, budgetMs, tickMs) {
  if (!(tickMs > 0)) return 64;
  const f = budgetMs / tickMs;
  let cap = prev || Math.max(1, Math.floor(f));
  if (f >= cap + 1.05) cap = Math.floor(f - 0.05);
  else if (f < cap * 0.9) cap = Math.floor(f / 0.9);
  return Math.max(1, Math.min(64, cap));
}

// Running tick cost from a frame's ticks: their average, smoothed over about ten frames. Per-tick updates let the
// odd/even tick split, field rebuilds and GC pauses push the estimate across a tick-cap step and flip the cap.
export function tickCost(prev, ms, n) {
  if (!(n > 0)) return prev;
  const avg = ms / n;
  return prev > 0 ? prev * 0.9 + avg * 0.1 : avg;
}

export class Pacer {
  constructor(dt, clock = () => performance.now()) {
    this.dt = dt;
    this.clock = clock;
    this.acc = 0;
    this.tickMs = 0;
    this.cap = 0;
    this.limited = false;
  }

  reset() { this.acc = 0; this.limited = false; }

  // step() runs one tick and returns false when the clock must stop (the stage ended). Returns ticks run.
  run(real, rate, budgetMs, step) {
    const dt = this.dt, t0 = this.clock();
    this.acc += Math.max(0, real) * Math.max(0, rate);
    const cap = this.cap = tickCap(this.cap, budgetMs, this.tickMs);
    let n = 0, ms = 0;
    this.limited = false;
    while (this.acc >= dt) {
      if (n >= cap || (n > 0 && this.clock() - t0 > budgetMs * 1.25)) { this.limited = true; break; }
      const s0 = this.clock();
      const go = step();
      ms += this.clock() - s0;
      this.acc -= dt;
      n++;
      if (go === false) { this.acc = 0; break; }
    }
    this.tickMs = tickCost(this.tickMs, ms, n);
    if (this.acc > dt) this.acc = dt * 0.999;
    return n;
  }
}
