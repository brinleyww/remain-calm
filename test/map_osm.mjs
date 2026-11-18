// node test/map_osm.mjs — osmToMap on a synthetic Overpass "out geom" response (no network).
import { osmToMap, overpassQuery, areaBBox, specialFromTags, isHugeMap, OSM_ATTRIBUTION } from '../js/map/osm.js';
import { validateMap, mapStats } from '../js/map/format.js';
import { pointInPoly } from '../js/util/geom.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.error('FAIL', msg); } };

// Author the fixture in local metres on a 1 km square centred on (LAT, LON), then convert to lat/lon.
const LAT = 51.5, LON = -0.12, SIZE = 1, W = 1000;
const R = 6371008.8, ky = R * Math.PI / 180, kx = ky * Math.cos(LAT * Math.PI / 180);
const ll = (x, y) => ({ lat: LAT - (y - W / 2) / ky, lon: LON + (x - W / 2) / kx });
let nid = 1, wid = 1;
const els = [];
const node = (x, y, tags) => { const id = nid++; els.push({ type: 'node', id, ...ll(x, y), ...(tags ? { tags } : {}) }); return id; };
function way(pts, tags, close = false) {
  const ids = [], geometry = [];
  for (let i = 0; i < pts.length; i += 2) { ids.push(nid++); geometry.push(ll(pts[i], pts[i + 1])); }
  if (close) { ids.push(ids[0]); geometry.push(geometry[0]); }
  const w = { type: 'way', id: wid++, nodes: ids, geometry, tags };
  els.push(w);
  return w;
}
const rect = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const circle = (cx, cy, r, n = 24) => { const p = []; for (let k = 0; k < n; k++) p.push(cx + Math.cos(k / n * 2 * Math.PI) * r, cy + Math.sin(k / n * 2 * Math.PI) * r); return p; };

// roads
way([-50, 300, 1050, 300], { highway: 'primary', name: 'Long Road' });
way([300, -50, 300, 1050], { highway: 'residential', name: 'Cross Street' });
way([100, 100, 200, 120, 260, 180], { highway: 'footway' });
way([500, 100, 500, 250], { highway: 'secondary', tunnel: 'yes', name: 'Under Pass' });
way([150, 300, 150, 500], { highway: 'residential', bridge: 'yes', name: 'Land Viaduct' });
way([0, 950, 1000, 900], { railway: 'rail' });
// river line (no riverbank) crossing x = 700..1000 at y ~ 620, with a bridge over it
way([600, 650, 700, 620, 850, 630, 1060, 610], { waterway: 'river', width: '24' });
way([800, 560, 800, 700], { highway: 'tertiary', bridge: 'yes', name: 'River Bridge' });
// multipolygon lake: outer ring split in two ways, inner island ring
const lakeOuter = circle(200, 700, 120, 32);
const half = lakeOuter.length / 2;
const o1 = lakeOuter.slice(0, half + 2), o2 = lakeOuter.slice(half).concat(lakeOuter.slice(0, 2));
const geom = pts => { const g = []; for (let i = 0; i < pts.length; i += 2) g.push(ll(pts[i], pts[i + 1])); return g; };
const revPts = pts => { const r = []; for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); return r; };
els.push({ type: 'relation', id: 9001, tags: { type: 'multipolygon', natural: 'water', name: 'Test Mere' }, members: [
  { type: 'way', ref: 801, role: 'outer', geometry: geom(o1) },
  { type: 'way', ref: 802, role: 'outer', geometry: geom(revPts(o2)) },
  { type: 'way', ref: 803, role: 'inner', geometry: geom(circle(200, 700, 35, 16).concat(circle(200, 700, 35, 16).slice(0, 2))) },
] });
// coastline: from the bottom edge to the right edge, water on the right -> sea in the bottom-right corner
way([780, 1080, 860, 960, 960, 860, 1080, 780], { natural: 'coastline' });
// buildings
way(rect(320, 320, 340, 340), { building: 'house' }, true);
way(rect(350, 320, 380, 345), { building: 'apartments', 'building:levels': '10' }, true);
way(rect(390, 320, 420, 350), { building: 'yes', height: '45 m' }, true);
way(rect(320, 360, 350, 390), { building: 'yes', amenity: 'police', name: 'Central Police' }, true);
way(rect(360, 360, 400, 400), { building: 'commercial' }, true);
node(380, 380, { amenity: 'bank', name: 'First Test Bank' });
way(rect(430, 400, 600, 520), { amenity: 'hospital', name: 'St Testing Hospital' }, true);
way(rect(440, 410, 520, 470), { building: 'yes' }, true);
way(rect(530, 420, 560, 450), { building: 'yes' }, true);
way(rect(620, 400, 700, 460), { building: 'industrial' }, true);
way(rect(-30, 320, 20, 360), { building: 'yes' }, true);
way(rect(1200, 1200, 1210, 1210), { building: 'yes' }, true);
way(rect(330, 330, 333, 333), { building: 'shed' }, true);
els.push({ type: 'relation', id: 9002, tags: { type: 'multipolygon', building: 'apartments', 'building:levels': '5' }, members: [
  { type: 'way', ref: 804, role: 'outer', geometry: geom(rect(640, 100, 720, 180).concat([640, 100])) },
  { type: 'way', ref: 805, role: 'inner', geometry: geom(rect(665, 125, 695, 155).concat([665, 125])) },
] });
way(rect(330, 100, 450, 200), { leisure: 'park', name: 'Test Park' }, true);
way(rect(460, 100, 520, 160), { landuse: 'grass' }, true);

