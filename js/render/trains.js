// Decorative trains on the railways. A train's position comes from the map and the train clock alone. The clock
// follows the battle clock (world.t) and keeps running through planning, so trains pause with the game, speed
// up with it and look the same for both co-op players without any messages. Nothing here touches the simulation.
import { railNetFor, sampleAt } from './railnet.js';
import { mulberry32, hashStr } from '../util/rng.js';
import { mix } from './palette.js';

const LOCO_L = 17, COACH_L = 19.5, WAGON_L = 14, GAP = 1.2, CAR_W = 3.0;
const ACC = 0.55, DEC = 0.75;
export const MAX_TRAINS = 12;
const F_DEP = 1, F_HIDE = 2;
const PH = 6;                      // per phase: t0, s0, v0, a, dir, flags
const K_COACH = 0, K_LOCO = 1, K_CAB = 2, K_WAGON = 3;
const GLYPH_Z = 1.0;               // CSS px per metre below which a train is drawn as a segmented bar
const MAX_CARS = 14;

// ---------------------------------------------------------------- timetables

class Plan {
  constructor() { this.a = []; this.t = 0; }
  push(dur, s0, v0, acc, dir, flags) {
    if (!(dur > 1e-6)) return;
    this.a.push(this.t, s0, v0, acc, dir, flags);
    this.t += dur;
  }
  dwell(dur, s, dir, flags = 0) { this.push(dur, s, 0, 0, dir, flags); }
  // From sa to a stop at sb, entering at speed ua.
  stop(sa, sb, ua, V, dir, flags) {
    const D = Math.abs(sb - sa);
    if (D < 1e-6) return;
    const g = sb > sa ? 1 : -1;
    let vp = V;
    if ((V * V - ua * ua) / (2 * ACC) + V * V / (2 * DEC) > D) vp = Math.sqrt(Math.max(0, (2 * ACC * DEC * D + DEC * ua * ua) / (ACC + DEC)));
    if (vp < ua) { const b = ua * ua / (2 * D); this.push(ua / b, sa, g * ua, -g * b, dir, flags); return; }
    let s = sa;
    this.push((vp - ua) / ACC, s, g * ua, g * ACC, dir, flags);
    s += g * (vp * vp - ua * ua) / (2 * ACC);
    const dc = D - (vp * vp - ua * ua) / (2 * ACC) - vp * vp / (2 * DEC);
    if (dc > 1e-6) { this.push(dc / vp, s, g * vp, 0, dir, 0); s += g * dc; }
    this.push(vp / DEC, s, g * vp, -g * DEC, dir, 0);
  }
  // From sa to sb without stopping: speed up to V and hold it.
  run(sa, sb, ua, V, dir, flags) {
    const D = Math.abs(sb - sa);
    if (D < 1e-6) return;
    const g = sb > sa ? 1 : -1, da = Math.max(0, (V * V - ua * ua) / (2 * ACC));
    if (da >= D) { const v1 = Math.sqrt(ua * ua + 2 * ACC * D); this.push((v1 - ua) / ACC, sa, g * ua, g * ACC, dir, flags); return; }
    this.push((V - ua) / ACC, sa, g * ua, g * ACC, dir, flags);
    this.push((D - da) / V, sa + g * da, g * V, 0, dir, ua > 0 ? flags : 0);
  }
}

// One pass along the route: from s0 (at speed v0) through the stops to s1, ending at speed (exit) or standing (stop).
function traverse(pl, s0, v0, stops, s1, exit, V, dir, dwell, rng) {
  let s = s0, v = v0;
  for (const x of stops) {
    pl.stop(s, x, v, V, dir, v === 0 ? F_DEP : 0);
    pl.dwell(dwell + rng() * 10, x, dir);
    s = x; v = 0;
  }
  if (exit) pl.run(s, s1, v, V, dir, v === 0 ? F_DEP : 0);
  else pl.stop(s, s1, v, V, dir, v === 0 ? F_DEP : 0);
}

function consist(rng, freight) {
  const cars = [];
  let off = 0;
  const add = (k, len) => { cars.push({ k, off, len }); off += len + GAP; };
  add(K_LOCO, LOCO_L);
  const n = freight ? 6 + Math.floor(rng() * 7) : 3 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) add(freight ? K_WAGON : i === n - 1 ? K_CAB : K_COACH, freight ? WAGON_L : COACH_L);
  return { cars, len: off - GAP };
}

