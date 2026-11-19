// node test/bigmap.mjs — big sheets (8-10 km): size limits, the population cap, an 8 km generated city in battle,
// tiled imports, memory. Long measurements live in test/bigmap_bench.mjs.
import { generateCity, normalizeCityOptions } from '../js/map/citygen.js';
import { validateMap, normalizeMap, makeStages, popLimit, mapStats, LIMITS, FORMAT, VERSION } from '../js/map/format.js';
import { IMPORT_RANGE, snapSize, planTiles, tileCount, fetchArea, isHugeMap, NET, OVERPASS_MIRRORS, resetMirrorHealth } from '../js/map/osm.js';
import { useMemoryCache } from '../js/map/osmcache.js';
import { CAMPAIGN, getCampaignMap } from '../js/map/campaign.js';
import { makeConfig, DEFAULTS } from '../js/data/config.js';
import { World, TYPE } from '../js/sim/world.js';
import { installCombat } from '../js/sim/units.js';
import { bigMul } from '../js/sim/nav.js';
import { hardCap } from '../js/sim/agents.js';
import { pointInPoly } from '../js/util/geom.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.error('FAIL', msg); } };
const now = () => performance.now();

// ---------------------------------------------------------------- limits
ok(normalizeCityOptions({ sizeKm: 10 }).sizeKm === 10 && normalizeCityOptions({ sizeKm: 14 }).sizeKm === 10, 'generator takes 10 km, clamps above');
ok(IMPORT_RANGE.max === 10 && snapSize(8) === 8 && snapSize(10) === 10 && snapSize(11) === 10, 'import sizes up to 10 km');
ok(planTiles(51.5, -0.1, 8).length === 16 && planTiles(51.5, -0.1, 10).length === 25 && tileCount(10) === 25 && tileCount(4) === 4, '2 km tiles: 16 for 8 km, 25 for 10 km');
ok(LIMITS.maxSize >= 12000, 'format allows 12 km sheets');

// a synthetic sheet: n x n buildings of side b metres on a step grid
function gridSheet(sizeM, step, b, stages = 5) {
  const buildings = [];
  for (let y = step / 2; y + b < sizeM; y += step) for (let x = step / 2; x + b < sizeM; x += step) buildings.push({ p: [x, y, x + b, y, x + b, y + b, x, y + b], h: 9, k: 'res' });
  const m = normalizeMap({ format: FORMAT, v: VERSION, name: 'grid ' + sizeM, source: 'editor', seed: 5, w: sizeM, h: sizeM, buildings, roads: [], water: [], parks: [] });
  m.levels = makeStages(sizeM, sizeM, stages, { seed: 5 });
  return m;
}

// ---------------------------------------------------------------- population cap
const cap = DEFAULTS.population.autoCap;
ok(cap >= 100000 && cap <= 150000 && DEFAULTS.population.autoCapKm2 === 25, `cap ${cap} on sheets over 25 km2`);
const s5 = gridSheet(5000, 100, 70);          // 2,500 m2 footprints, about 240,000 nominal on 25 km2
const l5 = popLimit(s5);
ok(l5.nominal > 200000 && !l5.limited && l5.factor === 1, `5 km sheet is never thinned (nominal ${Math.round(l5.nominal)})`);
const s8 = gridSheet(8000, 100, 70);
const l8 = popLimit(s8);
ok(l8.limited && Math.abs(l8.factor * l8.nominal - cap) < 1, `8 km sheet thinned to ${cap} (factor ${l8.factor.toFixed(3)})`);
ok(popLimit(s8, makeConfig(['population.autoCap=0'])).factor === 1, 'autoCap=0 turns the limit off');
ok(Math.abs(popLimit(s8, makeConfig(['population.perM2=0.03'])).factor * popLimit(s8, makeConfig(['population.perM2=0.03'])).nominal - cap) < 1, 'limit follows mutated perM2');
const sparse = gridSheet(8000, 400, 30);
ok(!popLimit(sparse).limited, 'a sparse 8 km sheet under the cap keeps everyone');
for (const c of CAMPAIGN) ok(popLimit(getCampaignMap(c.id)).factor === 1, `campaign ${c.id} unchanged by the cap`);
const g5 = generateCity({ seed: 3, sizeKm: 5, water: 'river', density: 1, stages: 5 });
ok(popLimit(g5).factor === 1, '5 km generated city at full density unchanged');

