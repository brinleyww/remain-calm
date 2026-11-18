// Stage growth: the out-of-bounds shading recedes from the old outline to the new one, a plotter pen re-inks the
// boundary, the camera eases out in step, new residents fade in, then a stamp and a typed line announce it.
// Render-only: it reads the world but never changes it and runs on real frame time, so co-op peers animate locally.
import { ease } from './camera.js';

const T = { morph: 1.4, oldOut: 0.45, pen0: 0.2, pen: 1.4, lag: 0.12, stamp: 1.2, type0: 1.32, type: 0.55, out: 2.1, end: 2.45 };
const RT = { fade: 0.45, out: 1.5, end: 1.85 };
const CAP = 640;
const FRONTS = 4;
// destination-out alpha per reveal front (newest first): leaves 0, 25, 50 and 75 % opacity bands behind the front
const ERASE = [1, 0.5, 1 / 3, 0.25];
const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'Escape']);
const DASH = [13, 3.5, 2.5, 3.5];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));

export function reducedMotion(prefs) {
  try {
    if (prefs && prefs.get().reduceMotion) return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { return false; }
}

export class Expand {
  // s: the Session (after world.beginStage); fromPoly: the previous stage outline; onDone runs when it ends or is skipped.
  constructor(s, fromPoly, onDone) {
    this.s = s;
    this.onDone = onDone;
    this.active = true;
    this.t = 0;
    this.from = fromPoly;
    this.to = s.world.region.poly;
    this.reduced = reducedMotion(s.prefs);
    this.camSec = this.reduced ? 0 : T.morph;
    this.cues = new Set();
    this.typed = -1;
    this._oc = null;
    this._drew = false;
    this._ft = new Float64Array(FRONTS).fill(-1);
    if (this.reduced) this.snap = copyCanvas(s.canvas);
    else {
      let m = null;
      try { m = buildMorph(fromPoly, this.to); } catch (e) { m = null; }
      this.morph = m;
      this.fronts = m ? Array.from({ length: FRONTS }, () => new Float64Array(m.n * 2)) : null;
      this.pen = penOf(this.to);
      this.fromOk = !!fromPoly && fromPoly.length >= 6;
      s.sfx('expand', 0.5);
    }
    this.buildDom();
    this._key = (e) => {
      if (!SKIP_KEYS.has(e.code) || typing(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) this.skip();
    };
    this._down = (e) => {
      const onMap = e.target === s.canvas;
      this.skip();
      if (!onMap) return;
      e.stopPropagation();
      const eat = (u) => { if (u.pointerId === e.pointerId) { u.stopPropagation(); window.removeEventListener('pointerup', eat, true); } };
      window.addEventListener('pointerup', eat, true);
      setTimeout(() => window.removeEventListener('pointerup', eat, true), 3000);
    };
    window.addEventListener('keydown', this._key, true);
    if (s.root) s.root.addEventListener('pointerdown', this._down, true);
  }

  buildDom() {
    const s = this.s, w = s.world;
    if (!s.root || typeof document === 'undefined') return;
    const el = this.el = document.createElement('div');
    el.className = 'rc-expand' + (this.reduced ? ' is-still' : '');
    el.setAttribute('aria-live', 'polite');
    const stamp = this.stampEl = document.createElement('span');
    stamp.className = 'stamp stamp-lg tilt-1';
    stamp.textContent = 'Area extended';
    const line = this.lineEl = document.createElement('p');
    line.className = 'rc-expand-line';
    this.typedEl = document.createElement('span');
    this.restEl = document.createElement('span');
    this.restEl.className = 'rest';
    line.append(this.typedEl, this.restEl);
    el.append(stamp, line);
    this.text = announceText(w, this.from);
    this.restEl.textContent = this.text;
    this.place();
    s.root.append(el);
  }

  place() {
    if (!this.el) return;
    const v = this.s.viewRect();
    const l = Math.round(v.x + v.w / 2) + 'px', t = Math.round(v.y + v.h * 0.42) + 'px';
    if (this.el.style.left !== l) this.el.style.left = l;
    if (this.el.style.top !== t) this.el.style.top = t;
  }

  cue(name) { if (this.cues.has(name)) return false; this.cues.add(name); return true; }

  // Called once per frame with the same capped dt the camera gets, so the morph and the flight stay in step.
  update(real) {
    if (!this.active) return;
    this.t += real;
    const t = this.t, R = this.reduced;
    this.place();
    if (t >= (R ? 0 : T.stamp) && this.cue('stamp')) {
      if (this.stampEl) this.stampEl.classList.add('is-on');
      this.s.sfx('stamp', 0.55);
    }
    const t0 = R ? 0 : T.type0;
    if (t >= t0 && this.lineEl) {
      const n = this.text.length;
      const k = R ? n : Math.min(n, Math.floor((t - t0) / T.type * n));
      if (k !== this.typed) {
        if (this.typed < 0) this.lineEl.classList.add('is-on');
        if (!R && k > this.typed && /\S/.test(this.text.slice(Math.max(0, this.typed), k))) this.s.sfx('clack', 0.22);
        this.typed = k;
        this.typedEl.textContent = this.text.slice(0, k);
        this.restEl.textContent = this.text.slice(k);
        this.lineEl.classList.toggle('is-typing', k < n);
        if (k >= n && !R) this.s.sfx('bell', 0.3);
      }
    }
    if (t >= (R ? RT.out : T.out) && this.cue('out') && this.el) this.el.classList.add('is-out');
    if (t >= (R ? RT.end : T.end)) this.finish();
  }

  skip() {
    if (!this.active) return;
    this.s.cam.finishFlight();
    this.finish();
  }

  finish() {
    if (!this.active) return;
    this.cancel();
    if (this.onDone) this.onDone();
  }

  // Removes everything at once (retry, clear stage, quit): no callback.
  cancel() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this._key, true);
    if (this.s.root) this.s.root.removeEventListener('pointerdown', this._down, true);
    if (this.el) this.el.remove();
    this.el = null;
    this._oc = null;
    this.snap = null;
  }

  e(k) { return ease(clamp01((this.t - k * T.lag) / T.morph)); }

  front(k) {
    const out = this.fronts[k];
    if (this._ft[k] === this.t) return out;
    this._ft[k] = this.t;
    const m = this.morph, e = this.e(k);
    for (let i = 0, n = m.n; i < n; i++) {
      out[2 * i] = m.ax[i] + m.dx[i] * e;
      out[2 * i + 1] = m.ay[i] + m.dy[i] * e;
    }
    return out;
  }

  // Polygon for the out-of-bounds shading this frame.
  mask() {
    if (this.reduced || !this.morph || this.e(0) >= 1) return this.to;
    return this.front(0);
  }

  // True once the pen has finished: the static renderer then draws the boundary line itself.
  get lineDone() { return this.reduced || this.t >= T.pen0 + T.pen; }

  // After the static map, before the world layer. Returns the context the world layer should draw into.
  beginWorld(ctx) {
    this._drew = false;
    if (this.reduced) return ctx;
    const s = this.s, cam = s.cam, dpr = s.dpr || 1, pal = s.pal;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ko = 1 - clamp01(this.t / T.oldOut);
    if (ko > 0 && this.fromOk) { ctx.globalAlpha = ko; inkBoundary(ctx, cam, this.from, pal, null, Infinity); ctx.globalAlpha = 1; }
    if (!this.lineDone && this.pen) {
      const k = ease(clamp01((this.t - T.pen0) / T.pen));
      this.tip = k > 0 ? inkBoundary(ctx, cam, this.to, pal, this.pen, k * this.pen.L) : null;
    } else this.tip = null;
    ctx.restore();
    if (!this.morph || this.e(FRONTS - 1) >= 1) return ctx;
    const W = s.canvas.width, H = s.canvas.height;
    if (!this._oc) this._oc = document.createElement('canvas');
    const oc = this._oc;
    if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
    const g = oc.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    this._drew = true;
    return g;
  }

  // After the world layer: fades the residents outside the old outline behind the reveal fronts, then the pen nib.
  endWorld(ctx) {
    const s = this.s, cam = s.cam, dpr = s.dpr || 1;
    if (this._drew && this._oc) {
      const oc = this._oc, g = oc.getContext('2d'), W = oc.width, H = oc.height, k = cam.zoom * dpr;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); polyPath(g, this.to, cam, k); g.clip();
      g.beginPath(); g.rect(0, 0, W, H); polyPath(g, this.from, cam, k); g.clip('evenodd');
      g.fillStyle = '#000';
      for (let f = FRONTS - 1; f >= 0; f--) {
        if (this.e(f) >= 1) continue;
        g.globalAlpha = ERASE[f];
        g.beginPath(); g.rect(0, 0, W, H); polyPath(g, this.front(f), cam, k);
        g.fill('evenodd');
      }
      g.restore();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(oc, 0, 0);
      ctx.restore();
      this._drew = false;
    }
    if (this.reduced && this.snap) {
      const a = 1 - clamp01(this.t / RT.fade);
      if (a > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = a;
        ctx.drawImage(this.snap, 0, 0);
        ctx.restore();
      } else this.snap = null;
    }
    if (this.tip) drawNib(ctx, this.tip[0], this.tip[1], s.pal, dpr);
  }
}

