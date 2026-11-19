// Railway network read from the map's rail polylines: track geometry, junctions, level crossings, rail
// bridges, station platforms and long routes. Only the tile renderer and the decorative trains use it;
// the simulation never does. DOM-free.
import { pointInPoly, polyCentroid, polyBBox, distToPolyline, distToSeg, clamp } from '../util/geom.js';

export const JOIN = 3;             // rail ends closer than this (m) meet
const EDGE_TOL = 14;               // an end this close to the sheet edge runs off the map
const TURN_COS = Math.cos(0.7);    // a train follows a junction only through bends under ~40 degrees
export const MIN_ROUTE = 350;
const MAX_ROUTES = 24;
const DFS_BUDGET = 60000;

export const gaugeOf = w => (w > 0 && w < 5 ? 1.0 : 1.435);
export const bedOf = w => clamp((w > 0 ? w : 6) * 0.6, 3.4, 5);
export const isStation = b => !!b && b.use === 'Rail Station';

// ---------------------------------------------------------------- polyline helpers

// An end that stops just short of the sheet edge, heading out, is carried on to the edge so the track and its
// trains run off the map instead of stopping a few metres before the frame.
function toEdge(out, W, H) {
  for (const end of [0, 1]) {
    const n = out.length, k = end ? n - 2 : 0, j = end ? n - 4 : 2;
    const x = out[k], y = out[k + 1];
    let dx = x - out[j], dy = y - out[j + 1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) continue;
    dx /= l; dy /= l;
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (W - x) / dx);
    if (dx < -1e-6) t = Math.min(t, -x / dx);
    if (dy > 1e-6) t = Math.min(t, (H - y) / dy);
    if (dy < -1e-6) t = Math.min(t, -y / dy);
    if (!(t > 0.05 && t <= EDGE_TOL)) continue;
    if (end) out.push(x + dx * t, y + dy * t); else out.unshift(x + dx * t, y + dy * t);
  }
}

// A rail with heights (road.z) gives one line per level stretch: lev 1 (on a viaduct, drawn on the deck layer),
// 0 (on the ground) or -1 (in a tunnel). The pieces share their end points, so trains run straight through.
function makeLines(r, road, W, H) {
  const src = road.p, zsrc = Array.isArray(road.z) && road.z.length * 2 === src.length ? road.z : null, out = [], oz = [];
  let px = NaN, py = NaN;
  for (let k = 0; k + 1 < src.length; k += 2) {
    const x = +src[k], y = +src[k + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (out.length && Math.hypot(x - px, y - py) < 0.05) continue;
    out.push(x, y); px = x; py = y;
    if (zsrc) oz.push(+zsrc[k >> 1] || 0);
  }
  if (out.length < 4) return [];
  if (W > 0 && H > 0) {
    const fx = out[0], fy = out[1];
    toEdge(out, W, H);
    if (zsrc) {
      if (out[0] !== fx || out[1] !== fy) oz.unshift(oz[0]);
      while (oz.length < out.length >> 1) oz.push(oz[oz.length - 1]);
    }
  }
  if (!zsrc || !oz.some((v) => Math.abs(v) >= 0.5)) { const ln = makeLine(r, road, out); return ln ? [ln] : []; }
  const lev = (v) => (v >= 0.5 ? 1 : v <= -0.5 ? -1 : 0), pieces = [];
  let cur = null;
  for (let i = 0; i + 3 < out.length; i += 2) {
    const za = oz[i >> 1], zb = oz[(i >> 1) + 1], cuts = [0];
    if (za !== zb) for (const t of [-0.5, 0.5]) { const f = (t - za) / (zb - za); if (f > 1e-6 && f < 1 - 1e-6) cuts.push(f); }
    cuts.sort((a, b) => a - b);
    cuts.push(1);
    for (let j = 0; j + 1 < cuts.length; j++) {
      const f0 = cuts[j], f1 = cuts[j + 1], l = lev(za + (zb - za) * (f0 + f1) / 2);
      if (!cur || cur.lev !== l) {
        if (cur) pieces.push(cur);
        cur = { p: [out[i] + (out[i + 2] - out[i]) * f0, out[i + 1] + (out[i + 3] - out[i + 1]) * f0], z: [za + (zb - za) * f0], lev: l };
      }
      cur.p.push(out[i] + (out[i + 2] - out[i]) * f1, out[i + 1] + (out[i + 3] - out[i + 1]) * f1); cur.z.push(za + (zb - za) * f1);
    }
  }
  if (cur) pieces.push(cur);
  const lines = [];
  for (const pc of pieces) {
    const ln = makeLine(r, road, pc.p);
    if (!ln) continue;
    ln.lev = pc.lev;
    ln.z = Float64Array.from(pc.z.length === ln.p.length >> 1 ? pc.z : new Array(ln.p.length >> 1).fill(pc.lev));
    lines.push(ln);
  }
  return lines;
}

function makeLine(r, road, out) {
  if (out.length < 4) return null;
  const p = Float64Array.from(out), n = p.length >> 1, cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
  const L = cum[n - 1];
  if (L < 1) return null;
  const w = road.w > 0 ? road.w : 6;
  return { r, w, p, cum, L, bb: polyBBox(out), bed: bedOf(w), gauge: gaugeOf(w), spans: [], buf0: false, buf1: false, edges: [], twins: [], lev: 0, z: null };
}

// Height (tiers) of a line, or of a route, at distance s along it.
export function zAlong(p, cum, z, s) {
  if (!z) return 0;
  const i = segAt(cum, s), L = cum[i + 1] - cum[i] || 1e-9, t = clamp((s - cum[i]) / L, 0, 1);
  return z[i] + (z[i + 1] - z[i]) * t;
}

// Index of the segment holding distance s (clamped to the first / last segment).
export function segAt(cum, s) {
  const n = cum.length;
  if (s <= cum[1] || n < 3) return 0;
  if (s >= cum[n - 2]) return n - 2;
  let lo = 1, hi = n - 2;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (cum[m] <= s) lo = m; else hi = m - 1;
  }
  return lo;
}

