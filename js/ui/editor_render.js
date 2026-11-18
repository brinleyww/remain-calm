// Editor drawing: keeps the static map cache in step with edits and draws the drafting overlays
// (selection, handles, outbreak points, stage labels, previews) in screen space on top of drawStatic.
import { makeStaticCache, getStaticCache } from '../render/maprender.js';
import { FONT_MONO, FONT_LABEL, rgba } from '../render/palette.js';
import { polyBBox } from '../util/geom.js';

const now = () => performance.now();

// Re-indexes the map after edits. Cached tiles outside the edited rectangles are kept, so an edit on a
// large city only redraws the tiles it touched instead of the whole sheet.
export function refreshCache(map, rects, full) {
  const t0 = now();
  const old = getStaticCache(map);
  const fresh = makeStaticCache(map, null);
  const reuse = !full && old && old !== fresh && old.style && old.iw === fresh.iw && old.ih === fresh.ih && rects && rects.length;
  if (reuse) {
    const st = old.style;
    fresh.setStyle(st.pal, st.view, st.px);
    fresh.tiles = old.tiles;
    fresh.pool = old.pool;
    fresh.bi = old.bi;
    fresh.prevBi = old.prevBi;
    fresh.overviews = old.overviews;
    fresh.frame = old.frame;
    fresh.maxTiles = old.maxTiles;
    for (const r of rects) fresh.invalidate([r[0] - 8, r[1] - 8, r[2] + 8, r[3] + 8]);
  }
  return now() - t0;
}

// ---------------------------------------------------------------- screen-space path helpers

export function tracePath(ctx, cam, p, closed) {
  if (!p || p.length < 2) return;
  ctx.moveTo((p[0] - cam.x) * cam.zoom, (p[1] - cam.y) * cam.zoom);
  for (let k = 2; k < p.length; k += 2) ctx.lineTo((p[k] - cam.x) * cam.zoom, (p[k + 1] - cam.y) * cam.zoom);
  if (closed) ctx.closePath();
}

export function handle(ctx, sx, sy, pal, opts = {}) {
  const s = opts.size || 7;
  ctx.fillStyle = opts.fill || pal.card;
  ctx.strokeStyle = opts.stroke || pal.ink;
  ctx.lineWidth = 1;
  if (opts.round) {
    ctx.beginPath();
    ctx.arc(sx, sy, s / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(Math.round(sx - s / 2), Math.round(sy - s / 2), s, s);
    ctx.strokeRect(Math.round(sx - s / 2) + 0.5, Math.round(sy - s / 2) + 0.5, s - 1, s - 1);
  }
}

export function label(ctx, text, sx, sy, pal, opts = {}) {
  ctx.font = opts.font || `600 11px ${FONT_MONO}`;
  const w = ctx.measureText(text).width + 10, h = 17;
  let x = sx + (opts.dx ?? 12), y = sy + (opts.dy ?? -22);
  if (opts.center) x = sx - w / 2;
  ctx.fillStyle = opts.bg || pal.card;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), h);
  ctx.strokeStyle = opts.edge || pal.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, h - 1);
  ctx.fillStyle = opts.color || pal.ink;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, Math.round(x) + 5, Math.round(y) + h / 2 + 0.5);
}

export const fmtM = m => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(m < 100 ? 1 : 0) + ' m');
export const fmtM2 = a => (a >= 1e5 ? (a / 1e6).toFixed(3) + ' km²' : Math.round(a).toLocaleString('en-GB') + ' m²');

