// Railways on the static map tiles, called from maprender's road pass. Far out a railway is the classic
// chequered line; closer in it is a ballast bed with sleepers and two running rails, with level crossings,
// rail bridges, station platforms and buffer stops.
import { mix } from './palette.js';
import { railNetFor, sampleAt } from './railnet.js';
import { clamp } from '../util/geom.js';

const NETS = new WeakMap();
const COLS = new Map();
const SCR = { lines: [], cross: [] };
const T = [0, 0, 0, 0];

export function railColours(pal) {
  let c = COLS.get(pal.name);
  if (c) return c;
  c = {
    line: mix(pal.rail, pal.ink, 0.45),
    gap: pal.railGap,
    ballast: mix(pal.paper, pal.ink2, 0.3),
    ballastEdge: mix(pal.rail, pal.ink, 0.25),
    sleeper: mix(pal.ink2, pal.paper, 0.1),
    steel: pal.ink,
    inset: mix(pal.ink, pal.road, 0.45),
    deck: mix(pal.bridge, pal.ink3, 0.22),
    girder: pal.bridgeCasing,
    platform: pal.card,
    platformLine: pal.ink2,
    platformEdge: mix(pal.ink3, pal.card, 0.15),
    barrier: pal.stamp,
    barrierGap: pal.card,
  };
  COLS.set(pal.name, c);
  return c;
}

export function railNetOfCache(cache) {
  let net = NETS.get(cache);
  if (!net) { net = railNetFor(cache.map); NETS.set(cache, net); }
  return net;
}

// Runs of consecutive segments touching the rectangle, as [i0, i1] pairs in out.
function collectRuns(ln, x0, y0, x1, y1, out) {
  out.length = 0;
  const p = ln.p, n = (p.length >> 1) - 1;
  let a = -1;
  for (let i = 0; i < n; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
    const hit = !((ax < bx ? ax : bx) > x1 || (ax > bx ? ax : bx) < x0 || (ay < by ? ay : by) > y1 || (ay > by ? ay : by) < y0);
    if (hit) { if (a < 0) a = i; } else if (a >= 0) { out.push(a, i - 1); a = -1; }
  }
  if (a >= 0) out.push(a, n - 1);
  return out;
}

function traceRun(ctx, p, i0, i1) {
  ctx.moveTo(p[2 * i0], p[2 * i0 + 1]);
  for (let k = i0 + 1; k <= i1 + 1; k++) ctx.lineTo(p[2 * k], p[2 * k + 1]);
}

