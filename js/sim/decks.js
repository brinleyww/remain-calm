// Multi-level roads: deck and tunnel nodes over the ground grid.
// A road with z (one height per vertex, in tiers) puts its tier-0 cells on the ground as usual; every other cell it
// covers becomes a node, one per (tier, cell), with field id N + k (N = gw * gh). Tiers: -2, -1 tunnels, 1..3 decks.
// Nodes link to their same-tier neighbours in nav's compass order (DX/DY); where a road changes tier between two
// orthogonal cells, a portal links them (ground cells with portals carry lvf bit 4). The open ground under the first
// deck cells of a ramp is T.RAMP (an embankment or cutting), so every tier change is one unambiguous step. Where the
// ramp foot lies under another street (or a building), that cell stays as it is and gets lvf bit 16 (shadow): the
// orthogonal step into it from the portal cell is the portal, so fields do not route people onto it that way.
import { T } from '../map/format.js';
import { distToSeg, clamp } from '../util/geom.js';

export const LV_DECK = 1, LV_TUNNEL = 2, LV_PORTAL = 4, LV_SOLID = 8, LV_SHADOW = 16;
export const TIERS = [-2, -1, 1, 2, 3];
const SLOT = (t) => (t < 0 ? t + 2 : t + 1);
const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
const WALK = new Uint8Array(16);
WALK[T.OPEN] = 1; WALK[T.ROAD] = 1; WALK[T.PARK] = 1; WALK[T.BRIDGE] = 1; WALK[T.RUBBLE] = 1; WALK[T.RAIL] = 1;
// (dx, dy) in -1..1 -> compass direction (8 = same cell)
export const DIR9 = Int8Array.of(5, 6, 7, 4, 8, 0, 3, 2, 1);
const PIECE_M = 300;
const CIV_OK = 2;   // nav.js P_CIV

export const tierOfZ = (z) => (z >= 0 ? Math.floor(z + 0.5) : -Math.floor(0.5 - z));

// Covers a road with z like rasterSeg covers flat ones: cb(cell, z, s) per cell and segment, z and arc length s
// at the cell centre's projection onto the segment.
export function rasterZRoad(p, z, width, cell, gw, gh, cb) {
  const r = Math.max(width * 0.5, cell * 0.5);
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3], za = z[i >> 1], zb = z[(i >> 1) + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell)), cx1 = Math.min(gw - 1, Math.floor((Math.max(ax, bx) + r) / cell));
    const cy0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cell)), cy1 = Math.min(gh - 1, Math.floor((Math.max(ay, by) + r) / cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      const y = (cy + 0.5) * cell;
      for (let cx = cx0; cx <= cx1; cx++) {
        const x = (cx + 0.5) * cell;
        if (distToSeg(x, y, ax, ay, bx, by) > r) continue;
        const t = L2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
        cb(cy * gw + cx, za + (zb - za) * t, acc + L * t);
      }
    }
    acc += L;
  }
}

// Collector used by raster.js while it lays the roads: off-ground cells of roads with z, and the ground cells those
// roads cover (portals only join cells of one road).
export function makeDeckCollector(nRoads) {
  return { nRoads, nt: [], nc: [], nr: [], nz: [], ns: [], ground: new Set() };
}

export function collectZRoad(col, ri, rd, w, cell, gw, gh, put, isRail) {
  rasterZRoad(rd.p, rd.z, w, cell, gw, gh, (c, z, s) => {
    const t = tierOfZ(z);
    if (t === 0) { put(c); if (!isRail) col.ground.add(c * col.nRoads + ri); return; }
    if (isRail) return;   // elevated and underground rail is scenery
    col.nt.push(t); col.nc.push(c); col.nr.push(ri); col.nz.push(Math.round(z * 10)); col.ns.push(s);
  });
}