// Trains for every chosen route. Deterministic for a given map.
export function planTrains(map, net = railNetFor(map)) {
  const routes = net.routes || [];
  if (!routes.length) return { net, trains: [] };
  const seed = ((map.seed >>> 0) || hashStr(String(map.name || 'map'))) ^ hashStr('trains:' + routes.length);
  const rng = mulberry32(seed);
  // a branch sharing track with another route runs a single train, timed to stay off the shared stretch
  const want = routes.map(r => (r.share && r.share.length ? 1 : r.portalA && r.portalB ? Math.max(1, Math.min(3, Math.round(r.L / 1600))) : 1));
  let total = want.reduce((x, y) => x + y, 0);
  for (let i = routes.length - 1; i >= 0 && total > MAX_TRAINS; i--) while (want[i] > 1 && total > MAX_TRAINS) { want[i]--; total--; }
  for (let i = routes.length - 1; i >= 0 && total > MAX_TRAINS; i--) { total -= want[i]; want[i] = 0; }
  const svc = routes.map((route, ri) => (want[ri] ? service(route, want[ri], rng) : null));
  // routes sharing track run on one common period, so a timing that keeps them apart once keeps them apart for good
  const group = routes.map((_, i) => i);
  const root = i => (group[i] === i ? i : (group[i] = root(group[i])));
  routes.forEach((r, i) => { for (const j of r.share || []) if (svc[i] && svc[j]) group[root(i)] = root(j); });
  const period = new Map();
  svc.forEach((v, i) => { if (v) period.set(root(i), Math.max(period.get(root(i)) || 0, v.P)); });
  svc.forEach((v, i) => { if (v) v.P = period.get(root(i)); });
  const trains = [], occ = new Map();
  svc.forEach((v, ri) => {
    if (!v) return;
    const route = routes[ri];
    let phase = rng() * v.P;
    const shared = (route.share || []).length ? sharedSegs(routes, ri) : null;
    if (shared && shared.length) phase = bestPhase(v, route, shared, occ, phase);
    for (let j = 0; j < v.n; j++) {
      const tr = { route, ri, freight: v.freight, cars: v.cars, len: v.len, V: v.V, ph: v.ph, np: v.ph.length / PH, P: v.P, off: phase - j * v.headway };
      trains.push(tr);
      if ((route.share || []).length) markOcc(tr, sharedSegs(routes, ri), occ);
    }
  });
  return { net, trains };
}

// Timetable of one route: forward and back with stops at the platforms, ending on a layover that can stretch.
function service(route, n, rng) {
  const through = route.portalA && route.portalB;
  const freight = through && rng() < 0.3;
  const { cars, len } = consist(rng, freight);
  const V = freight ? 11 + rng() * 5 : 15 + rng() * 9;
  const L = route.L, headway = 70 + rng() * 40, dwell = 18;
  const centreStops = dir => {
    const out = [];
    for (const sp of route.stops) out.push(sp + dir * len / 2);
    return dir > 0 ? out : out.reverse();
  };
  const pl = new Plan();
  if (through) {
    const gap = Math.max(25 + rng() * 70, (n - 1) * headway + 30);
    const fwd = freight ? [] : centreStops(1).filter(s => s > 40 && s < L + len - 40);
    traverse(pl, -10, V, fwd, L + len + 10, true, V, 1, dwell, rng);
    pl.dwell(gap, L + len + 10, 1, F_HIDE);
    const back = freight ? [] : centreStops(-1).filter(s => s < L - 40 && s > -len + 40);
    traverse(pl, L + 10, V, back, -len - 10, true, V, -1, dwell, rng);
    pl.dwell(gap, -len - 10, -1, F_HIDE);
  } else if (route.portalA) {
    const end = L - 4;
    if (end < len + 120) return null;
    const stops = centreStops(1).filter(s => s > 40 && s < end - 40);
    traverse(pl, -10, V, stops, end, false, V, 1, dwell, rng);
    pl.dwell(30 + rng() * 25, end, 1);
    traverse(pl, end, 0, stops.slice().reverse(), -10, true, V, 1, dwell, rng);
    pl.dwell(30 + rng() * 80, -10, 1, F_HIDE);
  } else {
    const a = len + 4, b = L - 4;
    if (b - a < 120) return null;
    const stops = centreStops(1).filter(s => s > a + 40 && s < b - 40);
    traverse(pl, a, 0, stops, b, false, V, 1, dwell, rng);
    pl.dwell(30 + rng() * 25, b, 1);
    traverse(pl, b, 0, stops.slice().reverse(), a, false, V, 1, dwell, rng);
    pl.dwell(30 + rng() * 25, a, 1);
  }
  return { n: through ? n : 1, freight, cars, len, V, headway, ph: Float64Array.from(pl.a), P: pl.t };
}

