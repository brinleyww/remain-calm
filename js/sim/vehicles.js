// Vehicles and aircraft called in by abilities: armour (APC, tank), rescue (bus, medevac), bulldozer, helicopter, gunship;
// plus the player's boats (js/sim/naval.js). Ground vehicles drive on civilian-passable cells with a windowed A*,
// boats on their own water, aircraft fly straight over everything.
// Commandable vehicles (boats, armour) follow v.order = { kind: 'move'|'hunt'|'hold'|'return', x, y, t, done } when set.
// On maps with decks ground vehicles drive over decks and through tunnels (A* over decks.js windowGraph): v.tier follows
// the path, and crushing, scratches and boarding only reach people on that tier.
import { T } from '../map/format.js';
import { clamp } from '../util/geom.js';
import { ZOMBIE, ZSUB, M_ZOMBIE, M_CIV } from './agents.js';
import { P_CIV, P_SLOW, nearestPassable, updatePassCells } from './nav.js';
import { windowGraph, localOf, nodeAt, nearestOnTier, portalOf, LV_PORTAL } from './decks.js';
import { abilityKey, nearestZombie, zombiesNear, pickDirect, pickArty, addClaim, queueShell, destroyUnit, sound, log } from './combat.js';
import { updateBoat } from './naval.js';

export const GROUND_VEHICLES = new Set(['apc', 'bus', 'bulldozer', 'tank']);
export const VEHICLE_NAMES = {
  apc: 'Armoured carrier', bus: 'Evacuation bus', medevac: 'Medevac', bulldozer: 'Bulldozer',
  tank: 'Battle tank', heli: 'Attack helicopter', gunship: 'Gunship',
  patrolBoat: 'Patrol boat', gunboat: 'Gunboat', rocketBarge: 'Rocket barge', ferry: 'Evac ferry',
};
const VEH_R = 3; // ground vehicle footprint radius (m)

// ---------------------------------------------------------------- windowed A* on the fine grid
const PF = { cap: 0, g: null, open: null, closed: null, prev: null, gen: 0, hn: new Int32Array(4096), hk: new Float32Array(4096), hs: 0 };
const MAX_WIN = 480;

function pfEnsure(n) {
  if (PF.cap >= n) return;
  const cap = Math.max(n, PF.cap * 2, 16384);
  PF.g = new Float32Array(cap); PF.open = new Uint32Array(cap); PF.closed = new Uint32Array(cap); PF.prev = new Int32Array(cap);
  PF.cap = cap; PF.gen = 0;
}

function hpush(l, k) {
  if (PF.hs >= PF.hn.length) {
    const n2 = new Int32Array(PF.hn.length * 2); n2.set(PF.hn); PF.hn = n2;
    const k2 = new Float32Array(PF.hk.length * 2); k2.set(PF.hk); PF.hk = k2;
  }
  const hn = PF.hn, hk = PF.hk;
  let i = PF.hs++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hk[p] < k || (hk[p] === k && hn[p] <= l)) break;
    hn[i] = hn[p]; hk[i] = hk[p]; i = p;
  }
  hn[i] = l; hk[i] = k;
}

function hpop() {
  const hn = PF.hn, hk = PF.hk, top = hn[0];
  const n = --PF.hs;
  if (n > 0) {
    const l = hn[n], k = hk[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (hk[c + 1] < hk[c] || (hk[c + 1] === hk[c] && hn[c + 1] < hn[c]))) c++;
      if (hk[c] > k || (hk[c] === k && hn[c] >= l)) break;
      hn[i] = hn[c]; hk[i] = hk[c]; i = c;
    }
    hn[i] = l; hk[i] = k;
  }
  return top;
}

// Nearest cell (ring search) with one of `bits` in a custom pass array, or -1.
function nearestIn(pass, g, x, y, bits, maxR) {
  const cx0 = Math.floor(x / g.cell), cy0 = Math.floor(y / g.cell);
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx > 0 && cy > 0 && cx < g.gw - 1 && cy < g.gh - 1 && pass[cy * g.gw + cx] & bits) return cy * g.gw + cx;
    }
  }
  return -1;
}