// Builds grid.deck from the collected cells (after buildings are in) and appends deck structures to grid.bridges.
export function buildDecks(map, grid, col, cfg) {
  const { gw, gh, cell, terrain } = grid, N = gw * gh;
  const M = col.nt.length;
  if (!M) return null;
  const ord = new Int32Array(M);
  for (let i = 0; i < M; i++) ord[i] = i;
  const nt = col.nt, nc = col.nc;
  ord.sort((a, b) => nt[a] - nt[b] || nc[a] - nc[b] || a - b);
  let D = 0;
  for (let k = 0; k < M; k++) { const i = ord[k]; if (k === 0 || nt[i] !== nt[ord[k - 1]] || nc[i] !== nc[ord[k - 1]]) D++; }
  const dcell = new Int32Array(D), dtier = new Int8Array(D), road = new Int32Array(D), zq = new Int16Array(D), sAt = new Float32Array(D);
  D = 0;
  for (let k = 0; k < M; k++) {
    const i = ord[k];
    if (k > 0 && nt[i] === nt[ord[k - 1]] && nc[i] === nc[ord[k - 1]]) continue;
    dcell[D] = nc[i]; dtier[D] = nt[i]; road[D] = col.nr[i]; zq[D] = col.nz[i]; sAt[D] = col.ns[i]; D++;
  }
  // tile lookup: (tier, 16x16 cell tile) -> block of 256 node slots
  const tw = Math.ceil(gw / 16), tiles = tw * Math.ceil(gh / 16);
  const tix = new Int32Array(5 * tiles).fill(-1);
  let used = 0;
  for (let k = 0; k < D; k++) {
    const c = dcell[k], t = SLOT(dtier[k]) * tiles + (((c / gw) | 0) >> 4) * tw + ((c % gw) >> 4);
    if (tix[t] < 0) tix[t] = 256 * used++;
  }
  const tstore = new Int32Array(256 * used).fill(-1);
  for (let k = 0; k < D; k++) {
    const c = dcell[k], cx = c % gw, cy = (c / gw) | 0;
    tstore[tix[SLOT(dtier[k]) * tiles + (cy >> 4) * tw + (cx >> 4)] + ((cy & 15) << 4) + (cx & 15)] = k;
  }
  const dk = { N, D, gw, gh, cell: dcell, tier: dtier, road, zq, sid: new Int32Array(D).fill(-1), over: new Uint8Array(D),
    nb: new Int32Array(8 * D).fill(-1), tix, tstore, tw, tiles, lvf: new Uint8Array(N), portals: null, pnb: null };
  const find = (t, cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return -1;
    const b = tix[SLOT(t) * tiles + (cy >> 4) * tw + (cx >> 4)];
    return b < 0 ? -1 : tstore[b + ((cy & 15) << 4) + (cx & 15)];
  };
  const lvf = dk.lvf, nb = dk.nb, R = col.nRoads;
  for (let k = 0; k < D; k++) {
    const c = dcell[k], t = dtier[k], az = Math.abs(zq[k]);
    lvf[c] |= t > 0 ? LV_DECK : LV_TUNNEL;
    const tc = terrain[c];
    if (tc === T.WATER || tc === T.BRIDGE) dk.over[k] = 1;
    if (az >= 5 && az < 7 && (tc === T.OPEN || tc === T.PARK || tc === T.RUBBLE)) { terrain[c] = T.RAMP; lvf[c] |= LV_SOLID; }
  }
  // links: same-tier neighbours first, else a portal to the next tier along the same road
  const gport = [];
  for (let k = 0; k < D; k++) {
    const c = dcell[k], t = dtier[k], cx = c % gw, cy = (c / gw) | 0, base = 8 * k;
    for (let d = 0; d < 8; d += 2) {
      const qx = cx + DX[d], qy = cy + DY[d];
      const m = find(t, qx, qy);
      if (m >= 0) { nb[base + d] = N + m; continue; }
      if (qx <= 0 || qy <= 0 || qx >= gw - 1 || qy >= gh - 1) continue;
      for (const t2 of [t - 1, t + 1]) {
        if (t2 < -2 || t2 > 3) continue;
        if (t2 === 0) {
          const g = qy * gw + qx;
          if (!WALK[terrain[g]] || !col.ground.has(g * R + road[k])) continue;
          const tc = terrain[c];
          if (tc === T.OPEN || tc === T.PARK || tc === T.RUBBLE) { terrain[c] = T.RAMP; lvf[c] |= LV_SOLID; }
          nb[base + d] = g; gport.push(g, (d + 4) & 7, N + k);
          break;
        }
        const m2 = find(t2, qx, qy);
        if (m2 < 0 || road[m2] !== road[k] || find(t2, cx, cy) >= 0) continue;
        nb[base + d] = N + m2;
        break;
      }
    }
  }
  // ground side of the portals, one per direction (first wins); links that are not two-way are dropped
  const pg = new Map();
  for (let j = 0; j < gport.length; j += 3) {
    const g = gport[j], d = gport[j + 1], m = gport[j + 2];
    let e = pg.get(g);
    if (!e) pg.set(g, e = [-1, -1, -1, -1]);
    if (e[d >> 1] < 0) e[d >> 1] = m;
  }
  for (let k = 0; k < D; k++) {
    const base = 8 * k;
    for (let d = 0; d < 8; d += 2) {
      const m = nb[base + d];
      if (m < 0) continue;
      const back = (d + 4) & 7;
      if (m >= N) { if (nb[8 * (m - N) + back] !== N + k) nb[base + d] = -1; }
      else { const e = pg.get(m); if (!e || e[back >> 1] !== N + k) nb[base + d] = -1; }
    }
  }
  const pk = [...pg.keys()].sort((a, b) => a - b);
  dk.portals = Int32Array.from(pk);
  dk.pnb = new Int32Array(4 * pk.length).fill(-1);
  pk.forEach((g, p) => {
    const e = pg.get(g);
    for (let j = 0; j < 4; j++) {
      const m = e[j];
      if (m >= 0 && nb[8 * (m - N) + (((2 * j) + 4) & 7)] === g) dk.pnb[4 * p + j] = m;
    }
    lvf[g] |= LV_PORTAL;
    for (let j = 0; j < 4; j++) if (dk.pnb[4 * p + j] >= 0) lvf[g + DX[2 * j] + DY[2 * j] * gw] |= LV_SHADOW;
  });
  // diagonals: both sides must be same-tier nodes
  for (let k = 0; k < D; k++) {
    const c = dcell[k], t = dtier[k], cx = c % gw, cy = (c / gw) | 0, base = 8 * k;
    for (let d = 1; d < 8; d += 2) {
      const a = nb[base + d - 1], b = nb[base + ((d + 1) & 7)];
      if (a < N || b < N || dtier[a - N] !== t || dtier[b - N] !== t) continue;
      const m = find(t, cx + DX[d], cy + DY[d]);
      if (m >= 0) nb[base + d] = N + m;
    }
  }
  addDeckStructures(map, grid, dk, sAt, cfg);
  return dk;
}

