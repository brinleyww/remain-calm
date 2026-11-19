// Multi-level roads on the map. Every road with heights is split where it leaves the ground (|z| = 0.5) and where its
// tier changes: the ground pieces are drawn with the other roads, tunnels as a dashed casing over the buildings (with a
// portal mark where they go under), and decks on their own sparse layer of transparent tiles drawn above the people on
// the ground, tier by tier, each with a drop shadow, piers and a bridge-style casing. Elevated railways go on that layer
// too. DOM-free apart from the canvases it draws into.
import { clamp } from '../util/geom.js';
import { getPalette, mix } from './palette.js';
import { drawRails } from './raildraw.js';

const TILE = 256;
const TIER_H = 12;                     // metres of height per tier, for the shadow (a little more than real, so it reads)
const SHX = 0.25, SHY = 0.18;          // shadow offset per metre of height (maprender's SHADOW_X / SHADOW_Y)
const PIER_EVERY = 30;
const LEVELS = new WeakMap();
const LAYERS = new WeakMap();

const tierOfZ = (z) => (z >= 0 ? Math.floor(z + 0.5) : -Math.floor(0.5 - z));

// A polyline with heights cut at every tier boundary (z = +-0.5, 1.5, 2.5): [{ tier, p, z, s }], s = arc length from
// the road's start per vertex.
export function splitByTier(p, z) {
  const n = p.length >> 1, out = [];
  if (n < 2) return out;
  const T = [-1.5, -0.5, 0.5, 1.5, 2.5];
  let cur = null, acc = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3], za = z[i], zb = z[i + 1];
    const L = Math.hypot(bx - ax, by - ay), cuts = [0];
    if (za !== zb) for (const t of T) { const f = (t - za) / (zb - za); if (f > 1e-6 && f < 1 - 1e-6) cuts.push(f); }
    cuts.sort((a, b) => a - b);
    cuts.push(1);
    // each stretch between cuts takes the tier of its middle, so a vertex sitting exactly on a boundary still splits
    for (let j = 0; j + 1 < cuts.length; j++) {
      const f0 = cuts[j], f1 = cuts[j + 1], t = tierOfZ(za + (zb - za) * (f0 + f1) / 2);
      if (!cur || cur.tier !== t) {
        if (cur && cur.p.length >= 4) out.push(cur);
        cur = { tier: t, p: [ax + (bx - ax) * f0, ay + (by - ay) * f0], z: [za + (zb - za) * f0], s: [acc + L * f0] };
      }
      cur.p.push(ax + (bx - ax) * f1, ay + (by - ay) * f1); cur.z.push(za + (zb - za) * f1); cur.s.push(acc + L * f1);
    }
    acc += L;
  }
  if (cur && cur.p.length >= 4) out.push(cur);
  return out;
}

function bboxOf(p, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) { if (p[k] < x0) x0 = p[k]; if (p[k] > x1) x1 = p[k]; if (p[k + 1] < y0) y0 = p[k + 1]; if (p[k + 1] > y1) y1 = p[k + 1]; }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

let levelsVersion = 0;
// The editor calls this after every edit of the roads, so the pieces are worked out again.
export function forgetLevels(map) { LEVELS.delete(map); }

// Per map: ground pieces of each road with heights (byRoad), tunnel pieces and deck pieces (incl. elevated rail).
export function roadLevels(map) {
  const R = map.roads || [];
  const c = LEVELS.get(map);
  if (c && c.n === R.length) return c;
  const sig = ++levelsVersion;
  const ground = new Map(), tunnels = [], decks = [];
  for (let r = 0; r < R.length; r++) {
    const rd = R[r];
    if (!rd || !rd.z || !rd.p || rd.p.length < 4 || rd.z.length * 2 !== rd.p.length) continue;
    const rail = rd.k === 'rail', w = rd.w > 0 ? rd.w : rail ? 6 : 8, kind = rail ? 'rail' : rd.k === 'bridge' ? 'major' : rd.k;
    const g = [];
    for (const pc of splitByTier(rd.p, rd.z)) {
      const o = { r, kind, w, tier: pc.tier, p: pc.p, z: pc.z, s: pc.s, bb: bboxOf(pc.p, w / 2 + 10 + Math.max(...pc.z.map(Math.abs)) * TIER_H * SHX) };
      if (pc.tier === 0) g.push(pc.p);
      else if (pc.tier < 0) tunnels.push(o);
      else decks.push(o);
    }
    ground.set(r, g);
  }
  decks.sort((a, b) => a.tier - b.tier || (a.kind === 'rail') - (b.kind === 'rail') || a.w - b.w || a.r - b.r);
  const out = { sig, n: R.length, ground, tunnels, decks, any: ground.size > 0 };
  LEVELS.set(map, out);
  return out;
}

