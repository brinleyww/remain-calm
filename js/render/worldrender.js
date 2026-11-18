// Live world layer over the static paper map, drawn in CSS-pixel screen space each frame:
// zones (hatched), walls, gates, corridors, holds, fire, mosh pits, agents (batched per colour), units, vehicles, rings.
import { getPalette, rgba, mix, hexToRgb, FONT_MONO } from './palette.js';
import { drawProjectiles, drawEffects, drawAircraft, stampLabel, tag } from './fx.js';
import { drawNavalGlyph, drawBoat, BOAT_TYPES } from './navalrender.js';
import { hash2 } from '../util/rng.js';
import { pointInPoly, polyBBox } from '../util/geom.js';

const TAU = Math.PI * 2;
const CIV = 1, ZOMBIE = 2, TURNING = 3, POLICE = 4, MILITIA = 5, SOLDIER = 6;
const B_CALM = 0, B_PANIC = 1, B_TURN = 2, B_ZOM = 3, B_POL = 4, B_MIL = 5, B_SOL = 6, NB = 7;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PIXEL_ZOOM = 1.2; // CSS px per metre below which crowds are drawn into a pixel buffer
// Agent discs: radius in metres, and the smallest radius in CSS px when zoomed out.
const R_CIV = 0.65, R_ZOM = 0.75, R_ARM = 0.8;
const F_CIV = 1.3, F_ZOM = 1.4, F_ARM = 1.5;
const EDGE_R = 3; // zombie disc radius (px) from which crowds get an ink edge
const VEC_MAX = 4000, VEC_MAX_ZOOM = 2.5; // above this many visible agents, and zoomed out past this, use the pixel buffer
const PIX_MAX_D = 12; // ...or, that crowded, whenever a zombie disc is at most this many device px across
const SAMPLE_M = 2; // wall damage is read from the grid every 2 m along the drawn line
const W_NONE = 0, W_OK = 1, W_WORN = 2, W_CRIT = 3, W_BROKEN = 4, W_GATE = 5;

export function wallLineWidth(cam, cell = 4) { return Math.max(1.5, cell * cam.zoom * 1.05); }

