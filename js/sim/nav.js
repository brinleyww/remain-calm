// Passability, per-cell costs and flow fields (Dial's bucket-queue Dijkstra on typed arrays).
// All fields live on the fine grid; the coarse grid (sim.coarse) is only used for fire and broadcast masks.
// Field encoding: dist (Uint32, INF unreachable), dir (Uint8: 0..7 = step toward the target, 8 = target cell, 255 = unreachable).
import { T } from '../map/format.js';

export const P_IN = 1, P_CIV = 2, P_ZOM = 4, P_SWIM = 8, P_SLOW = 16, P_WALL = 32, P_GATE = 64, P_WATER = 128;
export const INF = 0xFFFFFFFF;
export const DX = Int8Array.of(1, 1, 0, -1, -1, -1, 0, 1);
export const DY = Int8Array.of(0, 1, 1, 1, 0, -1, -1, -1);

const WALK = new Uint8Array(16);
WALK[T.OPEN] = 1; WALK[T.ROAD] = 1; WALK[T.PARK] = 1; WALK[T.BRIDGE] = 1; WALK[T.RUBBLE] = 1; WALK[T.RAIL] = 1;
export function isWalkTerrain(t) { return WALK[t] === 1; }

export class DialJob {
  constructor(N, gw) {
    this.N = N; this.gw = gw;
    this.dist = new Uint32Array(N);
    this.dir = new Uint8Array(N);
    this.nb = 0; this.mask = 0; this.buckets = [];
    this.cost = null; this.cur = 0; this.pending = 0; this.active = false; this.maxD = INF;
    this.dist.fill(INF); this.dir.fill(255);
  }

  begin(cost, maxCost, maxD = INF) {
    let nb = 64;
    while (nb < 14 * maxCost + 1) nb <<= 1;
    if (nb !== this.nb) { this.nb = nb; this.mask = nb - 1; this.buckets = []; for (let i = 0; i < nb; i++) this.buckets.push([]); }
    else for (const b of this.buckets) b.length = 0;
    this.dist.fill(INF); this.dir.fill(255);
    this.cost = cost; this.cur = 0; this.pending = 0; this.active = true; this.maxD = maxD;
  }

  source(c) {
    if (c < 0 || c >= this.N || this.dist[c] === 0) return;
    this.dist[c] = 0; this.dir[c] = 8; this.buckets[0].push(c); this.pending++;
  }

  // Expands up to `budget` cells. Returns true once finished. Border cells must have cost 0 (no bounds checks).
  run(budget) {
    if (!this.active) return true;
    const dist = this.dist, dir = this.dir, cost = this.cost, buckets = this.buckets, mask = this.mask, gw = this.gw, maxD = this.maxD;
    let cur = this.cur, pending = this.pending;
    while (pending > 0 && budget > 0) {
      const bk = buckets[cur & mask];
      if (bk.length === 0) { cur++; if (cur > maxD) { for (const b of buckets) b.length = 0; pending = 0; break; } continue; }
      const c = bk.pop(); pending--;
      if (dist[c] !== cur) continue;
      budget--;
      const ce = cost[c + 1], cw = cost[c - 1], cs = cost[c + gw], cn = cost[c - gw];
      let nd;
      if (ce) { nd = cur + 10 * ce; if (nd < dist[c + 1]) { dist[c + 1] = nd; dir[c + 1] = 4; buckets[nd & mask].push(c + 1); pending++; } }
      if (cw) { nd = cur + 10 * cw; if (nd < dist[c - 1]) { dist[c - 1] = nd; dir[c - 1] = 0; buckets[nd & mask].push(c - 1); pending++; } }
      if (cs) { nd = cur + 10 * cs; if (nd < dist[c + gw]) { dist[c + gw] = nd; dir[c + gw] = 6; buckets[nd & mask].push(c + gw); pending++; } }
      if (cn) { nd = cur + 10 * cn; if (nd < dist[c - gw]) { dist[c - gw] = nd; dir[c - gw] = 2; buckets[nd & mask].push(c - gw); pending++; } }
      let n, k;
      if (ce && cs) { n = c + gw + 1; k = cost[n]; if (k) { nd = cur + 14 * k; if (nd < dist[n]) { dist[n] = nd; dir[n] = 5; buckets[nd & mask].push(n); pending++; } } }
      if (cw && cs) { n = c + gw - 1; k = cost[n]; if (k) { nd = cur + 14 * k; if (nd < dist[n]) { dist[n] = nd; dir[n] = 7; buckets[nd & mask].push(n); pending++; } } }
      if (cw && cn) { n = c - gw - 1; k = cost[n]; if (k) { nd = cur + 14 * k; if (nd < dist[n]) { dist[n] = nd; dir[n] = 1; buckets[nd & mask].push(n); pending++; } } }
      if (ce && cn) { n = c - gw + 1; k = cost[n]; if (k) { nd = cur + 14 * k; if (nd < dist[n]) { dist[n] = nd; dir[n] = 3; buckets[nd & mask].push(n); pending++; } } }
    }
    this.cur = cur; this.pending = pending;
    if (pending === 0) { this.active = false; return true; }
    return false;
  }
}