// Path of fine cells from (sx,sy) toward (tx,ty) over cells with `bits`. If the goal cannot be reached inside the search
// window/budget, returns the path to the explored cell closest to it. null when the start is boxed in.
// opt: { pass (custom passability array, default world.nav.pass), margin (window margin in cells), maxWin (cells),
// tier / goalTier (maps with decks: the start and goal tiers; the path is then of field ids, nodes included) }.
export function findPath(world, sx, sy, tx, ty, bits = P_CIV, maxExp = 40000, opt = null) {
  const g = world.grid, gw = g.gw, gh = g.gh, cs = g.cell, own = opt && opt.pass, pass = own || world.nav.pass;
  const layered = !!g.deck && !own && opt !== null;
  let s = world.cellAt(sx, sy);
  if (layered && opt.tier) { const f = s < 0 ? -1 : nodeAt(g.deck, opt.tier, s % gw, (s / gw) | 0); if (f >= 0 && (pass[f] & bits)) s = f; }
  if (s < 0 || !(pass[s] & bits)) { s = own ? nearestIn(pass, g, sx, sy, bits, 4) : nearestPassable(world, sx, sy, bits, 4); if (s < 0) return null; }
  if (s >= g.gw * g.gh) return findPathT(world, s, tx, ty, bits, maxExp, opt);
  const scx = s % gw, scy = (s / gw) | 0;
  let tcx = clamp(Math.floor(tx / cs), 1, gw - 2), tcy = clamp(Math.floor(ty / cs), 1, gh - 2);
  const M = (opt && opt.margin) || 40, MW = (opt && opt.maxWin) || MAX_WIN;
  let ox = Math.max(1, Math.min(scx, tcx) - M), oy = Math.max(1, Math.min(scy, tcy) - M);
  let ex = Math.min(gw - 2, Math.max(scx, tcx) + M), ey = Math.min(gh - 2, Math.max(scy, tcy) + M);
  if (ex - ox > MW) { if (tcx > scx) { ox = Math.max(1, scx - M); ex = Math.min(gw - 2, ox + MW); } else { ex = Math.min(gw - 2, scx + M); ox = Math.max(1, ex - MW); } }
  if (ey - oy > MW) { if (tcy > scy) { oy = Math.max(1, scy - M); ey = Math.min(gh - 2, oy + MW); } else { ey = Math.min(gh - 2, scy + M); oy = Math.max(1, ey - MW); } }
  tcx = clamp(tcx, ox, ex); tcy = clamp(tcy, oy, ey);
  const lw = ex - ox + 1, lh = ey - oy + 1;
  if (layered) { const wg = windowGraph(g.deck, ox - 1, oy - 1, lw + 2, lh + 2); if (wg) return astarT(world, wg, s, tcx, tcy, opt.goalTier | 0, bits, maxExp); }
  pfEnsure(lw * lh);
  if (++PF.gen > 0xFFFFFFF0) { PF.open.fill(0); PF.closed.fill(0); PF.gen = 1; }
  const gen = PF.gen, G = PF.g, OP = PF.open, CL = PF.closed, PR = PF.prev;
  const H = (lx, ly) => { const dx = Math.abs(lx + ox - tcx), dy = Math.abs(ly + oy - tcy); return (dx > dy ? dx + 0.4142 * dy : dy + 0.4142 * dx); };
  const l0 = (scy - oy) * lw + (scx - ox), lt = (tcy - oy) * lw + (tcx - ox);
  PF.hs = 0;
  G[l0] = 0; OP[l0] = gen; PR[l0] = -1;
  let best = l0, bestH = H(scx - ox, scy - oy);
  hpush(l0, bestH);
  let exp = 0;
  while (PF.hs > 0 && exp < maxExp) {
    const l = hpop();
    if (CL[l] === gen) continue;
    CL[l] = gen; exp++;
    if (l === lt) { best = l; break; }
    const lx = l % lw, ly = (l / lw) | 0, gc = (ly + oy) * gw + lx + ox;
    const h = H(lx, ly);
    if (h < bestH) { bestH = h; best = l; }
    const gl = G[l];
    for (let d = 0; d < 8; d++) {
      const dx = d === 0 || d === 1 || d === 7 ? 1 : d === 3 || d === 4 || d === 5 ? -1 : 0;
      const dy = d === 1 || d === 2 || d === 3 ? 1 : d === 5 || d === 6 || d === 7 ? -1 : 0;
      const nx = lx + dx, ny = ly + dy;
      if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
      const nl = ny * lw + nx;
      if (CL[nl] === gen) continue;
      const nc = gc + dy * gw + dx;
      if (!(pass[nc] & bits)) continue;
      if (dx && dy && (!(pass[gc + dx] & bits) || !(pass[gc + dy * gw] & bits))) continue;
      const step = (dx && dy ? 1.4142 : 1) * (pass[nc] & P_SLOW ? 2 : 1);
      const ng = gl + step;
      if (OP[nl] === gen && G[nl] <= ng) continue;
      OP[nl] = gen; G[nl] = ng; PR[nl] = l;
      hpush(nl, ng + H(nx, ny));
    }
  }
  if (best === l0) return new Int32Array(0);
  const out = [];
  for (let l = best; l !== l0 && l >= 0; l = PR[l]) out.push((((l / lw) | 0) + oy) * gw + (l % lw) + ox);
  out.reverse();
  return Int32Array.from(out);
}

// findPath from a deck or tunnel node s: the same window around it and the goal.
function findPathT(world, s, tx, ty, bits, maxExp, opt) {
  const g = world.grid, gw = g.gw, gh = g.gh, cs = g.cell, sc = g.deck.cell[s - g.gw * g.gh], scx = sc % gw, scy = (sc / gw) | 0;
  let tcx = clamp(Math.floor(tx / cs), 1, gw - 2), tcy = clamp(Math.floor(ty / cs), 1, gh - 2);
  const M = opt.margin || 40, MW = opt.maxWin || MAX_WIN;
  let ox = Math.max(1, Math.min(scx, tcx) - M), oy = Math.max(1, Math.min(scy, tcy) - M);
  let ex = Math.min(gw - 2, Math.max(scx, tcx) + M), ey = Math.min(gh - 2, Math.max(scy, tcy) + M);
  if (ex - ox > MW) { if (tcx > scx) { ox = Math.max(1, scx - M); ex = Math.min(gw - 2, ox + MW); } else { ex = Math.min(gw - 2, scx + M); ox = Math.max(1, ex - MW); } }
  if (ey - oy > MW) { if (tcy > scy) { oy = Math.max(1, scy - M); ey = Math.min(gh - 2, oy + MW); } else { ey = Math.min(gh - 2, scy + M); oy = Math.max(1, ey - MW); } }
  tcx = clamp(tcx, ox, ex); tcy = clamp(tcy, oy, ey);
  const wg = windowGraph(g.deck, ox - 1, oy - 1, ex - ox + 3, ey - oy + 3);
  return wg ? astarT(world, wg, s, tcx, tcy, opt.goalTier | 0, bits, maxExp) : null;
}