// ---------------------------------------------------------------- true wall lines
function cleanRing(p, closed = true) {
  const out = [];
  for (let k = 0; k + 1 < p.length; k += 2) {
    const x = p[k], y = p[k + 1], m = out.length;
    if (m && Math.abs(out[m - 2] - x) < 1e-6 && Math.abs(out[m - 1] - y) < 1e-6) continue;
    out.push(x, y);
  }
  while (closed && out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-6 && Math.abs(out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  return out;
}

function edgeT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const qx = cx - ax, qy = cy - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return u >= -1e-9 && u <= 1 + 1e-9 && t > 1e-7 && t < 1 - 1e-7 ? t : -1;
}

function covered(P, x, y) { for (let k = 0; k < P.length; k++) if (P[k].length >= 6 && pointInPoly(P[k], x, y)) return true; return false; }

// Boundary pieces of the union of polygons (even-odd inside each, as the grid raster does), split where edges cross and
// oriented with the covered side on the left. `from` limits the output to the edges of those polygon indices.
export function outlineSegments(polys, from = null) {
  const P = polys.map((p) => cleanRing(p));
  const segs = [], seen = new Set(), ts = [], e = 0.03;
  for (let i = 0; i < P.length; i++) {
    if (from && !from.includes(i)) continue;
    const p = P[i], n = p.length;
    if (n < 6) continue;
    for (let k = 0; k < n; k += 2) {
      const ax = p[k], ay = p[k + 1], bx = p[(k + 2) % n], by = p[(k + 3) % n];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const x0 = Math.min(ax, bx) - 1e-6, x1 = Math.max(ax, bx) + 1e-6, y0 = Math.min(ay, by) - 1e-6, y1 = Math.max(ay, by) + 1e-6;
      ts.length = 0; ts.push(0, 1);
      for (let j = 0; j < P.length; j++) {
        const q = P[j], m = q.length;
        if (m < 6) continue;
        for (let l = 0; l < m; l += 2) {
          if (j === i && l === k) continue;
          const cx = q[l], cy = q[l + 1], ex = q[(l + 2) % m], ey = q[(l + 3) % m];
          if ((cx > x1 && ex > x1) || (cx < x0 && ex < x0) || (cy > y1 && ey > y1) || (cy < y0 && ey < y0)) continue;
          const t = edgeT(ax, ay, bx, by, cx, cy, ex, ey);
          if (t > 0) ts.push(t);
        }
      }
      ts.sort((a, b) => a - b);
      const nx = -dy / len, ny = dx / len;
      for (let s = 0; s + 1 < ts.length; s++) {
        const t0 = ts[s], t1 = ts[s + 1];
        if ((t1 - t0) * len < 1e-3) continue;
        const sx0 = ax + dx * t0, sy0 = ay + dy * t0, sx1 = ax + dx * t1, sy1 = ay + dy * t1;
        const mx = (sx0 + sx1) / 2, my = (sy0 + sy1) / 2;
        const L = covered(P, mx + nx * e, my + ny * e), R = covered(P, mx - nx * e, my - ny * e);
        if (L === R) continue;
        const seg = L ? [sx0, sy0, sx1, sy1] : [sx1, sy1, sx0, sy0];
        const key = seg.map((v) => Math.round(v * 100)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        segs.push(seg);
      }
    }
  }
  return segs;
}

function dropCollinear(p, closed) {
  const n = p.length / 2;
  if (n < 3) return p;
  const out = [];
  for (let k = 0; k < n; k++) {
    if (!closed && (k === 0 || k === n - 1)) { out.push(p[2 * k], p[2 * k + 1]); continue; }
    const a = (k + n - 1) % n, b = (k + 1) % n;
    const ux = p[2 * k] - p[2 * a], uy = p[2 * k + 1] - p[2 * a + 1], vx = p[2 * b] - p[2 * k], vy = p[2 * b + 1] - p[2 * k + 1];
    const cr = ux * vy - uy * vx, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (Math.abs(cr) <= 1e-6 * lu * lv && ux * vx + uy * vy > 0) continue;
    out.push(p[2 * k], p[2 * k + 1]);
  }
  return out.length >= 4 ? out : p;
}

// Joins oriented segments end to start into polylines: [{ p: flat points, closed }].
export function chainSegments(segs, tol = 0.01) {
  const n = segs.length, used = new Uint8Array(n), out = [];
  const key = (x, y) => Math.round(x * 100) * 1048576 + Math.round(y * 100);
  const byA = new Map(), byB = new Map();
  const put = (m, k, i) => { const l = m.get(k); if (l) l.push(i); else m.set(k, [i]); };
  for (let i = 0; i < n; i++) { put(byA, key(segs[i][0], segs[i][1]), i); put(byB, key(segs[i][2], segs[i][3]), i); }
  const find = (m, x, y, end) => {
    const cx = Math.round(x * 100), cy = Math.round(y * 100);
    let best = -1, bd = tol * tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = m.get((cx + dx) * 1048576 + cy + dy);
      if (!l) continue;
      for (const i of l) {
        if (used[i]) continue;
        const s = segs[i], d = (s[end] - x) ** 2 + (s[end + 1] - y) ** 2;
        if (d <= bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const p = segs[i].slice();
    let closed = false;
    for (;;) {
      const ex = p[p.length - 2], ey = p[p.length - 1];
      if (p.length > 4 && (ex - p[0]) ** 2 + (ey - p[1]) ** 2 <= tol * tol) { closed = true; p.length -= 2; break; }
      const j = find(byA, ex, ey, 0);
      if (j < 0) break;
      used[j] = 1; p.push(segs[j][2], segs[j][3]);
    }
    if (!closed) {
      for (;;) {
        const j = find(byB, p[0], p[1], 2);
        if (j < 0) break;
        used[j] = 1; p.unshift(segs[j][0], segs[j][1]);
      }
    }
    out.push({ p: dropCollinear(p, closed), closed });
  }
  return out;
}

// A drawn wall line with its damage sample cells. kind 0 = zone wall (comp = zone index), 1 = standalone wall.
function makeTrack(world, pts, closed, kind, comp) {
  const n = pts.length / 2, segN = closed ? n : n - 1;
  if (segN < 1 || (closed && n < 3)) return null;
  const cum = new Float64Array(segN + 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = pts[2 * k], y = pts[2 * k + 1];
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  for (let k = 0; k < segN; k++) {
    const j = (k + 1) % n;
    cum[k + 1] = cum[k] + Math.hypot(pts[2 * j] - pts[2 * k], pts[2 * j + 1] - pts[2 * k + 1]);
  }
  const L = cum[segN];
  if (!(L > 0.01)) return null;
  const ns = Math.max(1, Math.ceil(L / SAMPLE_M)), step = L / ns;
  const tr = { kind, comp, pts, closed, n, segN, cum, L, ns, step, cells: new Int32Array(ns), bb: [x0, y0, x1, y1] };
  const q = [0, 0, 0, 0, 0];
  for (let s = 0; s < ns; s++) { trackAt(tr, (s + 0.5) * step, q); tr.cells[s] = sampleCell(world, q[0], q[1], kind === 0); }
  return tr;
}

// The wall cell under a point of the drawn line, or the nearest neighbouring one when the line runs just past the raster.
function sampleCell(world, x, y, zone) {
  const g = world.grid, cs = g.cell, block = world.block;
  const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
  const ok = (c) => (zone ? block[c] === 1 || block[c] === 3 : block[c] !== 0);
  if (cx >= 0 && cy >= 0 && cx < g.gw && cy < g.gh && ok(cy * g.gw + cx)) return cy * g.gw + cx;
  let best = -1, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const X = cx + dx, Y = cy + dy;
    if ((dx | dy) === 0 || X < 0 || Y < 0 || X >= g.gw || Y >= g.gh) continue;
    const c = Y * g.gw + X;
    if (!ok(c)) continue;
    const d = ((X + 0.5) * cs - x) ** 2 + ((Y + 0.5) * cs - y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// Point at arc length a: out = [x, y, ux, uy, segment].
function trackAt(tr, a, out) {
  const L = tr.L, cum = tr.cum;
  if (tr.closed) { a %= L; if (a < 0) a += L; } else a = clamp(a, 0, L);
  let lo = 0, hi = tr.segN - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= a) lo = mid; else hi = mid - 1; }
  const p = tr.pts, i = 2 * lo, j = 2 * ((lo + 1) % tr.n);
  const sl = cum[lo + 1] - cum[lo] || 1, f = (a - cum[lo]) / sl;
  out[0] = p[i] + (p[j] - p[i]) * f; out[1] = p[i + 1] + (p[j + 1] - p[i + 1]) * f;
  out[2] = (p[j] - p[i]) / sl; out[3] = (p[j + 1] - p[i + 1]) / sl; out[4] = lo;
  return out;
}

const TQ = [0, 0, 0, 0, 0];
function arcPath(path, tr, a, b, cam) {
  const z = cam.zoom, ox = cam.x, oy = cam.y, p = tr.pts, cum = tr.cum, L = tr.L;
  trackAt(tr, a, TQ);
  path.moveTo((TQ[0] - ox) * z, (TQ[1] - oy) * z);
  let k = TQ[4], base = tr.closed ? Math.floor(a / L) * L : 0;
  for (let guard = 0; guard <= tr.segN + 1; guard++) {
    if (base + cum[k + 1] >= b - 1e-6) break;
    const vi = 2 * ((k + 1) % tr.n);
    path.lineTo((p[vi] - ox) * z, (p[vi + 1] - oy) * z);
    if (++k >= tr.segN) { if (!tr.closed) break; k = 0; base += L; }
  }
  trackAt(tr, b, TQ);
  path.lineTo((TQ[0] - ox) * z, (TQ[1] - oy) * z);
}

// arcPath minus the track's gate stretches.
const CUTS = [];
function cutArc(path, tr, a, b, cam) {
  const G = tr.gaps;
  if (!G) { arcPath(path, tr, a, b, cam); return; }
  CUTS.length = 0;
  const L = tr.L, n = tr.closed ? 3 : 1;
  for (const g of G) for (let k = 0; k < n; k++) { const sh = tr.closed ? (k - 1) * L : 0, x0 = g[0] + sh, x1 = g[1] + sh; if (x1 > a && x0 < b) CUTS.push(x0, x1); }
  if (!CUTS.length) { arcPath(path, tr, a, b, cam); return; }
  const idx = [];
  for (let k = 0; k < CUTS.length; k += 2) idx.push(k);
  idx.sort((p, q) => CUTS[p] - CUTS[q]);
  let cur = a;
  for (const k of idx) {
    if (CUTS[k] > cur + 1e-3) arcPath(path, tr, cur, Math.min(CUTS[k], b), cam);
    cur = Math.max(cur, CUTS[k + 1]);
    if (cur >= b) return;
  }
  if (b > cur + 1e-3) arcPath(path, tr, cur, b, cam);
}

// Arc length of the point on the track nearest (x, y), and its distance: [a, d].
function trackProject(tr, x, y) {
  const p = tr.pts, n = tr.n;
  let ba = 0, bd = Infinity;
  for (let k = 0; k < tr.segN; k++) {
    const i = 2 * k, j = 2 * ((k + 1) % n);
    const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1], l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - p[i]) * dx + (y - p[i + 1]) * dy) / l2, 0, 1);
    const d = Math.hypot(p[i] + dx * t - x, p[i + 1] + dy * t - y);
    if (d < bd) { bd = d; ba = tr.cum[k] + t * Math.sqrt(l2); }
  }
  return [ba, bd];
}

function ringPath(path, p, cam) {
  const z = cam.zoom, ox = cam.x, oy = cam.y;
  path.moveTo((p[0] - ox) * z, (p[1] - oy) * z);
  for (let k = 2; k < p.length; k += 2) path.lineTo((p[k] - ox) * z, (p[k + 1] - oy) * z);
  path.closePath();
}

// True when arc length s lies in one of the track's gate stretches, widened by pad metres.
function inGap(tr, s, pad) {
  const G = tr.gaps;
  if (!G) return false;
  const L = tr.L, k0 = tr.closed ? -1 : 0, k1 = tr.closed ? 1 : 0;
  if (tr.closed) { s %= L; if (s < 0) s += L; }
  for (const g of G) for (let k = k0; k <= k1; k++) if (s >= g[0] + k * L - pad && s <= g[1] + k * L + pad) return true;
  return false;
}

// Rubble ticks scattered along a broken stretch [a, b] of a wall line, none in a gate's opening.
function rubblePath(path, tr, a, b, cam, lw, seed) {
  const z = cam.zoom, len = b - a;
  const n = Math.max(1, Math.round(len / Math.max(2.2, 7 / z)));
  const hl = Math.max(1.6, lw * 0.3), pad = hl / z;
  let drawn = 0;
  for (let j = 0; j < n; j++) {
    const s = a + (j + 0.5) * len / n;
    if (inGap(tr, s, pad)) continue;
    drawn++;
    trackAt(tr, s, TQ);
    const h = hash2(seed * 977 + j, Math.floor(s * 4));
    const off = (((h & 255) / 255) - 0.5) * lw * 0.7;
    const ang = ((((h >> 8) & 255) / 255) - 0.5) * 1.2 + ((j & 1) ? 0.9 : -0.9);
    const c = Math.cos(ang), sn = Math.sin(ang), ux = TQ[2], uy = TQ[3];
    const dx = ux * c - uy * sn, dy = ux * sn + uy * c;
    const sx = (TQ[0] - cam.x) * z - uy * off, sy = (TQ[1] - cam.y) * z + ux * off;
    path.moveTo(sx - dx * hl, sy - dy * hl); path.lineTo(sx + dx * hl, sy + dy * hl);
  }
  return drawn;
}

function hatchPattern(ctx, color, dpr, gap = 7, width = 1) {
  const n = Math.max(4, Math.round(gap * dpr));
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.lineWidth = width * dpr;
  g.beginPath();
  g.moveTo(-1, n + 1); g.lineTo(n + 1, -1);
  g.moveTo(-1, 1); g.lineTo(1, -1);
  g.moveTo(n - 1, n + 1); g.lineTo(n + 1, n - 1);
  g.stroke();
  const p = ctx.createPattern(c, 'repeat');
  if (p && p.setTransform && typeof DOMMatrix !== 'undefined') p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  return p;
}

// ---------------------------------------------------------------- unit plan symbols
// Draws a unit glyph centred at (x, y) with half-size s (CSS px). Also used for toolbar icons.
export function drawUnitGlyph(ctx, type, x, y, s, color, paper, o = {}) {
  const ang = o.angle || 0, level = o.level || 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color; ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
  const letter = (ch) => {
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.max(7, Math.round(s * 1.15))}px ${FONT_MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, s * 0.06);
  };
  switch (type) {
    case 'garrison': {
      const h = s * 0.85;
      ctx.fillRect(-h, -h, 2 * h, 2 * h);
      if (level > 0) {
        ctx.fillStyle = paper;
        const nw = Math.max(1, s * 0.16), step = (2 * h) / (level + 1);
        for (let k = 1; k <= level; k++) ctx.fillRect(-h + step * k - nw / 2, h - s * 0.55, nw, s * 0.55);
      }
      break;
    }
    case 'sniper': {
      ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.92, s * 0.75); ctx.lineTo(-s * 0.92, s * 0.75); ctx.closePath(); ctx.fill();
      ctx.fillStyle = paper; ctx.fillRect(-s * 0.1, -s * 0.1, s * 0.2, s * 0.5);
      break;
    }
    case 'turret': {
      ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(0, 0, s * 0.72, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s * 0.28, 0, TAU); ctx.fill();
      ctx.lineWidth = Math.max(1.5, s * 0.26); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * s * 1.45, Math.sin(ang) * s * 1.45); ctx.stroke();
      break;
    }
    case 'mortar': case 'gasMortar': case 'fireMortar': {
      ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(0, 0, s * 0.92, 0, TAU); ctx.fill(); ctx.stroke();
      letter(type === 'mortar' ? 'M' : type === 'gasMortar' ? 'G' : 'F');
      break;
    }
    case 'mlrs': {
      ctx.fillStyle = paper; ctx.fillRect(-s, -s * 0.7, 2 * s, 1.4 * s); ctx.strokeRect(-s, -s * 0.7, 2 * s, 1.4 * s);
      ctx.fillStyle = color;
      const r = Math.max(0.8, s * 0.15);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { ctx.beginPath(); ctx.arc(-s * 0.55 + i * s * 0.55, -s * 0.28 + j * s * 0.56, r, 0, TAU); ctx.fill(); }
      break;
    }
    case 'howitzer': {
      ctx.beginPath(); ctx.arc(0, 0, s * 0.66, 0, TAU); ctx.fill();
      ctx.lineWidth = Math.max(1.5, s * 0.24); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * s * 2.1, Math.sin(ang) * s * 2.1); ctx.stroke();
      break;
    }
    case 'battleship': {
      ctx.rotate(ang);
      ctx.fillStyle = paper;
      ctx.beginPath(); ctx.moveTo(s * 1.9, 0); ctx.quadraticCurveTo(s * 0.9, -s * 0.7, -s * 1.5, -s * 0.55); ctx.lineTo(-s * 1.6, s * 0.55);
      ctx.quadraticCurveTo(s * 0.9, s * 0.7, s * 1.9, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color;
      for (const dx of [-0.8, 0, 0.8]) { ctx.beginPath(); ctx.arc(dx * s, 0, s * 0.18, 0, TAU); ctx.fill(); }
      break;
    }
    case 'railgun': {
      ctx.rotate(ang);
      ctx.fillRect(-s * 1.7, -s * 0.32, s * 3.4, s * 0.64);
      ctx.fillStyle = paper; ctx.fillRect(-s * 1.4, -s * 0.08, s * 2.6, s * 0.16);
      break;
    }
    case 'mine': {
      const r = s * 0.55;
      ctx.lineWidth = Math.max(1, s * 0.22);
      ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke();
      break;
    }
    case 'chemical': {
      ctx.beginPath(); ctx.arc(0, 0, s * 0.55, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, s * 0.18, 0, TAU); ctx.fill();
      break;
    }
    case 'napalm': {
      ctx.fillStyle = paper;
      ctx.beginPath(); ctx.moveTo(0, -s * 0.85); ctx.lineTo(s * 0.85, 0); ctx.lineTo(0, s * 0.85); ctx.lineTo(-s * 0.85, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, TAU); ctx.fill();
      break;
    }
    case 'c4': {
      const h = s * 0.8;
      ctx.fillStyle = paper; ctx.fillRect(-h, -h * 0.75, 2 * h, 1.5 * h); ctx.strokeRect(-h, -h * 0.75, 2 * h, 1.5 * h);
      ctx.beginPath(); ctx.moveTo(-h, -h * 0.75); ctx.lineTo(h, h * 0.75); ctx.moveTo(h, -h * 0.75); ctx.lineTo(-h, h * 0.75); ctx.stroke();
      break;
    }
    case 'spikes': {
      ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
      for (let k = -2; k <= 2; k++) { ctx.moveTo(k * s * 0.42, -s * 0.4); ctx.lineTo(k * s * 0.42, s * 0.4); }
      ctx.stroke();
      break;
    }
    case 'oil': {
      ctx.lineWidth = Math.max(2, s * 0.5); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-s, s * 0.3); ctx.quadraticCurveTo(0, -s * 0.6, s, s * 0.2); ctx.stroke();
      break;
    }
    case 'patrolBoat': case 'gunboat': case 'rocketBarge': case 'ferry': case 'waterMine':
      drawNavalGlyph(ctx, type, s, color, paper, ang);
      break;
    default: {
      ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(0, 0, s * 0.85, 0, TAU); ctx.fill(); ctx.stroke();
      letter(String(type || '?').charAt(0).toUpperCase());
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- agent discs and mutants
// Rows [dy, x0, x1] of a d-pixel disc: pixels whose centre lies within d/2 - 0.2 of the disc centre (3 px gives a plus).
const SPANS = new Map();
function discSpans(d) {
  let sp = SPANS.get(d);
  if (sp) return sp;
  const out = [], c = d / 2, r2 = (d / 2 - 0.2) ** 2;
  for (let y = 0; y < d; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < d; x++) if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= r2) { if (x0 < 0) x0 = x; x1 = x + 1; }
    if (x0 >= 0) out.push(y, x0, x1);
  }
  sp = Int16Array.from(out);
  SPANS.set(d, sp);
  return sp;
}