// Point and unit tangent at distance s along an interleaved polyline; past either end it carries straight on.
export function sampleAt(p, cum, s, out) {
  const i = segAt(cum, s);
  const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
  const L = cum[i + 1] - cum[i] || 1e-9, t = (s - cum[i]) / L;
  out[0] = ax + (bx - ax) * t; out[1] = ay + (by - ay) * t;
  out[2] = (bx - ax) / L; out[3] = (by - ay) / L;
  return out;
}

// Nearest point of a line to (x, y): out = [d along the line, distance, x, y].
export function nearestOnLine(line, x, y, out = [0, 0, 0, 0]) {
  const p = line.p, cum = line.cum, n = cum.length;
  let bd = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], dx = p[2 * i + 2] - ax, dy = p[2 * i + 3] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(x - qx, y - qy);
    if (d < bd) { bd = d; out[0] = cum[i] + t * (cum[i + 1] - cum[i]); out[1] = d; out[2] = qx; out[3] = qy; }
  }
  return out;
}

function subPoints(line, d0, d1, dst, dz = null) {
  const p = line.p, cum = line.cum, n = cum.length, T = [0, 0, 0, 0];
  sampleAt(p, cum, d0, T); dst.push(T[0], T[1]);
  if (dz) dz.push(zAlong(p, cum, line.z, d0));
  for (let k = 1; k < n - 1; k++) if (cum[k] > d0 + 1e-6 && cum[k] < d1 - 1e-6) { dst.push(p[2 * k], p[2 * k + 1]); if (dz) dz.push(line.z ? line.z[k] : 0); }
  sampleAt(p, cum, d1, T); dst.push(T[0], T[1]);
  if (dz) dz.push(zAlong(p, cum, line.z, d1));
  return dst;
}

class SegGrid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  key(cx, cy) { return (cy + 32768) * 65536 + (cx + 32768); }
  add(x0, y0, x1, y1, v) {
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
      const k = this.key(cx, cy);
      let a = this.m.get(k);
      if (!a) this.m.set(k, (a = []));
      a.push(v);
    }
  }
  each(x0, y0, x1, y1, fn) {
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
      const a = this.m.get(this.key(cx, cy));
      if (a) for (let i = 0; i < a.length; i++) fn(a[i]);
    }
  }
}