// A* over a window graph (its ground cells and nodes): the layered twin of the loop in findPath. Returns field ids.
function astarT(world, wg, s, tcx, tcy, gt, bits, maxExp) {
  const g = world.grid, gw = g.gw, N = g.gw * g.gh, pass = world.nav.pass, lw = wg.gw, lh = wg.gh, LN = wg.N, ox = wg.ox, oy = wg.oy;
  pfEnsure(LN + wg.D);
  if (++PF.gen > 0xFFFFFFF0) { PF.open.fill(0); PF.closed.fill(0); PF.gen = 1; }
  const gen = PF.gen, G = PF.g, OP = PF.open, CL = PF.closed, PR = PF.prev, nb = wg.nb, gid = wg.gid, wc = wg.cell;
  const H = (lx, ly) => { const dx = Math.abs(lx + ox - tcx), dy = Math.abs(ly + oy - tcy); return (dx > dy ? dx + 0.4142 * dy : dy + 0.4142 * dx); };
  const glob = (l) => (l < LN ? ((l / lw) | 0) * gw + (l % lw) + oy * gw + ox : gid[l - LN]);
  const l0 = localOf(wg, s, N, gw, ox, oy, lw, lh);
  let lt = gt ? localOf(wg, nodeAt(g.deck, gt, tcx, tcy), N, gw, ox, oy, lw, lh) : -1;
  if (lt < 0) lt = (tcy - oy) * lw + (tcx - ox);
  if (l0 < 0) return null;
  PF.hs = 0;
  G[l0] = 0; OP[l0] = gen; PR[l0] = -1;
  const xy = (l) => (l < LN ? l : wc[l - LN]);
  let best = l0, bestH = H(xy(l0) % lw, (xy(l0) / lw) | 0);
  hpush(l0, bestH);
  let exp = 0;
  const relax = (l, nl, step) => {
    if (CL[nl] === gen) return;
    const ng = G[l] + step;
    if (OP[nl] === gen && G[nl] <= ng) return;
    OP[nl] = gen; G[nl] = ng; PR[nl] = l;
    const q = xy(nl);
    hpush(nl, ng + H(q % lw, (q / lw) | 0));
  };
  while (PF.hs > 0 && exp < maxExp) {
    const l = hpop();
    if (CL[l] === gen) continue;
    CL[l] = gen; exp++;
    if (l === lt) { best = l; break; }
    const q = xy(l), lx = q % lw, ly = (q / lw) | 0;
    const h = H(lx, ly);
    if (h < bestH) { bestH = h; best = l; }
    if (l >= LN) {
      const b = 8 * (l - LN);
      for (let d = 0; d < 8; d++) {
        const nl = nb[b + d];
        if (nl < 0 || !(pass[glob(nl)] & bits)) continue;
        if (d & 1) { const a = nb[b + d - 1], c = nb[b + ((d + 1) & 7)]; if (a < 0 || c < 0 || !(pass[glob(a)] & bits) || !(pass[glob(c)] & bits)) continue; }
        relax(l, nl, (d & 1 ? 1.4142 : 1) * (nl < LN && pass[glob(nl)] & P_SLOW ? 2 : 1));
      }
      continue;
    }
    const gc = (ly + oy) * gw + lx + ox, portal = (wg.lvf[l] & LV_PORTAL) !== 0;
    for (let d = 0; d < 8; d++) {
      const dx = d === 0 || d === 1 || d === 7 ? 1 : d === 3 || d === 4 || d === 5 ? -1 : 0;
      const dy = d === 1 || d === 2 || d === 3 ? 1 : d === 5 || d === 6 || d === 7 ? -1 : 0;
      if (portal && !(d & 1)) { const pn = portalOf(wg, l, d); if (pn >= 0) { if (pass[gid[pn - LN]] & bits) relax(l, pn, 1); continue; } }
      const nx = lx + dx, ny = ly + dy;
      if (nx < 1 || ny < 1 || nx >= lw - 1 || ny >= lh - 1) continue;
      const nc = gc + dy * gw + dx;
      if (!(pass[nc] & bits)) continue;
      if (dx && dy && (!(pass[gc + dx] & bits) || !(pass[gc + dy * gw] & bits))) continue;
      relax(l, ny * lw + nx, (dx && dy ? 1.4142 : 1) * (pass[nc] & P_SLOW ? 2 : 1));
    }
  }
  if (best === l0) return new Int32Array(0);
  const out = [];
  for (let l = best; l !== l0 && l >= 0; l = PR[l]) out.push(glob(l));
  out.reverse();
  return Int32Array.from(out);
}

// Nearest point on the map edge, pushed `out` meters past it (negative = inside).
export function edgePoint(world, x, y, out = 0) {
  const W = world.map.w, Hh = world.map.h;
  const d = [x, W - x, y, Hh - y];
  let k = 0;
  for (let j = 1; j < 4; j++) if (d[j] < d[k]) k = j;
  if (k === 0) return [-out, y];
  if (k === 1) return [W + out, y];
  if (k === 2) return [x, -out];
  return [x, Hh + out];
}

// ---------------------------------------------------------------- creation / destruction
export function addVehicle(world, kind, x, y, props = {}) {
  const C = world.combat;
  const v = {
    id: props.id ?? C.nextVeh++, kind, x, y, heading: 0, hp: 0, hpMax: 0, alive: true, owner: 0, state: 'active', t0: world.t,
    tgt: -1, scanT: 0, cd: 0, path: null, pi: 0, goalX: NaN, goalY: NaN, replanAt: 0, kills: 0, offmap: false, tier: 0,
    ...props,
  };
  if (v.hpMax && !v.hp) v.hp = v.hpMax;
  world.vehicles.push(v);
  return v;
}