// The run offset sideways by o (left of the direction of travel), mitred like the road bridges' edges.
function traceOffset(ctx, p, i0, i1, o) {
  const n = p.length >> 1;
  for (let k = i0; k <= i1 + 1; k++) {
    let nx = 0, ny = 0, m = 0;
    if (k > 0) { const dx = p[2 * k] - p[2 * k - 2], dy = p[2 * k + 1] - p[2 * k - 1], l = Math.hypot(dx, dy) || 1; nx -= dy / l; ny += dx / l; m++; }
    if (k < n - 1) { const dx = p[2 * k + 2] - p[2 * k], dy = p[2 * k + 3] - p[2 * k + 1], l = Math.hypot(dx, dy) || 1; nx -= dy / l; ny += dx / l; m++; }
    const l = Math.hypot(nx, ny) || 1, f = m === 2 ? Math.min(2.5, 2 / l) : 1;
    const x = p[2 * k] + (nx / l) * o * f, y = p[2 * k + 1] + (ny / l) * o * f;
    if (k === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
}

// Points of the line between d0 and d1, offset sideways by o.
function subOffset(ln, d0, d1, o) {
  const p = ln.p, cum = ln.cum, n = cum.length, pts = [];
  sampleAt(p, cum, d0, T); pts.push(T[0], T[1], T[2], T[3]);
  for (let k = 1; k < n - 1; k++) {
    if (cum[k] <= d0 + 1e-6 || cum[k] >= d1 - 1e-6) continue;
    const ax = p[2 * k] - p[2 * k - 2], ay = p[2 * k + 1] - p[2 * k - 1], bx = p[2 * k + 2] - p[2 * k], by = p[2 * k + 3] - p[2 * k + 1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    pts.push(p[2 * k], p[2 * k + 1], ax / la + bx / lb, ay / la + by / lb);
  }
  sampleAt(p, cum, d1, T); pts.push(T[0], T[1], T[2], T[3]);
  const out = [];
  for (let k = 0; k < pts.length; k += 4) {
    const tl = Math.hypot(pts[k + 2], pts[k + 3]) || 1, tx = pts[k + 2] / tl, ty = pts[k + 3] / tl;
    const f = k > 0 && k < pts.length - 4 ? Math.min(2.5, 1 / Math.max(0.4, Math.hypot(pts[k + 2], pts[k + 3]) / 2)) : 1;
    out.push(pts[k] - ty * o * f, pts[k + 1] + tx * o * f);
  }
  return out;
}

function tracePts(ctx, q) {
  ctx.moveTo(q[0], q[1]);
  for (let k = 2; k < q.length; k += 2) ctx.lineTo(q[k], q[k + 1]);
}

const boxHit = (x, y, r, x0, y0, x1, y1) => !(x + r < x0 || x - r > x1 || y + r < y0 || y - r > y1);

// list: road indices found for this region (maprender's road query). Transform is set to S here.
// lev: which level stretches to draw (0 on the ground; 1 on viaducts, from the deck layer; tunnels are drawn as tunnels).
export function drawRails(ctx, cache, list, S, ox, oy, qx0, qy0, qx1, qy1, lev = 0) {
  const net = railNetOfCache(cache);
  if (!net.lines.length) return;
  const st = cache.style, pal = st.pal, px = st.px, c = railColours(pal), u = 1 / S;
  const far = S < 1.6 * px, skip = far ? farSkip(net, S, px) : null;
  const lines = SCR.lines;
  lines.length = 0;
  for (let k = 0; k < list.length; k++) {
    const li = net.byRoad[list[k]];
    if (li < 0) continue;
    const all = net.more && net.more.get(list[k]);
    for (const lj of all || [li]) if (net.lines[lj].lev === lev && !(skip && skip[lj])) lines.push(lj);
  }
  lines.sort((a, b) => a - b);
  const runsOf = [];
  for (const li of lines) {
    const ln = net.lines[li], pad = ln.bed + 3;
    const r = collectRuns(ln, qx0 - pad, qy0 - pad, qx1 + pad, qy1 + pad, []);
    if (r.length) runsOf.push(li, r);
  }
  ctx.save();
  ctx.setTransform(S, 0, 0, S, -ox, -oy);
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  if (far) drawFar(ctx, net, runsOf, skip, c, pal, S, px, u, qx0, qy0, qx1, qy1);
  else drawNear(ctx, net, runsOf, c, pal, S, px, u, qx0, qy0, qx1, qy1);
  ctx.restore();
}

// Far out, a track running close beside a wider or longer one is left to that one's symbol, so a double
// track or a station loop reads as one railway instead of a smudge of overlapping dashes.
function farSkip(net, S, px) {
  const cache = net._farSkip || (net._farSkip = new Map());
  let skip = cache.get(S);
  if (skip) return skip;
  const L = net.lines, order = L.map((_, i) => i).sort((a, b) => L[b].w - L[a].w || L[b].L - L[a].L || a - b);
  skip = new Uint8Array(L.length);
  const drawn = new Uint8Array(L.length);
  for (const i of order) {
    const wl = farWidth(L[i], S, px);
    if (L[i].twins.some(t => drawn[t.j] && t.d * S < wl * 1.25)) skip[i] = 1;
    else drawn[i] = 1;
  }
  cache.set(S, skip);
  return skip;
}

const farWidth = (ln, S, px) => clamp(ln.w * S * 0.62, 3.2 * px, 6.5 * px);

function drawFar(ctx, net, runsOf, skip, c, pal, S, px, u, qx0, qy0, qx1, qy1) {
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]];
    if (ln.spans.length) bridgeFar(ctx, ln, farWidth(ln, S, px) * u, pal, px, u, qx0, qy0, qx1, qy1);
  }
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1];
    ctx.beginPath();
    for (let k = 0; k < r.length; k += 2) traceRun(ctx, ln.p, r[k], r[k + 1]);
    ctx.lineWidth = farWidth(ln, S, px) * u;
    ctx.strokeStyle = c.line;
    ctx.stroke();
  }
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1], wl = farWidth(ln, S, px);
    const D = clamp(wl * 1.9, 6 * px, 13 * px) * u;
    ctx.lineWidth = Math.max(0.9 * px, wl - 2 * Math.max(0.9 * px, wl * 0.22)) * u;
    ctx.strokeStyle = c.gap;
    ctx.setLineDash([D, D]);
    for (let k = 0; k < r.length; k += 2) {
      ctx.lineDashOffset = ln.cum[r[k]] % (2 * D);
      ctx.beginPath();
      traceRun(ctx, ln.p, r[k], r[k + 1]);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  let any = false;
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], wl = farWidth(ln, S, px) * u;
    for (const end of [0, 1]) {
      if (!(end ? ln.buf1 : ln.buf0)) continue;
      sampleAt(ln.p, ln.cum, end ? ln.L : 0, T);
      if (!boxHit(T[0], T[1], wl * 2, qx0, qy0, qx1, qy1)) continue;
      const h = wl * 1.1;
      ctx.moveTo(T[0] + T[3] * h, T[1] - T[2] * h); ctx.lineTo(T[0] - T[3] * h, T[1] + T[2] * h);
      any = true;
    }
  }
  if (any) { ctx.lineWidth = 1.6 * px * u; ctx.strokeStyle = c.line; ctx.stroke(); }
  crossings(ctx, net, c, pal, S, px, u, skip, qx0, qy0, qx1, qy1);
}