// Each road's deck nodes, split into continuous spans and then pieces of at most 300 m: destructible structures
// appended to grid.bridges after the water bridges ({ deck: true, nodes, cells, ... }). Tunnels cannot be destroyed.
function addDeckStructures(map, grid, dk, sAt, cfg) {
  const bc = (cfg && cfg.bridge) || { hpPerM: 6, hpPerWidthM: 20, hpMin: 200, hpMax: 4000 };
  const mul = (cfg && cfg.decks && cfg.decks.hpMul) || 1;
  const byRoad = new Map();
  for (let k = 0; k < dk.D; k++) {
    if (dk.tier[k] <= 0) continue;
    let a = byRoad.get(dk.road[k]);
    if (!a) byRoad.set(dk.road[k], a = []);
    a.push(k);
  }
  const roads = map.roads || [], gw = grid.gw, cs = grid.cell;
  for (const ri of [...byRoad.keys()].sort((a, b) => a - b)) {
    const ks = byRoad.get(ri).sort((a, b) => sAt[a] - sAt[b] || a - b);
    const spans = [];
    let cur = [ks[0]];
    for (let j = 1; j < ks.length; j++) {
      if (sAt[ks[j]] - sAt[ks[j - 1]] > cs * 3) { spans.push(cur); cur = []; }
      cur.push(ks[j]);
    }
    spans.push(cur);
    const width = Math.max(cs, +(roads[ri] && roads[ri].w) || 8);
    for (const sp of spans) {
      const s0 = sAt[sp[0]], s1 = sAt[sp[sp.length - 1]], L = Math.max(cs, s1 - s0 + cs);
      const n = Math.max(1, Math.ceil(L / PIECE_M)), step = L / n;
      const parts = Array.from({ length: n }, () => []);
      for (const k of sp) parts[Math.min(n - 1, Math.floor((sAt[k] - s0) / step))].push(k);
      for (const part of parts) {
        if (!part.length) continue;
        let mx = 0, my = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const cells = new Set();
        for (const k of part) {
          const c = dk.cell[k], X = c % gw, Y = (c / gw) | 0;
          mx += X; my += Y; cells.add(c);
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
        mx /= part.length; my /= part.length;
        const len = Math.min(L, step);
        let s0 = Infinity, s1 = -Infinity;
        for (const k of part) { if (sAt[k] < s0) s0 = sAt[k]; if (sAt[k] > s1) s1 = sAt[k]; }
        const hpMax = Math.round(clamp((bc.hpPerM * len + bc.hpPerWidthM * width) * mul, bc.hpMin, bc.hpMax * mul));
        const id = grid.bridges.length;
        for (const k of part) dk.sid[k] = id;
        grid.bridges.push({
          deck: true, road: ri, tier: dk.tier[part[0]], nodes: Int32Array.from(part, (k) => dk.N + k).sort(), cells: Int32Array.from([...cells].sort((a, b) => a - b)),
          len, width, cx: (mx + 0.5) * cs, cy: (my + 0.5) * cs, hpMax, bb: [x0 * cs, y0 * cs, (x1 + 1) * cs, (y1 + 1) * cs], s0, s1,
        });
      }
    }
  }
}

// ---------------------------------------------------------------- lookups
// Field id of the node at (tier, cx, cy), the ground cell for tier 0, or -1.
export function nodeAt(dk, t, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= dk.gw || cy >= dk.gh) return -1;
  if (t === 0) return cy * dk.gw + cx;
  if (t < -2 || t > 3) return -1;
  const b = dk.tix[SLOT(t) * dk.tiles + (cy >> 4) * dk.tw + (cx >> 4)];
  if (b < 0) return -1;
  const k = dk.tstore[b + ((cy & 15) << 4) + (cx & 15)];
  return k < 0 ? -1 : dk.N + k;
}

