// Passability, per-cell costs and flow fields (Dial's bucket-queue Dijkstra on typed arrays).
// All fields live on the fine grid; the coarse grid (sim.coarse) is only used for fire and broadcast masks.
// Field encoding: dist (Uint32, INF unreachable), dir (Uint8: 0..7 = step toward the target, 8 = target cell, 255 = unreachable).
// Costs: 0 = blocked, low 7 bits = cost multiplier, BARRIER bit = wall or gate (no diagonal step may cut past it).
import { T } from '../map/format.js';

export const P_IN = 1, P_CIV = 2, P_ZOM = 4, P_SWIM = 8, P_SLOW = 16, P_WALL = 32, P_GATE = 64, P_WATER = 128;
export const INF = 0xFFFFFFFF;
export const DX = Int8Array.of(1, 1, 0, -1, -1, -1, 0, 1);
export const DY = Int8Array.of(0, 1, 1, 1, 0, -1, -1, -1);
const BARRIER = 128;

const WALK = new Uint8Array(16);
WALK[T.OPEN] = 1; WALK[T.ROAD] = 1; WALK[T.PARK] = 1; WALK[T.BRIDGE] = 1; WALK[T.RUBBLE] = 1; WALK[T.RAIL] = 1;
export function isWalkTerrain(t) { return WALK[t] === 1; }
// What a cell would let through if no wall stood on it.
const UNDER = new Uint8Array(16);
for (let t = 0; t < 16; t++) UNDER[t] = WALK[t] ? (P_CIV | P_ZOM | P_SWIM) : t === T.WATER ? P_SWIM : 0;

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
  // A diagonal step needs both side cells open and neither a barrier, so fields never slip between wall cells.
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
      let nd, n, k;
      if (ce) { nd = cur + 10 * (ce & 127); if (nd < dist[c + 1]) { dist[c + 1] = nd; dir[c + 1] = 4; buckets[nd & mask].push(c + 1); pending++; } }
      if (cw) { nd = cur + 10 * (cw & 127); if (nd < dist[c - 1]) { dist[c - 1] = nd; dir[c - 1] = 0; buckets[nd & mask].push(c - 1); pending++; } }
      if (cs) { nd = cur + 10 * (cs & 127); if (nd < dist[c + gw]) { dist[c + gw] = nd; dir[c + gw] = 6; buckets[nd & mask].push(c + gw); pending++; } }
      if (cn) { nd = cur + 10 * (cn & 127); if (nd < dist[c - gw]) { dist[c - gw] = nd; dir[c - gw] = 2; buckets[nd & mask].push(c - gw); pending++; } }
      const okE = ce !== 0 && ce < BARRIER, okW = cw !== 0 && cw < BARRIER, okS = cs !== 0 && cs < BARRIER, okN = cn !== 0 && cn < BARRIER;
      if (okE && okS) { n = c + gw + 1; k = cost[n]; if (k) { nd = cur + 14 * (k & 127); if (nd < dist[n]) { dist[n] = nd; dir[n] = 5; buckets[nd & mask].push(n); pending++; } } }
      if (okW && okS) { n = c + gw - 1; k = cost[n]; if (k) { nd = cur + 14 * (k & 127); if (nd < dist[n]) { dist[n] = nd; dir[n] = 7; buckets[nd & mask].push(n); pending++; } } }
      if (okW && okN) { n = c - gw - 1; k = cost[n]; if (k) { nd = cur + 14 * (k & 127); if (nd < dist[n]) { dist[n] = nd; dir[n] = 1; buckets[nd & mask].push(n); pending++; } } }
      if (okE && okN) { n = c - gw + 1; k = cost[n]; if (k) { nd = cur + 14 * (k & 127); if (nd < dist[n]) { dist[n] = nd; dir[n] = 3; buckets[nd & mask].push(n); pending++; } } }
    }
    this.cur = cur; this.pending = pending;
    if (pending === 0) { this.active = false; return true; }
    return false;
  }
}

function makeField(N, gw) { return { dist: new Uint32Array(N).fill(INF), dir: new Uint8Array(N).fill(255), job: new DialJob(N, gw), dirty: true, last: -1e9, ready: false, urgent: true }; }

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
    pass: new Uint8Array(N), under: new Uint8Array(N), civCost: new Uint8Array(N), zCost: new Uint8Array(N), sCost: new Uint8Array(N),
    civDyn: new Uint8Array(N), dynList: [],
    civ: makeField(N, g.gw), scent: makeField(N, g.gw), swim: null,
    version: 0, regionCells: 1, swimmers: 0, k: costConsts(cfg),
    corrFields: [],
  };
}

