// Map checks for the editor: format validation plus playability rules (nested stages, civilians per stage,
// bridges over water). Every issue can point at a place on the sheet and at the item that caused it.
import { validateMap, normalizeMap, LIMITS, popLimit } from '../map/format.js';
import { polyArea, polyCentroid, pointInPoly, polyBBox } from '../util/geom.js';
import { DEFAULTS } from '../data/config.js';
import { itemCentre } from './editor_model.js';

const MIN_STAGE_CIVILIANS = 25;

// Points every `step` metres along a polyline (always including the nodes).
function samplePolyline(p, step = 4) {
  const out = [];
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s < n; s++) out.push(ax + (bx - ax) * s / n, ay + (by - ay) * s / n);
  }
  if (p.length >= 2) out.push(p[p.length - 2], p[p.length - 1]);
  return out;
}

function waterLookup(map) {
  const boxes = map.water.map(w => polyBBox(w.p));
  return (x, y) => {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInPoly(map.water[i].p, x, y)) return true;
    }
    return false;
  };
}

// Per-stage facts used by the Stages list and the checks.
export function stageInfo(map, cfg = DEFAULTS) {
  const levels = map.levels || [];
  const perM2 = cfg.population.perM2, mul = cfg.population.kindMul, scale = cfg.population.scale * popLimit(map, cfg).factor;
  const cents = map.buildings.map(b => polyCentroid(b.p));
  const areas = map.buildings.map(b => polyArea(b.p));
  const inside = new Uint8Array(map.buildings.length);
  return levels.map((lv, k) => {
    let buildings = 0, pop = 0, specials = 0;
    const p = lv.p;
    const bb = polyBBox(p);
    for (let i = 0; i < cents.length; i++) {
      if (!inside[i]) {
        const [x, y] = cents[i];
        if (x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3] && pointInPoly(p, x, y)) inside[i] = 1;
      }
      if (!inside[i]) continue;
      buildings++;
      const b = map.buildings[i];
      pop += areas[i] * perM2 * (mul[b.k] ?? 1);
      if (b.k === 'civic' || b.k === 'trade' || b.k === 'armory' || b.k === 'rescue') specials++;
    }
    let outside = -1;
    if (k > 0) {
      const prev = levels[k - 1].p;
      for (let j = 0; j < prev.length; j += 2) {
        if (!pointInPoly(p, prev[j], prev[j + 1]) && edgeDist(p, prev[j], prev[j + 1]) > 2) { outside = j; break; }
      }
    }
    return {
      idx: k, label: lv.label || '', areaKm2: polyArea(p) / 1e6, buildings, pop: Math.round(pop),
      civilians: Math.round(pop * scale), specials, nested: outside < 0,
      outsideAt: outside >= 0 ? [levels[k - 1].p[outside], levels[k - 1].p[outside + 1]] : null,
    };
  });
}

