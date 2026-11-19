// node test/map_osm.mjs — osmToMap on synthetic Overpass and OSM XML data, plus the fetch layer on a mocked network.
import { osmToMap, overpassQuery, areaBBox, specialFromTags, isHugeMap, isPrivateGarden, OSM_ATTRIBUTION } from '../js/map/osm.js';
import { validateMap, mapStats } from '../js/map/format.js';
import { pointInPoly } from '../js/util/geom.js';
import { buildGrid } from '../js/sim/raster.js';

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
ok(road('Under Pass').length === 1 && Math.min(...road('Under Pass')[0].z) === -1 && road('Under Pass')[0].k === 'major', 'tunnel kept underground (z -1)');
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

// back gardens and private yards are open ground, not parks; public gardens still are
{
  const g = [];
  let id = 50000;
  const area = (pts, tags) => { const geometry = []; for (let i = 0; i < pts.length; i += 2) geometry.push(ll(pts[i], pts[i + 1])); geometry.push(geometry[0]); g.push({ type: 'way', id: id++, geometry, tags }); };
  area(rect(100, 100, 160, 160), { leisure: 'garden', access: 'private' });
  area(rect(200, 100, 260, 160), { leisure: 'garden', 'garden:type': 'residential' });
  area(rect(300, 100, 360, 160), { leisure: 'garden', 'garden:type': 'backyard' });
  area(rect(400, 100, 500, 200), { leisure: 'garden', 'garden:type': 'botanical', name: 'Botanic Garden' });
  area(rect(600, 100, 700, 200), { leisure: 'garden', name: 'Rose Garden' });
  const m3 = osmToMap({ elements: g }, { lat: LAT, lon: LON, sizeKm: 1, name: 'Gardens', stages: 3 });
  const parkAt = (x, y) => m3.parks.some(pk => pointInPoly(pk.p, x, y));
  ok(!parkAt(130, 130) && !parkAt(230, 130) && !parkAt(330, 130), 'private, residential and back gardens are not parks');
  ok(parkAt(450, 150) && parkAt(650, 150) && m3.parks.length === 2, 'public gardens are parks');
  ok(isPrivateGarden({ leisure: 'garden', access: 'no' }) && !isPrivateGarden({ leisure: 'park', access: 'private' }) && !isPrivateGarden({ leisure: 'garden', access: 'yes' }), 'private garden rule');
}