function costConsts(cfg) {
  const sc = cfg.scent, n = (v) => Math.max(1, Math.min(127, v | 0));
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
  nav.under[c] = p ? UNDER[terrain[c]] : 0;
  const land = (p & P_SLOW) ? k.rubble : terrain[c] === T.PARK ? k.park : 1;
  nav.civCost[c] = nav.civDyn[c] = (p & P_CIV) ? ((p & P_SLOW) ? k.rubble : 1) : 0;
  const barrier = (p & P_WALL) ? (k.wall | BARRIER) : (p & P_GATE) ? (k.gate | BARRIER) : 0;
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
  nav.dynList.length = 0;
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

// Civilian traversal cost for this rebuild: base cost + danger near zombies + queue cost on crowded gates.
function dynamicCivCost(world) {
  const nav = world.nav, dyn = nav.civDyn, base = nav.civCost, list = nav.dynList, cc = world.cfg.civ, g = world.grid;
  for (let k = 0; k < list.length; k++) dyn[list[k]] = base[list[k]];
  list.length = 0;
  let extra = 0;
  const sh = world.sh;
  const dc = +cc.dangerCost || 0, dmax = Math.min(60, +cc.dangerMax || 0);
  if (dc > 0 && dmax > 0 && world.counts[2] > 0 && sh) {
    extra = dmax;
    const r = Math.max(1, Math.round(sh.hcell / g.cell)), gw = g.gw, gh = g.gh, cntZ = sh.cntZ, hw = sh.hw;
    for (let k = 0; k < sh.nz; k++) {
      const hc = sh.zcells[k], z = cntZ[hc];
      const add = Math.min(dmax, dc * z);
      const hx = hc % hw, hy = (hc / hw) | 0;
      const x0 = Math.max(1, (hx - 1) * r), x1 = Math.min(gw - 2, (hx + 2) * r - 1);
      const y0 = Math.max(1, (hy - 1) * r), y1 = Math.min(gh - 2, (hy + 2) * r - 1);
      for (let y = y0; y <= y1; y++) for (let c = y * gw + x0, e = y * gw + x1; c <= e; c++) {
        const b = base[c];
        if (!b) continue;
        const v = dyn[c];
        if (v === b) list.push(c);
        dyn[c] = Math.min(b + dmax, v + add);
      }
    }
  }
  const per = +cc.gateQueuePer || 0, qmax = Math.min(60, +cc.gateQueueMax || 0);
  if (per > 0 && qmax > 0 && sh && world.zones) {
    extra += qmax;
    const ri = Math.ceil((cc.gateQueueRadius || 16) * sh.inv), cntC = sh.cntC, hw = sh.hw;
    for (const gt of world.zones.gates) {
      const comp = world.zones.comps[gt.comp];
      if (!(gt.hp > 0) || !comp || comp.breached) continue;
      const hx = (gt.x * sh.inv) | 0, hy = (gt.y * sh.inv) | 0;
      let n = 0;
      for (let y = Math.max(0, hy - ri); y <= Math.min(sh.hh - 1, hy + ri); y++) for (let x = Math.max(0, hx - ri); x <= Math.min(hw - 1, hx + ri); x++) {
        const fc = world.cellAt((x + 0.5) * sh.hcell, (y + 0.5) * sh.hcell);
        if (fc >= 0 && !world.zoneId[fc]) n += cntC[y * hw + x];
      }
      const add = Math.min(qmax, Math.floor(n / per));
      if (!add) continue;
      for (const c of gt.cells) {
        const b = base[c];
        if (!b) continue;
        if (dyn[c] === b) list.push(c);
        dyn[c] = Math.min(127, dyn[c] + add);
      }
    }
  }
  return extra;
}

function startCivField(world, urgent) {
  const nav = world.nav, f = nav.civ, job = f.job, cfg = world.cfg;
  const extra = dynamicCivCost(world);
  job.begin(nav.civDyn, Math.max(1, cfg.scent.rubbleCost | 0) + extra, Math.ceil(cfg.civ.seekMaxPath / world.grid.cell * 10));
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
  f.urgent = urgent;
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

// Big stages refresh the fields less often so the amortised cost stays flat. Past a 5 km square (bigMul > 1) the
// rates grow with the square root of the area, so residents and zombies still react in seconds; the population
// cap keeps the agents' share of a tick flat there.
function refreshEvery(world, base, perCells = 200000) {
  return Math.max(base || 1, world.nav.regionCells / (perCells * bigMul(world)));
}

export function bigMul(world) {
  const a = world.nav.regionCells * world.grid.cell * world.grid.cell;
  return a > 25e6 ? Math.sqrt(a / 25e6) : 1;
}

// Computes every field synchronously (READY, restore, tests).
export function computeFieldsNow(world) {
  const nav = world.nav;
  startCivField(world, true); nav.civ.job.run(1e12); swap(nav.civ);
  startScent(world, nav.scent, nav.zCost); nav.scent.job.run(1e12); swap(nav.scent);
  if (nav.swim || nav.swimmers > 0) { const sw = swimField(world); startScent(world, sw, nav.sCost); sw.job.run(1e12); swap(sw); }
}

export function navSystem(world) {
  const nav = world.nav, cfg = world.cfg, dt = cfg.sim.dt;
  for (const pk of world.pickups) {
    const dx = pk.x - pk.fx, dy = pk.y - pk.fy;
    if (dx * dx + dy * dy > 64) { nav.civ.dirty = true; break; }
  }
  const civ = nav.civ;
  const civEvery = refreshEvery(world, cfg.civ.fieldEvery, 45000);
  // a change (breach, gate, zone) restarts a slow periodic rebuild as an urgent one
  if (civ.job.active && !civ.urgent && civ.dirty) startCivField(world, true);
  else if (!civ.job.active && (civ.dirty || (world.counts[2] > 0 && world.t - civ.last >= civEvery))) startCivField(world, civ.dirty);
  if (civ.job.active) {
    const budget = civ.urgent ? Math.max(12000, Math.min(Math.round(26000 * bigMul(world)), nav.regionCells >> 3)) : Math.max(6000, Math.ceil(nav.regionCells / Math.max(1, civEvery / dt * 0.6)));
    if (civ.job.run(budget)) swap(civ);
  }

  const every = refreshEvery(world, cfg.sim.scentEvery);
  const scentBudget = Math.max(8000, Math.ceil(nav.regionCells / Math.max(1, every / dt * 0.8)));
  const sf = nav.scent;
  if (!sf.job.active && world.t - sf.last >= every) startScent(world, sf, nav.zCost);
  if (sf.job.active && sf.job.run(scentBudget)) swap(sf);
  if (nav.swimmers > 0) {
    const sw = swimField(world);
    if (!sw.job.active && world.t - sw.last >= every) startScent(world, sw, nav.sCost);
    if (sw.job.active && sw.job.run(scentBudget)) swap(sw);
  }
}

// True when the straight line from (x0,y0) to (x1,y1) only crosses fine cells with one of `bits`
// (the start cell is not tested; a step through a cell corner tests one of its two side cells).
export function lineClear(pass, gw, cs, x0, y0, x1, y1, bits) {
  const inv = 1 / cs;
  let cx = (x0 * inv) | 0, cy = (y0 * inv) | 0;
  const ex = (x1 * inv) | 0, ey = (y1 * inv) | 0;
  if (cx === ex && cy === ey) return true;
  const dx = x1 - x0, dy = y1 - y0, sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const adx = dx > 0 ? dx : -dx, ady = dy > 0 ? dy : -dy;
  let tx = adx > 1e-9 ? (sx > 0 ? (cx + 1) * cs - x0 : x0 - cx * cs) / adx : 1e30;
  let ty = ady > 1e-9 ? (sy > 0 ? (cy + 1) * cs - y0 : y0 - cy * cs) / ady : 1e30;
  const sdx = adx > 1e-9 ? cs / adx : 1e30, sdy = ady > 1e-9 ? cs / ady : 1e30;
  for (let guard = (ex - cx) * sx + (ey - cy) * sy + 1; guard > 0; guard--) {
    if (tx < ty) { cx += sx; tx += sdx; } else { cy += sy; ty += sdy; }
    if (!(pass[cy * gw + cx] & bits)) return false;
    if (cx === ex && cy === ey) return true;
  }
  return true;
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
