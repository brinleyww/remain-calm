// Live world layer over the static paper map, drawn in CSS-pixel screen space each frame:
// zones (hatched), walls, gates, corridors, holds, fire, mosh pits, agents (batched per colour), units, vehicles, rings.
import { getPalette, rgba, mix, hexToRgb, FONT_MONO } from './palette.js';
import { drawProjectiles, drawEffects, drawAircraft, stampLabel, tag } from './fx.js';
import { hash2 } from '../util/rng.js';

const TAU = Math.PI * 2;
const CIV = 1, ZOMBIE = 2, TURNING = 3, POLICE = 4, MILITIA = 5, SOLDIER = 6;
const B_CALM = 0, B_PANIC = 1, B_TURN = 2, B_ZOM = 3, B_EXP = 4, B_SHD = 5, B_SWM = 6, B_GNT = 7, B_POL = 8, B_MIL = 9, B_SOL = 10, NB = 11;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PIXEL_ZOOM = 1.2; // CSS px per metre below which crowds are drawn as pixels

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
    default: {
      ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(0, 0, s * 0.85, 0, TAU); ctx.fill(); ctx.stroke();
      letter(String(type || '?').charAt(0).toUpperCase());
    }
  }
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
    this._paths = Array.from({ length: NB }, () => null);
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
    this.comps = world.zones.comps.map((c) => ({ c, polys: c.polys.map((id) => byId.get(id)).filter(Boolean).map((p) => p.p) }));
    this.gateGeo = world.zones.gates.map((gt) => gateGeometry(world, gt));
    this.dirty = false;
  }

  // st: { dpr, ext (s of extrapolation), t (world s), rt (real s), rings, sel, hover, ghost }
  draw(ctx, world, cam, st) {
    if (this.dirty) this._rebuild(world);
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

  _zones(ctx, world, cam, pats, st) {
    const pal = this.pal, z = cam.zoom;
    for (const { c, polys } of this.comps) {
      if (!polys.length) continue;
      const path = new Path2D();
      for (const p of polys) this._polyPath(path, p, cam);
      ctx.fillStyle = c.breached ? rgba(pal.stamp, 0.08) : pal.zone.fill;
      ctx.fill(path);
      ctx.fillStyle = c.breached ? pats.breach : pats.zone;
      ctx.fill(path);
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
  _walls(ctx, world, cam, pats) {
    const cells = world._blockCells;
    const pal = this.pal, z = cam.zoom, ox = cam.x, oy = cam.y;
    if (cells && cells.length) {
      // Each wall cell is a node; a thick round-capped stroke joins it to neighbouring wall cells of the same state,
      // which reads as one continuous drawn wall at any zoom while still showing every breached cell.
      const g = world.grid, cs = g.cell, gw = g.gw, cfg = world.cfg.wall, lm = cfg.levelHpMul;
      const N = gw * g.gh;
      if (!this._wcls || this._wcls.length !== N) this._wcls = new Uint8Array(N);
      const cls = this._wcls;
      const bb = cam.visibleBBox(16);
      const comps = world.zones.comps;
      const vis = [];
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k], b = world.block[c];
        if (b === 3) continue;
        const X = c % gw, Y = (c / gw) | 0;
        const wx = (X + 0.5) * cs, wy = (Y + 0.5) * cs;
        if (wx < bb[0] || wy < bb[1] || wx > bb[2] || wy > bb[3]) continue;
        const hp = world.wallHp[c];
        let full = cfg.hp;
        if (b === 1) { const cp = comps[world.zoneComp[c] - 1]; full = cfg.hp * (lm[(cp ? cp.wallLevel : 1) - 1] || 1); }
        const r = hp <= 0 ? 5 : b === 2 ? (hp < full * 0.5 ? 4 : 3) : hp >= full * 0.6 ? 1 : hp >= full * 0.25 ? 2 : 4;
        cls[c] = r;
        vis.push(c);
      }
      const P = [null, new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const used = [0, 0, 0, 0, 0, 0];
      for (const c of vis) {
        const r = cls[c];
        const X = c % gw, Y = (c / gw) | 0;
        const sx = ((X + 0.5) * cs - ox) * z, sy = ((Y + 0.5) * cs - oy) * z;
        if (r === 5) { P[5].rect(sx - 1, sy - 1, 2, 2); used[5]++; continue; }
        const p = P[r];
        let links = 0;
        if (X + 1 < gw && cls[c + 1] === r) { p.moveTo(sx, sy); p.lineTo(sx + cs * z, sy); links++; }
        if (Y + 1 < g.gh) {
          if (cls[c + gw] === r) { p.moveTo(sx, sy); p.lineTo(sx, sy + cs * z); links++; }
          if (X + 1 < gw && cls[c + gw + 1] === r && cls[c + 1] !== r && cls[c + gw] !== r) { p.moveTo(sx, sy); p.lineTo(sx + cs * z, sy + cs * z); links++; }
          if (X > 0 && cls[c + gw - 1] === r && cls[c - 1] !== r && cls[c + gw] !== r) { p.moveTo(sx, sy); p.lineTo(sx - cs * z, sy + cs * z); links++; }
        }
        if (!links) { p.moveTo(sx, sy); p.lineTo(sx + 0.01, sy); }
        used[r]++;
      }
      for (const c of vis) cls[c] = 0;
      const zc = pal.zone;
      const cols = [null, zc.wall, mix(zc.wall, pal.paper, 0.38), mix(zc.standalone, pal.ink2, 0.22), mix(zc.wall, pal.stamp, 0.55)];
      const lw = Math.max(1.5, cs * z * 1.05);
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let r = 1; r <= 4; r++) {
        if (!used[r]) continue;
        ctx.lineWidth = lw; ctx.strokeStyle = cols[r]; ctx.stroke(P[r]);
        if (lw >= 3 && r !== 4) { ctx.strokeStyle = pats.wall; ctx.globalAlpha = r === 2 ? 0.3 : 0.55; ctx.stroke(P[r]); ctx.globalAlpha = 1; }
      }
      if (lw >= 6) {
        ctx.globalAlpha = 0.5; ctx.strokeStyle = mix(zc.wall, pal.ink, 0.5); ctx.lineWidth = 1;
        for (let r = 1; r <= 3; r++) if (used[r]) ctx.stroke(P[r]);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      if (used[5]) { ctx.fillStyle = pal.rubble; ctx.fill(P[5]); }
    }
    const gates = world.zones.gates;
    if (!gates.length) return;
    ctx.lineCap = 'butt';
    for (let k = 0; k < gates.length; k++) {
      const gt = gates[k], geo = this.gateGeo[k];
      if (!geo) continue;
      const L = Math.max(5, 6 * z);
      const dead = gt.hp <= 0, hurt = gt.hp < gt.hpMax * 0.5;
      ctx.strokeStyle = dead ? pal.ink3 : hurt ? pal.stamp : (world.owners > 1 && gt.owner > 0 ? pal.carbon : pal.zone.gate);
      ctx.lineWidth = Math.max(1.5, Math.min(3, z * 1.2));
      if (dead) ctx.setLineDash([2, 2]);
      ctx.beginPath();
      for (const [ex, ey] of [[geo.ax, geo.ay], [geo.bx, geo.by]]) {
        const sx = (ex - ox) * z, sy = (ey - oy) * z;
        ctx.moveTo(sx - geo.nx * L, sy - geo.ny * L); ctx.lineTo(sx + geo.nx * L, sy + geo.ny * L);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (z > 0.9 && !dead) {
        const ax = (geo.ax - ox) * z, ay = (geo.ay - oy) * z, bx = (geo.bx - ox) * z, by = (geo.by - oy) * z;
        ctx.lineWidth = 1; ctx.setLineDash([1.5, 2.5]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      }
    }
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
  _agents(ctx, world, cam, st) {
    if (cam.zoom < PIXEL_ZOOM && world.A.n > 3000) { this._agentPixels(ctx, world, cam, st); return; }
    const A = world.A, n = A.n;
    const pal = this.pal, z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h;
    const type = A.type, sub = A.sub, X = A.x, Y = A.y, VX = A.vx, VY = A.vy, state = A.state;
    const ext = st.ext || 0;
    const sc = clamp(z * 1.25, 1.6, 4.6), sz = clamp(z * 1.45, 1.9, 5.2), sa = clamp(z * 1.6, 2.2, 6);
    const hc = sc / 2, hz = sz / 2, ha = sa / 2;
    const mutS = sz * 1.7, giantS = sz * 2.9;
    const paths = this._paths;
    for (let b = 0; b < NB; b++) paths[b] = new Path2D();
    let drawn = 0, total = 0;
    const m = 8;
    const dots = new Path2D();
    const showDot = sa >= 4.2;
    const giants = [], shields = [];
    for (let i = 0; i < n; i++) {
      const t = type[i];
      if (!t) continue;
      total++;
      const sx = (X[i] + VX[i] * ext - ox) * z, sy = (Y[i] + VY[i] * ext - oy) * z;
      if (sx < -m || sy < -m || sx > W + m || sy > H + m) continue;
      drawn++;
      if (t === CIV) {
        paths[state[i] === 1 ? B_PANIC : B_CALM].rect(sx - hc, sy - hc, sc, sc);
      } else if (t === ZOMBIE) {
        const s = sub[i];
        if (!s) paths[B_ZOM].rect(sx - hz, sy - hz, sz, sz);
        else if (s === 4) giants.push(sx, sy);
        else {
          const hh = mutS / 2;
          const p = paths[s === 1 ? B_EXP : s === 2 ? B_SHD : B_SWM];
          if (s === 3) { p.moveTo(sx, sy - hh); p.lineTo(sx + hh, sy); p.lineTo(sx, sy + hh); p.lineTo(sx - hh, sy); p.closePath(); }
          else p.rect(sx - hh, sy - hh, mutS, mutS);
          if (s === 2) shields.push(sx, sy);
        }
      } else if (t === TURNING) {
        paths[B_TURN].rect(sx - hc, sy - hc, sc, sc);
      } else {
        paths[t === POLICE ? B_POL : t === MILITIA ? B_MIL : B_SOL].rect(sx - ha, sy - ha, sa, sa);
        if (showDot && t === POLICE) dots.rect(sx - 0.9, sy - 0.9, 1.8, 1.8);
      }
    }
    const ag = pal.agent;
    const cols = [ag.civ, ag.civPanic, ag.turning, ag.zombie, ag.explosive, ag.shielded, ag.swimmer, ag.giant, ag.police, ag.militia, ag.soldier];
    for (let b = 0; b < NB; b++) { ctx.fillStyle = cols[b]; ctx.fill(paths[b]); }
    if (showDot) { ctx.fillStyle = ag.policeDot; ctx.fill(dots); }
    if (shields.length) {
      ctx.strokeStyle = ag.shielded; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < shields.length; k += 2) { ctx.moveTo(shields[k] + mutS, shields[k + 1]); ctx.arc(shields[k], shields[k + 1], mutS, 0, TAU); }
      ctx.stroke();
    }
    if (giants.length) {
      ctx.fillStyle = ag.giant; ctx.strokeStyle = ag.outline; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < giants.length; k += 2) { ctx.moveTo(giants[k] + giantS / 2, giants[k + 1]); ctx.arc(giants[k], giants[k + 1], giantS / 2, 0, TAU); }
      ctx.fill(); ctx.stroke();
    }
    this.stats.agents = total; this.stats.drawn = drawn;
  }

  // Zoomed out, every agent is a 2-3 px square: write them into a pixel buffer and upload it once,
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
    const px1 = (v) => Math.max(1, Math.round(v * dpr));
    const sC = px1(clamp(z * 1.25, 1.6, 4.6)), sZ = px1(clamp(z * 1.45, 1.9, 5.2)), sA = px1(clamp(z * 1.6, 2.2, 6)), sM = Math.round(sZ * 1.7);
    const mutS = clamp(z * 1.45, 1.9, 5.2) * 1.7, giantS = clamp(z * 1.45, 1.9, 5.2) * 2.9;
    const giants = [], shields = [];
    let bx0 = PW, by0 = PH, bx1 = 0, by1 = 0, drawn = 0, total = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const t = type[i];
        if (!t) continue;
        if ((t === CIV || t === TURNING) === (pass === 1)) continue;
        total++;
        const px = (X[i] + VX[i] * ext - ox) * k, py = (Y[i] + VY[i] * ext - oy) * k;
        let s, c;
        if (t === CIV) { s = sC; c = col[state[i] === 1 ? B_PANIC : B_CALM]; }
        else if (t === TURNING) { s = sC; c = col[B_TURN]; }
        else if (t === ZOMBIE) {
          const sb = sub[i];
          if (sb === 4) { if (px > -20 && py > -20 && px < PW + 20 && py < PH + 20) giants.push(px / dpr, py / dpr); continue; }
          if (sb === 2) shields.push(px / dpr, py / dpr);
          s = sb ? sM : sZ;
          c = col[sb === 1 ? B_EXP : sb === 2 ? B_SHD : sb === 3 ? B_SWM : B_ZOM];
        } else { s = sA; c = col[t === POLICE ? B_POL : t === MILITIA ? B_MIL : B_SOL]; }
        let x0 = Math.round(px - s * 0.5), y0 = Math.round(py - s * 0.5), x1 = x0 + s, y1 = y0 + s;
        if (x1 <= 0 || y1 <= 0 || x0 >= PW || y0 >= PH) continue;
        if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > PW) x1 = PW; if (y1 > PH) y1 = PH;
        drawn++;
        for (let y = y0; y < y1; y++) { const r = y * PW; for (let x = x0; x < x1; x++) u32[r + x] = c; }
        if (x0 < bx0) bx0 = x0; if (y0 < by0) by0 = y0; if (x1 > bx1) bx1 = x1; if (y1 > by1) by1 = y1;
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
    const ag = this.pal.agent;
    if (shields.length) {
      ctx.strokeStyle = ag.shielded; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let q = 0; q < shields.length; q += 2) { ctx.moveTo(shields[q] + mutS, shields[q + 1]); ctx.arc(shields[q], shields[q + 1], mutS, 0, TAU); }
      ctx.stroke();
    }
    if (giants.length) {
      ctx.fillStyle = ag.giant; ctx.strokeStyle = ag.outline; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let q = 0; q < giants.length; q += 2) { ctx.moveTo(giants[q] + giantS / 2, giants[q + 1]); ctx.arc(giants[q], giants[q + 1], giantS / 2, 0, TAU); }
      ctx.fill(); ctx.stroke();
    }
    this.stats.agents = total; this.stats.drawn = drawn;
  }

  _pixelColours() {
    if (this._pixCol && this._pixColPal === this.pal.name) return this._pixCol;
    const ag = this.pal.agent;
    const cols = [ag.civ, ag.civPanic, ag.turning, ag.zombie, ag.explosive, ag.shielded, ag.swimmer, ag.giant, ag.police, ag.militia, ag.soldier];
    this._pixCol = Uint32Array.from(cols, (hex) => { const [r, g, b] = hexToRgb(hex); return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; });
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
      const small = u.type === 'mine' || u.type === 'chemical' || u.type === 'napalm';
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
      const r = drawVehicleGlyph(ctx, v, sx, sy, z, pal, st.rt, col);
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
          const p = new Path2D(); for (const pp of e.polys) this._polyPath(p, pp, cam);
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