// ---------------------------------------------------------------- graph

function buildGraph(lines, W, H) {
  const ne = lines.length * 2;
  const ex = new Float64Array(ne), ey = new Float64Array(ne);
  lines.forEach((ln, i) => {
    const n = ln.p.length;
    ex[2 * i] = ln.p[0]; ey[2 * i] = ln.p[1];
    ex[2 * i + 1] = ln.p[n - 2]; ey[2 * i + 1] = ln.p[n - 1];
  });
  const parent = new Int32Array(ne);
  for (let i = 0; i < ne; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  const eg = new SegGrid(JOIN * 2);
  for (let e = 0; e < ne; e++) eg.add(ex[e], ey[e], ex[e], ey[e], e);
  for (let e = 0; e < ne; e++) {
    eg.each(ex[e] - JOIN, ey[e] - JOIN, ex[e] + JOIN, ey[e] + JOIN, f => {
      if (f > e && Math.hypot(ex[f] - ex[e], ey[f] - ey[e]) <= JOIN) union(e, f);
    });
  }

  // an end that meets another line part way along it (a branch off a through line) splits that line there
  const sg = new SegGrid(32);
  lines.forEach((ln, li) => {
    const p = ln.p;
    for (let k = 0; k + 3 < p.length; k += 2) sg.add(Math.min(p[k], p[k + 2]), Math.min(p[k + 1], p[k + 3]), Math.max(p[k], p[k + 2]), Math.max(p[k + 1], p[k + 3]), li);
  });
  const splits = lines.map(() => []);
  const near = [0, 0, 0, 0], seen = new Set();
  for (let e = 0; e < ne; e++) {
    const li = e >> 1;
    seen.clear();
    sg.each(ex[e] - JOIN, ey[e] - JOIN, ex[e] + JOIN, ey[e] + JOIN, lj => {
      if (seen.has(lj)) return;
      seen.add(lj);
      const ln = lines[lj];
      nearestOnLine(ln, ex[e], ey[e], near);
      if (near[1] > JOIN || near[0] <= JOIN || near[0] >= ln.L - JOIN) return;
      if (lj === li && Math.abs(near[0] - (e & 1 ? ln.L : 0)) < JOIN * 4) return;
      splits[lj].push({ d: near[0], e });
    });
  }
  for (const list of splits) {
    list.sort((a, b) => a.d - b.d);
    for (let k = 1; k < list.length; k++) if (list[k].d - list[k - 1].d <= JOIN) { union(list[k].e, list[k - 1].e); list[k].d = list[k - 1].d; }
  }

  const nodeOf = new Map(), nodes = [];
  const node = root => {
    let id = nodeOf.get(root);
    if (id === undefined) { id = nodes.length; nodeOf.set(root, id); nodes.push({ x: 0, y: 0, k: 0, ends: [], deg: 0, portal: false }); }
    return id;
  };
  for (let e = 0; e < ne; e++) { const n = nodes[node(find(e))]; n.x += ex[e]; n.y += ey[e]; n.k++; }
  for (const n of nodes) { n.x /= n.k; n.y /= n.k; }

  const edges = [], T = [0, 0, 0, 0];
  lines.forEach((ln, li) => {
    const stops = [{ d: 0, n: node(find(2 * li)) }];
    for (const s of splits[li]) if (!stops.length || s.d - stops[stops.length - 1].d > 1e-6) stops.push({ d: s.d, n: node(find(s.e)) });
    stops.push({ d: ln.L, n: node(find(2 * li + 1)) });
    for (let k = 0; k + 1 < stops.length; k++) {
      const d0 = stops[k].d, d1 = stops[k + 1].d;
      if (d1 - d0 < 0.5) continue;
      const L = d1 - d0, h = Math.min(10, L / 2);
      sampleAt(ln.p, ln.cum, d0, T); const x0 = T[0], y0 = T[1];
      sampleAt(ln.p, ln.cum, d0 + h, T); let hx0 = T[0] - x0, hy0 = T[1] - y0;
      sampleAt(ln.p, ln.cum, d1, T); const x1 = T[0], y1 = T[1];
      sampleAt(ln.p, ln.cum, d1 - h, T); let hx1 = T[0] - x1, hy1 = T[1] - y1;
      const l0 = Math.hypot(hx0, hy0) || 1, l1 = Math.hypot(hx1, hy1) || 1;
      hx0 /= l0; hy0 /= l0; hx1 /= l1; hy1 /= l1;
      const id = edges.length;
      edges.push({ line: li, d0, d1, L, a: stops[k].n, b: stops[k + 1].n, hx0, hy0, hx1, hy1 });
      ln.edges.push(id);
      nodes[stops[k].n].ends.push(id * 2);
      nodes[stops[k + 1].n].ends.push(id * 2 + 1);
    }
  });
  for (const n of nodes) {
    n.deg = n.ends.length;
    n.portal = n.deg === 1 && (n.x < EDGE_TOL || n.y < EDGE_TOL || n.x > W - EDGE_TOL || n.y > H - EDGE_TOL);
  }
  for (const n of nodes) {
    if (n.deg !== 1 || n.portal) continue;
    const e = edges[n.ends[0] >> 1], ln = lines[e.line];
    if (n.ends[0] & 1) { if (e.d1 >= ln.L - 1e-6) ln.buf1 = true; } else if (e.d0 <= 1e-6) ln.buf0 = true;
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------- water, crossings, platforms

function bridgeSpans(line, water) {
  const near = water.filter(w => !(w.bb[0] > line.bb[2] + 2 || w.bb[2] < line.bb[0] - 2 || w.bb[1] > line.bb[3] + 2 || w.bb[3] < line.bb[1] - 2));
  if (!near.length) return [];
  const wet = (x, y) => { for (const w of near) if (x >= w.bb[0] && y >= w.bb[1] && x <= w.bb[2] && y <= w.bb[3] && pointInPoly(w.p, x, y)) return true; return false; };
  const step = 2, n = Math.ceil(line.L / step), T = [0, 0, 0, 0], runs = [];
  let a = -1;
  for (let k = 0; k <= n; k++) {
    const s = Math.min(line.L, k * step);
    sampleAt(line.p, line.cum, s, T);
    const w = wet(T[0], T[1]);
    if (w && a < 0) a = s;
    if ((!w || k === n) && a >= 0) { runs.push([a, w ? s : s - step]); a = -1; }
  }
  const out = [];
  for (const r of runs) {
    if (out.length && r[0] - out[out.length - 1][1] < 8) out[out.length - 1][1] = r[1];
    else out.push(r.slice());
  }
  return out.filter(r => r[1] - r[0] >= 3).map(r => [Math.max(0, r[0] - 3), Math.min(line.L, r[1] + 3)]);
}

const inSpan = (line, d) => line.spans.some(s => d >= s[0] && d <= s[1]);

// Roads (major and minor) crossing a rail on the level: { line, d, x, y, ux, uy (road), tx, ty (rail), sin, w, k, road }.
function findCrossings(map, lines) {
  const R = map.roads || [], out = [];
  if (!lines.length) return out;
  const rg = new SegGrid(64);
  lines.forEach((ln, li) => {
    const p = ln.p;
    for (let k = 0; k + 3 < p.length; k += 2) rg.add(Math.min(p[k], p[k + 2]), Math.min(p[k + 1], p[k + 3]), Math.max(p[k], p[k + 2]), Math.max(p[k + 1], p[k + 3]), li * 65536 + (k >> 1));
  });
  const seen = new Map();
  for (let ri = 0; ri < R.length; ri++) {
    const rd = R[ri];
    if (rd.k !== 'major' && rd.k !== 'minor') continue;
    const q = rd.p, rz = Array.isArray(rd.z) && rd.z.length * 2 === (q ? q.length : 0) ? rd.z : null;
    if (!q || q.length < 4) continue;
    const w = rd.w > 0 ? rd.w : rd.k === 'major' ? 12 : 7;
    for (let j = 0; j + 3 < q.length; j += 2) {
      const cx = q[j], cy = q[j + 1], dx = q[j + 2], dy = q[j + 3];
      rg.each(Math.min(cx, dx), Math.min(cy, dy), Math.max(cx, dx), Math.max(cy, dy), v => {
        const li = Math.floor(v / 65536), k = v % 65536, ln = lines[li], p = ln.p;
        if (ln.lev) return;
        const ax = p[2 * k], ay = p[2 * k + 1], bx = p[2 * k + 2], by = p[2 * k + 3];
        const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) return;
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) return;
        // a road on a deck or in a tunnel there passes over or under the railway, not across it
        if (rz && Math.abs(rz[j >> 1] + (rz[(j >> 1) + 1] - rz[j >> 1]) * u) >= 0.5) return;
        const rl = Math.hypot(rx, ry) || 1, sl = Math.hypot(sx, sy) || 1;
        const sin = Math.abs(den) / (rl * sl);
        if (sin < 0.26) return;
        const d = ln.cum[k] + t * (ln.cum[k + 1] - ln.cum[k]);
        if (inSpan(ln, d)) return;
        const key = li * 1e7 + ri;
        const prev = seen.get(key);
        if (prev && prev.some(c => Math.abs(c.d - d) < 4)) return;
        const c = { line: li, d, x: ax + rx * t, y: ay + ry * t, ux: sx / sl, uy: sy / sl, tx: rx / rl, ty: ry / rl, sin, w, k: rd.k, road: ri };
        if (prev) prev.push(c); else seen.set(key, [c]);
        out.push(c);
      });
    }
  }
  // on a road over several tracks only the outermost barriers stand
  const byRoad = new Map();
  for (const c of out) { const a = byRoad.get(c.road); if (a) a.push(c); else byRoad.set(c.road, [c]); }
  for (const c of out) {
    c.bar0 = c.bar1 = true;
    for (const o of byRoad.get(c.road)) {
      if (o === c) continue;
      const t = (o.x - c.x) * c.ux + (o.y - c.y) * c.uy;
      if (t > 0 && t < 30) c.bar1 = false;
      if (t < 0 && t > -30) c.bar0 = false;
    }
    const ln = lines[c.line];
    if ((ln.buf0 && c.d < 8) || (ln.buf1 && c.d > ln.L - 8)) c.bar0 = c.bar1 = false;   // a road past the end of a siding
  }
  return out;
}

// Lines running alongside another for most of their length (double track, station loops): { j, d (typical gap) }.
function findTwins(lines) {
  const sg = new SegGrid(64);
  lines.forEach((ln, li) => {
    const p = ln.p;
    for (let k = 0; k + 3 < p.length; k += 2) sg.add(Math.min(p[k], p[k + 2]), Math.min(p[k + 1], p[k + 3]), Math.max(p[k], p[k + 2]), Math.max(p[k + 1], p[k + 3]), li * 65536 + (k >> 1));
  });
  const T = [0, 0, 0, 0], best = new Float64Array(lines.length).fill(Infinity), touched = [];
  lines.forEach((ln, li) => {
    const n = Math.max(4, Math.min(60, Math.ceil(ln.L / 20))), hits = new Map();
    for (let k = 0; k <= n; k++) {
      sampleAt(ln.p, ln.cum, ln.L * k / n, T);
      const x = T[0], y = T[1];
      sg.each(x - 32, y - 32, x + 32, y + 32, v => {
        const lj = Math.floor(v / 65536);
        if (lj === li) return;
        const q = lines[lj].p, i = (v % 65536) * 2, d = distToSeg(x, y, q[i], q[i + 1], q[i + 2], q[i + 3]);
        if (d < best[lj]) { if (best[lj] === Infinity) touched.push(lj); best[lj] = d; }
      });
      for (const lj of touched) {
        if (best[lj] <= 30) { const a = hits.get(lj); if (a) a.push(best[lj]); else hits.set(lj, [best[lj]]); }
        best[lj] = Infinity;
      }
      touched.length = 0;
    }
    ln.twins = [];
    for (const [j, ds] of hits) {
      if (ds.length < (n + 1) * 0.6) continue;
      ds.sort((a, b) => a - b);
      ln.twins.push({ j, d: ds[ds.length >> 1] });
    }
  });
}

// Platforms beside the tracks next to each rail station building, and where trains stop.
function findPlatforms(map, lines, crossings) {
  const B = map.buildings || [], platforms = [], stops = [];
  const near = [0, 0, 0, 0], T = [0, 0, 0, 0];
  for (let bi = 0; bi < B.length; bi++) {
    const b = B[bi];
    if (!isStation(b) || !b.p || b.p.length < 6) continue;
    const [cx, cy] = polyCentroid(b.p);
    const cand = [];
    let best = Infinity;
    lines.forEach((ln, li) => {
      if (ln.lev || ln.bb[0] > cx + 90 || ln.bb[2] < cx - 90 || ln.bb[1] > cy + 90 || ln.bb[3] < cy - 90) return;
      nearestOnLine(ln, cx, cy, near);
      if (near[1] > 80 || near[0] < 10 || near[0] > ln.L - 10) return;
      cand.push({ li, d: near[0], dist: near[1] });
      best = Math.min(best, near[1]);
    });
    for (const c of cand) {
      if (c.dist > best + 45) continue;
      const ln = lines[c.li];
      if (inSpan(ln, c.d)) continue;
      sampleAt(ln.p, ln.cum, c.d, T);
      const px = T[0], py = T[1], tx = T[2], ty = T[3], nx = -ty, ny = tx;
      const side = (cx - px) * nx + (cy - py) * ny >= 0 ? 1 : -1;
      let free = ln.bed / 2 + 7;
      lines.forEach((o, oi) => {
        if (oi === c.li || o.bb[0] > px + 40 || o.bb[2] < px - 40 || o.bb[1] > py + 40 || o.bb[3] < py - 40) return;
        nearestOnLine(o, px, py, near);
        const qx = near[2] - px, qy = near[3] - py;
        if (near[1] > 32 || Math.abs(qx * tx + qy * ty) > 12) return;
        const lat = qx * nx + qy * ny;
        if (lat * side > 0) free = Math.min(free, Math.abs(lat) - o.bed / 2 - 0.5);
      });
      if (pointInPoly(b.p, px, py)) free = 0;
      else free = Math.min(free, distToPolyline(b.p, px, py, true) - 0.6);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < b.p.length; k += 2) { const a = (b.p[k] - px) * tx + (b.p[k + 1] - py) * ty; lo = Math.min(lo, a); hi = Math.max(hi, a); }
      let a = c.d + lo - 12, z = c.d + hi + 12;
      const mid = (a + z) / 2, half = clamp((z - a) / 2, 35, 130);
      a = Math.max(6, mid - half); z = Math.min(ln.L - 6, mid + half);
      for (const x of crossings) {
        if (x.line !== c.li || x.d < a - 20 || x.d > z + 20) continue;
        const clear = (x.w / 2) / x.sin + 3;
        if (x.d < mid) a = Math.max(a, x.d + clear); else z = Math.min(z, x.d - clear);
      }
      for (const s of ln.spans) {
        if (s[1] < a || s[0] > z) continue;
        if (s[0] > mid) z = Math.min(z, s[0]); else a = Math.max(a, s[1]);
      }
      const o0 = ln.bed / 2 + 0.35, o1 = Math.min(o0 + 6, free);
      const stopD = clamp(c.d, a, z);
      if (z - a >= 40 && o1 - o0 >= 2.2) {
        sampleAt(ln.p, ln.cum, (a + z) / 2, T);
        platforms.push({ line: c.li, d0: a, d1: z, side, o0, o1, x: T[0], y: T[1], station: bi });
        stops.push({ line: c.li, d: (a + z) / 2, station: bi });
      } else stops.push({ line: c.li, d: stopD, station: bi });
    }
  }
  return { platforms, stops };
}

