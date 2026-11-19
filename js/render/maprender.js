// Static paper-map renderer. The city is rasterised into cached device-pixel tiles per zoom bucket
// (factor sqrt 2), so panning only blits tiles; vectors are redrawn on bucket changes and for
// invalidated rectangles (collapses, bridges). Overlays (stage dimming, hover, frame) are per frame.

import { polyCentroid, polySignedArea, pointInPoly, distToPolyline, clamp } from '../util/geom.js';
import { hash2, mulberry32 } from '../util/rng.js';
import { T, ROAD_WIDTH, clipPolyRect } from '../map/format.js';
import { getPalette, heightClass, mix, SPECIAL_CODES, FONT_MONO, FONT_LABEL, BUILDING_KIND_ORDER } from './palette.js';
import { drawRails } from './raildraw.js';

const TILE = 256;
const IDX = 128;
const OVERVIEW_MAX = 2048;
const OV_CHUNK = 256;
const CHUNK = 200;
export const SHADOW_X = 0.25, SHADOW_Y = 0.18;          // shadow offset per metre of height (light from the north-west)
// Shadow length grows linearly up to 24 m of height, then at 40% so towers don't blanket whole blocks.
export const shadowHeight = h => (h <= 24 ? h : 24 + (h - 24) * 0.4);
const TAU = Math.PI * 2;
const KIND = Object.fromEntries(BUILDING_KIND_ORDER.map((k, i) => [k, i]));
const K_SPECIAL_LO = KIND.civic, K_SPECIAL_HI = KIND.hazard;
const RK = { path: 0, minor: 1, major: 2, rail: 3, bridge: 4 };
const ROAD_W = ['path', 'minor', 'major', 'rail', 'bridge'].map(k => ROAD_WIDTH[k]);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const mod = (a, n) => ((a % n) + n) % n;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function polyTo(path, p, dx = 0, dy = 0, reverse = false) {
  const n = p.length;
  if (n < 6) return;
  if (!reverse) {
    path.moveTo(p[0] + dx, p[1] + dy);
    for (let k = 2; k < n; k += 2) path.lineTo(p[k] + dx, p[k + 1] + dy);
  } else {
    path.moveTo(p[n - 2] + dx, p[n - 1] + dy);
    for (let k = n - 4; k >= 0; k -= 2) path.lineTo(p[k] + dx, p[k + 1] + dy);
  }
  path.closePath();
}

// Outline of a ring whose holes were folded in with zero-width cuts: the ring without the cut segments
// (each cut is walked once in each direction), as open polylines. Returns null when there is no cut.
function cutOutline(p) {
  const n = p.length, v = n >> 1;
  if (v < 8) return null;
  const seen = new Map();
  let dup = false;
  for (let k = 0; k < n; k += 2) {
    const key = p[k] + ',' + p[k + 1];
    if (seen.has(key)) { dup = true; break; }
    seen.set(key, 1);
  }
  if (!dup) return null;
  const segs = new Set();
  for (let k = 0; k < n; k += 2) { const j = (k + 2) % n; segs.add(p[k] + ',' + p[k + 1] + '>' + p[j] + ',' + p[j + 1]); }
  const cut = new Uint8Array(v);
  let any = false;
  for (let k = 0; k < n; k += 2) {
    const j = (k + 2) % n;
    if (segs.has(p[j] + ',' + p[j + 1] + '>' + p[k] + ',' + p[k + 1])) { cut[k >> 1] = 1; any = true; }
  }
  if (!any) return null;
  let start = 0;
  while (start < v && cut[start]) start++;
  if (start === v) return [];
  const lines = [];
  let cur = null;
  for (let q = 0; q < v; q++) {
    const s = (start + q) % v, k = s * 2, j = ((s + 1) % v) * 2;
    if (cut[s]) { cur = null; continue; }
    if (!cur) { cur = [p[k], p[k + 1]]; lines.push(cur); }
    cur.push(p[j], p[j + 1]);
  }
  return lines;
}

function lineTo(path, p) {
  path.moveTo(p[0], p[1]);
  for (let k = 2; k < p.length; k += 2) path.lineTo(p[k], p[k + 1]);
}

function polylineLength(p) {
  let L = 0;
  for (let k = 2; k < p.length; k += 2) L += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  return L;
}

function subPolyline(p, d0, d1) {
  const out = [];
  let acc = 0;
  for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2], ay = p[k - 1], bx = p[k], by = p[k + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L <= 0) continue;
    const s0 = clamp((d0 - acc) / L, 0, 1), s1 = clamp((d1 - acc) / L, 0, 1);
    if (s1 > s0) {
      const x0 = ax + (bx - ax) * s0, y0 = ay + (by - ay) * s0;
      if (!out.length) out.push(x0, y0);
      out.push(ax + (bx - ax) * s1, ay + (by - ay) * s1);
    }
    acc += L;
  }
  return out;
}

function offsetPolyline(p, d) {
  const n = p.length / 2, out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    let nx = 0, ny = 0;
    if (i > 0) { const dx = p[2 * i] - p[2 * i - 2], dy = p[2 * i + 1] - p[2 * i - 1], l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l; }
    if (i < n - 1) { const dx = p[2 * i + 2] - p[2 * i], dy = p[2 * i + 3] - p[2 * i + 1], l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l; }
    const l = Math.hypot(nx, ny) || 1;
    const f = i > 0 && i < n - 1 ? Math.min(2.5, 2 / l) : 1;
    out[2 * i] = p[2 * i] + (nx / l) * d * f;
    out[2 * i + 1] = p[2 * i + 1] + (ny / l) * d * f;
  }
  return out;
}

