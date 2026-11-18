// Game clock pacing with a fake clock: the per-frame sim budget, steady ticks, dropped backlog, and co-op lockstep
// where the slower machine sets the pace. Run: node test/speed_pacing.mjs
import { Pacer, SPEEDS, baseSpeed, simBudgetMs, tickCap } from '../js/game/pacer.js';
import { LockstepDriver } from '../js/net/coop.js';
import { DEFAULTS } from '../js/data/config.js';

let fails = 0;
const ok = (c, msg) => { if (c) console.log('ok -', msg); else { fails++; console.error('FAIL:', msg); } };
const DT = DEFAULTS.sim.dt, BASE = baseSpeed(DEFAULTS);

ok(BASE === 2 && SPEEDS.join() === '0.5,1,2,4,8', `speed steps ${SPEEDS.join('/')} on a base of ${BASE} sim s per real s`);

// One single-player loop: frames at the display rate, each costing render + whatever ticks the pacer runs.
function runSolo({ speed, tickMs, renderMs = 4, jitter = 0, seconds = 10, hz = 60, stall = -1, top = speed >= SPEEDS[SPEEDS.length - 1] }) {
  let now = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const p = new Pacer(DT, () => now);
  const per = [];
  let ticks = 0, real = 1 / hz, t = 0, maxAcc = 0;
  while (t < seconds) {
    const f0 = now;
    const n = p.run(stall >= 0 && per.length === stall ? 0.1 : real, speed * BASE, simBudgetMs(renderMs, 0.5, top), () => { now += tickMs * (1 + jitter * (rnd() * 2 - 1)); return true; });
    now += renderMs;
    per.push(n);
    ticks += n;
    maxAcc = Math.max(maxAcc, p.acc);
    const work = now - f0;
    real = Math.max(1000 / hz, work) / 1000;
    now = f0 + real * 1000;
    t += real;
  }
  const frames = per.length;
  return { per, fps: frames / t, speed: ticks * DT / t / BASE, maxAcc, steady: per.slice(30) };
}

{
  const r = runSolo({ speed: 1, tickMs: 1 });
  ok(Math.abs(r.speed - 1) < 0.02 && r.fps > 59, `1x on a light map runs at 1x (${r.speed.toFixed(3)}x, ${r.fps.toFixed(0)} fps)`);
  const r8 = runSolo({ speed: 8, tickMs: 1 });
  ok(Math.abs(r8.speed - 8) < 0.1, `8x keeps up when ticks are cheap (${r8.speed.toFixed(2)}x)`);
  ok(Math.abs(runSolo({ speed: 0.5, tickMs: 1 }).speed - 0.5) < 0.02, '0.5x runs at 0.5x');
}
{
  // a 4 km city: about 7.5 ms per tick and 4 ms to draw
  const r = runSolo({ speed: 8, tickMs: 7.5 });
  const counts = new Set(r.steady);
  ok(r.fps >= 45, `8x on a heavy map keeps ${r.fps.toFixed(1)} fps (aim >= 45)`);
  ok(counts.size === 1, `the same number of ticks every frame (${[...counts].join(',')})`);
  ok(r.maxAcc < DT, 'no backlog is carried from frame to frame');
  ok(r.speed > 1.5 && r.speed < 8, `it runs below the asked-for speed instead of spiralling (${r.speed.toFixed(2)}x)`);
  const rj = runSolo({ speed: 8, tickMs: 7.5, jitter: 0.25 });
  const flips = rj.steady.reduce((a, n, i) => a + (i && n !== rj.steady[i - 1] ? 1 : 0), 0);
  ok(flips <= rj.steady.length * 0.05, `25% jitter in tick cost barely changes the tick count (${flips} changes in ${rj.steady.length} frames)`);
  ok(rj.fps >= 45, `and keeps ${rj.fps.toFixed(1)} fps`);
}
{
  const r = runSolo({ speed: 8, tickMs: 7.5, stall: 100 });
  ok(Math.max(...r.per.slice(95, 110)) <= Math.max(...r.steady.slice(0, 60)), 'a 100 ms hitch is not followed by a burst of ticks');
  const slow = runSolo({ speed: 8, tickMs: 30, renderMs: 4 });
  ok(Math.min(...slow.steady) >= 1, 'a tick that costs more than the whole budget still runs once per frame');
}
{
  // a higher step never runs slower than the one below it, whatever a tick costs
  let worst = Infinity, where = '', low = Infinity;
  for (const tickMs of [2, 3, 4, 5, 6, 7, 7.5, 8, 8.5, 9, 10, 12]) {
    const r = [1, 2, 4, 8].map((speed) => runSolo({ speed, tickMs, renderMs: 3.5, jitter: 0.25 }));
    for (let k = 1; k < r.length; k++) if (r[k].speed - r[k - 1].speed < worst) { worst = r[k].speed - r[k - 1].speed; where = `${tickMs} ms, step ${k}`; }
    low = Math.min(low, r[3].fps);
  }
  ok(worst > -0.02, `each speed step runs at least as fast as the one below (worst ${worst.toFixed(3)} at ${where})`);
  ok(low >= 45, `8x keeps ${low.toFixed(1)} fps or better at every tick cost`);
}
{
  ok(tickCap(0, 15, 7.5) === 2 && tickCap(2, 15, 8) === 2 && tickCap(2, 15, 8.4) === 1 && tickCap(1, 15, 7.4) === 1 && tickCap(1, 15, 7.2) === 2, 'tick cap has hysteresis');
  ok(simBudgetMs(1.4, 0.5) > simBudgetMs(4, 0.5) && simBudgetMs(30, 5) >= 4, 'the sim budget shrinks as drawing gets dearer, with a floor');
}