function bridgeFar(ctx, ln, wl, pal, px, u, qx0, qy0, qx1, qy1) {
  const gap = Math.max(1.4 * px * u, wl * 0.35), tick = Math.max(2.4, 5 * px * u);
  for (const [d0, d1] of ln.spans) {
    sampleAt(ln.p, ln.cum, (d0 + d1) / 2, T);
    if (!boxHit(T[0], T[1], (d1 - d0) / 2 + 20, qx0, qy0, qx1, qy1)) continue;
    const mid = subOffset(ln, d0, d1, 0);
    ctx.beginPath(); tracePts(ctx, mid);
    ctx.lineWidth = wl + 2 * gap;
    ctx.strokeStyle = pal.bridge;
    ctx.stroke();
    ctx.beginPath();
    for (const sg of [-1, 1]) {
      const e = subOffset(ln, d0, d1, sg * (wl / 2 + gap));
      tracePts(ctx, e);
      endTicks(ctx, e, sg, tick);
    }
    ctx.lineWidth = 1.15 * px * u;
    ctx.strokeStyle = pal.bridgeEdge;
    ctx.stroke();
  }
}

// Wing ticks at both ends of a bridge edge, splayed outwards like the road bridges'.
function endTicks(ctx, e, sg, tick) {
  for (const end of [0, 1]) {
    const k = end ? e.length - 2 : 0, k2 = end ? e.length - 4 : 2;
    const tx = e[k] - e[k2], ty = e[k + 1] - e[k2 + 1], tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl * sg * (end ? 1 : -1), ny = tx / tl * sg * (end ? 1 : -1);
    ctx.moveTo(e[k], e[k + 1]);
    ctx.lineTo(e[k] + (tx / tl + nx) * tick * 0.7071, e[k + 1] + (ty / tl + ny) * tick * 0.7071);
  }
}