function colLabel(i) {
  let s = '';
  i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function niceStep(v) {
  const steps = [25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  for (const s of steps) if (s >= v) return s;
  return 10000;
}

function parseRgba(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return [0, 0, 0, 160];
  const v = m[1].split(',').map(Number);
  return [v[0], v[1], v[2], Math.round((v[3] ?? 1) * 255)];
}

// ---------------- patterns (per palette and device scale) ----------------

const PATTERNS = new Map();

function patternSet(pal, px) {
  const key = pal.name + '@' + px;
  let s = PATTERNS.get(key);
  if (s) return s;
  const mk = (w, h, draw) => {
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    draw(g, w, h);
    return { pat: g.createPattern(c, 'repeat'), w, h };
  };
  const grain = mk(256, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    const r = mulberry32(0x5eed + pal.name.length * 977);
    const [dr, dg, db] = pal.grainDark, [lr, lg, lb] = pal.grainLight;
    const amt = pal.grainAmt;
    for (let i = 0; i < w * h; i++) {
      const v = r();
      const o = i * 4;
      if (v < 0.2) { img.data[o] = dr; img.data[o + 1] = dg; img.data[o + 2] = db; img.data[o + 3] = (6 + r() * 16) * amt; }
      else if (v > 0.93) { img.data[o] = lr; img.data[o + 1] = lg; img.data[o + 2] = lb; img.data[o + 3] = (8 + r() * 14) * amt; }
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = `rgba(${dr},${dg},${db},${0.05 * amt})`;
    g.lineWidth = 0.7;
    for (let f = 0; f < 46; f++) {
      const x = r() * w, y = r() * h, a = r() * TAU, L = 5 + r() * 16, bend = (r() - 0.5) * 8;
      const ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L;
      for (let ox = -w; ox <= w; ox += w) for (let oy = -h; oy <= h; oy += h) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.quadraticCurveTo((x + ex) / 2 + ox + bend, (y + ey) / 2 + oy - bend, ex + ox, ey + oy);
        g.stroke();
      }
    }
  });
  const ws = Math.max(4, Math.round(5 * px));
  const water = mk(8, ws, (g, w) => {
    g.fillStyle = pal.waterHatch;
    g.globalAlpha = 0.55;
    g.fillRect(0, 0, w, Math.max(1, Math.round(px * 0.8)));
  });
  const pk = Math.round(22 * px);
  const park = mk(pk, pk, (g, w, h) => {
    g.strokeStyle = pal.parkMark;
    g.lineWidth = Math.max(0.8, 0.85 * px);
    g.lineCap = 'butt';
    const tuft = (x, y) => {
      const u = px;
      g.beginPath();
      g.moveTo(x - 2.2 * u, y); g.lineTo(x - 1.4 * u, y - 2.6 * u);
      g.moveTo(x, y); g.lineTo(x, y - 3.4 * u);
      g.moveTo(x + 2.2 * u, y); g.lineTo(x + 1.4 * u, y - 2.6 * u);
      g.stroke();
    };
    tuft(w * 0.27, h * 0.36);
    tuft(w * 0.77, h * 0.86);
  });
  const hs = Math.max(5, Math.round(7 * px));
  const hatch = mk(hs, hs, (g, w) => {
    g.strokeStyle = pal.outsideHatch;
    g.lineWidth = Math.max(1, 0.9 * px);
    g.beginPath();
    for (let o = -w; o <= w; o += w) { g.moveTo(o, w); g.lineTo(o + w, 0); }
    g.stroke();
  });
  s = { grain, water, park, hatch };
  PATTERNS.set(key, s);
  return s;
}

function usePattern(ctx, P, dx, dy) {
  if (P.pat.setTransform) P.pat.setTransform(new DOMMatrix([1, 0, 0, 1, mod(dx, P.w), mod(dy, P.h)]));
  ctx.fillStyle = P.pat;
}

// ---------------- cache ----------------

const CACHES = new WeakMap();

class StaticCache {
  constructor(map, grid = null) {
    this.map = map;
    this.grid = null;
    this.world = null;
    this.tiles = new Map();
    this.pool = [];
    this.version = 0;
    this.style = null;
    this.bi = null;
    this.prevBi = null;
    this.overviews = new Map();
    this.minimap = null;
    this.maxTiles = 96;
    this.budgetMs = 6;
    this.frame = 0;
    this.stats = { rendered: 0, pending: 0, ms: 0, tiles: 0 };
    this._q = 1;
    this._index();
    this.setGrid(grid);
    this._watchFonts();
  }

  _index() {
    const m = this.map;
    this.iw = Math.max(1, Math.ceil(m.w / IDX));
    this.ih = Math.max(1, Math.ceil(m.h / IDX));
    const B = m.buildings || [], n = B.length;
    this.nb = n;
    const bb = (this.bb = new Float32Array(n * 4));
    const bh = (this.bh = new Float32Array(n));
    const bk = (this.bk = new Uint8Array(n));
    const lx = (this.lx = new Float32Array(n)), ly = (this.ly = new Float32Array(n));
    const pos = (this.bpos = new Uint8Array(n));
    const cuts = (this.bCut = new Map());
    let maxH = 0;
    const specials = [];
    for (let i = 0; i < n; i++) {
      const b = B[i], p = b.p;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) {
        const x = p[k], y = p[k + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      bb[i * 4] = x0; bb[i * 4 + 1] = y0; bb[i * 4 + 2] = x1; bb[i * 4 + 3] = y1;
      const h = b.h > 0 ? b.h : 6;
      bh[i] = h;
      if (shadowHeight(h) > maxH) maxH = shadowHeight(h);
      const k = KIND[b.k] ?? 0;
      bk[i] = k;
      const c = p.length >= 6 ? polyCentroid(p) : [x0, y0];
      lx[i] = c[0]; ly[i] = c[1];
      pos[i] = polySignedArea(p) > 0 ? 1 : 0;
      const co = cutOutline(p);
      if (co) cuts.set(i, co);
      if (k >= K_SPECIAL_LO && k <= K_SPECIAL_HI) specials.push(i);
    }
    this.specials = Int32Array.from(specials);
    this.maxShX = maxH * SHADOW_X;
    this.maxShY = maxH * SHADOW_Y;
    this.bStamp = new Uint32Array(n);
    this.bIdx = this._csr(n, (i, cb) => this._cellsOfRect(bb[i * 4], bb[i * 4 + 1], bb[i * 4 + 2], bb[i * 4 + 3], cb));

    const R = m.roads || [], nr = R.length;
    this.nr = nr;
    const rk = (this.rk = new Uint8Array(nr)), rw = (this.rw = new Float32Array(nr));
    const bridges = [];
    for (let r = 0; r < nr; r++) {
      const k = RK[R[r].k] ?? 1;
      rk[r] = k;
      rw[r] = R[r].w > 0 ? R[r].w : ROAD_W[k];
      if (k === RK.bridge) bridges.push(r);
    }
    const order = Array.from({ length: nr }, (_, i) => i).sort((a, b) => rk[a] - rk[b] || rw[a] - rw[b] || a - b);
    this.rRank = new Int32Array(nr);
    order.forEach((r, i) => { this.rRank[r] = i; });
    this.rStamp = new Uint32Array(nr);
    this.rIdx = this._csr(nr, (r, cb) => {
      const p = R[r].p, hw = rw[r] / 2 + 2;
      if (p.length === 2) { this._cellsOfRect(p[0] - hw, p[1] - hw, p[0] + hw, p[1] + hw, cb); return; }
      for (let k = 2; k < p.length; k += 2) {
        this._cellsOfRect(Math.min(p[k - 2], p[k]) - hw, Math.min(p[k - 1], p[k + 1]) - hw, Math.max(p[k - 2], p[k]) + hw, Math.max(p[k - 1], p[k + 1]) + hw, cb);
      }
    });
    this.bridgeRoads = Int32Array.from(bridges);
    this.brLen = Float32Array.from(bridges.map(r => polylineLength(R[r].p)));
    this.brBox = new Float32Array(bridges.length * 4);
    bridges.forEach((r, j) => {
      const p = R[r].p, hw = rw[r] / 2 + 6;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]); }
      this.brBox.set([x0 - hw, y0 - hw, x1 + hw, y1 + hw], j * 4);
    });

    const boxes = list => {
      const out = new Float32Array(list.length * 4);
      list.forEach((o, i) => {
        const p = o.p;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < p.length; k += 2) { x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1]); }
        out[i * 4] = x0; out[i * 4 + 1] = y0; out[i * 4 + 2] = x1; out[i * 4 + 3] = y1;
      });
      return out;
    };
    this.waterBox = boxes(m.water || []);
    this.parkBox = boxes(m.parks || []);
    this.gridStep = niceStep(Math.max(m.w, m.h) / 9);
    this.bAlive = new Uint8Array(n).fill(1);
    this.brAlive = new Uint8Array(bridges.length).fill(1);
    this.brId = new Int32Array(bridges.length).fill(-1);
  }

  _cellsOfRect(x0, y0, x1, y1, cb) {
    const a = clamp(Math.floor(x0 / IDX), 0, this.iw - 1), b = clamp(Math.floor(x1 / IDX), 0, this.iw - 1);
    const c = clamp(Math.floor(y0 / IDX), 0, this.ih - 1), d = clamp(Math.floor(y1 / IDX), 0, this.ih - 1);
    for (let cy = c; cy <= d; cy++) for (let cx = a; cx <= b; cx++) cb(cy * this.iw + cx);
  }

  _csr(n, visit) {
    const nc = this.iw * this.ih;
    const start = new Int32Array(nc + 1);
    const last = new Int32Array(nc).fill(-1);
    let cur = 0;
    const count = c => { if (last[c] !== cur) { last[c] = cur; start[c + 1]++; } };
    for (cur = 0; cur < n; cur++) visit(cur, count);
    for (let c = 0; c < nc; c++) start[c + 1] += start[c];
    const items = new Int32Array(start[nc]);
    const fill = start.slice(0, nc);
    last.fill(-1);
    const put = c => { if (last[c] !== cur) { last[c] = cur; items[fill[c]++] = cur; } };
    for (cur = 0; cur < n; cur++) visit(cur, put);
    return { start, items };
  }

  _query(idx, stamp, x0, y0, x1, y1, out) {
    out.length = 0;
    const q = ++this._q;
    const { start, items } = idx;
    this._cellsOfRect(x0, y0, x1, y1, c => {
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const i = items[k];
        if (stamp[i] !== q) { stamp[i] = q; out.push(i); }
      }
    });
    return out;
  }

  setGrid(grid) {
    this.grid = grid || null;
    const g = this.grid;
    this.brId.fill(-1);
    const gb = (g && g.bridges) || [];
    this.gbAlive = new Uint8Array(gb.length).fill(1);
    this.gbMapped = new Uint8Array(gb.length);
    this.gbBox = new Float32Array(gb.length * 4);
    gb.forEach((b, id) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of b.cells) { const X = c % g.gw, Y = (c / g.gw) | 0; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
      this.gbBox.set([x0 * g.cell, y0 * g.cell, (x1 + 1) * g.cell, (y1 + 1) * g.cell], id * 4);
    });
    if (g && g.bridgeId) {
      const R = this.map.roads;
      this.bridgeRoads.forEach((r, j) => {
        const p = R[r].p, tally = new Map();
        const sample = (x, y) => {
          const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
          if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) return;
          const id = g.bridgeId[cy * g.gw + cx];
          if (id > 0) tally.set(id, (tally.get(id) || 0) + 1);
        };
        for (let k = 0; k < p.length; k += 2) {
          sample(p[k], p[k + 1]);
          if (k + 3 < p.length) for (let s = 1; s < 4; s++) sample(p[k] + (p[k + 2] - p[k]) * s / 4, p[k + 1] + (p[k + 3] - p[k + 1]) * s / 4);
        }
        let best = 0, bc = 0;
        for (const [id, c] of tally) if (c > bc) { bc = c; best = id; }
        this.brId[j] = best - 1;
        if (best > 0) this.gbMapped[best - 1] = 1;
      });
    }
    this.invalidate();
  }

  setWorld(world) {
    this.world = world || null;
    this.invalidate();
  }

  _bDead(i) {
    const w = this.world;
    if (w && w.buildings && w.buildings[i]) return w.buildings[i].alive === false;
    const g = this.grid, info = g && g.bInfo && g.bInfo[i];
    if (!info || !info.cells || !info.cells.length) return false;
    const t = g.terrain, cells = info.cells;
    let c = 0;
    for (let k = 0; k < cells.length; k++) if (t[cells[k]] === T.BLDG) c++;
    return c * 2 < cells.length;
  }

  _brDead(j) {
    const id = this.brId[j];
    if (id < 0) return false;
    const w = this.world;
    if (w && w.bridges && w.bridges[id]) return w.bridges[id].alive === false;
    const g = this.grid, br = g && g.bridges && g.bridges[id];
    if (!br || !br.cells || !br.cells.length) return false;
    let c = 0;
    for (let k = 0; k < br.cells.length; k++) if (g.terrain[br.cells[k]] === T.BRIDGE) c++;
    return c * 2 < br.cells.length;
  }

  _gbDead(id) {
    const w = this.world;
    if (w && w.bridges && w.bridges[id]) return w.bridges[id].alive === false;
    const g = this.grid, cells = g.bridges[id].cells;
    let c = 0;
    for (let k = 0; k < cells.length; k++) if (g.terrain[cells[k]] === T.BRIDGE) c++;
    return c * 2 < cells.length;
  }

  _refreshAlive(rect) {
    if (!this.grid && !this.world) { this.bAlive.fill(1); this.brAlive.fill(1); return; }
    if (this.grid) {
      const gx = this.gbBox;
      for (let id = 0; id < this.gbAlive.length; id++) {
        if (rect && (gx[id * 4] > rect[2] || gx[id * 4 + 2] < rect[0] || gx[id * 4 + 1] > rect[3] || gx[id * 4 + 3] < rect[1])) continue;
        this.gbAlive[id] = this._gbDead(id) ? 0 : 1;
      }
    }
    if (!rect) {
      for (let i = 0; i < this.nb; i++) this.bAlive[i] = this._bDead(i) ? 0 : 1;
      for (let j = 0; j < this.brAlive.length; j++) this.brAlive[j] = this._brDead(j) ? 0 : 1;
      return;
    }
    const list = this._query(this.bIdx, this.bStamp, rect[0], rect[1], rect[2], rect[3], []);
    for (const i of list) this.bAlive[i] = this._bDead(i) ? 0 : 1;
    const bx = this.brBox;
    for (let j = 0; j < this.brAlive.length; j++) {
      if (bx[j * 4] > rect[2] || bx[j * 4 + 2] < rect[0] || bx[j * 4 + 1] > rect[3] || bx[j * 4 + 3] < rect[1]) continue;
      this.brAlive[j] = this._brDead(j) ? 0 : 1;
    }
  }

  _watchFonts() {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
    const specs = ['700 12px "Archivo Narrow"', '600 12px "IBM Plex Mono"'];
    let ok = true;
    try { ok = specs.every(s => document.fonts.check(s)); } catch (e) { ok = false; }
    if (ok) return;
    Promise.all(specs.map(s => document.fonts.load(s))).then(() => this.invalidate(), () => {});
  }

  // Marks cached pixels stale. rect = [x0, y0, x1, y1] in metres, or null for everything.
  invalidate(rect = null) {
    this.version++;
    if (!rect) {
      this._refreshAlive(null);
      for (const t of this.tiles.values()) t.dirty = true;
      // a drawn overview keeps showing while it is redrawn a chunk at a time
      for (const ov of this.overviews.values()) { ov.rects.length = 0; if (ov.drawn) ov.todo = ovChunks(ov); else ov.full = true; }
      return;
    }
    this._refreshAlive(rect);
    const ex = [rect[0] - this.maxShX - 4, rect[1] - this.maxShY - 4, rect[2] + 4, rect[3] + 4];
    for (const t of this.tiles.values()) {
      const S = 2 ** (t.bi / 2), m = 40 * (this.style ? this.style.px : 1) / S;
      const x0 = t.tx * TILE / S - m, y0 = t.ty * TILE / S - m, x1 = (t.tx + 1) * TILE / S + m, y1 = (t.ty + 1) * TILE / S + m;
      if (x1 < ex[0] || x0 > ex[2] || y1 < ex[1] || y0 > ex[3]) continue;
      t.dirty = true;
    }
    for (const ov of this.overviews.values()) if (!ov.full) ov.rects.push(ex);
  }

  invalidateBuilding(b) {
    if (b < 0 || b >= this.nb) return;
    const bb = this.bb, h = this.bh[b] * 1.25 + 8;
    this.invalidate([bb[b * 4] - h, bb[b * 4 + 1] - h, bb[b * 4 + 2] + h, bb[b * 4 + 3] + h]);
  }

  // id = grid / world bridge index (0-based), as in the 'bridgeDown' event.
  invalidateBridge(id) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (b, k) => { x0 = Math.min(x0, b[k]); y0 = Math.min(y0, b[k + 1]); x1 = Math.max(x1, b[k + 2]); y1 = Math.max(y1, b[k + 3]); };
    if (this.gbBox && id >= 0 && id < this.gbAlive.length) grow(this.gbBox, id * 4);
    for (let j = 0; j < this.brId.length; j++) if (this.brId[j] === id) grow(this.brBox, j * 4);
    if (x1 >= x0) this.invalidate([x0 - 8, y0 - 8, x1 + 8, y1 + 8]);
  }

  setStyle(pal, view, px) {
    const key = `${pal.name}|${view}|${px}`;
    if (this.style && this.style.key === key) return;
    const n = this.nb, bk = this.bk;
    const colorIdx = new Uint8Array(n);
    let colors, lines;
    if (view === 'height') {
      for (let i = 0; i < n; i++) colorIdx[i] = heightClass(this.bh[i]);
      colors = pal.heightRamp.slice();
      lines = colors.map(() => pal.buildingLine);
    } else if (view === 'specials') {
      for (let i = 0; i < n; i++) colorIdx[i] = bk[i] >= K_SPECIAL_LO && bk[i] <= K_SPECIAL_HI ? bk[i] : 0;
      colors = BUILDING_KIND_ORDER.map(k => pal.specialFill[k] || pal.bldgFaded);
      lines = BUILDING_KIND_ORDER.map(k => pal.special[k] || pal.bldgFadedLine);
      colors[0] = pal.bldgFaded;
      lines[0] = pal.bldgFadedLine;
    } else {
      for (let i = 0; i < n; i++) colorIdx[i] = bk[i];
      colors = BUILDING_KIND_ORDER.map(k => pal.bldgKind[k]);
      lines = colors.map(() => pal.buildingLine);
    }
    const [sr, sg, sb, sa] = parseRgba(pal.buildingShadow);
    this.style = { key, pal, view, px, colorIdx, colors, lines, pats: patternSet(pal, px), rubbleLow: mix(pal.rubbleGround, pal.rubble, 0.5),
                   shadowRGB: `rgb(${sr},${sg},${sb})`, shadowA: sa / 255 };
    for (const t of this.tiles.values()) this._release(t);
    this.tiles.clear();
    this.bi = null;
    this.prevBi = null;
  }

  _release(t) {
    if (this.pool.length < 16) this.pool.push(t.canvas);
  }

  _pickBucket(z) {
    if (this.bi !== null) {
      const S = 2 ** (this.bi / 2), r = z / S;
      if (r <= 1.03 && r >= 0.686) return this.bi;
    }
    const bi = clamp(Math.ceil(2 * Math.log2(z) - 0.06), -40, 14);
    if (bi !== this.bi) { this.prevBi = this.bi; this.bi = bi; }
    return bi;
  }

  // ---------------- vector drawing into a device-pixel region ----------------

  _renderRegion(ctx, S, ox, oy, pw, ph) {
    const st = this.style, pal = st.pal, px = st.px, m = this.map;
    const x0 = ox / S, y0 = oy / S, x1 = (ox + pw) / S, y1 = (oy + ph) / S;
    const mg = 36 * px / S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash([]);
    ctx.clearRect(0, 0, pw, ph);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-ox, -oy, m.w * S, m.h * S);
    ctx.clip();
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, pw, ph);
    this._areas(ctx, S, ox, oy, x0 - mg, y0 - mg, x1 + mg, y1 + mg);
    this._grid(ctx, S, ox, oy, pw, ph);
    this._roads(ctx, S, ox, oy, x0 - mg, y0 - mg, x1 + mg, y1 + mg);
    this._lostCrossings(ctx, S, ox, oy, x0 - mg, y0 - mg, x1 + mg, y1 + mg);
    this._bridges(ctx, S, ox, oy, x0 - mg, y0 - mg, x1 + mg, y1 + mg);
    this._rubble(ctx, S, ox, oy, x0 - mg, y0 - mg, x1 + mg, y1 + mg);
    this._buildings(ctx, S, ox, oy, x0 - mg - this.maxShX, y0 - mg - this.maxShY, x1 + mg, y1 + mg, pw, ph);
    this._labels(ctx, S, ox, oy, pw, ph);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    usePattern(ctx, st.pats.grain, -ox, -oy);
    ctx.fillRect(0, 0, pw, ph);
    ctx.restore();
  }

  _areas(ctx, S, ox, oy, qx0, qy0, qx1, qy1) {
    const st = this.style, pal = st.pal, px = st.px, m = this.map;
    // vertices on the sheet edge are pushed past it so outlines and shore lining only follow real edges
    const E = Math.max(60, 40 * px / S), W = m.w, H = m.h;
    const pushOut = p => {
      let q = null;
      for (let k = 0; k < p.length; k += 2) {
        const x = p[k], y = p[k + 1];
        const nx = x <= 0.5 ? -E : x >= W - 0.5 ? W + E : x, ny = y <= 0.5 ? -E : y >= H - 0.5 ? H + E : y;
        if (nx !== x || ny !== y) { if (!q) q = p.slice(); q[k] = nx; q[k + 1] = ny; }
      }
      return q || p;
    };
    const pick = (list, box) => {
      let any = false;
      ctx.setTransform(S, 0, 0, S, -ox, -oy);
      ctx.beginPath();
      for (let i = 0; i < list.length; i++) {
        const bx0 = box[i * 4], by0 = box[i * 4 + 1], bx1 = box[i * 4 + 2], by1 = box[i * 4 + 3];
        if (bx0 > qx1 || bx1 < qx0 || by0 > qy1 || by1 < qy0) continue;
        let p = list[i].p;
        if (bx0 <= 0.5 || by0 <= 0.5 || bx1 >= W - 0.5 || by1 >= H - 0.5) p = pushOut(p);
        // big polygons are cut to the padded region so strokes don't walk the whole outline per tile
        if (bx0 < qx0 || by0 < qy0 || bx1 > qx1 || by1 > qy1) p = clipPolyRect(p, qx0, qy0, qx1, qy1);
        if (p.length < 6) continue;
        polyTo(ctx, p);
        any = true;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return any;
    };
    const P = m.parks || [], pb = this.parkBox;
    for (let from = 0; from < P.length; from += CHUNK) {
      if (!pick(P.slice(from, from + CHUNK), pb.subarray(from * 4, (from + CHUNK) * 4))) continue;
      ctx.fillStyle = pal.park;
      ctx.fill();
      usePattern(ctx, st.pats.park, -ox, -oy);
      ctx.fill();
      ctx.lineWidth = 0.9 * px;
      ctx.strokeStyle = pal.parkLine;
      ctx.stroke();
    }
    if (m.water && m.water.length && pick(m.water, this.waterBox)) {
      ctx.fillStyle = pal.water;
      ctx.fill();
      usePattern(ctx, st.pats.water, -ox, -oy);
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.lineJoin = 'round';
      for (const d of [11, 5.5]) {
        ctx.lineWidth = (2 * d + 1) * px;
        ctx.strokeStyle = pal.waterHatch;
        ctx.stroke();
        ctx.lineWidth = (2 * d - 1) * px;
        ctx.strokeStyle = pal.water;
        ctx.stroke();
      }
      ctx.restore();
      ctx.lineWidth = 1.2 * px;
      ctx.strokeStyle = pal.waterLine;
      ctx.stroke();
    }
  }

  _grid(ctx, S, ox, oy, pw, ph) {
    const pal = this.style.pal, px = this.style.px, m = this.map;
    const G = this.gridStep, minor = G / 5;
    const showMinor = minor * S >= 30 * px;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lines = (step, skipMajor) => {
      ctx.beginPath();
      const ax = Math.max(0, Math.ceil(ox / S / step)), bx = Math.floor(Math.min(m.w, (ox + pw) / S) / step);
      for (let k = ax; k <= bx; k++) {
        const w = k * step;
        if (skipMajor && Math.abs(w / G - Math.round(w / G)) < 1e-6) continue;
        const X = Math.round(w * S - ox) + 0.5;
        ctx.moveTo(X, 0); ctx.lineTo(X, ph);
      }
      const ay = Math.max(0, Math.ceil(oy / S / step)), by = Math.floor(Math.min(m.h, (oy + ph) / S) / step);
      for (let k = ay; k <= by; k++) {
        const w = k * step;
        if (skipMajor && Math.abs(w / G - Math.round(w / G)) < 1e-6) continue;
        const Y = Math.round(w * S - oy) + 0.5;
        ctx.moveTo(0, Y); ctx.lineTo(pw, Y);
      }
    };
    ctx.lineWidth = Math.max(1, Math.round(px * 0.8));
    if (showMinor) { lines(minor, true); ctx.strokeStyle = pal.grid; ctx.stroke(); }
    lines(G, false);
    ctx.strokeStyle = pal.gridMajor;
    ctx.stroke();
    if (G * S >= 170 * px) {
      ctx.font = `500 ${Math.round(9.5 * px)}px ${FONT_MONO}`;
      ctx.fillStyle = pal.gridLabel;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      const lm = 60 * px / S;
      const ax = Math.max(0, Math.floor((ox / S - lm) / G)), bx = Math.floor(Math.min(m.w - 1, (ox + pw) / S) / G);
      const ay = Math.max(0, Math.floor((oy / S - lm) / G)), by = Math.floor(Math.min(m.h - 1, (oy + ph) / S) / G);
      for (let gy = ay; gy <= by; gy++) for (let gx = ax; gx <= bx; gx++) {
        ctx.fillText(colLabel(gx) + (gy + 1), Math.round(gx * G * S - ox) + 4 * px, Math.round(gy * G * S - oy) + 4 * px);
      }
    }
  }

  _roads(ctx, S, ox, oy, qx0, qy0, qx1, qy1) {
    if (!this.nr) return;
    const pal = this.style.pal, px = this.style.px, R = this.map.roads;
    const list = this._query(this.rIdx, this.rStamp, qx0, qy0, qx1, qy1, this._rl || (this._rl = []));
    if (!list.length) return;
    const rank = this.rRank;
    list.sort((a, b) => rank[a] - rank[b]);
    const rk = this.rk, rw = this.rw;
    const groups = [];
    let cur = null;
    for (const r of list) {
      const k = rk[r];
      if (k === RK.bridge || k === RK.rail) continue;
      if (!cur || cur.k !== k || cur.w !== rw[r]) { cur = { k, w: rw[r], path: new Path2D() }; groups.push(cur); }
      const p = R[r].p;
      if (p.length >= 4) lineTo(cur.path, p);
    }
    const u = 1 / S;
    ctx.setTransform(S, 0, 0, S, -ox, -oy);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const g of groups) {
      if (g.k !== RK.path) continue;
      ctx.lineWidth = Math.max(g.w * 0.35 * S, 1.1 * px) * u;
      ctx.strokeStyle = pal.path;
      ctx.setLineDash([3.2 * px * u, 2.6 * px * u]);
      ctx.stroke(g.path);
    }
    ctx.setLineDash([]);
    const dev = g => Math.max(g.w * S, (g.k === RK.major ? 2.4 : 1.5) * px);
    const cas = g => (g.k === RK.major ? clamp(g.w * S * 0.09, 1.0 * px, 2.4 * px) : clamp(g.w * S * 0.07, 0.75 * px, 1.6 * px));
    for (const g of groups) {
      if (g.k !== RK.minor && g.k !== RK.major) continue;
      ctx.lineWidth = (dev(g) + 2 * cas(g)) * u;
      ctx.strokeStyle = g.k === RK.major ? pal.majorCasing : pal.roadCasing;
      ctx.stroke(g.path);
    }
    for (const g of groups) {
      if (g.k !== RK.minor && g.k !== RK.major) continue;
      ctx.lineWidth = dev(g) * u;
      ctx.strokeStyle = g.k === RK.major ? pal.majorRoad : pal.road;
      ctx.stroke(g.path);
    }
    drawRails(ctx, this, list, S, ox, oy, qx0, qy0, qx1, qy1);
  }

  _bridges(ctx, S, ox, oy, qx0, qy0, qx1, qy1) {
    const n = this.bridgeRoads.length;
    if (!n) return;
    const pal = this.style.pal, px = this.style.px, R = this.map.roads, box = this.brBox, u = 1 / S;
    ctx.setTransform(S, 0, 0, S, -ox, -oy);
    for (let j = 0; j < n; j++) {
      if (box[j * 4] > qx1 || box[j * 4 + 2] < qx0 || box[j * 4 + 1] > qy1 || box[j * 4 + 3] < qy0) continue;
      const r = this.bridgeRoads[j], p = R[r].p;
      if (p.length < 4) continue;
      const w = this.rw[r], L = this.brLen[j];
      const alive = this.brAlive[j] === 1;
      const devW = Math.max(w * S, 2.2 * px);
      const gap = Math.max(1.4, 2.2 * px * u);
      const pieces = alive ? [p] : [subPolyline(p, 0, Math.min(L * 0.16, 14)), subPolyline(p, L - Math.min(L * 0.16, 14), L)];
      for (let pi = 0; pi < pieces.length; pi++) {
        const q = pieces[pi];
        if (q.length < 4) continue;
        const path = new Path2D();
        lineTo(path, q);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.lineWidth = devW * u + 2 * Math.max(0.9 * px, devW * 0.06) * u;
        ctx.strokeStyle = pal.bridgeCasing;
        ctx.stroke(path);
        ctx.lineWidth = devW * u;
        ctx.strokeStyle = pal.bridge;
        ctx.stroke(path);
        const d = devW * u / 2 + gap;
        ctx.lineWidth = 1.15 * px * u;
        ctx.strokeStyle = pal.bridgeEdge;
        const tick = Math.max(2.4, 5 * px * u);
        const edges = new Path2D();
        for (const sgn of [-1, 1]) {
          const e = offsetPolyline(q, sgn * d);
          lineTo(edges, e);
          const ends = alive ? [0, 1] : [pi === 0 ? 0 : 1];
          for (const end of ends) {
            const k = end === 0 ? 0 : e.length - 2;
            const k2 = end === 0 ? 2 : e.length - 4;
            const tx = e[k] - e[k2], ty = e[k + 1] - e[k2 + 1], tl = Math.hypot(tx, ty) || 1;
            const nx = e[k] - q[k], ny = e[k + 1] - q[k + 1], nl = Math.hypot(nx, ny) || 1;
            edges.moveTo(e[k], e[k + 1]);
            edges.lineTo(e[k] + (tx / tl + nx / nl) * tick * 0.7071, e[k + 1] + (ty / tl + ny / nl) * tick * 0.7071);
          }
        }
        ctx.stroke(edges);
        if (!alive) {
          const end = pi === 0 ? q.length - 2 : 0, prev = pi === 0 ? q.length - 4 : 2;
          const ex = q[end], ey = q[end + 1];
          const tx = ex - q[prev], ty = ey - q[prev + 1], tl = Math.hypot(tx, ty) || 1;
          const ux = tx / tl, uy = ty / tl, nx = -uy, ny = ux;
          const zz = new Path2D();
          const hw = w / 2 + gap;
          const steps = 5;
          for (let s = 0; s <= steps; s++) {
            const f = -hw + (2 * hw * s) / steps, jag = (s % 2 ? 1 : -0.6) * Math.min(2.5, w * 0.25);
            const x = ex + nx * f + ux * jag, y = ey + ny * f + uy * jag;
            if (s === 0) zz.moveTo(x, y); else zz.lineTo(x, y);
          }
          ctx.lineWidth = 1.4 * px * u;
          ctx.strokeStyle = pal.bridgeCasing;
          ctx.stroke(zz);
        }
      }
      if (!alive) {
        const rnd = mulberry32(hash2(r, 77));
        const mid = subPolyline(p, Math.min(L * 0.16, 14), L - Math.min(L * 0.16, 14));
        if (mid.length >= 4) {
          const ml = polylineLength(mid);
          ctx.fillStyle = pal.rubble;
          ctx.beginPath();
          const cnt = Math.min(40, Math.round(ml / 3));
          for (let k = 0; k < cnt; k++) {
            const pt = subPolyline(mid, rnd() * ml, ml);
            const s = Math.max(0.8, 1.4 * px * u) * (0.6 + rnd());
            ctx.rect(pt[0] + (rnd() - 0.5) * w, pt[1] + (rnd() - 0.5) * w, s, s);
          }
          ctx.fill();
        }
      }
    }
    ctx.lineCap = 'round';
  }

  // Grid bridges with no 'bridge' road drawn over them (plain roads crossing water): show the gap as water.
  _lostCrossings(ctx, S, ox, oy, qx0, qy0, qx1, qy1) {
    const g = this.grid;
    if (!g || !g.bridges || !this.gbAlive) return;
    const pal = this.style.pal, gx = this.gbBox, cell = g.cell;
    let any = false;
    ctx.setTransform(S, 0, 0, S, -ox, -oy);
    ctx.beginPath();
    for (let id = 0; id < this.gbAlive.length; id++) {
      if (this.gbAlive[id] || this.gbMapped[id]) continue;
      if (gx[id * 4] > qx1 || gx[id * 4 + 2] < qx0 || gx[id * 4 + 1] > qy1 || gx[id * 4 + 3] < qy0) continue;
      for (const c of g.bridges[id].cells) ctx.rect((c % g.gw) * cell, ((c / g.gw) | 0) * cell, cell + 0.05, cell + 0.05);
      any = true;
    }
    if (!any) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.water;
    ctx.fill();
    usePattern(ctx, this.style.pats.water, -ox, -oy);
    ctx.fill();
  }

  _rubble(ctx, S, ox, oy, qx0, qy0, qx1, qy1) {
    const g = this.grid;
    if (!g || !g.terrain) return;
    const st = this.style, pal = st.pal, px = st.px;
    const cell = g.cell, gw = g.gw, gh = g.gh, t = g.terrain;
    const cx0 = Math.max(0, Math.floor(qx0 / cell)), cx1 = Math.min(gw - 1, Math.floor(qx1 / cell));
    const cy0 = Math.max(0, Math.floor(qy0 / cell)), cy1 = Math.min(gh - 1, Math.floor(qy1 / cell));
    if (cx1 < cx0 || cy1 < cy0) return;
    const detail = cell * S >= 6 * px;
    ctx.setTransform(S, 0, 0, S, -ox, -oy);
    ctx.beginPath();
    let any = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * gw;
      let cx = cx0;
      while (cx <= cx1) {
        if (t[row + cx] !== T.RUBBLE) { cx++; continue; }
        const a = cx;
        while (cx <= cx1 && t[row + cx] === T.RUBBLE) cx++;
        ctx.rect(a * cell, cy * cell, (cx - a) * cell, cell);
        any = true;
      }
    }
    if (!any) return;
    ctx.fillStyle = detail ? pal.rubbleGround : st.rubbleLow;
    ctx.fill();
    if (!detail) return;
    ctx.beginPath();
    const big = cell * S >= 16 * px;
    const dmin = Math.max(cell * 0.06, 1.1 * px / S);
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * gw;
      for (let cx = cx0; cx <= cx1; cx++) {
        if (t[row + cx] !== T.RUBBLE) continue;
        let h = hash2(cx, cy);
        const n = big ? 7 : 4;
        for (let k = 0; k < n; k++) {
          const fx = (h & 255) / 256, fy = ((h >>> 8) & 255) / 256, fs = ((h >>> 16) & 255) / 256;
          const s = dmin * (0.7 + fs * (big ? 2.6 : 1.4));
          ctx.rect(cx * cell + fx * cell, cy * cell + fy * cell, s, s * (0.6 + fs * 0.8));
          h = hash2(h, k + 1);
        }
      }
    }
    ctx.fillStyle = pal.rubble;
    ctx.fill();
  }

  _scratch(w, h) {
    let c = this._scr;
    if (!c || c.width < w || c.height < h) {
      c = this._scr = makeCanvas(Math.max(w, c ? c.width : 0), Math.max(h, c ? c.height : 0));
      this._scrCtx = c.getContext('2d');
    }
    return this._scrCtx;
  }

  // Paths are flushed every CHUNK footprints: one huge overlapping path makes GPU canvases tessellate slowly.
  // Shadows go opaque into a scratch mask (overlaps merge) that is composited once with the shadow alpha.
  _buildings(ctx, S, ox, oy, qx0, qy0, qx1, qy1, pw, ph) {
    if (!this.nb) return;
    const st = this.style, pal = st.pal, px = st.px, B = this.map.buildings;
    const list = this._query(this.bIdx, this.bStamp, qx0, qy0, qx1, qy1, this._bl || (this._bl = []));
    if (!list.length) return;
    list.sort((a, b) => a - b);
    const bb = this.bb, bh = this.bh, alive = this.bAlive, posO = this.bpos, ci = st.colorIdx;
    const batches = new Array(st.colors.length);
    const tiny = 1.4 * px / S;
    let sctx = null, sh = null, nsh = 0;
    for (const i of list) {
      if (!alive[i]) continue;
      const x0 = bb[i * 4], y0 = bb[i * 4 + 1], x1 = bb[i * 4 + 2], y1 = bb[i * 4 + 3];
      const h = shadowHeight(bh[i]), dx = h * SHADOW_X, dy = h * SHADOW_Y;
      if (x0 > qx1 || y0 > qy1 || x1 + dx < qx0 || y1 + dy < qy0) continue;
      const p = B[i].p, n = p.length;
      if (n < 6) continue;
      const sdev = (dx + dy) * S;
      if (sdev >= 0.6 * px) {
        if (!sctx) {
          sctx = this._scratch(pw, ph);
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.clearRect(0, 0, pw, ph);
          sctx.setTransform(S, 0, 0, S, -ox, -oy);
          sctx.fillStyle = st.shadowRGB;
        }
        if (!sh) sh = new Path2D();
        polyTo(sh, p, dx, dy, !posO[i]);
        if (sdev >= 2.5 * px && n <= 160) {
          for (let k = 0; k < n; k += 2) {
            const ax = p[k], ay = p[k + 1], bx = p[(k + 2) % n], by = p[(k + 3) % n];
            const cr = (bx - ax) * dy - (by - ay) * dx;
            if (cr > 1e-9) {
              sh.moveTo(ax, ay); sh.lineTo(bx, by); sh.lineTo(bx + dx, by + dy); sh.lineTo(ax + dx, ay + dy); sh.closePath();
            } else if (cr < -1e-9) {
              sh.moveTo(ax, ay); sh.lineTo(ax + dx, ay + dy); sh.lineTo(bx + dx, by + dy); sh.lineTo(bx, by); sh.closePath();
            }
          }
        }
        if (++nsh % CHUNK === 0) { sctx.fill(sh); sh = null; }
      }
      if (x0 > qx1 || y0 > qy1 || x1 < qx0 || y1 < qy0) continue;
      const c = ci[i];
      const arr = batches[c] || (batches[c] = []);
      let cur = arr[arr.length - 1];
      if (!cur || cur.n >= CHUNK) { cur = { path: new Path2D(), n: 0, fillOnly: null, outline: null }; arr.push(cur); }
      cur.n++;
      const cut = this.bCut.get(i);
      if (x1 - x0 < tiny && y1 - y0 < tiny) cur.path.rect(x0, y0, Math.max(x1 - x0, tiny * 0.7), Math.max(y1 - y0, tiny * 0.7));
      else if (cut) {
        polyTo(cur.fillOnly || (cur.fillOnly = new Path2D()), p);
        const o = cur.outline || (cur.outline = new Path2D());
        for (const ln of cut) { o.moveTo(ln[0], ln[1]); for (let k = 2; k < ln.length; k += 2) o.lineTo(ln[k], ln[k + 1]); }
      } else polyTo(cur.path, p);
    }
    if (sh) sctx.fill(sh);
    if (sctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = st.shadowA;
      ctx.drawImage(sctx.canvas, 0, 0, pw, ph, 0, 0, pw, ph);
      ctx.restore();
    }
    ctx.setTransform(S, 0, 0, S, -ox, -oy);
    for (let c = 0; c < batches.length; c++) {
      if (!batches[c]) continue;
      ctx.fillStyle = st.colors[c];
      for (const b of batches[c]) { ctx.fill(b.path); if (b.fillOnly) ctx.fill(b.fillOnly); }
    }
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 3;
    const lw = clamp(0.3 * S, 0.5 * px, 1.25 * px) / S;
    for (let c = 0; c < batches.length; c++) {
      if (!batches[c]) continue;
      ctx.lineWidth = st.view === 'specials' && c > 0 ? lw * 1.8 : lw;
      ctx.strokeStyle = st.lines[c];
      for (const b of batches[c]) { ctx.stroke(b.path); if (b.outline) ctx.stroke(b.outline); }
    }
  }

  _labels(ctx, S, ox, oy, pw, ph) {
    const sp = this.specials;
    if (!sp.length) return;
    const st = this.style, pal = st.pal, px = st.px, B = this.map.buildings;
    const view = st.view;
    const full = view === 'specials' ? S >= 0.45 * px : S >= 1.15 * px;
    const R = (S < 0.9 * px ? 9 : S < 2.5 * px ? 11.5 : 13.5) * px;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(R * 0.7)}px ${FONT_LABEL}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(0.06 * R).toFixed(1)}px`;
    const pad = R + 3 * px;
    for (let s = 0; s < sp.length; s++) {
      const i = sp[s];
      if (!this.bAlive[i]) continue;
      const X = this.lx[i] * S - ox, Y = this.ly[i] * S - oy;
      if (X < -pad || Y < -pad || X > pw + pad || Y > ph + pad) continue;
      const kind = B[i].k, col = pal.special[kind] || pal.ink;
      if (!full) {
        if (view === 'specials' || S >= 0.35 * px) {
          const q = Math.max(2, Math.round((view === 'specials' ? 4 : 3) * px));
          ctx.fillStyle = col;
          ctx.fillRect(Math.round(X - q / 2), Math.round(Y - q / 2), q, q);
        }
        continue;
      }
      const rot = (((hash2(i, 911) & 1023) / 1023) * 7 - 4) * Math.PI / 180;
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fillStyle = pal.card;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6 * px;
      ctx.setLineDash([R * 1.9, R * 0.12, R * 1.2, R * 0.08]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(0, 0, R - 2.8 * px, 0, TAU);
      ctx.lineWidth = 0.75 * px;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(SPECIAL_CODES[kind] || '?', 0, 0.06 * R);
      ctx.restore();
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  // ---------------- overview fallback (whole map, low resolution) ----------------

  // Brings the overview up to date within budgetMs of t0 (at least one patch per call): damaged rectangles first,
  // then the chunks of a whole-sheet refresh nearest (fx, fy) metres. Only a never-drawn overview is drawn at once.
  _overview(t0 = now(), budgetMs = Infinity, fx = null, fy = null) {
    const st = this.style, m = this.map;
    let ov = this.overviews.get(st.key);
    if (!ov) {
      const s = Math.min(OVERVIEW_MAX / Math.max(m.w, m.h), 2.5);
      const w = Math.max(1, Math.ceil(m.w * s)), h = Math.max(1, Math.ceil(m.h * s));
      ov = { s, w, h, canvas: makeCanvas(w, h), full: true, drawn: false, rects: [], todo: [] };
      this.overviews.set(st.key, ov);
      if (this.overviews.size > 3) this.overviews.delete(this.overviews.keys().next().value);
    }
    const g = ov.canvas.getContext('2d');
    if (ov.full) {
      this._renderRegion(g, ov.s, 0, 0, ov.w, ov.h);
      ov.full = false;
      ov.drawn = true;
      ov.rects.length = 0;
      ov.todo.length = 0;
      return ov;
    }
    for (let n = 0; ov.rects.length || ov.todo.length; n++) {
      if (n > 0 && now() - t0 >= budgetMs) break;
      let px;
      if (ov.rects.length) {
        const r = ov.rects.shift();
        px = [clamp(Math.floor(r[0] * ov.s) - 2, 0, ov.w), clamp(Math.floor(r[1] * ov.s) - 2, 0, ov.h), clamp(Math.ceil(r[2] * ov.s) + 2, 0, ov.w), clamp(Math.ceil(r[3] * ov.s) + 2, 0, ov.h)];
      } else {
        let k = 0;
        if (fx !== null) {
          let bd = Infinity;
          const qx = fx * ov.s, qy = fy * ov.s;
          for (let i = 0; i < ov.todo.length; i++) {
            const c = ov.todo[i], d = ((c[0] + c[2]) / 2 - qx) ** 2 + ((c[1] + c[3]) / 2 - qy) ** 2;
            if (d < bd) { bd = d; k = i; }
          }
        }
        px = ov.todo.splice(k, 1)[0];
      }
      this._ovPatch(ov, g, px);
    }
    return ov;
  }

  _ovPatch(ov, g, [ax, ay, bx, by]) {
    const w = bx - ax, h = by - ay;
    if (w <= 0 || h <= 0) return;
    let tmp = this._ovTmp;
    if (!tmp || tmp.width < w || tmp.height < h) tmp = this._ovTmp = makeCanvas(Math.max(w, tmp ? tmp.width : 0), Math.max(h, tmp ? tmp.height : 0));
    this._renderRegion(tmp.getContext('2d'), ov.s, ax, ay, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(ax, ay, w, h);
    g.drawImage(tmp, 0, 0, w, h, ax, ay, w, h);
  }

  _newTile(bi, tx, ty, key) {
    const canvas = this.pool.pop() || makeCanvas(TILE, TILE);
    const t = { key, bi, tx, ty, canvas, ctx: canvas.getContext('2d'), dirty: true, used: this.frame };
    this.tiles.set(key, t);
    return t;
  }

  _renderTile(t) {
    const S = 2 ** (t.bi / 2);
    this._renderRegion(t.ctx, S, t.tx * TILE, t.ty * TILE, TILE, TILE);
    t.dirty = false;
    this.stats.rendered++;
  }

  _evict(keep) {
    if (this.tiles.size <= this.maxTiles) return;
    const arr = [...this.tiles.values()].filter(t => t.used < keep).sort((a, b) => a.used - b.used);
    for (const t of arr) {
      if (this.tiles.size <= this.maxTiles) break;
      this.tiles.delete(t.key);
      this._release(t);
    }
  }
}

const tileKey = (bi, tx, ty) => ((bi + 64) * 8192 + ty) * 8192 + tx;

function ovChunks(ov) {
  const out = [];
  for (let y = 0; y < ov.h; y += OV_CHUNK) for (let x = 0; x < ov.w; x += OV_CHUNK) out.push([x, y, Math.min(ov.w, x + OV_CHUNK), Math.min(ov.h, y + OV_CHUNK)]);
  return out;
}

export function makeStaticCache(map, grid = null) {
  const c = new StaticCache(map, grid);
  CACHES.set(map, c);
  return c;
}

export function getStaticCache(map, grid) {
  let c = CACHES.get(map);
  if (!c) c = makeStaticCache(map, grid ?? null);
  return c;
}

export function invalidate(map, rect = null) { const c = CACHES.get(map); if (c) c.invalidate(rect); }
export function invalidateBuilding(map, b) { const c = CACHES.get(map); if (c) c.invalidateBuilding(b); }
export function invalidateBridge(map, id) { const c = CACHES.get(map); if (c) c.invalidateBridge(id); }

function stagePolyOf(map, sm) {
  if (sm == null || sm === false) return null;
  if (typeof sm === 'number') return (map.levels && map.levels[sm] && map.levels[sm].p) || null;
  if (sm instanceof Uint8Array) return sm;
  if (Array.isArray(sm) || sm instanceof Float32Array || sm instanceof Float64Array) return sm;
  if (sm.p) return sm.p;
  if (sm.poly) return sm.poly;
  return null;
}

const MASKS = new WeakMap();
function maskCanvas(mask, grid, pal) {
  let e = MASKS.get(mask);
  if (e && e.pal === pal.name) return e.canvas;
  const gw = grid.gw, gh = grid.gh;
  const c = makeCanvas(gw, gh), g = c.getContext('2d');
  const img = g.createImageData(gw, gh);
  const [r, gg, b, a] = parseRgba(pal.outsideDim);
  for (let i = 0; i < gw * gh; i++) {
    if (mask[i]) continue;
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
  MASKS.set(mask, { pal: pal.name, canvas: c });
  return c;
}

function pathDevice(ctx, p, z, offX, offY) {
  ctx.moveTo(p[0] * z - offX, p[1] * z - offY);
  for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k] * z - offX, p[k + 1] * z - offY);
  ctx.closePath();
}

// Draws the paper map for one frame. ctx must be in CSS-pixel space (identity * devicePixelRatio).
// opts: { palette, view: 'normal'|'height'|'specials', stageMask (level index | flat polygon | Uint8Array cell mask | level/region object),
//         stage (alias of stageMask), dimOutside = true, stageLine = true, allStages = false, hover (building idx | {b} | {bridge: gridBridgeId} | {road}),
//         frame = true (sheet margin + graduated border), world (optional: use world.buildings/bridges alive flags), budgetMs, cache }
// Returns { pending, rendered, ms } — pending > 0 means more tiles will sharpen on the next frames.
export function drawStatic(ctx, map, grid, camera, opts = {}) {
  const t0 = now();
  const cache = opts.cache || getStaticCache(map, grid);
  if (grid !== undefined && (grid || null) !== cache.grid) cache.setGrid(grid);
  if (opts.world !== undefined && (opts.world || null) !== cache.world) cache.setWorld(opts.world);
  const pal = getPalette(opts.palette || map.palette);
  const tr = ctx.getTransform();
  const dpr = tr.a || 1;
  cache.setStyle(pal, opts.view || 'normal', Math.round(dpr * 100) / 100);
  cache.frame++;
  cache.stats.rendered = 0;
  const frame = cache.frame;
  const z = camera.zoom * dpr;
  const bi = cache._pickBucket(z);
  const S = 2 ** (bi / 2);
  const offX = camera.x * z - tr.e, offY = camera.y * z - tr.f;
  const vw = camera.w * dpr, vh = camera.h * dpr;
  const VX0 = tr.e, VY0 = tr.f, VX1 = tr.e + vw, VY1 = tr.f + vh;
  const mx0 = -offX, my0 = -offY, mx1 = map.w * z - offX, my1 = map.h * z - offY;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
  ctx.setLineDash([]);
  ctx.fillStyle = pal.desk;
  ctx.fillRect(VX0, VY0, vw, vh);
  const showFrame = opts.frame !== false;
  const M = showFrame ? 34 * dpr : 0;
  ctx.fillStyle = pal.deskShadow;
  ctx.fillRect(mx0 - M + 6 * dpr, my0 - M + 6 * dpr, mx1 - mx0 + 2 * M, my1 - my0 + 2 * M);
  ctx.fillStyle = pal.paper;
  ctx.fillRect(mx0 - M, my0 - M, mx1 - mx0 + 2 * M, my1 - my0 + 2 * M);

  ctx.save();
  ctx.beginPath();
  const cx0 = Math.max(VX0, mx0), cy0 = Math.max(VY0, my0), cx1 = Math.min(VX1, mx1), cy1 = Math.min(VY1, my1);
  ctx.rect(cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0));
  ctx.clip();

  const r = z / S;
  const ntx = Math.ceil(map.w * S / TILE), nty = Math.ceil(map.h * S / TILE);
  const wx0 = camera.x, wy0 = camera.y, wx1 = camera.x + camera.w / camera.zoom, wy1 = camera.y + camera.h / camera.zoom;
  const tx0 = clamp(Math.floor(wx0 * S / TILE), 0, ntx - 1), tx1 = clamp(Math.floor(wx1 * S / TILE), 0, ntx - 1);
  const ty0 = clamp(Math.floor(wy0 * S / TILE), 0, nty - 1), ty1 = clamp(Math.floor(wy1 * S / TILE), 0, nty - 1);
  const visible = cx1 > cx0 && cy1 > cy0;
  const need = [];
  const budget = opts.budgetMs ?? cache.budgetMs;
  const fxm = (wx0 + wx1) / 2, fym = (wy0 + wy1) / 2;
  let missing = false;
  const blit = t => {
    const rr = z / (2 ** (t.bi / 2));
    const X0 = Math.round(t.tx * TILE * rr - offX), X1 = Math.round((t.tx + 1) * TILE * rr - offX);
    const Y0 = Math.round(t.ty * TILE * rr - offY), Y1 = Math.round((t.ty + 1) * TILE * rr - offY);
    if (X1 < VX0 || Y1 < VY0 || X0 > VX1 || Y0 > VY1) return;
    ctx.drawImage(t.canvas, X0, Y0, X1 - X0, Y1 - Y0);
  };
  if (visible) {
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(bi, tx, ty);
      const t = cache.tiles.get(key);
      if (t) { t.used = frame; if (t.dirty) need.push(t); }
      else { missing = true; need.push({ key, bi, tx, ty, fresh: true }); }
    }
    if (missing) {
      const ov = cache._overview(t0, budget * 0.5, fxm, fym);
      ctx.drawImage(ov.canvas, 0, 0, ov.w, ov.h, mx0, my0, ov.w / ov.s * z, ov.h / ov.s * z);
      if (cache.prevBi !== null && cache.prevBi !== bi) for (const t of cache.tiles.values()) if (t.bi === cache.prevBi && !t.dirty) blit(t);
    }
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = cache.tiles.get(tileKey(bi, tx, ty));
      if (t) blit(t);
    }
    const ccx = (wx0 + wx1) / 2 * S / TILE - 0.5, ccy = (wy0 + wy1) / 2 * S / TILE - 0.5;
    need.sort((a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0) || Math.hypot(a.tx - ccx, a.ty - ccy) - Math.hypot(b.tx - ccx, b.ty - ccy));
    // out-of-date tiles keep showing until a frame has time for them; a missing tile is drawn at least one per frame
    let done = 0;
    while (need.length && (now() - t0 < budget || (done === 0 && need[0].fresh))) {
      let t = need.shift();
      if (t.fresh) t = cache._newTile(t.bi, t.tx, t.ty, t.key);
      cache._renderTile(t);
      t.used = frame;
      blit(t);
      done++;
    }
    if (!need.length && now() - t0 < budget * 0.5) {
      outer: for (let ring = 1; ring <= 1; ring++) {
        for (let ty = ty0 - ring; ty <= ty1 + ring; ty++) for (let tx = tx0 - ring; tx <= tx1 + ring; tx++) {
          if (tx < 0 || ty < 0 || tx >= ntx || ty >= nty) continue;
          if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) continue;
          const key = tileKey(bi, tx, ty);
          let t = cache.tiles.get(key);
          if (t && !t.dirty) { t.used = frame; continue; }
          if (!t) t = cache._newTile(bi, tx, ty, key);
          cache._renderTile(t);
          t.used = frame;
          if (now() - t0 > budget * 0.6) break outer;
        }
      }
    }
    const ovs = cache.overviews.get(cache.style.key);
    if (ovs && ovs.drawn && (ovs.rects.length || ovs.todo.length) && now() - t0 < budget * 0.5) cache._overview(t0, budget * 0.7, fxm, fym);
    const vis = (tx1 - tx0 + 3) * (ty1 - ty0 + 3);
    cache.maxTiles = Math.max(64, Math.min(Math.ceil(vis * 2.2), 360));
    cache._evict(frame);
  }
  ctx.restore();

  const sm = stagePolyOf(map, opts.stageMask ?? opts.stage);
  if (opts.allStages && map.levels) {
    ctx.save();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = pal.ink3;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    for (const lv of map.levels) {
      if (!lv.p || lv.p === sm) continue;
      ctx.beginPath();
      pathDevice(ctx, lv.p, z, offX, offY);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (sm instanceof Uint8Array) {
    if (opts.dimOutside !== false && grid) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      const mc = maskCanvas(sm, grid, pal);
      ctx.drawImage(mc, mx0, my0, grid.gw * grid.cell * z, grid.gh * grid.cell * z);
      ctx.restore();
    }
  } else if (sm && sm.length >= 6) {
    ctx.save();
    if (opts.dimOutside !== false) {
      ctx.beginPath();
      ctx.rect(mx0, my0, mx1 - mx0, my1 - my0);
      pathDevice(ctx, sm, z, offX, offY);
      ctx.fillStyle = pal.outsideDim;
      ctx.fill('evenodd');
      usePattern(ctx, cache.style.pats.hatch, mx0, my0);
      ctx.fill('evenodd');
    }
    if (opts.stageLine !== false) {
      ctx.beginPath();
      pathDevice(ctx, sm, z, offX, offY);
      ctx.save();
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 12 * dpr;
      ctx.strokeStyle = pal.stageBand;
      ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 1.7 * dpr;
      ctx.strokeStyle = pal.stageLine;
      ctx.setLineDash([13 * dpr, 3.5 * dpr, 2.5 * dpr, 3.5 * dpr]);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (showFrame) drawFrame(ctx, map, cache, pal, dpr, z, offX, offY, VX0, VY0, VX1, VY1);
  if (opts.hover != null) drawHover(ctx, map, cache, pal, dpr, z, offX, offY, opts.hover);
  ctx.restore();

  const ms = now() - t0;
  cache.stats.pending = need.length;
  cache.stats.ms = ms;
  cache.stats.tiles = cache.tiles.size;
  return { pending: need.length, rendered: cache.stats.rendered, ms };
}

function drawFrame(ctx, map, cache, pal, dpr, z, offX, offY, VX0, VY0, VX1, VY1) {
  const G = cache.gridStep;
  const mx0 = -offX, my0 = -offY, mx1 = map.w * z - offX, my1 = map.h * z - offY;
  const bw = 5 * dpr;
  ctx.save();
  ctx.lineWidth = 1 * dpr;
  const nx = Math.ceil(map.w / G), ny = Math.ceil(map.h / G);
  ctx.fillStyle = pal.ink;
  for (let k = 0; k < nx; k++) {
    if (k % 2) continue;
    const a = k * G * z - offX, b = Math.min(map.w, (k + 1) * G) * z - offX;
    if (b < VX0 || a > VX1) continue;
    ctx.fillRect(a, my0 - bw, b - a, bw);
    ctx.fillRect(a, my1, b - a, bw);
  }
  for (let k = 0; k < ny; k++) {
    if (k % 2) continue;
    const a = k * G * z - offY, b = Math.min(map.h, (k + 1) * G) * z - offY;
    if (b < VY0 || a > VY1) continue;
    ctx.fillRect(mx0 - bw, a, bw, b - a);
    ctx.fillRect(mx1, a, bw, b - a);
  }
  ctx.strokeStyle = pal.ink;
  ctx.strokeRect(Math.round(mx0) - 0.5 * dpr, Math.round(my0) - 0.5 * dpr, Math.round(mx1 - mx0) + dpr, Math.round(my1 - my0) + dpr);
  ctx.strokeRect(Math.round(mx0 - bw) - 0.5 * dpr, Math.round(my0 - bw) - 0.5 * dpr, Math.round(mx1 - mx0 + 2 * bw) + dpr, Math.round(my1 - my0 + 2 * bw) + dpr);
  const o2 = bw + 4 * dpr;
  ctx.lineWidth = 0.75 * dpr;
  ctx.strokeRect(mx0 - o2, my0 - o2, mx1 - mx0 + 2 * o2, my1 - my0 + 2 * o2);
  if (G * z >= 26 * dpr) {
    ctx.fillStyle = pal.ink2;
    ctx.font = `600 ${Math.round(10 * dpr)}px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < nx; k++) {
      const c = (k * G + Math.min(map.w, (k + 1) * G)) / 2 * z - offX;
      if (c < VX0 - 20 || c > VX1 + 20) continue;
      const lab = colLabel(k);
      ctx.fillText(lab, c, my0 - o2 - 9 * dpr);
      ctx.fillText(lab, c, my1 + o2 + 9 * dpr);
    }
    for (let k = 0; k < ny; k++) {
      const c = (k * G + Math.min(map.h, (k + 1) * G)) / 2 * z - offY;
      if (c < VY0 - 20 || c > VY1 + 20) continue;
      ctx.fillText(String(k + 1), mx0 - o2 - 11 * dpr, c);
      ctx.fillText(String(k + 1), mx1 + o2 + 11 * dpr, c);
    }
  }
  ctx.restore();
}