// ---------------------------------------------------------------- an 8 km generated city
let t = now();
const map = generateCity({ seed: 81118, sizeKm: 8, water: 'river', density: 0.6, bridges: 4, stages: 5 });
const genMs = now() - t;
const v = validateMap(map), st = mapStats(map);
ok(v.ok, '8 km city valid: ' + v.errors.join('; '));
ok(!v.warnings.some(w => /contain/.test(w)), '8 km stages nested');
ok(genMs < 20000, `8 km generated in ${Math.round(genMs)} ms`);
ok(st.buildings > 50000 && st.roads > 1500, `8 km city: ${st.buildings} buildings, ${st.roads} roads`);
ok(map.roads.some(r => / Orbital$/.test(r.name || '')), 'metro sheet has an orbital road');
ok(map.roads.filter(r => r.k === 'rail').length >= 2, 'metro sheet has rail');
ok(map.levels.every((l, i) => i === map.levels.length - 1 || l.p.length >= 40), 'big sheet stage outlines have fine detail');
const s1 = map.levels[0].p;
ok(map.buildings.some(b => b.k === 'civic' && pointInPoly(s1, b.p[0], b.p[1])), 'stage 1 has a civic building');
const lim = popLimit(map);
ok(lim.limited && lim.factor < 0.6, `8 km city thinned (factor ${lim.factor.toFixed(3)}, nominal ${Math.round(lim.nominal)})`);
ok(isHugeMap(map), '8 km city counts as a large map');

const ab0 = process.memoryUsage().arrayBuffers;
t = now();
const world = new World(map, { seed: 7, stage: map.levels.length - 1 });
installCombat(world);
const worldMs = now() - t;
ok(world.popLimited && Math.abs(world.popFactor - lim.factor) < 1e-9, 'world uses the same factor as the shell');
ok(Math.abs(world.stats.civStart - cap) < cap * 0.01, `final stage spawns about ${cap} (got ${world.stats.civStart})`);
ok(bigMul(world) > 1.5, 'big stage refreshes its fields faster than the flat rate');
const abMB = (process.memoryUsage().arrayBuffers - ab0) / 1e6;
ok(abMB < 450, `8 km world typed arrays ${Math.round(abMB)} MB`);
t = now();
world.beginStage(0);
const s0Ms = now() - t;
const want0 = Math.round(world.C * lim.factor);
ok(Math.abs(world.stats.civStart - want0) <= 2 && world.stats.civStart < world.C * 0.6, `stage 1 thinned by the same factor (${world.stats.civStart} of ${Math.round(world.C)})`);
ok(bigMul(world) === 1, 'small stage keeps the flat field rates');
world.beginStage(map.levels.length - 1);
const cx = map.w / 2, cy = map.h / 2;
for (const [dx, dy] of [[0, 0], [-900, -600], [700, 500]]) {
  const x = cx + dx, y = cy + dy;
  world.exec({ t: 'zone.add', p: [x - 90, y - 90, x + 90, y - 90, x + 90, y + 90, x - 90, y + 90] });
}
for (const c of world.zones.comps) {
  const [x0, y0, x1, y1] = c.bbox.map(q => q * world.grid.cell);
  world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
}
const r = world.exec({ t: 'ready' });
ok(r.ok && world.phase === 'battle', 'READY on the 8 km final stage');
const z0 = world.counts[TYPE.ZOMBIE];
ok(z0 > 0 && z0 < 2000, `outbreak thinned with the crowd (${z0} zombies)`);
let err = null, ticks = 0;
t = now();
try { for (; ticks < 300 && world.phase === 'battle'; ticks++) world.step(); } catch (e) { err = e; }
const tickMs = (now() - t) / Math.max(1, ticks);
ok(!err, '300 battle ticks run: ' + (err && err.stack));
ok(world.A.count <= hardCap(world) && world.counts[TYPE.ZOMBIE] > 0, `agents ${world.A.count}, zombies ${world.counts[TYPE.ZOMBIE]}`);
ok(Number.isFinite(world.hash()), 'hash after battle');

