// Procedural city generator -> MapData. Deterministic per seed, DOM-free.
// Pipeline: water field -> centre -> rail -> districts (Voronoi) -> streets in an unwarped plan -> gentle warp ->
// clip against water/rail -> bridges -> planted specials -> pocket parks -> frontage buildings -> specials -> stages.
import { Rng, hashStr, makeNoise2D } from '../util/rng.js';
import { polyArea, polySignedArea, polyCentroid, polyBBox, pointInPoly, rasterPoly, rasterSeg, simplify, clamp, lerp, segIntersect, distToSeg } from '../util/geom.js';
import { FORMAT, VERSION, normalizeMap, makeStages, mergeHoles, clipPolyRect, clipLineRect } from './format.js';
import { simplifyZ } from './osmlevels.js';

export const WATER_TYPES = ['none', 'river', 'coast', 'lake', 'islands'];

const FREE = 0, WATER = 1, ROAD = 2, RAIL = 3, PARK = 4, BLDG = 5, KEEP = 6, MWAY = 7;
const MWAY_W = 24;
const DT = 1, MID = 2, OLD = 3, SUB = 4, IND = 5, PRK = 6;
const TAU = Math.PI * 2;
const OCC_CELL = 2, ZG_CELL = 8;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export function normalizeCityOptions(opts = {}) {
  const seed = typeof opts.seed === 'string' && !/^\d+$/.test(opts.seed) ? hashStr(opts.seed)
    : Number.isFinite(+opts.seed) ? (+opts.seed >>> 0) : 1;
  const water = WATER_TYPES.includes(opts.water) ? opts.water : 'none';
  return {
    seed,
    sizeKm: clamp(+opts.sizeKm || 2, 0.5, 10),
    water,
    density: clamp(opts.density == null || opts.density === '' ? 0.6 : +opts.density || 0, 0, 1),
    bridges: water === 'none' ? 0 : clamp(Math.round(opts.bridges == null ? 3 : +opts.bridges || 0), 0, 16),
    stages: clamp(Math.round(+opts.stages || 5), 3, 7),
    // sheets of 3 km and more get a motorway (two from 6 km) on viaducts over the main roads, rail and water
    motorways: opts.motorways === undefined || opts.motorways === null ? true : !!opts.motorways,
    name: typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 80) : '',
  };
}

export function generateCity(options = {}) {
  const o = normalizeCityOptions(options);
  const W = Math.round(o.sizeKm * 1000), H = W;
  const ctx = {
    // dens: the build-up the generator works with; the slider's 0% still gives a loose town, 100% a packed core
    o, W, H, S: o.sizeKm, rng: new Rng(o.seed), dens: 0.3 + 0.7 * o.density,
    // metro: sheets above 6 km keep a core the size of a 5 km city and grow outward (satellite towns, an orbital road)
    metro: o.sizeKm > 6, sats: [],
    occ: makeOcc(W, H, OCC_CELL),
    roads: [], parks: [], buildings: [], reserves: [], ponds: [], extraWater: [], cands: [],
  };
  ctx.names = new Namer(ctx.rng.fork('names'));
  ctx.name = o.name || ctx.names.city(o.water);
  buildWater(ctx);
  buildLandGrid(ctx);
  chooseCentre(ctx);
  chooseSatellites(ctx);
  planRail(ctx);
  planMotorways(ctx);
  setupWarp(ctx);
  planDistricts(ctx);
  layStreets(ctx);
  warpAll(ctx);
  buildZoneGrid(ctx);
  elevateMotorways(ctx);
  clipRoads(ctx);
  layMotorways(ctx);
  addEmbankments(ctx);
  stampRoads(ctx, ctx.roads);
  buildBridges(ctx);
  dropStrayBridges(ctx);
  plantSpecials(ctx);
  pocketParks(ctx);
  placeFrontage(ctx);
  fillYards(ctx);
  infillBlocks(ctx);
  assignSpecials(ctx);
  const levels = buildStages(ctx);
  ensureStageSpecials(ctx, levels);
  return assemble(ctx, levels);
}

// ================================================================= small geometry helpers

function makeOcc(W, H, cell) {
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  return { cell, inv: 1 / cell, gw, gh, a: new Uint8Array(gw * gh) };
}
function occAt(o, x, y) {
  if (x < 0 || y < 0) return 255;
  const cx = (x * o.inv) | 0, cy = (y * o.inv) | 0;
  if (cx >= o.gw || cy >= o.gh) return 255;
  return o.a[cy * o.gw + cx];
}
// mode: 0 set always, 1 only FREE/KEEP/PARK cells, 2 anything but WATER, 3 only motorway cells
function stampPoly(o, p, v, mode) {
  const a = o.a;
  if (mode === 0) rasterPoly(p, o.cell, o.gw, o.gh, i => { a[i] = v; });
  else if (mode === 3) rasterPoly(p, o.cell, o.gw, o.gh, i => { if (a[i] === MWAY) a[i] = v; });
  else if (mode === 1) rasterPoly(p, o.cell, o.gw, o.gh, i => { const c = a[i]; if (c === FREE || c === KEEP || c === PARK) a[i] = v; });
  else rasterPoly(p, o.cell, o.gw, o.gh, i => { if (a[i] !== WATER) a[i] = v; });
}
function stampLine(o, p, w, v, mode) {
  const r = w / 2;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const nx = -(by - ay) / L * r, ny = (bx - ax) / L * r;
    stampPoly(o, [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], v, mode);
  }
  for (let i = 0; i < p.length; i += 2) stampPoly(o, octagon(p[i], p[i + 1], r), v, mode);
}
function octagon(x, y, r) {
  const out = [];
  for (let k = 0; k < 8; k++) { const a = (k + 0.5) * Math.PI / 4; out.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  return out;
}
function circlePoly(x, y, rx, ry, n, rot = 0) {
  const out = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU, u = Math.cos(a) * rx, v = Math.sin(a) * ry;
    out.push(x + u * c - v * s, y + u * s + v * c);
  }
  return out;
}
function cpoly(p) { return { p, s: polySignedArea(p) >= 0 ? 1 : -1 }; }

// Cyrus-Beck: parameter interval of segment AB inside convex polygon {p, s}.
function segInConvex(ax, ay, bx, by, P, sgn) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (let i = 0, n = P.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const nx = -(P[j + 1] - P[i + 1]) * sgn, ny = (P[j] - P[i]) * sgn;
    const num = (ax - P[i]) * nx + (ay - P[i + 1]) * ny;
    const den = dx * nx + dy * ny;
    if (den === 0) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return null;
  }
  return [t0, t1];
}
function subtractIv(ivs, [a, b]) {
  const out = [];
  for (const [s, e] of ivs) {
    if (b <= s || a >= e) { out.push([s, e]); continue; }
    if (a > s) out.push([s, a]);
    if (b < e) out.push([b, e]);
  }
  return out;
}
// Clip a polyline to (keep convex polygon) minus (convex polygons). Returns polylines.
function clipPolyline(pts, keep, minus) {
  const out = [];
  let cur = null, open = false;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    let ivs;
    if (keep) { const iv = segInConvex(ax, ay, bx, by, keep.p, keep.s); ivs = iv ? [iv] : []; } else ivs = [[0, 1]];
    for (const m of minus) {
      if (!ivs.length) break;
      const iv = segInConvex(ax, ay, bx, by, m.p, m.s);
      if (iv) ivs = subtractIv(ivs, iv);
    }
    let endOpen = false;
    for (const [s, e] of ivs) {
      if (e - s < 1e-7) continue;
      const ex = ax + (bx - ax) * e, ey = ay + (by - ay) * e;
      if (cur && open && s <= 1e-9) cur.push(ex, ey);
      else { if (cur) out.push(cur); cur = [ax + (bx - ax) * s, ay + (by - ay) * s, ex, ey]; }
      open = e >= 1 - 1e-9;
      endOpen = open;
    }
    if (!endOpen) { if (cur) out.push(cur); cur = null; open = false; }
  }
  if (cur) out.push(cur);
  return out;
}
function clipHalf(P, nx, ny, c) { // keep n.p >= c ; P flat convex
  const out = [], n = P.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const ax = P[i], ay = P[i + 1], bx = P[j], by = P[j + 1];
    const da = ax * nx + ay * ny - c, db = bx * nx + by * ny - c;
    if (da >= 0) out.push(ax, ay);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push(ax + (bx - ax) * t, ay + (by - ay) * t); }
  }
  return out;
}
function insetConvex(P, d) {
  const sg = polySignedArea(P) >= 0 ? 1 : -1;
  let Q = P;
  for (let i = 0, n = P.length; i < n && Q.length >= 6; i += 2) {
    const j = (i + 2) % n;
    const ex = P[j] - P[i], ey = P[j + 1] - P[i + 1], L = Math.hypot(ex, ey);
    if (L < 1e-9) continue;
    const nx = -ey / L * sg, ny = ex / L * sg;
    Q = clipHalf(Q, nx, ny, P[i] * nx + P[i + 1] * ny + d);
  }
  return Q.length >= 6 ? Q : null;
}
function splitConvex(P, px, py, dx, dy) {
  const nx = -dy, ny = dx, c = px * nx + py * ny;
  const A = clipHalf(P, nx, ny, c), B = clipHalf(P, -nx, -ny, -c);
  return [A.length >= 6 ? A : null, B.length >= 6 ? B : null];
}
function chaikin(p, iters, closed) {
  let q = p;
  for (let k = 0; k < iters; k++) {
    const out = [], n = q.length, last = closed ? n : n - 2;
    if (!closed) out.push(q[0], q[1]);
    for (let i = 0; i < last; i += 2) {
      const j = (i + 2) % n;
      out.push(q[i] * 0.75 + q[j] * 0.25, q[i + 1] * 0.75 + q[j + 1] * 0.25, q[i] * 0.25 + q[j] * 0.75, q[i + 1] * 0.25 + q[j + 1] * 0.75);
    }
    if (!closed) out.push(q[n - 2], q[n - 1]);
    q = out;
  }
  return q;
}
function closeRing(p) { return p.concat([p[0], p[1]]); }
function polyLen(p) { let s = 0; for (let i = 0; i + 3 < p.length; i += 2) s += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]); return s; }
function subdivide(p, maxSeg) {
  const out = [p[0], p[1]];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / maxSeg));
    for (let k = 1; k <= n; k++) out.push(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
  }
  return out;
}
function catmull(ctrl, step) {
  const out = [];
  for (let i = 1; i < ctrl.length - 2; i++) {
    const [x0, y0] = ctrl[i - 1], [x1, y1] = ctrl[i], [x2, y2] = ctrl[i + 1], [x3, y3] = ctrl[i + 2];
    const n = Math.max(2, Math.ceil(dist(x1, y1, x2, y2) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
        0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3));
    }
  }
  const e = ctrl[ctrl.length - 2];
  out.push(e[0], e[1]);
  return out;
}
function harmonics(rng, n, amp) {
  const h = [];
  for (let k = 1; k <= n; k++) h.push([k, amp * rng.range(0.5, 1) / Math.pow(k, 0.6), rng.range(0, TAU)]);
  h.push([n + 2, 0.025, rng.range(0, TAU)], [n + 4, 0.015, rng.range(0, TAU)]);
  return a => { let s = 1; for (const [k, am, ph] of h) s += am * Math.cos(k * a + ph); return s; };
}
function hull(pts) { // pts flat -> convex hull flat (monotone chain)
  const P = [];
  for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  const out = [];
  for (const p of lo.concat(up)) out.push(p[0], p[1]);
  return out;
}
// Polygon in a local frame (u along ux,uy; v along vx,vy) -> world.
function toWorld(loc, ox, oy, ux, uy, vx, vy) {
  const out = new Array(loc.length);
  for (let i = 0; i < loc.length; i += 2) {
    out[i] = ox + loc[i] * ux + loc[i + 1] * vx;
    out[i + 1] = oy + loc[i] * uy + loc[i + 1] * vy;
  }
  return out;
}

// ================================================================= names

const SYL_A = ['Ash', 'Bal', 'Bram', 'Car', 'Cold', 'Dun', 'Elm', 'Fen', 'Gal', 'Har', 'Holt', 'Kel', 'Lang', 'Mar', 'Nor', 'Oak', 'Pen',
  'Quar', 'Red', 'Rook', 'Sal', 'Stan', 'Thorn', 'Ware', 'Wex', 'Wil', 'Yar', 'Brack', 'Cleve', 'Fair', 'Glen', 'Hay', 'Kings', 'Mill',
  'Over', 'Rush', 'Sand', 'Ton', 'West', 'Wynd', 'Alder', 'Birch', 'Crane', 'Dray', 'Ever', 'Fallow', 'Gorse', 'Heron', 'Ivel', 'Lark'];
const SYL_B = ['ford', 'ham', 'ley', 'wick', 'field', 'gate', 'borough', 'ton', 'mere', 'wood', 'bridge', 'stead', 'haven', 'by', 'burn',
  'cliff', 'dale', 'moor', 'worth', 'well', 'combe', 'hurst', 'marsh', 'den', 'brook', 'holme', 'thorpe', 'wold'];
const DIST_SUFFIX = ['', '', '', '', ' Park', ' Heights', ' Green', ' Fields', ' Hill', ' Vale', ' Cross', ' End', ' Common', ' Rise'];
const ART_TYPES = ['Road', 'Avenue', 'Boulevard', 'Way', 'Road', 'Street', 'Parkway'];
const LOC_TYPES = ['Street', 'Lane', 'Close', 'Row', 'Place', 'Terrace', 'Grove', 'Crescent', 'Walk', 'Mews', 'Street', 'Road'];
const SAINTS = ['Aldric', 'Bede', 'Cuthbert', 'Edith', 'Hilda', 'Oswin', 'Wendel', 'Brigid', 'Columba', 'Anselm', 'Ninian', 'Petroc'];
const TOWER_WORDS = ['Meridian', 'Halcyon', 'Beacon', 'Sentinel', 'Aurora', 'Granite', 'Corinth', 'Pinnacle', 'Atlas', 'Vantage',
  'Lumen', 'Equinox', 'Keystone', 'Monarch', 'Cobalt', 'Paragon'];

class Namer {
  constructor(rng) { this.rng = rng; this.used = new Set(); }
  word() {
    for (let i = 0; i < 40; i++) {
      const w = this.rng.pick(SYL_A) + this.rng.pick(SYL_B);
      if (!this.used.has(w) || i > 30) { this.used.add(w); return w; }
    }
    return 'Elmford';
  }
  city(water) {
    const w = this.word();
    if (water === 'coast' && this.rng.chance(0.3)) return 'Port ' + w;
    if (water === 'river' && this.rng.chance(0.2)) return w + ' Crossing';
    return w;
  }
  district() { return this.word() + this.rng.pick(DIST_SUFFIX); }
  street(major) { return this.word() + ' ' + this.rng.pick(major ? ART_TYPES : LOC_TYPES); }
  saint() { return 'St ' + this.rng.pick(SAINTS); }
  tower() { return this.rng.pick(TOWER_WORDS); }
}

// ================================================================= water

function riverLine(rng, ax, ay, bx, by, width, amp, pinEnd) {
  const L = dist(ax, ay, bx, by), n = Math.max(4, Math.ceil(L / 20));
  const dx = (bx - ax) / L, dy = (by - ay) / L, px = -dy, py = dx;
  const nz = makeNoise2D(rng.int(1, 2 ** 30));
  const pts = new Float64Array((n + 1) * 2), hw = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = t * L;
    const env = pinEnd ? Math.min(1, (1 - t) * 6) : 1;
    const off = amp * 1.6 * nz.fbm(s / 900, 3.7, 3) * env;
    pts[2 * i] = ax + dx * s + px * off;
    pts[2 * i + 1] = ay + dy * s + py * off;
    hw[i] = (width / 2) * (1 + 0.22 * nz(s / 450, 9.1));
  }
  return { pts, hw, n: n + 1, width };
}

function riverField(r) {
  const B = 64;
  let maxHw = 0;
  for (const h of r.hw) if (h > maxHw) maxHw = h;
  const pad = maxHw + 48;
  const bb = polyBBox(r.pts);
  const x0 = bb[0] - pad, y0 = bb[1] - pad;
  const nbx = Math.ceil((bb[2] - bb[0] + 2 * pad) / B) + 1, nby = Math.ceil((bb[3] - bb[1] + 2 * pad) / B) + 1;
  const cells = new Array(nbx * nby);
  const P = r.pts;
  for (let i = 0; i < r.n - 1; i++) {
    const ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * i + 2], by = P[2 * i + 3];
    const cx0 = Math.floor((Math.min(ax, bx) - pad - x0) / B), cx1 = Math.floor((Math.max(ax, bx) + pad - x0) / B);
    const cy0 = Math.floor((Math.min(ay, by) - pad - y0) / B), cy1 = Math.floor((Math.max(ay, by) + pad - y0) / B);
    for (let cy = Math.max(0, cy0); cy <= Math.min(nby - 1, cy1); cy++) {
      for (let cx = Math.max(0, cx0); cx <= Math.min(nbx - 1, cx1); cx++) (cells[cy * nbx + cx] ||= []).push(i);
    }
  }
  return (x, y) => {
    const cx = Math.floor((x - x0) / B), cy = Math.floor((y - y0) / B);
    if (cx < 0 || cy < 0 || cx >= nbx || cy >= nby) return -48;
    const list = cells[cy * nbx + cx];
    if (!list) return -48;
    let best = -48;
    for (const i of list) {
      const ax = P[2 * i], ay = P[2 * i + 1], dx = P[2 * i + 2] - ax, dy = P[2 * i + 3] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const v = r.hw[i] + (r.hw[i + 1] - r.hw[i]) * t - Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (v > best) best = v;
    }
    return best;
  };
}