const MUT_KEYS = [null, 'explosive', 'shielded', 'swimmer', 'giant'];

// One mutant: its own colour and mark, with a deeper fill and heavier ring for more health left (tier 2 full .. 0 low).
// Explosive: spiked burst. Shielded: steel plate, plus an outer ring while its shield holds. Swimmer: wave. Giant: bullseye.
export function drawMutant(ctx, sub, x, y, r, pal, tier = 2, shield = 0) {
  pal = getPalette(pal);
  const ag = pal.agent, base = ag[MUT_KEYS[sub]] || ag.zombie, ink = pal.ink;
  // health shows in the ring weight only; a paled fill vanished against buildings and water
  const fill = base;
  const big = r >= 3.2;
  ctx.save();
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  if (sub === 1 && big) {
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, r * 0.16);
    const r0 = r + 0.5, r1 = r + Math.max(2, r * 0.55);
    ctx.beginPath();
    for (let k = 0; k < 8; k++) { const a = (k + 0.5) * TAU / 8, c = Math.cos(a), s = Math.sin(a); ctx.moveTo(x + c * r0, y + s * r0); ctx.lineTo(x + c * r1, y + s * r1); }
    ctx.stroke();
  }
  if (sub === 2 && shield > 0) {
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(0.8, r * 0.3 * Math.min(1, shield));
    ctx.beginPath(); ctx.arc(x, y, r + Math.max(2, r * 0.45), 0, TAU); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = tier >= 2 ? Math.max(1.6, r * 0.26) : tier === 1 ? Math.max(1.2, r * 0.15) : 1;
  ctx.strokeStyle = ink;
  ctx.stroke();
  if (big) {
    if (sub === 1) { ctx.fillStyle = ag.markDark; ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, TAU); ctx.fill(); }
    else if (sub === 2) { const h = r * 0.38; ctx.fillStyle = ag.markDark; ctx.fillRect(x - h, y - h, 2 * h, 2 * h); }
    else if (sub === 3) {
      ctx.strokeStyle = ag.markLight; ctx.lineWidth = Math.max(1, r * 0.22);
      ctx.beginPath(); ctx.moveTo(x - r * 0.62, y + r * 0.12); ctx.lineTo(x - r * 0.2, y - r * 0.18); ctx.lineTo(x + r * 0.2, y + r * 0.18); ctx.lineTo(x + r * 0.62, y - r * 0.12); ctx.stroke();
    } else if (sub === 4) {
      ctx.strokeStyle = ag.markLight; ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, TAU); ctx.stroke();
    }
  }
  ctx.restore();
}

export const KEY_KINDS = [
  ['civ', 'Resident'], ['panic', 'Panicking'], ['turning', 'Turning'], ['zombie', 'Zombie'],
  ['police', 'Police'], ['militia', 'Militia'], ['soldier', 'Soldier'],
  ['explosive', 'Explosive'], ['shielded', 'Armoured'], ['swimmer', 'Swimmer'], ['giant', 'Giant'],
];

// A map-key swatch of an agent as drawn on the map, centred at (x, y). r overrides the size; tier sets mutant health.
export function drawAgentKey(ctx, kind, x, y, pal, r = 3.5, tier = 2) {
  pal = getPalette(pal);
  const ag = pal.agent, sub = MUT_KEYS.indexOf(kind);
  if (sub > 0) { drawMutant(ctx, sub, x, y, r, pal, tier, sub === 2 ? 1 : 0); return; }
  const col = { civ: ag.civ, panic: ag.civPanic, turning: ag.turning, zombie: ag.zombie, police: ag.police, militia: ag.militia, soldier: ag.soldier }[kind] || ag.zombie;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = col; ctx.fill();
  ctx.lineWidth = clamp(r * 0.2, 0.6, 1.1); ctx.strokeStyle = ag.edge; ctx.stroke();
  if (kind === 'police') { ctx.fillStyle = ag.policeDot; ctx.beginPath(); ctx.arc(x, y, r * 0.38, 0, TAU); ctx.fill(); }
  ctx.restore();
}

function drawVehicleGlyph(ctx, v, sx, sy, z, pal, realT, color) {
  const kind = v.kind;
  const ang = Number.isFinite(v.heading) ? v.heading : Number.isFinite(v.angle) ? v.angle : 0;
  if (kind === 'heli' || kind === 'gunship' || kind === 'plane' || kind === 'medevac') {
    const size = Math.max(kind === 'gunship' || kind === 'plane' ? 13 : 9, (kind === 'gunship' ? 14 : kind === 'plane' ? 16 : 7) * z);
    drawAircraft(ctx, kind === 'gunship' ? 'plane' : kind, sx, sy, ang, size, pal, realT, 1);
    return size;
  }
  const dims = { apc: [7.5, 3.6], bus: [12, 3.2], bulldozer: [6.5, 3.6], tank: [7.6, 3.8] }[kind] || [6, 3];
  const k = Math.max(z, 2.2);
  const L = dims[0] * k, Wd = dims[1] * k;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle = pal.buildingShadow; ctx.save(); ctx.translate(2, 2); ctx.rotate(ang); ctx.fillRect(-L / 2, -Wd / 2, L, Wd); ctx.restore();
  ctx.rotate(ang);
  ctx.fillStyle = kind === 'bus' ? pal.card : pal.paper2;
  ctx.strokeStyle = color; ctx.lineWidth = 1.25;
  ctx.fillRect(-L / 2, -Wd / 2, L, Wd); ctx.strokeRect(-L / 2, -Wd / 2, L, Wd);
  ctx.fillStyle = color;
  if (kind === 'tank') {
    ctx.beginPath(); ctx.arc(-L * 0.05, 0, Wd * 0.36, 0, TAU); ctx.fill();
    ctx.lineWidth = Math.max(1.5, Wd * 0.14); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L * 0.75, 0); ctx.stroke();
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-L / 2, -Wd * 0.32); ctx.lineTo(L / 2, -Wd * 0.32); ctx.moveTo(-L / 2, Wd * 0.32); ctx.lineTo(L / 2, Wd * 0.32); ctx.stroke();
  } else if (kind === 'apc') {
    ctx.beginPath(); ctx.moveTo(L * 0.2, -Wd * 0.35); ctx.lineTo(L * 0.42, 0); ctx.lineTo(L * 0.2, Wd * 0.35); ctx.stroke();
    ctx.fillRect(-L * 0.25, -Wd * 0.18, Wd * 0.36, Wd * 0.36);
  } else if (kind === 'bus') {
    const n = 5;
    for (let i = 0; i < n; i++) ctx.fillRect(-L / 2 + L * (0.12 + i * 0.16), -Wd * 0.28, L * 0.09, Wd * 0.18);
    ctx.fillRect(L * 0.38, -Wd * 0.4, L * 0.06, Wd * 0.8);
  } else if (kind === 'bulldozer') {
    ctx.lineWidth = Math.max(2, Wd * 0.18);
    ctx.beginPath(); ctx.moveTo(L * 0.62, -Wd * 0.72); ctx.lineTo(L * 0.62, Wd * 0.72); ctx.stroke();
    ctx.fillRect(-L * 0.3, -Wd * 0.25, L * 0.35, Wd * 0.5);
  }
  ctx.restore();
  return Math.max(L, Wd) / 2;
}