export function destroyVehicle(world, v, quiet = false) {
  if (!v.alive) return;
  v.alive = false;
  if (v.pickup) world.removePickup(v.pickup);
  if (v.boat) {
    // a sunk boat is a lost unit: gone for good, logged once by destroyUnit
    if (quiet) return;
    world.effects.push({ kind: 'splash', x: v.x, y: v.y, r: Math.max(12, v.len || 12), t0: world.t, dur: 1.6 });
    sound(world, 'explosion', v.x, v.y, 0.7, 2);
    if (v.unit && v.unit.alive) destroyUnit(world, v.unit, 'sunk');
    return;
  }
  if (quiet) return;
  world.effects.push({ kind: 'boom', x: v.x, y: v.y, r: 14, t0: world.t, dur: 1 });
  sound(world, 'explosion', v.x, v.y, 0.8, 1);
  log(world, `${(VEHICLE_NAMES[v.kind] || v.kind).toUpperCase()} DESTROYED`, 'warn', v.x, v.y);
}

// ---------------------------------------------------------------- movement
// gt: the goal's tier (maps with decks)
function drive(world, v, tx, ty, spd, dt, gt = 0) {
  const g = world.grid, cs = g.cell, dk = g.deck, N = g.gw * g.gh;
  if (!v.path || world.t >= v.replanAt || Math.hypot(tx - v.goalX, ty - v.goalY) > 10 || (v.goalT | 0) !== gt) {
    v.path = findPath(world, v.x, v.y, tx, ty, P_CIV, 30000, dk ? { tier: v.tier | 0, goalTier: gt } : null);
    v.pi = 0; v.goalX = tx; v.goalY = ty; v.goalT = gt; v.replanAt = world.t + 2;
  }
  const path = v.path;
  if (!path || v.pi >= path.length) return Math.hypot(tx - v.x, ty - v.y) < 5 ? 'arrived' : 'stuck';
  const c0 = world.cellAt(v.x, v.y);
  let budget = spd * dt * (c0 >= 0 && (dk === null || !v.tier) && world.nav.pass[c0] & P_SLOW ? 0.5 : 1);
  while (budget > 1e-6 && v.pi < path.length) {
    const f = path[v.pi], c = f < N ? f : dk.cell[f - N], wx = (c % g.gw + 0.5) * cs, wy = (((c / g.gw) | 0) + 0.5) * cs;
    const dx = wx - v.x, dy = wy - v.y, d = Math.hypot(dx, dy);
    if (d > 1e-3) v.heading = Math.atan2(dy, dx);
    if (d <= budget) { v.x = wx; v.y = wy; budget -= d; v.pi++; if (dk !== null) v.tier = f < N ? 0 : dk.tier[f - N]; }
    else { v.x += dx / d * budget; v.y += dy / d * budget; budget = 0; }
  }
  if (v.pi >= path.length) return Math.hypot(tx - v.x, ty - v.y) < 5 ? 'arrived' : 'end';
  return 'moving';
}

function fly(v, tx, ty, spd, dt) {
  const dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy), step = spd * dt;
  if (d > 1e-3) v.heading = Math.atan2(dy, dx);
  if (d <= step) { v.x = tx; v.y = ty; return true; }
  v.x += dx / d * step; v.y += dy / d * step;
  return false;
}

// ---------------------------------------------------------------- shared actions
function crush(world, v, r, dmg, key) {
  if (!(v.tier < 0) && !zombiesNear(world, v.x, v.y, r)) return;
  const hits = [];
  world.query(v.x, v.y, r, M_ZOMBIE, (i) => { hits.push(i); }, v.tier | 0);
  for (const i of hits) if (world.A.type[i] === ZOMBIE && world.damageAgent(i, dmg, key)) v.kills++;
}

function scratched(world, v, dt) {
  if (!(v.tier < 0) && !zombiesNear(world, v.x, v.y, VEH_R + 3)) return;
  const A = world.A, zc = world.cfg.zombie;
  const giantMul = (world.cfg.mutation.kinds.giant && world.cfg.mutation.kinds.giant.wallDpsMul) || 1;
  let n = 0;
  world.query(v.x, v.y, zc.touchRadius + VEH_R, M_ZOMBIE, (i) => { if (A.stun[i] <= 0) n += A.sub[i] === ZSUB.GIANT ? giantMul : 1; }, v.tier | 0);
  if (!n) return;
  v.hp -= zc.wallDps * dt * n;
  if (v.hp <= 0) destroyVehicle(world, v);
}

export function gunHit(world, v, t, dmg, acc, key) {
  const A = world.A;
  world.projectiles.push({ kind: 'tracer', x0: v.x, y0: v.y, x1: A.x[t], y1: A.y[t], t0: world.t, dur: 0.06, src: key });
  if (world.rng.next() < acc && world.damageAgent(t, dmg, key)) { v.kills++; return true; }
  addClaim(world, t, dmg * acc);
  return false;
}

// A vehicle gun keeps its zombie while it lives in range, else takes one the other guns have not covered.
export function gunTarget(world, v, slot, r, shot) {
  const A = world.A;
  let t = v[slot];
  if (t >= 0 && A.type[t] === ZOMBIE) { const dx = A.x[t] - v.x, dy = A.y[t] - v.y; if (dx * dx + dy * dy <= r * r) return t; }
  t = v.tier < 0 ? world.nearest(v.x, v.y, r, M_ZOMBIE, v.tier) : zombiesNear(world, v.x, v.y, r) ? pickDirect(world, v.x, v.y, r, shot) : -1;
  v[slot] = t;
  return t;
}