function buildWater(ctx) {
  const { o, W, H, S } = ctx;
  const rng = ctx.rng.fork('water');
  const feats = [];
  ctx.rivers = [];
  ctx.islandBlobs = null;
  const baseW = clamp(38 + 26 * S, 45, 175) * rng.range(0.85, 1.15);
  const addRiver = (ax, ay, bx, by, width, amp, pin) => {
    const r = riverLine(rng, ax, ay, bx, by, width, amp, pin);
    ctx.rivers.push(r);
    feats.push(riverField(r));
    return r;
  };
  if (o.water === 'river') {
    const ang = rng.range(0, Math.PI), dx = Math.cos(ang), dy = Math.sin(ang);
    const off = W * rng.range(0.11, 0.2) * rng.sign();
    const mx = W / 2 - dy * off, my = H / 2 + dx * off, L = W * 0.9;
    const main = addRiver(mx - dx * L, my - dy * L, mx + dx * L, my + dy * L, baseW, Math.max(70, W * 0.07), false);
    if (S >= 2.5 && (rng.chance(0.55) || ctx.metro)) {
      const k = Math.floor(main.n * rng.range(0.38, 0.62));
      const jx = main.pts[2 * k], jy = main.pts[2 * k + 1], side = Math.sign(off) || 1;
      const ta = rng.range(-0.45, 0.45);
      addRiver(jx + (-dy * side + dx * ta) * W, jy + (dx * side + dy * ta) * W, jx, jy, baseW * 0.42, Math.max(45, W * 0.04), true);
    }
  } else if (o.water === 'coast') {
    let nx, ny;
    if (rng.chance(0.3)) { const c = rng.int(0, 3); nx = (c === 0 || c === 3 ? -1 : 1) / Math.SQRT2; ny = (c < 2 ? -1 : 1) / Math.SQRT2; }
    else [nx, ny] = [[0, -1], [1, 0], [0, 1], [-1, 0]][rng.int(0, 3)];
    const tx = -ny, ty = nx;
    let pmin = Infinity, pmax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, H]]) {
      const p = x * nx + y * ny, t = x * tx + y * ty;
      pmin = Math.min(pmin, p); pmax = Math.max(pmax, p); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    const b = pmax - rng.range(0.27, 0.36) * (pmax - pmin);
    const nz = makeNoise2D(rng.int(1, 2 ** 30));
    const A = W * 0.045, lam = W * 0.3;
    const bumps = [];
    const nb = S >= 2 ? rng.int(1, 3) : rng.int(1, 2);
    for (let k = 0; k < nb; k++) {
      bumps.push([lerp(tmin, tmax, rng.range(0.15, 0.85)), W * rng.range(0.05, 0.1) * (rng.chance(0.65) ? 1 : -1), W * rng.range(0.05, 0.1)]);
    }
    feats.push((x, y) => {
      const t = x * tx + y * ty;
      let v = x * nx + y * ny - b + A * nz.fbm(t / lam, 0.37, 3);
      for (const [tk, am, sg] of bumps) { const q = (t - tk) / sg; v += am * Math.exp(-q * q); }
      return v;
    });
    if (o.bridges > 0 || rng.chance(0.35)) {
      const t0 = lerp(tmin, tmax, 0.5 + rng.range(-0.25, 0.25)), t1 = t0 + rng.range(-0.12, 0.12) * W;
      addRiver(tx * t0 + nx * (pmin - 150), ty * t0 + ny * (pmin - 150), tx * t1 + nx * (b + W * 0.25), ty * t1 + ny * (b + W * 0.25),
        baseW * 0.62, Math.max(55, W * 0.055), false);
    }
  } else if (o.water === 'lake') {
    const a = rng.range(0, TAU), d0 = W * rng.range(0.17, 0.27);
    const lx = W / 2 + Math.cos(a) * d0, ly = H / 2 + Math.sin(a) * d0;
    const R = clamp(W * rng.range(0.13, 0.19), 140, 850);
    const g = harmonics(rng, 3, 0.16), nzl = makeNoise2D(rng.int(1, 2 ** 30)), lamL = R * 0.9;
    let isl = null;
    if (R > 280 && rng.chance(0.5)) { const ia = rng.range(0, TAU); isl = [lx + Math.cos(ia) * R * 0.3, ly + Math.sin(ia) * R * 0.3, R * rng.range(0.15, 0.24)]; }
    feats.push((x, y) => {
      const dx = x - lx, dy = y - ly;
      let v = R * g(Math.atan2(dy, dx)) - Math.hypot(dx, dy) + R * 0.12 * nzl.fbm(x / lamL, y / lamL, 3);
      if (isl) v = Math.min(v, Math.hypot(x - isl[0], y - isl[1]) - isl[2]);
      return v;
    });
    ctx.lake = { x: lx, y: ly, R };
    if (o.bridges > 0 || rng.chance(0.5)) {
      const oa = a + rng.range(-0.8, 0.8), dx = Math.cos(oa), dy = Math.sin(oa);
      addRiver(lx + dx * R * 0.5, ly + dy * R * 0.5, lx + dx * W * 1.3, ly + dy * W * 1.3, baseW * 0.55, Math.max(50, W * 0.05), false);
    }
  } else if (o.water === 'islands') {
    const cx = W / 2 + rng.range(-0.05, 0.05) * W, cy = H / 2 + rng.range(-0.05, 0.05) * H;
    const R0 = W * rng.range(0.29, 0.34);
    const g0 = harmonics(rng, 3, 0.13);
    const blobs = [[cx, cy, R0, g0]];
    const K = S >= 2.5 ? rng.int(3, 4) : rng.int(2, 3);
    const a0 = rng.range(0, TAU);
    for (let k = 0; k < K; k++) {
      const a = a0 + k * TAU / K + rng.range(-0.3, 0.3);
      const Rk = W * rng.range(0.13, 0.2), gk = harmonics(rng, 3, 0.1);
      const gap = rng.range(45, 130) * (0.8 + 0.15 * S);
      const d = R0 * g0(a) + Rk * gk(a + Math.PI) + gap;
      blobs.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d, Rk, gk]);
    }
    ctx.islandBlobs = blobs;
    const nzi = makeNoise2D(rng.int(1, 2 ** 30)), lamI = W * 0.12, ampI = W * 0.035;
    feats.push((x, y) => {
      let m = -Infinity;
      for (const [bx, by, R, g] of blobs) {
        const dx = x - bx, dy = y - by, v = R * g(Math.atan2(dy, dx)) - Math.hypot(dx, dy);
        if (v > m) m = v;
      }
      return -m - ampI * nzi.fbm(x / lamI, y / lamI, 3);
    });
  }
  ctx.waterPolys = [];
  ctx.shoreLoops = [];
  if (!feats.length) return;
  const f = feats.length === 1 ? feats[0] : (x, y) => { let m = -Infinity; for (const g of feats) { const v = g(x, y); if (v > m) m = v; } return m; };
  ctx.waterF = f;
  const step = S <= 2 ? 6 : 8;
  const loops = traceContours(f, W, H, step);
  const outers = [], holes = [];
  for (const raw of loops) {
    const A = polySignedArea(raw);
    if (Math.abs(A) < 600) continue;
    const sg = A >= 0 ? 1 : -1, n = raw.length;
    let wet = 0, dry = 0;
    const stride = Math.max(2, 2 * Math.floor(n / 2 / 40));
    for (let i = 0; i < n; i += stride) {
      const j = (i + 2) % n;
      const ex = raw[j] - raw[i], ey = raw[j + 1] - raw[i + 1], L = Math.hypot(ex, ey);
      if (L < 1e-6) continue;
      const tx = (raw[i] + raw[j]) / 2 - ey / L * sg * step * 0.25, ty = (raw[i + 1] + raw[j + 1]) / 2 + ex / L * sg * step * 0.25;
      if (tx < 1 || ty < 1 || tx > W - 1 || ty > H - 1) continue;
      if (f(tx, ty) > 0) wet++; else dry++;
    }
    const isOuter = wet + dry ? wet > dry : f(...polyCentroid(raw)) > 0;
    const p = simplify(raw, 0.9);
    if (p.length < 8) continue;
    (isOuter ? outers : holes).push(p);
    ctx.shoreLoops.push({ p, landSign: (polySignedArea(p) >= 0 ? 1 : -1) * (isOuter ? -1 : 1) });
  }
  const groups = outers.map(p => ({ p, holes: [], area: polyArea(p), bb: polyBBox(p) }));
  for (const h of holes) {
    let best = null;
    for (const g of groups) {
      if (h[0] < g.bb[0] || h[0] > g.bb[2] || h[1] < g.bb[1] || h[1] > g.bb[3]) continue;
      if (pointInPoly(g.p, h[0], h[1]) && (!best || g.area < best.area)) best = g;
    }
    if (best) best.holes.push(h);
  }
  for (const g of groups) {
    const merged = clipPolyRect(mergeHoles(g.p, g.holes), 0, 0, W, H);
    if (merged.length >= 6 && polyArea(merged) > 300) ctx.waterPolys.push(merged);
  }
  for (const p of ctx.waterPolys) stampPoly(ctx.occ, p, WATER, 0);
}

// Marching squares on a padded grid (outside the map counts as land) -> closed loops.
function traceContours(f, W, H, g) {
  const nx = Math.ceil(W / g) + 3, ny = Math.ceil(H / g) + 3;
  const vals = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = (j - 1) * g;
    for (let i = 0; i < nx; i++) {
      const x = (i - 1) * g;
      let v = x < 0 || y < 0 || x > W || y > H ? -50 : f(x, y);
      if (v === 0) v = 1e-4;
      vals[j * nx + i] = v;
    }
  }
  const ptX = (e) => { const c = e >> 1, i = c % nx, j = (c / nx) | 0; if (e & 1) return (i - 1) * g; const va = vals[c], vb = vals[c + 1]; return (i - 1 + va / (va - vb)) * g; };
  const ptY = (e) => { const c = e >> 1, i = c % nx, j = (c / nx) | 0; if (!(e & 1)) return (j - 1) * g; const va = vals[c], vb = vals[c + nx]; return (j - 1 + va / (va - vb)) * g; };
  const segA = [], segB = [];
  const e1 = new Int32Array(nx * ny * 2).fill(-1), e2 = new Int32Array(nx * ny * 2).fill(-1);
  const link = (e, s) => { if (e1[e] < 0) e1[e] = s; else e2[e] = s; };
  const add = (a, b) => { const s = segA.length; segA.push(a); segB.push(b); link(a, s); link(b, s); };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const c = j * nx + i;
      const a = vals[c] > 0, b = vals[c + 1] > 0, cc = vals[c + nx + 1] > 0, d = vals[c + nx] > 0;
      if (a === b && b === cc && cc === d) continue;
      const T = 2 * c, B = 2 * (c + nx), L = 2 * c + 1, R = 2 * (c + 1) + 1;
      const es = [];
      if (a !== b) es.push(T);
      if (b !== cc) es.push(R);
      if (d !== cc) es.push(B);
      if (a !== d) es.push(L);
      if (es.length === 2) add(es[0], es[1]);
      else if (es.length === 4) {
        const centre = (vals[c] + vals[c + 1] + vals[c + nx + 1] + vals[c + nx]) / 4 > 0;
        if (centre === a) { add(T, R); add(B, L); } else { add(T, L); add(R, B); }
      }
    }
  }
  const used = new Uint8Array(segA.length);
  const loops = [];
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const start = segA[s0];
    const p = [ptX(start), ptY(start)];
    let key = segB[s0], cur = s0, guard = 0;
    while (key !== start && guard++ < 1e7) {
      p.push(ptX(key), ptY(key));
      const nxt = e1[key] === cur ? e2[key] : e1[key];
      if (nxt < 0 || used[nxt]) break;
      used[nxt] = 1;
      key = segA[nxt] === key ? segB[nxt] : segA[nxt];
      cur = nxt;
    }
    if (p.length >= 8) loops.push(p);
  }
  return loops;
}

function buildLandGrid(ctx) {
  const { W, H, occ } = ctx;
  const zgw = Math.ceil(W / ZG_CELL), zgh = Math.ceil(H / ZG_CELL);
  const land = new Uint8Array(zgw * zgh);
  const src = new Uint8Array(zgw * zgh);
  let n = 0;
  for (let j = 0; j < zgh; j++) {
    for (let i = 0; i < zgw; i++) {
      const w = occAt(occ, (i + 0.5) * ZG_CELL, (j + 0.5) * ZG_CELL) === WATER;
      land[j * zgw + i] = w ? 0 : 1;
      src[j * zgw + i] = w ? 1 : 0;
      if (!w) n++;
    }
  }
  ctx.zg = { gw: zgw, gh: zgh, land, wdist: distField(src, zgw, zgh, ZG_CELL), zone: new Uint8Array(zgw * zgh), dist: new Int16Array(zgw * zgh) };
  ctx.landKm2 = (n * ZG_CELL * ZG_CELL) / 1e6;
}
function distField(src, gw, gh, cell) {
  const d = new Float32Array(gw * gh);
  const BIG = 1e9, D = 1.41421356;
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : BIG;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    let v = d[i];
    if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
    if (y > 0) {
      if (d[i - gw] + 1 < v) v = d[i - gw] + 1;
      if (x > 0 && d[i - gw - 1] + D < v) v = d[i - gw - 1] + D;
      if (x < gw - 1 && d[i - gw + 1] + D < v) v = d[i - gw + 1] + D;
    }
    d[i] = v;
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x;
    let v = d[i];
    if (x < gw - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
    if (y < gh - 1) {
      if (d[i + gw] + 1 < v) v = d[i + gw] + 1;
      if (x < gw - 1 && d[i + gw + 1] + D < v) v = d[i + gw + 1] + D;
      if (x > 0 && d[i + gw - 1] + D < v) v = d[i + gw - 1] + D;
    }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= BIG ? 1e6 : d[i] * cell;
  return d;
}
function zgIndex(ctx, x, y) {
  const z = ctx.zg;
  const i = clamp((x / ZG_CELL) | 0, 0, z.gw - 1), j = clamp((y / ZG_CELL) | 0, 0, z.gh - 1);
  return j * z.gw + i;
}
const isLand = (ctx, x, y) => x >= 0 && y >= 0 && x <= ctx.W && y <= ctx.H && ctx.zg.land[zgIndex(ctx, x, y)] === 1;
const waterDist = (ctx, x, y) => ctx.zg.wdist[zgIndex(ctx, x, y)];

// ================================================================= centre, rail

function chooseCentre(ctx) {
  const { W, H, S, o } = ctx, rng = ctx.rng.fork('centre');
  const minDw = o.water === 'none' ? 0 : 80 + 30 * S;
  const R = 200 + 60 * S;
  let best = null, bs = -Infinity;
  const spread = ctx.metro ? 0.18 : 0.3;
  for (let k = 0; k < 320; k++) {
    const x = W * (0.5 + rng.range(-spread, spread)), y = H * (0.5 + rng.range(-spread, spread));
    if (!isLand(ctx, x, y)) continue;
    const dw = waterDist(ctx, x, y);
    if (dw < minDw) continue;
    let land = 0, tot = 0;
    for (const r of [R * 0.5, R]) for (let a = 0; a < 12; a++) { tot++; if (isLand(ctx, x + Math.cos(a * TAU / 12) * r, y + Math.sin(a * TAU / 12) * r)) land++; }
    const lf = land / tot;
    if (lf < 0.68) continue;
    let s = -dist(x, y, W / 2, H / 2) / W + lf * 0.3;
    if (o.water !== 'none' && dw < minDw + 380) s += 0.12;
    if (s > bs) { bs = s; best = [x, y]; }
  }
  [ctx.cx, ctx.cy] = best || [W / 2, H / 2];
  const d = ctx.dens, Sc = ctx.metro ? 4 + (S - 4) * 0.25 : S;
  ctx.Rd = (140 + 120 * Sc) * (0.65 + 0.7 * d);
  ctx.Rmid = ctx.Rd + (300 + 230 * Sc) * (0.4 + 0.9 * d);
  ctx.hTop = 40 + (60 + 120 * d) * Math.min(1, 0.35 + 0.2 * S);
  ctx.theta0 = rng.range(-Math.PI / 4, Math.PI / 4);
  const a = ctx.Rd * rng.range(1.0, 1.2), b = ctx.Rd * rng.range(0.72, 0.92), ch = Math.min(a, b) * rng.range(0.2, 0.38);
  const loc = [-a + ch, -b, a - ch, -b, a, -b + ch, a, b - ch, a - ch, b, -a + ch, b, -a, b - ch, -a, -b + ch];
  const c = Math.cos(ctx.theta0), s = Math.sin(ctx.theta0);
  ctx.dtPoly = cpoly(toWorld(loc, ctx.cx, ctx.cy, c, s, -s, c));
}

function planRail(ctx) {
  const best = railLine(ctx, ctx.rng.fork('rail'), null);
  ctx.rail = [];
  if (!best) return;
  addRail(ctx, best);
  // a metro gets a second line well away from the first
  if (ctx.metro) { const second = railLine(ctx, ctx.rng.fork('rail2'), best); if (second) addRail(ctx, second); }
}

function addRail(ctx, pts) {
  const { W, H } = ctx, n0 = ctx.rail.length;
  for (const piece of clipLineRect(pts, -2, -2, W + 2, H + 2)) {
    for (const q of cutByWater(ctx, piece)) ctx.rail.push(q);
  }
  for (let k = n0; k < ctx.rail.length; k++) stampLine(ctx.occ, ctx.rail[k], 18, RAIL, 2);
}

function railLine(ctx, rng, avoid) {
  const { W, H, cx, cy, Rd, occ } = ctx;
  const edgePt = (e, t) => [[t * W, -200], [W + 200, t * H], [t * W, H + 200], [-200, t * H]][e];
  let best = null, bs = Infinity;
  for (let k = 0; k < 36; k++) {
    const e1 = rng.int(0, 3), e2 = (e1 + (rng.chance(0.65) ? 2 : rng.chance(0.5) ? 1 : 3)) % 4;
    const A = edgePt(e1, rng.range(0.08, 0.92)), B = edgePt(e2, rng.range(0.08, 0.92));
    const L = dist(A[0], A[1], B[0], B[1]), px = -(B[1] - A[1]) / L, py = (B[0] - A[0]) / L;
    const off = (Rd + rng.range(60, 320)) * rng.sign();
    const M = [cx + px * off, cy + py * off];
    const a1 = Math.atan2(M[1] - A[1], M[0] - A[0]), a2 = Math.atan2(B[1] - M[1], B[0] - M[0]);
    let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = TAU - turn;
    if (turn > 0.85) continue;
    const pts = catmull([[2 * A[0] - M[0], 2 * A[1] - M[1]], A, M, B, [2 * B[0] - M[0], 2 * B[1] - M[1]]], 15);
    let wl = 0, minD = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (occAt(occ, pts[i], pts[i + 1]) === WATER) wl++;
      minD = Math.min(minD, dist(pts[i], pts[i + 1], cx, cy));
    }
    let score = wl * 40 + turn * 250 + Math.abs(minD - Rd - 120) * 0.3 + rng.range(0, 60);
    if (avoid) {
      let close = 0;
      for (let i = 0; i < pts.length; i += 8) for (let j = 0; j < avoid.length; j += 16) if (dist(pts[i], pts[i + 1], avoid[j], avoid[j + 1]) < W * 0.12) { close++; break; }
      score += close * 60;
    }
    if (score < bs) { bs = score; best = pts; }
  }
  return best;
}

// ================================================================= motorways
// An edge-to-edge motorway that bypasses the core (two on a metro sheet). It is planned like the railway, before the
// streets; once the main roads exist it goes up on viaducts (z 1) around every crossing with them, the railway, the
// other motorway and water, and over the whole inner city, with 90 m ramps. At-grade stretches cut the local streets.
// One crossing is an underpass (the main road dips under), and one or two get diamond interchanges.
function planMotorways(ctx) {
  ctx.mways = [];
  const { o, S, W, H } = ctx;
  if (!o.motorways || S < 3) return;
  const n = S >= 6 ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const pts = motorwayLine(ctx, ctx.rng.fork('mway' + k), ctx.mways.map(m => m.p));
    if (!pts) continue;
    let best = null;
    for (const piece of clipLineRect(pts, -2, -2, W + 2, H + 2)) if (!best || polyLen(piece) > polyLen(best)) best = piece;
    if (!best || polyLen(best) < 600) continue;
    const nm = ctx.rng.fork('mway-name' + k);
    ctx.mways.push({ p: best, k, name: `${nm.pick(['North', 'South', 'East', 'West', 'Outer', 'Valley', 'Lowland'])} ${nm.pick(['Motorway', 'Expressway', 'Freeway', 'Parkway'])}` });
    stampLine(ctx.occ, best, MWAY_W + 10, MWAY, 2);
  }
}