// ---------------------------------------------------------------- routes

function findRoutes(net) {
  const { nodes, edges } = net, found = [];
  const onPath = new Uint8Array(edges.length), path = [];
  let budget = DFS_BUDGET;
  nodes.forEach((n0, start) => {
    if (n0.deg !== 1 || budget <= 0) return;
    const mine = [];
    let steps = 0;
    const walk = (e, dir, len) => {
      if (++steps > 4000 || --budget <= 0) return;
      onPath[e] = 1; path.push(e * 2 + (dir > 0 ? 0 : 1));
      const E = edges[e], total = len + E.L, m = dir > 0 ? E.b : E.a, node = nodes[m];
      const hx = dir > 0 ? -E.hx1 : -E.hx0, hy = dir > 0 ? -E.hy1 : -E.hy0;
      if (node.deg === 1) {
        if (m !== start && total >= MIN_ROUTE) {
          mine.push({ dirs: path.slice(), L: total, a: start, b: m });
          mine.sort((x, y) => y.L - x.L);
          if (mine.length > 6) mine.pop();
        }
      } else {
        const next = [];
        for (const end of node.ends) {
          const f = end >> 1, side = end & 1;
          if (onPath[f]) continue;
          const F = edges[f], gx = side ? F.hx1 : F.hx0, gy = side ? F.hy1 : F.hy0, dot = hx * gx + hy * gy;
          if (dot >= TURN_COS) next.push([dot, f, side ? -1 : 1]);
        }
        next.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
        for (const [, f, d] of next) walk(f, d, total);
      }
      path.pop(); onPath[e] = 0;
    };
    const end = n0.ends[0];
    walk(end >> 1, end & 1 ? -1 : 1, 0);
    found.push(...mine);
  });
  found.sort((x, y) => y.L - x.L || x.dirs[0] - y.dirs[0]);
  // longest routes first, on track no other route uses; then routes that share at most half their length
  // with one other (a branch running onto a main line), which the train layer schedules around each other
  const uses = new Uint8Array(edges.length), chosen = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const r of found) {
      if (chosen.length >= MAX_ROUTES || r.taken) continue;
      let shared = 0, full = false;
      for (const de of r.dirs) { const e = de >> 1; if (uses[e]) { shared += edges[e].L; if (uses[e] > 1) full = true; } }
      if (pass === 0 ? shared > 0 : full || shared > r.L * 0.5) continue;
      for (const de of r.dirs) uses[de >> 1]++;
      r.taken = true;
      chosen.push(r);
    }
  }
  chosen.forEach((r, i) => {
    r.share = [];
    const mine = new Set(r.dirs.map(de => de >> 1));
    chosen.forEach((o, j) => { if (j !== i && o.dirs.some(de => mine.has(de >> 1))) r.share.push(j); });
  });
  return chosen;
}