function drawHover(ctx, map, cache, pal, dpr, z, offX, offY, hv) {
  let b = -1, road = -1;
  if (typeof hv === 'number') b = hv;
  else if (hv) {
    if (hv.b != null) b = hv.b;
    else if (hv.building != null) b = hv.building;
    if (hv.road != null) road = hv.road;
    else if (hv.bridge != null) {
      const j = cache.brId.indexOf(hv.bridge);
      road = j >= 0 ? cache.bridgeRoads[j] : -1;
    }
  }
  ctx.save();
  ctx.lineJoin = 'miter';
  if (b >= 0 && b < cache.nb) {
    const p = map.buildings[b].p;
    ctx.beginPath();
    pathDevice(ctx, p, z, offX, offY);
    ctx.fillStyle = pal.hover;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = pal.hoverHalo;
    ctx.stroke();
    ctx.lineWidth = 1.8 * dpr;
    ctx.strokeStyle = pal.hover;
    ctx.stroke();
  }
  if (road >= 0 && road < cache.nr) {
    const p = map.roads[road].p;
    ctx.beginPath();
    ctx.moveTo(p[0] * z - offX, p[1] * z - offY);
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k] * z - offX, p[k + 1] * z - offY);
    const w = cache.rw[road] * z;
    ctx.lineCap = 'butt';
    ctx.lineWidth = w + 8 * dpr;
    ctx.strokeStyle = pal.hover;
    ctx.stroke();
    ctx.lineWidth = w + 4.5 * dpr;
    ctx.strokeStyle = pal.hoverHalo;
    ctx.stroke();
  }
  ctx.restore();
}