function motorwayLine(ctx, rng, avoid) {
  const { W, H, cx, cy, Rd, occ } = ctx;
  const edgePt = (e, t) => [[t * W, -300], [W + 300, t * H], [t * W, H + 300], [-300, t * H]][e];
  const rails = ctx.rail || [];
  let best = null, bs = Infinity;
  for (let k = 0; k < 40; k++) {
    const e1 = rng.int(0, 3), e2 = (e1 + (rng.chance(0.7) ? 2 : rng.chance(0.5) ? 1 : 3)) % 4;
    const A = edgePt(e1, rng.range(0.12, 0.88)), B = edgePt(e2, rng.range(0.12, 0.88));
    const L = dist(A[0], A[1], B[0], B[1]), px = -(B[1] - A[1]) / L, py = (B[0] - A[0]) / L;
    const off = (Rd + rng.range(260, 620)) * rng.sign();
    const M = [cx + px * off, cy + py * off];
    const a1 = Math.atan2(M[1] - A[1], M[0] - A[0]), a2 = Math.atan2(B[1] - M[1], B[0] - M[0]);
    let turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = TAU - turn;
    if (turn > 0.9) continue;
    const pts = catmull([[2 * A[0] - M[0], 2 * A[1] - M[1]], A, M, B, [2 * B[0] - M[0], 2 * B[1] - M[1]]], 20);
    let wl = 0, minD = Infinity, near = 0;
    for (let i = 0; i < pts.length; i += 2) {
      if (occAt(occ, pts[i], pts[i + 1]) === WATER) wl++;
      minD = Math.min(minD, dist(pts[i], pts[i + 1], cx, cy));
    }
    for (const line of [...rails, ...avoid]) {
      for (let i = 0; i < pts.length; i += 6) for (let j = 0; j + 3 < line.length; j += 2) {
        if (distToSeg(pts[i], pts[i + 1], line[j], line[j + 1], line[j + 2], line[j + 3]) < 90) { near++; break; }
      }
    }
    const score = wl * 12 + turn * 220 + Math.abs(minD - Rd - 380) * 0.25 + near * 25 + rng.range(0, 80);
    if (score < bs) { bs = score; best = pts; }
  }
  return best;
}

// Points every `step` metres along p, with their arc lengths.
function resampleLine(p, step) {
  const out = [p[0], p[1]], cum = [0];
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const L = dist(p[i], p[i + 1], p[i + 2], p[i + 3]), n = Math.max(1, Math.round(L / step));
    for (let k = 1; k <= n; k++) { out.push(p[i] + (p[i + 2] - p[i]) * k / n, p[i + 1] + (p[i + 3] - p[i + 1]) * k / n); cum.push(acc + L * k / n); }
    acc += L;
  }
  return { p: out, cum, L: acc };
}

// Crossings of polyline p (with arc lengths cum) by polyline q: [{ s, x, y, ux, uy (q's direction) }].
function crossingsOf(p, cum, q) {
  const out = [];
  for (let j = 0; j + 3 < q.length; j += 2) {
    const qx0 = Math.min(q[j], q[j + 2]), qx1 = Math.max(q[j], q[j + 2]), qy0 = Math.min(q[j + 1], q[j + 3]), qy1 = Math.max(q[j + 1], q[j + 3]);
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (Math.max(p[i], p[i + 2]) < qx0 || Math.min(p[i], p[i + 2]) > qx1 || Math.max(p[i + 1], p[i + 3]) < qy0 || Math.min(p[i + 1], p[i + 3]) > qy1) continue;
      const t = segIntersect(p[i], p[i + 1], p[i + 2], p[i + 3], q[j], q[j + 1], q[j + 2], q[j + 3]);
      if (t < 0) continue;
      const L = dist(q[j], q[j + 1], q[j + 2], q[j + 3]) || 1;
      out.push({ s: cum[i >> 1] + (cum[(i >> 1) + 1] - cum[i >> 1]) * t, x: p[i] + (p[i + 2] - p[i]) * t, y: p[i + 1] + (p[i + 3] - p[i + 1]) * t,
        ux: (q[j + 2] - q[j]) / L, uy: (q[j + 3] - q[j + 1]) / L });
    }
  }
  return out;
}

function elevateMotorways(ctx) {
  if (!ctx.mways.length) return;
  const { cx, cy, Rmid, occ } = ctx;
  const majors = ctx.roads.filter(r => r.cls === 'art' || r.cls === 'ring' || r.cls === 'ave');
  for (const mw of ctx.mways) {
    const R = resampleLine(mw.p, 10), p = R.p, cum = R.cum, L = R.L, n = cum.length;
    const iv = [];
    const raise = (a, b, z = 1) => iv.push([Math.max(0, a), Math.min(L, b), z]);
    const mc = [];
    for (const r of majors) for (const c of crossingsOf(p, cum, r.p)) { c.road = r; mc.push(c); }
    const hard = [];
    for (const line of ctx.rail || []) for (const c of crossingsOf(p, cum, line)) hard.push(c.s);
    for (const other of ctx.mways) {
      if (other === mw) continue;
      for (const c of crossingsOf(p, cum, other.p)) { hard.push(c.s); if (mw.k > 0) raise(c.s - 140, c.s + 140, 2); }
    }
    let wet = -1;
    for (let k = 0; k < n; k++) {
      const w = occAt(occ, p[2 * k], p[2 * k + 1]) === WATER;
      if (w && wet < 0) wet = cum[k];
      if ((!w || k === n - 1) && wet >= 0) { raise(wet - 140, cum[k] + 140); hard.push(wet, cum[k]); wet = -1; }
    }
    let inner = -1;
    for (let k = 0; k < n; k++) {
      const inside = dist(p[2 * k], p[2 * k + 1], cx, cy) < Rmid;
      if (inside && inner < 0) inner = cum[k];
      if ((!inside || k === n - 1) && inner >= 0) { raise(inner, cum[k]); inner = -1; }
    }
    for (const s of hard) raise(s - 140, s + 140);
    // one main-road crossing away from everything else becomes an underpass; one or two others get interchanges
    const lone = (c, d) => !hard.some(s => Math.abs(s - c.s) < d) && !mc.some(o => o !== c && Math.abs(o.s - c.s) < d) && dist(c.x, c.y, cx, cy) > Rmid + 200;
    const steep = c => { const k = Math.min(n - 2, Math.max(0, cum.findIndex(v => v >= c.s) - 1)), tx = p[2 * k + 2] - p[2 * k], ty = p[2 * k + 3] - p[2 * k + 1], tl = Math.hypot(tx, ty) || 1; return Math.abs(tx / tl * c.uy - ty / tl * c.ux) > 0.6; };
    const cand = mc.filter(c => c.s > 300 && c.s < L - 300 && steep(c));
    mw.under = null;
    const u = cand.filter(c => lone(c, 450)).sort((a, b) => a.s - b.s)[0];
    if (u) mw.under = u;
    mw.ics = [];
    const want = ctx.S >= 6 ? 2 : 1;
    const ics = cand.filter(c => c !== u && c.s > 420 && c.s < L - 420 && !hard.some(s => Math.abs(s - c.s) < 360)).sort((a, b) =>
      Math.abs(dist(a.x, a.y, cx, cy) - Rmid - 500) - Math.abs(dist(b.x, b.y, cx, cy) - Rmid - 500) || a.s - b.s);
    for (const c of ics) {
      if (mw.ics.length >= want) break;
      if (mw.ics.some(o => Math.abs(o.s - c.s) < 900)) continue;
      if (mw.under && Math.abs(mw.under.s - c.s) < 700) continue;
      mw.ics.push(c);
    }
    for (const c of mc) {
      if (c === mw.under) continue;
      const half = mw.ics.includes(c) ? 330 : 140;
      raise(c.s - half, c.s + half);
    }
    // merge raised stretches closer than 350 m; the higher tier of two overlapping stretches wins inside it
    iv.sort((a, b) => a[0] - b[0]);
    const runs = [];
    for (const [a, b, z] of iv) {
      const last = runs[runs.length - 1];
      if (last && a - last[1] < 350 && last[2] === 1 && z === 1) last[1] = Math.max(last[1], b);
      else runs.push([a, b, z]);
    }
    const RAMP = 90;
    const zAtS = (s) => {
      let z = 0;
      for (const [a, b, t] of runs) {
        const ramp = RAMP * t;
        const v = s >= a && s <= b ? t : s < a ? t * (1 - (a - s) / ramp) : t * (1 - (s - b) / ramp);
        if (v > z) z = v;
      }
      return Math.round(Math.max(0, z) * 10) / 10;
    };
    const zs = cum.map(zAtS);
    const sp = simplifyZ(p, zs, 0.4);
    mw.rp = p; mw.rcum = cum; mw.L = L;
    mw.p = sp.p; mw.z = sp.z.some(v => v !== 0) ? sp.z : null; mw.zAtS = zAtS;
    // viaduct stretches no longer cut the local streets: they pass underneath
    for (let k = 0; k + 1 < n; k++) if (zAtS(cum[k]) >= 0.5 && zAtS(cum[k + 1]) >= 0.5) stampLine(occ, [p[2 * k], p[2 * k + 1], p[2 * k + 2], p[2 * k + 3]], MWAY_W + 10, ROAD, 3);
  }
}

// Point and direction at arc length s along polyline p (cum = its arc lengths per vertex).
function alongLine(p, cum, s) {
  const n = cum.length;
  let k = 0;
  while (k < n - 2 && cum[k + 1] < s) k++;
  const L = cum[k + 1] - cum[k] || 1, t = clamp((s - cum[k]) / L, 0, 1);
  const x = p[2 * k] + (p[2 * k + 2] - p[2 * k]) * t, y = p[2 * k + 1] + (p[2 * k + 3] - p[2 * k + 1]) * t;
  return [x, y, (p[2 * k + 2] - p[2 * k]) / L, (p[2 * k + 3] - p[2 * k + 1]) / L];
}

function cumOf(p) { const c = [0]; for (let i = 0; i + 3 < p.length; i += 2) c.push(c[c.length - 1] + dist(p[i], p[i + 1], p[i + 2], p[i + 3])); return c; }

// The motorways go into the road list after the streets were clipped; then the underpass and the slip roads.
function layMotorways(ctx) {
  const { occ } = ctx;
  for (const mw of ctx.mways) {
    ctx.roads.push({ p: mw.p, z: mw.z, w: MWAY_W, k: 'major', cls: 'mway', name: mw.name });
    if (mw.under) underpass(ctx, mw, mw.under);
    for (const c of mw.ics) interchange(ctx, mw, c);
  }
  function underpass(ctx2, mw, c) {
    let best = null, bd = 30;
    for (const r of ctx2.roads) {
      if (r.z || !(r.cls === 'art' || r.cls === 'ring' || r.cls === 'ave')) continue;
      const cum = cumOf(r.p);
      for (const q of crossingsOf(r.p, cum, mw.rp)) { const d = dist(q.x, q.y, c.x, c.y); if (d < bd) { bd = d; best = { r, s: q.s, cum }; } }
    }
    if (!best) { mw.under = null; return; }
    const { r, s } = best, L = best.cum[best.cum.length - 1];
    if (s < 120 || s > L - 120) { mw.under = null; return; }
    const R2 = resampleLine(r.p, 6), zs = R2.cum.map(v => { const d = Math.abs(v - s); return d <= 40 ? -1 : d >= 110 ? 0 : -Math.round((1 - (d - 40) / 70) * 10) / 10; });
    const sp = simplifyZ(R2.p, zs, 0.3);
    r.p = sp.p; r.z = sp.z;
  }
  function interchange(ctx2, mw, c) {
    let road = null, sa = 0, ca = null, bd = 30;
    for (const r of ctx2.roads) {
      if (r.z || !(r.cls === 'art' || r.cls === 'ring' || r.cls === 'ave')) continue;
      const cum = cumOf(r.p);
      for (const q of crossingsOf(r.p, cum, mw.rp)) { const d = dist(q.x, q.y, c.x, c.y); if (d < bd) { bd = d; road = r; sa = q.s; ca = cum; } }
    }
    if (!road) return;
    const La = ca[ca.length - 1];
    let made = 0;
    for (const sv of [-1, 1]) {
      const sP = sa + sv * 75;
      if (sP < 5 || sP > La - 5) continue;
      const [px, py] = alongLine(road.p, ca, sP);
      for (const su of [-1, 1]) {
        const [x0, y0, tx, ty] = alongLine(mw.rp, mw.rcum, c.s + su * 290), [x1, y1] = alongLine(mw.rp, mw.rcum, c.s + su * 130);
        const nx = -ty, ny = tx, side = (px - c.x) * nx + (py - c.y) * ny >= 0 ? 1 : -1, o0 = 16 * side, o1 = 28 * side;
        const q = [x0 + nx * o0, y0 + ny * o0, x1 + nx * o1, y1 + ny * o1, px, py];
        let wet = false;
        for (let k = 0; k <= 20 && !wet; k++) { const [wx, wy] = alongLine(q, cumOf(q), polyLen(q) * k / 20); if (occAt(occ, wx, wy) === WATER) wet = true; }
        if (wet) continue;
        ctx2.roads.push({ p: q, z: [1, 0, 0], w: 8, k: 'major', cls: 'slip', name: mw.name + ' Slip' });
        made++;
      }
    }
    if (!made) mw.ics = mw.ics.filter(o => o !== c);
  }
}

// Two to four satellite town centres out in the suburbs of a metro sheet, each a few blocks of mid-rise streets.
function chooseSatellites(ctx) {
  if (!ctx.metro) return;
  const { W, H, S, cx, cy, Rmid, o } = ctx, rng = ctx.rng.fork('metro-sats');
  const n = S >= 9 ? 4 : 3, a0 = rng.range(0, TAU);
  for (let k = 0; k < n; k++) {
    let best = null, bs = -Infinity;
    for (let t = 0; t < 60; t++) {
      const a = a0 + (k + rng.range(-0.35, 0.35)) * TAU / n, r = Rmid + rng.range(650, 1500);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (x < 450 || y < 450 || x > W - 450 || y > H - 450 || !isLand(ctx, x, y)) continue;
      const dw = waterDist(ctx, x, y);
      if (o.water !== 'none' && dw < 140) continue;
      let land = 0;
      for (let q = 0; q < 8; q++) if (isLand(ctx, x + Math.cos(q * TAU / 8) * 380, y + Math.sin(q * TAU / 8) * 380)) land++;
      if (land < 6 || ctx.sats.some(sv => dist(x, y, sv.x, sv.y) < 1800)) continue;
      const sc = land + Math.min(dw, 600) / 300 + rng.range(0, 1.5);
      if (sc > bs) { bs = sc; best = { x, y, R: rng.range(380, 520) }; }
    }
    if (best) ctx.sats.push(best);
  }
}

// Split a polyline where it comes within `clear` metres (sideways) of water or hits a blocked cell.
// Pieces are trimmed by `trim` metres at every cut so road caps stay off the water.
// Returns { pieces: [{ p, cutStart, cutEnd }], runs: [{ a, b, pts }] } where runs are water crossings between two pieces.
function cutClear(ctx, p, clear, trim, blocked) {
  const occ = ctx.occ;
  const pieces = [], runs = [];
  let cur = null, lx = 0, ly = 0, startCut = false, wrun = null, wet = false;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const L = dist(ax, ay, bx, by);
    if (L < 1e-6) continue;
    const nx = -(by - ay) / L * clear, ny = (bx - ax) / L * clear;
    const n = Math.max(1, Math.ceil(L / 2));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
      const c = occAt(occ, x, y);
      const water = c === WATER || occAt(occ, x + nx, y + ny) === WATER || occAt(occ, x - nx, y - ny) === WATER;
      if (water || c === 255 || (blocked && blocked(c))) {
        if (cur) {
          if (cur[cur.length - 2] !== lx || cur[cur.length - 1] !== ly) cur.push(lx, ly);
          pieces.push({ p: cur, cutStart: startCut, cutEnd: water });
          cur = null;
          if (water) wrun = { a: [lx, ly], pts: [], piece: pieces.length - 1 };
        }
        wet = water;
        if (wrun) { if (water) wrun.pts.push(x, y); else wrun = null; }
        continue;
      }
      if (wrun) { runs.push({ a: wrun.a, b: [x, y], pts: [wrun.a[0], wrun.a[1], ...wrun.pts, x, y], before: wrun.piece, after: pieces.length }); wrun = null; }
      if (!cur) { cur = [x, y]; startCut = wet; } else if (k === n) cur.push(x, y);
      lx = x; ly = y; wet = false;
    }
  }
  if (cur) pieces.push({ p: cur, cutStart: startCut, cutEnd: false });
  const capWet = (x, y) => {
    if (occAt(occ, x, y) === WATER) return true;
    for (let a = 0; a < 8; a++) if (occAt(occ, x + Math.cos(a * TAU / 8) * clear, y + Math.sin(a * TAU / 8) * clear) === WATER) return true;
    return false;
  };
  for (const pc of pieces) {
    if (pc.cutStart) pc.p = trimPolyline(pc.p, trim, true);
    if (pc.cutEnd && pc.p) pc.p = trimPolyline(pc.p, trim, false);
    for (let g = 0; g < 8 && pc.p && capWet(pc.p[0], pc.p[1]); g++) pc.p = trimPolyline(pc.p, 2.5, true);
    for (let g = 0; g < 8 && pc.p && capWet(pc.p[pc.p.length - 2], pc.p[pc.p.length - 1]); g++) pc.p = trimPolyline(pc.p, 2.5, false);
  }
  return { pieces, runs };
}

function trimPolyline(p, d, fromStart) {
  if (!p || p.length < 4) return null;
  if (fromStart) { const r = trimPolyline(reverseLine(p), d, false); return r ? reverseLine(r) : null; }
  const q = p.slice();
  let left = d;
  while (q.length >= 4) {
    const n = q.length, ax = q[n - 4], ay = q[n - 3], bx = q[n - 2], by = q[n - 1];
    const L = dist(ax, ay, bx, by);
    if (L > left) { const t = (L - left) / L; q[n - 2] = ax + (bx - ax) * t; q[n - 1] = ay + (by - ay) * t; return q; }
    left -= L;
    q.length = n - 2;
  }
  return null;
}
function reverseLine(p) { const out = []; for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]); return out; }