function drawNear(ctx, net, runsOf, c, pal, S, px, u, qx0, qy0, qx1, qy1) {
  const street = S >= 4 * px;
  const edge = clamp(0.18 * S, 0.8 * px, 1.6 * px) * u;
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1];
    ctx.beginPath();
    for (let k = 0; k < r.length; k += 2) traceRun(ctx, ln.p, r[k], r[k + 1]);
    ctx.lineWidth = ln.bed + 2 * edge;
    ctx.strokeStyle = c.ballastEdge;
    ctx.stroke();
  }
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1];
    ctx.beginPath();
    for (let k = 0; k < r.length; k += 2) traceRun(ctx, ln.p, r[k], r[k + 1]);
    ctx.lineWidth = ln.bed;
    ctx.strokeStyle = c.ballast;
    ctx.stroke();
  }
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]];
    if (ln.spans.length) bridgeNear(ctx, ln, c, pal, S, px, u, street, qx0, qy0, qx1, qy1);
  }
  platforms(ctx, net, c, S, px, u, street, qx0, qy0, qx1, qy1);

  // sleepers: one tick every sp metres from the start of each line, so tiles meet without a seam
  const sp = Math.max(0.65, 4.2 * px * u);
  ctx.beginPath();
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1], p = ln.p, cum = ln.cum, hl = (ln.gauge + 1.1) / 2;
    const x0 = qx0 - hl, y0 = qy0 - hl, x1 = qx1 + hl, y1 = qy1 + hl;
    for (let k = 0; k < r.length; k += 2) {
      for (let i = r[k]; i <= r[k + 1]; i++) {
        const ax = p[2 * i], ay = p[2 * i + 1], L = cum[i + 1] - cum[i];
        if (L <= 0) continue;
        const tx = (p[2 * i + 2] - ax) / L, ty = (p[2 * i + 3] - ay) / L;
        for (let m = Math.ceil(cum[i] / sp), m1 = Math.ceil(cum[i + 1] / sp); m < m1; m++) {
          const f = m * sp - cum[i], x = ax + tx * f, y = ay + ty * f;
          if (x < x0 || x > x1 || y < y0 || y > y1) continue;
          ctx.moveTo(x + ty * hl, y - tx * hl);
          ctx.lineTo(x - ty * hl, y + tx * hl);
        }
      }
    }
  }
  ctx.lineWidth = Math.max(px * u, 0.24);
  ctx.strokeStyle = c.sleeper;
  ctx.stroke();

  ctx.beginPath();
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], r = runsOf[j + 1], g = ln.gauge / 2;
    for (let k = 0; k < r.length; k += 2) { traceOffset(ctx, ln.p, r[k], r[k + 1], g); traceOffset(ctx, ln.p, r[k], r[k + 1], -g); }
  }
  ctx.lineWidth = clamp(0.13 * S, 0.9 * px, 3 * px) * u;
  ctx.strokeStyle = c.steel;
  ctx.stroke();

  ctx.beginPath();
  let any = false;
  for (let j = 0; j < runsOf.length; j += 2) {
    const ln = net.lines[runsOf[j]], hw = ln.gauge / 2 + 0.8;
    for (const end of [0, 1]) {
      if (!(end ? ln.buf1 : ln.buf0)) continue;
      sampleAt(ln.p, ln.cum, end ? ln.L - 0.6 : 0.6, T);
      if (!boxHit(T[0], T[1], 4, qx0, qy0, qx1, qy1)) continue;
      const sg = end ? 1 : -1, tx = T[2] * sg, ty = T[3] * sg;
      ctx.moveTo(T[0] - ty * hw, T[1] + tx * hw); ctx.lineTo(T[0] + ty * hw, T[1] - tx * hw);
      if (street) for (const s of [-1, 1]) { ctx.moveTo(T[0] - ty * hw * 0.8 * s, T[1] + tx * hw * 0.8 * s); ctx.lineTo(T[0] - tx * 1.6 - ty * ln.gauge / 2 * s, T[1] - ty * 1.6 + tx * ln.gauge / 2 * s); }
      any = true;
    }
  }
  if (any) { ctx.lineWidth = clamp(0.5 * S, 1.4 * px, 4 * px) * u; ctx.strokeStyle = c.steel; ctx.stroke(); }
  crossings(ctx, net, c, pal, S, px, u, null, qx0, qy0, qx1, qy1);
}