function routeGeometry(net, lines, r, stopList) {
  const { edges, nodes } = net;
  const pts = [], at = [], zs = [];
  let s = 0, anyZ = false;
  for (const de of r.dirs) {
    const E = edges[de >> 1], rev = de & 1, sz = [], sub = subPoints(lines[E.line], E.d0, E.d1, [], sz);
    if (lines[E.line].z) anyZ = true;
    if (rev) { for (let i = 0, j = sub.length - 2; i < j; i += 2, j -= 2) { let t = sub[i]; sub[i] = sub[j]; sub[j] = t; t = sub[i + 1]; sub[i + 1] = sub[j + 1]; sub[j + 1] = t; } sz.reverse(); }
    at.push({ e: de >> 1, rev, s, L: E.L });
    let k0 = 0;
    if (pts.length && Math.hypot(sub[0] - pts[pts.length - 2], sub[1] - pts[pts.length - 1]) < 0.5) k0 = 2;
    for (let k = k0; k < sub.length; k++) pts.push(sub[k]);
    for (let k = k0 >> 1; k < sz.length; k++) zs.push(sz[k]);
    s += E.L;
  }
  const p = Float64Array.from(pts), n = p.length >> 1, cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]);
  const L = cum[n - 1], scale = s > 0 ? L / s : 1;
  const st = [];
  for (const sp of stopList) {
    for (const a of at) {
      const E = edges[a.e];
      if (E.line !== sp.line || sp.d < E.d0 || sp.d > E.d1) continue;
      st.push((a.s + (a.rev ? E.d1 - sp.d : sp.d - E.d0)) * scale);
    }
  }
  st.sort((x, y) => x - y);
  const stops = [];
  for (const v of st) if (!stops.length || v - stops[stops.length - 1] > 60) stops.push(v);
  const segs = at.map(a => ({ e: a.e, s0: a.s * scale, s1: (a.s + a.L) * scale }));
  return { p, cum, L, z: anyZ && zs.length === n ? Float64Array.from(zs) : null, portalA: nodes[r.a].portal, portalB: nodes[r.b].portal, stops: Float64Array.from(stops), segs, share: r.share };
}