function cutByWater(ctx, p) {
  return cutClear(ctx, p, 7, 6, null).pieces.map(pc => pc.p).filter(q => q && q.length >= 4 && polyLen(q) > 30).map(q => simplify(q, 0.5));
}

// ================================================================= districts

function voronoi(seeds, domain, reach) {
  return seeds.map(([sx, sy], i) => {
    let P = domain.map(([x, y]) => ({ x, y, lab: -1 }));
    for (let j = 0; j < seeds.length && P.length >= 3; j++) {
      if (j === i) continue;
      const [tx, ty] = seeds[j];
      if (Math.abs(tx - sx) > reach || Math.abs(ty - sy) > reach) continue;
      const nx = tx - sx, ny = ty - sy, c = nx * (sx + tx) / 2 + ny * (sy + ty) / 2;
      const out = [];
      for (let k = 0; k < P.length; k++) {
        const A = P[k], B = P[(k + 1) % P.length];
        const da = A.x * nx + A.y * ny - c, db = B.x * nx + B.y * ny - c;
        if (da <= 0) {
          out.push(A);
          if (db > 0) { const t = da / (da - db); out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, lab: j }); }
        } else if (db <= 0) { const t = da / (da - db); out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, lab: A.lab }); }
      }
      P = out;
    }
    return P;
  });
}

function planDistricts(ctx) {
  const { W, H, S, o, cx, cy, Rd, Rmid } = ctx, rng = ctx.rng.fork('districts');
  const sp = 380 + 70 * (ctx.metro ? 5 : S), m = sp * 0.6;
  const x0 = -m, y0 = -m, x1 = W + m, y1 = H + m;
  const nx = Math.max(2, Math.round((x1 - x0) / sp)), ny = Math.max(2, Math.round((y1 - y0) / sp));
  const sx = (x1 - x0) / nx, sy = (y1 - y0) / ny;
  let seeds = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    seeds.push([x0 + (i + 0.5 + rng.range(-0.38, 0.38)) * sx, y0 + (j + 0.5 + rng.range(-0.38, 0.38)) * sy]);
  }
  const domain = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  let cells = voronoi(seeds, domain, sp * 3);
  seeds = cells.map(c => polyCentroid(c.flatMap(v => [v.x, v.y])));
  cells = voronoi(seeds, domain, sp * 3);
  const dt = ctx.dtPoly;
  const ds = ctx.districts = cells.map((c, i) => {
    const p = c.flatMap(v => [v.x, v.y]);
    const [ccx, ccy] = polyCentroid(p);
    const bb = polyBBox(p);
    let inMap = 0, land = 0, inDt = 0, tot = 0;
    for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) {
      const x = lerp(bb[0], bb[2], (a + 0.5) / 9), y = lerp(bb[1], bb[3], (b + 0.5) / 9);
      if (!pointInPoly(p, x, y)) continue;
      tot++;
      if (pointInPoly(dt.p, x, y)) inDt++;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      inMap++;
      if (isLand(ctx, x, y)) land++;
    }
    return {
      i, seed: seeds[i], verts: c, poly: cpoly(p), cx: ccx, cy: ccy, d: dist(ccx, ccy, cx, cy), area: polyArea(p),
      land: inMap ? land / inMap : 0, inMap: tot ? inMap / tot : 0, inDt: tot ? inDt / tot : 0,
      style: 'none', zone: SUB, theta: 0, requests: [], name: ctx.names.district(),
    };
  });
  const live = d => d.style !== 'none';
  for (const d of ds) {
    if (d.inMap < 0.02 || d.land < 0.1 || d.inDt > 0.97) continue;
    if (d.d < Rmid) {
      d.zone = MID; d.style = 'grid';
      d.theta = ctx.theta0 + (rng.chance(0.5) ? 0 : rng.range(-0.3, 0.3));
      d.sA = rng.range(76, 100); d.sB = rng.range(104, 150); d.drop = 0.11;
    } else {
      d.zone = SUB;
      const r = rng.next();
      d.style = r < 0.38 ? 'grid' : r < 0.74 ? 'wavy' : r < 0.92 ? 'loops' : 'organic';
      d.theta = ctx.theta0 + rng.range(-0.7, 0.7);
      d.sA = rng.range(58, 78); d.sB = rng.range(110, 175); d.drop = 0.14;
      if (d.style === 'wavy') { d.sB = rng.range(170, 260); d.amp = rng.range(10, 0.28 * d.sA); d.lam = rng.range(200, 380); d.phase = rng.range(0, TAU); }
    }
  }
  if (ctx.metro) {
    const mr = ctx.rng.fork('metro-districts');
    for (const d of ds) {
      if (!live(d) || !ctx.sats.some(sv => dist(d.cx, d.cy, sv.x, sv.y) < sv.R + sp * 0.35)) continue;
      d.zone = MID; d.style = 'grid'; d.sat = true;
      d.theta = ctx.theta0 + mr.range(-0.8, 0.8);
      d.sA = mr.range(72, 96); d.sB = mr.range(100, 140); d.drop = 0.12;
    }
  }
  ctx.oldTown = null;
  if (rng.chance(0.7)) {
    const cand = ds.filter(d => live(d) && d.zone === MID && d.inDt < 0.45 && d.land > 0.6).sort((a, b) => a.d - b.d)[0];
    if (cand) { cand.style = 'organic'; cand.zone = OLD; ctx.oldTown = cand; }
  }
  const outer = ds.filter(d => live(d) && d.d > Rd + 250 && d.zone !== OLD && !d.sat);
  const nInd = Math.max(S >= 1.5 ? 1 : rng.chance(0.5) ? 1 : 0, Math.round(outer.length * 0.16));
  const railD = (x, y) => { let b = Infinity; for (const r of ctx.rail) for (let i = 0; i < r.length; i += 8) b = Math.min(b, dist(x, y, r[i], r[i + 1])); return b; };
  for (const d of outer) {
    const edge = Math.min(d.cx, d.cy, W - d.cx, H - d.cy) < sp * 0.5 ? 0.6 : 0;
    d.indScore = (railD(d.cx, d.cy) < 420 ? 2 : 0) + (o.water !== 'none' && waterDist(ctx, d.cx, d.cy) < 260 ? 0.8 : 0) + edge + (d.d > Rmid ? 0.6 : 0) + rng.range(0, 1);
  }
  outer.sort((a, b) => b.indScore - a.indScore);
  for (const d of outer.slice(0, nInd)) {
    d.zone = IND; d.style = 'grid'; d.theta = ctx.theta0 + rng.range(-0.5, 0.5);
    d.sA = rng.range(130, 190); d.sB = rng.range(170, 260); d.drop = 0.2;
  }
  const nPark = ctx.metro ? Math.round(S * S / 18) : S >= 2.5 ? 1 + (S >= 4 ? 1 : 0) : 0;
  const parkC = ds.filter(d => live(d) && !d.sat && (d.zone === MID || d.zone === SUB) && d.d > Rd * 0.9 && d.d < Rmid * (ctx.metro ? 1.8 : 1.3) && d.land > 0.9 && d.inDt < 0.1 && d.inMap > 0.95);
  rng.shuffle(parkC);
  for (const d of parkC.slice(0, nPark)) { d.style = 'park'; d.zone = PRK; }
  if (ctx.metro) {
    // a broken green belt of commons and woods out towards the sheet edge
    const gr = ctx.rng.fork('metro-green');
    for (const d of ds) if (live(d) && !d.sat && d.zone === SUB && d.d > Rmid + 900 && d.land > 0.8 && gr.chance(0.12)) { d.style = 'park'; d.zone = PRK; }
  }

  // big-site requests (reservations aligned to street blocks)
  const grids = ds.filter(d => d.style === 'grid' && d.inMap > 0.9 && d.land > 0.85);
  const want = (kind, bu, bv, filter, n) => {
    const c = grids.filter(filter);
    rng.shuffle(c);
    for (let k = 0; k < n; k++) for (const d of c) { d.requests.push({ kind, bu, bv, alt: true, group: kind + k }); }
  };
  ctx.dtReq = [{ kind: 'plaza', bu: 1, bv: 1 }, { kind: 'park', bu: 1, bv: 1 }];
  if (S >= 2) want('stadium', 2, 2, d => d.zone !== IND && d.d > Rd * 1.1, ctx.metro ? 2 : 1);
  want('hospital', 1, 2, d => d.zone === MID || d.zone === SUB, Math.max(1, Math.round(ctx.landKm2 / 5)));
  if (S >= 1.5) want('mall', 1, 2, d => d.zone === SUB || d.zone === MID, 1 + (S >= 4 ? 1 : 0) + (ctx.metro ? ctx.sats.length : 0));
  if (S >= 3 && rng.chance(0.6)) want('park', 2, 3, d => d.zone === MID, 1);
  for (const d of grids) if (d.zone === MID && rng.chance(0.45)) d.requests.push({ kind: 'park', bu: 1, bv: 1 });
  for (const d of grids) if (d.zone === SUB && rng.chance(0.25)) d.requests.push({ kind: 'park', bu: 1, bv: 1 });
}

// ================================================================= streets (unwarped plan)

const LOC_W = { [DT]: 9.5, [MID]: 8, [OLD]: 6, [SUB]: 6.5, [IND]: 10, [PRK]: 3 };

function layStreets(ctx) {
  const rng = ctx.rng.fork('streets');
  const R = ctx.uroads = [];
  const dt = ctx.dtPoly;
  ctx.doneGroups = new Set();
  // small sheets get narrower trunk roads, so the few big roads do not eat the town
  const trunk = clamp(0.8 + 0.1 * ctx.S, 0.9, 1);
  ctx.trunk = trunk;
  R.push({ p: closeRing(dt.p), w: 16 * trunk, k: 'major', cls: 'ring', name: ctx.names.street(true) });
  const dtd = { poly: dt, zone: DT, theta: ctx.theta0, sA: rng.range(86, 110), sB: rng.range(104, 140), drop: 0.04, aveEvery: rng.int(3, 4), requests: ctx.dtReq, minus: [] };
  gridStreets(ctx, dtd, rng);
  for (const d of ctx.districts) {
    for (let k = 0; k < d.verts.length; k++) {
      const v = d.verts[k], j = v.lab;
      if (j <= d.i) continue;
      const e = ctx.districts[j];
      if (d.style === 'none' && e.style === 'none') continue;
      const w = d.verts[(k + 1) % d.verts.length];
      const nm = ctx.names.street(true), wid = rng.range(12, 15) * trunk;
      for (const piece of clipPolyline([v.x, v.y, w.x, w.y], null, [dt])) if (polyLen(piece) > 4) R.push({ p: piece, w: wid, k: 'major', cls: 'art', name: nm });
    }
  }
  if (ctx.metro) {
    const rr = ctx.rng.fork('metro-orbital');
    const R0 = ctx.Rmid + rr.range(220, 420), g = harmonics(rr, 3, 0.07), pts = [];
    for (let k = 0; k < 180; k++) { const a = k / 180 * TAU, r = R0 * g(a); pts.push(ctx.cx + Math.cos(a) * r, ctx.cy + Math.sin(a) * r); }
    const nm = ctx.name.split(' ')[0] + ' Orbital';
    for (const piece of clipPolyline(closeRing(pts), null, [dt])) if (polyLen(piece) > 4) R.push({ p: piece, w: 17 * trunk, k: 'major', cls: 'art', name: nm });
  }
  for (const d of ctx.districts) {
    if (d.style === 'none') continue;
    d.minus = [dt];
    if (d.style === 'grid' || d.style === 'wavy') gridStreets(ctx, d, rng);
    else if (d.style === 'organic') organicStreets(ctx, d, rng);
    else if (d.style === 'loops') loopStreets(ctx, d, rng);
    else if (d.style === 'park') parkDistrict(ctx, d, rng);
  }
}

function gridStreets(ctx, d, rng) {
  const c = Math.cos(d.theta), s = Math.sin(d.theta);
  const P = d.poly.p;
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < P.length; i += 2) {
    const u = P[i] * c + P[i + 1] * s, v = -P[i] * s + P[i + 1] * c;
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const vs = [], us = [];
  for (let v = vmin + d.sA * rng.range(0.25, 0.75); v < vmax - 8; v += d.sA * rng.range(0.88, 1.12)) vs.push(v);
  for (let u = umin + d.sB * rng.range(0.25, 0.75); u < umax - 8; u += d.sB * rng.range(0.88, 1.12)) us.push(u);
  if (!vs.length || !us.length) return;
  const amp = d.style === 'wavy' ? d.amp : 0, lam = d.lam || 1, ph = d.phase || 0;
  const wv = u => (amp ? amp * Math.sin(TAU * u / lam + ph) : 0);
  const ub = [umin - 6, ...us, umax + 6], vbFor = j => [vmin - 6 - amp, ...vs.map(v => v + wv(us[j])), vmax + 6 + amp];
  const NA = vs.length, NB = us.length;
  const keepA = vs.map(() => new Uint8Array(NB + 1).fill(1)), keepB = us.map(() => new Uint8Array(NA + 1).fill(1));
  const prot = { A: vs.map(() => new Uint8Array(NB + 1)), B: us.map(() => new Uint8Array(NA + 1)) };
  const pathA = vs.map(() => new Uint8Array(NB + 1)), pathB = us.map(() => new Uint8Array(NA + 1));
  const toW = (u, v) => [u * c - v * s, u * s + v * c];
  const usedBlk = new Set();
  const locW = LOC_W[d.zone];
  const kindsHere = new Set();
  for (const req of amp ? [] : d.requests) {
    if (req.group && (ctx.doneGroups.has(req.group) || kindsHere.has(req.kind))) continue;
    const cands = [];
    for (let j = 0; j + req.bu < NB; j++) for (let k = 0; k + req.bv < NA; k++) {
      let clash = false;
      for (let a = j - 1; a <= j + req.bu && !clash; a++) for (let b = k - 1; b <= k + req.bv; b++) if (usedBlk.has(a * 1000 + b)) { clash = true; break; }
      if (clash) continue;
      const u0 = us[j], u1 = us[j + req.bu], v0 = vs[k], v1 = vs[k + req.bv];
      if ((u1 - u0) * (v1 - v0) > 200000) continue;
      let ok = true;
      for (let a = 0; a <= 4 && ok; a++) for (let b = 0; b <= 4; b++) {
        const [x, y] = toW(lerp(u0, u1, a / 4), lerp(v0, v1, b / 4));
        if (!pointInPoly(d.poly.p, x, y) || d.minus.some(m => pointInPoly(m.p, x, y))) { ok = false; break; }
        const [wx, wy] = ctx.warpFwd(x, y);
        const oc = occAt(ctx.occ, wx, wy);
        if (oc !== FREE) { ok = false; break; }
      }
      if (!ok) continue;
      const [mx, my] = toW((u0 + u1) / 2, (v0 + v1) / 2);
      cands.push([j, k, dist(mx, my, d.cx ?? ctx.cx, d.cy ?? ctx.cy) + rng.range(0, 120) + (req.kind === 'plaza' ? dist(mx, my, ctx.cx, ctx.cy) * 2 : 0)]);
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a[2] - b[2]);
    const [j0, k0] = cands[0];
    if (req.group) { ctx.doneGroups.add(req.group); kindsHere.add(req.kind); }
    for (let a = j0; a < j0 + req.bu; a++) for (let b = k0; b < k0 + req.bv; b++) usedBlk.add(a * 1000 + b);
    const toPath = req.kind === 'park';
    for (let k = k0 + 1; k < k0 + req.bv; k++) for (let j = j0 + 1; j <= j0 + req.bu; j++) { keepA[k][j] = 0; if (toPath && rng.chance(0.6)) pathA[k][j] = 1; }
    for (let j = j0 + 1; j < j0 + req.bu; j++) for (let k = k0 + 1; k <= k0 + req.bv; k++) { keepB[j][k] = 0; if (toPath && rng.chance(0.6)) pathB[j][k] = 1; }
    for (const k of [k0, k0 + req.bv]) for (let j = j0; j <= j0 + req.bu + 1; j++) if (j <= NB) prot.A[k][j] = 1;
    for (const j of [j0, j0 + req.bu]) for (let k = k0; k <= k0 + req.bv + 1; k++) if (k <= NA) prot.B[j][k] = 1;
    const ins = locW / 2 + 3;
    const corners = [[us[j0] + ins, vs[k0] + ins], [us[j0 + req.bu] - ins, vs[k0] + ins], [us[j0 + req.bu] - ins, vs[k0 + req.bv] - ins], [us[j0] + ins, vs[k0 + req.bv] - ins]];
    ctx.reserves.push({ kind: req.kind, zone: d.zone, theta: d.theta, uc: corners.map(([u, v]) => toW(u, v)), district: d });
  }
  const isAve = (idx) => d.aveEvery && idx % d.aveEvery === 1;
  for (let k = 0; k < NA; k++) for (let j = 0; j <= NB; j++) if (!prot.A[k][j] && !isAve(k) && rng.chance(d.drop)) keepA[k][j] = 0;
  for (let j = 0; j < NB; j++) for (let k = 0; k <= NA; k++) if (!prot.B[j][k] && !isAve(j) && rng.chance(d.drop * 1.3)) keepB[j][k] = 0;
  const emit = (pts, w, k, cls, name) => {
    for (const piece of clipPolyline(pts, d.poly, d.minus)) if (polyLen(piece) > 6) ctx.uroads.push({ p: piece, w, k, cls, name });
  };
  const runs = (keep, path, n, build) => {
    let start = -1;
    for (let j = 0; j <= n + 1; j++) {
      const on = j <= n && keep[j];
      if (on && start < 0) start = j;
      if (!on && start >= 0) { build(start, j - 1, false); start = -1; }
      if (j <= n && path[j]) build(j, j, true);
    }
  };
  for (let k = 0; k < NA; k++) {
    const nm = ctx.names.street(isAve(k));
    runs(keepA[k], pathA[k], NB, (j0, j1, isPath) => {
      const ua = ub[j0], ubb = ub[j1 + 1], pts = [];
      const n = amp ? Math.max(2, Math.ceil((ubb - ua) / 14)) : 1;
      for (let q = 0; q <= n; q++) { const u = lerp(ua, ubb, q / n); pts.push(...toW(u, vs[k] + wv(u))); }
      if (isPath) emit(pts, 3, 'path', 'path');
      else if (isAve(k)) emit(pts, 15 * ctx.trunk, 'major', 'ave', nm);
      else emit(pts, locW, 'minor', 'loc', nm);
    });
  }
  for (let j = 0; j < NB; j++) {
    const nm = ctx.names.street(isAve(j)), vb = vbFor(j);
    runs(keepB[j], pathB[j], NA, (k0, k1, isPath) => {
      const pts = [...toW(us[j], vb[k0]), ...toW(us[j], vb[k1 + 1])];
      if (isPath) emit(pts, 3, 'path', 'path');
      else if (isAve(j)) emit(pts, 15 * ctx.trunk, 'major', 'ave', nm);
      else emit(pts, locW, 'minor', 'loc', nm);
    });
  }
}

