// MapData: constants, validation, normalisation, (de)serialisation and shared map geometry.
import { polyArea, polySignedArea, polyBBox, pointInPoly, clamp } from '../util/geom.js';
import { Rng, hashStr } from '../util/rng.js';
import { DEFAULTS } from '../data/config.js';

export const FORMAT = 'rcmap';
export const VERSION = 1;
export const FILE_EXT = '.rcmap.json';

export const T = Object.freeze({ OPEN: 0, ROAD: 1, BLDG: 2, WATER: 3, BRIDGE: 4, PARK: 5, RUBBLE: 6, RAIL: 7 });
export const BUILDING_KINDS = ['res', 'com', 'ind', 'civic', 'trade', 'armory', 'rescue', 'hazard', 'landmark'];
export const SPECIAL_KINDS = ['civic', 'trade', 'armory', 'rescue'];
export const ROAD_KINDS = ['major', 'minor', 'path', 'rail', 'bridge'];
export const PALETTES = ['paper', 'blueprint', 'night'];
export const SOURCES = ['gen', 'osm', 'editor'];

export const ROAD_WIDTH = { major: 12, minor: 7, path: 3, rail: 6, bridge: 12 };
export const KIND_TAG = { civic: 'CIV', trade: 'COM', armory: 'ARS', rescue: 'REL', hazard: 'HAZ' };
export const KIND_LABEL = {
  res: 'Residential', com: 'Commercial', ind: 'Industrial', civic: 'Civic', trade: 'Commerce',
  armory: 'Arsenal', rescue: 'Relief', hazard: 'Hazard', landmark: 'Landmark',
};
export const DEFAULT_USE = {
  res: 'Housing', com: 'Offices', ind: 'Warehouse', civic: 'Town Hall', trade: 'Market Hall',
  armory: 'Armory', rescue: 'Hospital', hazard: 'Fuel Station', landmark: 'Tower',
};
export const DEFAULT_HEIGHT = { res: 8, com: 14, ind: 10, civic: 14, trade: 12, armory: 9, rescue: 16, hazard: 6, landmark: 60 };
// Uses the editor offers per kind (any string is accepted in a map).
export const USES = {
  res: ['House', 'Terrace', 'Apartments', 'Tower Block'],
  com: ['Offices', 'Shops', 'Office Tower', 'Restaurant', 'Church'],
  ind: ['Warehouse', 'Factory', 'Depot', 'Works'],
  civic: ['Police Station', 'Town Hall', 'Fire Station', 'School', 'Library', 'Courthouse'],
  trade: ['Bank', 'Market Hall', 'Shopping Centre', 'Hotel'],
  armory: ['Armory', 'Hardware Store', 'Sporting Goods', 'National Guard Depot'],
  rescue: ['Hospital', 'Bus Depot', 'Rail Station', 'Ferry Terminal'],
  hazard: ['Fuel Station', 'Chemical Works', 'Gas Holder'],
  landmark: ['Tower', 'Cathedral', 'Stadium'],
};
export const LIMITS = { minSize: 100, maxSize: 12000, minLevels: 3, maxLevels: 7, maxBuildings: 400000, maxRoads: 200000, maxPoints: 16e6, maxText: 2000 };

const r1 = v => Math.round(v * 10) / 10;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

// ---------------------------------------------------------------- clipping helpers

// Sutherland-Hodgman clip of a flat polygon against an axis-aligned rectangle.
export function clipPolyRect(p, x0, y0, x1, y1) {
  let bb = polyBBox(p);
  if (bb[0] >= x0 && bb[1] >= y0 && bb[2] <= x1 && bb[3] <= y1) return p.slice();
  if (bb[2] < x0 || bb[3] < y0 || bb[0] > x1 || bb[1] > y1) return [];
  let out = p;
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    const n = inp.length;
    if (!n) break;
    const inside = (x, y) => (e === 0 ? x >= x0 : e === 1 ? x <= x1 : e === 2 ? y >= y0 : y <= y1);
    const cut = (ax, ay, bx, by) => {
      let t;
      if (e === 0) t = (x0 - ax) / (bx - ax); else if (e === 1) t = (x1 - ax) / (bx - ax);
      else if (e === 2) t = (y0 - ay) / (by - ay); else t = (y1 - ay) / (by - ay);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    };
    for (let i = 0; i < n; i += 2) {
      const j = (i + n - 2) % n;
      const ax = inp[j], ay = inp[j + 1], bx = inp[i], by = inp[i + 1];
      const ain = inside(ax, ay), bin = inside(bx, by);
      if (bin) { if (!ain) cut(ax, ay, bx, by); out.push(bx, by); } else if (ain) cut(ax, ay, bx, by);
    }
  }
  return out;
}