// True when a step from ground cell g in compass direction d (orthogonal) takes a portal.
export function portalStep(dk, g, d) { return (dk.lvf[g] & LV_PORTAL) !== 0 && portalOf(dk, g, d) >= 0; }

// Node reached from ground cell g through its portal in compass direction d (orthogonal), or -1.
export function portalOf(dk, g, d) {
  const P = dk.portals;
  let lo = 0, hi = P.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = P[m];
    if (v === g) return dk.pnb[4 * m + (d >> 1)];
    if (v < g) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

export const tierOf = (dk, f) => (f < dk.N ? 0 : dk.tier[f - dk.N]);
export const groundOf = (dk, f) => (f < dk.N ? f : dk.cell[f - dk.N]);

// Field id where agent i stands (its ground cell on flat maps and on tier 0), or -1 off its deck.
export function fieldOf(world, i) {
  const g = world.grid, A = world.A, cx = Math.floor(A.x[i] / g.cell), cy = Math.floor(A.y[i] / g.cell);
  const t = A.tier ? A.tier[i] : 0;
  if (!g.deck || t === 0) return cy * g.gw + cx;
  return nodeAt(g.deck, t, cx, cy);
}

// The field ids at a ground cell on every tier (ground first, then nodes by tier), into out.
export function fieldsAt(dk, c, out) {
  out.length = 0;
  out.push(c);
  if (!dk || !(dk.lvf[c] & (LV_DECK | LV_TUNNEL))) return out;
  const cx = c % dk.gw, cy = (c / dk.gw) | 0;
  for (const t of TIERS) { const f = nodeAt(dk, t, cx, cy); if (f >= 0) out.push(f); }
  return out;
}

// Top tier someone dropped from the air at (x, y) lands on: the highest live deck node there, else the ground.
export function surfaceAt(world, x, y) {
  const g = world.grid, dk = g.deck;
  if (!dk) return 0;
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh || !(dk.lvf[cy * g.gw + cx] & LV_DECK)) return 0;
  const pass = world.nav && world.nav.pass;
  for (let t = 3; t >= 1; t--) {
    const f = nodeAt(dk, t, cx, cy);
    if (f >= 0 && (!pass || pass[f])) return t;
  }
  return 0;
}

// One step from field id f to the neighbouring cell (dx, dy in -1..1): the field id there (another tier through a
// portal), or -1. Diagonal steps on decks need both side nodes (they are linked only then).
export function stepField(dk, f, dx, dy) {
  const d = DIR9[(dy + 1) * 3 + dx + 1];
  if (d === 8) return f;
  if (f >= dk.N) return dk.nb[8 * (f - dk.N) + d];
  if ((d & 1) === 0 && (dk.lvf[f] & LV_PORTAL)) { const m = portalOf(dk, f, d); if (m >= 0) return m; }
  return f + dx + dy * dk.gw;
}

