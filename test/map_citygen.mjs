// node test/map_citygen.mjs  — generator validity, determinism, timing, campaign cities.
import { generateCity, WATER_TYPES } from '../js/map/citygen.js';
import { validateMap, mapStats, serializeMap, SPECIAL_KINDS } from '../js/map/format.js';
import { CAMPAIGN, getCampaignMap } from '../js/map/campaign.js';
import { pointInPoly, polyBBox, rasterPoly, rasterSeg } from '../js/util/geom.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.error('FAIL', msg); } };
const now = () => performance.now();

function waterIndex(map) {
  const polys = map.water.map(w => ({ p: w.p, bb: polyBBox(w.p) }));
  return (x, y) => polys.some(w => x >= w.bb[0] && y >= w.bb[1] && x <= w.bb[2] && y <= w.bb[3] && pointInPoly(w.p, x, y));
}

// Cells where any road crosses water, grouped 8-connected: each group is a bridge to the simulation.
function wetRoadGroups(map, cell = 4) {
  const gw = Math.ceil(map.w / cell), gh = Math.ceil(map.h / cell);
  const water = new Uint8Array(gw * gh), wetRoad = new Uint8Array(gw * gh);
  for (const w of map.water) rasterPoly(w.p, cell, gw, gh, c => { water[c] = 1; });
  for (const r of map.roads) for (let i = 0; i + 3 < r.p.length; i += 2) {
    rasterSeg(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3], Math.max(r.w, cell), cell, gw, gh, c => { if (water[c]) wetRoad[c] = 1; });
  }
  let groups = 0;
  const seen = new Uint8Array(gw * gh), stack = [];
  for (let s0 = 0; s0 < wetRoad.length; s0++) {
    if (!wetRoad[s0] || seen[s0]) continue;
    groups++; seen[s0] = 1; stack.push(s0);
    while (stack.length) {
      const c = stack.pop(), x = c % gw, y = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && wetRoad[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
  }
  return groups;
}

function checkMap(map, label, opts = {}) {
  const v = validateMap(map);
  ok(v.ok, `${label}: valid (${v.errors.join('; ')})`);
  ok(!v.warnings.some(w => /contain/.test(w)), `${label}: stages nested (${v.warnings.join('; ')})`);
  const st = mapStats(map);
  ok(st.buildings > (opts.minBuildings ?? 300), `${label}: buildings ${st.buildings}`);
  ok(st.roads > 50, `${label}: roads ${st.roads}`);
  for (const k of SPECIAL_KINDS) ok(st.specials[k] >= 1, `${label}: has ${k} specials`);
  ok(st.specials.hazard >= 1, `${label}: has hazard`);
  ok(st.specials.landmark >= 1, `${label}: has landmark`);
  ok(map.levels.length === opts.stages, `${label}: ${map.levels.length} stages, wanted ${opts.stages}`);
  const last = map.levels[map.levels.length - 1].p;
  ok(last.length === 8 && last[4] === map.w && last[5] === map.h, `${label}: last stage is the whole map`);
  const s1 = map.levels[0].p;
  for (const k of ['civic', 'trade', 'armory']) {
    ok(map.buildings.some(b => b.k === k && insideCentroid(s1, b.p)), `${label}: stage 1 has a ${k} building`);
  }
  if (opts.water && opts.water !== 'none') {
    ok(map.water.length >= 1, `${label}: water present`);
    if (opts.bridges > 0) ok(st.bridges === opts.bridges, `${label}: bridges ${st.bridges} wanted ${opts.bridges}`);
  } else ok(st.bridges === 0, `${label}: no bridges inland`);
  ok(wetRoadGroups(map) === st.bridges, `${label}: roads touch water only at the ${st.bridges} bridge(s) (found ${wetRoadGroups(map)})`);
  const wet = waterIndex(map);
  let bad = 0, n = 0;
  for (let i = 0; i < map.buildings.length; i += Math.max(1, Math.floor(map.buildings.length / 600))) {
    const b = map.buildings[i];
    let sx = 0, sy = 0;
    for (let j = 0; j < b.p.length; j += 2) { sx += b.p[j]; sy += b.p[j + 1]; }
    n++;
    if (wet(sx / (b.p.length / 2), sy / (b.p.length / 2))) bad++;
  }
  ok(bad <= Math.max(1, n * 0.01), `${label}: buildings in water ${bad}/${n}`);
  let wetRoads = 0, nr = 0;
  for (const r of map.roads) {
    if (r.k === 'bridge') continue;
    for (let j = 0; j + 3 < r.p.length; j += 2) { nr++; if (wet((r.p[j] + r.p[j + 2]) / 2, (r.p[j + 1] + r.p[j + 3]) / 2)) wetRoads++; }
  }
  ok(wetRoads <= Math.max(2, nr * 0.01), `${label}: road segments over water ${wetRoads}/${nr}`);
  if ((opts.density ?? 0.6) >= 0.5 && (opts.sizeKm ?? 2) >= 2) ok(map.buildings.some(b => b.h >= 60), `${label}: has towers`);
  ok(map.buildings.every(b => b.h > 0 && b.h <= 230), `${label}: heights in range`);
  return st;
}
function insideCentroid(poly, p) {
  let sx = 0, sy = 0;
  for (let j = 0; j < p.length; j += 2) { sx += p[j]; sy += p[j + 1]; }
  return pointInPoly(poly, sx / (p.length / 2), sy / (p.length / 2));
}

// --- campaign cities
for (const c of CAMPAIGN) {
  const t0 = now();
  const map = getCampaignMap(c.id);
  const st = checkMap(map, 'campaign ' + c.id, { ...c.gen, minBuildings: 800 });
  ok(map.name === c.name && map.welcome === c.welcome, `${c.id}: name/welcome`);
  ok(getCampaignMap(c.id) === map, `${c.id}: memoised`);
  console.log(`campaign ${c.id.padEnd(13)} ${c.gen.sizeKm}km ${c.gen.water.padEnd(7)} ${String(Math.round(now() - t0)).padStart(5)} ms  buildings ${st.buildings}  roads ${st.roads}  bridges ${st.bridges}  pop ${st.nominalPop}  specials ${JSON.stringify(st.specials)}`);
}

// --- random seeds / options
const combos = [];
for (const water of WATER_TYPES) for (const sizeKm of [1, 2.5]) combos.push({ seed: 1000 + combos.length * 37, sizeKm, water, density: 0.3 + (combos.length % 4) * 0.2, bridges: water === 'none' ? 0 : 1 + (combos.length % 4), stages: 3 + (combos.length % 5) });
for (const o of combos) {
  const t0 = now();
  const map = generateCity(o);
  const ms = now() - t0;
  const st = checkMap(map, `seed ${o.seed} ${o.sizeKm}km ${o.water}`, { ...o, minBuildings: o.sizeKm < 1.5 ? 200 : 600 });
  console.log(`seed ${String(o.seed).padEnd(5)} ${o.sizeKm}km ${o.water.padEnd(7)} d${o.density.toFixed(1)} ${String(Math.round(ms)).padStart(5)} ms  buildings ${st.buildings}  bridges ${st.bridges}/${o.bridges}`);
}

// --- determinism
{
  const o = { seed: 4242, sizeKm: 2, water: 'river', density: 0.7, bridges: 3, stages: 5 };
  const a = serializeMap(generateCity(o)), b = serializeMap(generateCity(o));
  ok(a === b, 'same seed -> identical map');
  ok(serializeMap(generateCity({ ...o, seed: 4243 })) !== a, 'different seed -> different map');
  ok(generateCity({ ...o, seed: 'harbour' }).seed === generateCity({ ...o, seed: 'harbour' }).seed, 'string seeds hash consistently');
}

// --- timing targets
for (const [size, limit] of [[4, 3000], [5, 6000]]) {
  const t0 = now();
  const map = generateCity({ seed: 77 + size, sizeKm: size, water: 'coast', density: 0.85, bridges: 3, stages: 7 });
  const ms = now() - t0;
  ok(ms < limit, `${size} km city in ${Math.round(ms)} ms (limit ${limit})`);
  console.log(`timing ${size} km: ${Math.round(ms)} ms, ${map.buildings.length} buildings, ${map.roads.length} roads`);
}

// --- motorways: viaducts over the main roads, slip roads that work both ways, the centre reaches the deck
{
  const { World, TYPE } = await import('../js/sim/world.js');
  const { INF } = await import('../js/sim/nav.js');
  const small = generateCity({ seed: 7, sizeKm: 2.5, water: 'river', density: 0.7, stages: 5 });
  ok(!small.roads.some(r => r.z) && small.v === 1, 'a city under 3 km has no motorway and stays a v1 map');
  const off = generateCity({ seed: 7, sizeKm: 3, water: 'river', density: 0.7, stages: 5, motorways: false });
  ok(!off.roads.some(r => r.z), 'motorways: false leaves the city flat');
  ok(!CAMPAIGN.some(c => getCampaignMap(c.id).roads.some(r => r.z)), 'campaign cities stay flat');
  const map = generateCity({ seed: 7, sizeKm: 3, water: 'river', density: 0.7, stages: 5 });
  ok(validateMap(map).ok && map.v === 2, 'a 3 km city with a motorway is a valid v2 map');
  const mw = map.roads.filter(r => r.z && r.w === 24), slips = map.roads.filter(r => r.z && r.w === 8);
  ok(mw.length === 1 && Math.max(...mw[0].z) === 1 && slips.length >= 2 && slips.every(r => r.z[0] === 1 && r.z[r.z.length - 1] === 0), `one motorway on viaducts with slip roads (${slips.length})`);
  const w = new World(map, { seed: 1, sandbox: true, stage: map.levels.length - 1, mutators: ['population.scale=0', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false'] });
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i]) w.remove(i);
  const g = w.grid, dk = g.deck, cs = g.cell;
  // a node in the middle of the motorway's longest deck
  const deck = g.bridges.filter(b => b.deck).sort((a, b) => b.nodes.length - a.nodes.length)[0];
  const f = deck.nodes[deck.nodes.length >> 1], c = dk.cell[f - dk.N];
  const h = w.spawn(TYPE.SOLDIER, (c % g.gw + 0.5) * cs, (((c / g.gw) | 0) + 0.5) * cs, 0, dk.tier[f - dk.N]);
  w.A.stun[h] = 1e9;
  w.computeFields();
  const lv = map.levels[0].p;
  let cx = 0, cy = 0;
  for (let k = 0; k < lv.length; k += 2) { cx += lv[k]; cy += lv[k + 1]; }
  cx /= lv.length / 2; cy /= lv.length / 2;
  const centre = Math.floor(cy / cs) * g.gw + Math.floor(cx / cs);
  ok(g.terrain[centre] === 1 && w.nav.scent.dist[centre] !== INF, 'the motorway deck reaches the city centre');
  w.remove(h);
  const g2 = w.spawn(TYPE.SOLDIER, cx, cy);
  w.A.stun[g2] = 1e9;
  w.computeFields();
  const N = g.gw * g.gh;
  let rn = 0;
  for (let k = 0; k < dk.D; k++) if (!w.nav.pass[N + k] || w.nav.scent.dist[N + k] !== INF) rn++;
  ok(rn === dk.D, `and the centre reaches every deck node (${rn}/${dk.D}): the slip roads work both ways`);
}

console.log(`\nmap_citygen: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