function makeField(N, gw) { return { dist: new Uint32Array(N).fill(INF), dir: new Uint8Array(N).fill(255), job: new DialJob(N, gw), dirty: true, last: -1e9, ready: false }; }

function swap(f) {
  const d = f.dist, r = f.dir;
  f.dist = f.job.dist; f.dir = f.job.dir;
  f.job.dist = d; f.job.dir = r;
  f.ready = true;
}

export function initNav(world) {
  const g = world.grid, cfg = world.cfg;
  const N = g.gw * g.gh;
  const R = Math.max(1, Math.round((cfg.sim.coarse || 8) / g.cell));
  const cgw = Math.ceil(g.gw / R), cgh = Math.ceil(g.gh / R);
  const cN = cgw * cgh;
  world.nav = {
    R, cgw, cgh, cN, ccell: R * g.cell,
    pass: new Uint8Array(N), civCost: new Uint8Array(N), zCost: new Uint8Array(N), sCost: new Uint8Array(N),
    civ: makeField(N, g.gw), scent: makeField(N, g.gw), swim: null,
    version: 0, regionCells: 1, swimmers: 0, k: costConsts(cfg),
    corrFields: [],
  };
}

function costConsts(cfg) {
  const sc = cfg.scent, n = (v) => Math.max(1, Math.min(255, v | 0));
  return { wall: n(sc.wallCost), gate: n(sc.gateCost), rubble: n(sc.rubbleCost), park: n(sc.parkCost), water: n(sc.waterCostSwimmer) };
}

// Swimmer field memory is only spent once a swimmer exists.
export function swimField(world) {
  const nav = world.nav;
  if (!nav.swim) nav.swim = makeField(nav.pass.length, world.grid.gw);
  return nav.swim;
}

export function passOf(world, c) {
  const g = world.grid, gw = g.gw, X = c % gw, Y = (c / gw) | 0;
  if (X === 0 || Y === 0 || X === gw - 1 || Y === g.gh - 1) return 0;
  if (!world.region.mask[c]) return 0;
  const t = g.terrain[c];
  let p = P_IN;
  if (t === T.RUBBLE) p |= P_SLOW;
  if (t === T.WATER) p |= P_WATER;
  const blk = world.block[c];
  const intact = blk !== 0 && world.wallHp[c] > 0;
  if (WALK[t]) {
    if (intact) p |= blk === 3 ? (P_GATE | P_CIV) : P_WALL;
    else p |= P_CIV | P_ZOM | P_SWIM;
  } else if (t === T.WATER && !intact) p |= P_SWIM;
  return p;
}

// Writes pass bits and the three traversal costs (civilian, zombie, swimmer; 0 = blocked) of one cell.
function setCell(nav, terrain, c, p) {
  const k = nav.k;
  nav.pass[c] = p;
  const land = (p & P_SLOW) ? k.rubble : terrain[c] === T.PARK ? k.park : 1;
  nav.civCost[c] = (p & P_CIV) ? ((p & P_SLOW) ? k.rubble : 1) : 0;
  const barrier = (p & P_WALL) ? k.wall : (p & P_GATE) ? k.gate : 0;
  nav.zCost[c] = barrier || ((p & P_ZOM) ? land : 0);
  nav.sCost[c] = barrier || ((p & P_SWIM) ? ((p & P_WATER) ? k.water : land) : 0);
}

