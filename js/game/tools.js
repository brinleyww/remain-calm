// Player tools. Each tool turns pointer/key input into world commands and draws its own preview.
// Every price and validity message comes from world.quote() so the cursor label always matches what exec() will do.
import { pointInPoly, polyPerimeter, clamp, simplify } from '../util/geom.js';
import { pickBuilding, pickBridge } from '../render/maprender.js';
import { drawUnitGlyph } from '../render/worldrender.js';
import { rgba } from '../render/palette.js';

const TAU = Math.PI * 2;
const QUOTE_MS = 50;
const now = () => performance.now();
const money = (v) => (v >= 1e8 ? '$--' : '$' + Math.round(v).toLocaleString('en-US'));

function toScreen(cam, x, y) { return [(x - cam.x) * cam.zoom, (y - cam.y) * cam.zoom]; }

class Tool {
  constructor(s) { this.s = s; this.q = null; this._qt = 0; this._qkey = ''; this.hover = null; }
  get world() { return this.s.world; }
  get cfg() { return this.s.world.cfg; }
  enter() {}
  exit() {}
  down() {}
  move(e) { this.hover = e; }
  up() {}
  dbl() {}
  wheel() { return false; }
  key() { return false; }
  rightClick() { return false; }
  draw() {}
  label() { return null; }
  cursor() { return 'crosshair'; }
  // Throttled quote; `key` identifies the command so a changed target re-quotes immediately.
  quote(cmd, key, force = false) {
    const t = now();
    if (!force && key === this._qkey && t - this._qt < QUOTE_MS) return this.q;
    this._qt = t; this._qkey = key;
    this.q = cmd ? this.s.quote(cmd) : null;
    return this.q;
  }
  base(title, q, extra = '') {
    if (!q) return { title, ok: null, note: extra };
    return { title, ok: !!q.ok, cost: q.cost || 0, reason: q.ok ? '' : q.reason || 'Not possible here', note: extra };
  }
}

// ---------------------------------------------------------------- select / inspect
export class SelectTool extends Tool {
  get name() { return 'select'; }
  cursor() { return this.drag ? 'grabbing' : 'default'; }
  down(e) { if (e.button === 0) { this.start = e; this.drag = false; } }
  move(e) {
    this.hover = e;
    if (this.start && e.buttons & 1) {
      if (!this.drag && Math.hypot(e.sx - this.start.sx, e.sy - this.start.sy) > 4) { this.drag = true; this.last = this.start; }
      if (this.drag) { this.s.cam.pan(e.sx - this.last.sx, e.sy - this.last.sy); this.last = e; }
    }
  }
  up(e) {
    if (this.start && !this.drag && e.button === 0) this.s.select(this.s.pickAt(e.sx, e.sy, e.wx, e.wy));
    this.start = null; this.drag = false;
  }
}