function gateGeometry(world, gt) {
  const g = world.grid, cs = g.cell, cells = gt.cells;
  if (!cells || !cells.length) return null;
  let best = -1, ai = 0, bi = 0;
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const dx = (cells[i] % g.gw) - (cells[j] % g.gw), dy = ((cells[i] / g.gw) | 0) - ((cells[j] / g.gw) | 0), d = dx * dx + dy * dy;
    if (d > best) { best = d; ai = i; bi = j; }
  }
  const ax = (cells[ai] % g.gw + 0.5) * cs, ay = (((cells[ai] / g.gw) | 0) + 0.5) * cs;
  const bx = (cells[bi] % g.gw + 0.5) * cs, by = (((cells[bi] / g.gw) | 0) + 0.5) * cs;
  let dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
  if (L < 1e-3) { dx = 1; dy = 0; L = 1; }
  dx /= L; dy /= L;
  return { ax: ax - dx * cs * 0.9, ay: ay - dy * cs * 0.9, bx: bx + dx * cs * 0.9, by: by + dy * cs * 0.9, nx: -dy, ny: dx };
}

export class WorldRenderer {
  constructor(opts = {}) {
    this.pal = getPalette(opts.palette);
    this.combat = opts.combat || null;
    this.dirty = true;
    this.scorch = new Set();
    this._pats = null;
    this._patKey = '';
    this.comps = [];
    this.gateGeo = [];
    this.stats = { agents: 0, drawn: 0 };
  }

  setPalette(name) { this.pal = getPalette(name); this._patKey = ''; }
  invalidate() { this.dirty = true; }
  resetStage() { this.scorch.clear(); this.dirty = true; }

  _patterns(ctx, dpr) {
    const key = `${this.pal.name}|${dpr}`;
    if (this._patKey !== key) {
      const z = this.pal.zone;
      this._pats = {
        zone: hatchPattern(ctx, z.hatch, dpr, 7, 1),
        breach: hatchPattern(ctx, rgba(this.pal.stamp, 0.4), dpr, 5, 1),
        wall: hatchPattern(ctx, mix(z.wall, this.pal.ink, 0.45), dpr, 3.5, 0.9),
        corridor: hatchPattern(ctx, rgba(this.pal.amber, 0.22), dpr, 9, 1),
      };
      this._patKey = key;
    }
    return this._pats;
  }

  _rebuild(world) {
    const byId = new Map();
    for (const p of world.zones.polys) byId.set(p.id, p);
    this.comps = world.zones.comps.map((c) => {
      const polys = c.polys.map((id) => byId.get(id)).filter(Boolean).map((p) => p.p);
      const loops = polys.length === 1 ? [{ p: cleanRing(polys[0]), closed: true }] : chainSegments(outlineSegments(polys));
      return { c, polys, loops };
    });
    const tracks = [];
    this.comps.forEach((e, ci) => { for (const lp of e.loops) { const tr = makeTrack(world, lp.p, lp.closed, 0, ci); if (tr) tracks.push(tr); } });
    for (const w of world.walls) { const tr = makeTrack(world, cleanRing(w.p, false), false, 1, -1); if (tr) tracks.push(tr); }
    this.tracks = tracks;
    let maxNs = 1;
    for (const tr of tracks) if (tr.ns > maxNs) maxNs = tr.ns;
    if (!this._cls || this._cls.length < maxNs) this._cls = new Uint8Array(maxNs);
    this.gateGeo = world.zones.gates.map((gt, k) => this._gateOnTrack(gt) || this._gateOnLine(world, gt, k) || gateGeometry(world, gt));
    this._blockKey = world._blockCells;
    this.dirty = false;
  }

  // A gate the sim placed on the true edge (x0..x1): also cut that exact stretch out of its wall line.
  _gateOnTrack(gt) {
    if (!Number.isFinite(gt.x0) || !Number.isFinite(gt.x1)) return null;
    const L = Math.hypot(gt.x1 - gt.x0, gt.y1 - gt.y0);
    if (L < 0.5) return null;
    let best = null;
    for (const tr of this.tracks) {
      if (tr.kind !== 0 || tr.comp !== gt.comp) continue;
      const a = trackProject(tr, gt.x0, gt.y0), b = trackProject(tr, gt.x1, gt.y1);
      if (a[1] > 1 || b[1] > 1 || (best && a[1] + b[1] >= best.d)) continue;
      best = { tr, a: a[0], b: b[0], d: a[1] + b[1] };
    }
    if (best) {
      let a0 = Math.min(best.a, best.b), a1 = Math.max(best.a, best.b);
      if (best.tr.closed && a1 - a0 > best.tr.L / 2) { const t = a0; a0 = a1; a1 = t + best.tr.L; }
      (best.tr.gaps || (best.tr.gaps = [])).push([a0, a1]);
    }
    return { ax: gt.x0, ay: gt.y0, bx: gt.x1, by: gt.y1, nx: -(gt.y1 - gt.y0) / L, ny: (gt.x1 - gt.x0) / L };
  }

  // The gate as a straight piece of its wall line: from the first to the last line sample that falls in the gate's cells.
  _gateOnLine(world, gt, k) {
    const gi = world.gateIdx, id = k + 1;
    let best = null;
    for (const tr of this.tracks) {
      if (tr.kind !== 0 || tr.comp !== gt.comp) continue;
      const ns = tr.ns, cells = tr.cells, inGate = (s) => { const c = cells[s]; return c >= 0 && gi[c] === id; };
      for (let s = 0; s < ns; s++) {
        if (!inGate(s)) continue;
        if (s > 0 ? inGate(s - 1) : tr.closed && inGate(ns - 1)) continue;
        let m = 1;
        while (m < ns && (tr.closed || s + m < ns) && inGate((s + m) % ns)) m++;
        if (!best || m > best.m) best = { tr, s, m };
      }
    }
    if (!best) return null;
    const { tr, s, m } = best, q = [0, 0, 0, 0, 0];
    trackAt(tr, s * tr.step, q); const ax = q[0], ay = q[1];
    trackAt(tr, (s + m) * tr.step, q); const bx = q[0], by = q[1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 0.5) return null;
    return { ax, ay, bx, by, nx: -(by - ay) / L, ny: (bx - ax) / L };
  }

  // st: { dpr, ext (s of extrapolation), t (world s), rt (real s), rings, sel, hover, ghost }
  draw(ctx, world, cam, st) {
    if (this.dirty || this._blockKey !== world._blockCells) this._rebuild(world);
    const pal = this.pal;
    const dpr = st.dpr || 1;
    const pats = this._patterns(ctx, dpr);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._fire(ctx, world, cam);
    this._zones(ctx, world, cam, pats, st);
    this._corridors(ctx, world, cam, pats);
    this._holds(ctx, world, cam);
    this._walls(ctx, world, cam, pats);
    this._pickups(ctx, world, cam, st);
    this._pits(ctx, world, cam, st);
    this._agents(ctx, world, cam, st);
    this._units(ctx, world, cam, st);
    this._vehicles(ctx, world, cam, st);
    drawProjectiles(ctx, world, cam, st.t, pal);
    const flash = drawEffects(ctx, world, cam, st.t, pal, st.rt, st.abilityName);
    if (st.rings) this._allRings(ctx, world, cam);
    this._selection(ctx, world, cam, st);
    ctx.restore();
    return flash;
  }

  // ---------------------------------------------------------------- fire
  _fire(ctx, world, cam) {
    const list = world._fireList;
    const nav = world.nav, ccs = nav.ccell, cgw = nav.cgw, z = cam.zoom, ox = cam.x, oy = cam.y;
    const bb = cam.visibleBBox(10);
    const pal = this.pal;
    if (list && list.length) for (let k = 0; k < list.length; k++) this.scorch.add(list[k]);
    if (this.scorch.size) {
      const p = new Path2D();
      let n = 0;
      const step = Math.max(1, Math.round(1.2 / Math.max(0.2, ccs * z / 6)));
      for (const c of this.scorch) {
        const cx = c % cgw, cy = (c / cgw) | 0;
        const wx = cx * ccs, wy = cy * ccs;
        if (wx > bb[2] || wy > bb[3] || wx + ccs < bb[0] || wy + ccs < bb[1]) continue;
        if (world.fire[c] > 0) continue;
        const sx = (wx - ox) * z, sy = (wy - oy) * z, w = ccs * z;
        const dots = w < 3 ? 1 : 4;
        for (let j = 0; j < dots; j += step) {
          const h = hash2(c, j);
          p.rect(sx + ((h & 255) / 255) * w, sy + (((h >> 8) & 255) / 255) * w, 1.3, 1.3);
        }
        n++;
      }
      if (n) { ctx.fillStyle = rgba(pal.ink, 0.45); ctx.fill(p); }
    }
    if (!list || !list.length) return;
    const flick = (performance.now() / 120) | 0;
    const body = new Path2D(), emb = new Path2D();
    for (let k = 0; k < list.length; k++) {
      const c = list[k], I = world.fire[c];
      if (!(I > 0)) continue;
      const cx = c % cgw, cy = (c / cgw) | 0;
      const wx = cx * ccs, wy = cy * ccs;
      if (wx > bb[2] || wy > bb[3] || wx + ccs < bb[0] || wy + ccs < bb[1]) continue;
      const sx = (wx - ox) * z, sy = (wy - oy) * z, w = ccs * z;
      body.rect(sx, sy, w, w);
      const dots = w < 4 ? 1 : 3 + Math.round(I * 3);
      for (let j = 0; j < dots; j++) {
        const h = hash2(c * 7 + j, flick + j);
        const s = 1 + (h & 1);
        emb.rect(sx + ((h >> 4) & 255) / 255 * w, sy + ((h >> 12) & 255) / 255 * w, s, s);
      }
    }
    ctx.globalAlpha = 0.33;
    ctx.fillStyle = pal.fx.fire;
    ctx.fill(body);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.fx.ember;
    ctx.fill(emb);
    ctx.fillStyle = pal.fx.fire;
  }

