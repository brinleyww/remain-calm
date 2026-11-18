// Boats on the plotting sheet: hull plan with a pointed bow along the heading, deck marks, a short wake when under
// way, a plain glyph at far zoom; toolbar glyphs; and the water-body tint used by the placement preview.
import { DEFAULTS } from '../data/config.js';
import { hexToRgb } from './palette.js';

const TAU = Math.PI * 2;
export const BOAT_TYPES = new Set(['patrolBoat', 'gunboat', 'rocketBarge', 'ferry']);

// Hull outline in local coordinates (bow toward +x), length L and beam B in px.
function hullPath(ctx, kind, L, B) {
  const h = L / 2, b = B / 2;
  ctx.beginPath();
  if (kind === 'rocketBarge') {
    ctx.moveTo(h, -b * 0.45); ctx.lineTo(h - b * 0.8, -b); ctx.lineTo(-h, -b); ctx.lineTo(-h, b); ctx.lineTo(h - b * 0.8, b); ctx.lineTo(h, b * 0.45);
  } else if (kind === 'ferry') {
    ctx.moveTo(h, 0); ctx.quadraticCurveTo(h * 0.7, -b, h * 0.3, -b); ctx.lineTo(-h * 0.85, -b);
    ctx.quadraticCurveTo(-h, -b, -h, -b * 0.6); ctx.lineTo(-h, b * 0.6); ctx.quadraticCurveTo(-h, b, -h * 0.85, b);
    ctx.lineTo(h * 0.3, b); ctx.quadraticCurveTo(h * 0.7, b, h, 0);
  } else {
    ctx.moveTo(h, 0); ctx.quadraticCurveTo(h * 0.3, -b * 1.1, -h * 0.3, -b); ctx.lineTo(-h, -b * 0.8);
    ctx.lineTo(-h, b * 0.8); ctx.lineTo(-h * 0.3, b); ctx.quadraticCurveTo(h * 0.3, b * 1.1, h, 0);
  }
  ctx.closePath();
}

// Deck marks in local coordinates. aim = turret angle relative to the hull (radians) or null.
function deckMarks(ctx, kind, L, B, color, paper, aim) {
  const h = L / 2, b = B / 2, lw = Math.max(1, B * 0.12);
  ctx.fillStyle = color; ctx.strokeStyle = color;
  const gun = (x, r, len) => {
    ctx.beginPath(); ctx.arc(x, 0, r, 0, TAU); ctx.fill();
    const a = aim ?? 0;
    ctx.lineWidth = Math.max(1, r * 0.7);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + Math.cos(a) * len, Math.sin(a) * len); ctx.stroke();
  };
  if (kind === 'patrolBoat') {
    ctx.fillRect(-h * 0.45, -b * 0.5, h * 0.55, b);
    gun(h * 0.42, Math.max(1, b * 0.32), b * 1.3);
  } else if (kind === 'gunboat') {
    ctx.fillRect(-h * 0.35, -b * 0.55, h * 0.45, b * 1.1);
    ctx.fillStyle = paper; ctx.beginPath(); ctx.arc(h * 0.42, 0, b * 0.62, 0, TAU); ctx.fill();
    ctx.fillStyle = color; ctx.lineWidth = lw; ctx.stroke();
    gun(h * 0.42, b * 0.3, b * 1.7);
    ctx.beginPath(); ctx.arc(-h * 0.68, 0, Math.max(0.8, b * 0.22), 0, TAU); ctx.fill();
  } else if (kind === 'rocketBarge') {
    ctx.save(); ctx.translate(h * 0.05, 0); ctx.rotate(aim ?? 0);
    ctx.fillStyle = paper; ctx.fillRect(-b * 0.9, -b * 0.62, b * 1.8, b * 1.24);
    ctx.lineWidth = lw; ctx.strokeRect(-b * 0.9, -b * 0.62, b * 1.8, b * 1.24);
    ctx.fillStyle = color;
    const r = Math.max(0.7, b * 0.13);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { ctx.beginPath(); ctx.arc(-b * 0.5 + i * b * 0.5, -b * 0.28 + j * b * 0.56, r, 0, TAU); ctx.fill(); }
    ctx.restore();
    ctx.fillRect(-h * 0.88, -b * 0.55, h * 0.22, b * 1.1);
  } else if (kind === 'ferry') {
    ctx.fillStyle = paper; ctx.lineWidth = lw;
    ctx.fillRect(-h * 0.55, -b * 0.62, h * 1.0, b * 1.24); ctx.strokeRect(-h * 0.55, -b * 0.62, h * 1.0, b * 1.24);
    ctx.fillStyle = color;
    const n = 5, w = (h * 1.0) / n;
    for (let k = 0; k < n; k++) ctx.fillRect(-h * 0.55 + k * w + w * 0.3, -b * 0.62, w * 0.4, Math.max(1, b * 0.2));
    ctx.beginPath(); ctx.moveTo(h * 0.62, -b * 0.35); ctx.lineTo(h * 0.62, b * 0.35); ctx.lineWidth = lw * 1.4; ctx.stroke();
  }
}