function reverseRoute(rt) {
  const p = rt.p, n = p.length >> 1, q = new Float64Array(p.length), cum = new Float64Array(n);
  for (let k = 0; k < n; k++) { q[2 * k] = p[2 * (n - 1 - k)]; q[2 * k + 1] = p[2 * (n - 1 - k) + 1]; }
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(q[2 * k] - q[2 * k - 2], q[2 * k + 1] - q[2 * k - 1]);
  const stops = Float64Array.from(Array.from(rt.stops, v => rt.L - v).reverse());
  const segs = rt.segs.map(g => ({ e: g.e, s0: rt.L - g.s1, s1: rt.L - g.s0 })).reverse();
  const z = rt.z ? Float64Array.from(rt.z).reverse() : null;
  return { ...rt, p: q, cum, z, portalA: rt.portalB, portalB: rt.portalA, stops, segs };
}

// ---------------------------------------------------------------- entry point

// { lines, byRoad, nodes, edges, crossings, platforms, stops, routes, W, H, length }
export function analyseRails(map) {
  const W = map.w || 0, H = map.h || 0, R = map.roads || [];
  const byRoad = new Int32Array(R.length).fill(-1), more = new Map(), lines = [];
  for (let r = 0; r < R.length; r++) {
    if (!R[r] || R[r].k !== 'rail' || !R[r].p) continue;
    const ls = makeLines(r, R[r], W, H);
    if (!ls.length) continue;
    byRoad[r] = lines.length;
    if (ls.length > 1) more.set(r, ls.map((_, k) => lines.length + k));
    lines.push(...ls);
  }
  const net = { lines, byRoad, more, nodes: [], edges: [], crossings: [], platforms: [], stops: [], routes: [], W, H, length: 0 };
  if (!lines.length) return net;
  const water = (map.water || []).filter(w => w.p && w.p.length >= 6).map(w => ({ p: w.p, bb: polyBBox(w.p) }));
  for (const ln of lines) { ln.spans = ln.lev ? [] : bridgeSpans(ln, water); net.length += ln.L; }
  Object.assign(net, buildGraph(lines, W, H));
  findTwins(lines);
  net.crossings = findCrossings(map, lines);
  Object.assign(net, findPlatforms(map, lines, net.crossings));
  net.routes = findRoutes(net).map(r => {
    const rt = routeGeometry(net, lines, r, net.stops);
    return !rt.portalA && rt.portalB ? reverseRoute(rt) : rt;
  });
  return net;
}