// Outline of one item in screen space (roads as their casing).
export function outlineItem(ctx, cam, coll, it, color, width = 2) {
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (coll === 'spawns') {
    const sx = (it[0] - cam.x) * cam.zoom, sy = (it[1] - cam.y) * cam.zoom;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(sx, sy, 13, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  tracePath(ctx, cam, it.p, coll !== 'roads');
  if (coll === 'roads') {
    ctx.lineWidth = Math.max(3, it.w * cam.zoom + 5);
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = width;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

export function vertexHandles(ctx, cam, coll, it, pal, hotK = -1) {
  const p = it.p;
  for (let k = 0; k < p.length; k += 2) {
    const sx = (p[k] - cam.x) * cam.zoom, sy = (p[k + 1] - cam.y) * cam.zoom;
    const end = coll === 'roads' && (k === 0 || k === p.length - 2);
    handle(ctx, sx, sy, pal, { size: k === hotK ? 10 : 7, fill: k === hotK ? pal.select : pal.card, round: coll === 'roads' && !end });
  }
}

// Outbreak hint marker: a stamped crosshair ring with its number.
export function drawSpawn(ctx, cam, s, i, pal, opts = {}) {
  const sx = (s[0] - cam.x) * cam.zoom, sy = (s[1] - cam.y) * cam.zoom;
  const c = opts.color || pal.stamp;
  if (opts.radius) {
    ctx.save();
    ctx.strokeStyle = rgba(c, 0.55);
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(14, opts.radius * cam.zoom), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = pal.card;
  ctx.beginPath();
  ctx.arc(sx, sy, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = c;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 13, sy); ctx.lineTo(sx - 4, sy);
  ctx.moveTo(sx + 4, sy); ctx.lineTo(sx + 13, sy);
  ctx.moveTo(sx, sy - 13); ctx.lineTo(sx, sy - 4);
  ctx.moveTo(sx, sy + 4); ctx.lineTo(sx, sy + 13);
  ctx.stroke();
  ctx.fillStyle = c;
  ctx.font = `700 10px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(i + 1), sx + 9, sy - 8);
}

// "STAGE n  label" tag at the top of each stage boundary.
export function drawStageTags(ctx, cam, map, active, pal) {
  const L = map.levels || [];
  ctx.font = `700 11px ${FONT_LABEL}`;
  for (let k = 0; k < L.length; k++) {
    const p = L[k].p;
    if (!p || p.length < 6) continue;
    let bi = 0;
    for (let j = 2; j < p.length; j += 2) if (p[j + 1] < p[bi + 1] || (p[j + 1] === p[bi + 1] && p[j] < p[bi])) bi = j;
    let sx = (p[bi] - cam.x) * cam.zoom, sy = (p[bi + 1] - cam.y) * cam.zoom;
    if (sx < -60 || sy < -30 || sx > cam.w + 60 || sy > cam.h + 30) {
      const b = polyBBox(p);
      sx = Math.min(Math.max((b[0] - cam.x) * cam.zoom + 6, 6), cam.w - 120);
      sy = Math.min(Math.max((b[1] - cam.y) * cam.zoom, 20), cam.h - 10);
    }
    const text = `STAGE ${k + 1}${L[k].label ? ' · ' + L[k].label.toUpperCase() : ''}`;
    const w = ctx.measureText(text).width + 12;
    const x = Math.round(sx - w / 2), y = Math.round(sy - 22);
    const on = k === active;
    ctx.fillStyle = on ? pal.ink : pal.card;
    ctx.fillRect(x, y, Math.round(w), 16);
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.round(w) - 1, 15);
    ctx.fillStyle = on ? pal.card : pal.ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 6, y + 8.5);
  }
}

// Numbered pins for validation issues.
export function drawIssuePins(ctx, cam, issues, pal) {
  ctx.font = `700 10px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  issues.forEach((it, i) => {
    if (!it.at) return;
    const sx = (it.at[0] - cam.x) * cam.zoom, sy = (it.at[1] - cam.y) * cam.zoom;
    if (sx < -20 || sy < -20 || sx > cam.w + 20 || sy > cam.h + 20) return;
    const c = it.level === 'error' ? pal.stamp : pal.amber;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - 7, sy - 12);
    ctx.lineTo(sx + 7, sy - 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(sx - 9, sy - 28, 18, 16);
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 8.5, sy - 27.5, 17, 15);
    ctx.fillStyle = pal.card;
    ctx.fillText(String(i + 1), sx, sy - 19.5);
  });
}

export function drawSnap(ctx, cam, snap, pal) {
  if (!snap) return;
  const sx = (snap.x - cam.x) * cam.zoom, sy = (snap.y - cam.y) * cam.zoom;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(Math.PI / 4);
  ctx.lineWidth = 3;
  ctx.strokeStyle = pal.card;
  ctx.strokeRect(-5, -5, 10, 10);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = snap.kind === 'edge' ? pal.amber : pal.select;
  ctx.strokeRect(-5, -5, 10, 10);
  ctx.restore();
}