// Stretches of this route's track that another chosen route also runs on: [{ e, s0, s1 }] in this route's s.
function sharedSegs(routes, ri) {
  const route = routes[ri], other = new Set();
  for (const j of route.share) for (const g of routes[j].segs) other.add(g.e);
  return route.segs.filter(g => other.has(g.e));
}

const OCC_STEP = 1;
// Seconds of the common period during which a train is on each shared stretch of track (with a margin).
function occupancy(tr, shared, phase, out) {
  const slots = Math.ceil(tr.P / OCC_STEP), st = [0, 0, 0, 0, 0];
  for (let k = 0; k < slots; k++) {
    trainAt(tr, k * OCC_STEP - phase, st);
    if (st[4] & F_HIDE) continue;
    const lo = st[1] > 0 ? st[0] - tr.len : st[0], hi = st[1] > 0 ? st[0] : st[0] + tr.len;
    for (const g of shared) {
      if (hi < g.s0 - 40 || lo > g.s1 + 40) continue;
      let a = out.get(g.e);
      if (!a) out.set(g.e, (a = new Uint8Array(slots)));
      a[k] = 1;
    }
  }
  return out;
}

function markOcc(tr, shared, occ) {
  const mine = occupancy(tr, shared, 0, new Map());
  for (const [e, a] of mine) {
    const b = occ.get(e);
    if (!b) occ.set(e, a.slice());
    else for (let k = 0; k < a.length && k < b.length; k++) b[k] |= a[k];
  }
}

function bestPhase(v, route, shared, occ, phase0) {
  const probe = { route, len: v.len, ph: v.ph, np: v.ph.length / PH, P: v.P, off: 0 };
  const mine = occupancy(probe, shared, 0, new Map());
  const slots = Math.ceil(v.P / OCC_STEP);
  let best = phase0, bestHits = Infinity;
  for (let c = 0; c < 72; c++) {
    const shift = Math.floor(((phase0 / v.P + c / 72) % 1) * slots);
    let hits = 0;
    for (const [e, a] of mine) {
      const b = occ.get(e);
      if (!b) continue;
      for (let k = 0; k < slots; k++) if (a[k] && b[(k + shift) % slots]) hits++;
    }
    if (hits < bestHits) { bestHits = hits; best = -shift * OCC_STEP; if (!hits) break; }
  }
  return best;
}

// Where a train is at clock tau: out = [s (front of the consist along the route), dir, speed, phase index, flags].
export function trainAt(tr, tau, out) {
  const ph = tr.ph, P = tr.P;
  let u = (tau + tr.off) % P;
  if (u < 0) u += P;
  let lo = 0, hi = tr.np - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ph[m * PH] <= u) lo = m; else hi = m - 1;
  }
  const b = lo * PH, du = u - ph[b];
  out[0] = ph[b + 1] + ph[b + 2] * du + 0.5 * ph[b + 3] * du * du;
  out[1] = ph[b + 4];
  out[2] = Math.abs(ph[b + 2] + ph[b + 3] * du);
  out[3] = lo;
  out[4] = ph[b + 5];
  return out;
}

const S5 = [0, 0, 0, 0, 0], PT = [0, 0, 0, 0];

