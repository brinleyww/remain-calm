// Real-place import: heights for bridges, tunnels and their ramps (z per vertex in tiers, see map/format.js).
// Bridge ways are joined into chains at shared end nodes; a chain over a road, path or railway becomes a deck, one
// over water only stays a plain water bridge (destructible, boats pass under), and one over nothing stays a road.
// Chain ends ramp down: a link road (or an unbridged way with a layer) meeting a deck end slopes along its whole
// length, otherwise the chain itself ramps down over its last 24 to 40 m.
import { clamp } from '../util/geom.js';

const BRIDGE_NO = new Set(['no', 'false', '0']);
const COVERED = new Set(['building_passage', 'covered', 'no']);

function num(v) {
  if (v == null) return NaN;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(String(v));
  return m ? parseFloat(m[1].replace(',', '.')) : NaN;
}

// Height class of a way from its tags: { z (tier, 0 ground), drop (indoor or a level other than 0), raised, link }.
export function levelTags(t, isRail = false) {
  const layer = num(t.layer), lay = Number.isFinite(layer) ? Math.round(layer) : 0;
  const lv = num(t.level);
  if (!isRail && (t.indoor === 'yes' || t.indoor === 'corridor' || (Number.isFinite(lv) && lv !== 0 && t.level !== undefined))) return { z: 0, drop: true };
  if (!isRail && t.highway === 'service' && t.service === 'parking_aisle' && lay < 0) return { z: 0, drop: true };
  const bridge = !!(t.bridge && !BRIDGE_NO.has(t.bridge));
  const tunnel = !!(t.tunnel && !COVERED.has(t.tunnel)) && t.covered !== 'yes';
  let z = 0;
  if (tunnel) z = clamp(Math.min(-1, lay), -2, -1);
  else if (bridge) z = clamp(Math.max(1, lay), 1, 3);
  else if (isRail && t.railway === 'subway' && !(lay > 0)) z = -1;
  return { z, drop: false, raised: !bridge && !tunnel && lay > 0, link: /_link$/.test(t.highway || '') };
}

// Segment buckets for crossing tests.
class SegGrid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  add(x0, y0, x1, y1, v) {
    const c = this.cell;
    for (let y = Math.floor(y0 / c); y <= Math.floor(y1 / c); y++) for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
      const k = x * 100003 + y;
      let a = this.m.get(k);
      if (!a) this.m.set(k, a = []);
      a.push(v);
    }
  }
  each(x0, y0, x1, y1, fn) {
    const c = this.cell, seen = new Set();
    for (let y = Math.floor(y0 / c); y <= Math.floor(y1 / c); y++) for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
      const a = this.m.get(x * 100003 + y);
      if (a) for (const v of a) if (!seen.has(v)) { seen.add(v); fn(v); }
    }
  }
}

const segLen = (p, i) => Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
function polyLen(p) { let s = 0; for (let i = 0; i + 3 < p.length; i += 2) s += segLen(p, i); return s; }