// Toolbar / cursor symbol for a boat or water mine, centred at the current origin, half-size s.
export function drawNavalGlyph(ctx, type, s, color, paper, ang = 0) {
  if (type === 'waterMine') {
    const r = s * 0.42;
    ctx.lineWidth = Math.max(1, s * 0.18);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a) * r * 1.75, Math.sin(a) * r * 1.75); }
    ctx.stroke();
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.beginPath(); ctx.moveTo(-s, s * 0.95); ctx.quadraticCurveTo(-s * 0.5, s * 0.7, 0, s * 0.95); ctx.quadraticCurveTo(s * 0.5, s * 1.2, s, s * 0.95); ctx.stroke();
    return;
  }
  const [l, b] = (DEFAULTS.units[type] && DEFAULTS.units[type].size) || [16, 5];
  const L = s * 3.4, B = L * b / l * 1.25;
  ctx.rotate(ang);
  hullPath(ctx, type, L, B);
  ctx.fillStyle = paper; ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.16); ctx.strokeStyle = color; ctx.stroke();
  deckMarks(ctx, type, L, B, color, paper, null);
}

// A placed boat at screen (sx, sy). Returns the radius (px) the caller hangs the HP bar and tags under.
export function drawBoat(ctx, v, sx, sy, z, pal, col, world) {
  const kind = v.kind, L = (v.len || 16) * z, B = (v.beam || 5) * z, ang = v.heading || 0;
  ctx.save();
  ctx.translate(sx, sy);
  if (L < 11) {
    // far zoom: a fixed-size hull plan so a boat still reads on the whole-city view
    const s = 5;
    ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(s * 1.6, 0); ctx.lineTo(-s, -s * 0.75); ctx.lineTo(-s * 0.55, 0); ctx.lineTo(-s, s * 0.75); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = pal.card; ctx.stroke();
    if (v.spd > 0.6) {
      ctx.strokeStyle = pal.fx.splash; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-s * 1.2, 0); ctx.lineTo(-s * 1.2 - Math.min(10, v.spd * 1.2), 0); ctx.stroke();
    }
    ctx.restore();
    return 7;
  }
  ctx.rotate(ang);
  if (v.spd > 0.6) {
    // wake: two diverging lines and a centre streak off the stern, longer at speed
    const len = Math.min(2.2, 0.35 + v.spd / 6) * L * 0.8, h = L / 2, b = B / 2;
    ctx.strokeStyle = pal.fx.splash; ctx.lineWidth = Math.max(1, z * 0.6);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(-h, -b * 0.7); ctx.lineTo(-h - len, -b * 0.7 - len * 0.32);
    ctx.moveTo(-h, b * 0.7); ctx.lineTo(-h - len, b * 0.7 + len * 0.32);
    ctx.stroke();
    ctx.setLineDash([Math.max(2, 2 * z), Math.max(2, 2.5 * z)]);
    ctx.beginPath(); ctx.moveTo(-h, 0); ctx.lineTo(-h - len * 0.75, 0); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  // offset print shadow, then hull
  ctx.save(); ctx.translate(1.5, 1.5); hullPath(ctx, kind, L, B); ctx.fillStyle = pal.buildingShadow; ctx.fill(); ctx.restore();
  hullPath(ctx, kind, L, B);
  ctx.fillStyle = pal.card; ctx.fill();
  ctx.lineWidth = Math.max(1, Math.min(2.2, z * 0.7)); ctx.strokeStyle = col; ctx.stroke();
  let aim = null;
  if (Number.isFinite(v.ax) && world && world.t - v.fireT < 4) aim = Math.atan2(v.ay - v.y, v.ax - v.x) - ang;
  deckMarks(ctx, kind, L, B, col, pal.card, aim);
  ctx.restore();
  const lv = v.unit ? v.unit.level || 1 : 1;
  if (lv > 1) {
    ctx.fillStyle = col;
    const top = sy - Math.max(L, B) * 0.5 - 6;
    for (let k = 0; k < lv; k++) ctx.fillRect(sx - (lv * 3 - 1) / 2 + k * 3, top, 2, 3);
  }
  if (v.hitT !== undefined && world && world.t - v.hitT < 0.3) {
    ctx.strokeStyle = pal.stamp; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, Math.max(L, B) * 0.55 + 2, 0, TAU); ctx.stroke();
  }
  return Math.max(7, Math.min(L * 0.5, 40));
}

// Tint the cells of water body k (placement preview). Cached per grid, body and colour.
const TINT = new WeakMap();
export function drawWaterBody(ctx, world, cam, k, color, alpha = 0.32) {
  const N = world.combat && world.combat.naval;
  if (!N || !k || !N.bbox[k] || typeof document === 'undefined') return;
  let m = TINT.get(N);
  if (!m) TINT.set(N, m = new Map());
  const key = k + '|' + color;
  let e = m.get(key);
  if (!e) {
    const [x0, y0, x1, y1] = N.bbox[k], w = x1 - x0 + 1, h = y1 - y0 + 1;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), img = g.createImageData(w, h), d = img.data, [r, gg, b] = hexToRgb(color), gw = N.gw;
    for (let j = N.start[k]; j < N.end[k]; j++) {
      const c = N.cells[j], p = (((c / gw) | 0) - y0) * w + (c % gw) - x0;
      d[p * 4] = r; d[p * 4 + 1] = gg; d[p * 4 + 2] = b; d[p * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    e = { cv, x0, y0 };
    if (m.size > 8) m.clear();
    m.set(key, e);
  }
  const z = cam.zoom, cs = N.cs;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(e.cv, (e.x0 * cs - cam.x) * z, (e.y0 * cs - cam.y) * z, e.cv.width * cs * z, e.cv.height * cs * z);
  ctx.restore();
}

