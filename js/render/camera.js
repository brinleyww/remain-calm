// 2D map camera. (x, y) is the world point (metres) at the viewport's top-left corner,
// zoom is CSS px per metre, w/h is the viewport size in CSS px. Screen = (world - xy) * zoom.

import { clamp } from '../util/geom.js';

export const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Camera {
  constructor(o = {}) {
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.zoom = o.zoom ?? 1;
    this.w = o.w ?? 800;
    this.h = o.h ?? 600;
    this.maxZoom = o.maxZoom ?? 16;
    this._minZoom = o.minZoom ?? null;
    this.minZoomFit = o.minZoomFit ?? 0.6;   // auto min zoom: bounds fill this fraction of the view
    this.bounds = o.bounds || null;           // [x0, y0, x1, y1] the view centre is kept inside
    this.zoomRate = o.zoomRate ?? 16;         // smoothing speed (1/s) for zoomAtSmooth
    this.version = 0;
    this._tz = null;
    this._ax = 0;
    this._ay = 0;
    this._fly = null;
  }

  get minZoom() {
    if (this._minZoom != null) return this._minZoom;
    if (!this.bounds) return 0.01;
    const [x0, y0, x1, y1] = this.bounds;
    return this.minZoomFit * Math.min(this.w / Math.max(1, x1 - x0), this.h / Math.max(1, y1 - y0));
  }
  set minZoom(v) { this._minZoom = v; }

  get cx() { return this.x + this.w / (2 * this.zoom); }
  get cy() { return this.y + this.h / (2 * this.zoom); }
  get animating() { return this._tz !== null || this._fly !== null; }

  setBounds(x0, y0, x1, y1) { this.bounds = [x0, y0, x1, y1]; this.clamp(); return this; }
  setMap(map) { return this.setBounds(0, 0, map.w, map.h); }

  resize(w, h) {
    const cx = this.cx, cy = this.cy;
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this._centre(cx, cy);
    this.clamp();
    return this;
  }

  toScreenX(wx) { return (wx - this.x) * this.zoom; }
  toScreenY(wy) { return (wy - this.y) * this.zoom; }
  toWorldX(sx) { return this.x + sx / this.zoom; }
  toWorldY(sy) { return this.y + sy / this.zoom; }
  worldToScreen(wx, wy, out = [0, 0]) { out[0] = (wx - this.x) * this.zoom; out[1] = (wy - this.y) * this.zoom; return out; }
  screenToWorld(sx, sy, out = [0, 0]) { out[0] = this.x + sx / this.zoom; out[1] = this.y + sy / this.zoom; return out; }

  // [x0, y0, x1, y1] in metres; marginPx grows it on every side.
  visibleBBox(marginPx = 0, out = [0, 0, 0, 0]) {
    const m = marginPx / this.zoom;
    out[0] = this.x - m;
    out[1] = this.y - m;
    out[2] = this.x + this.w / this.zoom + m;
    out[3] = this.y + this.h / this.zoom + m;
    return out;
  }

  // Drag semantics: the map content moves by (dsx, dsy) screen px.
  pan(dsx, dsy) {
    if (!dsx && !dsy) return this;
    this._fly = null;
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
    this.clamp();
    this.version++;
    return this;
  }

  panWorld(dx, dy) { return this.pan(-dx * this.zoom, -dy * this.zoom); }

  // Keeps the world point under (sx, sy) fixed.
  zoomAt(sx, sy, factor) {
    this._tz = null;
    this._fly = null;
    this._zoomAbout(sx, sy, this.zoom * factor);
    return this;
  }

  setZoom(z, sx = this.w / 2, sy = this.h / 2) { this._tz = null; this._fly = null; this._zoomAbout(sx, sy, z); return this; }

  centerOn(wx, wy, zoom = this.zoom) {
    this._tz = null;
    this._fly = null;
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this._centre(wx, wy);
    this.clamp();
    this.version++;
    return this;
  }

  fitZoom(bbox, padPx = 24, w = this.w, h = this.h) {
    const bw = Math.max(1, bbox[2] - bbox[0]), bh = Math.max(1, bbox[3] - bbox[1]);
    return Math.max(1e-4, Math.min((w - 2 * padPx) / bw, (h - 2 * padPx) / bh));
  }

  // Fit a world bbox [x0,y0,x1,y1] into a w x h viewport (also updates the viewport size).
  fit(bbox, w = this.w, h = this.h, padPx = 24) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this._tz = null;
    this._fly = null;
    this.zoom = clamp(this.fitZoom(bbox, padPx), this.minZoom, this.maxZoom);
    this._centre((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
    this.clamp();
    this.version++;
    return this;
  }

  clamp() {
    const z = clamp(this.zoom, this.minZoom, this.maxZoom);
    if (z !== this.zoom) {
      const cx = this.cx, cy = this.cy;
      this.zoom = z;
      this._centre(cx, cy);
    }
    if (this.bounds) {
      const [x0, y0, x1, y1] = this.bounds;
      const cx = clamp(this.cx, x0, x1), cy = clamp(this.cy, y0, y1);
      this._centre(cx, cy);
    }
    return this;
  }

  // ---- smooth helpers: call update(dt) every frame ----

  zoomAtSmooth(sx, sy, factor) {
    this._fly = null;
    const base = this._tz ?? this.zoom;
    this._tz = clamp(base * factor, this.minZoom, this.maxZoom);
    this._ax = sx;
    this._ay = sy;
    return this;
  }

  // Mouse wheel convenience. deltaMode: 0 px, 1 lines, 2 pages (WheelEvent.deltaMode).
  wheel(deltaY, sx, sy, deltaMode = 0, smooth = true) {
    const d = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
    const f = clamp(Math.exp(-d * 0.0018), 0.5, 2);
    return smooth ? this.zoomAtSmooth(sx, sy, f) : this.zoomAt(sx, sy, f);
  }

  flyTo(wx, wy, zoom = this.zoom, sec = 0.5) {
    this._tz = null;
    zoom = clamp(zoom, this.minZoom, this.maxZoom);
    if (sec <= 0) return this.centerOn(wx, wy, zoom);
    this._fly = { x0: this.cx, y0: this.cy, z0: this.zoom, x1: wx, y1: wy, z1: zoom, t: 0, dur: sec };
    return this;
  }

  fitSmooth(bbox, padPx = 24, sec = 0.5) {
    const z = this.fitZoom(bbox, padPx);
    return this.flyTo((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, z, sec);
  }

  stop() { this._tz = null; this._fly = null; return this; }

  // Jumps a flight in progress to its destination.
  finishFlight() { const f = this._fly; if (f) this.centerOn(f.x1, f.y1, f.z1); return this; }

  // Advances smooth zoom / flights. Returns true when the view changed.
  update(dt) {
    let moved = false;
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(f.dur, f.t + dt);
      const k = ease(f.t / f.dur);
      this.zoom = Math.exp(Math.log(f.z0) + (Math.log(f.z1) - Math.log(f.z0)) * k);
      this._centre(f.x0 + (f.x1 - f.x0) * k, f.y0 + (f.y1 - f.y0) * k);
      this.clamp();
      if (f.t >= f.dur) this._fly = null;
      this.version++;
      moved = true;
    } else if (this._tz !== null) {
      const k = 1 - Math.exp(-dt * this.zoomRate);
      const lz = Math.log(this.zoom), lt = Math.log(this._tz);
      let nz = Math.exp(lz + (lt - lz) * k);
      if (Math.abs(lt - Math.log(nz)) < 0.003) { nz = this._tz; this._tz = null; }
      this._zoomAbout(this._ax, this._ay, nz);
      moved = true;
    }
    return moved;
  }

  // ctx transform helpers: world space (metres) or screen space (CSS px), both including devicePixelRatio.
  applyWorld(ctx, dpr = 1) {
    const s = this.zoom * dpr;
    ctx.setTransform(s, 0, 0, s, -this.x * s, -this.y * s);
  }
  applyScreen(ctx, dpr = 1) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }

  getState() { return { x: this.cx, y: this.cy, zoom: this.zoom }; }
  setState(s) { if (s) this.centerOn(s.x, s.y, s.zoom); return this; }

  _centre(cx, cy) {
    this.x = cx - this.w / (2 * this.zoom);
    this.y = cy - this.h / (2 * this.zoom);
  }

  _zoomAbout(sx, sy, z) {
    z = clamp(z, this.minZoom, this.maxZoom);
    if (z === this.zoom) { this.clamp(); return; }
    const wx = this.x + sx / this.zoom, wy = this.y + sy / this.zoom;
    this.zoom = z;
    this.x = wx - sx / z;
    this.y = wy - sy / z;
    this.clamp();
    this.version++;
  }
}