// ---------------------------------------------------------------- safe zone polygon
export class ZoneTool extends Tool {
  constructor(s) { super(s); this.pts = []; }
  get name() { return 'zone'; }
  nearFirst(e) {
    if (this.pts.length < 6) return false;
    const [fx, fy] = toScreen(this.s.cam, this.pts[0], this.pts[1]);
    return Math.hypot(e.sx - fx, e.sy - fy) <= 10;
  }
  down(e) {
    if (e.button !== 0) return;
    if (this.nearFirst(e)) { this.close(); return; }
    if (!pointInPoly(this.world.region.poly, e.wx, e.wy)) { this.s.flash('Corners must be inside the stage boundary', 'warn'); return; }
    this.pts.push(Math.round(e.wx * 10) / 10, Math.round(e.wy * 10) / 10);
    this.s.sfx('clack');
    this._qkey = '';
  }
  dbl() { if (this.pts.length >= 6) this.close(); }
  close() {
    if (this.pts.length < 6) { this.s.flash('A safe zone needs at least 3 corners', 'warn'); return; }
    const r = this.s.issue({ t: 'zone.add', p: this.pts.slice() });
    if (r.ok) { this.pts = []; this.q = null; this._qkey = ''; }
  }
  key(action) {
    if (action === 'confirm') { if (this.pts.length >= 6) { this.close(); return true; } return false; }
    if (action === 'cancel' && this.pts.length) { this.pts = []; this.q = null; return true; }
    if (action === 'backspace' && this.pts.length) { this.pts.length -= 2; this._qkey = ''; return true; }
    return false;
  }
  rightClick() { if (this.pts.length) { this.pts.length -= 2; this._qkey = ''; return true; } return false; }
  label() {
    const e = this.hover;
    if (!e) return null;
    const n = this.pts.length / 2;
    if (n < 2) return { title: 'SAFE ZONE', ok: null, note: n ? 'click the next corner' : 'click to place the first corner' };
    const closing = this.nearFirst(e);
    const p = closing ? this.pts.slice() : [...this.pts, e.wx, e.wy];
    const q = this.quote({ t: 'zone.add', p }, `${n}|${closing}|${Math.round(e.wx)}|${Math.round(e.wy)}`);
    return this.base('SAFE ZONE', q, closing ? 'click to close' : n >= 3 ? 'Enter or first corner closes' : '');
  }
  draw(ctx, cam, pal) {
    const s = this.s;
    if (!this.pts.length && s.world.phase === 'planning') drawCornerHandles(ctx, s, cam, pal);
    if (!this.pts.length || !this.hover) return;
    const e = this.hover, closing = this.nearFirst(e);
    const p = closing ? this.pts.slice() : [...this.pts, e.wx, e.wy];
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < p.length; k += 2) { const [x, y] = toScreen(cam, p[k], p[k + 1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = rgba(pal.zone.wall, 0.12); ctx.fill();
    // the wall it will build: the outline outside existing zones, in the built-wall line style
    const lines = p.length >= 6 ? s.wr.zoneOutlinePreview(s.world, p) : [{ p, closed: false }];
    s.wr.drawWallPreview(ctx, cam, s.world.grid.cell, lines, 0, 0.75);
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    for (let k = 0; k < this.pts.length; k += 2) {
      const [x, y] = toScreen(cam, this.pts[k], this.pts[k + 1]);
      ctx.fillStyle = k === 0 && closing ? pal.zone.wall : pal.card;
      ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeStyle = pal.ink; ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    ctx.restore();
  }
}

function drawCornerHandles(ctx, s, cam, pal) {
  const w = s.world;
  ctx.save();
  ctx.lineWidth = 1;
  for (const pl of w.zones.polys) {
    if (w.owners > 1 && pl.owner !== s.owner) continue;
    for (let k = 0; k < pl.p.length; k += 2) {
      const [x, y] = toScreen(cam, pl.p[k], pl.p[k + 1]);
      if (x < -6 || y < -6 || x > cam.w + 6 || y > cam.h + 6) continue;
      ctx.fillStyle = pal.card; ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeStyle = pal.zone.wall; ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
    }
  }
  ctx.restore();
}

// Finds an own zone corner within `px` screen pixels: { id, j, p } or null.
export function findCorner(s, sx, sy, px = 9) {
  const w = s.world, cam = s.cam;
  let best = null, bd = px;
  for (const pl of w.zones.polys) {
    if (w.owners > 1 && pl.owner !== s.owner) continue;
    for (let k = 0; k < pl.p.length; k += 2) {
      const [x, y] = toScreen(cam, pl.p[k], pl.p[k + 1]);
      const d = Math.hypot(x - sx, y - sy);
      if (d <= bd) { bd = d; best = { id: pl.id, j: k, p: pl.p }; }
    }
  }
  return best;
}

// Drag gesture that moves one zone corner (planning only).
export class CornerDrag {
  constructor(s, c) { this.s = s; this.id = c.id; this.j = c.j; this.p = c.p.slice(); this.q = null; this._qt = 0; this.moved = false; }
  move(e) {
    this.p[this.j] = Math.round(e.wx * 10) / 10; this.p[this.j + 1] = Math.round(e.wy * 10) / 10;
    this.moved = true;
    const t = now();
    if (t - this._qt > 140) { this._qt = t; this.q = this.s.quote({ t: 'zone.move', id: this.id, p: this.p }); }
  }
  up() {
    if (!this.moved) return;
    this.s.issue({ t: 'zone.move', id: this.id, p: this.p.slice() });
  }
  label() {
    const q = this.q;
    if (!q) return { title: 'MOVE CORNER', ok: null };
    return { title: 'MOVE CORNER', ok: !!q.ok, cost: Math.max(0, q.cost || 0), reason: q.ok ? '' : q.reason, note: q.ok && q.cost < 0 ? `refund ${money(-q.cost)}` : '' };
  }
  draw(ctx, cam, pal) {
    const s = this.s, bad = this.q && !this.q.ok;
    s.wr.drawWallPreview(ctx, cam, s.world.grid.cell, s.wr.zoneOutlinePreview(s.world, this.p, this.id), 0, 0.75, bad ? pal.stamp : null);
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < this.p.length; k += 2) { const [x, y] = toScreen(cam, this.p[k], this.p[k + 1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
    ctx.strokeStyle = bad ? pal.stamp : pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke();
    const [x, y] = toScreen(cam, this.p[this.j], this.p[this.j + 1]);
    ctx.setLineDash([]); ctx.fillStyle = pal.zone.wall; ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- standalone wall polyline
export class WallTool extends Tool {
  constructor(s) { super(s); this.pts = []; }
  get name() { return 'wall'; }
  left() {
    const c = this.cfg.wall;
    let used = 0;
    for (const w of this.world.walls) used += w.len || 0;
    return Math.max(0, c.standaloneMaxM + c.standalonePerLevelM * this.world.stage - used);
  }
  down(e) {
    if (e.button !== 0) return;
    if (!pointInPoly(this.world.region.poly, e.wx, e.wy)) { this.s.flash('Walls must be inside the stage boundary', 'warn'); return; }
    this.pts.push(Math.round(e.wx * 10) / 10, Math.round(e.wy * 10) / 10);
    this.s.sfx('clack');
    this._qkey = '';
  }
  dbl() { this.finish(); }
  finish() {
    if (this.pts.length >= 4 && this.pts[this.pts.length - 1] === this.pts[this.pts.length - 3] && this.pts[this.pts.length - 2] === this.pts[this.pts.length - 4]) this.pts.length -= 2;
    if (this.pts.length < 4) return false;
    const r = this.s.issue({ t: 'wall.add', p: this.pts.slice() });
    if (r.ok) { this.pts = []; this.q = null; }
    return true;
  }
  key(action) {
    if (action === 'confirm') return this.finish();
    if (action === 'cancel' && this.pts.length) { this.pts = []; return true; }
    if (action === 'backspace' && this.pts.length) { this.pts.length -= 2; this._qkey = ''; return true; }
    return false;
  }
  rightClick() { if (this.pts.length) { this.pts.length -= 2; return true; } return false; }
  label() {
    const e = this.hover;
    if (!e) return null;
    const left = `${Math.floor(this.left())} m left`;
    if (!this.pts.length) return { title: 'WALL', ok: null, note: `click points, Enter ends · ${left}` };
    const p = [...this.pts, e.wx, e.wy];
    const q = this.quote({ t: 'wall.add', p }, `${this.pts.length}|${Math.round(e.wx)}|${Math.round(e.wy)}`);
    return this.base('WALL', q, `${Math.round(polyPerimeter(p, false))} m · ${left}`);
  }
  draw(ctx, cam, pal) {
    if (!this.pts.length || !this.hover) return;
    const p = [...this.pts, this.hover.wx, this.hover.wy];
    const path = this.s.wr.drawWallPreview(ctx, cam, this.world.grid.cell, [{ p, closed: false }], 1, 0.75, this.q && this.q.ok === false ? pal.stamp : null);
    ctx.save();
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(path);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- gate
export class GateTool extends Tool {
  get name() { return 'gate'; }
  snap(e) {
    const w = this.world, g = w.grid, cs = g.cell;
    const cx0 = Math.floor(e.wx / cs), cy0 = Math.floor(e.wy / cs);
    let best = -1, bd = Infinity;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
      const c = cy * g.gw + cx;
      if (!w.zoneComp[c] || w.zoneId[c]) continue;
      const d = ((cx + 0.5) * cs - e.wx) ** 2 + ((cy + 0.5) * cs - e.wy) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best < 0 ? null : [(best % g.gw + 0.5) * cs, (((best / g.gw) | 0) + 0.5) * cs];
  }
  down(e) {
    if (e.button !== 0) return;
    this.s.issue({ t: 'gate.add', x: e.wx, y: e.wy });
    this._qkey = '';
  }
  label() {
    const e = this.hover;
    if (!e) return null;
    const sn = this.snap(e);
    const q = this.quote({ t: 'gate.add', x: e.wx, y: e.wy }, sn ? `${sn[0]}|${sn[1]}|${this.world.zones.gates.length}` : 'none');
    const warn = q && q.ok && q.warn ? q.warn.toLowerCase() : '';
    return this.base('GATE', q, !sn ? 'point at a safe-zone wall' : warn ? 'warning: ' + warn : 'civilians enter here');
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    const sn = this.snap(e);
    if (!sn) return;
    // the gate as a straight piece of the wall line: the quoted segment when the sim gives one, else the nearest edge
    const q = this.q, wr = this.s.wr;
    let geo = null;
    if (q && Number.isFinite(q.x0) && Number.isFinite(q.x1)) geo = { ax: q.x0, ay: q.y0, bx: q.x1, by: q.y1 };
    else {
      const w = wr.nearestZoneWall(this.world, e.wx, e.wy, this.world.grid.cell * 3), hw = this.cfg.gate.width * 0.5;
      if (w) geo = { ax: w.x - w.ux * hw, ay: w.y - w.uy * hw, bx: w.x + w.ux * hw, by: w.y + w.uy * hw };
    }
    if (!geo) return;
    const L = Math.hypot(geo.bx - geo.ax, geo.by - geo.ay) || 1;
    geo.nx = -(geo.by - geo.ay) / L; geo.ny = (geo.bx - geo.ax) / L;
    wr.drawGate(ctx, cam, geo, q && (q.ok === false || q.warn) ? pal.stamp : pal.ink, false, 0.9);
  }
}

// ---------------------------------------------------------------- corridor
export class CorridorTool extends Tool {
  constructor(s) { super(s); this.w = s.world.cfg.corridor.defaultWidth; this.a = null; }
  get name() { return 'corridor'; }
  down(e) { if (e.button === 0) { this.a = [e.wx, e.wy]; this._qkey = ''; } }
  up(e) {
    if (!this.a || e.button !== 0) return;
    const [x0, y0] = this.a;
    this.a = null;
    if (Math.hypot(e.wx - x0, e.wy - y0) < 8) { this.s.flash('Drag from the tail to the arrow head', 'warn'); return; }
    this.s.issue({ t: 'corridor.add', x0, y0, x1: e.wx, y1: e.wy, w: this.w });
  }
  setWidth(d) {
    const c = this.cfg.corridor;
    this.w = clamp(Math.round(this.w + d), c.minWidth, c.maxWidth);
    this._qkey = '';
  }
  wheel(e) {
    if (!this.a && !e.shift) return false;
    this.setWidth(e.deltaY < 0 ? 4 : -4);
    return true;
  }
  key(action) {
    if (action === 'widthUp') { this.setWidth(4); return true; }
    if (action === 'widthDown') { this.setWidth(-4); return true; }
    if (action === 'cancel' && this.a) { this.a = null; return true; }
    return false;
  }
  label() {
    const e = this.hover;
    if (!e) return null;
    if (!this.a) return { title: 'EVAC CORRIDOR', ok: null, note: `drag tail to head · width ${this.w} m (wheel while dragging)` };
    const q = this.quote({ t: 'corridor.add', x0: this.a[0], y0: this.a[1], x1: e.wx, y1: e.wy, w: this.w }, `${Math.round(e.wx)}|${Math.round(e.wy)}|${this.w}`);
    return this.base('EVAC CORRIDOR', q, `width ${this.w} m`);
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    if (this.a) this.s.wr.drawCorridor(ctx, cam, this.a[0], this.a[1], e.wx, e.wy, this.w, undefined, this.q && this.q.ok === false ? pal.stamp : null, 0.85);
    else {
      ctx.save(); ctx.strokeStyle = pal.zone.corridor; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(e.sx, e.sy, Math.max(3, this.w * cam.zoom / 2), 0, TAU); ctx.stroke(); ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- hold
export class HoldTool extends Tool {
  constructor(s) { super(s); this.c = null; }
  get name() { return 'hold'; }
  radius(e) { const h = this.cfg.hold; return clamp(this.c ? Math.hypot(e.wx - this.c[0], e.wy - this.c[1]) : h.minR, h.minR, h.maxR); }
  down(e) { if (e.button === 0) { this.c = [e.wx, e.wy]; this._qkey = ''; } }
  up(e) {
    if (!this.c || e.button !== 0) return;
    const R = this.radius(e), [x, y] = this.c;
    this.c = null;
    this.s.issue({ t: 'hold.add', x, y, R });
  }
  key(action) { if (action === 'cancel' && this.c) { this.c = null; return true; } return false; }
  label() {
    const e = this.hover;
    if (!e) return null;
    if (!this.c) return { title: 'HOLD POINT', ok: null, note: 'drag out the radius' };
    const R = this.radius(e);
    const q = this.quote({ t: 'hold.add', x: this.c[0], y: this.c[1], R }, `${Math.round(R)}`);
    return this.base('HOLD POINT', q, `radius ${Math.round(R)} m`);
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    if (this.c) { const R = this.radius(e); this.s.wr.drawHold(ctx, cam, this.c[0], this.c[1], R, R * this.cfg.hold.innerFrac, this.q && this.q.ok === false ? pal.stamp : null, 0.9); }
  }
}

// ---------------------------------------------------------------- units
export class UnitTool extends Tool {
  constructor(s, type) {
    super(s);
    this.type = type;
    this.c = s.world.cfg.units[type] || {};
    this.mount = this.c.mount || 'ground';
    this.drag = null;
  }
  get name() { return 'unit:' + this.type; }
  get painting() { return this.mount === 'building' && this.c.paint && this.s.paint; }
  title() { return this.s.combat.unitName(this.type).toUpperCase(); }

  target(e) {
    const w = this.world, map = w.map, owner = this.s.owner;
    if (this.mount === 'building' || this.mount === 'building|bridge') {
      const b = pickBuilding(map, e.wx, e.wy);
      if (b >= 0 && w.buildings[b] && w.buildings[b].alive) {
        const bd = w.buildings[b];
        return { key: 'b' + b, b, cmd: { t: 'unit.place', type: this.type, x: bd.cx, y: bd.cy, b, owner } };
      }
      if (this.mount === 'building|bridge') {
        const br = pickBridge(map, e.wx, e.wy, 3);
        if (br && br.id >= 0) return { key: 'br' + br.id, bridge: br.id, cmd: { t: 'unit.place', type: this.type, x: e.wx, y: e.wy, bridge: br.id, owner } };
      }
      return { key: 'none', cmd: null, reason: this.mount === 'building' ? 'Place on a building' : 'Place on a building or bridge' };
    }
    const x = Math.round(e.wx * 10) / 10, y = Math.round(e.wy * 10) / 10;
    return { key: `${Math.round(x / 2)}|${Math.round(y / 2)}`, cmd: { t: 'unit.place', type: this.type, x, y, owner } };
  }

  brushCells(wx, wy, out) {
    const g = this.world.grid, cs = g.cell, r = this.brushR();
    const cx0 = Math.floor((wx - r) / cs), cx1 = Math.floor((wx + r) / cs), cy0 = Math.floor((wy - r) / cs), cy1 = Math.floor((wy + r) / cs);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
      const dx = (cx + 0.5) * cs - wx, dy = (cy + 0.5) * cs - wy;
      if (dx * dx + dy * dy <= r * r) out.add(cy * g.gw + cx);
    }
    return out;
  }
  brushR() { return Math.max(this.world.grid.cell * 0.75, (this.c.splash || 6) * 0.9); }

  down(e) {
    if (e.button !== 0) return;
    if (this.mount === 'brush') { this.drag = { cells: this.brushCells(e.wx, e.wy, new Set()) }; this._qkey = ''; return; }
    if (this.mount === 'line') { this.drag = { path: [e.wx, e.wy] }; this._qkey = ''; return; }
    if (this.painting) { this.drag = { blds: new Set(), last: [e.wx, e.wy] }; this.sweep(e); return; }
    const t = this.target(e);
    if (!t.cmd) { this.s.flash(t.reason, 'warn'); return; }
    const r = this.s.issue(t.cmd);
    if (r.ok) this._qkey = '';
  }

  sweep(e) {
    const d = this.drag, [lx, ly] = d.last, map = this.world.map;
    const L = Math.hypot(e.wx - lx, e.wy - ly), n = Math.max(1, Math.ceil(L / 3));
    for (let k = 1; k <= n; k++) {
      const x = lx + (e.wx - lx) * k / n, y = ly + (e.wy - ly) * k / n;
      const b = pickBuilding(map, x, y);
      if (b >= 0 && this.world.buildings[b].alive && this.world.buildings[b].unitId < 0 && !this.occupied(b)) d.blds.add(b);
    }
    d.last = [e.wx, e.wy];
    this._qkey = '';
  }
  occupied(b) { for (const u of this.world.units) if (u && u.alive !== false && u.b === b) return true; return false; }
  // One fine cell per swept building: the combat module places a unit on the building under each cell.
  paintCmd(blds) {
    const g = this.world.grid, cells = [];
    for (const b of blds) {
      const bd = this.world.buildings[b];
      const c = this.world.cellAt(bd.cx, bd.cy);
      cells.push(c >= 0 && g.bldg[c] === b + 1 ? c : g.bInfo[b].cells[0]);
    }
    return { t: 'unit.paint', type: this.type, cells: cells.filter((c) => c >= 0), owner: this.s.owner };
  }

  move(e) {
    this.hover = e;
    const d = this.drag;
    if (!d || !(e.buttons & 1)) return;
    if (d.cells) { const n0 = d.cells.size; this.brushCells(e.wx, e.wy, d.cells); if (d.cells.size !== n0) this._qkey = ''; }
    else if (d.path) {
      const p = d.path, lx = p[p.length - 2], ly = p[p.length - 1];
      if (Math.hypot(e.wx - lx, e.wy - ly) >= 4) { p.push(e.wx, e.wy); this._qkey = ''; }
    } else if (d.blds) this.sweep(e);
  }

  up(e) {
    const d = this.drag;
    if (!d || e.button !== 0) return;
    this.drag = null;
    if (d.cells) {
      if (d.cells.size) this.s.issue({ t: 'unit.paint', type: this.type, cells: [...d.cells].sort((a, b) => a - b), owner: this.s.owner });
    } else if (d.path) {
      const p = simplify(d.path, 1.5).map((v) => Math.round(v * 10) / 10);
      if (p.length >= 4) this.s.issue({ t: 'unit.paint', type: this.type, path: p, owner: this.s.owner });
      else this.s.flash('Drag to draw a line', 'warn');
    } else if (d.blds) {
      if (d.blds.size) this.s.issue(this.paintCmd(d.blds));
    }
    this._qkey = '';
  }

  key(action) { if (action === 'cancel' && this.drag) { this.drag = null; return true; } return false; }

  label() {
    const e = this.hover;
    if (!e) return null;
    const title = this.title();
    const d = this.drag;
    if (d && d.cells) return this.base(title, this.quote({ t: 'unit.paint', type: this.type, cells: [...d.cells], owner: this.s.owner }, 'c' + d.cells.size), `${d.cells.size} cells`);
    if (d && d.path) return this.base(title, this.quote({ t: 'unit.paint', type: this.type, path: d.path, owner: this.s.owner }, 'p' + d.path.length), `${Math.round(polyPerimeter(d.path, false))} m`);
    if (d && d.blds) {
      if (!d.blds.size) return { title, ok: null, note: 'sweep across roofs' };
      const q = this.quote(this.paintCmd(d.blds), 'B' + d.blds.size);
      const n = q && q.ok ? q.count || d.blds.size : 0;
      return this.base(title, q, `${n} building${n === 1 ? '' : 's'}`);
    }
    if (this.mount === 'brush') {
      const cells = [...this.brushCells(e.wx, e.wy, new Set())];
      return this.base(title, this.quote({ t: 'unit.paint', type: this.type, cells, owner: this.s.owner }, 'b' + cells[0]), 'drag to paint');
    }
    if (this.mount === 'line') return { title, ok: null, note: `drag to draw · ${money(this.c.cost || 0)}/m` };
    const t = this.target(e);
    if (!t.cmd) return { title, ok: false, cost: 0, reason: t.reason, note: this.painting ? 'paint: drag across roofs' : '' };
    const q = this.quote(t.cmd, t.key);
    let note = '';
    if (t.b >= 0) { const bd = this.world.buildings[t.b]; note = `${Math.round(bd.h)} m tall${this.s.world.buildingInZone(t.b) >= 0 ? ' · in zone' : ''}`; }
    if (this.painting) note = (note ? note + ' · ' : '') + 'paint mode';
    return this.base(title, q, note);
  }

  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    const d = this.drag;
    ctx.save();
    if (d && d.cells) {
      const g = this.world.grid, cs = g.cell;
      ctx.fillStyle = rgba(pal.stamp, 0.35);
      for (const c of d.cells) { const [x, y] = toScreen(cam, (c % g.gw) * cs, ((c / g.gw) | 0) * cs); ctx.fillRect(x, y, cs * cam.zoom, cs * cam.zoom); }
    } else if (d && d.path) {
      ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(2, 2 * cam.zoom); ctx.lineCap = 'round'; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let k = 0; k < d.path.length; k += 2) { const [x, y] = toScreen(cam, d.path[k], d.path[k + 1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.lineTo(e.sx, e.sy); ctx.stroke();
    } else if (d && d.blds) {
      ctx.strokeStyle = pal.select; ctx.lineWidth = 2;
      for (const b of d.blds) {
        const p = this.world.map.buildings[b].p;
        ctx.beginPath();
        for (let k = 0; k < p.length; k += 2) { const [x, y] = toScreen(cam, p[k], p[k + 1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.stroke();
        const bd = this.world.buildings[b];
        const [x, y] = toScreen(cam, bd.cx, bd.cy);
        drawUnitGlyph(ctx, this.type, x, y, 6, pal.select, pal.card, { level: 1 });
      }
    } else if (this.mount === 'brush') {
      ctx.strokeStyle = pal.ink; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(e.sx, e.sy, this.brushR() * cam.zoom, 0, TAU); ctx.stroke();
    } else {
      const t = this.target(e);
      const ok = this.q ? this.q.ok : true;
      let x = e.sx, y = e.sy, b = null;
      if (t.b >= 0) { b = this.world.buildings[t.b]; [x, y] = toScreen(cam, b.cx, b.cy); }
      if (t.cmd) {
        ctx.globalAlpha = 0.85;
        drawUnitGlyph(ctx, this.type, x, y, 7, ok ? pal.ink : pal.stamp, pal.card, { level: 1, angle: -Math.PI / 4 });
        ctx.globalAlpha = 1;
        const r = this.s.combat.previewRange(this.world, this.type, b);
        if (r > 0) {
          ctx.strokeStyle = ok ? pal.ink : pal.stamp; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.arc(x, y, r * cam.zoom, 0, TAU); ctx.stroke();
          if (this.c.minRange) { ctx.strokeStyle = rgba(pal.stamp, 0.6); ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.arc(x, y, this.c.minRange * cam.zoom, 0, TAU); ctx.stroke(); }
        }
      }
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- upgrade
export class UpgradeTool extends Tool {
  get name() { return 'upgrade'; }
  down(e) { if (e.button === 0) { this.done = new Set(); this.apply(e); } }
  move(e) { this.hover = e; if (this.done && e.buttons & 1) this.apply(e); }
  up() { this.done = null; }
  apply(e) {
    const u = this.s.pickUnit(e.sx, e.sy, e.wx, e.wy);
    if (!u || this.done.has(u.id)) return;
    this.done.add(u.id);
    this.s.issue({ t: 'unit.upgrade', id: u.id, owner: this.s.owner });
    this._qkey = '';
  }
  label() {
    const e = this.hover;
    if (!e) return null;
    const u = this.s.pickUnit(e.sx, e.sy, e.wx, e.wy);
    if (!u) return { title: 'UPGRADE', ok: null, note: 'click or drag over units' };
    const q = this.quote({ t: 'unit.upgrade', id: u.id, owner: this.s.owner }, `${u.id}|${u.level}`);
    const nx = this.s.combat.nextUpgradeStat(u);
    const note = `level ${u.level || 1} to ${(u.level || 1) + 1}${nx ? ` · ${nx[0]} x${nx[1]}` : ''}`;
    return this.base(`UPGRADE ${this.s.combat.unitName(u.type).toUpperCase()}`, q, note);
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    const u = this.s.pickUnit(e.sx, e.sy, e.wx, e.wy);
    if (!u) return;
    const [x, y] = toScreen(cam, u.x, u.y);
    ctx.save(); ctx.strokeStyle = this.q && this.q.ok === false ? pal.stamp : pal.approve; ctx.lineWidth = 2; ctx.strokeRect(x - 12, y - 12, 24, 24); ctx.restore();
  }
}

// ---------------------------------------------------------------- refund
export class RefundTool extends Tool {
  get name() { return 'refund'; }
  down(e) { if (e.button === 0) { this.a = e; this.box = false; } }
  move(e) {
    this.hover = e;
    if (this.a && e.buttons & 1 && Math.hypot(e.sx - this.a.sx, e.sy - this.a.sy) > 6) this.box = true;
  }
  up(e) {
    if (!this.a || e.button !== 0) return;
    const a = this.a;
    this.a = null;
    if (this.box) {
      this.box = false;
      const items = this.s.placementsInBox(Math.min(a.wx, e.wx), Math.min(a.wy, e.wy), Math.max(a.wx, e.wx), Math.max(a.wy, e.wy));
      if (!items.length) { this.s.flash('Nothing of yours in that box', 'warn'); return; }
      this.s.openRefundPanel(items);
      return;
    }
    const it = this.s.pickPlacement(e.sx, e.sy, e.wx, e.wy);
    if (!it) { this.s.flash('Nothing to refund here', 'warn'); return; }
    this.s.issue(it.cmd);
  }
  key(action) { if (action === 'cancel' && this.a) { this.a = null; this.box = false; return true; } return false; }
  label() {
    const e = this.hover;
    if (!e) return null;
    if (this.a && this.box) return { title: 'REFUND', ok: null, note: 'release to list what is inside' };
    const it = this.s.pickPlacement(e.sx, e.sy, e.wx, e.wy);
    if (!it) return { title: 'REFUND', ok: null, note: 'click a placement or drag a box' };
    const q = this.quote(it.cmd, it.key);
    const back = q && q.ok ? (q.refund !== undefined ? q.refund : this.world.refundValue(it.paid)) : 0;
    return { title: `REFUND ${it.label.toUpperCase()}`, ok: q ? !!q.ok : null, cost: 0, reason: q && !q.ok ? q.reason : '', note: q && q.ok ? (back > 0 ? `returns ${money(back)}` : 'no money back in battle') : '' };
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    ctx.save();
    if (this.a && this.box) {
      ctx.strokeStyle = pal.stamp; ctx.setLineDash([5, 3]); ctx.lineWidth = 1.5;
      ctx.fillStyle = rgba(pal.stamp, 0.06);
      const x = Math.min(this.a.sx, e.sx), y = Math.min(this.a.sy, e.sy), w = Math.abs(e.sx - this.a.sx), h = Math.abs(e.sy - this.a.sy);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    } else {
      const it = this.s.pickPlacement(e.sx, e.sy, e.wx, e.wy);
      if (it) {
        const [x, y] = toScreen(cam, it.x, it.y);
        ctx.strokeStyle = pal.stamp; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- abilities
export class AbilityTool extends Tool {
  constructor(s, id) { super(s); this.id = id; this.a = s.world.cfg.abilities[id] || {}; this.kind = this.a.target || 'point'; this.start = null; }
  get name() { return 'ability:' + this.id; }
  title() { return this.s.combat.abilityName(this.id).toUpperCase(); }
  cmdFor(e) {
    const id = this.id, owner = this.s.owner, w = this.world;
    const r1 = (v) => Math.round(v * 10) / 10;
    if (this.kind === 'circle') {
      if (!this.start) return null;
      const [x, y] = this.start;
      const maxR = this.a.maxR || 160, d = Math.hypot(e.wx - x, e.wy - y);
      const R = d * this.s.cam.zoom < 4 ? Math.round(maxR * 0.6) : clamp(d, 10, maxR);
      const ang = Math.atan2(e.wy - y, e.wx - x) || 0;
      return { key: `c${Math.round(R)}`, cmd: { t: 'ability.use', id, x: r1(x), y: r1(y), x2: r1(x + Math.cos(ang) * R), y2: r1(y + Math.sin(ang) * R), r: r1(R), owner } };
    }
    if (this.kind === 'line') {
      if (!this.start) return null;
      const [x, y] = this.start;
      let x2 = e.wx, y2 = e.wy;
      if (this.a.length) {
        const L = Math.hypot(x2 - x, y2 - y) || 1;
        x2 = x + (x2 - x) / L * this.a.length; y2 = y + (y2 - y) / L * this.a.length;
      }
      return { key: `l${Math.round(x2)}|${Math.round(y2)}`, cmd: { t: 'ability.use', id, x: r1(x), y: r1(y), x2: r1(x2), y2: r1(y2), owner } };
    }
    if (this.kind === 'garrison') {
      const u = this.s.pickUnit(e.sx, e.sy, e.wx, e.wy, (q) => q.type === 'garrison');
      if (!u) return { key: 'none', cmd: null, reason: 'Pick one of your garrisons' };
      return { key: 'u' + u.id, cmd: { t: 'ability.use', id, x: u.x, y: u.y, unit: u.id, b: u.b, owner } };
    }
    if (this.kind === 'building' || this.kind === 'bridge|building') {
      const b = pickBuilding(w.map, e.wx, e.wy);
      if (b >= 0 && w.buildings[b].alive) return { key: `b${b}|${Math.round(e.wx / 3)}|${Math.round(e.wy / 3)}`, b, cmd: { t: 'ability.use', id, x: r1(e.wx), y: r1(e.wy), b, owner } };
      if (this.kind === 'bridge|building') {
        const br = pickBridge(w.map, e.wx, e.wy, 3);
        if (br && br.id >= 0) return { key: 'br' + br.id, cmd: { t: 'ability.use', id, x: r1(e.wx), y: r1(e.wy), bridge: br.id, owner } };
      }
      return { key: 'none', cmd: null, reason: this.kind === 'building' ? 'Pick a building' : 'Pick a building or bridge' };
    }
    return { key: `${Math.round(e.wx / 2)}|${Math.round(e.wy / 2)}`, cmd: { t: 'ability.use', id, x: r1(e.wx), y: r1(e.wy), owner } };
  }
  down(e) {
    if (e.button !== 0) return;
    if (this.kind === 'circle' || this.kind === 'line') { this.start = [e.wx, e.wy]; this._qkey = ''; return; }
    this.fire(e);
  }
  up(e) {
    if (e.button !== 0 || !this.start) return;
    if (Math.hypot(e.wx - this.start[0], e.wy - this.start[1]) < 3 && this.kind === 'line') { this.start = null; this.s.flash('Drag to set the direction', 'warn'); return; }
    this.fire(e);
    this.start = null;
  }
  fire(e) {
    const t = this.cmdFor(e);
    if (!t || !t.cmd) { this.s.flash((t && t.reason) || 'Pick a target', 'warn'); return; }
    const r = this.s.issue(t.cmd);
    if (!r.ok) return;
    const left = this.s.combat.abilityState(this.world, this.id).charges;
    if (!e.shift || left <= 0) this.s.setTool('select');
  }
  key(action) { if (action === 'cancel' && this.start) { this.start = null; return true; } return false; }
  label() {
    const e = this.hover;
    if (!e) return null;
    const st = this.s.combat.abilityState(this.world, this.id);
    const title = `${this.title()} x${st.charges}`;
    if (this.world.phase !== 'battle') return { title, ok: false, cost: 0, reason: 'Abilities are used after READY' };
    if (st.unlockIn > 0) return { title, ok: false, cost: 0, reason: `Available in ${Math.ceil(st.unlockIn)} s` };
    if ((this.kind === 'circle' || this.kind === 'line') && !this.start) return { title, ok: null, note: this.kind === 'circle' ? 'drag out the radius' : 'drag to set the direction' };
    const t = this.cmdFor(e);
    if (!t || !t.cmd) return { title, ok: false, cost: 0, reason: (t && t.reason) || '' };
    const q = this.quote(t.cmd, t.key);
    return { title, ok: !!(q && q.ok), cost: 0, reason: q && !q.ok ? q.reason : '', note: this.a.delay ? `lands ${this.a.delay} s after the call` : '' };
  }
  draw(ctx, cam, pal) {
    const e = this.hover;
    if (!e) return;
    const a = this.a, col = this.q && this.q.ok === false ? pal.stamp : pal.carbon;
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    const ring = (x, y, r, dash = [5, 4]) => { ctx.setLineDash(dash); ctx.beginPath(); ctx.arc(x, y, Math.max(3, r * cam.zoom), 0, TAU); ctx.stroke(); ctx.setLineDash([]); };
    if (this.kind === 'circle' && this.start) {
      const t = this.cmdFor(e);
      const [x, y] = toScreen(cam, this.start[0], this.start[1]);
      ring(x, y, t.cmd.r);
      ctx.fillStyle = rgba(col, 0.08); ctx.beginPath(); ctx.arc(x, y, t.cmd.r * cam.zoom, 0, TAU); ctx.fill();
    } else if (this.kind === 'line' && this.start) {
      const t = this.cmdFor(e);
      const [x, y] = toScreen(cam, t.cmd.x, t.cmd.y), [x2, y2] = toScreen(cam, t.cmd.x2, t.cmd.y2);
      ctx.lineWidth = Math.max(2, (a.width || a.splash || 8) * cam.zoom);
      ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      if (a.bombs) for (let k = 0; k < a.bombs; k++) { const f = (k + 0.5) / a.bombs; ctx.strokeRect(x + (x2 - x) * f - 3, y + (y2 - y) * f - 3, 6, 6); }
    } else if (this.kind === 'building' || this.kind === 'bridge|building' || this.kind === 'garrison') {
      const t = this.cmdFor(e);
      if (t && t.cmd && t.b >= 0) {
        const bd = this.world.buildings[t.b];
        const [cx, cy] = toScreen(cam, bd.cx, bd.cy);
        const p = this.world.map.buildings[t.b].p;
        ctx.lineWidth = 2; ctx.beginPath();
        for (let k = 0; k < p.length; k += 2) { const [x, y] = toScreen(cam, p[k], p[k + 1]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.closePath(); ctx.stroke();
        let dx = e.sx - cx, dy = e.sy - cy;
        const L = Math.hypot(dx, dy);
        if (L > 4 && this.kind === 'building') {
          dx /= L; dy /= L;
          const len = Math.max(18, bd.h * this.cfg.building.toppleRange * cam.zoom);
          const ex = cx + dx * len, ey = cy + dy * len;
          ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - dx * 8 - dy * 5, ey - dy * 8 + dx * 5); ctx.lineTo(ex - dx * 8 + dy * 5, ey - dy * 8 - dx * 5); ctx.closePath();
          ctx.fillStyle = col; ctx.fill();
        }
      } else if (t && t.cmd) { const [x, y] = toScreen(cam, t.cmd.x, t.cmd.y); ring(x, y, 14, [3, 3]); }
    } else {
      const r = a.radius || a.splash || a.orbitR || a.huntRadius || 20;
      ring(e.sx, e.sy, r);
      if (this.id === 'nuke' && a.coreFrac) ring(e.sx, e.sy, a.radius * a.coreFrac, [2, 3]);
      ctx.beginPath(); ctx.moveTo(e.sx - 8, e.sy); ctx.lineTo(e.sx + 8, e.sy); ctx.moveTo(e.sx, e.sy - 8); ctx.lineTo(e.sx, e.sy + 8); ctx.stroke();
    }
    ctx.restore();
  }
}

export function makeTool(s, name) {
  if (name.startsWith('unit:')) return new UnitTool(s, name.slice(5));
  if (name.startsWith('ability:')) return new AbilityTool(s, name.slice(8));
  switch (name) {
    case 'zone': return new ZoneTool(s);
    case 'wall': return new WallTool(s);
    case 'gate': return new GateTool(s);
    case 'corridor': return new CorridorTool(s);
    case 'hold': return new HoldTool(s);
    case 'upgrade': return new UpgradeTool(s);
    case 'refund': return new RefundTool(s);
    default: return new SelectTool(s);
  }
}

export { money };