// Clip a flat polyline to a rectangle; returns an array of polylines (Liang-Barsky per segment).
export function clipLineRect(p, x0, y0, x1, y1) {
  const res = [];
  let cur = null;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    const P = [-dx, dx, -dy, dy], Q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    for (let k = 0; k < 4 && ok; k++) {
      if (P[k] === 0) { if (Q[k] < 0) ok = false; } else {
        const t = Q[k] / P[k];
        if (P[k] < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; } else { if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
    }
    if (!ok) { if (cur) { res.push(cur); cur = null; } continue; }
    const sx = ax + dx * t0, sy = ay + dy * t0, ex = ax + dx * t1, ey = ay + dy * t1;
    if (!cur) cur = [sx, sy];
    else if (t0 > 0) { res.push(cur); cur = [sx, sy]; }
    cur.push(ex, ey);
    if (t1 < 1) { res.push(cur); cur = null; }
  }
  if (cur) res.push(cur);
  return res.filter(l => l.length >= 4);
}

// MapData polygons have no holes: fold each hole into the outer ring through a zero-width cut.
// The cut point is where a ray from the hole's rightmost vertex first meets the ring, so it never crosses an edge.
export function mergeHoles(outer, holes) {
  if (!holes || !holes.length) return outer;
  let ring = polySignedArea(outer) >= 0 ? outer.slice() : reversePoly(outer);
  const hs = holes.filter(h => h && h.length >= 6).map(h => {
    const hh = polySignedArea(h) <= 0 ? h : reversePoly(h);
    let mi = 0;
    for (let i = 2; i < hh.length; i += 2) if (hh[i] > hh[mi]) mi = i;
    return { p: hh, mi, mx: hh[mi] };
  }).sort((a, b) => b.mx - a.mx);
  for (const h of hs) {
    const mx = h.p[h.mi], my = h.p[h.mi + 1];
    let best = Infinity, bi = -1, bx = 0;
    const n = ring.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const ay = ring[i + 1], by = ring[j + 1];
      if ((ay > my) === (by > my)) continue;
      const x = ring[i] + (my - ay) * (ring[j] - ring[i]) / (by - ay);
      if (x >= mx && x - mx < best) { best = x - mx; bi = i; bx = x; }
    }
    if (bi < 0) continue;
    const hp = h.p, hn = hp.length;
    const ins = [bx, my];
    for (let k = 0; k <= hn; k += 2) { const q = (h.mi + k) % hn; ins.push(hp[q], hp[q + 1]); }
    ins.push(bx, my);
    ring = ring.slice(0, bi + 2).concat(ins, ring.slice(bi + 2));
  }
  return ring;
}

export function reversePoly(p) {
  const out = new Array(p.length);
  for (let i = 0, n = p.length; i < n; i += 2) { out[n - 2 - i] = p[i]; out[n - 1 - i] = p[i + 1]; }
  return out;
}

// ---------------------------------------------------------------- stages