function organicStreets(ctx, d, rng) {
  const target = d.zone === OLD ? rng.range(3800, 6500) : rng.range(6500, 11000);
  const leaves = [];
  const stack = [[d.poly.p, 0]];
  const projExt = (P, a) => { const c = Math.cos(a), s = Math.sin(a); let lo = Infinity, hi = -Infinity; for (let i = 0; i < P.length; i += 2) { const t = P[i] * c + P[i + 1] * s; lo = Math.min(lo, t); hi = Math.max(hi, t); } return hi - lo; };
  while (stack.length) {
    const [P, depth] = stack.pop();
    const A = polyArea(P);
    if (A < target * rng.range(0.75, 1.4) || depth > 16) { leaves.push(P); continue; }
    let bw = -1, ba = 0;
    for (let k = 0; k < 12; k++) { const a = k * Math.PI / 12, e = projExt(P, a); if (e > bw) { bw = e; ba = a; } }
    let done = false;
    for (let t = 0; t < 4 && !done; t++) {
      const ang = ba + Math.PI / 2 + rng.range(-0.28, 0.28);
      const [gx, gy] = polyCentroid(P), f = rng.range(-0.17, 0.17) * bw;
      const px = gx + Math.cos(ba) * f, py = gy + Math.sin(ba) * f, dx = Math.cos(ang), dy = Math.sin(ang);
      const [P1, P2] = splitConvex(P, px, py, dx, dy);
      if (!P1 || !P2 || polyArea(P1) < target * 0.35 || polyArea(P2) < target * 0.35) continue;
      if (minWidth(P1) < 34 || minWidth(P2) < 34) continue;
      const iv = segInConvex(px - dx * 5000, py - dy * 5000, px + dx * 5000, py + dy * 5000, P, polySignedArea(P) >= 0 ? 1 : -1);
      if (!iv) continue;
      const chord = [px - dx * 5000 + dx * 10000 * iv[0], py - dy * 5000 + dy * 10000 * iv[0], px - dx * 5000 + dx * 10000 * iv[1], py - dy * 5000 + dy * 10000 * iv[1]];
      const w = d.zone === OLD ? (depth <= 1 ? 9 : 6) : (depth <= 1 ? 9 : 7);
      for (const piece of clipPolyline(chord, null, d.minus)) if (polyLen(piece) > 6) ctx.uroads.push({ p: piece, w, k: 'minor', cls: 'loc', name: ctx.names.street(false) });
      stack.push([P1, depth + 1], [P2, depth + 1]);
      done = true;
    }
    if (!done) leaves.push(P);
  }
  if (d.zone === OLD) {
    let best = null, bs = Infinity;
    for (const L of leaves) {
      const [gx, gy] = polyCentroid(L), A = polyArea(L);
      if (A < target * 0.6 || A > target * 2.5 || d.minus.some(m => pointInPoly(m.p, gx, gy))) continue;
      const sc = dist(gx, gy, d.cx, d.cy);
      if (sc < bs) { bs = sc; best = L; }
    }
    if (best) {
      const q = insetConvex(best, 6);
      if (q) ctx.reserves.push({ kind: 'oldplaza', zone: OLD, theta: 0, up: q, district: d });
    }
  }
}

function minWidth(P) {
  let best = Infinity;
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 12, c = Math.cos(a), s = Math.sin(a);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < P.length; i += 2) { const t = P[i] * c + P[i + 1] * s; if (t < lo) lo = t; if (t > hi) hi = t; }
    if (hi - lo < best) best = hi - lo;
  }
  return best;
}

function loopStreets(ctx, d, rng) {
  const sp = rng.range(72, 92);
  const [gx, gy] = polyCentroid(d.poly.p);
  let innermost = null;
  const rings = rng.int(2, 3);
  for (let m = 0; m < rings; m++) {
    const Q = insetConvex(d.poly.p, sp * (m + 0.95));
    if (!Q || polyArea(Q) < sp * sp * 1.4) break;
    innermost = Q;
    const ring = closeRing(chaikin(Q, 3, true));
    for (const piece of clipPolyline(ring, null, d.minus)) if (polyLen(piece) > 20) ctx.uroads.push({ p: piece, w: 7, k: 'minor', cls: 'loc', name: ctx.names.street(false) });
    if (m > 0) {
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const i = 2 * rng.int(0, ring.length / 2 - 2);
        const x = ring[i], y = ring[i + 1], L = dist(x, y, gx, gy) || 1, len = Math.min(sp * 0.42, L * 0.5);
        ctx.uroads.push({ p: [x, y, x + (gx - x) / L * len, y + (gy - y) / L * len], w: 6, k: 'minor', cls: 'loc' });
      }
    }
  }
  if (innermost && polyArea(innermost) > sp * sp * 2.5) {
    const a = rng.range(0, Math.PI), [qx, qy] = polyCentroid(innermost), w = Math.sqrt(polyArea(innermost));
    for (let k = -1; k <= 1; k++) {
      const ox = -Math.sin(a) * k * sp, oy = Math.cos(a) * k * sp;
      const line = [qx + ox - Math.cos(a) * w * 2, qy + oy - Math.sin(a) * w * 2, qx + ox + Math.cos(a) * w * 2, qy + oy + Math.sin(a) * w * 2];
      for (const piece of clipPolyline(line, cpoly(innermost), d.minus)) if (polyLen(piece) > 30) ctx.uroads.push({ p: piece, w: 7, k: 'minor', cls: 'loc', name: ctx.names.street(false) });
    }
  }
  const K = rng.int(4, 5), a0 = rng.range(0, TAU);
  for (let k = 0; k < K; k++) {
    if (rng.chance(0.2)) continue;
    const a = a0 + k * TAU / K + rng.range(-0.3, 0.3);
    const ray = [gx, gy, gx + Math.cos(a) * 3000, gy + Math.sin(a) * 3000];
    for (const piece of clipPolyline(ray, d.poly, d.minus)) if (polyLen(piece) > 20) ctx.uroads.push({ p: piece, w: 7.5, k: 'minor', cls: 'loc', name: ctx.names.street(false) });
  }
}

function parkDistrict(ctx, d, rng) {
  const q = insetConvex(d.poly.p, 10);
  if (!q) return;
  ctx.reserves.push({ kind: 'parkpoly', zone: PRK, theta: 0, up: chaikin(q, 2, true), district: d });
  const [gx, gy] = polyCentroid(q);
  const inner = cpoly(insetConvex(d.poly.p, 4) || q);
  for (let k = 0; k < 3; k++) {
    const a = rng.range(0, Math.PI), c = Math.cos(a), s = Math.sin(a), amp = rng.range(10, 30), lam = rng.range(150, 300), ph = rng.range(0, TAU);
    const pts = [];
    for (let t = -1500; t <= 1500; t += 15) { const o = amp * Math.sin(TAU * t / lam + ph); pts.push(gx + c * t - s * o, gy + s * t + c * o); }
    for (const piece of clipPolyline(pts, inner, [])) if (polyLen(piece) > 30) ctx.uroads.push({ p: piece, w: 3, k: 'path', cls: 'path' });
  }
  if (rng.chance(0.6)) {
    const r = clamp(Math.sqrt(d.area) * rng.range(0.07, 0.11), 25, 90);
    ctx.ponds.push({ x: gx + rng.range(-0.1, 0.1) * Math.sqrt(d.area), y: gy + rng.range(-0.1, 0.1) * Math.sqrt(d.area), r, g: harmonics(rng, 3, 0.18) });
  }
}

// ================================================================= warp + zones

function makeWarp(ctx) {
  const rng = ctx.rng.fork('warp');
  const n1 = makeNoise2D(rng.int(1, 2 ** 30)), n2 = makeNoise2D(rng.int(1, 2 ** 30));
  const amax = rng.range(30, 50), lam = rng.range(550, 800), r0 = ctx.Rd * 0.9, r1 = ctx.Rd * 1.8;
  const { cx, cy } = ctx;
  return (x, y) => {
    const a = amax * smoothstep(r0, r1, dist(x, y, cx, cy));
    let dx = 0, dy = 0;
    if (a >= 0.01) { dx = a * n1.fbm(x / lam, y / lam, 2); dy = a * n2.fbm(x / lam + 31.7, y / lam - 11.3, 2); }
    const ot = ctx.oldTown;
    if (ot) {
      const R = Math.sqrt(ot.area / Math.PI), b = 11 * (1 - smoothstep(R * 0.55, R * 1.05, dist(x, y, ot.cx, ot.cy)));
      if (b > 0.01) { dx += b * n1(x / 130 + 7.1, y / 130); dy += b * n2(x / 130, y / 130 - 3.3); }
    }
    return [dx, dy];
  };
}

function setupWarp(ctx) {
  const disp = makeWarp(ctx);
  ctx.warpDisp = disp;
  ctx.warpFwd = (x, y) => { const [dx, dy] = disp(x, y); return [x + dx, y + dy]; };
}

function warpAll(ctx) {
  const disp = ctx.warpDisp;
  const fwd = (p) => {
    const q = subdivide(p, 14);
    for (let i = 0; i < q.length; i += 2) { const [dx, dy] = disp(q[i], q[i + 1]); q[i] += dx; q[i + 1] += dy; }
    return q.length > 4 ? simplify(q, 0.35) : q;
  };
  const clipR = clipLineRect;
  for (const r of ctx.uroads) {
    for (const p of clipR(fwd(r.p), -1, -1, ctx.W + 1, ctx.H + 1)) ctx.roads.push({ ...r, p });
  }
  ctx.uroads = null;
  for (const rs of ctx.reserves) {
    if (rs.uc) { rs.corners = rs.uc.map(([x, y]) => ctx.warpFwd(x, y)); rs.p = fwd(closeRing(rs.uc.flat())).slice(0, -2); }
    else rs.p = fwd(closeRing(rs.up)).slice(0, -2);
  }
  for (const pd of ctx.ponds) [pd.x, pd.y] = ctx.warpFwd(pd.x, pd.y);
}

function buildZoneGrid(ctx) {
  const z = ctx.zg, ds = ctx.districts, disp = ctx.warpDisp, dt = ctx.dtPoly.p;
  const sx = ds.map(d => d.seed[0]), sy = ds.map(d => d.seed[1]);
  let last = 0;
  for (let j = 0; j < z.gh; j++) {
    for (let i = 0; i < z.gw; i++) {
      const x = (i + 0.5) * ZG_CELL, y = (j + 0.5) * ZG_CELL;
      let [dx, dy] = disp(x, y);
      [dx, dy] = disp(x - dx, y - dy);
      const ux = x - dx, uy = y - dy, idx = j * z.gw + i;
      let bi = last, bd = (sx[last] - ux) ** 2 + (sy[last] - uy) ** 2;
      for (let k = 0; k < sx.length; k++) { const dd = (sx[k] - ux) ** 2 + (sy[k] - uy) ** 2; if (dd < bd) { bd = dd; bi = k; } }
      last = bi;
      z.dist[idx] = bi;
      if (pointInPoly(dt, ux, uy)) z.zone[idx] = DT;
      else { const d = ds[bi]; z.zone[idx] = d.style === 'none' ? SUB : d.zone; }
    }
  }
}
const zoneAt = (ctx, x, y) => ctx.zg.zone[zgIndex(ctx, x, y)];
const districtAt = (ctx, x, y) => ctx.districts[ctx.zg.dist[zgIndex(ctx, x, y)]];

// ================================================================= clipping, embankments, bridges

const FRONT_CLS = { ring: 0, ave: 1, art: 2, emb: 3, loc: 4 };

function clipRoads(ctx) {
  const out = [];
  const isRail = c => c === RAIL || c === MWAY;
  for (const r of ctx.roads) {
    const major = r.cls === 'art' || r.cls === 'ring' || r.cls === 'ave';
    const trim = r.w / 2 + 2;
    const { pieces, runs } = cutClear(ctx, r.p, r.w / 2 + 2.5, trim, major ? null : isRail);
    for (const pc of pieces) if (pc.p && pc.p.length >= 4 && polyLen(pc.p) > 8) out.push({ ...r, p: simplify(pc.p, 0.3) });
    if (!major) continue;
    for (const run of runs) {
      const L = polyLen(run.pts);
      if (L < 650 && L > 6) ctx.cands.push({ pts: run.pts, len: L, w: r.w, name: r.name, a: run.a, b: run.b, ext: trim + 2 });
    }
  }
  ctx.roads = out;
  for (const r of ctx.rail) ctx.roads.push({ p: r, w: 8, k: 'rail', cls: 'rail' });
}

function addEmbankments(ctx) {
  if (!ctx.shoreLoops.length) return;
  const { W, H, occ } = ctx, rng = ctx.rng.fork('emb');
  const reach = ctx.o.water === 'river' ? ctx.Rmid + 450 : ctx.Rmid;
  const OFF = 13;
  const added = [];
  for (const L of ctx.shoreLoops) {
    const p = subdivide(closeRing(L.p), 12);
    const n = p.length / 2;
    let run = [];
    const end = () => { if (run.length >= 4) { const q = chaikin(run, 1, false); if (polyLen(q) > 110) added.push(q); } run = []; };
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const tx = p[2 * b] - p[2 * a], ty = p[2 * b + 1] - p[2 * a + 1], tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl * L.landSign, ny = tx / tl * L.landSign;
      const x = p[2 * i] + nx * OFF, y = p[2 * i + 1] + ny * OFF;
      let ok = x > 4 && y > 4 && x < W - 4 && y < H - 4 && dist(x, y, ctx.cx, ctx.cy) < reach
        && occAt(occ, x, y) !== WATER && occAt(occ, x, y) !== RAIL
        && occAt(occ, p[2 * i] - nx * 3, p[2 * i + 1] - ny * 3) === WATER;
      for (let a = 0; ok && a < 8; a++) if (occAt(occ, x + Math.cos(a * TAU / 8) * 8, y + Math.sin(a * TAU / 8) * 8) === WATER) ok = false;
      if (ok) {
        if (run.length >= 2 && dist(run[run.length - 2], run[run.length - 1], x, y) > 30) end();
        run.push(x, y);
      } else end();
    }
    end();
  }
  for (const q of added) ctx.roads.push({ p: simplify(q, 0.5), w: 9, k: 'minor', cls: 'emb', name: ctx.names.street(false).replace(/ \w+$/, rng.chance(0.5) ? ' Quay' : ' Embankment') });
}

function stampRoads(ctx, roads) {
  const occ = ctx.occ;
  for (const r of roads) {
    if (r.k === 'rail') continue;
    const side = r.cls === 'path' ? 0.5 : zoneAt(ctx, r.p[0], r.p[1]) === DT ? 2.5 : 1.8;
    stampLine(occ, r.p, r.w + side * 2, ROAD, r.k === 'bridge' ? 0 : 2);
  }
}