// ---- co-op: two drivers over a fake link, each machine on its own timeline
function fakeWorld(tickMs, clk) {
  return {
    phase: 'planning', speed: 1, tick: 0, log: [], cfg: { sim: { dt: DT, baseSpeed: BASE } },
    step() { this.tick++; clk.now += tickMs; },
    exec(c) {
      this.log.push(this.tick + ':' + c.t + ':' + (c.s ?? '') + ':' + c.owner);
      if (c.t === 'ready') this.phase = 'battle';
      if (c.t === 'speed') this.speed = c.s;
      return { ok: true };
    },
    hash() { return (this.tick * 2654435761 + this.log.length) >>> 0; },
  };
}
function runCoop({ tickA, tickB, latencyMs = 30, seconds = 12, speed = 8 }) {
  const peers = [0, 1].map((i) => ({ clk: { now: 0 }, t: 0, inbox: [], per: [], tick: tickA }));
  peers[1].tick = tickB;
  const links = peers.map((p, i) => ({
    open: true, onMessage: null, onClose: null,
    send(m) { const q = peers[1 - i]; q.inbox.push([p.t + latencyMs, JSON.parse(JSON.stringify(m))]); return true; },
  }));
  peers.forEach((p, i) => {
    p.world = fakeWorld(p.tick, p.clk);
    p.d = new LockstepDriver(p.world, links[i], i, { clock: () => p.clk.now, hashEvery: 10 });
  });
  let issued = 0;
  while (Math.min(peers[0].t, peers[1].t) < seconds * 1000) {
    const p = peers[0].t <= peers[1].t ? peers[0] : peers[1];
    const i = peers.indexOf(p);
    while (p.inbox.length && p.inbox[0][0] <= p.t) links[i].onMessage(p.inbox.shift()[1]);
    if (i === 0 && issued === 0 && p.t > 200) { p.d.submit({ t: 'ready' }); issued = 1; }
    if (i === 1 && issued === 1 && p.t > 400) { p.d.submit({ t: 'speed', s: speed }); issued = 2; }
    p.clk.now = p.t;
    const n = p.d.advance(p.lastReal || 1 / 60, simBudgetMs(4, 0.5));
    p.clk.now += 4;
    const real = Math.max(1000 / 60, p.clk.now - p.t);
    if (p.world.phase === 'battle' && p.t > 2000) { p.per.push(n); p.ms = (p.ms || 0) + real; }
    p.lastReal = real / 1000;
    p.t += real;
  }
  const rate = (p) => p.per.reduce((a, b) => a + b, 0) / p.ms * 1000;
  return { peers, rate };
}
{
  const { peers, rate } = runCoop({ tickA: 1, tickB: 7.5 });
  const [A, B] = peers;
  ok(A.world.log.join('|') === B.world.log.join('|'), 'both peers apply every command at the same tick');
  const common = [...A.d.hashLog.keys()].filter((t) => B.d.hashLog.has(t));
  ok(common.length > 3 && common.every((t) => A.d.hashLog.get(t).h === B.d.hashLog.get(t).h), `hash checkpoints agree (${common.length})`);
  const ra = rate(A), rb = rate(B);
  ok(Math.abs(ra - rb) / rb < 0.12, `the fast peer runs at the slow peer's pace (${ra.toFixed(1)} vs ${rb.toFixed(1)} ticks per second)`);
  const zeros = A.per.filter((n) => n === 0).length / A.per.length;
  let run = 0, worst = 0;
  for (const n of A.per) { run = n ? 0 : run + 1; worst = Math.max(worst, run); }
  ok(zeros < 0.2 && worst <= 2, `the fast peer's ticks are spread out, not bursts (${(zeros * 100).toFixed(0)}% empty frames, longest gap ${worst})`);
  ok(Math.max(...A.per) <= 4, `no frame runs a burst of ticks (max ${Math.max(...A.per)})`);
  const lag = Math.abs(A.world.tick - B.world.tick);
  ok(lag <= 4 * 16, `the peers stay within the input delay of each other (${lag} ticks)`);
}
{
  const { peers, rate } = runCoop({ tickA: 0.5, tickB: 0.5, latencyMs: 80, speed: 2 });
  const [A, B] = peers;
  const nominal = 2 * BASE / DT;
  ok(Math.abs(rate(A) - nominal) / nominal < 0.06 && Math.abs(rate(B) - nominal) / nominal < 0.06, `two fast peers on a slow link still run at full speed (${rate(A).toFixed(1)} / ${rate(B).toFixed(1)}, want ${nominal} ticks per second)`);
  ok(A.world.log.join('|') === B.world.log.join('|'), 'and agree on every command');
}

console.log(fails ? `speed_pacing: ${fails} FAILED` : 'speed_pacing: all passed');
if (fails) process.exitCode = 1;