const SHELL_W = { r: 10, dmg: 0, n: 1, spread: 0, speed: 260, kind: 0, minC: 1, ox: 0, oy: 0 };
export function shellAim(world, v, x, y, minR, maxR, r, dmg, speed) {
  const W = SHELL_W;
  W.r = r; W.dmg = dmg; W.speed = speed; W.ox = v.x; W.oy = v.y;
  return pickArty(world, x, y, minR, maxR, W);
}

export function cannon(world, v, x, y, dmg, splash, speed, key) {
  const ff = world.cfg.friendlyFire, dur = Math.hypot(x - v.x, y - v.y) / speed;
  world.projectiles.push({ kind: 'shell', x0: v.x, y0: v.y, x1: x, y1: y, t0: world.t, dur, src: key });
  queueShell(world, x, y, dur, {
    r: splash, dmg, src: key, friendly: !!ff.auto, bldgDmg: dmg * ff.autoStructureMul, bridgeDmg: dmg * ff.autoStructureMul,
    wallDmg: dmg * ff.autoStructureMul, fx: 'boom', u: v,
  });
}

export function loadCivs(world, v, a, dt) {
  v.acc = Math.min((v.acc || 0) + a.loadPerSec * dt, 3);
  let got = false;
  while (v.acc >= 1 && v.loaded < a.capacity) {
    const i = world.nearest(v.x, v.y, a.loadRadius, M_CIV, v.tier | 0);
    if (i < 0) break;
    if (!world.evacuate(i)) break;
    v.loaded++; v.acc -= 1; v.lastLoad = world.t; got = true;
  }
  if (!got && v.acc > 1) v.acc = 1;
  return v.loaded >= a.capacity || (world.t - v.lastLoad > 20 && world.t - v.t0 > 30);
}

function clearRubble(world, x, y, r) {
  const g = world.grid, cs = g.cell, terr = g.terrain, t0 = world.terrain0, changed = [];
  const x0 = Math.max(1, Math.floor((x - r) / cs)), x1 = Math.min(g.gw - 2, Math.floor((x + r) / cs));
  const y0 = Math.max(1, Math.floor((y - r) / cs)), y1 = Math.min(g.gh - 2, Math.floor((y + r) / cs));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const c = cy * g.gw + cx;
    if (terr[c] !== T.RUBBLE) continue;
    const dx = (cx + 0.5) * cs - x, dy = (cy + 0.5) * cs - y;
    if (dx * dx + dy * dy > r * r) continue;
    const o = t0[c];
    terr[c] = o === T.BLDG || o === T.RUBBLE ? T.OPEN : o;
    changed.push(c);
  }
  if (changed.length) { updatePassCells(world, changed); world.combat.cleared = (world.combat.cleared || 0) + changed.length; }
}

// ---------------------------------------------------------------- per kind
const ORDER_KINDS = new Set(['move', 'hunt', 'hold', 'return']);

// The order armour is following, or null once it has none (a finished return hands back to the patrol).
function armourOrder(v) {
  const o = v.order;
  return o && ORDER_KINDS.has(o.kind) && !(o.kind === 'return' && o.done) ? o : null;
}

// Nearest zombie for a vehicle: anyone above ground, or along its own tunnel.
function vehZombie(world, v, x, y, r) {
  return v.tier < 0 ? (world.counts[ZOMBIE] > 0 ? world.nearest(x, y, r, M_ZOMBIE, v.tier) : -1) : nearestZombie(world, x, y, r);
}

function updateArmour(world, v, dt) {
  const a = v.cfg, A = world.A, tank = v.kind === 'tank', key = v.key;
  if (tank) v.cd -= dt;
  v.mgCd = (v.mgCd || 0) - dt;
  const leash = a.leash || world.cfg.armed.pursueLeash || 300, o = armourOrder(v);
  if (world.t >= v.scanT) {
    v.scanT = world.t + 0.4;
    let t;
    if (o) t = vehZombie(world, v, v.x, v.y, o.kind === 'hunt' ? 600 : a.range);
    else {
      t = vehZombie(world, v, v.x, v.y, Math.max(a.range * 1.6, 150));
      if (t < 0 || Math.hypot(A.x[t] - v.hx, A.y[t] - v.hy) > leash) t = vehZombie(world, v, v.hx, v.hy, leash);
    }
    v.tgt = t;
  }
  let t = v.tgt, d = Infinity;
  if (t >= 0 && A.type[t] !== ZOMBIE) { t = v.tgt = -1; v.scanT = 0; }
  if (o) {
    if (o.kind === 'move' && !o.done) {
      if (v._oRef !== o) { v._oRef = o; v._og = Number.isFinite(+o.x) && Number.isFinite(+o.y) ? goalOn(world, +o.x, +o.y, o.tier | 0) : null; }
      if (!v._og || drive(world, v, v._og[0], v._og[1], a.speed, dt, v._og[2]) !== 'moving') o.done = true;
    } else if (o.kind === 'return') {
      if (drive(world, v, v.hx, v.hy, a.speed, dt, v.ht | 0) !== 'moving') o.done = true;
    } else if (o.kind === 'hunt') {
      if (t >= 0 && Math.hypot(A.x[t] - v.x, A.y[t] - v.y) > a.range * 0.75) drive(world, v, A.x[t], A.y[t], a.speed, dt, A.tier[t]);
    } else if (o.kind === 'hold') o.done = true;
  } else if (t >= 0) {
    d = Math.hypot(A.x[t] - v.x, A.y[t] - v.y);
    if (d > a.range * 0.75) drive(world, v, A.x[t], A.y[t], a.speed, dt, A.tier[t]);
  } else if (Math.hypot(v.hx - v.x, v.hy - v.y) > 6) drive(world, v, v.hx, v.hy, a.speed, dt, v.ht | 0);
  if (tank) {
    if (t >= 0 && v.cd <= 0 && !(v.tier < 0)) {
      const aim = shellAim(world, v, v.x, v.y, (a.splash || 10) + 4, a.range, a.splash || 10, a.dmg, 260);
      if (aim) {
        cannon(world, v, aim[0], aim[1], a.dmg, a.splash || 10, 260, key);
        v.cd = a.rof;
        sound(world, 'thump', v.x, v.y, 0.7, 4);
      } else v.cd = 0.3;
    }
    if (v.mgCd <= 0) {
      const m = gunTarget(world, v, 'mgT', a.mgRange, a.mgDmg * 0.8);
      if (m >= 0) { gunHit(world, v, m, a.mgDmg, 0.8, key); v.mgCd += a.mgRof; world.combat.shotN++; }
      if (v.mgCd < 0) v.mgCd = 0;
    }
    if ((world.tick & 1) === 0) crush(world, v, VEH_R + 1, (a.crushDps || 0) * dt * 2, key);
  } else if (v.mgCd <= 0) {
    const m = gunTarget(world, v, 'mgT', a.range, a.dmg * 0.8);
    if (m >= 0) { gunHit(world, v, m, a.dmg, 0.8, key); v.mgCd += a.rof; world.combat.shotN++; }
    if (v.mgCd < 0) v.mgCd = 0;
  }
}