// Bogie points of every car: out[base+4k..] = front x, y, back x, y. Returns the car count, or 0 when off the map.
export function carPoints(tr, tau, out, base = 0) {
  trainAt(tr, tau, S5);
  const s = S5[0], dir = S5[1], rt = tr.route, L = rt.L;
  const lo = dir > 0 ? s - tr.len : s, hi = dir > 0 ? s : s + tr.len;
  if (hi < 0 || lo > L) return 0;
  const cars = tr.cars;
  for (let k = 0; k < cars.length; k++) {
    const c = cars[k], f = s - dir * c.off, b = f - dir * c.len;
    const o = base + 4 * k;
    sampleAt(rt.p, rt.cum, f, PT); out[o] = PT[0]; out[o + 1] = PT[1];
    sampleAt(rt.p, rt.cum, b, PT); out[o + 2] = PT[0]; out[o + 3] = PT[1];
  }
  return cars.length;
}

// ---------------------------------------------------------------- clock

export class TrainClock {
  constructor() { this.tau = 0; this.lastSim = NaN; this.lastRt = NaN; this.lastTurn = NaN; this.step = 0; }
  // st: { t (world.t + extrapolation), rt (real s), turn (lockstep turn in co-op, else null), hold (menu open) }
  update(world, st) {
    const base = (world.cfg && world.cfg.sim && world.cfg.sim.baseSpeed) || 1;
    const dt = (world.cfg && world.cfg.sim && world.cfg.sim.dt) || 0.05;
    const rt = st.rt || 0, turn = st.turn;
    let d = 0;
    if (world.phase === 'planning') {
      if (turn != null && Number.isFinite(turn)) { if (Number.isFinite(this.lastTurn) && turn > this.lastTurn) d = (turn - this.lastTurn) * dt * base; }
      else if (!st.hold && Number.isFinite(this.lastRt)) d = Math.min(0.25, Math.max(0, rt - this.lastRt)) * base;
      this.lastSim = NaN;
    } else {
      const sim = Number.isFinite(st.t) ? st.t : world.t;
      // a new stage or a retry starts world.t again: carry on from here instead of jumping back
      if (Number.isFinite(this.lastSim) && sim >= this.lastSim) d = sim - this.lastSim;
      this.lastSim = sim;
    }
    this.lastRt = rt;
    this.lastTurn = turn != null ? turn : NaN;
    this.step = d;
    this.tau += d;
    return this.tau;
  }
}

// ---------------------------------------------------------------- drawing

const COLS = new Map();
function trainColours(pal) {
  let c = COLS.get(pal.name);
  if (c) return c;
  c = {
    body: pal.card, loco: pal.ink2, wagon: mix(pal.paper2, pal.ink3, 0.35), line: pal.ink, cab: pal.card,
    roof: mix(pal.ink3, pal.card, 0.2), shadow: pal.buildingShadow, halo: pal.paper, glyphCar: mix(pal.ink2, pal.paper, 0.15), glyphLoco: pal.ink,
  };
  COLS.set(pal.name, c);
  return c;
}

export class TrainLayer {
  constructor(map) {
    this.map = map;
    this.clock = new TrainClock();
    const { net, trains } = planTrains(map);
    this.net = net;
    this.trains = trains;
    this.lastIdx = new Int32Array(trains.length).fill(-1);
    this.geo = new Float64Array(MAX_TRAINS * MAX_CARS * 4);
    this.vis = new Int32Array(MAX_TRAINS * 2);
    this.bb = [0, 0, 0, 0];
    this.stats = { trains: trains.length, drawn: 0, ms: 0 };
  }

  // Car geometry for every train on screen at clock tau (no drawing); returns how many trains were placed.
  place(tau, bb, horn) {
    const trains = this.trains, geo = this.geo, vis = this.vis;
    let nv = 0;
    for (let i = 0; i < trains.length; i++) {
      const tr = trains[i];
      trainAt(tr, tau, S5);
      const idx = S5[3], flags = S5[4], s = S5[0], dir = S5[1];
      const prev = this.lastIdx[i];
      this.lastIdx[i] = idx;
      if (flags & F_HIDE) continue;
      const L = tr.route.L, lo = dir > 0 ? s - tr.len : s, hi = dir > 0 ? s : s + tr.len;
      if (hi < 0 || lo > L) continue;
      sampleAt(tr.route.p, tr.route.cum, s - dir * tr.len / 2, PT);
      const r = tr.len / 2 + 10;
      if (PT[0] + r < bb[0] || PT[0] - r > bb[2] || PT[1] + r < bb[1] || PT[1] - r > bb[3]) continue;
      const g = nv * MAX_CARS * 4, n = carPoints(tr, tau, geo, g);
      if (!n) continue;
      vis[2 * nv] = i; vis[2 * nv + 1] = n;
      nv++;
      if (horn && prev >= 0 && prev !== idx && (flags & F_DEP)) horn(geo[g], geo[g + 1]);
    }
    return nv;
  }