function bridgeNear(ctx, ln, c, pal, S, px, u, street, qx0, qy0, qx1, qy1) {
  const half = ln.bed / 2 + 0.7, gw = clamp(0.55 * S, 1.3 * px, 4 * px) * u, tick = Math.max(2.5, 4 * px * u);
  for (const [d0, d1] of ln.spans) {
    sampleAt(ln.p, ln.cum, (d0 + d1) / 2, T);
    if (!boxHit(T[0], T[1], (d1 - d0) / 2 + 20, qx0, qy0, qx1, qy1)) continue;
    const mid = subOffset(ln, d0, d1, 0);
    ctx.beginPath(); tracePts(ctx, mid);
    ctx.lineWidth = 2 * half;
    ctx.strokeStyle = c.deck;
    ctx.stroke();
    ctx.beginPath();
    for (const sg of [-1, 1]) {
      const e = subOffset(ln, d0, d1, sg * half);
      tracePts(ctx, e);
      endTicks(ctx, e, sg, tick);
    }
    ctx.lineWidth = gw;
    ctx.strokeStyle = c.girder;
    ctx.stroke();
    if (!street) continue;
    // truss posts along both girders
    ctx.beginPath();
    const step = 4;
    for (let d = d0 + step / 2; d < d1; d += step) {
      sampleAt(ln.p, ln.cum, d, T);
      for (const sg of [-1, 1]) {
        const x = T[0] - T[3] * half * sg, y = T[1] + T[2] * half * sg;
        ctx.moveTo(x, y); ctx.lineTo(x - T[3] * 0.9 * sg + T[2] * 0.9, y + T[2] * 0.9 * sg + T[3] * 0.9);
      }
    }
    ctx.lineWidth = Math.max(0.8 * px * u, gw * 0.5);
    ctx.stroke();
  }
}

