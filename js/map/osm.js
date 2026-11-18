// Real-place import: Nominatim search, one Overpass request, OSM JSON -> MapData.
// Etiquette: only user-triggered, one request at a time, timeouts, attribution shown wherever geo is set.
import { polyArea, polyCentroid, polyBBox, pointInPoly, simplify, clamp, rasterPoly } from '../util/geom.js';
import { hashStr } from '../util/rng.js';
import { FORMAT, VERSION, normalizeMap, makeStages, mergeHoles, clipPolyRect, clipLineRect, mapStats } from './format.js';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const IMPORT_SIZES = [0.5, 1, 1.5, 2, 3, 4, 5];
export const HUGE_LIMITS = { buildings: 30000, roads: 16000, areaKm2: 9.5 };

const R_EARTH = 6371008.8;

// ---------------------------------------------------------------- network

let lastSearch = 0;
let busy = null;

function linkSignals(signal, ms) {
  const ctl = new AbortController();
  const timer = ms ? setTimeout(() => ctl.abort(new Error('timeout')), ms) : null;
  const onAbort = () => ctl.abort(signal.reason || new Error('aborted'));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  return { signal: ctl.signal, done: () => { if (timer) clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); } };
}
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});

// Call only on an explicit submit. Results: [{ name, label, lat, lon, type, bbox }]
export async function searchPlaces(query, { signal, lang } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];
  const wait = lastSearch + 1100 - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastSearch = Date.now();
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`;
  const link = linkSignals(signal, 20000);
  let res;
  try {
    res = await fetch(url, { signal: link.signal, headers: { Accept: 'application/json', ...(lang ? { 'Accept-Language': lang } : {}) } });
  } catch (e) {
    throw new Error(signal && signal.aborted ? 'Search cancelled' : 'Place search failed (network or timeout)');
  } finally { link.done(); }
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status})`);
  const arr = await res.json();
  return (Array.isArray(arr) ? arr : []).map(r => ({
    name: r.name || String(r.display_name || '').split(',')[0] || q,
    label: String(r.display_name || r.name || ''),
    lat: +r.lat, lon: +r.lon, type: r.type || '', category: r.category || r.class || '',
    bbox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null,
  })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

export function areaBBox(lat, lon, sizeKm) {
  const half = (sizeKm * 1000) / 2;
  const dLat = (half / R_EARTH) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

export function overpassQuery(lat, lon, sizeKm, timeoutSec = 90) {
  const b = areaBBox(lat, lon, sizeKm);
  const bb = [b.s, b.w, b.n, b.e].map(v => v.toFixed(6)).join(',');
  const amen = 'police|fire_station|townhall|courthouse|library|bank|hospital|clinic|school|college|university|bus_station|ferry_terminal|fuel|marketplace|community_centre|place_of_worship';
  return `[out:json][timeout:${timeoutSec}][maxsize:536870912];
(
  way["highway"](${bb});
  way["railway"~"^(rail|light_rail|narrow_gauge|subway)$"](${bb});
  way["building"](${bb});
  relation["building"](${bb});
  way["natural"~"^(water|coastline|wood|scrub|grassland|heath|wetland)$"](${bb});
  relation["natural"~"^(water|wood|scrub|grassland|heath|wetland)$"](${bb});
  way["waterway"~"^(riverbank|river|canal|stream|dock)$"](${bb});
  relation["waterway"="riverbank"](${bb});
  way["water"](${bb});
  relation["water"](${bb});
  way["landuse"~"^(reservoir|basin|grass|forest|meadow|village_green|recreation_ground|cemetery|allotments|orchard|military|industrial)$"](${bb});
  relation["landuse"~"^(reservoir|basin|grass|forest|meadow|recreation_ground|cemetery|military|industrial)$"](${bb});
  way["leisure"~"^(park|garden|playground|pitch|golf_course|recreation_ground|common|dog_park|nature_reserve|stadium)$"](${bb});
  relation["leisure"~"^(park|garden|golf_course|nature_reserve|stadium)$"](${bb});
  way["amenity"~"^(${amen})$"](${bb});
  node["amenity"~"^(${amen})$"](${bb});
  node["shop"~"^(mall|department_store|supermarket|hardware|doityourself|sports|outdoor|hunting|weapons)$"](${bb});
  node["tourism"="hotel"](${bb});
  node["railway"="station"](${bb});
  way["man_made"~"^(gasometer|storage_tank|works)$"](${bb});
  way["power"~"^(plant|substation)$"](${bb});
  way["military"](${bb});
);
out geom qt;`;
}

async function overpassOnce(endpoint, query, { signal, onProgress, timeoutMs }) {
  const link = linkSignals(signal, timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST', signal: link.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (server busy)' : res.status === 504 ? ' (server timeout)' : res.status === 406 || res.status === 403 ? ' (request refused)' : ''}`);
    let text;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      const parts = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        parts.push(dec.decode(value, { stream: true }));
        if (onProgress) onProgress({ phase: 'download', bytes, endpoint });
      }
      parts.push(dec.decode());
      text = parts.join('');
    } else text = await res.text();
    if (onProgress) onProgress({ phase: 'parse', bytes: text.length, endpoint });
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.elements)) throw new Error('unexpected response');
    if (data.remark && /error|timed out|out of memory/i.test(data.remark) && data.elements.length === 0) throw new Error(data.remark);
    return data;
  } finally { link.done(); }
}

// One Overpass request; mirrors are tried only when the previous endpoint failed.
export async function fetchArea({ lat, lon, sizeKm = 2, onProgress, signal, timeoutSec = 90 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('No location chosen');
  sizeKm = clamp(+sizeKm || 2, 0.25, 6);
  if (busy) throw new Error('An import is already running');
  const query = overpassQuery(lat, lon, sizeKm, timeoutSec);
  let lastErr = null;
  busy = true;
  try {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (signal && signal.aborted) throw new Error('Import cancelled');
      if (onProgress) onProgress({ phase: 'request', endpoint, bytes: 0 });
      try {
        return await overpassOnce(endpoint, query, { signal, onProgress, timeoutMs: (timeoutSec + 30) * 1000 });
      } catch (e) {
        if (signal && signal.aborted) throw new Error('Import cancelled');
        lastErr = e;
        if (onProgress) onProgress({ phase: 'retry', endpoint, error: String(e.message || e) });
      }
    }
  } finally { busy = null; }
  throw new Error('Map data download failed: ' + (lastErr ? lastErr.message : 'no server answered'));
}

export async function importPlace({ lat, lon, sizeKm = 2, name, stages = 5, onProgress, signal } = {}) {
  const raw = await fetchArea({ lat, lon, sizeKm, onProgress, signal });
  if (onProgress) onProgress({ phase: 'convert' });
  await new Promise(r => setTimeout(r, 0));
  const map = osmToMap(raw, { lat, lon, sizeKm, name, stages });
  const stats = mapStats(map);
  const warnings = [];
  const huge = isHugeMap(map);
  if (huge) warnings.push('Large map: expect slower simulation on modest computers.');
  if (!map.buildings.length) warnings.push('No buildings found in this area.');
  if (onProgress) onProgress({ phase: 'done' });
  return { map, huge, warnings, stats };
}

export function isHugeMap(map) {
  return map.buildings.length > HUGE_LIMITS.buildings || map.roads.length > HUGE_LIMITS.roads || (map.w * map.h) / 1e6 > HUGE_LIMITS.areaKm2;
}

// ---------------------------------------------------------------- tag classification

const SKIP_HIGHWAY = new Set(['proposed', 'construction', 'abandoned', 'disused', 'platform', 'raceway', 'bus_stop', 'elevator', 'services',
  'rest_area', 'escape', 'emergency_bay', 'razed', 'no', 'traffic_island']);
const ROAD_SPEC = {
  motorway: ['major', 20], trunk: ['major', 17], primary: ['major', 14], secondary: ['major', 12], tertiary: ['major', 10],
  motorway_link: ['major', 9], trunk_link: ['major', 9], primary_link: ['major', 8], secondary_link: ['major', 8], tertiary_link: ['minor', 7],
  unclassified: ['minor', 7], residential: ['minor', 7], living_street: ['minor', 6], road: ['minor', 7], busway: ['minor', 7],
  service: ['minor', 5], pedestrian: ['path', 5], track: ['path', 3.5], footway: ['path', 2.5], path: ['path', 2.5],
  cycleway: ['path', 2.5], bridleway: ['path', 2.5], steps: ['path', 2.5], corridor: ['path', 2],
};
const PARK_TAGS = {
  leisure: new Set(['park', 'garden', 'playground', 'pitch', 'golf_course', 'recreation_ground', 'common', 'dog_park', 'nature_reserve']),
  landuse: new Set(['grass', 'forest', 'meadow', 'village_green', 'recreation_ground', 'cemetery', 'allotments', 'orchard', 'greenfield']),
  natural: new Set(['wood', 'scrub', 'grassland', 'heath', 'wetland']),
};
const BRIDGE_NO = new Set(['no', 'false', '0']);

function num(v) {
  if (v == null) return NaN;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|'|feet)?/i.exec(String(v));
  if (!m) return NaN;
  let x = parseFloat(m[1].replace(',', '.'));
  if (m[2] && /ft|'|feet/i.test(m[2])) x *= 0.3048;
  return x;
}

function isWaterArea(t) {
  return t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.landuse === 'reservoir' || t.landuse === 'basin'
    || (t.water && t.water !== 'no' && t.natural !== 'wetland' && !t.building);
}
function isPark(t) {
  return (t.leisure && PARK_TAGS.leisure.has(t.leisure)) || (t.landuse && PARK_TAGS.landuse.has(t.landuse)) || (t.natural && PARK_TAGS.natural.has(t.natural));
}

// Special-building class from tags (building, POI node or site) -> [kind, use] or null.
export function specialFromTags(t) {
  const a = t.amenity, s = t.shop, b = t.building;
  if (a === 'police') return ['civic', 'Police Station'];
  if (a === 'townhall') return ['civic', 'Town Hall'];
  if (a === 'fire_station' || b === 'fire_station') return ['civic', 'Fire Station'];
  if (a === 'courthouse') return ['civic', 'Courthouse'];
  if (a === 'library') return ['civic', 'Library'];
  if (a === 'school' || a === 'college' || a === 'university' || b === 'school' || b === 'university' || b === 'college') return ['civic', 'School'];
  if (a === 'community_centre') return ['civic', 'Community Centre'];
  if (a === 'bank') return ['trade', 'Bank'];
  if (a === 'marketplace') return ['trade', 'Market Hall'];
  if (s === 'mall' || s === 'department_store') return ['trade', 'Shopping Centre'];
  if (s === 'supermarket') return ['trade', 'Supermarket'];
  if (t.tourism === 'hotel' || b === 'hotel') return ['trade', 'Hotel'];
  if (s === 'hardware' || s === 'doityourself') return ['armory', 'Hardware Store'];
  if (s === 'sports' || s === 'outdoor') return ['armory', 'Sporting Goods'];
  if (s === 'hunting' || s === 'weapons') return ['armory', 'Gun Shop'];
  if (t.military || t.landuse === 'military' || b === 'military' || b === 'barracks') return ['armory', t.military === 'barracks' || b === 'barracks' ? 'Armory' : 'National Guard Depot'];
  if (a === 'hospital' || b === 'hospital') return ['rescue', 'Hospital'];
  if (a === 'clinic') return ['rescue', 'Clinic'];
  if (a === 'bus_station') return ['rescue', 'Bus Depot'];
  if (a === 'ferry_terminal') return ['rescue', 'Ferry Terminal'];
  if (t.railway === 'station' || b === 'train_station' || (t.public_transport === 'station' && t.train === 'yes')) return ['rescue', 'Rail Station'];
  if (a === 'fuel') return ['hazard', 'Fuel Station'];
  if (t.man_made === 'gasometer') return ['hazard', 'Gas Holder'];
  if (t.man_made === 'storage_tank' && /gas|oil|fuel|petrol|chemical/i.test(t.content || t.substance || '')) return ['hazard', 'Fuel Tank'];
  if (t.industrial === 'chemical' || /chemical/i.test(t.product || '')) return ['hazard', 'Chemical Works'];
  if (t.power === 'plant') return ['hazard', 'Power Station'];
  if (t.leisure === 'stadium' || b === 'stadium') return ['landmark', 'Stadium'];
  if (b === 'cathedral') return ['landmark', 'Cathedral'];
  if (t.historic === 'castle' || b === 'castle') return ['landmark', 'Castle'];
  return null;
}

const RES_TYPES = { house: 'House', detached: 'House', semidetached_house: 'House', bungalow: 'House', terrace: 'Terrace', residential: 'Apartments',
  apartments: 'Apartments', dormitory: 'Apartments', farm: 'House', cabin: 'House', hut: 'Hut', static_caravan: 'House', houseboat: 'House' };
const COM_TYPES = { commercial: 'Offices', office: 'Offices', retail: 'Shops', supermarket: 'Shops', kiosk: 'Kiosk', church: 'Church', chapel: 'Church',
  mosque: 'Place of Worship', temple: 'Place of Worship', synagogue: 'Place of Worship', religious: 'Place of Worship', public: 'Public Building',
  civic: 'Public Building', government: 'Public Building', parking: 'Car Park', hotel: 'Hotel', transportation: 'Terminal' };
const IND_TYPES = { industrial: 'Factory', warehouse: 'Warehouse', factory: 'Factory', manufacture: 'Factory', hangar: 'Hangar', storage_tank: 'Tank',
  shed: 'Shed', garage: 'Garage', garages: 'Garages', carport: 'Carport', barn: 'Barn', greenhouse: 'Greenhouse', service: 'Utility', roof: 'Canopy' };
const BASE_H = { House: 7, Terrace: 9, Apartments: 15, Hut: 3.5, Offices: 18, Shops: 8, Kiosk: 3, Church: 16, 'Place of Worship': 12, 'Public Building': 14,
  'Car Park': 12, Hotel: 24, Terminal: 12, Factory: 10, Warehouse: 9, Hangar: 12, Tank: 12, Shed: 3.5, Garage: 3, Garages: 3, Carport: 3, Barn: 7,
  Greenhouse: 4, Utility: 5, Canopy: 5, Building: 9, School: 12, Hospital: 20, 'Rail Station': 14, Stadium: 25, Cathedral: 40, Castle: 18 };

function buildingClass(t, area, inIndustrial) {
  const b = t.building;
  const sp = specialFromTags(t);
  if (sp) return sp;
  if (RES_TYPES[b]) return ['res', RES_TYPES[b]];
  if (COM_TYPES[b]) return ['com', COM_TYPES[b]];
  if (IND_TYPES[b]) return ['ind', IND_TYPES[b]];
  if (t.amenity === 'place_of_worship') return ['com', 'Place of Worship'];
  if (t.shop || t.office || t.amenity) return ['com', t.office ? 'Offices' : 'Shops'];
  if (inIndustrial) return ['ind', area > 1500 ? 'Factory' : 'Warehouse'];
  return area > 1800 ? ['com', 'Building'] : ['res', 'Building'];
}

function buildingHeight(t, use, id) {
  let h = num(t.height);
  if (!(h > 0)) {
    const lv = num(t['building:levels']), rl = num(t['roof:levels']);
    if (lv > 0) h = lv * 3.2 + (rl > 0 ? rl * 2 : 0) + 1;
  }
  if (h > 0) return clamp(h, 2.5, 850);
  const base = BASE_H[use] ?? 9;
  const j = ((hashStr(String(id)) % 1000) / 1000 - 0.5) * 0.4;
  return Math.round(base * (1 + j) * 10) / 10;
}

// ---------------------------------------------------------------- geometry helpers

function bufferLine(p, hw) {
  const n = p.length / 2;
  if (n < 2) return null;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    let ax = 0, ay = 0, bx = 0, by = 0;
    if (i > 0) { const dx = x - p[2 * i - 2], dy = y - p[2 * i - 1], l = Math.hypot(dx, dy) || 1; ax = dx / l; ay = dy / l; }
    if (i < n - 1) { const dx = p[2 * i + 2] - x, dy = p[2 * i + 3] - y, l = Math.hypot(dx, dy) || 1; bx = dx / l; by = dy / l; }
    if (i === 0) { ax = bx; ay = by; }
    if (i === n - 1) { bx = ax; by = ay; }
    let tx = ax + bx, ty = ay + by;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) { tx = ax; ty = ay; } else { tx /= tl; ty /= tl; }
    const nx = -ty, ny = tx;
    const cosHalf = Math.max(0.35, nx * -ay + ny * ax);
    const m = hw / cosHalf;
    L.push(x + nx * m, y + ny * m);
    R.push(x - nx * m, y - ny * m);
  }
  const out = L.slice();
  for (let i = R.length - 2; i >= 0; i -= 2) out.push(R[i], R[i + 1]);
  return out;
}

// Join open chains (arrays of [key, x, y] points) into rings / longer chains by shared endpoint keys.
function joinChains(chains) {
  const pool = chains.filter(c => c.length >= 2).map(c => c.slice());
  const done = [];
  while (pool.length) {
    let cur = pool.pop();
    let grew = true;
    while (grew && cur[0][0] !== cur[cur.length - 1][0]) {
      grew = false;
      const head = cur[0][0], tail = cur[cur.length - 1][0];
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i], a = c[0][0], b = c[c.length - 1][0];
        if (a === tail) cur = cur.concat(c.slice(1));
        else if (b === tail) cur = cur.concat(c.slice(0, -1).reverse());
        else if (b === head) cur = c.concat(cur.slice(1));
        else if (a === head) cur = c.slice().reverse().concat(cur.slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    done.push(cur);
  }
  return done;
}

const isClosed = c => c.length >= 4 && c[0][0] === c[c.length - 1][0];
const flat = c => { const out = []; for (const q of c) out.push(q[1], q[2]); return out; };
const ring = c => { const f = flat(c); if (isClosed(c)) f.length -= 2; return f; };

// ---------------------------------------------------------------- conversion

export function osmToMap(raw, opts = {}) {
  const lat0 = +opts.lat, lon0 = +opts.lon;
  if (!Number.isFinite(lat0) || !Number.isFinite(lon0)) throw new Error('osmToMap needs the centre lat/lon');
  const sizeKm = clamp(+opts.sizeKm || 2, 0.25, 6);
  const W = Math.round(sizeKm * 1000), H = W;
  const kx = (R_EARTH * Math.PI / 180) * Math.cos(lat0 * Math.PI / 180), ky = R_EARTH * Math.PI / 180;
  const px = lon => (lon - lon0) * kx + W / 2, py = lat => (lat0 - lat) * ky + H / 2;
  const els = (raw && Array.isArray(raw.elements)) ? raw.elements : [];
  const nodes = new Map(), ways = new Map(), rels = [];
  for (const e of els) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.push(e);
  }
  // way geometry as chain of [key, x, y]
  const wayChain = (w) => {
    if (w._chain !== undefined) return w._chain;
    let c = null;
    if (Array.isArray(w.geometry) && w.geometry.length) {
      c = [];
      for (let i = 0; i < w.geometry.length; i++) {
        const g = w.geometry[i];
        if (!g) continue;
        const id = w.nodes ? w.nodes[i] : null;
        c.push([id != null ? 'n' + id : g.lat.toFixed(7) + ',' + g.lon.toFixed(7), px(g.lon), py(g.lat)]);
      }
    } else if (Array.isArray(w.nodes)) {
      c = [];
      for (const id of w.nodes) { const n = nodes.get(id); if (n) c.push(['n' + id, px(n.lon), py(n.lat)]); }
    }
    w._chain = c && c.length >= 2 ? c : null;
    return w._chain;
  };
  const memberChain = (m) => {
    if (Array.isArray(m.geometry) && m.geometry.length) {
      return m.geometry.filter(Boolean).map(g => [g.lat.toFixed(7) + ',' + g.lon.toFixed(7), px(g.lon), py(g.lat)]);
    }
    const w = ways.get(m.ref);
    if (!w) return null;
    return wayChain(w);
  };

  const roads = [], waterPolys = [], parkPolys = [], bldgs = [], sites = [], riverLines = [], coastChains = [], pois = [];
  const usedAsMember = new Set();

  const addArea = (outerRings, innerRings, tags, id) => {
    if (!outerRings.length) return;
    const water = isWaterArea(tags), park = !water && isPark(tags);
    const isB = tags.building && tags.building !== 'no' && !(tags.location === 'underground') && !(num(tags.layer) < 0 && tags.building !== 'yes');
    const sp = specialFromTags(tags);
    const site = !isB && (sp || tags.landuse === 'industrial' || tags.man_made === 'works');
    for (const o of outerRings) {
      if (o.length < 6) continue;
      const bb = polyBBox(o);
      if (bb[2] < 0 || bb[3] < 0 || bb[0] > W || bb[1] > H) continue;
      const holes = innerRings.filter(h => h.length >= 6 && pointInPoly(o, h[0], h[1]));
      if (water) waterPolys.push(holes.length ? mergeHoles(o, holes) : o);
      else if (park) parkPolys.push(holes.length ? mergeHoles(o, holes) : o);
      if (isB) bldgs.push({ p: holes.length ? mergeHoles(o, holes) : o, tags, id });
      else if (site) sites.push({ p: o, bb, tags, sp, industrial: tags.landuse === 'industrial' || tags.man_made === 'works' });
    }
  };

  for (const r of rels) {
    const t = r.tags || {};
    if (t.type !== 'multipolygon' && t.type !== 'boundary') continue;
    const outer = [], inner = [];
    let tags = t;
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const c = memberChain(m);
      if (!c) continue;
      (m.role === 'inner' ? inner : outer).push(c);
      usedAsMember.add(m.ref);
    }
    if (Object.keys(t).filter(k => k !== 'type').length === 0) {
      const w = ways.get((r.members || []).find(m => m.role !== 'inner')?.ref);
      if (w && w.tags) tags = w.tags;
    }
    const close = list => joinChains(list).map(c => {
      if (!isClosed(c)) { const a = c[0], b = c[c.length - 1]; if (Math.hypot(a[1] - b[1], a[2] - b[2]) > 50) return null; }
      return ring(c);
    }).filter(Boolean);
    addArea(close(outer), close(inner), tags, 'r' + r.id);
  }

  for (const w of ways.values()) {
    const t = w.tags || {};
    const c = wayChain(w);
    if (!c) continue;
    if (t.highway && !SKIP_HIGHWAY.has(t.highway) && t.area !== 'yes') {
      if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
      if (num(t.layer) < 0 && !t.bridge) continue;
      const spec = ROAD_SPEC[t.highway];
      if (!spec) continue;
      let [k, wid] = spec;
      if (t.highway === 'service' && (t.service === 'parking_aisle' || t.service === 'driveway')) wid = 3.5;
      const tw = num(t.width);
      if (tw > 1.5 && tw < 50) wid = tw;
      roads.push({ p: flat(c), w: wid, k, name: t.name, bridge: !!(t.bridge && !BRIDGE_NO.has(t.bridge)) });
      continue;
    }
    if (t.railway) {
      if (t.tunnel && t.tunnel !== 'no') continue;
      if (t.railway === 'subway' && !(t.bridge && !BRIDGE_NO.has(t.bridge)) && t.tunnel !== 'no' && !(num(t.layer) > 0)) continue;
      if (/^(rail|light_rail|narrow_gauge|subway)$/.test(t.railway)) roads.push({ p: flat(c), w: num(t.gauge) > 0 && t.railway === 'narrow_gauge' ? 4 : 6, k: 'rail' });
      continue;
    }
    if (t.natural === 'coastline') { coastChains.push(c); continue; }
    if ((t.waterway === 'river' || t.waterway === 'canal' || t.waterway === 'stream') && !(t.tunnel && t.tunnel !== 'no')) {
      let wd = num(t.width);
      if (!(wd > 0)) wd = t.waterway === 'river' ? 18 : t.waterway === 'canal' ? 10 : 0;
      if (wd >= 3) riverLines.push({ p: flat(c), hw: Math.min(wd, 400) / 2 });
      continue;
    }
    if (isClosed(c) && !usedAsMember.has(w.id)) addArea([ring(c)], [], t, 'w' + w.id);
    else if (isClosed(c) && t.building) addArea([ring(c)], [], t, 'w' + w.id);
  }
  for (const n of nodes.values()) {
    if (!n.tags) continue;
    const sp = specialFromTags(n.tags);
    if (sp) pois.push({ x: px(n.lon), y: py(n.lat), sp, name: n.tags.name });
  }

  // coastline -> sea polygons (water on the right-hand side of the way direction)
  const sea = coastToWater(coastChains, W, H);
  for (const s of sea) waterPolys.push(s);

  // rivers drawn only as lines: buffer the parts not already covered by a water area
  const wbbs = waterPolys.map(polyBBox), nWater = waterPolys.length;
  const inWater = (x, y) => { for (let i = 0; i < nWater; i++) { const b = wbbs[i]; if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue; if (pointInPoly(waterPolys[i], x, y)) return true; } return false; };
  for (const rl of riverLines) {
    const p = rl.p, n = p.length / 2;
    const wet = [];
    for (let i = 0; i < n; i++) wet.push(inWater(p[2 * i], p[2 * i + 1]));
    let run = [];
    const flush = () => { if (run.length >= 4) { const poly = bufferLine(simplify(run, 0.8), rl.hw); if (poly) waterPolys.push(poly); } run = []; };
    for (let i = 0; i < n; i++) {
      if (!wet[i] || (i > 0 && !wet[i - 1]) || (i < n - 1 && !wet[i + 1])) run.push(p[2 * i], p[2 * i + 1]);
      if (wet[i] && (i === n - 1 || wet[i + 1]) && (i === 0 || wet[i - 1])) flush();
    }
    flush();
  }

  // final water / parks clipped to the square
  const water = [], parks = [];
  for (const p of waterPolys) { const q = clipPolyRect(simplify(p, 0.8), 0, 0, W, H); if (q.length >= 6 && polyArea(q) > 20) water.push({ p: q }); }
  for (const p of parkPolys) { const q = clipPolyRect(simplify(p, 0.8), 0, 0, W, H); if (q.length >= 6 && polyArea(q) > 30) parks.push({ p: q }); }

  // water raster (4 m) for bridge tests and stage weights
  const cell = 4, gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const wmask = new Uint8Array(gw * gh);
  for (const x of water) rasterPoly(x.p, cell, gw, gh, i => { wmask[i] = 1; });
  const wetAt = (x, y) => { const cx = (x / cell) | 0, cy = (y / cell) | 0; return cx >= 0 && cy >= 0 && cx < gw && cy < gh && wmask[cy * gw + cx] === 1; };

  // roads
  const outRoads = [];
  for (const r of roads) {
    for (const piece of clipLineRect(r.p, 0, 0, W, H)) {
      const q = simplify(piece, 0.5);
      if (q.length < 4) continue;
      let k = r.k;
      if (r.bridge && k !== 'rail') {
        let wetN = 0;
        for (let i = 0; i + 3 < q.length; i += 2) {
          const L = Math.hypot(q[i + 2] - q[i], q[i + 3] - q[i + 1]), m = Math.max(1, Math.ceil(L / 3));
          for (let s = 0; s <= m; s++) if (wetAt(q[i] + (q[i + 2] - q[i]) * s / m, q[i + 1] + (q[i + 3] - q[i + 1]) * s / m)) wetN++;
        }
        if (wetN > 0) k = 'bridge';
      }
      const o = { p: q, w: r.w, k };
      if (r.name) o.name = r.name;
      outRoads.push(o);
    }
  }

  // buildings
  const B = [];
  for (const b of bldgs) {
    let p = simplify(b.p, 0.25);
    const [cx0, cy0] = polyCentroid(p);
    if (cx0 < 0 || cy0 < 0 || cx0 > W || cy0 > H) continue;
    p = clipPolyRect(p, 0, 0, W, H);
    if (p.length < 6) continue;
    const area = polyArea(p);
    if (area < 12) continue;
    const [cx, cy] = polyCentroid(p);
    B.push({ p, tags: b.tags, id: b.id, area, cx, cy, bb: polyBBox(p), k: null, use: null, name: b.tags.name });
  }
  // spatial buckets
  const BK = 64, nbx = Math.ceil(W / BK) + 1, nby = Math.ceil(H / BK) + 1;
  const buckets = new Array(nbx * nby);
  B.forEach((b, i) => {
    const x0 = clamp(Math.floor(b.bb[0] / BK), 0, nbx - 1), x1 = clamp(Math.floor(b.bb[2] / BK), 0, nbx - 1);
    const y0 = clamp(Math.floor(b.bb[1] / BK), 0, nby - 1), y1 = clamp(Math.floor(b.bb[3] / BK), 0, nby - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (buckets[y * nbx + x] ||= []).push(i);
  });
  const near = (x0, y0, x1, y1, fn) => {
    const bx0 = clamp(Math.floor(x0 / BK), 0, nbx - 1), bx1 = clamp(Math.floor(x1 / BK), 0, nbx - 1);
    const by0 = clamp(Math.floor(y0 / BK), 0, nby - 1), by1 = clamp(Math.floor(y1 / BK), 0, nby - 1);
    const seen = new Set();
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) for (const i of buckets[y * nbx + x] || []) if (!seen.has(i)) { seen.add(i); fn(i); }
  };
  // industrial context + special sites (largest building in the site)
  const industrialOf = new Uint8Array(B.length);
  for (const s of sites) {
    const inside = [];
    near(s.bb[0], s.bb[1], s.bb[2], s.bb[3], i => { const b = B[i]; if (pointInPoly(s.p, b.cx, b.cy)) inside.push(i); });
    if (s.industrial) for (const i of inside) industrialOf[i] = 1;
    if (s.sp && inside.length) {
      let best = -1;
      for (const i of inside) if (!specialFromTags(B[i].tags) && (best < 0 || B[i].area > B[best].area)) best = i;
      if (best >= 0 && !B[best].k) { [B[best].k, B[best].use] = s.sp; if (!B[best].name && s.tags.name) B[best].name = s.tags.name; }
    }
  }
  for (const poi of pois) {
    let hit = -1, bd = 25;
    near(poi.x - 25, poi.y - 25, poi.x + 25, poi.y + 25, i => {
      const b = B[i];
      if (b.k && b.k !== 'res' && b.k !== 'com') return;
      if (pointInPoly(b.p, poi.x, poi.y)) { hit = i; bd = -1; return; }
      if (bd < 0) return;
      const d = Math.hypot(b.cx - poi.x, b.cy - poi.y) - Math.sqrt(b.area) / 2;
      if (d < bd) { bd = d; hit = i; }
    });
    if (hit >= 0 && !B[hit].k) { [B[hit].k, B[hit].use] = poi.sp; if (!B[hit].name && poi.name) B[hit].name = poi.name; }
  }
  const outB = [];
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    let k = b.k, use = b.use;
    if (!k) [k, use] = buildingClass(b.tags, b.area, industrialOf[i] === 1);
    const h = buildingHeight(b.tags, use, b.id);
    const o = { p: b.p, h, k, use };
    if (b.name) o.name = String(b.name).slice(0, 80);
    outB.push(o);
  }
  const plain = outB.filter(b => b.k === 'res' || b.k === 'com').sort((a, b) => b.h - a.h);
  for (let i = 0; i < plain.length && (plain[i].h >= 120 || (i < 3 && plain[i].h >= 60)); i++) { plain[i].k = 'landmark'; if (plain[i].use === 'Building' || plain[i].use === 'Offices' || plain[i].use === 'Apartments') plain[i].use = 'Tower'; }

  const nStages = clamp(Math.round(+opts.stages || 5), 3, 7);
  const levels = makeStages(W, H, nStages, {
    cx: W / 2, cy: H / 2, seed: hashStr(`${lat0.toFixed(5)},${lon0.toFixed(5)}`),
    weight: (x, y) => (wetAt(x, y) ? 0 : 1),
  });
  const name = String(opts.name || 'Imported place').slice(0, 80);
  return normalizeMap({
    format: FORMAT, v: VERSION, name, author: OSM_ATTRIBUTION,
    desc: `${name}: ${sizeKm} km square around ${lat0.toFixed(5)}, ${lon0.toFixed(5)}. Map data ${OSM_ATTRIBUTION}.`,
    welcome: '', source: 'osm', seed: hashStr(`${name}|${lat0.toFixed(5)}|${lon0.toFixed(5)}|${sizeKm}`), geo: { lat: lat0, lon: lon0 },
    palette: 'paper', w: W, h: H, roads: outRoads, water, parks, buildings: outB, levels, spawns: [],
  });
}

// Coastline chains -> sea polygons inside [0,W]x[0,H]. Walking the box perimeter clockwise on screen
// keeps the box interior on the right, matching OSM's "water on the right" rule for coastlines.
function coastToWater(chains, W, H) {
  if (!chains.length) return [];
  const joined = joinChains(chains);
  const P = 2 * (W + H);
  const sOf = (x, y) => {
    const d = [Math.abs(y), Math.abs(x - W), Math.abs(y - H), Math.abs(x)];
    const e = d.indexOf(Math.min(...d));
    if (e === 0) return clamp(x, 0, W);
    if (e === 1) return W + clamp(y, 0, H);
    if (e === 2) return W + H + (W - clamp(x, 0, W));
    return 2 * W + H + (H - clamp(y, 0, H));
  };
  const ptOf = s => {
    s = ((s % P) + P) % P;
    if (s <= W) return [s, 0];
    if (s <= W + H) return [W, s - W];
    if (s <= 2 * W + H) return [W - (s - W - H), H];
    return [0, H - (s - 2 * W - H)];
  };
  const snap = (x, y) => {
    const d = [y, W - x, H - y, x];
    const e = d.indexOf(Math.min(...d));
    return e === 0 ? [clamp(x, 0, W), 0] : e === 1 ? [W, clamp(y, 0, H)] : e === 2 ? [clamp(x, 0, W), H] : [0, clamp(y, 0, H)];
  };
  const pieces = [], islands = [];
  for (const c of joined) {
    const f = flat(c);
    if (isClosed(c)) {
      const r = ring(c), bb = polyBBox(r);
      if (bb[0] >= 0 && bb[1] >= 0 && bb[2] <= W && bb[3] <= H) { islands.push(r); continue; }
    }
    for (const q of clipLineRect(f, 0, 0, W, H)) {
      if (q.length < 4) continue;
      const a = snap(q[0], q[1]), b = snap(q[q.length - 2], q[q.length - 1]);
      const pts = [a[0], a[1], ...q.slice(2, -2), b[0], b[1]];
      pieces.push({ pts, s0: sOf(a[0], a[1]), s1: sOf(b[0], b[1]), used: false });
    }
  }
  const polys = [];
  for (const start of pieces) {
    if (start.used) continue;
    start.used = true;
    const poly = start.pts.slice();
    let cur = start, guard = 0;
    while (guard++ < pieces.length + 2) {
      let best = null, bd = Infinity;
      for (const p of pieces) {
        if (p.used && p !== start) continue;
        const d = (((p.s0 - cur.s1) % P) + P) % P;
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) break;
      const corners = [W, W + H, 2 * W + H, P];
      for (const c of corners.map(c => c).concat(corners.map(c => c + P))) {
        const rel = c - cur.s1;
        if (rel > 1e-6 && rel < bd - 1e-6) { const q = ptOf(c); poly.push(q[0], q[1]); }
      }
      if (best === start) break;
      best.used = true;
      poly.push(...best.pts);
      cur = best;
    }
    if (poly.length >= 6 && polyArea(poly) > 50) polys.push(poly);
  }
  if (!polys.length && islands.length) polys.push([0, 0, W, 0, W, H, 0, H]);
  if (!islands.length) return polys;
  const holesOf = polys.map(() => []);
  for (const isl of islands) {
    const i = polys.findIndex(p => pointInPoly(p, isl[0], isl[1]));
    if (i >= 0) holesOf[i].push(isl);
  }
  return polys.map((p, i) => mergeHoles(p, holesOf[i]));
}