function buildBridges(ctx) {
  const n = ctx.o.bridges;
  ctx.bridgeCount = 0;
  if (!n || !ctx.waterPolys.length) return;
  const { W, H, cx, cy, zg } = ctx, rng = ctx.rng.fork('bridges');
  const comp = new Int32Array(zg.gw * zg.gh).fill(-1), compSize = [];
  const q = new Int32Array(zg.gw * zg.gh);
  for (let s = 0; s < comp.length; s++) {
    if (!zg.land[s] || comp[s] >= 0) continue;
    const id = compSize.length;
    let h = 0, t = 0;
    q[t++] = s; comp[s] = id;
    while (h < t) {
      const i = q[h++], x = i % zg.gw, y = (i / zg.gw) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < zg.gw - 1 ? i + 1 : -1, y > 0 ? i - zg.gw : -1, y < zg.gh - 1 ? i + zg.gw : -1];
      for (const j of nb) if (j >= 0 && zg.land[j] && comp[j] < 0) { comp[j] = id; q[t++] = j; }
    }
    compSize.push(t * ZG_CELL * ZG_CELL);
  }
  const compAt = (x, y) => {
    for (const r of [0, 6, 12]) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const c = comp[zgIndex(ctx, x + dx, y + dy)];
      if (c >= 0) return c;
    }
    return -1;
  };
  const inside = (x, y, m) => x > m && y > m && x < W - m && y < H - m;
  const cands = ctx.cands.filter(c => inside(c.a[0], c.a[1], 30) && inside(c.b[0], c.b[1], 30));
  for (const c of cands) {
    c.ca = compAt(c.a[0], c.a[1]); c.cb = compAt(c.b[0], c.b[1]);
    const m = Math.floor(c.pts.length / 4) * 2;
    c.mx = c.pts[m]; c.my = c.pts[m + 1]; c.dc = dist(c.mx, c.my, cx, cy);
  }
  for (const c of synthBridges(ctx, rng)) {
    c.synth = true; c.w = 12;
    c.ca = compAt(c.a[0], c.a[1]); c.cb = compAt(c.b[0], c.b[1]); c.dc = dist(c.mx, c.my, cx, cy);
    cands.push(c);
  }
  for (let i = cands.length - 1; i >= 0; i--) if (!singleSpan(ctx, cands[i])) cands.splice(i, 1);
  const par = compSize.map((_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const big = c => c >= 0 && compSize[c] > 40000;
  const chosen = [];
  const minDistTo = (x, y) => { let b = Infinity; for (const c of chosen) b = Math.min(b, dist(x, y, c.mx, c.my)); return b; };
  const crosses = c => chosen.some(o => {
    const a = o.pts, b = c.pts, gap = ((o.w || 12) + (c.w || 12)) / 2 + 12;
    for (let i = 0; i + 3 < a.length; i += 2) for (let j = 0; j + 3 < b.length; j += 2) {
      if (segIntersect(a[i], a[i + 1], a[i + 2], a[i + 3], b[j], b[j + 1], b[j + 2], b[j + 3]) >= 0) return true;
    }
    for (const [P, Q] of [[a, b], [b, a]]) for (let i = 0; i < P.length; i += 2) {
      for (let j = 0; j + 3 < Q.length; j += 2) if (distToSeg(P[i], P[i + 1], Q[j], Q[j + 1], Q[j + 2], Q[j + 3]) < gap) return true;
    }
    return false;
  });
  const sorted = cands.slice().sort((a, b) => (a.len + 0.12 * a.dc + (a.synth ? 80 : 0)) - (b.len + 0.12 * b.dc + (b.synth ? 80 : 0)));
  for (const c of sorted) {
    if (chosen.length >= n) break;
    if (!big(c.ca) || !big(c.cb) || find(c.ca) === find(c.cb) || minDistTo(c.mx, c.my) < 60 || crosses(c)) continue;
    par[find(c.ca)] = find(c.cb);
    chosen.push(c);
  }
  for (const pool of [cands.filter(c => !c.synth), cands]) {
    for (const need of [180, 70, 30]) {
      while (chosen.length < n) {
        let best = null, bs = -Infinity;
        for (const c of pool) {
          if (chosen.includes(c) || c.ca < 0 || c.cb < 0) continue;
          const md = minDistTo(c.mx, c.my);
          if (md < need || crosses(c)) continue;
          const sc = Math.min(md, 900) - 0.35 * c.dc - 0.8 * c.len;
          if (sc > bs) { bs = sc; best = c; }
        }
        if (!best) break;
        chosen.push(best);
      }
    }
  }
  const newRoads = [];
  for (const c of chosen) {
    const nm = c.name || ctx.names.street(true);
    newRoads.push({ p: extendEnds(c.pts, c.ext || 2), w: c.w, k: 'bridge', cls: 'bridge', name: nm.replace(/ \w+$/, '') + ' Bridge' });
    if (!c.synth) continue;
    for (const [ex, ey, dx, dy] of [[c.a[0], c.a[1], c.a[0] - c.b[0], c.a[1] - c.b[1]], [c.b[0], c.b[1], c.b[0] - c.a[0], c.b[1] - c.a[1]]]) {
      const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      let end = 0;
      for (let s = 3; s <= 240; s += 3) {
        const x = ex + ux * s, y = ey + uy * s, v = occAt(ctx.occ, x, y);
        if (v === ROAD) { end = s + 2; break; }
        const wetSide = occAt(ctx.occ, x - uy * 9, y + ux * 9) === WATER || occAt(ctx.occ, x + uy * 9, y - ux * 9) === WATER;
        if (v === WATER || v === 255 || v === RAIL || (s > 14 && (wetSide || occAt(ctx.occ, x + ux * 8, y + uy * 8) === WATER))) { end = s - 3; break; }
        end = s;
      }
      if (end > 6) newRoads.push({ p: [ex, ey, ex + ux * end, ey + uy * end], w: 12, k: 'major', cls: 'art', name: nm });
    }
  }
  for (const r of newRoads) ctx.roads.push(r);
  stampRoads(ctx, newRoads);
  ctx.bridgeCount = chosen.length;
}
// The simulation turns every road or rail cell (4 m) that lies on water into bridge terrain. Remove the
// segments of ordinary roads / rails that would create such cells away from a real bridge.
function dropStrayBridges(ctx) {
  const { W, H } = ctx, cell = 4, gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const water = new Uint8Array(gw * gh);
  for (const p of ctx.waterPolys) rasterPoly(p, cell, gw, gh, c => { water[c] = 1; });
  // wet road cells grouped 8-connected, as the simulation does; a group is fine when a bridge road is part of it
  const okCell = () => {
    const mark = new Uint8Array(gw * gh);
    for (const r of ctx.roads) {
      if (r.z) continue;   // decks and tunnels never touch the water under them
      const v = r.k === 'bridge' ? 2 : 1, w = Math.max(r.w, cell);
      for (let i = 0; i + 3 < r.p.length; i += 2) rasterSeg(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], w, cell, gw, gh, c => { if (water[c]) mark[c] |= v; });
    }
    const good = new Uint8Array(gw * gh), seen = new Uint8Array(gw * gh), stack = [], group = [];
    for (let s0 = 0; s0 < mark.length; s0++) {
      if (!mark[s0] || seen[s0]) continue;
      let bridged = false;
      group.length = 0; seen[s0] = 1; stack.push(s0);
      while (stack.length) {
        const c = stack.pop(), x = c % gw, y = (c / gw) | 0;
        group.push(c);
        if (mark[c] & 2) bridged = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, n = ny * gw + nx;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && mark[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      if (bridged) for (const c of group) good[c] = 1;
    }
    return good;
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const good = okCell();
    const out = [];
    for (const r of ctx.roads) {
      if (r.k === 'bridge' || r.z) { out.push(r); continue; }
      const w = Math.max(r.w, cell), p = r.p;
      const bad = [];
      for (let i = 0; i + 3 < p.length; i += 2) {
        let hit = false;
        rasterSeg(p[i], p[i + 1], p[i + 2], p[i + 3], w, cell, gw, gh, c => { if (water[c] && !good[c]) hit = true; });
        bad.push(hit);
      }
      if (!bad.includes(true)) { out.push(r); continue; }
      changed = true;
      let cur = null;
      const flush = (trimEnd) => {
        if (!cur) return;
        let q = cur.p;
        if (cur.trimStart) q = trimPolyline(q, w / 2 + 2, true);
        if (q && trimEnd) q = trimPolyline(q, w / 2 + 2, false);
        if (q && q.length >= 4 && polyLen(q) > 8) out.push({ ...r, p: q });
        cur = null;
      };
      for (let i = 0; i < bad.length; i++) {
        if (bad[i]) { flush(true); continue; }
        if (!cur) cur = { p: [p[2 * i], p[2 * i + 1]], trimStart: i > 0 };
        cur.p.push(p[2 * i + 2], p[2 * i + 3]);
      }
      flush(false);
    }
    ctx.roads = out;
    if (!changed) break;
  }
}

// A bridge deck (centre line and both edges, ends extended) may cross only one stretch of water.
function singleSpan(ctx, c) {
  let open = 0;
  for (let i = 0; i + 3 < c.pts.length; i += 2) {
    const ax = c.pts[i], ay = c.pts[i + 1], bx = c.pts[i + 2], by = c.pts[i + 3], L = dist(ax, ay, bx, by), n = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k < n; k++) if (occAt(ctx.occ, ax + (bx - ax) * k / n, ay + (by - ay) * k / n) === WATER) open += L / n;
  }
  if (open < 16) return false;
  const p = extendEnds(c.pts, (c.ext || 2) + 2), hw = (c.w || 12) / 2 + 2;
  for (const side of [-1, 0, 1]) {
    let runs = 0, inWet = false, dry = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3], L = dist(ax, ay, bx, by) || 1;
      const nx = -(by - ay) / L * hw * side, ny = (bx - ax) / L * hw * side;
      const n = Math.max(1, Math.ceil(L / 1.5));
      for (let k = 0; k <= n; k++) {
        const wet = occAt(ctx.occ, ax + (bx - ax) * k / n + nx, ay + (by - ay) * k / n + ny) === WATER;
        if (wet) { if (!inWet && (runs === 0 || dry > 3)) runs++; inWet = true; dry = 0; }
        else { inWet = false; dry += L / n; }
      }
    }
    if (runs > 1) return false;
  }
  return true;
}
function extendEnds(p, e) {
  const q = p.slice(), n = q.length;
  const ax = q[2] - q[0], ay = q[3] - q[1], la = Math.hypot(ax, ay) || 1;
  q[0] -= ax / la * e; q[1] -= ay / la * e;
  const bx = q[n - 2] - q[n - 4], by = q[n - 1] - q[n - 3], lb = Math.hypot(bx, by) || 1;
  q[n - 2] += bx / lb * e; q[n - 1] += by / lb * e;
  return simplify(q, 0.3);
}
function waterRun(ctx, x, y, ux, uy, maxL) { // from a water point, walk both ways to land
  const occ = ctx.occ;
  let a = 0, b = 0;
  while (a < maxL && occAt(occ, x - ux * a, y - uy * a) === WATER) a += 2;
  while (b < maxL && occAt(occ, x + ux * b, y + uy * b) === WATER) b += 2;
  if (a >= maxL || b >= maxL) return null;
  const A = [x - ux * a, y - uy * a], B = [x + ux * b, y + uy * b];
  if (occAt(occ, A[0], A[1]) === 255 || occAt(occ, B[0], B[1]) === 255) return null;
  return { a: A, b: B, pts: [A[0], A[1], B[0], B[1]], len: a + b, mx: (A[0] + B[0]) / 2, my: (A[1] + B[1]) / 2 };
}
function synthBridges(ctx, rng) {
  const { W, H, cx, cy } = ctx, out = [];
  const ok = c => c && c.len < 600 && c.a[0] > 40 && c.a[1] > 40 && c.a[0] < W - 40 && c.a[1] < H - 40 && c.b[0] > 40 && c.b[1] > 40 && c.b[0] < W - 40 && c.b[1] < H - 40;
  for (const r of ctx.rivers) {
    for (let i = 2; i < r.n - 2; i += 3) {
      const x = r.pts[2 * i], y = r.pts[2 * i + 1];
      if (occAt(ctx.occ, x, y) !== WATER) continue;
      const tx = r.pts[2 * i + 2] - r.pts[2 * i - 2], ty = r.pts[2 * i + 3] - r.pts[2 * i - 1], L = Math.hypot(tx, ty) || 1;
      const c = waterRun(ctx, x, y, -ty / L, tx / L, 700);
      if (ok(c)) out.push(c);
    }
  }
  if (ctx.islandBlobs) {
    const B = ctx.islandBlobs;
    for (let i = 1; i < B.length; i++) {
      const [ax, ay] = B[0], [bx, by] = B[i];
      const L = dist(ax, ay, bx, by), ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let k = -4; k <= 4; k++) {
        const ox = -uy * k * 70, oy = ux * k * 70;
        let s = 0;
        while (s < L && occAt(ctx.occ, ax + ox + ux * s, ay + oy + uy * s) !== WATER) s += 4;
        if (s >= L) continue;
        const c = waterRun(ctx, ax + ox + ux * (s + 2), ay + oy + uy * (s + 2), ux, uy, 700);
        if (ok(c)) out.push(c);
      }
    }
  }
  if (ctx.lake) {
    const { x, y, R } = ctx.lake;
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 16, ux = Math.cos(a), uy = Math.sin(a);
      for (const off of [-0.5, 0, 0.5]) {
        const px = x - uy * off * R, py = y + ux * off * R;
        if (occAt(ctx.occ, px, py) !== WATER) continue;
        const c = waterRun(ctx, px, py, ux, uy, 700);
        if (ok(c)) out.push(c);
      }
    }
  }
  for (const c of out) c.score = c.len + 0.25 * dist(c.mx, c.my, cx, cy) + rng.range(0, 40);
  return out.sort((a, b) => a.score - b.score);
}

// ================================================================= buildings: shapes

function shapeLocal(kind, w, d, rng) {
  const hw = w / 2;
  switch (kind) {
    case 'L': { const a = rng.range(0.4, 0.65), b = rng.range(0.35, 0.6), r = rng.chance(0.5);
      return r ? [-hw, 0, hw, 0, hw, d * a, hw - w * b, d * a, hw - w * b, d, -hw, d]
               : [-hw, 0, hw, 0, hw, d, -hw + w * b, d, -hw + w * b, d * a, -hw, d * a]; }
    case 'U': { const wing = w * rng.range(0.24, 0.32), a = rng.range(0.38, 0.55);
      return [-hw, 0, hw, 0, hw, d, hw - wing, d, hw - wing, d * a, -hw + wing, d * a, -hw + wing, d, -hw, d]; }
    case 'T': { const a = rng.range(0.45, 0.6), b = rng.range(0.35, 0.55) * w / 2;
      return [-hw, 0, hw, 0, hw, d * a, b, d * a, b, d, -b, d, -b, d * a, -hw, d * a]; }
    case 'chamfer': { const c = Math.min(w, d) * rng.range(0.18, 0.32);
      return rng.chance(0.5) ? [-hw, 0, hw - c, 0, hw, c, hw, d, -hw, d] : [-hw + c, 0, hw, 0, hw, d, -hw, d, -hw, c]; }
    case 'notch': { const e = Math.min(3, d * 0.15), q = w * rng.range(0.15, 0.25);
      return [-hw, 0, -q, 0, -q, e, q, e, q, 0, hw, 0, hw, d, -hw, d]; }
    case 'slant': return [-hw, 0, hw, 0, hw, d * rng.range(0.7, 0.95), -hw, d];
    case 'octagon': { const r = Math.min(w, d) / 2, c = r * 0.41;
      return [-c, d / 2 - r, c, d / 2 - r, r, d / 2 - c, r, d / 2 + c, c, d / 2 + r, -c, d / 2 + r, -r, d / 2 + c, -r, d / 2 - c]; }
    case 'round': { const r = Math.min(w, d) / 2, n = 14, out = [];
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU; out.push(Math.cos(a) * r, d / 2 + Math.sin(a) * r); }
      return out; }
    case 'cross': { const r = Math.min(w, d) / 2, t = r * rng.range(0.32, 0.42), m = d / 2;
      return [-t, m - r, t, m - r, t, m - t, r, m - t, r, m + t, t, m + t, t, m + r, -t, m + r, -t, m + t, -r, m + t, -r, m - t, -t, m - t]; }
    case 'stepped': { const a = rng.range(0.45, 0.7), d2 = d * rng.range(0.55, 0.8);
      return [-hw, 0, hw, 0, hw, d2, -hw + w * a, d2, -hw + w * a, d, -hw, d]; }
    default: return [-hw, 0, hw, 0, hw, d, -hw, d];
  }
}
function pickShape(rng, zone, tower) {
  const r = rng.next();
  if (tower) return r < 0.5 ? 'rect' : r < 0.7 ? 'chamfer' : r < 0.82 ? 'stepped' : r < 0.88 ? 'L' : r < 0.94 ? 'octagon' : r < 0.97 ? 'round' : 'cross';
  switch (zone) {
    case DT: return r < 0.55 ? 'rect' : r < 0.63 ? 'L' : r < 0.66 ? 'U' : r < 0.82 ? 'notch' : 'chamfer';
    case MID: return r < 0.6 ? 'rect' : r < 0.72 ? 'L' : r < 0.75 ? 'U' : r < 0.78 ? 'T' : 'notch';
    case OLD: return r < 0.55 ? 'rect' : r < 0.8 ? 'slant' : 'L';
    case SUB: return r < 0.62 ? 'rect' : r < 0.92 ? 'L' : 'T';
    case IND: return r < 0.66 ? 'rect' : r < 0.86 ? 'L' : 'stepped';
    default: return 'rect';
  }
}

function addBuilding(ctx, p, h, k, use, zone, extra) {
  const [x, y] = polyCentroid(p);
  const b = { p, h: Math.round(h * 10) / 10, k, use, zone, cx: x, cy: y, area: polyArea(p), art: false, planted: false, ...extra };
  ctx.buildings.push(b);
  return b;
}

// Free-space test / mark in a local frame. Samples every ~1.3 m over [u0,u1]x[v0,v1].
function frameTest(occ, ox, oy, ux, uy, vx, vy, u0, u1, v0, v1, accept) {
  const a = occ.a, gw = occ.gw, gh = occ.gh, inv = occ.inv;
  const nu = Math.max(1, Math.ceil((u1 - u0) / 1.3)), nv = Math.max(1, Math.ceil((v1 - v0) / 1.3));
  for (let j = 0; j <= nv; j++) {
    const v = v0 + (v1 - v0) * j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = u0 + (u1 - u0) * i / nu;
      const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
      if (x < 0 || y < 0) return false;
      const gx = (x * inv) | 0, gy = (y * inv) | 0;
      if (gx >= gw || gy >= gh) return false;
      const c = a[gy * gw + gx];
      if (c !== FREE && !(accept && c === accept)) return false;
    }
  }
  return true;
}
function frameMark(occ, ox, oy, ux, uy, vx, vy, u0, u1, v0, v1, val) {
  const a = occ.a, gw = occ.gw, gh = occ.gh, inv = occ.inv;
  const nu = Math.max(1, Math.ceil((u1 - u0) / 1.3)), nv = Math.max(1, Math.ceil((v1 - v0) / 1.3));
  for (let j = 0; j <= nv; j++) {
    const v = v0 + (v1 - v0) * j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = u0 + (u1 - u0) * i / nu;
      const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
      if (x < 0 || y < 0) continue;
      const gx = (x * inv) | 0, gy = (y * inv) | 0;
      if (gx < gw && gy < gh) a[gy * gw + gx] = val;
    }
  }
}

// ================================================================= planted specials

