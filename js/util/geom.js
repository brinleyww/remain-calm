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

// Supercover of a segment: every cell the segment touches (cells closed, grown by eps), one row at a time.
// The cells form a 4-connected run and every point of the segment lies in one of them (floor(x / cell) mapping).
export function rasterSegCover(ax, ay, bx, by, cell, gw, gh, cb, eps = 1e-3) {
  const ymin = Math.min(ay, by), ymax = Math.max(ay, by), dx = bx - ax, dy = by - ay;
  const cy0 = Math.max(0, Math.floor((ymin - eps) / cell)), cy1 = Math.min(gh - 1, Math.floor((ymax + eps) / cell));
  const flat = Math.abs(dy) < 1e-9;
  for (let cy = cy0; cy <= cy1; cy++) {
    let xa, xb;
    if (flat) { xa = Math.min(ax, bx); xb = Math.max(ax, bx); }
    else {
      const ya = Math.max(ymin, cy * cell - eps), yb = Math.min(ymax, (cy + 1) * cell + eps);
      xa = ax + dx * (ya - ay) / dy; xb = ax + dx * (yb - ay) / dy;
      if (xa > xb) { const s = xa; xa = xb; xb = s; }
    }
    const c0 = Math.max(0, Math.floor((xa - eps) / cell)), c1 = Math.min(gw - 1, Math.floor((xb + eps) / cell));
    for (let cx = c0; cx <= c1; cx++) cb(cy * gw + cx, cx, cy);
  }
}

// Boundary of the union of polygons as segments [ax,ay,bx,by, ...]: the pieces of each edge with the union's
// inside on exactly one side (edges inside another polygon or shared by two touching polygons are dropped).
export function unionBoundary(polys, eps = 0.02) {
  const boxes = polys.map(polyBBox);
  const inside = (x, y) => {
    for (let k = 0; k < polys.length; k++) {
      const b = boxes[k];
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && pointInPoly(polys[k], x, y)) return true;
    }
    return false;
  };
  const out = [], ts = [];
  for (let k = 0; k < polys.length; k++) {
    const p = polys[k], n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, ax = p[i], ay = p[i + 1], bx = p[j], by = p[j + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const nx = -(by - ay) / L * eps, ny = (bx - ax) / L * eps;
      ts.length = 0; ts.push(0, 1);
      const ex0 = Math.min(ax, bx), ex1 = Math.max(ax, bx), ey0 = Math.min(ay, by), ey1 = Math.max(ay, by);
      for (let q = 0; q < polys.length; q++) {
        if (q === k) continue;
        const b = boxes[q];
        if (b[0] > ex1 || b[2] < ex0 || b[1] > ey1 || b[3] < ey0) continue;
        const o = polys[q], m = o.length;
        for (let u = 0; u < m; u += 2) {
          const v = (u + 2) % m, t = segIntersect(ax, ay, bx, by, o[u], o[u + 1], o[v], o[v + 1]);
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      ts.sort((a, b) => a - b);
      let open = -1;
      for (let s = 0; s + 1 < ts.length; s++) {
        const t0 = ts[s], t1 = ts[s + 1];
        if ((t1 - t0) * L < 1e-4) continue;
        const tm = (t0 + t1) * 0.5, mx = ax + (bx - ax) * tm, my = ay + (by - ay) * tm;
        const keep = inside(mx + nx, my + ny) !== inside(mx - nx, my - ny);
        if (keep && open < 0) open = t0;
        if (!keep && open >= 0) { out.push(ax + (bx - ax) * open, ay + (by - ay) * open, ax + (bx - ax) * t0, ay + (by - ay) * t0); open = -1; }
      }
      if (open >= 0) out.push(ax + (bx - ax) * open, ay + (by - ay) * open, bx, by);
    }
  }
  return out;
}

// Distance from (px,py) to the segment that starts at (ax,ay) with unit direction (ux,uy) and length L.
export function distToSegU(px, py, ax, ay, ux, uy, L) {
  const rx = px - ax, ry = py - ay, t = rx * ux + ry * uy;
  if (t <= 0) return Math.sqrt(rx * rx + ry * ry);
  if (t >= L) { const ex = rx - ux * L, ey = ry - uy * L; return Math.sqrt(ex * ex + ey * ey); }
  return Math.abs(rx * uy - ry * ux);
}