// roads: [{ p, keys (node key per vertex), k, zt (tag tier), raised, link }] (rail: k 'rail').
// Sets r.z (per vertex, or null) and r.wb (a water bridge: k becomes 'bridge' where it is over water).
export function assignHeights(roads, wetAt) {
  const R = roads.length;
  const ends = new Map();
  const addEnd = (key, ri, e) => { let a = ends.get(key); if (!a) ends.set(key, a = []); a.push([ri, e]); };
  roads.forEach((r, ri) => { r.z = null; r.wb = false; if (r.keys && r.keys.length >= 2) { addEnd(r.keys[0], ri, 0); addEnd(r.keys[r.keys.length - 1], ri, 1); } });
  const grid = new SegGrid(64);
  roads.forEach((r, ri) => {
    const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) grid.add(Math.min(p[i], p[i + 2]), Math.min(p[i + 1], p[i + 3]), Math.max(p[i], p[i + 2]), Math.max(p[i + 1], p[i + 3]), ri * 65536 + (i >> 1));
  });
  // chains: ways with the same non-zero tier joined end to end; members in order, each with its direction
  const chainOf = new Int32Array(R).fill(-1), chains = [];
  for (let s = 0; s < R; s++) {
    const r0 = roads[s];
    if (!r0.zt || chainOf[s] >= 0 || !r0.keys) continue;
    const id = chains.length;
    const mem = [[s, false]];
    chainOf[s] = id;
    const grow = (atHead) => {
      for (;;) {
        const [ri, rev] = atHead ? mem[0] : mem[mem.length - 1];
        const k = roads[ri].keys, key = atHead ? (rev ? k[k.length - 1] : k[0]) : (rev ? k[0] : k[k.length - 1]);
        const list = ends.get(key) || [];
        let next = null;
        for (const [rj, e] of list) {
          if (chainOf[rj] >= 0 || !roads[rj].keys || roads[rj].zt !== r0.zt || (roads[rj].k === 'rail') !== (r0.k === 'rail')) continue;
          next = [rj, e];
          break;
        }
        if (!next) return;
        const [rj, e] = next;
        chainOf[rj] = id;
        if (atHead) mem.unshift([rj, e === 0]); else mem.push([rj, e === 1]);
      }
    };
    grow(false); grow(true);
    const pts = [];
    for (const [ri, rev] of mem) {
      const p = roads[ri].p, n = p.length >> 1;
      for (let q = 0; q < n; q++) { const v = rev ? n - 1 - q : q; if (pts.length && q === 0) continue; pts.push(p[2 * v], p[2 * v + 1]); }
    }
    chains.push({ id, z: r0.zt, mem, pts, L: polyLen(pts), rail: r0.k === 'rail', kind: r0.zt > 0 ? 'deck' : 'tunnel' });
  }
  // what is under a road bridge chain
  for (const ch of chains) {
    if (ch.z <= 0 || ch.rail) continue;
    const p = ch.pts, L = ch.L, inChain = new Set(ch.mem.map(([ri]) => ri));
    let wet = 0, dryInner = 0, acc = 0, cross = false;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const l = segLen(p, i), n = Math.max(1, Math.ceil(l / 3));
      for (let s = 0; s <= n; s++) {
        const d = acc + l * s / n, x = p[i] + (p[i + 2] - p[i]) * s / n, y = p[i + 1] + (p[i + 3] - p[i + 1]) * s / n;
        if (wetAt(x, y)) wet++; else if (d > 15 && d < L - 15) dryInner++;
      }
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      if (!cross) grid.each(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (v) => {
        if (cross) return;
        const rj = Math.floor(v / 65536), k = (v % 65536) * 2;
        if (inChain.has(rj)) return;
        const q = roads[rj].p, cx = q[k], cy = q[k + 1], dx = q[k + 2], dy = q[k + 3];
        const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) return;
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) return;
        const at = acc + l * t;
        if (at > 6 && at < L - 6) cross = true;
      });
      acc += l;
    }
    if (cross) continue;
    if (wet > 0) { for (const [ri] of ch.mem) roads[ri].wb = true; }
    ch.z = 0;
  }
  // per-vertex z of every chain member; ramps at the chain ends
  const zs = new Array(R).fill(null);
  for (const ch of chains) {
    if (!ch.z) continue;
    for (const [ri] of ch.mem) zs[ri] = new Array(roads[ri].p.length >> 1).fill(ch.z);
  }
  const zEndOf = (ri, e) => { const z = zs[ri]; return z ? (e === 0 ? z[0] : z[z.length - 1]) : 0; };
  for (const ch of chains) {
    if (!ch.z) continue;
    for (const atHead of [true, false]) {
      const [ri, rev] = atHead ? ch.mem[0] : ch.mem[ch.mem.length - 1];
      const k = roads[ri].keys, key = atHead ? (rev ? k[k.length - 1] : k[0]) : (rev ? k[0] : k[k.length - 1]);
      const others = (ends.get(key) || []).filter(([rj]) => chainOf[rj] !== ch.id);
      if (!others.length) continue;
      let target = 0, ramp = true;
      for (const [rj, e] of others) {
        const zo = chainOf[rj] >= 0 && chains[chainOf[rj]].z ? zEndOf(rj, e) : 0;
        if (zo !== 0) { if (Math.abs(zo) >= Math.abs(ch.z)) ramp = false; else target = zo; }
      }
      if (!ramp) continue;
      const plain = others.filter(([rj]) => chainOf[rj] < 0 && !(roads[rj].link || roads[rj].raised) && roads[rj].k !== 'rail' === !ch.rail);
      const sloped = others.filter(([rj]) => chainOf[rj] < 0 && (roads[rj].link || roads[rj].raised) && !zs[rj]);
      if (target === 0 && !plain.length && sloped.length && !ch.rail) {
        // the link roads carry the slope from the deck down to the ground
        for (const [rj, e] of sloped) {
          const p = roads[rj].p, n = p.length >> 1, L = polyLen(p) || 1, z = new Array(n);
          let s = 0;
          for (let q = 0; q < n; q++) {
            const v = e === 0 ? q : n - 1 - q;
            if (q > 0) { const w = e === 0 ? v - 1 : v + 1; s += Math.hypot(p[2 * v] - p[2 * w], p[2 * v + 1] - p[2 * w + 1]); }
            z[v] = Math.round(ch.z * (1 - s / L) * 10) / 10;
          }
          zs[rj] = z;
        }
        continue;
      }
      chainRamp(roads, zs, ch, atHead, target);
    }
  }
  roads.forEach((r, ri) => { const z = zs[ri]; r.z = z && z.some((v) => v !== 0) ? z : null; });
}