// Topmost alive building containing (x, y), or -1.
export function pickBuilding(map, x, y, includeDead = false) {
  const c = getStaticCache(map);
  if (x < 0 || y < 0 || x > map.w || y > map.h) return -1;
  const cell = clamp(Math.floor(y / IDX), 0, c.ih - 1) * c.iw + clamp(Math.floor(x / IDX), 0, c.iw - 1);
  const { start, items } = c.bIdx, bb = c.bb;
  let best = -1;
  for (let k = start[cell]; k < start[cell + 1]; k++) {
    const i = items[k];
    if (x < bb[i * 4] || x > bb[i * 4 + 2] || y < bb[i * 4 + 1] || y > bb[i * 4 + 3]) continue;
    if (!includeDead && !c.bAlive[i]) continue;
    if (i > best && pointInPoly(map.buildings[i].p, x, y)) best = i;
  }
  return best;
}

// Bridge road under (x, y) within tol metres: { road, id (grid bridge id or -1), alive } or null.
export function pickBridge(map, x, y, tol = 2) {
  const c = getStaticCache(map);
  for (let j = 0; j < c.bridgeRoads.length; j++) {
    const b = c.brBox;
    if (x < b[j * 4] || x > b[j * 4 + 2] || y < b[j * 4 + 1] || y > b[j * 4 + 3]) continue;
    const r = c.bridgeRoads[j];
    if (distToPolyline(map.roads[r].p, x, y) <= c.rw[r] / 2 + tol) return { road: r, id: c.brId[j], alive: c.brAlive[j] === 1 };
  }
  return null;
}