const raw = { version: 0.6, generator: 'fixture', elements: els };
const t0 = performance.now();
const map = osmToMap(raw, { lat: LAT, lon: LON, sizeKm: SIZE, name: 'Fixture Town', stages: 4 });
console.log('osmToMap ms', Math.round(performance.now() - t0));
const v = validateMap(map);
ok(v.ok, 'valid map ' + v.errors.join('; '));
ok(map.source === 'osm' && map.geo && Math.abs(map.geo.lat - LAT) < 1e-9, 'source + geo set');
ok(map.w === 1000 && map.h === 1000, 'size 1000 m');
ok(map.levels.length === 4, 'stages 4');
ok(/OpenStreetMap/.test(OSM_ATTRIBUTION) && map.author === OSM_ATTRIBUTION, 'attribution');
for (const r of map.roads) ok(r.p.every((c, i) => c >= 0 && c <= 1000), 'road clipped to square');

const inWater = (x, y) => map.water.some(w => pointInPoly(w.p, x, y));
ok(inWater(200, 620), 'lake water (assembled from two outer ways)');
ok(!inWater(200, 700), 'lake island is land (inner ring)');
ok(inWater(960, 960), 'sea corner from coastline');
ok(!inWater(700, 700) && !inWater(100, 100) && !inWater(500, 300), 'land stays land');
ok(inWater(760, 625) && inWater(950, 618), 'river line buffered to water');
ok(!inWater(750, 660), 'river buffer has its width, not more');

const road = name => map.roads.filter(r => r.name === name);
ok(road('Long Road').length === 1 && road('Long Road')[0].k === 'major' && road('Long Road')[0].w === 14, 'primary -> major 14 m, clipped');
ok(road('Cross Street')[0]?.k === 'minor', 'residential -> minor');
ok(road('Under Pass').length === 0, 'tunnel dropped');
ok(road('River Bridge')[0]?.k === 'bridge', 'bridge over water -> bridge');
ok(road('Land Viaduct')[0]?.k === 'minor', 'bridge over land stays a road');
ok(map.roads.some(r => r.k === 'path'), 'footway -> path');
ok(map.roads.some(r => r.k === 'rail'), 'railway -> rail');

const bAt = (x, y) => map.buildings.find(b => pointInPoly(b.p, x, y));
ok(bAt(330, 330)?.use === 'House' && bAt(330, 330).k === 'res', 'house -> res');
ok(Math.abs(bAt(365, 330)?.h - 33) < 0.5, 'building:levels -> height');
ok(bAt(405, 335)?.h === 45, 'height tag');
ok(bAt(335, 375)?.k === 'civic' && bAt(335, 375).use === 'Police Station' && bAt(335, 375).name === 'Central Police', 'police building -> civic');
ok(bAt(380, 380)?.k === 'trade' && bAt(380, 380).use === 'Bank', 'bank POI node -> trade');
ok(bAt(480, 440)?.k === 'rescue' && bAt(480, 440).use === 'Hospital', 'largest building of hospital site -> rescue');
ok(bAt(545, 435)?.k !== 'rescue', 'other hospital-site building stays plain');
ok(bAt(660, 430)?.k === 'ind', 'industrial building -> ind');
ok(!map.buildings.some(b => b.p.some((c, i) => c > 1000.01)), 'no building outside the square');
ok(map.buildings.some(b => b.p.length > 12 && pointInPoly(b.p, 650, 110) && !pointInPoly(b.p, 680, 140)), 'courtyard building keeps its courtyard');
ok(!bAt(331.5, 331.5) || bAt(331.5, 331.5).use === 'House', 'tiny shed dropped');
ok(map.parks.length === 2, 'park + grass');

const st = mapStats(map);
ok(st.bridges === 1, 'one water bridge');
ok(!isHugeMap(map), 'fixture is not huge');
ok(specialFromTags({ shop: 'hardware' })[0] === 'armory' && specialFromTags({ amenity: 'fuel' })[0] === 'hazard', 'special tag mapping');

const q = overpassQuery(LAT, LON, 2, 60);
ok(/\[out:json\]\[timeout:60\]/.test(q) && /out geom/.test(q) && /way\["building"\]/.test(q) && /coastline/.test(q), 'overpass query shape');
const bb = areaBBox(LAT, LON, 2);
ok(Math.abs((bb.n - bb.s) * ky - 2000) < 1 && Math.abs((bb.e - bb.w) * kx - 2000) < 1, 'bbox is 2 km square');

// node-ref format (out body; >; out skel) works too
{
  const els2 = [];
  const n = (id, x, y) => els2.push({ type: 'node', id, ...ll(x, y) });
  n(1, 100, 100); n(2, 140, 100); n(3, 140, 140); n(4, 100, 140); n(5, 0, 500); n(6, 1000, 500);
  els2.push({ type: 'way', id: 1, nodes: [1, 2, 3, 4, 1], tags: { building: 'house' } });
  els2.push({ type: 'way', id: 2, nodes: [5, 6], tags: { highway: 'residential' } });
  const m2 = osmToMap({ elements: els2 }, { lat: LAT, lon: LON, sizeKm: 1, name: 'Refs', stages: 3 });
  ok(m2.buildings.length === 1 && m2.roads.length === 1 && validateMap(m2).ok, 'node-ref input format');
}
// empty response still yields a valid (blank) map
ok(validateMap(osmToMap({ elements: [] }, { lat: 0, lon: 0, sizeKm: 0.5 })).ok, 'empty area still valid');

console.log(`map_osm: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