// The chain slopes from its own tier down to `target` over its last clamp(L / 4, 24, 40) m (half the chain at most),
// with a vertex inserted where the slope starts.
function chainRamp(roads, zs, ch, atHead, target) {
  const d = Math.min(clamp(ch.L * 0.25, 24, 40), ch.L * 0.5);
  if (!(d > 1)) return;
  const order = atHead ? ch.mem : ch.mem.slice().reverse();
  let acc = 0;
  for (const [ri, rev0] of order) {
    const rev = atHead ? rev0 : !rev0, r = roads[ri], p = r.p, n = p.length >> 1, z = zs[ri];
    // walk this member from the end that faces the chain end
    const idx = (q) => (rev ? n - 1 - q : q);
    for (let q = 0; q < n; q++) {
      const v = idx(q);
      if (q > 0) {
        const w = idx(q - 1), l = Math.hypot(p[2 * v] - p[2 * w], p[2 * v + 1] - p[2 * w + 1]);
        if (acc + l > d) {
          // insert the slope start between w and v
          const f = (d - acc) / l, x = p[2 * w] + (p[2 * v] - p[2 * w]) * f, y = p[2 * w + 1] + (p[2 * v + 1] - p[2 * w + 1]) * f;
          const at = rev ? w : v;   // insert before index `at` in storage order
          p.splice(2 * at, 0, x, y);
          z.splice(at, 0, ch.z);
          if (r.keys) r.keys.splice(at, 0, null);
          return;
        }
        acc += l;
      }
      z[v] = Math.round((target + (ch.z - target) * Math.min(1, acc / d)) * 10) / 10;
    }
  }
}

// Douglas-Peucker on a polyline with heights, z counted as z * zScale metres. Returns { p, z }.
export function simplifyZ(p, z, eps, zScale = 30) {
  const n = p.length >> 1;
  if (n <= 2) return { p: p.slice(), z: z.slice() };
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = p[2 * a], ay = p[2 * a + 1], az = z[a] * zScale, dx = p[2 * b] - ax, dy = p[2 * b + 1] - ay, dz = z[b] * zScale - az;
    const L2 = dx * dx + dy * dy + dz * dz;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = p[2 * i] - ax, py = p[2 * i + 1] - ay, pz = z[i] * zScale - az;
      const t = L2 > 1e-12 ? clamp((px * dx + py * dy + pz * dz) / L2, 0, 1) : 0;
      const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t, d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const op = [], oz = [];
  for (let i = 0; i < n; i++) if (keep[i]) { op.push(p[2 * i], p[2 * i + 1]); oz.push(z[i]); }
  return { p: op, z: oz };
}