// ---------------- minimap ----------------

export function minimapTransform(map, w, h, pad = 3) {
  const s = Math.min((w - 2 * pad) / map.w, (h - 2 * pad) / map.h);
  const ox = (w - map.w * s) / 2, oy = (h - map.h * s) / 2;
  return {
    s, ox, oy,
    toWorld: (mx, my) => [(mx - ox) / s, (my - oy) / s],
    toMini: (x, y) => [ox + x * s, oy + y * s],
  };
}

const POLY_IDS = new WeakMap();
let polyIdSeq = 0;
function polyKey(p) {
  if (p == null) return 'none';
  if (typeof p === 'number') return 'L' + p;
  if (typeof p !== 'object') return 'none';
  let id = POLY_IDS.get(p);
  if (!id) { id = ++polyIdSeq; POLY_IDS.set(p, id); }
  return 'P' + id;
}

// Draws a cached minimap into (0,0)-(w,h) of ctx's current CSS-pixel space; returns minimapTransform.
// opts: { palette, stage (as drawStatic stageMask), camera (draws the view box), grid, cache }
export function drawMinimap(ctx, map, w, h, opts = {}) {
  const cache = opts.cache || getStaticCache(map, opts.grid);
  if (opts.grid !== undefined && (opts.grid || null) !== cache.grid) cache.setGrid(opts.grid);
  const pal = getPalette(opts.palette || map.palette);
  const dpr = ctx.getTransform().a || 1;
  const T = minimapTransform(map, w, h);
  const stageRaw = opts.stage ?? opts.stageMask;
  const sm = stagePolyOf(map, stageRaw);
  const key = `${w}x${h}@${dpr}|${pal.name}|${polyKey(typeof stageRaw === 'number' ? stageRaw : sm)}`;
  let mm = cache.minimap;
  const t = now();
  // damage redraws wait at least 40 times as long as the last redraw took (big sheets: about a second)
  if (!mm || mm.key !== key || (mm.version !== cache.version && t - mm.t > Math.max(400, (mm.ms || 0) * 40))) {
    mm = cache.minimap = renderMinimap(map, cache, pal, w, h, dpr, T, sm);
    mm.key = key;
    mm.version = cache.version;
    mm.t = now();
    mm.ms = mm.t - t;
  }
  ctx.drawImage(mm.canvas, 0, 0, w, h);
  if (opts.camera) {
    const cam = opts.camera;
    const [a, b] = T.toMini(cam.x, cam.y);
    const [c, d] = T.toMini(cam.x + cam.w / cam.zoom, cam.y + cam.h / cam.zoom);
    const x0 = clamp(a, 0, w), y0 = clamp(b, 0, h), x1 = clamp(c, 0, w), y1 = clamp(d, 0, h);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.card;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = pal.stamp;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }
  return T;
}

