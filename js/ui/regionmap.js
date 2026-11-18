// The campaign's regional plotting sheet: a fictional district drawn as a printed map.
// Sheet units: x 0..1.5, y 0..1 (the canvas box keeps a 3:2 aspect).
import { makeNoise2D, Rng } from '../util/rng.js';
import { getPalette, FONT_LABEL, FONT_MONO, mix, rgba } from '../render/palette.js';

export const SHEET_W = 1.5, SHEET_H = 1;

// City anchor points, in campaign order.
export const CITY_POS = {
  'millbrook': [0.30, 0.42],
  'port-ashby': [0.72, 0.795],
  'carrowmere': [0.515, 0.195],
  'halden-cross': [0.90, 0.36],
  'varra-isles': [1.19, 0.80],
  'new-corrigan': [1.275, 0.30],
};

const noise = makeNoise2D(9071);
const A = [0.50, 1.06], B = [1.56, 0.08];
const DIR = (() => { const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy); return [dx / l, dy / l]; })();
const NRM = [-DIR[1], DIR[0]]; // points to the sea (lower right)
const sideOf = (x, y) => (x - A[0]) * NRM[0] + (y - A[1]) * NRM[1]; // >0 sea side of the base line

function buildCoast() {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const pins = [['port-ashby', 0.022], ['new-corrigan', 0.02]].map(([id, gap]) => {
    const [x, y] = CITY_POS[id];
    const t = (x - A[0]) * DIR[0] + (y - A[1]) * DIR[1];
    return { t, off: sideOf(x, y) + gap };
  });
  const pts = [], offs = [];
  const N = 220;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * L;
    let off = noise.fbm(t * 4.2, 3.1, 4) * 0.075 + noise(t * 17, 8.4) * 0.012;
    for (const p of pins) {
      const w = Math.exp(-((t - p.t) ** 2) / (2 * 0.035 ** 2));
      off = off * (1 - w) + p.off * w;
    }
    offs.push(off);
    pts.push(A[0] + DIR[0] * t + NRM[0] * off, A[1] + DIR[1] * t + NRM[1] * off);
  }
  return { pts, offs, L };
}
const COAST = buildCoast();

// Signed distance-ish test: is (x, y) at sea?
export function isSea(x, y) {
  const t = (x - A[0]) * DIR[0] + (y - A[1]) * DIR[1];
  const k = Math.max(0, Math.min(COAST.offs.length - 1, Math.round((t / COAST.L) * (COAST.offs.length - 1))));
  return sideOf(x, y) > COAST.offs[k];
}

function coastPointNear(x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < COAST.pts.length; i += 2) {
    const d = (COAST.pts[i] - x) ** 2 + (COAST.pts[i + 1] - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return [COAST.pts[best], COAST.pts[best + 1]];
}

function blob(cx, cy, r, seed, n = 40, rough = 0.28) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + noise(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7 - seed) * rough + noise(Math.cos(a) * 5 + seed * 3, Math.sin(a) * 5) * rough * 0.35;
    out.push(cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * 0.9);
  }
  return out;
}