function updateBus(world, v, dt) {
  const a = v.cfg;
  if (v.state === 'load') {
    if (loadCivs(world, v, a, dt)) {
      world.removePickup(v.pickup); v.pickup = null;
      v.state = 'leave'; v.leaveT = world.t;
      [v.gx, v.gy] = edgePoint(world, v.x, v.y, -6);
      log(world, `BUS DEPARTING WITH ${v.loaded} ABOARD`, 'info', v.x, v.y);
    }
    return;
  }
  const r = drive(world, v, v.gx, v.gy, a.speed, dt);
  if (r !== 'moving' || world.t - v.leaveT > 90) destroyVehicle(world, v, true);
}

function updateMedevac(world, v, dt) {
  const a = v.cfg;
  if (v.state === 'inbound') { if (fly(v, v.lx, v.ly, a.speed, dt)) { v.state = 'load'; v.t0 = world.t; v.lastLoad = world.t; } return; }
  if (v.state === 'load') {
    if (loadCivs(world, v, a, dt)) {
      world.removePickup(v.pickup); v.pickup = null;
      v.state = 'leave';
      [v.gx, v.gy] = edgePoint(world, v.x, v.y, 80);
      log(world, `MEDEVAC AIRBORNE WITH ${v.loaded} ABOARD`, 'info', v.x, v.y);
    }
    return;
  }
  if (fly(v, v.gx, v.gy, a.speed, dt)) destroyVehicle(world, v, true);
}

function updateDozer(world, v, dt) {
  const a = v.cfg, key = v.key, g = world.grid, half = (a.width || 8) * 0.5;
  if (v.state === 'done') { if (world.t >= v.doneAt + 4) destroyVehicle(world, v, true); return; }
  const ux = v.ux, uy = v.uy;
  v.heading = Math.atan2(uy, ux);
  const px = v.x + ux * (half + 1), py = v.y + uy * (half + 1);
  let blockB = -1, wet = false, out = false;
  for (let k = -1; k <= 1 && blockB < 0; k++) {
    const qx = px - uy * half * 0.8 * k, qy = py + ux * half * 0.8 * k, c = world.cellAt(qx, qy);
    if (c < 0 || !world.region.mask[c]) { out = true; continue; }
    const tt = g.terrain[c];
    if (tt === T.BLDG) { const b = g.bldg[c] - 1; if (b >= 0 && world.buildings[b].alive) blockB = b; }
    else if (tt === T.WATER && k === 0) wet = true;
  }
  if (blockB >= 0) world.damageBuilding(blockB, (a.crushDps || 30) * 20 * dt, key, ux, uy);
  else if (wet || out) { v.state = 'done'; v.doneAt = world.t; }
  else {
    const step = Math.min(a.speed * dt, v.len - v.dist);
    v.x += ux * step; v.y += uy * step; v.dist += step;
    if (v.dist >= v.len - 1e-6) { v.state = 'done'; v.doneAt = world.t; }
  }
  if ((world.tick & 3) === 0) clearRubble(world, v.x + ux * 2, v.y + uy * 2, half + 1);
  if ((world.tick & 1) === 0) crush(world, v, half + 1.5, (a.crushDps || 30) * dt * 2, key);
}