function lineTo(path, p) {
  path.moveTo(p[0], p[1]);
  for (let k = 2; k < p.length; k += 2) path.lineTo(p[k], p[k + 1]);
}

function offset(p, d) {
  const n = p.length / 2, out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    let nx = 0, ny = 0;
    if (i > 0) { const dx = p[2 * i] - p[2 * i - 2], dy = p[2 * i + 1] - p[2 * i - 1], l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l; }
    if (i < n - 1) { const dx = p[2 * i + 2] - p[2 * i], dy = p[2 * i + 3] - p[2 * i + 1], l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l; }
    const l = Math.hypot(nx, ny) || 1, f = i > 0 && i < n - 1 ? Math.min(2.5, 2 / l) : 1;
    out[2 * i] = p[2 * i] + (nx / l) * d * f;
    out[2 * i + 1] = p[2 * i + 1] + (ny / l) * d * f;
  }
  return out;
}

const hit = (bb, x0, y0, x1, y1) => !(bb[0] > x1 || bb[2] < x0 || bb[1] > y1 || bb[3] < y0);

// ---------------------------------------------------------------- tunnels (static tiles, over the buildings)
// cache: maprender's StaticCache (map, style). A dashed double casing, and at each end that comes up to the ground a
// portal mark: a bar across the road with a tick at either side.
export function drawTunnels(ctx, cache, S, ox, oy, qx0, qy0, qx1, qy1) {
  const lv = roadLevels(cache.map);
  if (!lv.tunnels.length) return;
  const pal = cache.style.pal, px = cache.style.px, u = 1 / S;
  ctx.save();
  ctx.setTransform(S, 0, 0, S, -ox, -oy);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const casing = new Path2D(), marks = new Path2D();
  let any = false;
  for (const t of lv.tunnels) {
    if (!hit(t.bb, qx0, qy0, qx1, qy1)) continue;
    any = true;
    const hw = Math.max(t.w * 0.5, 1.6 * px * u);
    lineTo(casing, offset(t.p, hw));
    lineTo(casing, offset(t.p, -hw));
    const n = t.z.length;
    for (const end of [0, 1]) {
      const k = end ? n - 1 : 0, j = end ? n - 2 : 1;
      if (Math.abs(t.z[k]) > 0.55) continue;
      const x = t.p[2 * k], y = t.p[2 * k + 1], dx = x - t.p[2 * j], dy = y - t.p[2 * j + 1], l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l, nx = -uy, ny = ux, e = hw + Math.max(1, 2 * px * u), tk = Math.max(1.5, 3.5 * px * u);
      marks.moveTo(x + nx * e, y + ny * e); marks.lineTo(x - nx * e, y - ny * e);
      for (const sg of [1, -1]) { marks.moveTo(x + nx * e * sg, y + ny * e * sg); marks.lineTo(x + nx * e * sg + ux * tk, y + ny * e * sg + uy * tk); }
    }
  }
  if (any) {
    ctx.strokeStyle = pal.ink3;
    ctx.lineWidth = Math.max(0.9 * px * u, 0.35);
    ctx.setLineDash([4 * px * u, 3 * px * u]);
    ctx.stroke(casing);
    ctx.setLineDash([]);
    ctx.strokeStyle = pal.ink2;
    ctx.lineWidth = Math.max(1.3 * px * u, 0.5);
    ctx.stroke(marks);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- decks (own tile layer)
class DeckLayer {
  constructor(map) {
    this.map = map;
    this.tiles = new Map();
    this.key = '';
    this.bi = null;
    this.frame = 0;
    this.pool = [];
    this.railCache = { map, style: null };
  }
}

function layerOf(map) {
  let L = LAYERS.get(map);
  if (!L) { L = new DeckLayer(map); LAYERS.set(map, L); }
  return L;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Deck structures of road r with their arc-length ranges and state, from the grid (and the world's alive flags).
function structuresOf(grid, world) {
  const m = new Map();
  if (!grid || !grid.bridges) return m;
  grid.bridges.forEach((b, id) => {
    if (!b.deck) return;
    let a = m.get(b.road);
    if (!a) m.set(b.road, a = []);
    a.push({ s0: b.s0, s1: b.s1, alive: !(world && world.bridges && world.bridges[id] && world.bridges[id].alive === false) });
  });
  return m;
}

// Splits a deck piece into runs of standing and fallen deck: [{ p, z, alive }].
function runsOf(pc, structs) {
  const list = structs && structs.get(pc.r);
  if (!list || !list.length || list.every((b) => b.alive)) return [{ p: pc.p, z: pc.z, alive: true }];
  const out = [], n = pc.z.length;
  let cur = null;
  for (let i = 0; i + 1 < n; i++) {
    const sm = (pc.s[i] + pc.s[i + 1]) / 2;
    let alive = true;
    for (const b of list) if (sm >= b.s0 - 3 && sm <= b.s1 + 3) { alive = b.alive; break; }
    if (!cur || cur.alive !== alive) { cur = { p: [pc.p[2 * i], pc.p[2 * i + 1]], z: [pc.z[i]], alive }; out.push(cur); }
    cur.p.push(pc.p[2 * i + 2], pc.p[2 * i + 3]); cur.z.push(pc.z[i + 1]);
  }
  return out;
}

function renderDeckRegion(L, ctx, S, ox, oy, pw, ph, st) {
  const lv = roadLevels(L.map), pal = st.pal, px = st.px, u = 1 / S;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, pw, ph);
  const qx0 = ox / S - 40, qy0 = oy / S - 40, qx1 = (ox + pw) / S + 40, qy1 = (oy + ph) / S + 40;
  ctx.setTransform(S, 0, 0, S, -ox, -oy);
  ctx.lineJoin = 'round';
  let drawn = false;
  for (let tier = 1; tier <= 3; tier++) {
    const list = lv.decks.filter((d) => d.tier === tier && hit(d.bb, qx0, qy0, qx1, qy1));
    if (!list.length) continue;
    drawn = true;
    const runs = [];
    for (const d of list) for (const r of runsOf(d, st.structs)) runs.push({ d, ...r });
    // shadow: one path per width so overlaps are not darker
    ctx.lineCap = 'butt';
    ctx.strokeStyle = st.shadow;
    ctx.globalAlpha = st.shadowA;
    for (const w of [...new Set(runs.map((q) => q.d.w))]) {
      ctx.lineWidth = Math.max(w * S, 2.2 * px) * u;
      const ps = new Path2D();
      for (const { d, p, z, alive } of runs) {
        if (!alive || d.w !== w) continue;
        for (let i = 0; i < p.length; i += 2) {
          const h = z[i >> 1] * TIER_H;
          if (i === 0) ps.moveTo(p[i] + SHX * h, p[i + 1] + SHY * h); else ps.lineTo(p[i] + SHX * h, p[i + 1] + SHY * h);
        }
      }
      ctx.stroke(ps);
    }
    ctx.globalAlpha = 1;
    // piers every 30 m where the deck is well off the ground, in the shadow under it
    if (S * 4 >= 2.2 * px) {
      const pier = new Path2D();
      for (const { d, p, z, alive } of runs) {
        if (!alive) continue;
        let acc = PIER_EVERY / 2;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const L2 = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
          while (acc <= L2) {
            const f = L2 > 0 ? acc / L2 : 0, zz = z[i >> 1] + (z[(i >> 1) + 1] - z[i >> 1]) * f;
            if (zz >= 0.7) {
              const x = p[i] + (p[i + 2] - p[i]) * f, y = p[i + 1] + (p[i + 3] - p[i + 1]) * f, h = zz * TIER_H;
              pier.moveTo(x, y); pier.lineTo(x + SHX * h, y + SHY * h);
            }
            acc += PIER_EVERY;
          }
          acc -= L2;
        }
      }
      ctx.lineCap = 'butt';
      ctx.strokeStyle = st.pier;
      ctx.lineWidth = Math.max(1.2 * px * u, 1.6);
      ctx.stroke(pier);
    }
    // standing deck: casing, surface, edge lines
    for (const run of runs) {
      const { d, p, alive } = run;
      if (!alive || d.kind === 'rail') continue;
      const path = new Path2D();
      lineTo(path, p);
      const dev = Math.max(d.w * S, (d.kind === 'major' ? 2.4 : 1.6) * px), cas = Math.max(0.9 * px, dev * 0.07);
      ctx.lineCap = 'butt';
      ctx.lineWidth = (dev + 2 * cas) * u;
      ctx.strokeStyle = pal.bridgeCasing;
      ctx.stroke(path);
      ctx.lineWidth = dev * u;
      ctx.strokeStyle = d.kind === 'major' ? pal.majorRoad : d.kind === 'path' ? pal.bridge : pal.road;
      ctx.stroke(path);
      if (dev >= 5 * px) {
        const e = new Path2D(), o = dev * u / 2 + Math.max(1.1, 1.8 * px * u);
        lineTo(e, offset(p, o)); lineTo(e, offset(p, -o));
        ctx.lineWidth = 1.05 * px * u;
        ctx.strokeStyle = pal.bridgeEdge;
        ctx.stroke(e);
      }
    }
    // elevated railway: a deck of its own, the track drawn on it by the rail renderer
    const rails = runs.filter((q) => q.d.kind === 'rail' && q.alive);
    if (rails.length) {
      const path = new Path2D();
      for (const q of rails) lineTo(path, q.p);
      const dev = Math.max(6 * S, 3 * px);
      ctx.lineCap = 'butt';
      ctx.lineWidth = (dev + 2 * Math.max(0.9 * px, dev * 0.08)) * u;
      ctx.strokeStyle = pal.bridgeCasing;
      ctx.stroke(path);
      ctx.lineWidth = dev * u;
      ctx.strokeStyle = st.railDeck;
      ctx.stroke(path);
      L.railCache.style = { pal, px };
      const ids = [...new Set(rails.map((q) => q.d.r))];
      drawRails(ctx, L.railCache, ids, S, ox, oy, qx0, qy0, qx1, qy1, 1);
      ctx.setTransform(S, 0, 0, S, -ox, -oy);
    }
    // fallen deck: a broken outline and rubble along it
    for (const { d, p, alive } of runs) {
      if (alive) continue;
      const path = new Path2D();
      lineTo(path, p);
      ctx.lineCap = 'butt';
      ctx.setLineDash([3 * px * u, 2.5 * px * u]);
      ctx.lineWidth = Math.max(d.w * S, 2 * px) * u;
      ctx.strokeStyle = st.ruin;
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }
  if (drawn && st.stage && st.stage.length >= 6) {
    // outside the stage the decks are dimmed like the rest of the sheet
    ctx.globalCompositeOperation = 'source-atop';
    ctx.beginPath();
    ctx.rect(qx0 - 100, qy0 - 100, qx1 - qx0 + 200, qy1 - qy0 + 200);
    const sp = st.stage;
    ctx.moveTo(sp[0], sp[1]);
    for (let k = 2; k < sp.length; k += 2) ctx.lineTo(sp[k], sp[k + 1]);
    ctx.closePath();
    ctx.fillStyle = pal.outsideDim;
    ctx.fill('evenodd');
    ctx.globalCompositeOperation = 'source-over';
  }
  return drawn;
}

// Draws the deck layer for one frame (ctx in CSS px with dpr, or any scale + translate the world layer uses).
// opts: { palette, world, stage (polygon), fade (decks at 40%) }. Returns true when a deck is on screen.
export function drawDecks(ctx, map, grid, cam, opts = {}) {
  const lv = roadLevels(map);
  if (!lv.decks.length) return false;
  const L = layerOf(map), pal = getPalette(opts.palette || map.palette);
  const tr = ctx.getTransform(), dpr = tr.a || 1, px = Math.round(dpr * 100) / 100;
  const world = opts.world || null, structs = structuresOf(grid, world);
  let dead = '';
  for (const [r, a] of structs) a.forEach((b, k) => { if (!b.alive) dead += r + ':' + k + ','; });
  const stage = opts.stage || null;
  const key = `${pal.name}|${px}|${stage ? stage.length + ':' + Math.round(stage[0]) + ',' + Math.round(stage[1]) : '-'}|${dead}|${lv.sig}`;
  if (key !== L.key) { for (const t of L.tiles.values()) if (t.canvas && L.pool.length < 24) L.pool.push(t.canvas); L.tiles.clear(); L.key = key; }
  const z = cam.zoom * dpr;
  let bi = L.bi;
  if (bi === null || z / 2 ** (bi / 2) > 1.03 || z / 2 ** (bi / 2) < 0.686) bi = L.bi = clamp(Math.ceil(2 * Math.log2(z) - 0.06), -40, 14);
  const S = 2 ** (bi / 2), offX = cam.x * z - tr.e, offY = cam.y * z - tr.f;
  const ntx = Math.ceil(map.w * S / TILE), nty = Math.ceil(map.h * S / TILE);
  const wx0 = cam.x, wy0 = cam.y, wx1 = cam.x + cam.w / cam.zoom, wy1 = cam.y + cam.h / cam.zoom;
  const tx0 = clamp(Math.floor(wx0 * S / TILE), 0, ntx - 1), tx1 = clamp(Math.floor(wx1 * S / TILE), 0, ntx - 1);
  const ty0 = clamp(Math.floor(wy0 * S / TILE), 0, nty - 1), ty1 = clamp(Math.floor(wy1 * S / TILE), 0, nty - 1);
  const st = {
    pal, px, structs, stage, shadow: rgbOf(pal.buildingShadow), shadowA: alphaOf(pal.buildingShadow, 0.18) * 1.6,
    pier: mix(pal.ink3, pal.ink2, 0.4), ruin: mix(pal.rubble, pal.paper, 0.2), railDeck: mix(pal.bridge, pal.ink3, 0.22),
  };
  L.frame++;
  let any = false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = opts.fade ? 0.4 : 1;
  ctx.imageSmoothingEnabled = true;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const k = ((bi + 64) * 8192 + ty) * 8192 + tx;
    let t = L.tiles.get(k);
    if (!t) {
      const mx0 = tx * TILE / S, my0 = ty * TILE / S, mx1 = (tx + 1) * TILE / S, my1 = (ty + 1) * TILE / S;
      t = { canvas: null, used: L.frame };
      if (lv.decks.some((d) => hit(d.bb, mx0 - 40, my0 - 40, mx1 + 40, my1 + 40))) {
        t.canvas = L.pool.pop() || makeCanvas(TILE, TILE);
        if (!renderDeckRegion(L, t.canvas.getContext('2d'), S, tx * TILE, ty * TILE, TILE, TILE, st)) { L.pool.push(t.canvas); t.canvas = null; }
      }
      L.tiles.set(k, t);
    }
    t.used = L.frame;
    if (!t.canvas) continue;
    any = true;
    const X0 = Math.round(tx * TILE / S * z - offX), X1 = Math.round((tx + 1) * TILE / S * z - offX);
    const Y0 = Math.round(ty * TILE / S * z - offY), Y1 = Math.round((ty + 1) * TILE / S * z - offY);
    ctx.drawImage(t.canvas, X0, Y0, X1 - X0, Y1 - Y0);
  }
  ctx.restore();
  if (L.tiles.size > 400) {
    const old = [...L.tiles].filter(([, t]) => t.used < L.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of old.slice(0, L.tiles.size - 300)) { if (t.canvas && L.pool.length < 24) L.pool.push(t.canvas); L.tiles.delete(k); }
  }
  return any;
}

function rgbOf(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return c;
  const v = m[1].split(',').map(Number);
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}
function alphaOf(c, d) {
  const m = /rgba\(([^)]+)\)/.exec(c);
  if (!m) return d;
  const v = m[1].split(',').map(Number);
  return v.length > 3 && Number.isFinite(v[3]) ? v[3] : d;
}

// Is (x, y) on a drawn deck of the map? The top tier there, or 0.
export function deckTierAt(map, x, y) {
  const lv = roadLevels(map);
  let best = 0;
  for (const d of lv.decks) {
    if (d.tier <= best || x < d.bb[0] || y < d.bb[1] || x > d.bb[2] || y > d.bb[3]) continue;
    const p = d.p, hw = d.w / 2 + 1;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
      if (Math.hypot(ax + dx * t - x, ay + dy * t - y) <= hw) { best = d.tier; break; }
    }
  }
  return best;
}