// Full recompute (stage begin / restore).
export function rebuildPass(world) {
  const nav = world.nav, N = nav.pass.length, mask = world.region.mask, terr = world.grid.terrain;
  let rc = 0;
  for (let c = 0; c < N; c++) {
    setCell(nav, terr, c, passOf(world, c));
    if (mask[c]) rc++;
  }
  nav.regionCells = Math.max(1, rc);
  touchNav(world);
}

// Recompute a list of fine cells (iterable) after terrain/wall changes.
export function updatePassCells(world, cells) {
  const nav = world.nav, terr = world.grid.terrain;
  let changed = false;
  for (const c of cells) {
    const p = passOf(world, c);
    if (p !== nav.pass[c] || terr[c] === T.WATER) { setCell(nav, terr, c, p); changed = true; }
  }
  if (changed) touchNav(world);
  return changed;
}

export function touchNav(world) {
  const nav = world.nav;
  nav.version++;
  nav.civ.dirty = true;
  for (const f of nav.corrFields) if (f) f.stale = true;
}

function startCivField(world) {
  const nav = world.nav, f = nav.civ, job = f.job, cfg = world.cfg;
  job.begin(nav.civCost, Math.max(1, cfg.scent.rubbleCost | 0), Math.ceil(cfg.civ.seekMaxPath / world.grid.cell * 10));
  const zz = world.zones;
  if (zz) for (const comp of zz.comps) {
    if (comp.breached) continue;
    const ic = comp.interiorCells;
    for (let k = 0; k < ic.length; k++) if (nav.civCost[ic[k]]) job.source(ic[k]);
  }
  const g = world.grid, cs = g.cell;
  for (const pk of world.pickups) {
    const r = Math.min(Math.max(pk.r, cs), 24);
    const x0 = Math.max(1, Math.floor((pk.x - r) / cs)), x1 = Math.min(g.gw - 2, Math.floor((pk.x + r) / cs));
    const y0 = Math.max(1, Math.floor((pk.y - r) / cs)), y1 = Math.min(g.gh - 2, Math.floor((pk.y + r) / cs));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = y * g.gw + x, dx = (x + 0.5) * cs - pk.x, dy = (y + 0.5) * cs - pk.y;
      if (dx * dx + dy * dy <= r * r && nav.civCost[c]) job.source(c);
    }
    pk.fx = pk.x; pk.fy = pk.y;
  }
  f.dirty = false;
  f.last = world.t;
}

function startScent(world, f, cost) {
  const nav = world.nav, k = nav.k, job = f.job, A = world.A;
  job.begin(cost, Math.max(k.wall, k.gate, k.rubble, k.water, k.park));
  const g = world.grid, inv = 1 / g.cell, gw = g.gw, gh = g.gh;
  const type = A.type, X = A.x, Y = A.y;
  for (let i = 0, n = A.n; i < n; i++) {
    const t = type[i];
    if (t === 1 || t >= 4) {
      const cx = (X[i] * inv) | 0, cy = (Y[i] * inv) | 0;
      if (cx > 0 && cy > 0 && cx < gw - 1 && cy < gh - 1) job.source(cy * gw + cx);
    }
  }
  f.dirty = false;
  f.last = world.t;
}

// Big stages refresh the zombie fields less often so the amortised cost stays flat.
function scentEvery(world) {
  return Math.max(world.cfg.sim.scentEvery || 1, world.nav.regionCells / 200000);
}

// Computes every field synchronously (READY, restore, tests).
export function computeFieldsNow(world) {
  const nav = world.nav;
  startCivField(world); nav.civ.job.run(1e12); swap(nav.civ);
  startScent(world, nav.scent, nav.zCost); nav.scent.job.run(1e12); swap(nav.scent);
  if (nav.swim || nav.swimmers > 0) { const sw = swimField(world); startScent(world, sw, nav.sCost); sw.job.run(1e12); swap(sw); }
}