function updateHeli(world, v, dt) {
  const a = v.cfg, A = world.A, key = v.key;
  if (v.state === 'inbound' || v.state === 'return') {
    if (fly(v, v.sx, v.sy, v.state === 'inbound' ? v.tspd : a.speed, dt)) { v.state = 'hunt'; v.offmap = false; }
    return;
  }
  if (v.state === 'rtb') { if (fly(v, v.gx, v.gy, a.speed, dt)) { v.state = 'rearm'; v.until = world.t + a.rearmSec; v.offmap = true; } return; }
  if (v.state === 'rearm') {
    if (world.t >= v.until) { v.ammo = a.ammo; v.state = 'return'; v.offmap = false; log(world, 'HELICOPTER REARMED, RETURNING', 'info', v.sx, v.sy); }
    return;
  }
  v.cd -= dt;
  if (world.t >= v.scanT) {
    v.scanT = world.t + 0.3;
    let t = v.tgt;
    if (!(t >= 0 && A.type[t] === ZOMBIE && Math.hypot(A.x[t] - v.x, A.y[t] - v.y) <= a.range)) {
      t = zombiesNear(world, v.x, v.y, a.range) ? pickDirect(world, v.x, v.y, a.range, a.dmg * 0.85) : -1;
      if (t < 0 || Math.hypot(A.x[t] - v.sx, A.y[t] - v.sy) > a.huntRadius) t = nearestZombie(world, v.x, v.y, a.huntRadius);
      if (t >= 0 && Math.hypot(A.x[t] - v.sx, A.y[t] - v.sy) > a.huntRadius) t = nearestZombie(world, v.sx, v.sy, a.huntRadius);
    }
    v.tgt = t;
  }
  let t = v.tgt;
  if (t >= 0 && A.type[t] !== ZOMBIE) { t = v.tgt = -1; v.scanT = 0; }
  if (t < 0) {
    v.hover = (v.hover || 0) + dt * 0.4;
    fly(v, v.sx + Math.cos(v.hover) * 30, v.sy + Math.sin(v.hover) * 30, a.speed * 0.4, dt);
    return;
  }
  const d = Math.hypot(A.x[t] - v.x, A.y[t] - v.y);
  if (d > a.range * 0.6) fly(v, A.x[t], A.y[t], a.speed, dt);
  let shots = 0;
  while (v.cd <= 0 && v.ammo > 0 && d <= a.range && shots < 4 && A.type[t] === ZOMBIE) {
    shots++; v.ammo--; v.cd += a.rof;
    if (gunHit(world, v, t, a.dmg, 0.85, key)) { v.tgt = -1; v.scanT = 0; break; }
  }
  if (v.cd < 0) v.cd = 0;
  if (shots) world.combat.shotN += shots;
  if (v.ammo <= 0) {
    v.state = 'rtb';
    [v.gx, v.gy] = edgePoint(world, v.x, v.y, 60);
    log(world, 'HELICOPTER OUT OF AMMUNITION, REARMING', 'info', v.x, v.y);
  }
}

function updateGunship(world, v, dt) {
  const a = v.cfg, A = world.A, key = v.key, R = a.orbitR, ff = world.cfg.friendlyFire;
  if (v.state === 'inbound') {
    if (fly(v, v.cx + Math.cos(v.ang) * R, v.cy + Math.sin(v.ang) * R, v.tspd, dt)) { v.state = 'orbit'; v.until = world.t + a.sec; }
    return;
  }
  if (v.state === 'leave') { if (fly(v, v.gx, v.gy, 70, dt)) destroyVehicle(world, v, true); return; }
  v.ang += 55 / R * dt;
  v.x = v.cx + Math.cos(v.ang) * R; v.y = v.cy + Math.sin(v.ang) * R; v.heading = v.ang + Math.PI / 2;
  v.bigCd -= dt; v.smallCd -= dt;
  if (v.bigCd <= 0) {
    const aim = shellAim(world, v, v.cx, v.cy, 0, R, a.bigSplash, a.bigDmg, 500);
    if (aim) {
      const dur = Math.hypot(aim[0] - v.x, aim[1] - v.y) / 500;
      world.projectiles.push({ kind: 'shell', x0: v.x, y0: v.y, x1: aim[0], y1: aim[1], t0: world.t, dur, src: key });
      queueShell(world, aim[0], aim[1], dur, { r: a.bigSplash, dmg: a.bigDmg, src: key, friendly: !!ff.auto, wallDmg: a.bigDmg * ff.autoStructureMul,
        bldgDmg: a.bigDmg * ff.autoStructureMul, fx: 'boom', u: v });
      v.bigCd = a.bigRof;
      sound(world, 'thump', v.x, v.y, 0.6, 6);
    } else v.bigCd = 0.4;
  }
  if (v.smallCd <= 0) {
    const ang = world.rng.next() * Math.PI * 2, rr = world.rng.next() * R * 0.6;
    const t = pickDirect(world, v.cx + Math.cos(ang) * rr, v.cy + Math.sin(ang) * rr, R, a.smallDmg);
    if (t >= 0 && Math.hypot(A.x[t] - v.cx, A.y[t] - v.cy) <= R * 1.1) {
      const dur = Math.hypot(A.x[t] - v.x, A.y[t] - v.y) / 700;
      world.projectiles.push({ kind: 'shell', x0: v.x, y0: v.y, x1: A.x[t], y1: A.y[t], t0: world.t, dur, src: key });
      queueShell(world, A.x[t], A.y[t], dur, { r: a.smallSplash, dmg: a.smallDmg, src: key, friendly: !!ff.auto, wallDmg: a.smallDmg * ff.autoStructureMul, fx: 'boom', u: v });
      addClaim(world, t, a.smallDmg);
      v.smallCd = a.smallRof;
    } else v.smallCd = 0.3;
  }
  if (world.t >= v.until) {
    v.state = 'leave';
    [v.gx, v.gy] = edgePoint(world, v.x, v.y, 120);
    log(world, 'GUNSHIP LEAVING THE AREA', 'info', v.x, v.y);
  }
}

