// Geometry helpers. Polygons and polylines are FLAT arrays: [x0,y0,x1,y1,...] in meters.
// Polygons are implicitly closed (last point != first point).

export function polyArea(p) { // absolute area
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a) * 0.5;
}

export function polySignedArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a * 0.5;
}

export function polyCentroid(p) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = p[i] * p[j + 1] - p[j] * p[i + 1];
    a += f; cx += (p[i] + p[j]) * f; cy += (p[i + 1] + p[j + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) { // degenerate: average
    let sx = 0, sy = 0; const k = p.length / 2;
    for (let i = 0; i < p.length; i += 2) { sx += p[i]; sy += p[i + 1]; }
    return [sx / k, sy / k];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function polyPerimeter(p, closed = true) {
  let s = 0;
  const n = p.length;
  const last = closed ? n : n - 2;
  for (let i = 0; i < last; i += 2) {
    const j = (i + 2) % n;
    s += Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
  }
  return s;
}

export function polyBBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function pointInPoly(p, x, y) {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolyline(p, x, y, closed = false) {
  let best = Infinity;
  const n = p.length;
  const last = closed ? n : n - 2;
  for (let i = 0; i < last; i += 2) {
    const j = (i + 2) % n;
    const d = distToSeg(x, y, p[i], p[i + 1], p[j], p[j + 1]);
    if (d < best) best = d;
  }
  return best;
}

export function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) { // returns t along AB or -1
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : -1;
}

// Scanline-fill a polygon onto a grid. cb(cellIndex, cx, cy) is called for every cell whose CENTER is inside.
export function rasterPoly(p, cell, gw, gh, cb) {
  const [x0, y0, x1, y1] = polyBBox(p);
  const cy0 = Math.max(0, Math.floor(y0 / cell)), cy1 = Math.min(gh - 1, Math.floor(y1 / cell));
  const n = p.length;
  const xs = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    const y = (cy + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = p[i + 1], yj = p[j + 1];
      if ((yi > y) !== (yj > y)) xs.push(p[i] + (y - yi) * (p[j] - p[i]) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let cxa = Math.ceil(xs[k] / cell - 0.5), cxb = Math.floor(xs[k + 1] / cell - 0.5);
      if (cxa < 0) cxa = 0; if (cxb > gw - 1) cxb = gw - 1;
      const row = cy * gw;
      for (let cx = cxa; cx <= cxb; cx++) cb(row + cx, cx, cy);
    }
  }
}

// Rasterize a thick segment: every cell whose center lies within width/2 of the segment.
export function rasterSeg(ax, ay, bx, by, width, cell, gw, gh, cb) {
  const r = Math.max(width * 0.5, cell * 0.5);
  const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell));
  const cx1 = Math.min(gw - 1, Math.floor((Math.max(ax, bx) + r) / cell));
  const cy0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cell));
  const cy1 = Math.min(gh - 1, Math.floor((Math.max(ay, by) + r) / cell));
  for (let cy = cy0; cy <= cy1; cy++) {
    const y = (cy + 0.5) * cell;
    for (let cx = cx0; cx <= cx1; cx++) {
      const x = (cx + 0.5) * cell;
      if (distToSeg(x, y, ax, ay, bx, by) <= r) cb(cy * gw + cx, cx, cy);
    }
  }
}

export function rasterPolyline(p, width, cell, gw, gh, cb, closed = false) {
  const n = p.length;
  const last = closed ? n : n - 2;
  for (let i = 0; i < last; i += 2) {
    const j = (i + 2) % n;
    rasterSeg(p[i], p[i + 1], p[j], p[j + 1], width, cell, gw, gh, cb);
  }
}

// Bresenham-style thin line over grid cells (for line-of-fire / airstrike paths).
export function gridLine(x0, y0, x1, y1, cell, gw, gh, cb) {
  let cx = Math.floor(x0 / cell), cy = Math.floor(y0 / cell);
  const ex = Math.floor(x1 / cell), ey = Math.floor(y1 / cell);
  const dx = Math.abs(ex - cx), dy = -Math.abs(ey - cy);
  const sx = cx < ex ? 1 : -1, sy = cy < ey ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) { if (cb(cy * gw + cx, cx, cy) === false) return; }
    if (cx === ex && cy === ey) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; cx += sx; }
    if (e2 <= dx) { err += dx; cy += sy; }
  }
}

// Douglas-Peucker simplification of a flat polyline.
export function simplify(p, eps) {
  const n = p.length / 2;
  if (n <= 2) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

export function rectPoly(x0, y0, x1, y1) { return [x0, y0, x1, y0, x1, y1, x0, y1]; }

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