function renderMinimap(map, cache, pal, w, h, dpr, T, sm) {
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
  const canvas = makeCanvas(cw, ch), g = canvas.getContext('2d');
  g.fillStyle = pal.paper2;
  g.fillRect(0, 0, cw, ch);
  const s = T.s * dpr, ox = T.ox * dpr, oy = T.oy * dpr;
  g.fillStyle = pal.paper;
  g.fillRect(ox, oy, map.w * s, map.h * s);
  g.setTransform(s, 0, 0, s, ox, oy);
  const fillPolys = (list, col) => {
    if (!list || !list.length) return;
    g.beginPath();
    for (const o of list) polyTo(g, o.p);
    g.fillStyle = col;
    g.fill();
  };
  fillPolys(map.parks, pal.park);
  fillPolys(map.water, pal.water);
  const R = map.roads || [];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const kind of [RK.minor, RK.major, RK.rail, RK.bridge]) {
    g.beginPath();
    let any = false;
    for (let r = 0; r < R.length; r++) if (cache.rk[r] === kind && (kind !== RK.bridge || cache.brAlive[cache.bridgeRoads.indexOf(r)])) { lineTo(g, R[r].p); any = true; }
    if (!any) continue;
    const devW = kind === RK.major ? Math.max(1.6 * dpr, 12 * s) : kind === RK.minor ? Math.max(0.7 * dpr, 6 * s) : 1.1 * dpr;
    g.lineWidth = devW / s;
    g.strokeStyle = kind === RK.rail ? pal.rail : kind === RK.major ? pal.majorCasing : pal.roadCasing;
    g.stroke();
  }
  const B = map.buildings || [];
  if (B.length) {
    g.fillStyle = mix(pal.building, pal.ink2, 0.35);
    g.beginPath();
    const bb = cache.bb, tiny = 1.2 / s;
    let n = 0;
    for (let i = 0; i < B.length; i++) {
      if (!cache.bAlive[i]) continue;
      const x0 = bb[i * 4], y0 = bb[i * 4 + 1], x1 = bb[i * 4 + 2], y1 = bb[i * 4 + 3];
      if (x1 - x0 < tiny && y1 - y0 < tiny) g.rect(x0, y0, Math.max(x1 - x0, tiny * 0.6), Math.max(y1 - y0, tiny * 0.6));
      else polyTo(g, B[i].p);
      if (++n % CHUNK === 0) { g.fill(); g.beginPath(); }
    }
    g.fill();
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (sm && !(sm instanceof Uint8Array) && sm.length >= 6) {
    g.beginPath();
    g.rect(ox, oy, map.w * s, map.h * s);
    g.moveTo(sm[0] * s + ox, sm[1] * s + oy);
    for (let k = 2; k < sm.length; k += 2) g.lineTo(sm[k] * s + ox, sm[k + 1] * s + oy);
    g.closePath();
    g.fillStyle = pal.outsideDim;
    g.fill('evenodd');
    g.beginPath();
    g.moveTo(sm[0] * s + ox, sm[1] * s + oy);
    for (let k = 2; k < sm.length; k += 2) g.lineTo(sm[k] * s + ox, sm[k + 1] * s + oy);
    g.closePath();
    g.lineWidth = 1.2 * dpr;
    g.strokeStyle = pal.stageLine;
    g.setLineDash([5 * dpr, 2 * dpr]);
    g.stroke();
    g.setLineDash([]);
  }
  g.lineWidth = dpr;
  g.strokeStyle = pal.ink;
  g.strokeRect(ox + 0.5, oy + 0.5, map.w * s - 1, map.h * s - 1);
  return { canvas };
}

// Scale bar with alternating ink/paper segments at (x, y) CSS px (bottom-left anchor) in the ctx's CSS space.
export function drawScaleBar(ctx, camera, opts = {}) {
  const pal = getPalette(opts.palette);
  const x = opts.x ?? 16, y = opts.y ?? camera.h - 16, maxPx = opts.maxPx ?? 160;
  const metres = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  let m = metres[0];
  for (const v of metres) if (v * camera.zoom <= maxPx) m = v;
  const L = m * camera.zoom, seg = L / 4;
  ctx.save();
  ctx.lineWidth = 1;
  for (let k = 0; k < 4; k++) {
    ctx.fillStyle = k % 2 ? pal.card : pal.ink;
    ctx.fillRect(x + k * seg, y - 5, seg, 5);
  }
  ctx.strokeStyle = pal.ink;
  ctx.strokeRect(x + 0.5, y - 5.5, L, 5);
  ctx.fillStyle = pal.ink;
  ctx.font = `500 10px ${FONT_MONO}`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('0', x - 2, y - 8);
  ctx.textAlign = 'right';
  ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x + L + 4, y - 8);
  ctx.restore();
  return L;
}