// ---------------------------------------------------------------- system
export function vehicleSystem(world, dt) {
  const list = world.vehicles;
  if (!list.length) return;
  const even = (world.tick & 1) === 0;
  for (let k = 0; k < list.length; k++) {
    const v = list[k];
    if (!v.alive) continue;
    if (v.boat) { if (updateBoat(world, v, dt)) destroyVehicle(world, v); continue; }
    switch (v.kind) {
      case 'apc': case 'tank': updateArmour(world, v, dt); break;
      case 'bus': updateBus(world, v, dt); break;
      case 'medevac': updateMedevac(world, v, dt); break;
      case 'bulldozer': updateDozer(world, v, dt); break;
      case 'heli': updateHeli(world, v, dt); break;
      case 'gunship': updateGunship(world, v, dt); break;
      default: break;
    }
    if (v.alive && even && GROUND_VEHICLES.has(v.kind) && v.hpMax > 0) scratched(world, v, dt * 2);
  }
  let w = 0;
  for (let k = 0; k < list.length; k++) if (list[k].alive) list[w++] = list[k];
  list.length = w;
}

// Spawners used by abilities. (x, y) is already a valid target.
export function spawnArmour(world, kind, a, x, y, owner, tier = 0) {
  const v = addVehicle(world, kind, x, y, { cfg: a, hpMax: a.hp, owner, hx: x, hy: y, key: abilityKey(kind), mgCd: 0,
    commandable: true, selR: kind === 'tank' ? 7 : 6, label: VEHICLE_NAMES[kind] || kind, tier, ht: tier });
  world.effects.push({ kind: 'drop', x, y, r: 10, t0: world.t, dur: 1 });
  return v;
}

export function spawnBus(world, a, x, y, owner) {
  const tier = world.surfaceAt(x, y);
  const v = addVehicle(world, 'bus', x, y, { cfg: a, hpMax: a.hp, owner, state: 'load', loaded: 0, acc: 0, lastLoad: world.t, key: abilityKey('bus'), tier });
  v.pickup = 'bus' + v.id;
  world.addPickup(v.pickup, x, y, Math.min(a.loadRadius * 0.6, 15), tier);
  return v;
}

export function spawnMedevac(world, a, x, y, owner) {
  const [sx, sy] = edgePoint(world, x, y, 80);
  const tier = world.surfaceAt(x, y);
  const v = addVehicle(world, 'medevac', sx, sy, { cfg: a, owner, state: 'inbound', lx: x, ly: y, loaded: 0, acc: 0, lastLoad: world.t, key: abilityKey('medevac'), tier });
  v.heading = Math.atan2(y - sy, x - sx);
  v.pickup = 'medevac' + v.id;
  world.addPickup(v.pickup, x, y, Math.min(a.loadRadius * 0.6, 15), tier);
  return v;
}

export function spawnDozer(world, a, x0, y0, x1, y1, owner) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1;
  return addVehicle(world, 'bulldozer', x0, y0, {
    cfg: a, hpMax: a.hp, owner, state: 'drive', ux: (x1 - x0) / L, uy: (y1 - y0) / L, len: L, dist: 0, key: abilityKey('bulldozer'),
    x0, y0, x1, y1, heading: Math.atan2(y1 - y0, x1 - x0),
  });
}

// Aircraft enter from the nearest map edge and reach the target exactly `delay` seconds after the call.
function inboundStart(world, x, y, speed, delay) {
  const [ex, ey] = edgePoint(world, x, y, 100);
  const d = Math.hypot(x - ex, y - ey);
  return { sx: ex, sy: ey, tspd: Math.max(speed, delay > 0 ? d / delay : speed) };
}

export function spawnHeli(world, a, x, y, owner) {
  const s = inboundStart(world, x, y, a.speed, a.delay);
  return addVehicle(world, 'heli', s.sx, s.sy, { cfg: a, owner, state: 'inbound', sx: x, sy: y, tspd: s.tspd, ammo: a.ammo, key: abilityKey('helicopter'),
    heading: Math.atan2(y - s.sy, x - s.sx) });
}

export function spawnGunship(world, a, x, y, owner) {
  const [ex, ey] = edgePoint(world, x, y, 100);
  const ang = Math.atan2(ey - y, ex - x);
  const ix = x + Math.cos(ang) * a.orbitR, iy = y + Math.sin(ang) * a.orbitR;
  const d = Math.hypot(ix - ex, iy - ey);
  return addVehicle(world, 'gunship', ex, ey, {
    cfg: a, owner, state: 'inbound', cx: x, cy: y, ang, tspd: Math.max(55, a.delay > 0 ? d / a.delay : 55),
    bigCd: 0, smallCd: 0, until: Infinity, key: abilityKey('gunship'), heading: Math.atan2(iy - ey, ix - ex),
  });
}

// Where a vehicle ordered to (x, y) on tier t drives to: [x, y, tier] of the nearest open cell on that tier, else on the ground.
function goalOn(world, x, y, t) {
  const g = world.grid, f = t ? nearestOnTier(world, x, y, t, P_CIV, 0, 20) : -1;
  if (f >= 0) { const c = g.deck.cell[f - g.gw * g.gh]; return [(c % g.gw + 0.5) * g.cell, (((c / g.gw) | 0) + 0.5) * g.cell, t]; }
  const s = landingCell(world, x, y, 20);
  return s ? [s[0], s[1], 0] : [x, y, 0];
}

export function landingCell(world, x, y, maxCells = 12) {
  const c = nearestPassable(world, x, y, P_CIV, maxCells);
  if (c < 0) return null;
  const g = world.grid;
  return [(c % g.gw + 0.5) * g.cell, (((c / g.gw) | 0) + 0.5) * g.cell];
}