  // ---------------------------------------------------------------- zones / corridors / holds
  _polyPath(path, p, cam) {
    const z = cam.zoom, ox = cam.x, oy = cam.y;
    path.moveTo((p[0] - ox) * z, (p[1] - oy) * z);
    for (let k = 2; k < p.length; k += 2) path.lineTo((p[k] - ox) * z, (p[k + 1] - oy) * z);
    path.closePath();
  }

  // The zone's area as its union outline; falls back to the raw polygons if no closed loop came out.
  _compPath(polys, loops, cam) {
    const path = new Path2D();
    let n = 0;
    for (const lp of loops) if (lp.closed && lp.p.length >= 6) { this._polyPath(path, lp.p, cam); n++; }
    if (!n) for (const p of polys) this._polyPath(path, p, cam);
    return path;
  }

  _zones(ctx, world, cam, pats, st) {
    const pal = this.pal, z = cam.zoom;
    for (const { c, polys, loops } of this.comps) {
      if (!polys.length) continue;
      const path = this._compPath(polys, loops, cam);
      ctx.fillStyle = c.breached ? rgba(pal.stamp, 0.08) : pal.zone.fill;
      ctx.fill(path, 'evenodd');
      ctx.fillStyle = c.breached ? pats.breach : pats.zone;
      ctx.fill(path, 'evenodd');
      if (c.breached && z > 0.25) {
        const sx = (c.cx - cam.x) * z, sy = (c.cy - cam.y) * z;
        if (sx > -80 && sy > -40 && sx < cam.w + 80 && sy < cam.h + 40) stampLabel(ctx, 'BREACHED', sx, sy, pal.stamp, -0.07, 14);
      }
      if (world.owners > 1 && c.owner > 0 && z > 0.4) {
        const sx = (c.cx - cam.x) * z, sy = (c.cy - cam.y) * z;
        tag(ctx, 'PARTNER', sx - 24, sy + 14, pal, pal.carbon);
      }
    }
  }

  _corridors(ctx, world, cam, pats) {
    if (!world.corridors.length) return;
    const pal = this.pal, z = cam.zoom;
    for (const co of world.corridors) this.drawCorridor(ctx, cam, co.x0, co.y0, co.x1, co.y1, co.w, pats, co.owner > 0 && world.owners > 1 ? pal.carbon : null);
  }