function edgeDist(p, x, y) {
  let best = Infinity;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n, ax = p[i], ay = p[i + 1], dx = p[j] - ax, dy = p[j + 1] - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

// Returns { ok, errors: [issue], warnings: [issue], stages } where issue = { msg, at?: [x, y], ref?: {coll, idx} }.
export function checkMap(map, cfg = DEFAULTS) {
  const errors = [], warnings = [];
  const E = (msg, at, ref) => { if (errors.length < 200) errors.push({ msg, at, ref }); };
  const W = (msg, at, ref) => { if (warnings.length < 200) warnings.push({ msg, at, ref }); };

  const v = validateMap(map);
  for (const msg of v.errors) {
    const m = /^(road|water|park|building|stage|spawn) (\d+)/.exec(msg);
    const coll = m && { road: 'roads', water: 'water', park: 'parks', building: 'buildings', stage: 'levels', spawn: 'spawns' }[m[1]];
    const ref = coll ? { coll, idx: +m[2] } : null;
    const it = ref && map[coll][ref.idx];
    E(msg[0].toUpperCase() + msg.slice(1), it ? safeCentre(coll, it) : null, ref);
  }
  if (errors.length) return { ok: false, errors, warnings, stages: [] };

  // items that normalisation would silently drop
  const dropped = (list, coll, min) => list.forEach((it, i) => {
    const a = polyArea(it.p);
    if (a < min) W(`${coll === 'buildings' ? 'Building' : coll === 'water' ? 'Water area' : 'Park'} ${i + 1} is too small (${a.toFixed(1)} m²) and will be dropped`, safeCentre(coll, it), { coll, idx: i });
  });
  dropped(map.buildings, 'buildings', 2);
  dropped(map.water, 'water', 4);
  dropped(map.parks, 'parks', 4);

  const n = map.levels.length;
  if (n < LIMITS.minLevels) E(`The map needs at least ${LIMITS.minLevels} stages (it has ${n})`, null, null);
  if (n > LIMITS.maxLevels) E(`The map can have at most ${LIMITS.maxLevels} stages`, null, null);

  const stages = stageInfo(map, cfg);
  for (const s of stages) {
    const lv = map.levels[s.idx];
    const at = polyCentroid(lv.p);
    if (!s.nested) W(`Stage ${s.idx + 1} does not fully contain stage ${s.idx}`, s.outsideAt, { coll: 'levels', idx: s.idx });
    if (s.buildings === 0) E(`Stage ${s.idx + 1} has no buildings, so no civilians would spawn`, at, { coll: 'levels', idx: s.idx });
    else if (s.civilians < MIN_STAGE_CIVILIANS) W(`Stage ${s.idx + 1} would only spawn about ${s.civilians} civilians`, at, { coll: 'levels', idx: s.idx });
  }
  if (n && stages.length) {
    const last = map.levels[n - 1].p, bb = polyBBox(last);
    if ((bb[2] - bb[0]) * (bb[3] - bb[1]) < map.w * map.h * 0.6) W(`The last stage covers only part of the sheet; usually it is the whole map`, polyCentroid(last), { coll: 'levels', idx: n - 1 });
  }

  const inWater = waterLookup(map);
  map.roads.forEach((r, i) => {
    const pts = samplePolyline(r.p, 4);
    let wet = 0;
    for (let k = 0; k < pts.length; k += 2) if (inWater(pts[k], pts[k + 1])) wet++;
    const at = safeCentre('roads', r);
    const endWet = inWater(r.p[0], r.p[1]) || inWater(r.p[r.p.length - 2], r.p[r.p.length - 1]);
    if (r.k === 'bridge' && wet === 0) W(`Bridge ${i + 1} does not cross any water`, at, { coll: 'roads', idx: i });
    else if (r.k === 'bridge' && endWet) W(`Bridge ${i + 1} ends in the water; extend it onto land`, at, { coll: 'roads', idx: i });
    else if (r.k !== 'bridge' && wet > 0) W(`${r.k === 'rail' ? 'Rail line' : 'Road'} ${i + 1} crosses water; set its kind to Bridge`, at, { coll: 'roads', idx: i });
  });
  if (map.water.length) {
    map.buildings.forEach((b, i) => {
      const c = polyCentroid(b.p);
      if (inWater(c[0], c[1])) W(`Building ${i + 1} stands in water`, c, { coll: 'buildings', idx: i });
    });
  }
  if (!map.roads.length && map.buildings.length) W('There are no roads: civilians and zombies will cross open ground', null, null);
  if (!map.buildings.length) E('The map has no buildings', null, null);
  if (map.buildings.length > 90000 || map.roads.length > 50000) W(`Large map (${map.buildings.length.toLocaleString()} buildings): it needs a desktop with plenty of memory`, null, null);
  map.spawns.forEach((s, i) => {
    if (n && !pointInPoly(map.levels[n - 1].p, s[0], s[1])) W(`Outbreak point ${i + 1} lies outside every stage`, s, { coll: 'spawns', idx: i });
  });
  const norm = validateMap(normalizeMap(map));
  for (const msg of norm.errors) E('After cleanup: ' + msg, null, null);
  return { ok: errors.length === 0, errors, warnings, stages };
}

function safeCentre(coll, it) {
  try { return itemCentre(coll, it); } catch (e) { return null; }
}