// population scale still goes higher, up to the hard cap
const w2 = new World(map, { seed: 7, stage: map.levels.length - 1, mutators: ['population.scale=2.5'] });
ok(w2.largeMap && w2.stats.civStart === DEFAULTS.sim.maxAgents, `scale 250% fills to the ${DEFAULTS.sim.maxAgents} cap`);

// ---------------------------------------------------------------- 8 km tiled fetch (mocked): 16 parts, 2 in flight
useMemoryCache();
Object.assign(NET, { hedgeMs: 40, firstByteMs: 120, firstByteMaxMs: 700, stallMs: 400, hardMs: 1500, backoffMs: [20, 40], roundCapMs: 500 });
OVERPASS_MIRRORS.splice(0, OVERPASS_MIRRORS.length, 'https://m0.test/api/interpreter', 'https://m1.test/api/interpreter');
resetMirrorHealth();
let inflight = 0, maxInflight = 0, calls = 0, nextId = 1;
const mock = (url, opts) => {
  calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
  return new Promise((res) => setTimeout(() => {
    inflight--;
    const id = nextId++;
    res(new Response(JSON.stringify({ elements: [{ type: 'node', id, lat: 51.5, lon: -0.1 }, { type: 'node', id: 0, lat: 51.5, lon: -0.1 }] }), { status: 200 }));
  }, 3));
};
const parts = new Set();
const fa = await fetchArea({ lat: 51.5, lon: -0.1, sizeKm: 8, fetchImpl: mock, onProgress: (p) => { if (p.phase === 'tile') parts.add(p.tile); } });
ok(calls === 16 && maxInflight <= 2 && fa.info.tiles === 16, `8 km fetch: ${calls} requests, at most ${maxInflight} in flight`);
ok(parts.size === 16, 'progress reported for every part');
ok(fa.elements.length === 17, 'parts de-duplicated');

// one part finds every server busy for a whole round of rounds: it waits and asks again, the import still completes
NET.tileWaitMs = [30, 60, 90];
resetMirrorHealth();
const seenKeys = [], tries = new Map();
let waits = 0;
const busyPart = (url, opts) => {
  const q = decodeURIComponent(String(opts.body).slice(5)), key = /\[bbox:([^\]]+)\]/.exec(q)[1];
  if (!seenKeys.includes(key)) seenKeys.push(key);
  tries.set(key, (tries.get(key) || 0) + 1);
  const fail = key === seenKeys[3] && tries.get(key) <= 6;
  return new Promise((res) => setTimeout(() => res(fail ? new Response('rate limited', { status: 429 })
    : new Response(JSON.stringify({ elements: [{ type: 'node', id: nextId++, lat: 51.5, lon: -0.1 }] }), { status: 200 })), 3));
};
const fb = await fetchArea({ lat: 51.6, lon: -0.1, sizeKm: 6, fetchImpl: busyPart, onProgress: (p) => { if (p.phase === 'partwait') waits++; } });
ok(fb.info.tiles === 9 && fb.elements.length === 9 && waits >= 1, `a busy part waits (${waits}x) and the 6 km import completes`);

console.log(`timing: gen ${Math.round(genMs)} ms, world ${Math.round(worldMs)} ms, stage 1 ${Math.round(s0Ms)} ms, battle ${tickMs.toFixed(1)} ms/tick`);
console.log(`bigmap: ${passes} passed, ${fails} failed`);
process.exitCode = fails ? 1 : 0;