  // ctx in CSS px (dpr applied). st: as TrainClock.update, plus trains (false hides them) and horn(x, y).
  draw(ctx, world, cam, st, pal) {
    const tau = this.clock.update(world, st);
    if (!this.trains.length || st.trains === false) return 0;
    const z = cam.zoom, ox = cam.x, oy = cam.y;
    const bb = cam.visibleBBox(30, this.bb);
    const near = z >= 0.7 && this.clock.step > 0 && this.clock.step < 3 && st.horn;
    const nv = this.place(tau, bb, near ? st.horn : null);
    this.stats.drawn = nv;
    if (!nv) return 0;
    const c = trainColours(pal), geo = this.geo, vis = this.vis, trains = this.trains, map = this.map;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-ox * z, -oy * z, map.w * z, map.h * z);
    ctx.clip();
    ctx.lineJoin = 'miter';
    ctx.setLineDash([]);
    if (z < GLYPH_Z) this._glyphs(ctx, c, z, ox, oy, nv);
    else this._cars(ctx, c, z, ox, oy, nv);
    ctx.restore();
    return nv;
  }

  // Far out a train is an outlined light bar with a solid head and a tick at each coupling, so it stands
  // apart from the chequered line it runs on.
  _glyphs(ctx, c, z, ox, oy, nv) {
    const geo = this.geo, vis = this.vis, trains = this.trains;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let v = 0; v < nv; v++) {
      const n = vis[2 * v + 1], g = v * MAX_CARS * 4;
      ctx.moveTo((geo[g] - ox) * z, (geo[g + 1] - oy) * z);
      for (let k = 0; k < n; k++) ctx.lineTo((geo[g + 4 * k + 2] - ox) * z, (geo[g + 4 * k + 3] - oy) * z);
    }
    ctx.lineWidth = 7;
    ctx.strokeStyle = c.line;
    ctx.stroke();
    ctx.lineWidth = 4.6;
    ctx.strokeStyle = c.body;
    ctx.stroke();
    ctx.beginPath();
    for (let v = 0; v < nv; v++) {
      const tr = trains[vis[2 * v]], n = vis[2 * v + 1], g = v * MAX_CARS * 4;
      for (let k = 0; k < n; k++) {
        const fx = (geo[g + 4 * k] - ox) * z, fy = (geo[g + 4 * k + 1] - oy) * z, bx = (geo[g + 4 * k + 2] - ox) * z, by = (geo[g + 4 * k + 3] - oy) * z;
        if (tr.cars[k].k === K_LOCO) { ctx.moveTo(fx, fy); ctx.lineTo(bx, by); continue; }
        const dx = fx - bx, dy = fy - by, l = Math.hypot(dx, dy) || 1, nx = -dy / l * 2.3, ny = dx / l * 2.3;
        ctx.moveTo(fx + nx, fy + ny); ctx.lineTo(fx - nx, fy - ny);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.line;
    ctx.stroke();
    ctx.beginPath();
    for (let v = 0; v < nv; v++) {
      const tr = trains[vis[2 * v]], g = v * MAX_CARS * 4;
      if (tr.cars[0].k !== K_LOCO) continue;
      ctx.moveTo((geo[g] - ox) * z, (geo[g + 1] - oy) * z);
      ctx.lineTo((geo[g + 2] - ox) * z, (geo[g + 3] - oy) * z);
    }
    ctx.lineWidth = 4.6;
    ctx.strokeStyle = c.loco;
    ctx.stroke();
  }

  _cars(ctx, c, z, ox, oy, nv) {
    const geo = this.geo, vis = this.vis, trains = this.trains;
    const hw = Math.max(CAR_W * z, 4) / 2, sh = Math.max(1.5, Math.min(3, z * 0.8));
    const cabL = Math.max(2, 1.8 * z), cabIn = Math.max(1, 0.6 * z);
    for (let pass = 0; pass < 6; pass++) {
      ctx.beginPath();
      for (let v = 0; v < nv; v++) {
        const tr = trains[vis[2 * v]], n = vis[2 * v + 1], g0 = v * MAX_CARS * 4;
        for (let k = 0; k < n; k++) {
          const kind = tr.cars[k].k, g = g0 + 4 * k, len = tr.cars[k].len * z;
          if (pass === 0) quad(ctx, geo, g, ox, oy, z, hw, 0, 0, 1, sh);
          else if (pass === 1) { if (kind === K_COACH || kind === K_CAB) quad(ctx, geo, g, ox, oy, z, hw, 0, 0, 1, 0); }
          else if (pass === 2) { if (kind === K_WAGON) quad(ctx, geo, g, ox, oy, z, hw, 0, 0, 1, 0); }
          else if (pass === 3) { if (kind === K_LOCO) quad(ctx, geo, g, ox, oy, z, hw, 0, 0, 1, 0); }
          else if (pass === 4) quad(ctx, geo, g, ox, oy, z, hw, 0, 0, 1, 0);
          else if (kind === K_LOCO) quad(ctx, geo, g, ox, oy, z, hw, cabIn, len - cabIn - cabL, 0.62, 0);
          else if (kind === K_CAB && z >= 2) quad(ctx, geo, g, ox, oy, z, hw, len - cabIn - cabL, cabIn, 0.62, 0);
        }
      }
      if (pass === 0) { ctx.fillStyle = c.shadow; ctx.fill(); }
      else if (pass === 1) { ctx.fillStyle = c.body; ctx.fill(); }
      else if (pass === 2) { ctx.fillStyle = c.wagon; ctx.fill(); }
      else if (pass === 3) { ctx.fillStyle = c.loco; ctx.fill(); }
      else if (pass === 4) { ctx.lineWidth = 1; ctx.strokeStyle = c.line; ctx.stroke(); }
      else { ctx.fillStyle = c.cab; ctx.fill(); }
    }
    if (z < 2.2) return;
    // roof line along each coach, a cross band on each wagon
    ctx.beginPath();
    for (let v = 0; v < nv; v++) {
      const tr = trains[vis[2 * v]], n = vis[2 * v + 1], g0 = v * MAX_CARS * 4;
      for (let k = 0; k < n; k++) {
        const kind = tr.cars[k].k, g = g0 + 4 * k;
        if (kind === K_LOCO) continue;
        const fx = (geo[g] - ox) * z, fy = (geo[g + 1] - oy) * z, bx = (geo[g + 2] - ox) * z, by = (geo[g + 3] - oy) * z;
        if (kind === K_WAGON) {
          const mx = (fx + bx) / 2, my = (fy + by) / 2, l = Math.hypot(fx - bx, fy - by) || 1;
          const nx = -(fy - by) / l * hw, ny = (fx - bx) / l * hw;
          ctx.moveTo(mx + nx, my + ny); ctx.lineTo(mx - nx, my - ny);
          continue;
        }
        const e = 1.6 / tr.cars[k].len;
        ctx.moveTo(bx + (fx - bx) * e, by + (fy - by) * e);
        ctx.lineTo(fx - (fx - bx) * e, fy - (fy - by) * e);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.roof;
    ctx.stroke();
  }
}

// Outline of one car (bogie points at geo[g..g+3]) in screen px, trimmed by inset0 at the front and inset1 at the back,
// wf of the full width, shifted by sh px down and right (the offset print shadow).
function quad(ctx, geo, g, ox, oy, z, hw, inset0, inset1, wf, sh) {
  const fx = (geo[g] - ox) * z, fy = (geo[g + 1] - oy) * z, bx = (geo[g + 2] - ox) * z, by = (geo[g + 3] - oy) * z;
  let ux = fx - bx, uy = fy - by;
  const l = Math.hypot(ux, uy) || 1;
  ux /= l; uy /= l;
  const nx = -uy * hw * wf, ny = ux * hw * wf;
  const ax = bx + ux * inset1 + sh, ay = by + uy * inset1 + sh, cx = fx - ux * inset0 + sh, cy = fy - uy * inset0 + sh;
  ctx.moveTo(ax + nx, ay + ny); ctx.lineTo(cx + nx, cy + ny); ctx.lineTo(cx - nx, cy - ny); ctx.lineTo(ax - nx, ay - ny); ctx.closePath();
}