// Nested star-shaped stage boundaries around (cx, cy). Stage k covers roughly a geometric share of the
// weighted area (weight(x, y) -> 0..1, e.g. 1 on land); the last stage is the whole map.
export function makeStages(w, h, count, opts = {}) {
  count = clamp(Math.round(count) || 3, 1, LIMITS.maxLevels);
  const cx = opts.cx ?? w / 2, cy = opts.cy ?? h / 2;
  const rng = new Rng((opts.seed ?? 1) ^ 0x5a17);
  // big sheets get more outline points so a 4 km wide stage ring is not drawn in 500 m chords
  const NA = Math.max(w, h) > 6000 ? 80 : 48;
  const step = Math.max(w, h) / 72;
  const samples = [];
  let total = 0;
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const wt = opts.weight ? opts.weight(x, y) : 1;
      if (wt <= 0) continue;
      const a = Math.atan2(y - cy, x - cx);
      samples.push(a < 0 ? a + Math.PI * 2 : a, Math.hypot(x - cx, y - cy), wt);
      total += wt;
    }
  }
  const full = [0, 0, w, 0, w, h, 0, h];
  const levels = [];
  if (count === 1 || total <= 0) {
    for (let k = 0; k < count; k++) levels.push({ p: full.slice() });
    return levels;
  }
  const km2 = (w * h) / 1e6;
  const f0 = clamp(opts.firstFrac ?? (0.1 + 0.025 * km2) / km2, 0.005, 0.5);
  let prev = null;
  for (let k = 0; k < count - 1; k++) {
    const frac = f0 * Math.pow(1 / f0, k / (count - 1));
    const harm = [];
    for (let m = 1; m <= 4; m++) harm.push([m, rng.range(0.03, 0.16) / Math.sqrt(m), rng.range(0, Math.PI * 2)]);
    const g = a => { let s = 1; for (const [m, amp, ph] of harm) s += amp * Math.cos(m * a + ph); return Math.max(0.45, s); };
    const qs = [];
    for (let i = 0; i < samples.length; i += 3) qs.push([samples[i + 1] / g(samples[i]), samples[i + 2]]);
    qs.sort((a, b) => a[0] - b[0]);
    let acc = 0, scale = qs.length ? qs[qs.length - 1][0] : 1;
    const target = frac * total;
    for (const [q, wt] of qs) { acc += wt; if (acc >= target) { scale = q; break; } }
    const radii = new Float64Array(NA);
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      let r = Math.max(scale * g(a), 40);
      if (prev) r = Math.max(r, prev[i] * 1.06 + 20);
      radii[i] = r;
    }
    prev = radii;
    const p = [];
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      p.push(cx + Math.cos(a) * radii[i], cy + Math.sin(a) * radii[i]);
    }
    const c = clipPolyRect(p, 0, 0, w, h).map(r1);
    levels.push({ p: c.length >= 6 ? c : full.slice() });
  }
  levels.push({ p: full.slice() });
  if (opts.labels) levels.forEach((l, i) => { if (opts.labels[i]) l.label = String(opts.labels[i]).slice(0, 60); });
  return levels;
}

// ---------------------------------------------------------------- validation

export function validateMap(m) {
  const errors = [], warnings = [];
  const err = s => { if (errors.length < 50) errors.push(s); };
  if (!m || typeof m !== 'object') return { ok: false, errors: ['not a map object'], warnings };
  if (m.format !== FORMAT) err('format must be "rcmap"');
  if (!(m.v >= 1 && m.v <= VERSION)) err('unsupported version ' + m.v);
  if (!isNum(m.w) || !isNum(m.h) || m.w < LIMITS.minSize || m.h < LIMITS.minSize || m.w > LIMITS.maxSize || m.h > LIMITS.maxSize)
    err(`map size must be ${LIMITS.minSize}..${LIMITS.maxSize} m`);
  for (const key of ['roads', 'water', 'parks', 'buildings', 'levels']) if (!Array.isArray(m[key])) err(key + ' must be an array');
  if (errors.length) return { ok: false, errors, warnings };
  if (m.buildings.length > LIMITS.maxBuildings) err('too many buildings');
  if (m.roads.length > LIMITS.maxRoads) err('too many roads');
  let pts = 0;
  const checkPts = (p, min, what, i) => {
    if (!Array.isArray(p) || p.length < min || p.length % 2) { err(`${what} ${i}: needs at least ${min / 2} points`); return false; }
    for (let k = 0; k < p.length; k++) if (!isNum(p[k])) { err(`${what} ${i}: bad coordinate`); return false; }
    pts += p.length;
    return true;
  };
  m.roads.forEach((r, i) => {
    if (!r || !checkPts(r.p, 4, 'road', i)) return;
    if (!ROAD_KINDS.includes(r.k)) err(`road ${i}: unknown kind ${r.k}`);
    if (!isNum(r.w) || r.w <= 0 || r.w > 80) err(`road ${i}: bad width`);
  });
  m.water.forEach((x, i) => { if (x) checkPts(x.p, 6, 'water', i); });
  m.parks.forEach((x, i) => { if (x) checkPts(x.p, 6, 'park', i); });
  m.buildings.forEach((b, i) => {
    if (!b || !checkPts(b.p, 6, 'building', i)) return;
    if (!BUILDING_KINDS.includes(b.k)) err(`building ${i}: unknown kind ${b.k}`);
    if (!isNum(b.h) || b.h <= 0 || b.h > 1000) err(`building ${i}: bad height`);
  });
  if (m.levels.length < 1 || m.levels.length > LIMITS.maxLevels) err(`stage count must be 1..${LIMITS.maxLevels}`);
  else if (m.levels.length < LIMITS.minLevels) warnings.push(`only ${m.levels.length} stage(s); maps normally have ${LIMITS.minLevels}-${LIMITS.maxLevels}`);
  m.levels.forEach((l, i) => { if (l) checkPts(l.p, 6, 'stage', i); });
  if (!errors.length) {
    for (let i = 1; i < m.levels.length; i++) {
      const a = m.levels[i - 1].p, b = m.levels[i].p;
      let out = 0;
      for (let k = 0; k < a.length; k += 2) if (!pointInPoly(b, a[k], a[k + 1]) && distToPolyEdge(b, a[k], a[k + 1]) > 2) out++;
      if (out > 0) warnings.push(`stage ${i + 1} does not fully contain stage ${i}`);
    }
  }
  if (Array.isArray(m.spawns)) m.spawns.forEach((s, i) => { if (!Array.isArray(s) || !isNum(s[0]) || !isNum(s[1])) err(`spawn ${i}: bad point`); });
  if (pts > LIMITS.maxPoints) err('map has too many points');
  return { ok: errors.length === 0, errors, warnings };
}