  drawCorridor(ctx, cam, x0, y0, x1, y1, w, pats = this._pats, color = null, alpha = 1) {
    const pal = this.pal, z = cam.zoom;
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L, nx = -uy * w / 2, ny = ux * w / 2;
    const S = (x, y) => [(x - cam.x) * z, (y - cam.y) * z];
    const c = [S(x0 + nx, y0 + ny), S(x1 + nx, y1 + ny), S(x1 - nx, y1 - ny), S(x0 - nx, y0 - ny)];
    const col = color || pal.zone.corridor;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(c[k][0], c[k][1]); ctx.closePath();
    ctx.fillStyle = pal.zone.corridorFill; ctx.fill();
    if (pats && pats.corridor) { ctx.fillStyle = pats.corridor; ctx.fill(); }
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([7, 4]); ctx.stroke(); ctx.setLineDash([]);
    const Lp = L * z, half = Math.max(3, Math.min(w * z * 0.32, 13));
    const gap = Math.max(16, half * 2.4);
    const [sx0, sy0] = S(x0, y0);
    ctx.lineWidth = Math.max(1.5, Math.min(3, half * 0.3));
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (let d = gap * 0.6; d < Lp - half * 0.5; d += gap) {
      const px = sx0 + ux * d, py = sy0 + uy * d;
      ctx.moveTo(px - ux * half * 0.7 - uy * half, py - uy * half * 0.7 + ux * half);
      ctx.lineTo(px, py);
      ctx.lineTo(px - ux * half * 0.7 + uy * half, py - uy * half * 0.7 - ux * half);
    }
    ctx.stroke();
    const [hx, hy] = S(x1, y1);
    const ah = Math.max(6, Math.min(16, w * z * 0.45));
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(hx + ux * ah * 0.4, hy + uy * ah * 0.4);
    ctx.lineTo(hx - ux * ah - uy * ah * 0.7, hy - uy * ah + ux * ah * 0.7);
    ctx.lineTo(hx - ux * ah + uy * ah * 0.7, hy - uy * ah - ux * ah * 0.7); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  _holds(ctx, world, cam) {
    for (const h of world.holds) this.drawHold(ctx, cam, h.x, h.y, h.R, h.r, h.owner > 0 && world.owners > 1 ? this.pal.carbon : null);
  }

  drawHold(ctx, cam, x, y, R, r, color = null, alpha = 1) {
    const pal = this.pal, z = cam.zoom;
    const sx = (x - cam.x) * z, sy = (y - cam.y) * z;
    const Rp = R * z, rp = r * z;
    if (sx + Rp < -4 || sy + Rp < -4 || sx - Rp > cam.w + 4 || sy - Rp > cam.h + 4) return;
    const col = color || pal.zone.hold;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col; ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(sx, sy, Rp, 0, TAU); ctx.stroke();
    ctx.fillStyle = pal.zone.holdFill;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, rp), 0, TAU); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(sx - 4, sy); ctx.lineTo(sx + 4, sy); ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4); ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- walls and gates
  // Walls are drawn as true lines (zone union outlines and standalone polylines). Each stretch takes its state from the
  // grid cells under it, sampled every 2 m: healthy, worn, critical, or broken (a gap with rubble ticks).
  _wallCols() {
    if (this._wcPal === this.pal.name) return this._wc;
    const pal = this.pal, zc = pal.zone, sa = mix(zc.standalone, pal.ink2, 0.22);
    this._wc = [zc.wall, mix(zc.wall, pal.paper, 0.38), mix(zc.wall, pal.stamp, 0.55), sa, mix(sa, pal.paper, 0.38), mix(zc.standalone, pal.stamp, 0.55)];
    this._wcPal = pal.name;
    return this._wc;
  }

  _strokeWalls(ctx, P, used, lw, pats, alpha = 1) {
    const cols = this._wallCols();
    ctx.save();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.miterLimit = 3;
    for (let b = 0; b < 6; b++) {
      if (!used[b]) continue;
      const st = b % 3;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lw; ctx.strokeStyle = cols[b]; ctx.stroke(P[b]);
      if (lw >= 3 && st !== 2 && pats) { ctx.strokeStyle = pats.wall; ctx.globalAlpha = alpha * (st === 1 ? 0.3 : 0.55); ctx.stroke(P[b]); }
    }
    if (lw >= 6) {
      ctx.globalAlpha = alpha * 0.5; ctx.strokeStyle = mix(this.pal.zone.wall, this.pal.ink, 0.5); ctx.lineWidth = 1;
      for (let b = 0; b < 6; b++) if (used[b] && b % 3 !== 2) ctx.stroke(P[b]);
    }
    ctx.restore();
  }

  _walls(ctx, world, cam, pats) {
    const tracks = this.tracks || [];
    const pal = this.pal, z = cam.zoom, ox = cam.x, oy = cam.y;
    const lw = wallLineWidth(cam, world.grid.cell);
    if (tracks.length) {
      const bb = cam.visibleBBox(lw + 12);
      const block = world.block, hp = world.wallHp, zcomp = world.zoneComp, comps = world.zones.comps;
      const wc = world.cfg.wall, lm = wc.levelHpMul;
      const fullOf = (cp) => wc.hp * (lm[clamp((cp ? cp.wallLevel : 1) - 1, 0, lm.length - 1)] || 1);
      const P = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const used = [0, 0, 0, 0, 0, 0];
      const rub = new Path2D();
      let nRub = 0;
      const cls = this._cls;
      for (let ti = 0; ti < tracks.length; ti++) {
        const tr = tracks[ti];
        if (tr.bb[2] < bb[0] || tr.bb[0] > bb[2] || tr.bb[3] < bb[1] || tr.bb[1] > bb[3]) continue;
        const ns = tr.ns, cells = tr.cells, zoneFull = tr.kind === 0 ? fullOf(comps[tr.comp]) : wc.hp;
        for (let s = 0; s < ns; s++) {
          const c = cells[s];
          let k = W_NONE;
          if (c >= 0) {
            const b = block[c];
            if (b === 3) k = W_GATE;
            else if (b) {
              const h = hp[c], full = b === 2 ? wc.hp : tr.kind === 0 ? zoneFull : fullOf(comps[zcomp[c] - 1]);
              k = h <= 0 ? W_BROKEN : h >= full * 0.6 ? W_OK : h >= full * 0.25 ? W_WORN : W_CRIT;
            }
          }
          cls[s] = k;
        }
        const gaps = tr.gaps;
        if (gaps) {
          // gate cells take the state of the wall beside them; the gate's own stretch is cut out exactly below
          let last = W_OK;
          for (let s = ns - 1; s >= 0; s--) if (cls[s] !== W_GATE) { last = cls[s]; break; }
          for (let s = 0; s < ns; s++) { if (cls[s] === W_GATE) cls[s] = last; else last = cls[s]; }
        }
        const off = tr.kind * 3 - 1;
        let k0 = 0;
        if (tr.closed) {
          k0 = -1;
          for (let s = 0; s < ns; s++) if (cls[s] !== cls[(s + ns - 1) % ns]) { k0 = s; break; }
          if (k0 < 0) {
            const k = cls[0];
            if (k >= W_OK && k <= W_CRIT) {
              if (gaps) cutArc(P[off + k], tr, gaps[0][1], gaps[0][1] + tr.L, cam); else ringPath(P[off + k], tr.pts, cam);
              used[off + k] = 1;
            } else if (k === W_BROKEN) nRub += rubblePath(rub, tr, 0, tr.L, cam, lw, ti);
            continue;
          }
        }
        for (let s = 0; s < ns;) {
          const k = cls[(k0 + s) % ns];
          let e = s + 1;
          while (e < ns && cls[(k0 + e) % ns] === k) e++;
          const a = (k0 + s) * tr.step, b = (k0 + e) * tr.step;
          if (k >= W_OK && k <= W_CRIT) { cutArc(P[off + k], tr, a, b, cam); used[off + k] = 1; }
          else if (k === W_BROKEN) nRub += rubblePath(rub, tr, a, b, cam, lw, ti * 131 + s);
          s = e;
        }
      }
      this._strokeWalls(ctx, P, used, lw, pats);
      if (nRub) {
        ctx.save();
        ctx.strokeStyle = pal.rubble; ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(1, Math.min(2.4, lw * 0.16));
        ctx.stroke(rub);
        ctx.restore();
      }
    }
    const gates = world.zones.gates;
    for (let k = 0; k < gates.length; k++) {
      const gt = gates[k], geo = this.gateGeo[k];
      if (!geo) continue;
      const dead = gt.hp <= 0, hurt = gt.hp < gt.hpMax * 0.5;
      const sx = ((geo.ax + geo.bx) / 2 - ox) * z, sy = ((geo.ay + geo.by) / 2 - oy) * z;
      if (sx < -80 || sy < -80 || sx > cam.w + 80 || sy > cam.h + 80) continue;
      this.drawGate(ctx, cam, geo, dead ? pal.ink3 : hurt ? pal.stamp : (world.owners > 1 && gt.owner > 0 ? pal.carbon : pal.zone.gate), dead);
    }
  }

  // A gate: two posts across the wall line and a straight leaf between them, along the wall at its true angle.
  drawGate(ctx, cam, geo, color, dead = false, alpha = 1) {
    const z = cam.zoom, ox = cam.x, oy = cam.y;
    const ax = (geo.ax - ox) * z, ay = (geo.ay - oy) * z, bx = (geo.bx - ox) * z, by = (geo.by - oy) * z;
    const L = Math.max(wallLineWidth(cam) * 0.5 + 1.5, 6 * z), pw = Math.max(1.2, Math.min(3, z * 1.2));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = color;
    ctx.lineWidth = pw;
    if (dead) ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(ax - geo.nx * L, ay - geo.ny * L); ctx.lineTo(ax + geo.nx * L, ay + geo.ny * L);
    ctx.moveTo(bx - geo.nx * L, by - geo.ny * L); ctx.lineTo(bx + geo.nx * L, by + geo.ny * L);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, pw * 0.6);
    if (dead) ctx.setLineDash([1.5, 2.5]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- tool previews (same line style as built walls)
  drawWallPreview(ctx, cam, cell, lines, kind = 0, alpha = 0.8, color = null) {
    const lw = wallLineWidth(cam, cell);
    const path = new Path2D();
    for (const ln of lines) {
      if (!ln.p || ln.p.length < 4) continue;
      if (ln.closed && ln.p.length >= 6) ringPath(path, ln.p, cam);
      else {
        const z = cam.zoom;
        path.moveTo((ln.p[0] - cam.x) * z, (ln.p[1] - cam.y) * z);
        for (let k = 2; k < ln.p.length; k += 2) path.lineTo((ln.p[k] - cam.x) * z, (ln.p[k + 1] - cam.y) * z);
      }
    }
    if (color) {
      ctx.save();
      ctx.globalAlpha = alpha; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.miterLimit = 3;
      ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke(path);
      ctx.restore();
    } else {
      const P = [path, path, path, path, path, path], used = [0, 0, 0, 0, 0, 0];
      used[kind * 3] = 1;
      this._strokeWalls(ctx, P, used, lw, this._pats, alpha);
    }
    return path;
  }

  // Pieces of polygon p's outline that would become wall: the parts not inside other zones. skipId leaves one zone out.
  zoneOutlinePreview(world, p, skipId = null) {
    const ring = cleanRing(p);
    if (ring.length < 6) return [{ p: ring, closed: false }];
    const [x0, y0, x1, y1] = polyBBox(ring);
    const polys = [ring];
    for (const pl of world.zones.polys) {
      if (pl.id === skipId) continue;
      const b = polyBBox(pl.p);
      if (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) continue;
      polys.push(pl.p);
    }
    if (polys.length === 1) return [{ p: ring, closed: true }];
    return chainSegments(outlineSegments(polys, [0]));
  }

  // Nearest point on a built zone wall line: { x, y, ux, uy, comp, d } or null.
  nearestZoneWall(world, x, y, maxD) {
    if (this.dirty || this._blockKey !== world._blockCells) this._rebuild(world);
    let best = null, bd = maxD * maxD;
    for (const tr of this.tracks || []) {
      if (tr.kind !== 0 || tr.bb[0] - maxD > x || tr.bb[2] + maxD < x || tr.bb[1] - maxD > y || tr.bb[3] + maxD < y) continue;
      const p = tr.pts, n = tr.n;
      for (let k = 0; k < tr.segN; k++) {
        const i = 2 * k, j = 2 * ((k + 1) % n);
        const dx = p[j] - p[i], dy = p[j + 1] - p[i + 1], l2 = dx * dx + dy * dy || 1;
        const t = clamp(((x - p[i]) * dx + (y - p[i + 1]) * dy) / l2, 0, 1);
        const qx = p[i] + dx * t, qy = p[i + 1] + dy * t, d = (qx - x) ** 2 + (qy - y) ** 2;
        if (d < bd) { const l = Math.sqrt(l2); bd = d; best = { x: qx, y: qy, ux: dx / l, uy: dy / l, comp: tr.comp, d: Math.sqrt(d) }; }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- pickups, pits
  _pickups(ctx, world, cam, st) {
    if (!world.pickups || !world.pickups.length) return;
    const pal = this.pal, z = cam.zoom;
    ctx.save();
    ctx.strokeStyle = pal.carbon; ctx.lineWidth = 1.25; ctx.setLineDash([4, 3]); ctx.lineDashOffset = -st.rt * 10;
    for (const p of world.pickups) {
      const sx = (p.x - cam.x) * z, sy = (p.y - cam.y) * z, R = Math.max(6, (p.r || 12) * z);
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  _pits(ctx, world, cam, st) {
    if (!world.pits || !world.pits.length) return;
    const pal = this.pal, z = cam.zoom;
    for (const p of world.pits) {
      const sx = (p.x - cam.x) * z, sy = (p.y - cam.y) * z, R = Math.max(10, p.r * z);
      if (sx + R < -40 || sy + R < -40 || sx - R > cam.w + 40 || sy - R > cam.h + 40) continue;
      const left = Math.max(0, p.endsAt - st.t);
      ctx.save();
      ctx.fillStyle = rgba(pal.fx.pit, 0.07);
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.fill();
      ctx.strokeStyle = pal.fx.pit; ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]); ctx.lineDashOffset = st.rt * 18;
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.lineDashOffset = -st.rt * 24;
      ctx.beginPath(); ctx.arc(sx, sy, R * 0.72, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      const total = Math.max(0.1, p.endsAt - p.t0);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, R + 5, -Math.PI / 2, -Math.PI / 2 + TAU * (left / total)); ctx.stroke();
      ctx.restore();
      tag(ctx, `MOSH PIT ${left.toFixed(0)} s`, sx + R + 8, sy - 8, pal, pal.stamp);
    }
  }

  // ---------------------------------------------------------------- agents
  _agentCols() {
    if (this._acPal === this.pal.name) return this._ac;
    const ag = this.pal.agent;
    this._ac = [ag.civ, ag.civPanic, ag.turning, ag.zombie, ag.police, ag.militia, ag.soldier];
    this._acPal = this.pal.name;
    return this._ac;
  }

  // People and zombies are filled discs sized from a world radius (with a floor when zoomed out), drawn one fill per
  // disc grouped by colour (the browser has a fast path for single circles; one path of thousands of arcs is slow).
  // Very dense views go to the pixel buffer instead. Mutants are few, so each is drawn on its own.
  _agents(ctx, world, cam, st) {
    if (cam.zoom < PIXEL_ZOOM && world.A.n > 3000) { this._agentPixels(ctx, world, cam, st); return; }
    const A = world.A, n = A.n;
    const pal = this.pal, z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h;
    const type = A.type, sub = A.sub, X = A.x, Y = A.y, VX = A.vx, VY = A.vy, state = A.state;
    const ext = st.ext || 0;
    const rc = Math.max(F_CIV, R_CIV * z), rz = Math.max(F_ZOM, R_ZOM * z), ra = Math.max(F_ARM, R_ARM * z);
    if (!this._vx || this._vx.length < n) { const c = Math.max(1024, n * 1.25 | 0); this._vx = new Float32Array(c); this._vy = new Float32Array(c); this._vb = new Uint8Array(c); this._ox = new Float32Array(c); this._oy = new Float32Array(c); }
    const vx = this._vx, vy = this._vy, vb = this._vb, cnt = [0, 0, 0, 0, 0, 0, 0, 0];
    const muts = this._muts || (this._muts = []);
    muts.length = 0;
    let nv = 0, total = 0;
    const m = 8;
    for (let i = 0; i < n; i++) {
      const t = type[i];
      if (!t) continue;
      total++;
      if (t === ZOMBIE && sub[i]) { muts.push(i); continue; }
      const sx = (X[i] + VX[i] * ext - ox) * z, sy = (Y[i] + VY[i] * ext - oy) * z;
      if (sx < -m || sy < -m || sx > W + m || sy > H + m) continue;
      const b = t === CIV ? (state[i] === 1 ? B_PANIC : B_CALM) : t === ZOMBIE ? B_ZOM : t === TURNING ? B_TURN : t === POLICE ? B_POL : t === MILITIA ? B_MIL : B_SOL;
      vx[nv] = sx; vy[nv] = sy; vb[nv] = b; cnt[b + 1]++; nv++;
    }
    if (nv > VEC_MAX && (z < VEC_MAX_ZOOM || 2 * rz * (st.dpr || 1) <= PIX_MAX_D)) { this._agentPixels(ctx, world, cam, st); return; }
    for (let b = 1; b <= NB; b++) cnt[b] += cnt[b - 1];
    const sx = this._ox, sy = this._oy, at = cnt.slice();
    for (let k = 0; k < nv; k++) { const p = at[vb[k]]++; sx[p] = vx[k]; sy[p] = vy[k]; }
    const rad = [rc, rc, rc, rz, ra, ra, ra];
    if (rz >= EDGE_R) {
      const ew = clamp(rz * 0.18, 0.6, 1.1);
      ctx.fillStyle = pal.agent.edge;
      for (let b = 0; b < NB; b++) { const r = rad[b] + ew; for (let k = cnt[b]; k < cnt[b + 1]; k++) { ctx.beginPath(); ctx.arc(sx[k], sy[k], r, 0, TAU); ctx.fill(); } }
    }
    const cols = this._agentCols();
    for (let b = 0; b < NB; b++) {
      if (cnt[b + 1] === cnt[b]) continue;
      const r = rad[b];
      ctx.fillStyle = cols[b];
      for (let k = cnt[b]; k < cnt[b + 1]; k++) { ctx.beginPath(); ctx.arc(sx[k], sy[k], r, 0, TAU); ctx.fill(); }
    }
    if (ra >= 2.6 && cnt[B_POL + 1] > cnt[B_POL]) {
      const dr = ra * 0.38;
      ctx.fillStyle = pal.agent.policeDot;
      for (let k = cnt[B_POL]; k < cnt[B_POL + 1]; k++) { ctx.beginPath(); ctx.arc(sx[k], sy[k], dr, 0, TAU); ctx.fill(); }
    }
    this.stats.agents = total; this.stats.drawn = nv + this._mutants(ctx, world, cam, muts, ext, rz);
  }

  _mutants(ctx, world, cam, list, ext, rz) {
    if (!list.length) return 0;
    const A = world.A, z = cam.zoom, pal = this.pal, kinds = world.cfg.mutation.kinds;
    const rm = Math.max(2.6, rz * 1.6), rg = Math.max(4.5, rz * ((kinds.giant && kinds.giant.size) || 3));
    const shMax = (kinds.shielded && kinds.shielded.shield) || 1;
    let n = 0;
    for (const i of list) {
      const sb = A.sub[i], r = sb === 4 ? rg : rm;
      const sx = (A.x[i] + A.vx[i] * ext - cam.x) * z, sy = (A.y[i] + A.vy[i] * ext - cam.y) * z, m = r * 2 + 6;
      if (sx < -m || sy < -m || sx > cam.w + m || sy > cam.h + m) continue;
      const f = A.hp[i];
      drawMutant(ctx, sb, sx, sy, r, pal, f >= 0.67 ? 2 : f >= 0.34 ? 1 : 0, sb === 2 ? A.shield[i] / shMax : 0);
      n++;
    }
    return n;
  }

  // Zoomed out, every agent is a small disc stamped into a pixel buffer that is uploaded once,
  // because a vector path with tens of thousands of contours is slow to rasterise on the GPU.
  _agentPixels(ctx, world, cam, st) {
    const A = world.A, n = A.n, dpr = st.dpr || 1;
    const type = A.type, sub = A.sub, X = A.x, Y = A.y, VX = A.vx, VY = A.vy, state = A.state;
    const z = cam.zoom, ox = cam.x, oy = cam.y, k = z * dpr, ext = st.ext || 0;
    const PW = Math.max(1, Math.round(cam.w * dpr)), PH = Math.max(1, Math.round(cam.h * dpr));
    let pb = this._pix;
    if (!pb || pb.w !== PW || pb.h !== PH) {
      const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(PW, PH) : Object.assign(document.createElement('canvas'), { width: PW, height: PH });
      const g = cv.getContext('2d');
      const img = g.createImageData(PW, PH);
      pb = this._pix = { w: PW, h: PH, cv, g, img, u32: new Uint32Array(img.data.buffer), box: null };
    }
    const u32 = pb.u32, old = pb.box;
    if (old) for (let y = old[1]; y < old[3]; y++) u32.fill(0, y * PW + old[0], y * PW + old[2]);
    const col = this._pixelColours();
    const rz = Math.max(F_ZOM, R_ZOM * z);
    const dC = Math.max(3, Math.round(2 * Math.max(F_CIV, R_CIV * z) * dpr)), dZ = Math.max(3, Math.round(2 * rz * dpr)), dA = Math.max(3, Math.round(2 * Math.max(F_ARM, R_ARM * z) * dpr));
    const spC = discSpans(dC), spZ = discSpans(dZ), spA = discSpans(dA);
    // close up (crowded views only reach here then), every disc first gets an ink edge, as on the vector path
    const edge = rz >= EDGE_R, ed = edge ? Math.max(2, 2 * Math.round(clamp(rz * 0.18, 0.6, 1.1) * dpr)) : 0;
    const eC = edge ? discSpans(dC + ed) : null, eZ = edge ? discSpans(dZ + ed) : null, eA = edge ? discSpans(dA + ed) : null;
    const ecol = edge ? this._edgePixel() : 0;
    const muts = this._muts || (this._muts = []);
    muts.length = 0;
    let bx0 = PW, by0 = PH, bx1 = 0, by1 = 0, drawn = 0, total = 0;
    for (let pass = edge ? -1 : 0; pass < 2; pass++) {
      const rim = pass < 0;
      for (let i = 0; i < n; i++) {
        const t = type[i];
        if (!t) continue;
        if (!rim && (t === CIV || t === TURNING) === (pass === 1)) continue;
        if (t === ZOMBIE && sub[i]) { if (!rim) { total++; muts.push(i); } continue; }
        if (!rim) total++;
        const px = (X[i] + VX[i] * ext - ox) * k, py = (Y[i] + VY[i] * ext - oy) * k;
        let d, sp, c;
        if (t === CIV) { d = dC; sp = spC; c = col[state[i] === 1 ? B_PANIC : B_CALM]; }
        else if (t === TURNING) { d = dC; sp = spC; c = col[B_TURN]; }
        else if (t === ZOMBIE) { d = dZ; sp = spZ; c = col[B_ZOM]; }
        else { d = dA; sp = spA; c = col[t === POLICE ? B_POL : t === MILITIA ? B_MIL : B_SOL]; }
        if (rim) { sp = d === dC ? eC : d === dZ ? eZ : eA; d += ed; c = ecol; }
        const x0 = Math.round(px - d * 0.5), y0 = Math.round(py - d * 0.5), x1 = x0 + d, y1 = y0 + d;
        if (x1 <= 0 || y1 <= 0 || x0 >= PW || y0 >= PH) continue;
        if (!rim) drawn++;
        if (x0 >= 0 && y0 >= 0 && x1 <= PW && y1 <= PH) {
          if (d === 3) { const r = (y0 + 1) * PW + x0; u32[r - PW + 1] = c; u32[r] = c; u32[r + 1] = c; u32[r + 2] = c; u32[r + PW + 1] = c; }
          else for (let q = 0; q < sp.length; q += 3) {
            const r = (y0 + sp[q]) * PW + x0;
            for (let x = r + sp[q + 1], e = r + sp[q + 2]; x < e; x++) u32[x] = c;
          }
          if (x0 < bx0) bx0 = x0; if (y0 < by0) by0 = y0; if (x1 > bx1) bx1 = x1; if (y1 > by1) by1 = y1;
        } else {
          for (let q = 0; q < sp.length; q += 3) {
            const y = y0 + sp[q];
            if (y < 0 || y >= PH) continue;
            const r = y * PW, xa = Math.max(0, x0 + sp[q + 1]), xb = Math.min(PW, x0 + sp[q + 2]);
            for (let x = xa; x < xb; x++) u32[r + x] = c;
          }
          bx0 = Math.min(bx0, Math.max(0, x0)); by0 = Math.min(by0, Math.max(0, y0));
          bx1 = Math.max(bx1, Math.min(PW, x1)); by1 = Math.max(by1, Math.min(PH, y1));
        }
      }
    }
    const box = drawn ? [bx0, by0, bx1, by1] : null;
    if (box || old) {
      const u = box && old ? [Math.min(box[0], old[0]), Math.min(box[1], old[1]), Math.max(box[2], old[2]), Math.max(box[3], old[3])] : (box || old);
      pb.g.putImageData(pb.img, 0, 0, u[0], u[1], u[2] - u[0], u[3] - u[1]);
    }
    pb.box = box;
    if (box) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pb.cv, bx0, by0, bx1 - bx0, by1 - by0, bx0, by0, bx1 - bx0, by1 - by0);
      ctx.restore();
    }
    drawn += this._mutants(ctx, world, cam, muts, ext, rz);
    this.stats.agents = total; this.stats.drawn = drawn;
  }

  _edgePixel() {
    if (this._edgePalName === this.pal.name) return this._edgePx;
    const m = /rgba?\(([^)]+)\)/.exec(this.pal.agent.edge);
    let r = 0, g = 0, b = 0, a = 255;
    if (m) { const v = m[1].split(',').map(Number); [r, g, b] = v; if (v.length > 3) a = Math.round(v[3] * 255); }
    else [r, g, b] = hexToRgb(this.pal.agent.edge);
    this._edgePx = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    this._edgePalName = this.pal.name;
    return this._edgePx;
  }

  _pixelColours() {
    if (this._pixCol && this._pixColPal === this.pal.name) return this._pixCol;
    this._pixCol = Uint32Array.from(this._agentCols(), (hex) => { const [r, g, b] = hexToRgb(hex); return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; });
    this._pixColPal = this.pal.name;
    return this._pixCol;
  }

  // ---------------------------------------------------------------- units
  unitColor(world, u) {
    const pal = this.pal;
    if (u.alive === false) return pal.ink3;
    if (world.owners > 1 && u.owner > 0) return pal.carbon;
    return u.dry ? pal.ink3 : pal.ink;
  }

  _units(ctx, world, cam, st) {
    const list = world.units;
    if (!list || !list.length) return;
    const pal = this.pal, z = cam.zoom, ox = cam.x, oy = cam.y;
    const s = clamp(4 + z * 2.2, 4.5, 9);
    const bb = cam.visibleBBox(30);
    const stroked = new Path2D();
    let nStroke = 0;
    for (const u of list) {
      if (!u || u.alive === false) continue;
      if (u.veh && u.veh.alive && BOAT_TYPES.has(u.type)) continue;   // drawn with the vehicles
      const col = this.unitColor(world, u);
      const lp = u.p || u.path;
      if (Array.isArray(lp) || ArrayBuffer.isView(lp)) {
        const p = lp;
        if (p.length < 4) continue;
        ctx.save();
        ctx.strokeStyle = u.type === 'oil' ? rgba(pal.ink, 0.55) : col;
        ctx.lineWidth = u.type === 'oil' ? Math.max(3, 4 * z) : Math.max(1.5, 1.2 * z);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (u.type === 'spikes') ctx.setLineDash([Math.max(2, 2 * z), Math.max(2, 1.5 * z)]);
        ctx.beginPath(); ctx.moveTo((p[0] - ox) * z, (p[1] - oy) * z);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo((p[k] - ox) * z, (p[k + 1] - oy) * z);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      if (!lp && u.cells && u.cells.length && world.grid) {
        const g = world.grid, cs = g.cell;
        for (const c of u.cells) {
          const wx = (c % g.gw + 0.5) * cs, wy = (((c / g.gw) | 0) + 0.5) * cs;
          if (wx < bb[0] || wy < bb[1] || wx > bb[2] || wy > bb[3]) continue;
          drawUnitGlyph(ctx, u.type, (wx - ox) * z, (wy - oy) * z, Math.max(2.5, s * 0.5), col, pal.card);
        }
        continue;
      }
      if (!(u.x >= bb[0] && u.y >= bb[1] && u.x <= bb[2] && u.y <= bb[3])) continue;
      const sx = (u.x - ox) * z, sy = (u.y - oy) * z;
      const small = u.type === 'mine' || u.type === 'chemical' || u.type === 'napalm' || u.type === 'waterMine';
      const ss = small ? Math.max(3, s * 0.6) : s;
      const angle = Number.isFinite(u.ax) && Number.isFinite(u.ay) && (u.ax !== u.x || u.ay !== u.y) ? Math.atan2(u.ay - u.y, u.ax - u.x)
        : Number.isFinite(u.angle) ? u.angle : -Math.PI / 4;
      drawUnitGlyph(ctx, u.type, sx, sy, ss, col, pal.card, { angle, level: u.type === 'garrison' ? (u.level || 1) : 0 });
      if (!small && u.type !== 'garrison' && (u.level || 1) > 1) {
        const lv = u.level || 1;
        ctx.fillStyle = col;
        for (let k = 0; k < lv; k++) ctx.fillRect(sx - (lv * 3 - 1) / 2 + k * 3, sy - ss - 5, 2, 3);
      }
      if (u.hpMax > 0 && u.hp < u.hpMax) {
        const f = Math.max(0, u.hp / u.hpMax), w = ss * 2.2, segs = 4;
        for (let k = 0; k < segs; k++) {
          const on = f > k / segs + 1e-6;
          ctx.fillStyle = on ? (f < 0.35 ? pal.stamp : col) : pal.ink3;
          ctx.fillRect(sx - w / 2 + k * (w / segs), sy + ss + 3, w / segs - 1, 2);
        }
      }
      if (u.reloadT > 0 && z > 0.6) {
        stroked.moveTo(sx + ss + 3, sy); stroked.arc(sx, sy, ss + 3, 0, TAU * 0.25); nStroke++;
      }
    }
    if (nStroke) { ctx.strokeStyle = pal.amber; ctx.lineWidth = 1.5; ctx.stroke(stroked); }
  }

  _vehicles(ctx, world, cam, st) {
    const list = world.vehicles;
    if (!list || !list.length) return;
    const pal = this.pal, z = cam.zoom;
    for (const v of list) {
      if (!v || v.alive === false) continue;
      const sx = (v.x - cam.x) * z, sy = (v.y - cam.y) * z;
      if (sx < -60 || sy < -60 || sx > cam.w + 60 || sy > cam.h + 60) continue;
      const col = world.owners > 1 && v.owner > 0 ? pal.carbon : pal.ink;
      const r = v.boat ? drawBoat(ctx, v, sx, sy, z, pal, col, world) : drawVehicleGlyph(ctx, v, sx, sy, z, pal, st.rt, col);
      if (v.hpMax > 0 && v.hp < v.hpMax) {
        const f = Math.max(0, v.hp / v.hpMax), w = Math.max(14, r * 2);
        ctx.fillStyle = pal.ink3; ctx.fillRect(sx - w / 2, sy + r + 4, w, 2);
        ctx.fillStyle = f < 0.35 ? pal.stamp : pal.ink; ctx.fillRect(sx - w / 2, sy + r + 4, w * f, 2);
      }
      if (v.loaded > 0) tag(ctx, `${v.loaded} aboard`, sx + r + 4, sy - r - 10, pal, pal.carbon);
    }
  }

  // ---------------------------------------------------------------- rings + selection
  unitRange(world, u) { return this.combat ? this.combat.unitRange(world, u) : 0; }

  ring(ctx, cam, x, y, r, color, dash = null, width = 1) {
    if (!(r > 0)) return;
    const z = cam.zoom, sx = (x - cam.x) * z, sy = (y - cam.y) * z, R = r * z;
    if (sx + R < 0 || sy + R < 0 || sx - R > cam.w || sy - R > cam.h) return;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  _allRings(ctx, world, cam) {
    const pal = this.pal;
    ctx.save();
    for (const u of world.units) {
      if (!u || u.alive === false || u.p || u.path) continue;
      const r = this.unitRange(world, u);
      if (r > 0) this.ring(ctx, cam, u.x, u.y, r, pal.fx.range, [4, 4], 1);
      const mr = this.combat ? this.combat.minRange(world, u) : 0;
      if (mr > 0) this.ring(ctx, cam, u.x, u.y, mr, rgba(pal.stamp, 0.35), [2, 4], 1);
    }
    ctx.restore();
  }

  _selection(ctx, world, cam, st) {
    const pal = this.pal, z = cam.zoom;
    const draw = (sel, strong) => {
      if (!sel) return;
      const col = pal.select;
      ctx.save();
      if (sel.kind === 'building') {
        const b = world.map.buildings[sel.b];
        if (!b) { ctx.restore(); return; }
        const p = new Path2D(); this._polyPath(p, b.p, cam);
        ctx.strokeStyle = col; ctx.lineWidth = strong ? 2.5 : 1.5; ctx.stroke(p);
      } else if (sel.kind === 'unit') {
        const u = world.units.find((q) => q && q.id === sel.id);
        if (u && u.alive !== false && !u.p && !u.path) {
          const sx = (u.x - cam.x) * z, sy = (u.y - cam.y) * z;
          ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.strokeRect(sx - 11, sy - 11, 22, 22);
          if (strong) {
            this.ring(ctx, cam, u.x, u.y, this.unitRange(world, u), col, null, 1.5);
            const mr = this.combat ? this.combat.minRange(world, u) : 0;
            if (mr > 0) this.ring(ctx, cam, u.x, u.y, mr, pal.stamp, [3, 3], 1);
          }
        } else if (u && (u.p || u.path)) {
          const sx = (u.x - cam.x) * z, sy = (u.y - cam.y) * z;
          ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(sx - 9, sy - 9, 18, 18);
        }
      } else if (sel.kind === 'zone') {
        const e = this.comps.find((q) => q.c.id === sel.comp);
        if (e) {
          const p = this._compPath(e.polys, e.loops, cam);
          ctx.strokeStyle = col; ctx.lineWidth = strong ? 2.5 : 1.5; ctx.setLineDash([8, 4]); ctx.stroke(p);
        }
      } else if (sel.kind === 'bridge') {
        const br = world.bridges[sel.id];
        if (br) this.ring(ctx, cam, br.cx, br.cy, br.len * 0.5 + br.width, col, [6, 4], 2);
      } else if (sel.kind === 'squad') {
        const A = world.A;
        ctx.strokeStyle = col; ctx.lineWidth = 1.25;
        ctx.beginPath();
        let sx0 = 0, sy0 = 0, n = 0;
        for (let i = 0; i < A.n; i++) {
          if (A.type[i] < POLICE || A.group[i] !== sel.group) continue;
          const sx = (A.x[i] - cam.x) * z, sy = (A.y[i] - cam.y) * z;
          ctx.moveTo(sx + 5, sy); ctx.arc(sx, sy, 5, 0, TAU);
          sx0 += A.x[i]; sy0 += A.y[i]; n++;
        }
        ctx.stroke();
        if (n && strong) this.ring(ctx, cam, sx0 / n, sy0 / n, Math.min(world.cfg.armed.pursueLeash || 300, 120), rgba(col, 0.6), [3, 5], 1);
      } else if (sel.kind === 'corridor') {
        const co = world.corridors.find((q) => q.id === sel.id);
        if (co) { const sx = ((co.x0 + co.x1) / 2 - cam.x) * z, sy = ((co.y0 + co.y1) / 2 - cam.y) * z; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(sx - 8, sy - 8, 16, 16); }
      } else if (sel.kind === 'hold') {
        const h = world.holds.find((q) => q.id === sel.id);
        if (h) this.ring(ctx, cam, h.x, h.y, h.R, col, null, 2);
      }
      ctx.restore();
    };
    draw(st.hover && st.hover.kind !== 'building' ? st.hover : null, false);
    draw(st.sel, true);
  }
}