function announceText(w, fromPoly) {
  const parts = [`Stage ${w.stage + 1} of ${w.stageCount}`];
  const label = w.region && w.region.label;
  if (label && !/^stage\s*\d+$/i.test(label)) parts.push(label);
  const before = fromPoly && fromPoly.length >= 6 ? Math.abs(area2(fromPoly)) / 2 : 0;
  const grow = ((w.region.areaM2 || 0) - before) / 1e6;
  if (grow > 0.005) parts.push(`+${grow.toFixed(2)} km²`);
  const civ = w.stats && w.stats.civStart;
  if (civ > 0) parts.push(`${Math.round(civ).toLocaleString('en-US')} residents`);
  return parts.join(' · ').toUpperCase();
}

function copyCanvas(src) {
  if (!src || typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- drawing

function polyPath(g, p, cam, k) {
  const ox = cam.x, oy = cam.y;
  g.moveTo((p[0] - ox) * k, (p[1] - oy) * k);
  for (let i = 2; i < p.length; i += 2) g.lineTo((p[i] - ox) * k, (p[i + 1] - oy) * k);
  g.closePath();
}

// Outline as far as arc length `upto` (the whole closed outline when pen is null), in CSS px. Returns the tip point.
function partialPath(g, p, cam, pen, upto) {
  const z = cam.zoom, ox = cam.x, oy = cam.y, n = p.length >> 1;
  g.moveTo((p[0] - ox) * z, (p[1] - oy) * z);
  if (!pen || upto >= pen.L) {
    for (let i = 1; i < n; i++) g.lineTo((p[2 * i] - ox) * z, (p[2 * i + 1] - oy) * z);
    g.closePath();
    return null;
  }
  const cum = pen.cum;
  for (let i = 1; i <= n; i++) {
    const j = i % n, x = (p[2 * j] - ox) * z, y = (p[2 * j + 1] - oy) * z;
    if (cum[i] <= upto) { g.lineTo(x, y); continue; }
    const q = (i - 1) % n, seg = cum[i] - cum[i - 1], f = seg > 0 ? (upto - cum[i - 1]) / seg : 0;
    const px = (p[2 * q] - ox) * z, py = (p[2 * q + 1] - oy) * z;
    const tx = px + (x - px) * f, ty = py + (y - py) * f;
    g.lineTo(tx, ty);
    return [tx, ty];
  }
  return null;
}

// Same band and dashed line as the static renderer's stage boundary, so the hand-over at the end is seamless.
function inkBoundary(ctx, cam, p, pal, pen, upto) {
  ctx.save();
  ctx.beginPath();
  polyPath(ctx, p, cam, cam.zoom);
  ctx.clip();
  ctx.beginPath();
  partialPath(ctx, p, cam, pen, upto);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 12;
  ctx.strokeStyle = pal.stageBand;
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  const tip = partialPath(ctx, p, cam, pen, upto);
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = pal.stageLine;
  ctx.setLineDash(DASH);
  ctx.stroke();
  ctx.setLineDash([]);
  return tip;
}

function drawNib(ctx, x, y, pal, dpr) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = pal.stageLine;
  ctx.fillStyle = pal.stageLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.moveTo(x - 10, y); ctx.lineTo(x - 7, y);
  ctx.moveTo(x + 7, y); ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 7);
  ctx.moveTo(x, y + 7); ctx.lineTo(x, y + 10);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- outline morph

function penOf(p) {
  if (!p || p.length < 6) return null;
  const n = p.length >> 1, cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = (i - 1) % n, b = i % n;
    cum[i] = cum[i - 1] + Math.hypot(p[2 * b] - p[2 * a], p[2 * b + 1] - p[2 * a + 1]);
  }
  return cum[n] > 0 ? { cum, L: cum[n] } : null;
}