function distToPolyEdge(p, x, y) {
  let best = Infinity;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const ax = p[i], ay = p[i + 1], dx = p[j] - ax, dy = p[j + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------- normalisation

function cleanPts(p, closed, w, h) {
  if (!Array.isArray(p)) return [];
  const out = [];
  for (let i = 0; i + 1 < p.length; i += 2) {
    let x = +p[i], y = +p[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x = r1(x); y = r1(y);
    const n = out.length;
    if (n && out[n - 2] === x && out[n - 1] === y) continue;
    out.push(x, y);
  }
  if (closed) while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

function cleanPoly(p, w, h, minArea) {
  let q = cleanPts(p, true);
  if (q.length < 6) return null;
  const bb = polyBBox(q);
  if (bb[0] < 0 || bb[1] < 0 || bb[2] > w || bb[3] > h) q = cleanPts(clipPolyRect(q, 0, 0, w, h), true);
  if (q.length < 6 || polyArea(q) < minArea) return null;
  return q;
}

export function normalizeMap(m) {
  m = m && typeof m === 'object' ? m : {};
  const w = clamp(r1(+m.w || 2000), LIMITS.minSize, LIMITS.maxSize);
  const h = clamp(r1(+m.h || 2000), LIMITS.minSize, LIMITS.maxSize);
  const name = str(m.name, 80).trim() || 'Untitled';
  const out = {
    format: FORMAT, v: VERSION,
    name, author: str(m.author, 60), desc: str(m.desc, LIMITS.maxText), welcome: str(m.welcome, LIMITS.maxText),
    source: SOURCES.includes(m.source) ? m.source : 'editor',
    seed: Number.isFinite(+m.seed) && m.seed !== null && m.seed !== '' ? (+m.seed >>> 0) : hashStr(name),
    geo: m.geo && isNum(m.geo.lat) && isNum(m.geo.lon) ? { lat: m.geo.lat, lon: m.geo.lon } : null,
    palette: PALETTES.includes(m.palette) ? m.palette : 'paper',
    w, h, roads: [], water: [], parks: [], buildings: [], levels: [], spawns: [],
  };
  for (const r of Array.isArray(m.roads) ? m.roads : []) {
    if (!r) continue;
    const k = ROAD_KINDS.includes(r.k) ? r.k : 'minor';
    const rw = clamp(isNum(r.w) && r.w > 0 ? r1(r.w) : ROAD_WIDTH[k], 1, 60);
    let p = cleanPts(r.p, false);
    if (p.length < 4) continue;
    const bb = polyBBox(p);
    const pieces = bb[0] < 0 || bb[1] < 0 || bb[2] > w || bb[3] > h ? clipLineRect(p, 0, 0, w, h).map(q => cleanPts(q, false)) : [p];
    for (const q of pieces) {
      if (q.length < 4) continue;
      let len = 0;
      for (let i = 0; i + 3 < q.length; i += 2) len += Math.hypot(q[i + 2] - q[i], q[i + 3] - q[i + 1]);
      if (len < 1) continue;
      const o = { p: q, w: rw, k };
      const nm = str(r.name, 80);
      if (nm) o.name = nm;
      out.roads.push(o);
    }
  }
  for (const x of Array.isArray(m.water) ? m.water : []) { const p = x && cleanPoly(x.p, w, h, 4); if (p) out.water.push({ p }); }
  for (const x of Array.isArray(m.parks) ? m.parks : []) { const p = x && cleanPoly(x.p, w, h, 4); if (p) out.parks.push({ p }); }
  for (const b of Array.isArray(m.buildings) ? m.buildings : []) {
    const p = b && cleanPoly(b.p, w, h, 2);
    if (!p) continue;
    const k = BUILDING_KINDS.includes(b.k) ? b.k : 'res';
    const o = { p, h: clamp(isNum(b.h) && b.h > 0 ? r1(b.h) : DEFAULT_HEIGHT[k], 2, 900), k, use: str(b.use, 60) || DEFAULT_USE[k] };
    const nm = str(b.name, 80);
    if (nm) o.name = nm;
    out.buildings.push(o);
  }
  for (const l of Array.isArray(m.levels) ? m.levels.slice(0, LIMITS.maxLevels) : []) {
    const p = l && cleanPoly(l.p, w, h, 100);
    if (!p) continue;
    const o = { p };
    const lb = str(l.label, 60);
    if (lb) o.label = lb;
    out.levels.push(o);
  }
  if (!out.levels.length) out.levels = makeStages(w, h, 3, { seed: out.seed });
  for (const s of Array.isArray(m.spawns) ? m.spawns : []) {
    if (Array.isArray(s) && isNum(+s[0]) && isNum(+s[1])) out.spawns.push([clamp(r1(+s[0]), 0, w), clamp(r1(+s[1]), 0, h)]);
  }
  return out;
}

// ---------------------------------------------------------------- (de)serialisation

const KEYS = ['format', 'v', 'name', 'author', 'desc', 'welcome', 'source', 'seed', 'geo', 'palette', 'w', 'h',
  'roads', 'water', 'parks', 'buildings', 'levels', 'spawns'];

export function serializeMap(m) {
  const o = {};
  for (const k of KEYS) if (m[k] !== undefined) o[k] = m[k];
  o.format = FORMAT; o.v = VERSION;
  return JSON.stringify(o);
}

export function parseMap(text) {
  let o;
  try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new Error('Map file is not valid JSON'); }
  if (o && o.kind === 'rc-library' && o.item && o.item.data) o = o.item.type === 'scenario' ? o.item.data.map : o.item.data;
  if (!o || o.format !== FORMAT) throw new Error('Not a REMAIN CALM map');
  if (!(o.v <= VERSION)) throw new Error('Map was made by a newer version (v' + o.v + ')');
  const m = normalizeMap(o);
  const v = validateMap(m);
  if (!v.ok) throw new Error('Invalid map: ' + v.errors[0]);
  return m;
}

// ---------------------------------------------------------------- stats

export function mapStats(m, cfg = DEFAULTS) {
  const perM2 = cfg.population.perM2, mul = cfg.population.kindMul;
  let pop = 0, footprint = 0, roadKm = 0, bridges = 0, water = 0, parks = 0;
  const kinds = {};
  for (const b of m.buildings) {
    const a = polyArea(b.p);
    footprint += a;
    pop += a * perM2 * (mul[b.k] ?? 1);
    kinds[b.k] = (kinds[b.k] || 0) + 1;
  }
  for (const r of m.roads) {
    let len = 0;
    for (let i = 0; i + 3 < r.p.length; i += 2) len += Math.hypot(r.p[i + 2] - r.p[i], r.p[i + 3] - r.p[i + 1]);
    roadKm += len / 1000;
    if (r.k === 'bridge') bridges++;
  }
  for (const x of m.water) water += polyArea(x.p);
  for (const x of m.parks) parks += polyArea(x.p);
  const specials = {};
  for (const k of [...SPECIAL_KINDS, 'hazard', 'landmark']) specials[k] = kinds[k] || 0;
  return {
    buildings: m.buildings.length, roads: m.roads.length, areaKm2: (m.w * m.h) / 1e6, nominalPop: Math.round(pop),
    stages: m.levels.length, bridges, roadKm: Math.round(roadKm * 10) / 10, footprintKm2: footprint / 1e6,
    waterKm2: water / 1e6, parkKm2: parks / 1e6, kinds, specials,
  };
}

// Residents per building on sheets above population.autoCapKm2: the final stage holds about autoCap people at
// scale 1 and every stage is thinned by the same factor. -> { factor (0..1], nominal (whole sheet), limited }
export function popLimit(m, cfg = DEFAULTS) {
  const pc = cfg.population, perM2 = pc.perM2, mul = pc.kindMul, cap = +pc.autoCap || 0;
  let nominal = 0;
  for (const b of m.buildings || []) nominal += polyArea(b.p) * perM2 * (mul[b.k] ?? 1);
  const limited = cap > 0 && (m.w * m.h) / 1e6 > (+pc.autoCapKm2 || 0) && nominal > cap;
  return { factor: limited ? cap / nominal : 1, nominal, limited };
}

export function emptyMap(w = 2000, h = 2000, name = 'Untitled') {
  return normalizeMap({ format: FORMAT, v: VERSION, name, source: 'editor', w, h, seed: hashStr(name + ':' + w + 'x' + h) });
}