function meander(points, seed, amp = 0.018, steps = 14) {
  const out = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const [x0, y0] = points[s], [x1, y1] = points[s + 1];
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy), nx = -dy / l, ny = dx / l;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const w = Math.sin(t * Math.PI) * (s === 0 && i === 0 ? 0 : 1);
      const o = noise((s * steps + i) * 0.31 + seed, seed * 2.3) * amp * w;
      out.push([x0 + dx * t + nx * o, y0 + dy * t + ny * o]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

const LAKE = blob(0.60, 0.15, 0.058, 4.2, 48, 0.24);
const ISLANDS = [[1.155, 0.78, 0.048, 1], [1.248, 0.735, 0.03, 2], [1.235, 0.855, 0.036, 3], [1.09, 0.865, 0.02, 4], [1.315, 0.815, 0.019, 5], [1.34, 0.70, 0.012, 6]]
  .map(([x, y, r, s]) => blob(x, y, r, s * 1.9, 34, 0.32));
const LENNE = meander([[0.0, 0.29], [0.13, 0.33], [0.30, 0.425], [0.44, 0.55], [0.58, 0.69], coastPointNear(0.70, 0.83)], 1.3, 0.022);
const VARROW = meander([[0.80, -0.01], [0.86, 0.18], [0.905, 0.355], [0.97, 0.47], coastPointNear(1.05, 0.56)], 3.7, 0.02);
const BROOK = meander([[0.62, 0.21], [0.73, 0.29], [0.905, 0.36]], 6.1, 0.014, 10);
const WOODS = [[0.14, 0.66, 0.06], [0.44, 0.60, 0.045], [0.70, 0.30, 0.04], [1.06, 0.15, 0.05], [0.34, 0.84, 0.05], [0.20, 0.12, 0.045], [1.40, 0.11, 0.035], [0.95, 0.64, 0.03]]
  .map(([x, y, r], i) => blob(x, y, r, 10 + i, 30, 0.35));
const RAIL = [CITY_POS['millbrook'], [0.55, 0.36], CITY_POS['halden-cross'], [1.10, 0.30], CITY_POS['new-corrigan']];
const RAIL_BRANCH = [[0.55, 0.36], [0.64, 0.60], CITY_POS['port-ashby']];
const ROADS = [
  [CITY_POS['millbrook'], [0.41, 0.30], CITY_POS['carrowmere']],
  [CITY_POS['millbrook'], [0.50, 0.66], CITY_POS['port-ashby']],
  [CITY_POS['carrowmere'], [0.72, 0.24], CITY_POS['halden-cross']],
  [CITY_POS['halden-cross'], [1.04, 0.40], [1.18, 0.33], CITY_POS['new-corrigan']],
  [CITY_POS['port-ashby'], [0.86, 0.62], [0.96, 0.52], CITY_POS['halden-cross']],
  [CITY_POS['millbrook'], [0.12, 0.50], [-0.02, 0.56]],
  [CITY_POS['new-corrigan'], [1.42, 0.22], [1.53, 0.18]],
];
const FERRY = [CITY_POS['port-ashby'], [0.95, 0.86], CITY_POS['varra-isles']];

function pathPoly(g, p, s, ox, oy) {
  g.moveTo(p[0] * s + ox, p[1] * s + oy);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * s + ox, p[i + 1] * s + oy);
  g.closePath();
}
function pathLine(g, pts, s, ox, oy) {
  g.moveTo(pts[0][0] * s + ox, pts[0][1] * s + oy);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0] * s + ox, pts[i][1] * s + oy);
}

function hatchClip(g, w, h, step, color, lw, angle = 1) {
  g.beginPath();
  for (let x = -h; x < w + h; x += step) { g.moveTo(x, 0); g.lineTo(x + h * angle, h); }
  g.strokeStyle = color; g.lineWidth = lw; g.stroke();
}