// True when the straight line from (x0,y0) to (x1,y1), walked cell by cell from field id f0 (decks through their links),
// only meets field ids with one of `bits`.
export function lineClearField(dk, pass, cs, f0, x0, y0, x1, y1, bits) {
  const inv = 1 / cs;
  let cx = (x0 * inv) | 0, cy = (y0 * inv) | 0, f = f0;
  const ex = (x1 * inv) | 0, ey = (y1 * inv) | 0;
  if (cx === ex && cy === ey) return true;
  const dx = x1 - x0, dy = y1 - y0, sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const adx = dx > 0 ? dx : -dx, ady = dy > 0 ? dy : -dy;
  let tx = adx > 1e-9 ? (sx > 0 ? (cx + 1) * cs - x0 : x0 - cx * cs) / adx : 1e30;
  let ty = ady > 1e-9 ? (sy > 0 ? (cy + 1) * cs - y0 : y0 - cy * cs) / ady : 1e30;
  const sdx = adx > 1e-9 ? cs / adx : 1e30, sdy = ady > 1e-9 ? cs / ady : 1e30;
  for (let guard = (ex - cx) * sx + (ey - cy) * sy + 1; guard > 0; guard--) {
    if (tx < ty) { f = stepField(dk, f, sx, 0); cx += sx; tx += sdx; } else { f = stepField(dk, f, 0, sy); cy += sy; ty += sdy; }
    if (f < 0 || !(pass[f] & bits)) return false;
    if (cx === ex && cy === ey) return true;
  }
  return true;
}

// The deck structure on top at (x, y) for picking: { id (grid / world bridge index), road, alive }, or null.
export function deckAt(world, x, y) {
  const g = world.grid, dk = g.deck;
  if (!dk) return null;
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh || !(dk.lvf[cy * g.gw + cx] & LV_DECK)) return null;
  for (let t = 3; t >= 1; t--) {
    const f = nodeAt(dk, t, cx, cy), sid = f >= 0 ? dk.sid[f - dk.N] : -1;
    if (sid >= 0) return { id: sid, road: g.bridges[sid].road, alive: !world.bridges || !world.bridges[sid] || world.bridges[sid].alive !== false };
  }
  return null;
}

// ---------------------------------------------------------------- local graphs
// The nodes over a window of the grid (ox, oy, lw x lh cells) as a small graph for march fields and A*: ground cell
// (x, y) of the window is local id y * lw + x and the window's nodes follow from lw * lh, in global order. Shaped like
// grid.deck (N, gw, nb, lvf, portals, pnb), so DialJob.runLayered and stepField work on it; gid holds each local node's
// global field id and cell its local ground cell. Links to the window's border cells or past it are dropped. null when
// the window has no nodes.
export function windowGraph(dk, ox, oy, lw, lh) {
  const gw = dk.gw, N = dk.N, LN = lw * lh, tw = dk.tw, tiles = dk.tiles, ks = [];
  const tx0 = Math.max(0, (ox + 1) >> 4), tx1 = Math.min(tw - 1, (ox + lw - 2) >> 4);
  const ty0 = Math.max(0, (oy + 1) >> 4), ty1 = Math.min(((dk.gh + 15) >> 4) - 1, (oy + lh - 2) >> 4);
  for (let s = 0; s < 5; s++) for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const b = dk.tix[s * tiles + ty * tw + tx];
    if (b < 0) continue;
    for (let j = 0; j < 256; j++) {
      const k = dk.tstore[b + j];
      if (k < 0) continue;
      const c = dk.cell[k], x = c % gw - ox, y = ((c / gw) | 0) - oy;
      if (x > 0 && y > 0 && x < lw - 1 && y < lh - 1) ks.push(k);
    }
  }
  if (!ks.length) return null;
  const gid = Int32Array.from(ks).sort(), D = gid.length;
  const loc = (g) => { const x = g % gw - ox, y = ((g / gw) | 0) - oy; return x > 0 && y > 0 && x < lw - 1 && y < lh - 1 ? y * lw + x : -1; };
  const cell = new Int32Array(D), tier = new Int8Array(D), nb = new Int32Array(8 * D).fill(-1);
  for (let j = 0; j < D; j++) {
    const k = gid[j];
    cell[j] = loc(dk.cell[k]); tier[j] = dk.tier[k];
    for (let d = 0; d < 8; d++) {
      const m = dk.nb[8 * k + d];
      if (m < 0) continue;
      if (m < N) nb[8 * j + d] = loc(m);
      else { const q = bsearch(gid, m - N); if (q >= 0) nb[8 * j + d] = LN + q; }
    }
  }
  for (let j = 0; j < D; j++) gid[j] += N;
  const lvf = new Uint8Array(LN), P = dk.portals, lp = [], ln = [];
  let lo = 0, hi = P.length;
  const first = (oy + 1) * gw;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P[m] < first) lo = m + 1; else hi = m; }
  for (let p = lo, last = (oy + lh - 1) * gw; p < P.length && P[p] < last; p++) {
    const l = loc(P[p]);
    if (l < 0) continue;
    let any = false;
    for (let j = 0; j < 4; j++) {
      const m = dk.pnb[4 * p + j], q = m < 0 ? -1 : bsearch(gid, m);
      ln.push(q < 0 ? -1 : LN + q);
      if (q >= 0) any = true;
    }
    if (any) { lp.push(l); lvf[l] |= LV_PORTAL; } else ln.length -= 4;
  }
  for (let p = 0, P2 = lp.length; p < P2; p++) for (let j = 0; j < 4; j++) {
    if (ln[4 * p + j] < 0) continue;
    const n = lp[p] + DX[2 * j] + DY[2 * j] * lw;
    if (n >= 0 && n < LN) lvf[n] |= LV_SHADOW;
  }
  return { N: LN, gw: lw, gh: lh, D, ox, oy, nb, lvf, portals: Int32Array.from(lp), pnb: Int32Array.from(ln), tier, cell, gid };
}

