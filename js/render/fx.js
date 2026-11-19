// Transient print effects drawn over the map in CSS-pixel space: projectiles, blasts as ink rings, gas clouds,
// collapse dust, aircraft silhouettes, nuke flash + shockwave, and client-side markers (outbreak stamps, deliveries).
import { rgba, FONT_MONO, FONT_LABEL } from './palette.js';
import { hash2 } from '../util/rng.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rnd = (a, b) => hash2(a, b) / 4294967296;

// ---------------------------------------------------------------- projectiles
export function drawProjectiles(ctx, world, cam, t, pal) {
  const list = world.projectiles;
  if (!list.length) return;
  const z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h;
  const fx = pal.fx;
  const tracers = new Path2D(), dots = new Path2D(), trails = new Path2D(), rails = [];
  let nT = 0, nD = 0, nR = 0;
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    const dur = p.dur || 0.05;
    const u = (t - p.t0) / dur;
    if (u < 0 || u > 1.05) continue;
    const ax = (p.x0 - ox) * z, ay = (p.y0 - oy) * z, bx = (p.x1 - ox) * z, by = (p.y1 - oy) * z;
    if (Math.max(ax, bx) < -20 || Math.min(ax, bx) > W + 20 || Math.max(ay, by) < -20 || Math.min(ay, by) > H + 20) continue;
    const q = clamp01(u);
    const hx = ax + (bx - ax) * q, hy = ay + (by - ay) * q;
    switch (p.kind) {
      case 'tracer': {
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const tl = Math.min(len, Math.max(6, 9 * z));
        const tx = hx - (bx - ax) / len * tl, ty = hy - (by - ay) / len * tl;
        tracers.moveTo(tx, ty); tracers.lineTo(hx, hy); nT++;
        break;
      }
      case 'rail': rails.push([ax, ay, bx, by, 1 - q]); nR++; break;
      case 'shell': case 'bomb': case 'rocket': case 'missile': default: {
        const lift = p.kind === 'shell' || p.kind === 'rocket' ? Math.sin(q * Math.PI) * Math.min(28, Math.hypot(bx - ax, by - ay) * 0.12) : 0;
        const r = p.kind === 'bomb' ? 1.5 + 2.5 * (1 - q) : p.kind === 'missile' ? 2.6 : 1.8;
        const sx = hx, sy = hy - lift;
        dots.moveTo(sx + r, sy); dots.arc(sx, sy, r, 0, TAU); nD++;
        if (p.kind === 'rocket' || p.kind === 'missile') {
          const q0 = clamp01(q - 0.12), tx = ax + (bx - ax) * q0, ty = ay + (by - ay) * q0 - Math.sin(q0 * Math.PI) * (p.kind === 'rocket' ? Math.min(28, Math.hypot(bx - ax, by - ay) * 0.12) : 0);
          trails.moveTo(tx, ty); trails.lineTo(sx, sy);
        }
        break;
      }
    }
  }
  ctx.save();
  ctx.lineCap = 'round';
  if (nT) { ctx.strokeStyle = fx.tracer; ctx.globalAlpha = 0.75; ctx.lineWidth = 1; ctx.stroke(tracers); }
  ctx.globalAlpha = 1;
  if (nD) {
    ctx.strokeStyle = rgba(pal.ink3, 0.6); ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.stroke(trails); ctx.setLineDash([]);
    ctx.fillStyle = fx.shell; ctx.fill(dots);
  }
  for (const [ax, ay, bx, by, a] of rails) {
    ctx.globalAlpha = 0.25 + 0.75 * a;
    ctx.strokeStyle = pal.carbon; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = pal.card; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- aircraft / vehicles silhouettes (local coords, facing +x)
export function planePath(ctx, s) {
  ctx.moveTo(1.0 * s, 0);
  ctx.lineTo(0.55 * s, -0.08 * s); ctx.lineTo(0.15 * s, -0.1 * s); ctx.lineTo(-0.1 * s, -0.95 * s); ctx.lineTo(-0.32 * s, -0.95 * s);
  ctx.lineTo(-0.22 * s, -0.12 * s); ctx.lineTo(-0.72 * s, -0.1 * s); ctx.lineTo(-0.9 * s, -0.38 * s); ctx.lineTo(-1.02 * s, -0.38 * s);
  ctx.lineTo(-0.95 * s, 0);
  ctx.lineTo(-1.02 * s, 0.38 * s); ctx.lineTo(-0.9 * s, 0.38 * s); ctx.lineTo(-0.72 * s, 0.1 * s); ctx.lineTo(-0.22 * s, 0.12 * s);
  ctx.lineTo(-0.32 * s, 0.95 * s); ctx.lineTo(-0.1 * s, 0.95 * s); ctx.lineTo(0.15 * s, 0.1 * s); ctx.lineTo(0.55 * s, 0.08 * s);
  ctx.closePath();
}

export function heliPath(ctx, s) {
  ctx.moveTo(0.55 * s, 0);
  ctx.ellipse(0.1 * s, 0, 0.45 * s, 0.22 * s, 0, 0, TAU);
  ctx.moveTo(-0.3 * s, -0.05 * s); ctx.lineTo(-1.05 * s, -0.04 * s); ctx.lineTo(-1.05 * s, 0.04 * s); ctx.lineTo(-0.3 * s, 0.05 * s); ctx.closePath();
  ctx.moveTo(-0.95 * s, -0.22 * s); ctx.lineTo(-0.88 * s, -0.22 * s); ctx.lineTo(-0.88 * s, 0.22 * s); ctx.lineTo(-0.95 * s, 0.22 * s); ctx.closePath();
}

export function drawAircraft(ctx, kind, sx, sy, ang, sizePx, pal, realT, alpha = 1) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.globalAlpha = alpha;
  // offset drop shadow (aircraft fly above the sheet)
  for (const pass of [0, 1]) {
    ctx.save();
    if (!pass) { ctx.translate(sizePx * 0.35, sizePx * 0.28); ctx.fillStyle = pal.buildingShadow; }
    else ctx.fillStyle = pal.ink;
    ctx.rotate(ang);
    ctx.beginPath();
    if (kind === 'heli' || kind === 'medevac') heliPath(ctx, sizePx); else planePath(ctx, sizePx);
    ctx.fill();
    ctx.restore();
  }
  if (kind === 'heli' || kind === 'medevac') {
    ctx.rotate(ang);
    ctx.strokeStyle = pal.ink2;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.lineDashOffset = -realT * 40;
    ctx.beginPath(); ctx.arc(0.1 * sizePx, 0, sizePx * 0.85, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    if (kind === 'medevac') {
      ctx.fillStyle = pal.card;
      const c = sizePx * 0.12;
      ctx.fillRect(0.1 * sizePx - c * 1.5, -c * 0.5, c * 3, c); ctx.fillRect(0.1 * sizePx - c * 0.5, -c * 1.5, c, c * 3);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- world effects
// Returns a full-screen flash alpha (nuke) for the caller to apply after everything else.
// labelFn(abilityId) -> display name for delivery markers.
export function drawEffects(ctx, world, cam, t, pal, realT, labelFn = null) {
  const list = world.effects;
  let flash = 0;
  if (!list.length) return flash;
  const z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h, fx = pal.fx;
  ctx.save();
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    const dur = e.dur || 0.6;
    const u = (t - e.t0) / dur;
    if (u < 0 || u > 1) continue;
    const sx = (e.x - ox) * z, sy = (e.y - oy) * z;
    const R = Math.max(2, (e.r || 10) * z);
    const far = e.kind === 'plane' || e.kind === 'nuke' || e.kind === 'heli' || (e.kind === 'drop' && e.x2 !== undefined);
    if (!far && (sx + R < -10 || sx - R > W + 10 || sy + R < -10 || sy - R > H + 10)) continue;
    const seed = (Math.round(e.x * 7) ^ Math.round(e.y * 13) ^ Math.round(e.t0 * 1000)) | 0;
    switch (e.kind) {
      case 'boom': case 'fireburst': {
        if (u < 0.22) {
          ctx.globalAlpha = (1 - u / 0.22) * 0.55;
          ctx.fillStyle = e.kind === 'fireburst' ? fx.fire : fx.boom;
          ctx.beginPath(); ctx.arc(sx, sy, R * (0.45 + u * 2), 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1 - u;
        ctx.strokeStyle = e.kind === 'fireburst' ? fx.fire : pal.ink;
        ctx.lineWidth = Math.max(1, 3 * (1 - u));
        ctx.beginPath(); ctx.arc(sx, sy, R * (0.25 + 0.75 * Math.sqrt(u)), 0, TAU); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(sx, sy, R * (0.15 + 1.05 * u), 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = e.kind === 'fireburst' ? fx.ember : pal.ink2;
        const n = Math.min(24, 6 + (R / 4) | 0);
        for (let j = 0; j < n; j++) {
          const a = rnd(seed, j) * TAU, d = R * (0.2 + 0.9 * rnd(seed, j + 99)) * (0.3 + u);
          ctx.fillRect(sx + Math.cos(a) * d - 1, sy + Math.sin(a) * d - 1, 2, 2);
        }
        break;
      }
      case 'flash': {
        const tone = e.tone === 'cure' ? pal.approve : e.tone === 'arms' ? pal.carbon : null;
        ctx.globalAlpha = (1 - u) * (tone ? 0.3 : 0.8);
        ctx.fillStyle = tone || fx.flash;
        ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.fill();
        if (tone) {
          ctx.globalAlpha = 1 - u; ctx.strokeStyle = tone; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(sx, sy, R * (0.85 + 0.15 * u), 0, TAU); ctx.stroke();
        }
        break;
      }
      case 'gas': {
        const fade = u < 0.1 ? u / 0.1 : u > 0.75 ? (1 - u) / 0.25 : 1;
        ctx.globalAlpha = fade;
        ctx.fillStyle = fx.gas;
        for (let j = 0; j < 9; j++) {
          const a = rnd(seed, j) * TAU, d = R * 0.55 * rnd(seed, j + 7);
          const drift = Math.sin(realT * 0.6 + j) * R * 0.04;
          ctx.beginPath(); ctx.arc(sx + Math.cos(a) * d + drift, sy + Math.sin(a) * d, R * (0.35 + 0.25 * rnd(seed, j + 3)), 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = fade * 0.8;
        ctx.strokeStyle = fx.gas; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'collapse': {
        const x2 = e.x2 !== undefined ? (e.x2 - ox) * z : sx, y2 = e.y2 !== undefined ? (e.y2 - oy) * z : sy;
        ctx.globalAlpha = (1 - u) * 0.85;
        ctx.fillStyle = pal.rubble;
        const n = Math.min(90, 20 + (R / 2) | 0);
        for (let j = 0; j < n; j++) {
          const f = rnd(seed, j), a = rnd(seed, j + 333) * TAU, d = R * 0.7 * rnd(seed, j + 77) * (0.5 + u);
          const px = sx + (x2 - sx) * f + Math.cos(a) * d, py = sy + (y2 - sy) * f + Math.sin(a) * d;
          const s = 1 + (j % 3);
          ctx.fillRect(px, py, s, s);
        }
        ctx.globalAlpha = (1 - u) * 0.5;
        ctx.strokeStyle = pal.ink2; ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
        ctx.beginPath(); ctx.arc((sx + x2) / 2, (sy + y2) / 2, R * (0.6 + 0.6 * u), 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      case 'splash': {
        ctx.strokeStyle = fx.splash; ctx.lineWidth = 1.2;
        for (let j = 0; j < 3; j++) {
          const q = clamp01(u * 1.3 - j * 0.15);
          if (q <= 0) continue;
          ctx.globalAlpha = 1 - q;
          ctx.beginPath(); ctx.arc(sx, sy, R * (0.3 + q), 0, TAU); ctx.stroke();
        }
        break;
      }
      case 'nuke': {
        const fl = u < 0.06 ? 1 : Math.max(0, 1 - (u - 0.06) / 0.2);
        flash = Math.max(flash, fl);
        const ring = R * Math.min(1, Math.sqrt(u * 1.6));
        ctx.globalAlpha = 0.18 * (1 - u);
        ctx.fillStyle = fx.boom;
        ctx.beginPath(); ctx.arc(sx, sy, R * 0.35 * (0.6 + 0.4 * Math.min(1, u * 4)), 0, TAU); ctx.fill();
        ctx.globalAlpha = 1 - u * 0.7;
        ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(2, 7 * (1 - u));
        ctx.beginPath(); ctx.arc(sx, sy, ring, 0, TAU); ctx.stroke();
        ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.arc(sx, sy, ring * 0.82, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        if (e.core) {
          ctx.globalAlpha = 0.5 * (1 - u); ctx.fillStyle = pal.ink;
          ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, e.core * z), 0, TAU); ctx.fill();
        }
        break;
      }
      case 'plane': case 'heli': {
        const x2 = e.x2 !== undefined ? (e.x2 - ox) * z : sx, y2 = e.y2 !== undefined ? (e.y2 - oy) * z : sy;
        const hx = sx + (x2 - sx) * u, hy = sy + (y2 - sy) * u;
        const ang = Math.atan2(y2 - sy, x2 - sx) || 0;
        const size = Math.max(e.kind === 'plane' ? 14 : 10, (e.kind === 'plane' ? 16 : 7) * z);
        const a = u < 0.08 ? u / 0.08 : u > 0.92 ? (1 - u) / 0.08 : 1;
        drawAircraft(ctx, e.kind, hx, hy, ang, size, pal, realT, a);
        break;
      }
      case 'drop': {
        if (e.ability && dur > 2.5) { deliveryMarker(ctx, e, sx, sy, R, t, realT, cam, pal, world, labelFn); break; }
        ctx.globalAlpha = 1 - u * 0.6;
        ctx.strokeStyle = pal.ink; ctx.fillStyle = pal.card; ctx.lineWidth = 1;
        const n = 6;
        for (let j = 0; j < n; j++) {
          const a = rnd(seed, j) * TAU, d = R * rnd(seed, j + 5);
          const px = sx + Math.cos(a) * d, py = sy + Math.sin(a) * d - (1 - u) * 18;
          const s = 3 + 3 * (1 - u);
          ctx.beginPath(); ctx.arc(px, py, s, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px - s, py); ctx.lineTo(px, py + s * 1.4); ctx.lineTo(px + s, py); ctx.stroke();
        }
        break;
      }
      default: {
        ctx.globalAlpha = 1 - u;
        ctx.strokeStyle = pal.ink; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, R * (0.4 + 0.6 * u), 0, TAU); ctx.stroke();
      }
    }
  }
  ctx.restore();
  return flash;
}

// Countdown crosshair for an ability that has been called but has not landed yet (a long 'drop' effect).
function deliveryMarker(ctx, e, sx, sy, R, t, rt, cam, pal, world, labelFn) {
  const left = Math.max(0, e.t0 + e.dur - t);
  const z = cam.zoom;
  const col = e.ability === 'nuke' ? pal.stamp : pal.carbon;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = col; ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]); ctx.lineDashOffset = -rt * 12;
  if (e.x2 !== undefined && e.y2 !== undefined && Number.isFinite(e.x2)) {
    const ex = (e.x2 - cam.x) * z, ey = (e.y2 - cam.y) * z;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.lineWidth = 1.25;
  }
  const rr = Math.max(9, R);
  ctx.beginPath(); ctx.arc(sx, sy, rr, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  const a = world.cfg.abilities[e.ability];
  if (e.ability === 'nuke' && a && a.coreFrac) { ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(sx, sy, Math.max(5, e.r * a.coreFrac * z), 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
  const k = Math.min(rr, 22);
  ctx.beginPath();
  ctx.moveTo(sx - k - 6, sy); ctx.lineTo(sx - k * 0.35, sy); ctx.moveTo(sx + k * 0.35, sy); ctx.lineTo(sx + k + 6, sy);
  ctx.moveTo(sx, sy - k - 6); ctx.lineTo(sx, sy - k * 0.35); ctx.moveTo(sx, sy + k * 0.35); ctx.lineTo(sx, sy + k + 6);
  ctx.stroke();
  const name = (labelFn ? labelFn(e.ability) : e.ability) || '';
  const tx = Math.min(cam.w - 150, Math.max(4, sx + Math.min(rr, 40) + 6)), ty = Math.min(cam.h - 20, Math.max(46, sy - Math.min(rr, 40) - 6));
  tag(ctx, `${name.toUpperCase()} ${left.toFixed(left < 10 ? 1 : 0)} S`, tx, ty, pal, col);
}

// ---------------------------------------------------------------- client-side markers
// kinds: 'outbreak' {x,y,r,label}, 'pulse' {x,y,ok}, 'alert' {x,y,label}; each has rt0 (real seconds) and dur.
// With lt0 the lifetime counts the session's live clock instead (real seconds while the battle runs), so pausing holds it.
const ageOf = (m, rt, lt) => (m.lt0 !== undefined ? lt - m.lt0 : rt - m.rt0);

export class Markers {
  constructor() { this.list = []; }
  clear() { this.list.length = 0; }
  add(m) { this.list.push(m); return m; }

  prune(rt, lt = rt) {
    this.list = this.list.filter((m) => ageOf(m, rt, lt) < (m.dur || 2));
  }

  draw(ctx, cam, t, rt, pal, lt = rt) {
    if (!this.list.length) return;
    const z = cam.zoom, ox = cam.x, oy = cam.y;
    ctx.save();
    for (const m of this.list) {
      const sx = (m.x - ox) * z, sy = (m.y - oy) * z;
      const shown = rt - m.rt0;
      if (m.kind === 'outbreak') {
        const age = ageOf(m, rt, lt), dur = m.dur || 12, a = Math.min(shown < 0.25 ? shown / 0.25 : 1, Math.max(0, 1 - (age - dur * 0.7) / (dur * 0.3)));
        const R = Math.max(14, m.r * z);
        ctx.globalAlpha = a;
        ctx.strokeStyle = pal.stamp; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, R - 5, 0, TAU); ctx.stroke();
        stampLabel(ctx, m.label || 'OUTBREAK', sx, sy - R - 12, pal.stamp, -0.06, 12);
      } else if (m.kind === 'pulse') {
        const u = (rt - m.rt0) / (m.dur || 0.45);
        ctx.globalAlpha = Math.max(0, 1 - u);
        ctx.strokeStyle = m.ok === false ? pal.stamp : pal.ink; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, 4 + u * 18, 0, TAU); ctx.stroke();
      } else if (m.kind === 'alert') {
        const age = ageOf(m, rt, lt), a = Math.max(0, Math.min(1, shown / 0.2, ((m.dur || 6) - age) / 1));
        ctx.globalAlpha = a;
        stampLabel(ctx, m.label, sx, sy, m.color || pal.stamp, m.rot ?? -0.05, m.size || 13);
      }
    }
    ctx.restore();
  }
}

// Small typewriter tag on a card background with an offset ink shadow.
export function tag(ctx, text, x, y, pal, color = null) {
  ctx.save();
  ctx.font = `600 11px ${FONT_MONO}`;
  const w = Math.ceil(ctx.measureText(text).width) + 8, h = 15;
  ctx.fillStyle = pal.ink; ctx.fillRect(x + 2, y + 2, w, h);
  ctx.fillStyle = pal.card; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color || pal.ink; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = color || pal.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(text, x + 4, y + h / 2 + 0.5);
  ctx.restore();
  return w;
}

// Rubber-stamp style label: double border, uppercase condensed caps, slight rotation.
export function stampLabel(ctx, text, x, y, color, rot = -0.05, size = 13) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.font = `700 ${size}px ${FONT_LABEL}`;
  const w = Math.ceil(ctx.measureText(text).width + text.length * size * 0.12) + 14, h = size + 10;
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = 2; ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = 0.8; ctx.strokeRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.12).toFixed(1)}px`;
  ctx.fillText(text, 0, 1);
  ctx.restore();
}