export function navSystem(world) {
  const nav = world.nav, cfg = world.cfg;
  for (const pk of world.pickups) {
    const dx = pk.x - pk.fx, dy = pk.y - pk.fy;
    if (dx * dx + dy * dy > 64) { nav.civ.dirty = true; break; }
  }
  const civ = nav.civ;
  if (!civ.job.active && civ.dirty) startCivField(world);
  if (civ.job.active && civ.job.run(Math.max(12000, Math.min(26000, nav.regionCells >> 3)))) swap(civ);

  const every = scentEvery(world);
  const scentBudget = Math.max(8000, Math.ceil(nav.regionCells / Math.max(1, every / cfg.sim.dt * 0.8)));
  const sf = nav.scent;
  if (!sf.job.active && world.t - sf.last >= every) startScent(world, sf, nav.zCost);
  if (sf.job.active && sf.job.run(scentBudget)) swap(sf);
  if (nav.swimmers > 0) {
    const sw = swimField(world);
    if (!sw.job.active && world.t - sw.last >= every) startScent(world, sw, nav.sCost);
    if (sw.job.active && sw.job.run(scentBudget)) swap(sw);
  }
}

// ---------- corridor fields (small local Dijkstra inside the corridor box) ----------
export function corridorContains(co, x, y) {
  const dx = co.x1 - co.x0, dy = co.y1 - co.y0, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = x - co.x0, py = y - co.y0;
  const a = px * ux + py * uy, b = -px * uy + py * ux;
  return a >= 0 && a <= L && Math.abs(b) <= co.w * 0.5;
}

export function corridorBBox(co) {
  const dx = co.x1 - co.x0, dy = co.y1 - co.y0, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L * co.w * 0.5, ny = dx / L * co.w * 0.5;
  const xs = [co.x0 + nx, co.x0 - nx, co.x1 + nx, co.x1 - nx], ys = [co.y0 + ny, co.y0 - ny, co.y1 + ny, co.y1 - ny];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function buildCorridorField(world, co) {
  const g = world.grid, cs = g.cell, nav = world.nav;
  const [bx0, by0, bx1, by1] = corridorBBox(co);
  const ox = Math.max(0, Math.floor(bx0 / cs) - 1), oy = Math.max(0, Math.floor(by0 / cs) - 1);
  const ex = Math.min(g.gw - 1, Math.floor(bx1 / cs) + 1), ey = Math.min(g.gh - 1, Math.floor(by1 / cs) + 1);
  const lw = ex - ox + 1, lh = ey - oy + 1;
  const cost = new Uint8Array(lw * lh);
  const dx = co.x1 - co.x0, dy = co.y1 - co.y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const job = new DialJob(lw * lh, lw);
  job.begin(cost, Math.max(1, world.cfg.scent.rubbleCost | 0));
  const srcs = [];
  for (let y = 1; y < lh - 1; y++) for (let x = 1; x < lw - 1; x++) {
    const gx = x + ox, gy = y + oy, px = (gx + 0.5) * cs, py = (gy + 0.5) * cs;
    if (!corridorContains(co, px, py)) continue;
    const k = nav.civCost[gy * g.gw + gx];
    if (!k) continue;
    const l = y * lw + x;
    cost[l] = k;
    if ((px - co.x0) * ux + (py - co.y0) * uy >= L - cs * 1.5) srcs.push(l);
  }
  for (const s of srcs) job.source(s);
  job.run(1e12);
  return { ox, oy, lw, lh, dir: job.dir, ux, uy, L, stale: false };
}

// Nearest fine cell (spiral) that has all bits of `bits` set, within maxR cells. -1 if none.
export function nearestPassable(world, x, y, bits, maxR = 12) {
  const g = world.grid, pass = world.nav.pass;
  const cx0 = Math.floor(x / g.cell), cy0 = Math.floor(y / g.cell);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
      const c = cy * g.gw + cx;
      if ((pass[c] & bits) !== bits) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