function plantSpecials(ctx) {
  const rng = ctx.rng.fork('plant');
  const occ = ctx.occ;
  ctx.townHall = null;
  const frameOf = rs => {
    const [c0, c1, , c3] = rs.corners;
    const lu = dist(c0[0], c0[1], c1[0], c1[1]), lv = dist(c0[0], c0[1], c3[0], c3[1]);
    const ox = (rs.corners[0][0] + rs.corners[2][0]) / 2, oy = (rs.corners[0][1] + rs.corners[2][1]) / 2;
    return { ox, oy, ux: (c1[0] - c0[0]) / lu, uy: (c1[1] - c0[1]) / lu, vx: (c3[0] - c0[0]) / lv, vy: (c3[1] - c0[1]) / lv, lu, lv };
  };
  const plantIn = (f, loc, h, k, use, name, du = 0, dv = 0) => {
    const p = toWorld(loc, f.ox + f.ux * du + f.vx * dv, f.oy + f.uy * du + f.vy * dv, f.ux, f.uy, f.vx, f.vy);
    stampPoly(occ, p, BLDG, 1);
    return addBuilding(ctx, p, h, k, use, zoneAt(ctx, f.ox, f.oy), { planted: true, name });
  };
  const keep = p => stampPoly(occ, p, KEEP, 1);
  const park = p => { stampPoly(occ, p, PARK, 1); ctx.parks.push(p); };
  const rect = (w, d) => [-w / 2, -d / 2, w / 2, -d / 2, w / 2, d / 2, -w / 2, d / 2];
  const cent = loc => { const out = loc.slice(); let my = 0; for (let i = 1; i < out.length; i += 2) my += out[i]; my /= out.length / 2; for (let i = 1; i < out.length; i += 2) out[i] -= my; return out; };
  let cathedral = false;
  const hasOld = ctx.reserves.some(r => r.kind === 'oldplaza');
  for (const rs of ctx.reserves) {
    if (rs.kind === 'park' || rs.kind === 'parkpoly') { park(rs.p); continue; }
    if (rs.kind === 'oldplaza') {
      keep(rs.p);
      const bb = polyBBox(rs.p), [gx, gy] = polyCentroid(rs.p);
      let la = 0, lw = 0;
      for (let k = 0; k < 12; k++) {
        const a = k * Math.PI / 12, c = Math.cos(a), s = Math.sin(a);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < rs.p.length; i += 2) { const t = (rs.p[i] - gx) * c + (rs.p[i + 1] - gy) * s; lo = Math.min(lo, t); hi = Math.max(hi, t); }
        if (hi - lo > lw) { lw = hi - lo; la = a; }
      }
      const ux = Math.cos(la), uy = Math.sin(la), vx = -uy, vy = ux;
      const L = clamp(lw * 0.45, 40, 85), wd = L * 0.42;
      const nave = wd * 0.42, tr = L * 0.62;
      const ta = tr - L / 2 - nave * 0.6, tb = tr - L / 2 + nave * 0.6;
      const cross = [-L / 2, -nave / 2, ta, -nave / 2, ta, -wd / 2, tb, -wd / 2, tb, -nave / 2, L / 2, -nave / 2,
        L / 2, nave / 2, tb, nave / 2, tb, wd / 2, ta, wd / 2, ta, nave / 2, -L / 2, nave / 2];
      const off = -lw * 0.12;
      const p = toWorld(cross, gx + ux * off, gy + uy * off, ux, uy, vx, vy);
      if (p.every((v, i) => i % 2 || pointInPoly(rs.p, v, p[i + 1]))) {
        stampPoly(occ, p, BLDG, 1);
        addBuilding(ctx, p, rng.range(48, 72), 'landmark', 'Cathedral', OLD, { planted: true, name: ctx.names.saint() + "'s Cathedral" });
        cathedral = true;
      }
      park(octagon(gx + ux * lw * 0.3, gy + uy * lw * 0.3, Math.min(9, lw * 0.08)));
      continue;
    }
    if (!rs.corners) continue;
    const f = frameOf(rs);
    if (f.lu < 30 || f.lv < 30) { keep(rs.p); continue; }
    keep(rs.p);
    if (rs.kind === 'plaza') {
      const thW = clamp(f.lu * 0.5, 26, 60), thD = clamp(f.lv * 0.32, 18, 34);
      const u = shapeLocal('U', thW, thD, rng);
      ctx.townHall = plantIn(f, cent(u), rng.range(18, 28), 'civic', 'Town Hall', ctx.name + ' Town Hall', 0, -f.lv / 2 + thD / 2 + 4);
      if (!hasOld && !cathedral && f.lv > 60) {
        const L = clamp(f.lv * 0.45, 34, 60), wd = L * 0.4, nave = wd * 0.45;
        const cr = [-nave / 2, -L / 2, nave / 2, -L / 2, nave / 2, -L / 2 + L * 0.3, wd / 2, -L / 2 + L * 0.3, wd / 2, -L / 2 + L * 0.3 + nave, nave / 2, -L / 2 + L * 0.3 + nave, nave / 2, L / 2, -nave / 2, L / 2, -nave / 2, -L / 2 + L * 0.3 + nave, -wd / 2, -L / 2 + L * 0.3 + nave, -wd / 2, -L / 2 + L * 0.3, -nave / 2, -L / 2 + L * 0.3];
        plantIn(f, cr, rng.range(42, 60), 'landmark', 'Cathedral', ctx.names.saint() + "'s Cathedral", f.lu * 0.25, f.lv * 0.18);
        cathedral = true;
      }
      const gp = octagon(f.ox + f.vx * f.lv * 0.15, f.oy + f.vy * f.lv * 0.15, Math.min(f.lu, f.lv) * 0.14);
      park(gp);
    } else if (rs.kind === 'stadium') {
      const rx = Math.min(f.lu, f.lv * 1.35) * 0.42, ry = rx * 0.76;
      plantIn(f, circlePoly(0, 0, rx, ry, 28), rng.range(28, 40), 'landmark', 'Stadium', ctx.name + ' Stadium');
    } else if (rs.kind === 'hospital') {
      const w = Math.min(f.lu - 18, 115), d = Math.min(f.lv * 0.6, 80);
      const main = shapeLocal(rng.chance(0.5) ? 'T' : 'stepped', w, d, rng).map((v, i) => (i % 2 ? v - f.lv / 2 + 8 : v));
      plantIn(f, main, rng.range(22, 40), 'rescue', 'Hospital', districtAt(ctx, f.ox, f.oy).name + ' General Hospital');
      const aw = Math.min(w * 0.45, 45), ad = Math.min(f.lv - d - 30, 34);
      if (ad > 14) plantIn(f, [-aw / 2, -ad / 2, aw / 2, -ad / 2, aw / 2, ad / 2, -aw / 2, ad / 2], rng.range(10, 18), 'com', 'Clinic Annex', null, rng.range(-0.2, 0.2) * w, f.lv / 2 - ad / 2 - 8);
    } else if (rs.kind === 'mall') {
      const w = Math.min(f.lu - 20, 150), d = Math.min(f.lv * 0.55, 95);
      plantIn(f, shapeLocal('notch', w, d, rng).map((v, i) => (i % 2 ? v - d / 2 : v)), rng.range(12, 18), 'trade', 'Shopping Centre', districtAt(ctx, f.ox, f.oy).name + ' Centre', 0, -f.lv / 2 + d / 2 + 6);
    }
  }
  ctx.cathedral = cathedral;
  for (const pd of ctx.ponds) {
    const p = [];
    for (let k = 0; k < 20; k++) { const a = k / 20 * TAU, r = pd.r * pd.g(a); p.push(pd.x + Math.cos(a) * r, pd.y + Math.sin(a) * r); }
    let ok = true;
    rasterPoly(p, occ.cell, occ.gw, occ.gh, i => { if (occ.a[i] !== PARK) ok = false; });
    if (ok) { stampPoly(occ, p, WATER, 0); ctx.extraWater.push(p); }
  }
  plantStation(ctx, rng);
  plantFerry(ctx, rng);
}

function plantStation(ctx, rng) {
  if (!ctx.rail.length) return;
  const { cx, cy, occ } = ctx;
  let best = null;
  for (const r of ctx.rail) for (let i = 0; i + 3 < r.length; i += 2) {
    const d = dist(r[i], r[i + 1], cx, cy);
    if (!best || d < best.d) best = { r, i, d };
  }
  const tryAt = (r, i, len, side) => {
    const ax = r[i], ay = r[i + 1], bx = r[i + 2], by = r[i + 3], L = dist(ax, ay, bx, by) || 1;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    let vx = -uy * side, vy = ux * side;
    const ox = (ax + bx) / 2, oy = (ay + by) / 2;
    const dep = rng.range(22, 30), v0 = 10;
    if (!frameTest(occ, ox, oy, ux, uy, vx, vy, -len / 2 - 2, len / 2 + 2, v0, v0 + dep + 2)) return false;
    const p = toWorld(shapeLocal('notch', len, dep, rng), ox, oy, ux, uy, vx, vy).map((v, k) => v + (k % 2 ? vy : vx) * v0);
    stampPoly(occ, p, BLDG, 1);
    addBuilding(ctx, p, rng.range(14, 22), 'rescue', 'Rail Station', zoneAt(ctx, ox, oy), { planted: true, name: districtAt(ctx, ox, oy).name.split(' ')[0] + ' Station' });
    // platform canopies / sidings on the far side
    for (const off of [-11, -20]) {
      const s0 = Math.max(0, i - 10), s1 = Math.min(r.length - 2, i + 12);
      const sd = [];
      for (let k = s0; k <= s1; k += 2) {
        const tx2 = r[Math.min(k + 2, r.length - 2)] - r[Math.max(k - 2, 0)], ty2 = r[Math.min(k + 3, r.length - 1)] - r[Math.max(k - 1, 1)], tl = Math.hypot(tx2, ty2) || 1;
        sd.push(r[k] - ty2 / tl * side * off, r[k + 1] + tx2 / tl * side * off);
      }
      for (const q of cutByWater(ctx, sd)) {
        if (polyLen(q) < 60) continue;
        ctx.roads.push({ p: q, w: 5, k: 'rail', cls: 'rail' });
        stampLine(occ, q, 9, RAIL, 2);
      }
    }
    return true;
  };
  const sideToCentre = (r, i) => {
    const ax = r[i], ay = r[i + 1], bx = r[i + 2], by = r[i + 3];
    return ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 0 ? 1 : -1;
  };
  const { r, i } = best;
  for (const len of [140, 100, 70]) {
    for (let k = 0; k <= 20; k++) {
      const ii = i + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2;
      if (ii < 0 || ii + 3 >= r.length) continue;
      const sd = sideToCentre(r, ii);
      if (tryAt(r, ii, len, sd) || tryAt(r, ii, len, -sd)) return;
    }
  }
}

function plantFerry(ctx, rng) {
  if (ctx.o.water === 'none' || ctx.o.water === 'river' && ctx.S < 2) return;
  const { zg, occ, cx, cy } = ctx;
  const cands = [];
  for (let j = 1; j < zg.gh - 1; j++) for (let i = 1; i < zg.gw - 1; i++) {
    const idx = j * zg.gw + i, wd = zg.wdist[idx];
    if (!zg.land[idx] || wd < 10 || wd > 20) continue;
    const x = (i + 0.5) * ZG_CELL, y = (j + 0.5) * ZG_CELL, d = dist(x, y, cx, cy);
    if (d > ctx.Rmid * 1.2) continue;
    cands.push([x, y, d + rng.range(0, 200)]);
  }
  cands.sort((a, b) => a[2] - b[2]);
  for (const [x, y] of cands.slice(0, 160)) {
    const gx = waterDist(ctx, x + 8, y) - waterDist(ctx, x - 8, y), gy = waterDist(ctx, x, y + 8) - waterDist(ctx, x, y - 8);
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-6) continue;
    const vx = gx / gl, vy = gy / gl, ux = -vy, uy = vx;
    const w = rng.range(44, 64), d = rng.range(18, 26);
    if (!frameTest(occ, x, y, ux, uy, vx, vy, -w / 2 - 2, w / 2 + 2, -4, d + 2)) continue;
    const p = toWorld(shapeLocal('chamfer', w, d, rng), x, y, ux, uy, vx, vy);
    stampPoly(occ, p, BLDG, 1);
    addBuilding(ctx, p, rng.range(10, 16), 'rescue', 'Ferry Terminal', zoneAt(ctx, x, y), { planted: true, name: ctx.name.replace(/^Port /, '') + ' Ferry Terminal' });
    return;
  }
}

// ================================================================= pocket parks (leftover blocks)

function pocketParks(ctx) {
  const { occ } = ctx, rng = ctx.rng.fork('pockets');
  const { a, gw, gh, cell } = occ;
  const seen = new Uint8Array(gw * gh);
  const q = new Int32Array(gw * gh);
  for (let s = 0; s < a.length; s++) {
    if (a[s] !== FREE || seen[s]) continue;
    let h = 0, t = 0, water = false, edge = false;
    q[t++] = s; seen[s] = 1;
    while (h < t) {
      const i = q[h++], x = i % gw, y = (i / gw) | 0;
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) edge = true;
      if (x > 0) { const j = i - 1; if (a[j] === FREE) { if (!seen[j]) { seen[j] = 1; q[t++] = j; } } else if (a[j] === WATER) water = true; }
      if (x < gw - 1) { const j = i + 1; if (a[j] === FREE) { if (!seen[j]) { seen[j] = 1; q[t++] = j; } } else if (a[j] === WATER) water = true; }
      if (y > 0) { const j = i - gw; if (a[j] === FREE) { if (!seen[j]) { seen[j] = 1; q[t++] = j; } } else if (a[j] === WATER) water = true; }
      if (y < gh - 1) { const j = i + gw; if (a[j] === FREE) { if (!seen[j]) { seen[j] = 1; q[t++] = j; } } else if (a[j] === WATER) water = true; }
    }
    const area = t * cell * cell;
    const x0 = (s % gw + 0.5) * cell, y0 = (((s / gw) | 0) + 0.5) * cell;
    const zone = zoneAt(ctx, x0, y0);
    if (area < 110) { for (let k = 0; k < t; k++) a[q[k]] = KEEP; continue; }
    let make = false;
    if ((zone === DT || zone === MID) && area < 2600 && rng.chance(0.15)) make = true;
    else if (zone === OLD && area < 1800 && rng.chance(0.12)) make = true;
    else if (water && zone !== IND && area < 16000 && rng.chance(0.3)) make = true;
    else if (zone === SUB && area > 2500 && area < 12000 && !edge && rng.chance(0.05)) make = true;
    if (!make) continue;
    const pts = [];
    for (let k = 0; k < t; k++) { const i = q[k]; pts.push((i % gw + 0.5) * cell, (((i / gw) | 0) + 0.5) * cell); }
    const hp = hull(pts);
    if (hp.length < 6 || polyArea(hp) > area * 1.3) continue;
    for (let k = 0; k < t; k++) a[q[k]] = PARK;
    ctx.parks.push(hp);
  }
}

// ================================================================= frontage buildings

// Suburban runs: detached lots use f; terraces and semis (row) put 2-4 narrow houses wall to wall.
const LOT = {
  [DT]: { f: [24, 48], d: [30, 50], run: [2, 5], gap: [0.4, 2], sb: [0.3, 1.2] },
  [MID]: { f: [11, 24], d: [18, 30], run: [3, 7], gap: [0.8, 3], sb: [0.5, 1.8] },
  [OLD]: { f: [6, 12], d: [14, 24], run: [4, 8], gap: [0.3, 1.8], sb: [0.2, 0.8] },
  [SUB]: { f: [13, 19], d: [10, 14], run: [1, 1], gap: [0, 0], sb: [3, 6.5], row: [6.5, 9.5] },
  [IND]: { f: [30, 75], d: [26, 58], run: [1, 2], gap: [5, 12], sb: [3, 8] },
};
const STRIP = { f: [12, 22], d: [16, 24], run: [2, 4], gap: [1.5, 5], sb: [2, 4.5] };

function placeFrontage(ctx) {
  const rng = ctx.rng.fork('frontage');
  const { occ, cx, cy, Rd, o } = ctx;
  const dens = ctx.dens;
  const roads = ctx.roads.filter(r => FRONT_CLS[r.cls] !== undefined).sort((a, b) => FRONT_CLS[a.cls] - FRONT_CLS[b.cls]);
  for (const r of roads) {
    const P = r.p, n = P.length / 2;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(P[2 * i - 2], P[2 * i - 1], P[2 * i], P[2 * i + 1]);
    const L = cum[n - 1];
    if (L < 14) continue;
    const at = s => {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
      const sl = cum[hi] - cum[lo] || 1, t = clamp((s - cum[lo]) / sl, 0, 1);
      const ax = P[2 * lo], ay = P[2 * lo + 1], bx = P[2 * hi], by = P[2 * hi + 1];
      return [ax + (bx - ax) * t, ay + (by - ay) * t, (bx - ax) / sl, (by - ay) / sl];
    };
    const major = r.cls !== 'loc';
    const sideW = zoneAt(ctx, P[0], P[1]) === DT ? 2.5 : 1.8;
    for (const side of [1, -1]) {
      let s = r.w / 2 + 1.5;
      while (s < L - 4) {
        const [px, py] = at(s);
        const zone = zoneAt(ctx, px, py);
        if (zone === PRK) { s += 10; continue; }
        const strip = zone === SUB && major && rng.chance(0.75);
        const lot = strip ? STRIP : LOT[zone];
        if (zone === SUB && !strip && rng.chance(0.1 * (1 - dens) + 0.03)) { s += rng.range(lot.f[0], lot.f[1]); continue; }
        const house = zone === SUB && !strip, row = house && rng.chance(0.35 + 0.55 * dens);
        let k = row ? rng.int(2, 4) : rng.int(lot.run[0], lot.run[1]);
        const fs = [];
        for (let i = 0; i < k; i++) fs.push(row ? rng.range(lot.row[0], lot.row[1]) : rng.range(lot.f[0], lot.f[1]) * (house ? 1.2 - 0.3 * dens : 1));
        let total = fs.reduce((x, y) => x + y, 0);
        while (k > 1 && s + total > L - 3) { total -= fs.pop(); k--; }
        if (s + total > L - 3) { if (L - 3 - s < lot.f[0] * 0.7) break; fs[0] = L - 3 - s; total = fs[0]; }
        while (k > 1) {
          const [, , t0x, t0y] = at(s), [, , t1x, t1y] = at(s + total);
          if (t0x * t1x + t0y * t1y > 0.985) break;
          total -= fs.pop(); k--;
        }
        const gap = row ? rng.range(2.5, 5) : rng.range(lot.gap[0], lot.gap[1]);
        const dc = dist(px, py, cx, cy);
        let d = rng.range(lot.d[0], lot.d[1]);
        if (zone === DT) d *= 1 + 0.35 * (1 - clamp(dc / Rd, 0, 1));
        const sb = r.w / 2 + sideW + rng.range(lot.sb[0], lot.sb[1]) + 0.7;
        let placed = false;
        for (let attempt = 0; attempt < 7 && !placed; attempt++) {
          const [ox, oy, tx, ty] = at(s + total / 2);
          const vx = -ty * side, vy = tx * side;
          const bw = house && !row ? total - rng.range(2.5, 5) : total;
          if (bw < 5) break;
          const marg = house ? (row ? 1.2 : 1.5) : gap / 2;
          if (frameTest(occ, ox, oy, tx, ty, vx, vy, -bw / 2 - marg, bw / 2 + marg, sb, sb + d + (house ? 3 : 1.2))) {
            frameMark(occ, ox, oy, tx, ty, vx, vy, -bw / 2 + 0.3, bw / 2 - 0.3, sb + 0.3, sb + d - 0.3, BLDG);
            let u = -bw / 2;
            for (let i = 0; i < k; i++) {
              const fw = house && !row ? bw : fs[i];
              const area = fw * d;
              const tower = zone === DT && area >= 520 && rng.chance(0.78);
              const di = tower || zone === OLD || house ? d : d * rng.range(0.86, 1);
              const loc = shapeLocal(pickShape(rng, zone, tower), fw, di, rng);
              for (let q = 0; q < loc.length; q += 2) { loc[q] += u + fw / 2; loc[q + 1] += sb; }
              const wp = toWorld(loc, ox, oy, tx, ty, vx, vy);
              const [h, kind, use] = lotUse(ctx, rng, zone, strip, tower, dc, area, major);
              addBuilding(ctx, wp, h, kind, use, zone, { art: major });
              u += fw;
            }
            placed = true;
          } else if (d > lot.d[0] * 0.7) d *= 0.8;
          else if (k > 1) { total -= fs.pop(); k--; }
          else d *= 0.8;
          if (d < lot.d[0] * 0.45) break;
        }
        s += placed ? total + gap : 3;
      }
    }
  }
}

function lotUse(ctx, rng, zone, strip, tower, dc, area, major) {
  const dens = ctx.dens;
  switch (zone) {
    case DT: {
      if (tower) {
        const q = clamp(dc / ctx.Rd, 0, 1);
        const top = 40 + (ctx.hTop - 40) * Math.pow(1 - q, 1.25);
        const h = clamp(top * rng.range(0.55, 1.05), 40, 220);
        return rng.chance(0.75) ? [h, 'com', 'Office Tower'] : [h, 'res', 'Apartments'];
      }
      return [rng.range(14, 34) * (0.8 + 0.4 * dens), 'com', rng.chance(0.55) ? 'Offices' : 'Shops'];
    }
    case MID: {
      const h = rng.range(10, 18 + 18 * dens) * (major ? 1.2 : 1);
      return rng.chance(major ? 0.55 : 0.3) ? [h, 'com', rng.chance(0.5) ? 'Shops' : 'Offices'] : [h, 'res', 'Apartments'];
    }
    case OLD: return rng.chance(0.42) ? [rng.range(9, 17), 'com', 'Shops'] : [rng.range(9, 19), 'res', 'Terrace'];
    case SUB: return strip ? [rng.range(5, 11), 'com', 'Shops'] : [rng.range(5, 9), 'res', 'House'];
    case IND: return [rng.range(7, 16), 'ind', rng.pick(['Warehouse', 'Warehouse', 'Factory', 'Depot', 'Works'])];
    default: return [8, 'res', 'House'];
  }
}