function platforms(ctx, net, c, S, px, u, street, qx0, qy0, qx1, qy1) {
  const P = net.platforms;
  if (!P.length) return;
  const edge = clamp(0.2 * S, 0.8 * px, 1.4 * px) * u;
  for (const pf of P) {
    const half = (pf.d1 - pf.d0) / 2 + 10;
    if (!boxHit(pf.x, pf.y, half, qx0, qy0, qx1, qy1)) continue;
    const ln = net.lines[pf.line], w = pf.o1 - pf.o0, mid = subOffset(ln, pf.d0, pf.d1, pf.side * (pf.o0 + pf.o1) / 2);
    ctx.beginPath(); tracePts(ctx, mid);
    ctx.lineWidth = w + 2 * edge;
    ctx.strokeStyle = c.platformLine;
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = c.platform;
    ctx.stroke();
    if (!street) continue;
    const lip = subOffset(ln, pf.d0 + 1.5, pf.d1 - 1.5, pf.side * (pf.o0 + 0.6));
    ctx.beginPath(); tracePts(ctx, lip);
    ctx.lineWidth = Math.max(0.8 * px * u, 0.22);
    ctx.strokeStyle = c.platformEdge;
    ctx.setLineDash([1.4, 0.9]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// The road is drawn again across the track (casings of every crossing first, so crossings at a road junction
// merge like the roads do); close in, the rails show set into the road and striped barrier arms stand either side.
function crossings(ctx, net, c, pal, S, px, u, skip, qx0, qy0, qx1, qy1) {
  const X = net.crossings;
  if (!X.length) return;
  const far = !!skip, street = S >= 4 * px;
  const vis = SCR.cross || (SCR.cross = []);
  vis.length = 0;
  for (let i = 0; i < X.length; i++) {
    const x = X[i];
    if ((skip && skip[x.line]) || !boxHit(x.x, x.y, x.w / x.sin + 8, qx0, qy0, qx1, qy1)) continue;
    vis.push(i);
  }
  if (!vis.length) return;
  const dims = (x) => {
    const ln = net.lines[x.line], major = x.k === 'major';
    const dev = Math.max(x.w * S, (major ? 2.4 : 1.5) * px) * u;
    const cas = (major ? clamp(x.w * S * 0.09, 1.0 * px, 2.4 * px) : clamp(x.w * S * 0.07, 0.75 * px, 1.6 * px)) * u;
    const railHalf = (far ? farWidth(ln, S, px) * u : ln.bed + 0.6) / 2;
    const cos = Math.sqrt(Math.max(0, 1 - x.sin * x.sin));
    T[0] = dev; T[1] = cas; T[2] = railHalf / x.sin + (dev / 2 + cas) * cos / x.sin + 0.6 * u; T[3] = cos;
    return T;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const i of vis) {
      const x = X[i], major = x.k === 'major', [dev, cas, h] = dims(x);
      ctx.beginPath();
      ctx.moveTo(x.x - x.ux * h, x.y - x.uy * h);
      ctx.lineTo(x.x + x.ux * h, x.y + x.uy * h);
      ctx.lineWidth = pass ? dev : dev + 2 * cas;
      ctx.strokeStyle = pass ? (major ? pal.majorRoad : pal.road) : (major ? pal.majorCasing : pal.roadCasing);
      ctx.stroke();
    }
  }
  if (far) return;
  ctx.beginPath();
  for (const i of vis) {
    const x = X[i], ln = net.lines[x.line], dev = dims(x)[0];
    // each rail from kerb to kerb
    const rnx = -x.ty, rny = x.tx, unx = -x.uy, uny = x.ux;
    const along = x.tx * unx + x.ty * uny, side = rnx * unx + rny * uny;
    if (Math.abs(along) < 1e-3) continue;
    for (const o of [-ln.gauge / 2, ln.gauge / 2]) {
      const t0 = (-dev / 2 - o * side) / along, t1 = (dev / 2 - o * side) / along;
      ctx.moveTo(x.x + rnx * o + x.tx * t0, x.y + rny * o + x.ty * t0);
      ctx.lineTo(x.x + rnx * o + x.tx * t1, x.y + rny * o + x.ty * t1);
    }
  }
  ctx.lineWidth = clamp(0.11 * S, 0.8 * px, 2.4 * px) * u;
  ctx.strokeStyle = c.inset;
  ctx.stroke();
  if (!street) return;
  ctx.beginPath();
  for (const i of vis) {
    const x = X[i], ln = net.lines[x.line], d = dims(x), kerb = d[0] / 2, cos = d[3];
    const unx = -x.uy, uny = x.ux, reach = Math.max(0, kerb - 0.5), a = (ln.bed / 2 + 1.4 + reach * cos) / x.sin;
    for (const sg of [-1, 1]) {
      if (!(sg > 0 ? x.bar1 : x.bar0)) continue;
      const bx = x.x + x.ux * a * sg, by = x.y + x.uy * a * sg;
      ctx.moveTo(bx - unx * reach, by - uny * reach);
      ctx.lineTo(bx + unx * reach, by + uny * reach);
    }
  }
  const bw = clamp(0.45 * S, 1.2 * px, 3 * px) * u, dash = Math.max(0.7, 3 * px * u);
  ctx.lineWidth = bw + 1.2 * px * u;
  ctx.strokeStyle = pal.ink2;
  ctx.stroke();
  ctx.lineWidth = bw;
  ctx.strokeStyle = c.barrierGap;
  ctx.stroke();
  ctx.setLineDash([dash, dash]);
  ctx.strokeStyle = c.barrier;
  ctx.stroke();
  ctx.setLineDash([]);
}