function bsearch(a, v) {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] === v) return m; if (a[m] < v) lo = m + 1; else hi = m - 1; }
  return -1;
}

// Local id in window graph wg (null: ground only) of global field id f, or -1 outside the window's interior.
export function localOf(wg, f, N, gw, ox, oy, lw, lh) {
  if (f < N) {
    const x = f % gw - ox, y = ((f / gw) | 0) - oy;
    return x > 0 && y > 0 && x < lw - 1 && y < lh - 1 ? y * lw + x : -1;
  }
  if (wg === null) return -1;
  const q = bsearch(wg.gid, f);
  return q < 0 ? -1 : wg.N + q;
}

// Field id on tier t at (x, y) (the ground cell for tier 0 or flat maps), -1 when that tier has no node there.
export function fieldAtT(world, x, y, t) {
  const g = world.grid, cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) return -1;
  return !g.deck || !t ? cy * g.gw + cx : nodeAt(g.deck, t, cx, cy);
}

// Nearest field id on tier t (within maxR cells of a point) whose pass has `bits` and none of `not`, -1 if none.
export function nearestOnTier(world, x, y, t, bits, not, maxR) {
  const g = world.grid, pass = world.nav.pass, dk = g.deck, cx0 = Math.floor(x / g.cell), cy0 = Math.floor(y / g.cell);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR && best < 0; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 1 || cy < 1 || cx >= g.gw - 1 || cy >= g.gh - 1) continue;
      const f = t === 0 ? cy * g.gw + cx : nodeAt(dk, t, cx, cy);
      if (f < 0 || !(pass[f] & bits) || (pass[f] & not)) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = f; }
    }
  }
  return best;
}

// The tier an order aimed at (x, y) goes to: the top surface there; `low` takes the level under it (the ground under a
// deck, a tunnel under the ground). A click on ground nobody can stand on over an open tunnel goes into the tunnel.
export function orderTier(world, x, y, low = false) {
  const g = world.grid, dk = g.deck;
  if (!dk) return 0;
  const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 1 || cy < 1 || cx >= g.gw - 1 || cy >= g.gh - 1) return 0;
  const pass = world.nav.pass, c = cy * g.gw + cx, top = surfaceAt(world, x, y);
  const open = (t) => { const f = nodeAt(dk, t, cx, cy); return f >= 0 && (pass[f] & CIV_OK) !== 0; };
  if (top > 0 && !low) return top;
  if (top > 0) { for (let t = top - 1; t >= 1; t--) if (open(t)) return t; return 0; }
  if ((dk.lvf[c] & LV_TUNNEL) && (low || !(pass[c] & CIV_OK))) { if (open(-1)) return -1; if (open(-2)) return -2; }
  return 0;
}