function clean(p) {
  const out = [];
  for (let i = 0; i + 1 < p.length; i += 2) {
    const x = +p[i], y = +p[i + 1], n = out.length;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (n && Math.abs(out[n - 2] - x) < 1e-6 && Math.abs(out[n - 1] - y) < 1e-6) continue;
    out.push(x, y);
  }
  while (out.length >= 6 && Math.abs(out[0] - out[out.length - 2]) < 1e-6 && Math.abs(out[1] - out[out.length - 1]) < 1e-6) out.length -= 2;
  return out;
}

function area2(p) {
  let s = 0;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) s += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
  return s;
}

function perimeter(p) {
  let L = 0;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) L += Math.hypot(p[2 * i] - p[2 * j], p[2 * i + 1] - p[2 * j + 1]);
  return L;
}

function reversed(p) {
  const out = new Array(p.length), n = p.length >> 1;
  for (let i = 0; i < n; i++) { out[2 * i] = p[2 * (n - 1 - i)]; out[2 * i + 1] = p[2 * (n - 1 - i) + 1]; }
  return out;
}

// k points evenly spaced by arc length from vertex 0.
function uniform(p, k) {
  const n = p.length >> 1, L = perimeter(p), out = new Float64Array(2 * k);
  let i = 0, acc = 0, seg = Math.hypot(p[2] - p[0], p[3] - p[1]);
  for (let q = 0; q < k; q++) {
    const s = (q / k) * L;
    while (acc + seg < s && i < n - 1) { acc += seg; i++; const j = (i + 1) % n; seg = Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]); }
    const j = (i + 1) % n, f = seg > 0 ? (s - acc) / seg : 0;
    out[2 * q] = p[2 * i] + (p[2 * j] - p[2 * i]) * f;
    out[2 * q + 1] = p[2 * i + 1] + (p[2 * j + 1] - p[2 * i + 1]) * f;
  }
  return out;
}