// Cheap fingerprint of everything analyseRails reads, so an edited map is analysed again.
export function railSignature(map) {
  const R = map.roads || [], B = map.buildings || [];
  let h = 2166136261 >>> 0, n = 0;
  const mixIn = v => { h = Math.imul(h ^ (Math.round(v * 10) | 0), 16777619) >>> 0; };
  for (let r = 0; r < R.length; r++) {
    const rd = R[r];
    if (!rd || rd.k !== 'rail' || !rd.p) continue;
    n++;
    mixIn(rd.w || 0); mixIn(rd.p.length);
    for (let k = 0; k < rd.p.length; k++) mixIn(rd.p[k]);
    if (Array.isArray(rd.z)) for (let k = 0; k < rd.z.length; k++) mixIn(rd.z[k] + 7);
  }
  for (let i = 0; i < B.length; i++) if (isStation(B[i]) && B[i].p) { mixIn(i); mixIn(B[i].p[0]); mixIn(B[i].p[1]); }
  return `${n}|${R.length}|${B.length}|${(map.water || []).length}|${map.w}x${map.h}|${h}`;
}

const NETS = new WeakMap();
export function railNetFor(map) {
  const sig = railSignature(map);
  const c = NETS.get(map);
  if (c && c.sig === sig) return c.net;
  const net = analyseRails(map);
  NETS.set(map, { sig, net });
  return net;
}