// ---------------------------------------------------------------- new paths: files, cache, failover, tiles, cut outlines
{
  const { parseOsmText, parseOsmXml } = await import('../js/map/osmfile.js');
  const { importPlace, fetchArea, planTiles, fileSquare, NET, resetMirrorHealth, rankMirrors, OVERPASS_MIRRORS } = await import('../js/map/osm.js');
  const { useMemoryCache, cacheList, cacheKey } = await import('../js/map/osmcache.js');
  useMemoryCache();
  Object.assign(NET, { hedgeMs: 40, firstByteMs: 120, firstByteMaxMs: 700, stallMs: 400, hardMs: 1500, backoffMs: [20, 40], roundCapMs: 500 });
  OVERPASS_MIRRORS.splice(0, OVERPASS_MIRRORS.length, ...[0, 1, 2, 3, 4].map(i => `https://m${i}.test/api/interpreter`));

  // OSM XML as openstreetmap.org Export writes it (double quotes) plus JOSM style (single quotes, deleted objects)
  const n = (id, x, y) => { const g = ll(x, y); return `<node id="${id}" lat="${g.lat.toFixed(7)}" lon="${g.lon.toFixed(7)}"/>`; };
  const b0 = ll(0, 1000), b1 = ll(1000, 0);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="openstreetmap-cgimap">
 <bounds minlat="${b0.lat.toFixed(7)}" minlon="${b0.lon.toFixed(7)}" maxlat="${b1.lat.toFixed(7)}" maxlon="${b1.lon.toFixed(7)}"/>
 ${n(1, 400, 400)}${n(2, 440, 400)}${n(3, 440, 430)}${n(4, 400, 430)}${n(5, 0, 500)}${n(6, 1000, 500)}${n(7, 500, 0)}${n(8, 500, 1000)}
 <node id='9' lat='${ll(420, 415).lat.toFixed(7)}' lon='${ll(420, 415).lon.toFixed(7)}'><tag k='amenity' v='police'/><tag k='name' v='Fish &amp; Chips Station'/></node>
 <node id="10" lat="${ll(10, 10).lat}" lon="${ll(10, 10).lon}" visible="false"/>
 <way id="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/><tag k="building:levels" v="4"/></way>
 <way id="2"><nd ref="5"/><nd ref="6"/><tag k="highway" v="primary"/><tag k="name" v="High &quot;Street&quot;"/></way>
 <way id="3"><nd ref="7"/><nd ref="8"/><tag k="highway" v="footway"/><tag k="footway" v="sidewalk"/></way>
 <way id='4' action='delete'><nd ref='5'/><nd ref='7'/><tag k='highway' v='motorway'/></way>
 <relation id="5"><member type="way" ref="1" role="outer"/><member type="way" ref="99" role="outer"/><tag k="type" v="multipolygon"/></relation>
</osm>`;
  const px = parseOsmXml(xml);
  ok(px.bounds && px.elements.filter(e => e.type === 'way').length === 3 && !px.elements.some(e => e.id === 10 && e.type === 'node'), 'xml: bounds, ways, deleted/invisible skipped');
  ok(px.elements.find(e => e.type === 'node' && e.id === 9).tags.name === 'Fish & Chips Station', 'xml: entities and single quotes');
  ok(px.elements.find(e => e.type === 'relation').members.length === 2, 'xml: relation members');
  const sq = fileSquare(px.bounds);
  ok(Math.abs(sq.lat - LAT) < 1e-4 && Math.abs(sq.lon - LON) < 1e-4 && sq.maxKm === 1, 'file square from bounds');
  const fx = await importPlace({ text: xml, stages: 3 });
  ok(fx.source === 'file' && validateMap(fx.map).ok && fx.map.w === 1000, 'xml file import -> valid map');
  ok(fx.map.buildings.length === 1 && fx.map.buildings[0].k === 'civic' && Math.abs(fx.map.buildings[0].h - 13.8) < 0.2, 'xml: building, levels and police POI');
  ok(fx.map.roads.length === 1 && fx.map.roads[0].name === 'High "Street"', 'xml: sidewalk skipped, road kept');
  // Overpass JSON file (the fixture above, without bounds)
  const fj = await importPlace({ text: JSON.stringify(raw), stages: 4 });
  ok(fj.source === 'file' && Math.abs(fj.map.buildings.length - map.buildings.length) <= 2 && Math.abs(fj.lat - LAT) < 0.002 && validateMap(fj.map).ok, 'overpass json file import');
  let threw = '';
  try { parseOsmText('{"format":"rcmap","v":1}'); } catch (e) { threw = e.message; }
  ok(/Library/.test(threw), 'rcmap file sent to the library');
  try { parseOsmText('hello'); threw = ''; } catch (e) { threw = e.message; }
  ok(/Unknown file type/.test(threw), 'junk file refused');

  // mocked network: per-host behaviour, counts in-flight requests
  let inflight = 0, maxInflight = 0, calls = [];
  const behave = {};
  const body = (obj) => new Response(new ReadableStream({ start(c) { const s = JSON.stringify(obj); const enc = new TextEncoder(); c.enqueue(enc.encode(s.slice(0, 50))); c.enqueue(enc.encode(s.slice(50))); c.close(); } }), { status: 200 });
  const mockFetch = (url, opts) => {
    const hst = new URL(url).host, mode = behave[hst] || 'ok';
    calls.push(hst);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const done = () => { inflight--; };
    return new Promise((res, rej) => {
      const abort = () => { done(); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      if (opts.signal.aborted) return abort();
      opts.signal.addEventListener('abort', abort, { once: true });
      const reply = (r) => { opts.signal.removeEventListener('abort', abort); done(); res(r); };
      if (mode === 'busy') setTimeout(() => reply(new Response('# 502 Gateway Timeout\nThis Overpass API server is currently at capacity.', { status: 502 })), 5);
      else if (mode === 'remark') setTimeout(() => reply(body({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' })), 5);
      else if (mode === 'slow') setTimeout(() => reply(body(raw)), 260);
      else if (mode === 'ok') setTimeout(() => reply(body(raw)), 10);
      // 'hang': never answers until aborted
    });
  };
  const [M0, M1, M2, M3, M4] = OVERPASS_MIRRORS.map(u => new URL(u).host);
  const reset = () => { resetMirrorHealth(); inflight = 0; maxInflight = 0; calls = []; for (const k in behave) delete behave[k]; };

  // failover: busy -> hang -> ok; the hang is hedged around and cancelled
  reset();
  Object.assign(behave, { [M0]: 'busy', [M1]: 'hang', [M2]: 'ok' });
  const ev = [];
  let t = performance.now();
  const r1 = await importPlace({ lat: LAT, lon: LON, sizeKm: 1, name: 'Mock', fetchImpl: mockFetch, onProgress: p => ev.push(p.phase) });
  const dt = performance.now() - t;
  ok(r1.source === 'network' && r1.map.buildings.length === map.buildings.length && r1.info.mirrors[0] === M2, 'failover reached the working mirror');
  ok(calls.join(',') === [M0, M1, M2].join(','), 'mirrors tried in rank order: ' + calls.join(','));
  ok(maxInflight <= 2 && inflight === 0, 'never more than 2 in flight, loser cancelled');
  ok(ev.includes('retry') && ev.includes('convert') && dt < 400, 'retry reported, hedge kicked in quickly (' + Math.round(dt) + ' ms)');
  ok(rankMirrors()[0] === OVERPASS_MIRRORS[2], 'session health ranks the good mirror first');

  // cache: the same square again is instant and makes no request
  calls = [];
  const r2 = await importPlace({ lat: LAT + 0.00001, lon: LON, sizeKm: 1.1, name: 'Mock', fetchImpl: mockFetch });
  ok(r2.source === 'cache' && calls.length === 0 && r2.map.buildings.length === r1.map.buildings.length, 'cache hit on rounded centre and size');
  const cl = await cacheList();
  ok(cl.length === 1 && cl[0].key === cacheKey(LAT, LON, 1) && cl[0].name === 'Mock' && cl[0].bytes > 0, 'cache list entry');
  calls = [];
  const r2b = await importPlace({ lat: LAT, lon: LON, sizeKm: 1, name: 'Mock', fetchImpl: mockFetch, refresh: true });
  const cl2 = await cacheList();
  ok(r2b.source === 'network' && calls.length > 0 && cl2.length === 1 && cl2[0].t >= cl[0].t, 'refresh downloads again and replaces the cached copy');

  // a slow but working best mirror is not abandoned for worse ones
  reset();
  Object.assign(behave, { [M0]: 'slow', [M1]: 'hang', [M2]: 'hang', [M3]: 'hang', [M4]: 'hang' });
  t = performance.now();
  const r3 = await fetchArea({ lat: LAT, lon: LON, sizeKm: 1, fetchImpl: mockFetch });
  ok(r3.info.mirrors[0] === M0 && maxInflight <= 2 && inflight === 0, 'slow first mirror kept, hedges rotated: ' + calls.join(','));

  // runtime-error remark counts as a failure
  reset();
  Object.assign(behave, { [M0]: 'remark', [M1]: 'ok' });
  const r4 = await fetchArea({ lat: LAT, lon: LON, sizeKm: 1, fetchImpl: mockFetch });
  ok(r4.info.mirrors[0] === M1, 'server runtime error -> next mirror');

  // everything busy: rounds with backoff, then an honest error naming every mirror
  reset();
  for (const hh of [M0, M1, M2, M3, M4]) behave[hh] = 'busy';
  let err = null;
  try { await fetchArea({ lat: LAT, lon: LON, sizeKm: 1, fetchImpl: mockFetch }); } catch (e) { err = e; }
  ok(err && /No map server/.test(err.message) && /at capacity/.test(err.message) && [M0, M1, M2, M3, M4].every(hh => err.message.includes(hh)), 'all-busy error lists mirrors');
  ok(calls.length === 15, 'three rounds of five mirrors (' + calls.length + ')');

  // cancel
  reset();
  for (const hh of [M0, M1, M2, M3, M4]) behave[hh] = 'hang';
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 60);
  err = null;
  try { await importPlace({ lat: LAT, lon: LON + 0.01, sizeKm: 1, fetchImpl: mockFetch, signal: ctl.signal }); } catch (e) { err = e; }
  await new Promise(r => setTimeout(r, 5));
  ok(err && /cancelled/i.test(err.message) && inflight === 0, 'cancel aborts every request');
  const ctl2 = new AbortController();
  err = null;
  try { await importPlace({ text: JSON.stringify(raw), stages: 3, signal: ctl2.signal, onProgress: p => { if (p.phase === 'convert') ctl2.abort(); } }); } catch (e) { err = e; }
  ok(err && /cancelled/i.test(err.message), 'cancel during the convert step stops the import');

  // nobody answers at all: the last ones are dropped after firstByteMaxMs, no endless wait
  reset();
  for (const hh of [M0, M1, M2, M3, M4]) behave[hh] = 'hang';
  t = performance.now();
  err = null;
  try { await fetchArea({ lat: LAT, lon: LON + 0.02, sizeKm: 1, fetchImpl: mockFetch }); } catch (e) { err = e; }
  ok(err && /no answer/.test(err.message) && inflight === 0 && maxInflight <= 2 && performance.now() - t < 3000, 'silent servers give up in bounded time (' + Math.round(performance.now() - t) + ' ms)');

  // tiles: 4 km -> 2x2 parts, de-duplicated, still at most 2 in flight
  reset();
  ok(planTiles(LAT, LON, 2).length === 1 && planTiles(LAT, LON, 2.5).length === 4 && planTiles(LAT, LON, 4).length === 4, 'tile plan');
  const r5 = await fetchArea({ lat: LAT, lon: LON, sizeKm: 4, fetchImpl: mockFetch });
  ok(calls.length === 4 && maxInflight <= 2 && r5.elements.length === raw.elements.length && r5.info.tiles === 4, 'tiled fetch merges parts');

  // a part that fails for real is reported as such, not as the cancel it causes in the part still streaming
  let nCall = 0;
  const partFail = (url, opts) => {
    if (nCall++ === 0) {
      return Promise.resolve(new Response(new ReadableStream({ start(c) {
        const s = JSON.stringify(raw), enc = new TextEncoder();
        c.enqueue(enc.encode(s.slice(0, 50)));
        const tm = setTimeout(() => { try { c.enqueue(enc.encode(s.slice(50))); c.close(); } catch (e) { /* aborted */ } }, 300);
        opts.signal.addEventListener('abort', () => { clearTimeout(tm); try { c.error(opts.signal.reason); } catch (e) { /* closed */ } });
      } }), { status: 200 }));
    }
    return new Promise(res => setTimeout(() => res(new Response('bad', { status: 400 })), 5));
  };
  reset();
  err = null;
  try { await fetchArea({ lat: LAT + 0.03, lon: LON, sizeKm: 4, fetchImpl: partFail }); } catch (e) { err = e; }
  ok(err && !err.cancelled && /rejected/.test(err.message), 'failed part reported, not as cancelled');
}

// cut outlines: a lake relation cropped by the box (null geometry outside), members in arbitrary directions
{
  // Overpass 'out geom(bbox)': coordinates outside the crop box are null, except next to a point inside it
  const geomC = (pts) => {
    const inside = []; for (let i = 0; i < pts.length; i += 2) inside.push(!(pts[i] < -40 || pts[i + 1] < -40 || pts[i] > 1040 || pts[i + 1] > 1040));
    return inside.map((v, k) => (v || inside[k - 1] || inside[k + 1] ? ll(pts[2 * k], pts[2 * k + 1]) : null));
  };
  // lake = everything east of x ~ 610 (a big polygon that extends far outside the square)
  const lake = [600, -3000, 4000, -3000, 4000, 4000, 600, 4000, 605, 1100, 610, 1020, 620, 600, 610, -20, 605, -100, 600, -3000];
  const half1 = lake.slice(0, 8), half2 = lake.slice(6);
  const mk = (rev) => {
    const e = [];
    const m2 = rev ? revPts(half2) : half2;
    e.push({ type: 'relation', id: 1, bounds: { minlat: ll(0, 4000).lat, minlon: ll(600, 0).lon, maxlat: ll(0, -3000).lat, maxlon: ll(4000, 0).lon },
      tags: { type: 'multipolygon', natural: 'water' }, members: [
        { type: 'way', ref: 1, role: 'outer', geometry: geomC(half1) },
        { type: 'way', ref: 2, role: 'outer', geometry: geomC(m2) }] });
    let id = 10;
    for (let x = 100; x < 560; x += 60) for (let y = 100; y < 900; y += 60) e.push({ type: 'way', id: id++, tags: { building: 'house' }, geometry: geom(rect(x, y, x + 20, y + 20).concat([x, y])) });
    return { elements: e };
  };
  for (const rev of [false, true]) {
    const m = osmToMap(mk(rev), { lat: LAT, lon: LON, sizeKm: 1, stages: 3 });
    const wet = (x, y) => m.water.some(w => pointInPoly(w.p, x, y));
    ok(wet(800, 500) && wet(900, 100) && !wet(300, 500) && !wet(580, 200), `cropped lake closed on the water side (member reversed: ${rev})`);
  }
}

// ---------------- multi-level roads: bridges over roads become decks, links and chain ends ramp, tunnels go under
{
  const E = [];
  let nn = 100000, ww = 50000;
  const P = new Map();
  const pt = (x, y) => { const id = nn++; P.set(id, [x, y]); E.push({ type: 'node', id, ...ll(x, y) }); return id; };
  const lw = (ids, tags) => { E.push({ type: 'way', id: ww++, nodes: ids, geometry: ids.map(i => ll(...P.get(i))), tags }); };
  // a: bridge over a street, plain roads at both ends
  const a1 = pt(100, 500), a2 = pt(300, 500), a3 = pt(500, 500), a4 = pt(700, 500);
  lw([a1, a2], { highway: 'secondary', name: 'West Approach' });
  lw([a2, pt(400, 500), a3], { highway: 'secondary', bridge: 'yes', layer: '1', name: 'Over Bridge' });
  lw([a3, a4], { highway: 'secondary', name: 'East Approach' });
  lw([pt(400, 300), pt(400, 760)], { highway: 'residential', name: 'Under Street' });
  // b: bridge over water only
  E.push({ type: 'way', id: ww++, nodes: [], geometry: geom([0, 150, 1000, 150, 1000, 250, 0, 250, 0, 150]), tags: { natural: 'water' } });
  const b1 = pt(600, 100), b2 = pt(600, 300);
  lw([pt(600, 40), b1], { highway: 'tertiary', name: 'North Quay Road' });
  lw([b1, b2], { highway: 'tertiary', bridge: 'yes', name: 'Water Bridge' });
  lw([b2, pt(600, 340)], { highway: 'tertiary', name: 'South Quay Road' });
  // c: motorway bridge over a road with a link ramp down to the ground at one end
  const c0 = pt(20, 820), c1 = pt(100, 820), c2 = pt(300, 820), c3 = pt(450, 820);
  lw([c0, c1], { highway: 'motorway', name: 'Motorway West' });
  lw([c1, pt(200, 820), c2], { highway: 'motorway', bridge: 'yes', layer: '1', name: 'Motorway Viaduct' });
  lw([c2, pt(375, 820), c3], { highway: 'motorway_link', name: 'Slip Road' });
  lw([c3, pt(600, 820)], { highway: 'primary', name: 'Slip Street' });
  lw([pt(200, 760), pt(200, 900)], { highway: 'residential', name: 'Low Lane' });
  // d: a tunnel under a street
  const d1 = pt(0, 650), d2 = pt(150, 650), d3 = pt(470, 650), d4 = pt(600, 650);
  lw([d1, d2], { highway: 'primary', name: 'Tunnel West' });
  lw([d2, pt(300, 650), d3], { highway: 'primary', tunnel: 'yes', name: 'Deep Tunnel' });
  lw([d3, d4], { highway: 'primary', name: 'Tunnel East' });
  // e..h: ground, dropped and stacked ways
  lw([pt(700, 600), pt(900, 600)], { highway: 'service', layer: '-1', name: 'Sunk Lane' });
  lw([pt(700, 640), pt(900, 640)], { highway: 'footway', covered: 'yes', name: 'Arcade' });
  lw([pt(700, 680), pt(900, 680)], { highway: 'service', tunnel: 'building_passage', name: 'Passage' });
  lw([pt(700, 720), pt(900, 720)], { highway: 'service', service: 'parking_aisle', layer: '-1', name: 'Garage Aisle' });
  lw([pt(700, 740), pt(900, 740)], { highway: 'footway', indoor: 'yes', name: 'Mall Walk' });
  lw([pt(700, 760), pt(900, 760)], { highway: 'footway', level: '1', name: 'Gallery' });
  lw([pt(820, 560), pt(820, 960)], { highway: 'residential', name: 'Stack Street' });
  lw([pt(780, 900), pt(860, 900)], { highway: 'primary', bridge: 'yes', layer: '5', name: 'High Stack' });
  lw([pt(780, 940), pt(860, 940)], { highway: 'primary', bridge: 'yes', layer: '2', name: 'Mid Stack' });
  lw([pt(50, 980), pt(300, 980)], { railway: 'rail', bridge: 'yes', name: 'Rail Viaduct' });
  lw([pt(50, 960), pt(300, 960)], { railway: 'rail', tunnel: 'yes', name: 'Rail Tunnel' });
  const m = osmToMap({ elements: E }, { lat: LAT, lon: LON, sizeKm: 1, stages: 3, name: 'Levels' });
  ok(validateMap(m).ok, 'levels fixture is a valid map');
  const R1 = (name) => m.roads.filter(r => r.name === name);
  const zmax = (name) => Math.max(...R1(name).flatMap(r => r.z || [0])), zmin = (name) => Math.min(...R1(name).flatMap(r => r.z || [0]));
  const ob = R1('Over Bridge')[0];
  ok(ob && ob.z && ob.z[0] === 0 && ob.z[ob.z.length - 1] === 0 && zmax('Over Bridge') === 1 && ob.k === 'major', 'a bridge over a street is a deck that ramps down at both ends');
  ok(!R1('Under Street')[0].z && !R1('West Approach')[0].z, 'the street under it and the plain approaches stay on the ground');
  ok(R1('Water Bridge')[0].k === 'bridge' && !R1('Water Bridge')[0].z, 'a bridge over water only stays a level-0 water bridge');
  const mv = R1('Motorway Viaduct')[0], sl = R1('Slip Road')[0];
  ok(mv && mv.z && mv.z[0] === 0 && mv.z[mv.z.length - 1] === 1, 'the viaduct ramps at the plain end and stays up where the link meets it');
  ok(sl && sl.z && sl.z[0] === 1 && sl.z[sl.z.length - 1] === 0 && sl.z.length >= 2, 'the link road slopes from the deck down to the ground');
  ok(zmin('Deep Tunnel') === -1 && R1('Deep Tunnel')[0].z[0] === 0, 'a tunnel goes under (z -1) and ramps up at its ends');
  ok(R1('Sunk Lane').length === 1 && !R1('Sunk Lane')[0].z, 'layer -1 without a tunnel is ground');
  ok(R1('Arcade').length === 1 && !R1('Arcade')[0].z && R1('Passage').length === 1 && !R1('Passage')[0].z, 'covered ways and building passages are ground');
  ok(!R1('Garage Aisle').length && !R1('Mall Walk').length && !R1('Gallery').length, 'parking aisles below ground, indoor ways and upper levels are dropped');
  ok(zmax('High Stack') === 3 && zmax('Mid Stack') === 2, 'layers 2..5 stack up to tier 3');
  const railAt = (y) => m.roads.find(r => r.k === 'rail' && Math.abs(r.p[1] - y) < 1);
  ok(Math.max(...railAt(980).z) === 1 && Math.min(...railAt(960).z) === -1, 'rail bridges go up and rail tunnels down (scenery)');
  const g = buildGrid(m, 4);
  ok(g.deck && g.deck.D > 0 && g.deck.portals.length >= 4 && g.bridges.filter(b => b.deck).length >= 2, `the deck grid has nodes (${g.deck && g.deck.D}), portals and deck structures`);
}

console.log(`map_osm: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