function fillYards(ctx) {
  const rng = ctx.rng.fork('yards');
  const { zg, occ } = ctx;
  for (let j = 1; j < zg.gh - 1; j += 2) for (let i = 1; i < zg.gw - 1; i += 2) {
    const zone = zg.zone[j * zg.gw + i];
    if (zone !== DT && zone !== OLD && zone !== MID) continue;
    const x = (i + rng.range(0, 2)) * ZG_CELL, y = (j + rng.range(0, 2)) * ZG_CELL;
    if (occAt(occ, x, y) !== FREE) continue;
    const dd = districtAt(ctx, x, y), th = zone === DT ? ctx.theta0 : (dd ? dd.theta : ctx.theta0);
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    for (const sc of [1, 0.75, 0.55]) {
      const w = (zone === DT ? rng.range(22, 46) : zone === OLD ? rng.range(8, 16) : rng.range(12, 26)) * sc;
      const dd2 = (zone === DT ? rng.range(18, 38) : zone === OLD ? rng.range(8, 13) : rng.range(10, 20)) * sc;
      if (w < 9 || dd2 < 8) break;
      const mg = zone === OLD ? 1.4 : 2.2;
      if (!frameTest(occ, x, y, ux, uy, vx, vy, -w / 2 - mg, w / 2 + mg, -dd2 / 2 - mg, dd2 / 2 + mg)) continue;
      const tower = zone === DT && w * dd2 >= 520 && rng.chance(0.6);
      const loc = shapeLocal(pickShape(rng, zone, tower), w, dd2, rng).map((v, q) => (q % 2 ? v - dd2 / 2 : v));
      frameMark(occ, x, y, ux, uy, vx, vy, -w / 2, w / 2, -dd2 / 2, dd2 / 2, BLDG);
      const [h, kind, use] = lotUse(ctx, rng, zone, false, tower, dist(x, y, ctx.cx, ctx.cy), w * dd2, false);
      addBuilding(ctx, toWorld(loc, x, y, ux, uy, vx, vy), zone === MID ? Math.min(h, 16) : h, kind, use, zone, {});
      break;
    }
  }
  ctx.gasHolders = 0;
  const quota = Math.max(1, Math.round(ctx.landKm2 / 2.4));
  for (let j = 2; j < zg.gh - 2; j += 5) for (let i = 2; i < zg.gw - 2; i += 5) {
    const idx = j * zg.gw + i;
    if (zg.zone[idx] !== IND) continue;
    const x = (i + rng.range(0, 5)) * ZG_CELL, y = (j + rng.range(0, 5)) * ZG_CELL;
    if (occAt(occ, x, y) !== FREE) continue;
    const d = districtAt(ctx, x, y), th = (d ? d.theta : 0) + rng.range(-0.05, 0.05);
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    if (ctx.gasHolders < quota && rng.chance(0.3)) {
      const r = rng.range(16, 26);
      if (frameTest(occ, x, y, ux, uy, vx, vy, -r - 6, r + 6, -r - 6, r + 6)) {
        const p = circlePoly(x, y, r, r, 20);
        stampPoly(occ, p, BLDG, 1);
        frameMark(occ, x, y, ux, uy, vx, vy, -r - 3, r + 3, -r - 3, r + 3, KEEP);
        addBuilding(ctx, p, rng.range(24, 36), 'hazard', 'Gas Holder', IND, { planted: true });
        ctx.gasHolders++;
        continue;
      }
    }
    for (const sc of [1, 0.7, 0.5]) {
      const w = rng.range(36, 80) * sc, dd = rng.range(24, 50) * sc;
      if (frameTest(occ, x, y, ux, uy, vx, vy, -w / 2 - 6, w / 2 + 6, -dd / 2 - 6, dd / 2 + 6)) {
        const loc = shapeLocal(pickShape(rng, IND, false), w, dd, rng).map((v, q) => (q % 2 ? v - dd / 2 : v));
        const p = toWorld(loc, x, y, ux, uy, vx, vy);
        frameMark(occ, x, y, ux, uy, vx, vy, -w / 2, w / 2, -dd / 2, dd / 2, BLDG);
        addBuilding(ctx, p, rng.range(8, 18), 'ind', rng.pick(['Warehouse', 'Factory', 'Works']), IND, {});
        break;
      }
    }
  }
}

// Last pass over the urban zones: leftover ground inside blocks is packed with back buildings, each grown from a
// seed point in 2 m steps until it meets a neighbour's margin, so cores read as built up rather than as lawns.
// Suburbs only get blocks of flats, and only on open ground well clear of the houses (big margin), not in back gardens.
const INFILL = { [DT]: { max: [54, 44], mg: 0.8, h: 26, p: 1 }, [MID]: { max: [32, 26], mg: 0.8, h: 15, p: 1 }, [OLD]: { max: [18, 15], mg: 0.7, h: 15, p: 1 },
  [SUB]: { max: [36, 15], mg: 4, h: 15, p: 0.8, flats: true } };
function growRect(occ, x, y, ux, uy, vx, vy, mg, maxW, maxD) {
  let a0 = -3, a1 = 3, b0 = -3, b1 = 3;
  if (!frameTest(occ, x, y, ux, uy, vx, vy, a0 - mg, a1 + mg, b0 - mg, b1 + mg)) return null;
  for (let grew = true; grew;) {
    grew = false;
    if (a1 - a0 < maxW && frameTest(occ, x, y, ux, uy, vx, vy, a1 + mg, a1 + mg + 2, b0 - mg, b1 + mg)) { a1 += 2; grew = true; }
    if (a1 - a0 < maxW && frameTest(occ, x, y, ux, uy, vx, vy, a0 - mg - 2, a0 - mg, b0 - mg, b1 + mg)) { a0 -= 2; grew = true; }
    if (b1 - b0 < maxD && frameTest(occ, x, y, ux, uy, vx, vy, a0 - mg, a1 + mg, b1 + mg, b1 + mg + 2)) { b1 += 2; grew = true; }
    if (b1 - b0 < maxD && frameTest(occ, x, y, ux, uy, vx, vy, a0 - mg, a1 + mg, b0 - mg - 2, b0 - mg)) { b0 -= 2; grew = true; }
  }
  return [a0, a1, b0, b1];
}
function infillBlocks(ctx) {
  const rng = ctx.rng.fork('infill');
  const { zg, occ } = ctx;
  for (const off of [0.5, 0]) for (let j = 1; j < zg.gh - 1; j++) for (let i = 1; i < zg.gw - 1; i++) {
    const zone = zg.zone[j * zg.gw + i], spec = INFILL[zone];
    if (!spec) continue;
    const x = (i + off) * ZG_CELL, y = (j + off) * ZG_CELL;
    if (occAt(occ, x, y) !== FREE || !rng.chance(spec.p)) continue;
    const dd = districtAt(ctx, x, y), th = zone === DT ? ctx.theta0 : (dd ? dd.theta : ctx.theta0);
    const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
    const r = growRect(occ, x, y, ux, uy, vx, vy, spec.mg, spec.max[0] * rng.range(0.7, 1), spec.max[1] * rng.range(0.7, 1));
    if (!r) continue;
    const w = r[1] - r[0], d = r[3] - r[2];
    if (Math.max(w, d) < (spec.flats ? 18 : 7) || Math.min(w, d) < (spec.flats ? 9 : 7) || w > 5 * d || d > 5 * w) continue;
    const ox = x + ux * (r[0] + r[1]) / 2 + vx * (r[2] + r[3]) / 2, oy = y + uy * (r[0] + r[1]) / 2 + vy * (r[2] + r[3]) / 2;
    const loc = shapeLocal(rng.chance(0.75) ? 'rect' : pickShape(rng, zone, false), w, d, rng).map((v, q) => (q % 2 ? v - d / 2 : v));
    frameMark(occ, ox, oy, ux, uy, vx, vy, -w / 2, w / 2, -d / 2, d / 2, BLDG);
    const [h, kind, use] = spec.flats ? [rng.range(9, spec.h), 'res', 'Flats'] : lotUse(ctx, rng, zone, false, false, dist(ox, oy, ctx.cx, ctx.cy), w * d, false);
    addBuilding(ctx, toWorld(loc, ox, oy, ux, uy, vx, vy), Math.min(h, spec.h), kind, use, zone, {});
  }
}

// ================================================================= specials

const SPECIAL_PLAN = {
  civic: [['Police Station', 0.3], ['School', 0.26], ['Fire Station', 0.2], ['Library', 0.14], ['Courthouse', 0.1]],
  trade: [['Bank', 0.3], ['Hotel', 0.25], ['Market Hall', 0.2], ['Shopping Centre', 0.25]],
  armory: [['Hardware Store', 0.35], ['Sporting Goods', 0.3], ['Armory', 0.2], ['National Guard Depot', 0.15]],
  rescue: [['Hospital', 0.4], ['Bus Depot', 0.6]],
  hazard: [['Fuel Station', 0.65], ['Chemical Works', 0.35]],
};
const inZ = (...zs) => b => zs.includes(b.zone);
const USE_FILTER = {
  'Police Station': b => inZ(DT, MID, OLD, SUB)(b) && b.area >= 220 && b.area <= 2600 && b.h <= 45,
  'School': b => inZ(MID, SUB, OLD)(b) && b.area >= 380 && b.area <= 3600,
  'Fire Station': b => inZ(DT, MID, OLD, SUB, IND)(b) && b.area >= 220 && b.area <= 2000 && b.art,
  'Library': b => inZ(DT, MID, OLD)(b) && b.area >= 220 && b.area <= 2200 && b.h <= 40,
  'Courthouse': b => inZ(DT, MID, OLD)(b) && b.area >= 450 && b.area <= 3200,
  'Bank': b => inZ(DT, MID, OLD)(b) && b.area >= 200 && b.area <= 2600,
  'Hotel': b => inZ(DT, MID)(b) && b.h >= 18 && b.area >= 300,
  'Market Hall': b => inZ(OLD, MID, DT)(b) && b.area >= 380 && b.area <= 3200,
  'Shopping Centre': b => inZ(MID, SUB, DT)(b) && b.area >= 1300,
  'Hardware Store': b => inZ(SUB, MID, IND)(b) && b.area >= 250 && b.area <= 2600 && b.art,
  'Sporting Goods': b => inZ(MID, DT, SUB, OLD)(b) && b.area >= 180 && b.area <= 1600,
  'Armory': b => inZ(MID, OLD, DT, SUB)(b) && b.area >= 450 && b.area <= 3200,
  'National Guard Depot': b => inZ(IND, SUB)(b) && b.area >= 1100,
  'Bus Depot': b => inZ(IND, MID, SUB)(b) && b.area >= 850,
  'Hospital': b => inZ(MID, SUB)(b) && b.area >= 1400,
  'Fuel Station': b => inZ(SUB, MID, IND)(b) && b.area >= 60 && b.area <= 450 && b.art,
  'Chemical Works': b => inZ(IND)(b) && b.area >= 900,
};
const LOW_RISE = new Set(['School', 'Fire Station', 'Market Hall', 'Bus Depot', 'Hardware Store', 'Fuel Station', 'National Guard Depot', 'Chemical Works', 'Shopping Centre', 'Library']);

function relabel(ctx, b, kind, use, rng) {
  b.k = kind; b.use = use; b.special = true;
  if (LOW_RISE.has(use)) b.h = Math.min(b.h, use === 'Fuel Station' ? 5 : rng.range(8, 14));
  const dn = districtAt(ctx, b.cx, b.cy);
  const base = dn ? dn.name.split(' ')[0] : ctx.name;
  if (use === 'School') b.name = base + rng.pick([' Primary School', ' High School', ' Academy']);
  else if (use === 'Hospital') b.name = base + ' Hospital';
  else if (use !== 'Fuel Station' && use !== 'Hardware Store' && use !== 'Sporting Goods') b.name = base + ' ' + use;
}

function assignSpecials(ctx) {
  const rng = ctx.rng.fork('specials');
  const B = ctx.buildings;
  const land = Math.max(0.2, ctx.landKm2);
  const counts = {
    civic: Math.max(2, Math.round(land / 0.3)), trade: Math.max(2, Math.round(land / 0.45)), armory: Math.max(1, Math.round(land / 0.7)),
    rescue: Math.max(2, Math.round(land / 0.8)), hazard: Math.max(1, Math.round(land / 0.6)),
  };
  const placed = { civic: [], trade: [], armory: [], rescue: [], hazard: [] };
  for (const b of B) if (b.planted && placed[b.k]) placed[b.k].push(b);
  for (const b of B) if (b.planted) b.special = true;
  const order = B.map((b, i) => i);
  rng.shuffle(order);
  // Candidates only ever drop out (taken, or too close to a new pick), so each (use, relax) scan resumes where the
  // last one stopped, and the spacing test looks at nearby picks only: the same picks as a full rescan, in linear time.
  const RELAX = [1, 0.5, 0];
  for (const kind of ['rescue', 'civic', 'trade', 'armory', 'hazard']) {
    const plan = SPECIAL_PLAN[kind];
    const need = counts[kind] - placed[kind].length;
    const spacing = Math.sqrt(land * 1e6 / counts[kind]) * 0.55;
    const tally = {};
    for (const b of placed[kind]) tally[b.use] = (tally[b.use] || 0) + 1;
    const near = RELAX.map(relax => (spacing * relax > 0 ? { sp: spacing * relax, cells: new Map() } : null));
    const addNear = b => {
      for (const g of near) if (g) {
        const k = Math.floor(b.cx / g.sp) * 65536 + Math.floor(b.cy / g.sp);
        let l = g.cells.get(k);
        if (!l) g.cells.set(k, l = []);
        l.push(b);
      }
    };
    const crowded = (g, b) => {
      const gx = Math.floor(b.cx / g.sp), gy = Math.floor(b.cy / g.sp), sp2 = g.sp * g.sp;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = g.cells.get((gx + dx) * 65536 + gy + dy);
        if (l) for (const o of l) if ((o.cx - b.cx) ** 2 + (o.cy - b.cy) ** 2 < sp2) return true;
      }
      return false;
    };
    for (const b of placed[kind]) addNear(b);
    const cursor = new Map();
    for (let n = 0; n < need; n++) {
      let use = null, worst = Infinity;
      for (const [u, w] of plan) { const r = (tally[u] || 0) / w; if (r < worst) { worst = r; use = u; } }
      const filt = USE_FILTER[use];
      let pick = null;
      for (let ri = 0; ri < RELAX.length && !pick; ri++) {
        const g = near[ri], ck = use + '|' + ri;
        let k = cursor.get(ck) || 0;
        for (; k < order.length; k++) {
          const b = B[order[k]];
          if (b.special || b.k === 'landmark' || !filt(b)) continue;
          if (g && crowded(g, b)) continue;
          pick = b; break;
        }
        cursor.set(ck, k);
      }
      tally[use] = (tally[use] || 0) + 1;
      if (!pick) continue;
      relabel(ctx, pick, kind, use, rng);
      placed[kind].push(pick);
      addNear(pick);
    }
  }
  const towers = B.filter(b => !b.special && b.zone === DT && b.h >= 60).sort((a, b) => b.h - a.h);
  const nT = clamp(Math.round(land / 4) + 1, 1, 4);
  for (const b of towers.slice(0, nT)) { b.k = 'landmark'; b.use = 'Tower'; b.special = true; b.name = ctx.names.tower() + ' Tower'; }
  if (!ctx.cathedral) {
    const c = B.filter(b => !b.special && (b.zone === OLD || b.zone === MID) && b.area > 500 && b.area < 2500).sort((a, b) => dist(a.cx, a.cy, ctx.cx, ctx.cy) - dist(b.cx, b.cy, ctx.cx, ctx.cy))[0];
    if (c) { c.k = 'landmark'; c.use = 'Cathedral'; c.h = Math.max(c.h, 40); c.special = true; c.name = ctx.names.saint() + "'s Cathedral"; }
  }
}

function ensureStageSpecials(ctx, levels) {
  const rng = ctx.rng.fork('stage-specials');
  const B = ctx.buildings;
  const inside = (b, li) => pointInPoly(levels[li].p, b.cx, b.cy);
  const fix = (kind, use, li) => {
    if (B.some(b => b.k === kind && inside(b, li))) return;
    const filt = USE_FILTER[use];
    let pick = B.filter(b => !b.special && b.k !== 'landmark' && inside(b, li) && filt(b))[0];
    if (!pick) pick = B.filter(b => !b.special && b.k !== 'landmark' && inside(b, li) && b.area >= 150).sort((a, b) => b.area - a.area)[0];
    if (pick) relabel(ctx, pick, kind, use, rng);
  };
  fix('civic', 'Police Station', 0);
  fix('trade', 'Bank', 0);
  fix('armory', 'Sporting Goods', 0);
  if (levels.length > 1) fix('rescue', 'Hospital', 1);
}

// ================================================================= stages + output

function buildStages(ctx) {
  const land = ctx.landKm2;
  const a1 = Math.min(land * 0.3, 0.1 + 0.03 * land + 0.02 * ctx.S);
  const near = ctx.districts.filter(d => d.style !== 'none').sort((a, b) => a.d - b.d);
  const labels = [ctx.oldTown && ctx.oldTown.d < ctx.Rd * 2 ? 'Old Town' : 'Downtown'];
  for (let k = 1; k < ctx.o.stages; k++) {
    const d = near[Math.min(near.length - 1, Math.round((near.length - 1) * Math.pow(k / (ctx.o.stages - 1), 1.6)))];
    labels.push(k === ctx.o.stages - 1 ? 'Greater ' + ctx.name : d ? d.name : 'Outskirts');
  }
  return makeStages(ctx.W, ctx.H, ctx.o.stages, {
    cx: ctx.cx, cy: ctx.cy, seed: ctx.o.seed, firstFrac: a1 / land, labels,
    weight: (x, y) => (isLand(ctx, x, y) ? 1 : 0),
  });
}

function assemble(ctx, levels) {
  const { o, W, H } = ctx;
  const roads = ctx.roads.map(r => {
    const out = { p: r.p, w: Math.round(r.w * 10) / 10, k: r.k };
    if (r.name) out.name = r.name;
    if (r.z) out.z = r.z;
    return out;
  });
  const buildings = ctx.buildings.map(b => {
    const out = { p: b.p, h: b.h, k: b.k, use: b.use };
    if (b.name) out.name = b.name;
    return out;
  });
  const water = ctx.waterPolys.concat(ctx.extraWater).map(p => ({ p }));
  const parks = ctx.parks.map(p => ({ p }));
  const wl = o.water === 'none' ? 'inland' : o.water;
  return normalizeMap({
    format: FORMAT, v: VERSION, name: ctx.name, author: 'City Planning Office',
    desc: `Generated city, ${o.sizeKm} km square, ${wl}, density ${Math.round(o.density * 100)}%, ${ctx.bridgeCount || 0} bridge(s), ${o.stages} stages. Seed ${o.seed}.`,
    welcome: '', source: 'gen', seed: o.seed, geo: null, palette: 'paper', w: W, h: H,
    roads, water, parks, buildings, levels, spawns: [],
  });
}