// Every original vertex plus evenly spaced points along each edge (spacing h), with each point's arc position.
function densify(p, h) {
  const n = p.length >> 1;
  if (n >= CAP) {
    const u = uniform(p, CAP), L = perimeter(p), s = new Float64Array(CAP);
    for (let q = 0; q < CAP; q++) s[q] = (q / CAP) * L;
    return { p: u, s, L };
  }
  let count;
  for (;;) {
    count = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; count += Math.max(1, Math.ceil(Math.hypot(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]) / h)); }
    if (count <= CAP) break;
    h *= 1.25;
  }
  const out = new Float64Array(2 * count), s = new Float64Array(count);
  let q = 0, acc = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
    const len = Math.hypot(bx - ax, by - ay), k = Math.max(1, Math.ceil(len / h));
    for (let m = 0; m < k; m++) {
      out[2 * q] = ax + (bx - ax) * (m / k);
      out[2 * q + 1] = ay + (by - ay) * (m / k);
      s[q++] = acc + len * (m / k);
    }
    acc += len;
  }
  return { p: out, s, L: acc };
}

// Monotone point correspondence between two closed outlines (dynamic time warping on the densified outlines,
// started from the best rotation of evenly resampled copies). Shared edges map onto themselves and stay put.
export function buildMorph(fromPoly, toPoly) {
  let A = clean(fromPoly || []);
  const B = clean(toPoly || []);
  if (A.length < 6 || B.length < 6) return null;
  if (Math.sign(area2(A)) !== Math.sign(area2(B))) A = reversed(A);
  const LA = perimeter(A), LB = perimeter(B);
  if (!(LA > 0 && LB > 0)) return null;
  const K = 96, ua = uniform(A, K), ub = uniform(B, K);
  let best = Infinity, bo = 0;
  for (let o = 0; o < K; o++) {
    let sum = 0;
    for (let i = 0; i < K && sum < best; i++) {
      const j = ((i + o) % K) * 2, dx = ua[j] - ub[2 * i], dy = ua[j + 1] - ub[2 * i + 1];
      sum += dx * dx + dy * dy;
    }
    if (sum < best) { best = sum; bo = o; }
  }
  const h = Math.max(LA, LB) / 300;
  const da = densify(A, h), db = densify(B, h);
  const target = (bo / K) * da.L, na = da.s.length;
  let si = 0, sd = Infinity;
  for (let i = 0; i < na; i++) {
    const d = Math.abs(da.s[i] - target), c = Math.min(d, da.L - d);
    if (c < sd) { sd = c; si = i; }
  }
  const a = new Float64Array(2 * na);
  for (let i = 0; i < na; i++) { const j = (i + si) % na; a[2 * i] = da.p[2 * j]; a[2 * i + 1] = da.p[2 * j + 1]; }
  const b = db.p, m = na, n = b.length >> 1;
  const D = new Float32Array(m * n);
  for (let i = 0; i < m; i++) {
    const ax = a[2 * i], ay = a[2 * i + 1], r = i * n, rp = r - n;
    for (let j = 0; j < n; j++) {
      const dx = ax - b[2 * j], dy = ay - b[2 * j + 1], c = Math.sqrt(dx * dx + dy * dy);
      let prev;
      if (i === 0) prev = j === 0 ? 0 : D[j - 1];
      else if (j === 0) prev = D[rp];
      else { const dg = D[rp + j - 1], up = D[rp + j], lf = D[r + j - 1]; prev = dg <= up && dg <= lf ? dg : up < lf ? up : lf; }
      D[r + j] = c + prev;
    }
  }
  const pi = [], pj = [];
  let i = m - 1, j = n - 1;
  for (;;) {
    pi.push(i); pj.push(j);
    if (i === 0 && j === 0) break;
    if (i === 0) j--;
    else if (j === 0) i--;
    else {
      const dg = D[(i - 1) * n + j - 1], up = D[(i - 1) * n + j], lf = D[i * n + j - 1];
      if (dg <= up && dg <= lf) { i--; j--; } else if (up < lf) i--; else j--;
    }
  }
  const N = pi.length, ax = new Float64Array(N), ay = new Float64Array(N), dx = new Float64Array(N), dy = new Float64Array(N);
  for (let q = 0; q < N; q++) {
    const u = pi[N - 1 - q], v = pj[N - 1 - q];
    ax[q] = a[2 * u]; ay[q] = a[2 * u + 1];
    dx[q] = b[2 * v] - ax[q]; dy[q] = b[2 * v + 1] - ay[q];
  }
  return { n: N, ax, ay, dx, dy };
}