// Renders the static sheet into ctx (CSS px space). cities: [{ id, name, state: 'locked'|'open'|'cleared', sizeKm }]
export function drawRegion(ctx, w, h, { palette = 'paper', cities = [], selected = null } = {}) {
  const pal = getPalette(palette);
  const M = 9;
  const s = Math.min((w - 2 * M) / SHEET_W, (h - 2 * M) / SHEET_H);
  const ox = (w - SHEET_W * s) / 2, oy = (h - SHEET_H * s) / 2;
  const X = x => x * s + ox, Y = y => y * s + oy;
  const g = ctx;
  g.save();
  g.fillStyle = pal.paper;
  g.fillRect(0, 0, w, h);
  g.save();
  g.beginPath();
  g.rect(X(0), Y(0), SHEET_W * s, SHEET_H * s);
  g.clip();

  // sea
  g.save();
  g.beginPath();
  g.moveTo(X(COAST.pts[0]), Y(COAST.pts[1]));
  for (let i = 2; i < COAST.pts.length; i += 2) g.lineTo(X(COAST.pts[i]), Y(COAST.pts[i + 1]));
  g.lineTo(X(1.7), Y(-0.1)); g.lineTo(X(1.7), Y(1.2)); g.lineTo(X(0.3), Y(1.2));
  g.closePath();
  g.fillStyle = pal.water;
  g.fill();
  g.clip();
  hatchClip(g, w, h, 7, rgba(pal.waterHatch, 0.55), 0.6);
  g.restore();

  // offshore depth lines (dotted parallel to the coast)
  g.save();
  g.setLineDash([1.2, 3.2]);
  g.strokeStyle = pal.waterLine;
  g.lineWidth = 0.8;
  for (const d of [0.035, 0.075]) {
    g.beginPath();
    for (let i = 0, k = 0; i < COAST.pts.length; i += 2, k++) {
      const x = COAST.pts[i] + NRM[0] * d, y = COAST.pts[i + 1] + NRM[1] * d;
      if (i === 0) g.moveTo(X(x), Y(y)); else g.lineTo(X(x), Y(y));
    }
    g.stroke();
  }
  g.restore();

  // coastline ink
  g.beginPath();
  g.moveTo(X(COAST.pts[0]), Y(COAST.pts[1]));
  for (let i = 2; i < COAST.pts.length; i += 2) g.lineTo(X(COAST.pts[i]), Y(COAST.pts[i + 1]));
  g.strokeStyle = pal.ink2;
  g.lineWidth = 1.3;
  g.stroke();

  // islands + lake
  for (const p of ISLANDS) {
    g.beginPath(); pathPoly(g, p, s, ox, oy);
    g.fillStyle = pal.paper; g.fill();
    g.strokeStyle = pal.ink2; g.lineWidth = 1.1; g.stroke();
  }
  g.save();
  g.beginPath(); pathPoly(g, LAKE, s, ox, oy);
  g.fillStyle = pal.water; g.fill();
  g.clip();
  hatchClip(g, w, h, 6, rgba(pal.waterHatch, 0.6), 0.6);
  g.restore();
  g.beginPath(); pathPoly(g, LAKE, s, ox, oy);
  g.strokeStyle = pal.ink2; g.lineWidth = 1.1; g.stroke();

  // woods (stippled)
  const rng = new Rng(77);
  for (const p of WOODS) {
    g.save();
    g.beginPath(); pathPoly(g, p, s, ox, oy);
    g.fillStyle = rgba(pal.park, 0.55); g.fill();
    g.clip();
    g.fillStyle = pal.parkMark;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 2) { bb[0] = Math.min(bb[0], p[i]); bb[1] = Math.min(bb[1], p[i + 1]); bb[2] = Math.max(bb[2], p[i]); bb[3] = Math.max(bb[3], p[i + 1]); }
    for (let k = 0; k < 90; k++) {
      const x = X(rng.range(bb[0], bb[2])), y = Y(rng.range(bb[1], bb[3]));
      g.beginPath(); g.arc(x, y, 1.1, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    g.beginPath(); pathPoly(g, p, s, ox, oy);
    g.setLineDash([2, 2]); g.strokeStyle = pal.parkLine; g.lineWidth = 0.8; g.stroke(); g.setLineDash([]);
  }

  // hill contours in the north-west
  g.strokeStyle = rgba(pal.ink2, 0.42);
  g.lineWidth = 0.75;
  const hills = [[0.09, 0.11, 0.075, 1], [0.22, 0.21, 0.05, 2], [0.06, 0.30, 0.04, 3], [0.33, 0.075, 0.045, 4], [1.42, 0.06, 0.04, 5]];
  for (const [hx, hy, hr, sd] of hills) {
    for (let ring = 1; ring <= 4; ring++) {
      const rr = hr * (ring / 4);
      g.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const wob = 1 + noise(Math.cos(a) * 1.3 + sd * 7, Math.sin(a) * 1.3 + ring * 0.6) * 0.32;
        const x = X(hx + Math.cos(a) * rr * wob), y = Y(hy + Math.sin(a) * rr * wob * 0.78);
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      if (ring === 4) { g.setLineDash([]); g.lineWidth = 1; } else { g.setLineDash(ring === 1 ? [1.5, 2] : []); g.lineWidth = 0.7; }
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = pal.ink2;
    g.beginPath(); g.moveTo(X(hx), Y(hy) - 3); g.lineTo(X(hx) + 3, Y(hy) + 2); g.lineTo(X(hx) - 3, Y(hy) + 2); g.closePath(); g.fill();
  }

  // rivers
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [pts, wd] of [[LENNE, 2.6], [VARROW, 2.4], [BROOK, 1.4]]) {
    g.beginPath(); pathLine(g, pts, s, ox, oy);
    g.strokeStyle = pal.waterLine; g.lineWidth = wd + 1.4; g.stroke();
    g.beginPath(); pathLine(g, pts, s, ox, oy);
    g.strokeStyle = pal.water; g.lineWidth = wd; g.stroke();
  }

  // roads (cased)
  for (const r of ROADS) {
    g.beginPath(); pathLine(g, r, s, ox, oy);
    g.strokeStyle = pal.majorCasing; g.lineWidth = 3.2; g.stroke();
    g.beginPath(); pathLine(g, r, s, ox, oy);
    g.strokeStyle = pal.road; g.lineWidth = 1.6; g.stroke();
  }
  // ferry
  g.beginPath(); pathLine(g, FERRY, s, ox, oy);
  g.setLineDash([5, 4]); g.strokeStyle = pal.ink2; g.lineWidth = 0.9; g.stroke(); g.setLineDash([]);

  // railway with ties
  for (const r of [RAIL, RAIL_BRANCH]) {
    g.beginPath(); pathLine(g, r, s, ox, oy);
    g.strokeStyle = pal.rail; g.lineWidth = 1.4; g.stroke();
    for (let i = 0; i + 1 < r.length; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[i + 1];
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(L / 0.012);
      const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
      g.beginPath();
      for (let k = 1; k < n; k++) {
        const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        g.moveTo(X(x) - nx * 3, Y(y) - ny * 3); g.lineTo(X(x) + nx * 3, Y(y) + ny * 3);
      }
      g.lineWidth = 0.8; g.stroke();
    }
  }

  // causeways between islands
  g.strokeStyle = pal.majorCasing;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(X(1.19), Y(0.79)); g.lineTo(X(1.245), Y(0.745));
  g.moveTo(X(1.19), Y(0.80)); g.lineTo(X(1.232), Y(0.85));
  g.moveTo(X(1.15), Y(0.80)); g.lineTo(X(1.095), Y(0.862));
  g.moveTo(X(1.26), Y(0.855)); g.lineTo(X(1.31), Y(0.818));
  g.stroke();

  // city footprints
  for (const c of cities) {
    const pos = CITY_POS[c.id];
    if (!pos) continue;
    const r = 0.012 + (c.sizeKm || 1) * 0.0085;
    const cr = new Rng(c.id.length * 997 + c.id.charCodeAt(0));
    g.fillStyle = c.state === 'locked' ? rgba(pal.ink3, 0.55) : mix(pal.building, pal.ink2, 0.45);
    for (let k = 0; k < 18 + (c.sizeKm || 1) * 16; k++) {
      const a = cr.range(0, Math.PI * 2), d = Math.sqrt(cr.next()) * r;
      const x = pos[0] + Math.cos(a) * d, y = pos[1] + Math.sin(a) * d * 0.85;
      if (isSea(x, y) && c.id !== 'varra-isles') continue;
      const bw = cr.range(1.4, 3.6), bh = cr.range(1.4, 3.2);
      g.fillRect(X(x) - bw / 2, Y(y) - bh / 2, bw, bh);
    }
  }

  // campaign route
  for (let i = 0; i + 1 < cities.length; i++) {
    const a = CITY_POS[cities[i].id], b = CITY_POS[cities[i + 1].id];
    if (!a || !b) continue;
    const open = cities[i + 1].state !== 'locked';
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    const bend = 0.05 * (i % 2 ? 1 : -1);
    const cx = mx - dy / L * bend, cy = my + dx / L * bend;
    g.beginPath();
    g.moveTo(X(a[0]), Y(a[1]));
    g.quadraticCurveTo(X(cx), Y(cy), X(b[0]), Y(b[1]));
    g.setLineDash(open ? [7, 4] : [2, 4]);
    g.strokeStyle = open ? pal.stamp : pal.ink3;
    g.lineWidth = open ? 1.6 : 1.1;
    g.stroke();
    g.setLineDash([]);
    if (open) { // arrow head at 62% of the curve
      const t = 0.62, it = 1 - t;
      const px = it * it * a[0] + 2 * it * t * cx + t * t * b[0], py = it * it * a[1] + 2 * it * t * cy + t * t * b[1];
      const tx = 2 * it * (cx - a[0]) + 2 * t * (b[0] - cx), ty = 2 * it * (cy - a[1]) + 2 * t * (b[1] - cy);
      const tl = Math.hypot(tx, ty), ux = tx / tl, uy = ty / tl;
      g.beginPath();
      g.moveTo(X(px) + ux * 6, Y(py) + uy * 6);
      g.lineTo(X(px) - ux * 4 - uy * 4, Y(py) - uy * 4 + ux * 4);
      g.lineTo(X(px) - ux * 4 + uy * 4, Y(py) - uy * 4 - ux * 4);
      g.closePath();
      g.fillStyle = pal.stamp;
      g.fill();
    }
  }

  // graticule + labels
  g.strokeStyle = pal.grid;
  g.lineWidth = 0.7;
  g.beginPath();
  for (let i = 1; i < 15; i++) { g.moveTo(X(i * 0.1), Y(0)); g.lineTo(X(i * 0.1), Y(1)); }
  for (let j = 1; j < 10; j++) { g.moveTo(X(0), Y(j * 0.1)); g.lineTo(X(1.5), Y(j * 0.1)); }
  g.stroke();
  g.fillStyle = pal.gridLabel;
  g.font = `500 9px ${FONT_MONO}`;
  g.textBaseline = 'top';
  for (let i = 0; i < 15; i++) g.fillText(String.fromCharCode(65 + i), X(i * 0.1 + 0.05) - 3, Y(0) + 4);
  for (let j = 0; j < 10; j++) g.fillText(String(j + 1), X(0) + 4, Y(j * 0.1 + 0.05) - 5);

  // labels: water bodies
  const spaced = (txt, x, y, size, color, italic = true, track = 4) => {
    g.save();
    g.font = `${italic ? 'italic ' : ''}500 ${size}px ${FONT_MONO}`;
    g.fillStyle = color;
    g.textBaseline = 'middle';
    let total = 0;
    for (const ch of txt) total += g.measureText(ch).width + track;
    let cx = X(x) - total / 2;
    for (const ch of txt) { g.fillText(ch, cx, Y(y)); cx += g.measureText(ch).width + track; }
    g.restore();
  };
  spaced('VARROW SOUND', 1.29, 0.60, 12, pal.waterLine, true, 6);
  spaced('THE NARROWS', 0.92, 0.94, 9, pal.waterLine, true, 4);
  spaced('LOUGH CARROW', 0.61, 0.08, 8, pal.waterLine, true, 2);
  spaced('R. LENNE', 0.47, 0.6, 8, pal.waterLine, true, 2);
  spaced('R. VARROW', 0.93, 0.15, 8, pal.waterLine, true, 2);
  spaced('BRAEMOOR HILLS', 0.14, 0.035, 8, pal.ink3, false, 3);

  // compass
  const cX = X(1.42), cY = Y(0.46), R = 22;
  g.strokeStyle = pal.ink; g.lineWidth = 1;
  g.beginPath(); g.arc(cX, cY, R, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(cX, cY, R - 4, 0, Math.PI * 2); g.setLineDash([1, 2]); g.stroke(); g.setLineDash([]);
  g.beginPath(); g.moveTo(cX, cY - R - 8); g.lineTo(cX + 5, cY); g.lineTo(cX, cY + R - 4); g.lineTo(cX - 5, cY); g.closePath();
  g.fillStyle = pal.card; g.fill(); g.stroke();
  g.beginPath(); g.moveTo(cX, cY - R - 8); g.lineTo(cX + 5, cY); g.lineTo(cX, cY); g.closePath(); g.fillStyle = pal.ink; g.fill();
  g.font = `700 11px ${FONT_LABEL}`; g.fillStyle = pal.ink; g.textAlign = 'center'; g.textBaseline = 'bottom';
  g.fillText('N', cX, cY - R - 9);
  g.textAlign = 'left';

  // scale bar
  const sx = X(1.12), sy = Y(0.965), seg = 0.05 * s;
  for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? pal.card : pal.ink; g.fillRect(sx + k * seg, sy - 4, seg, 4); }
  g.strokeStyle = pal.ink; g.lineWidth = 1; g.strokeRect(sx + 0.5, sy - 4.5, seg * 4, 4);
  g.fillStyle = pal.ink; g.font = `500 9px ${FONT_MONO}`; g.textBaseline = 'bottom';
  g.fillText('0', sx - 2, sy - 6); g.fillText('20 km', sx + seg * 4 - 10, sy - 6);

  g.restore();
  // frame
  g.strokeStyle = pal.ink; g.lineWidth = 1;
  g.strokeRect(X(0) + 0.5, Y(0) + 0.5, SHEET_W * s - 1, SHEET_H * s - 1);
  g.lineWidth = 3;
  g.strokeRect(X(0) - 4, Y(0) - 4, SHEET_W * s + 8, SHEET_H * s + 8);
  g.restore();
  return { s, ox, oy };
}

// Pixel position of a city marker for the transform drawRegion returned.
export function cityPixel(id, t) {
  const p = CITY_POS[id] || [0.75, 0.5];
  return [p[0] * t.s + t.ox, p[1] * t.s + t.oy];
}
