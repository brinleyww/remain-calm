// COMBAT target sharing: mortars spread over separate clusters instead of doubling up, a row of garrisons spreads its
// volleys over a column of zombies, and direct fire takes the zombie next to residents first. Prints the numbers.
// Run: node test/combat_targeting.mjs            (asserts)
//      node test/combat_targeting.mjs --root DIR (same scenarios against another copy of the game, numbers only)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ri = process.argv.indexOf('--root');
const root = ri > 0 ? resolve(process.argv[ri + 1]) : resolve(here, '..');
const check = ri < 0;
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const { World, TYPE } = await imp('js/sim/world.js');
const { installCombat } = await imp('js/sim/units.js');

const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.03', 'mutation.firstSec=100000', 'zombie.speed=0', 'civ.panicRadius=0', 'civ.wander=0'];
const SEEDS = [11, 12, 13, 14, 15, 16];
const mk = (map, seed, mut) => installCombat(new World(map, { seed, stage: 2, sandbox: true, mutators: [...QUIET, ...mut] }));
const clearAll = (w) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE || w.A.type[i] === TYPE.CIV) w.remove(i); };
const pile = (w, x, y, n, r) => { for (let k = 0; k < n; k++) { const a = k * 2.4, d = r * Math.sqrt((k + 0.5) / n); w.spawn(TYPE.ZOMBIE, x + Math.cos(a) * d, y + Math.sin(a) * d); } };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const f2 = (v) => v.toFixed(2);

// ---------------------------------------------------------------- 8 mortars, 5 separate clusters of 12
function mortars(seed) {
  const map = makeTestMap({ size: 1200, river: false });
  const w = mk(map, seed, ['zombie.hpStart=20', 'zombie.hpMax=20']);
  w.exec({ t: 'zone.add', p: blockRect(4, 5, 5, 5) });
  const guns = w.buildings.filter((b) => b.zone === 0).slice(0, 8)
    .map((b) => w.exec({ t: 'unit.place', type: 'mortar', x: b.cx, y: b.cy })).map((r) => w.units.find((u) => u.id === r.id));
  w.exec({ t: 'ready' });
  clearAll(w);
  const cl = [];
  for (let k = 0; k < 5; k++) { const a = Math.PI / 2 + k * Math.PI * 0.4; cl.push([550 + 380 * Math.cos(a), 600 + 380 * Math.sin(a)]); }
  for (const [x, y] of cl) pile(w, x, y, 12, 4);
  const seen = new Set();
  let first = null;
  for (let k = 0; k < 1200 && w.phase === 'battle'; k++) {
    w.step();
    const fresh = w.combat.shells.filter((s) => !seen.has(s));
    for (const s of fresh) seen.add(s);
    if (!first && fresh.length) {
      first = new Set(fresh.map((s) => { let b = 0, bd = Infinity; cl.forEach(([x, y], j) => { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; b = j; } }); return b; }));
    }
  }
  const shells = guns.reduce((s, u) => s + u.shots, 0), kills = guns.reduce((s, u) => s + u.kills, 0);
  return { first: first ? first.size : 0, shells, kills, perShell: kills / Math.max(1, shells), clear: w.phase === 'won' ? w.t : Infinity, n: guns.length, hash: w.hash() };
}

// ---------------------------------------------------------------- 10 garrisons in a row, 20 zombies coming down the street
function garrisons(seed) {
  const map = makeTestMap({ size: 800, river: false });
  const w = mk(map, seed, ['zombie.hpStart=12', 'zombie.hpMax=12', 'units.garrison.range=600']);
  w.exec({ t: 'zone.add', p: blockRect(0, 0, 4, 0) });
  const row = w.buildings.filter((b) => b.zone === 0 && Math.abs(b.cy - 123) < 3).sort((a, b) => a.cx - b.cx).slice(0, 10);
  const guns = row.map((b) => w.exec({ t: 'unit.place', type: 'garrison', x: b.cx, y: b.cy })).map((r) => w.units.find((u) => u.id === r.id));
  w.exec({ t: 'ready' });
  clearAll(w);
  for (let k = 0; k < 20; k++) w.spawn(TYPE.ZOMBIE, 560 + k * 5, 150);
  const distinct = [], shooters = [];
  for (let k = 0; k < 600 && w.phase === 'battle'; k++) {
    w.step();
    const fired = guns.filter((u) => u.fireT === w.t);
    if (fired.length < 2) continue;
    shooters.push(fired.length);
    distinct.push(new Set(fired.map((u) => Math.round(u.ax * 4) + ',' + Math.round(u.ay * 4))).size);
  }
  return { distinct: mean(distinct), shooters: mean(shooters), clear: w.phase === 'won' ? w.t : Infinity, n: guns.length, hash: w.hash() };
}

// ---------------------------------------------------------------- the zombie next to residents goes first
function threatFirst() {
  const map = makeTestMap({ size: 800, river: false });
  const w = mk(map, 21, ['zombie.hpStart=1e6', 'zombie.hpMax=1e6', 'units.garrison.range=300', 'civ.walk=0.01', 'civ.run=0.01']);
  const b = w.buildings.find((q) => Math.abs(q.cx - 177) < 3 && Math.abs(q.cy - 177) < 3);
  const id = w.exec({ t: 'unit.place', type: 'garrison', x: b.cx, y: b.cy }).id, g = w.units.find((u) => u.id === id);
  w.exec({ t: 'ready' });
  clearAll(w);
  for (let k = 0; k < 8; k++) w.spawn(TYPE.CIV, 450 + (k % 4) * 2, 148 + (k >> 2) * 3);
  const near = w.spawn(TYPE.ZOMBIE, 220, 150), danger = w.spawn(TYPE.ZOMBIE, 432, 150);
  w.computeFields();
  for (let k = 0; k < 400 && !g.shots; k++) w.step();
  return { picked: g.tgt === danger ? 'zombie by the residents' : g.tgt === near ? 'nearest zombie' : String(g.tgt), ok: g.tgt === danger };
}

// ---------------------------------------------------------------- weapon-specific choices: which of two groups gets the first round
// Returns the index (0 or 1) of the group nearest to the first shell or slug, or -1 when nothing fired.
function firstAt(seed, type, at, groups, setup, mut = []) {
  const map = makeTestMap({ size: 800, river: false });
  const w = mk(map, seed, ['zombie.hpStart=1e6', 'zombie.hpMax=1e6', 'zone.outsideStartDelay=0', ...mut]);
  const r = w.exec({ t: 'unit.place', type, x: at[0], y: at[1] }), u = w.units.find((q) => q.id === r.id);
  w.exec({ t: 'ready' });
  clearAll(w);
  const ids = groups.map((g) => g.map(([x, y]) => w.spawn(TYPE.ZOMBIE, x, y)));
  if (setup) setup(w, ids);
  w.computeFields();
  for (let k = 0; k < 800 && w.phase === 'battle' && !u.shots; k++) w.step();
  if (!u.shots) return -1;
  const p = w.combat.shells.length ? w.combat.shells[0] : { x: u.ax, y: u.ay };
  const d = groups.map((g) => Math.min(...g.map(([x, y]) => Math.hypot(p.x - x, p.y - y))));
  return d[0] <= d[1] ? 0 : 1;
}
const ring = (x, y, n, r) => Array.from({ length: n }, (_, k) => [x + Math.cos(k * 2.4) * r * Math.sqrt((k + 0.5) / n), y + Math.sin(k * 2.4) * r * Math.sqrt((k + 0.5) / n)]);
const CHOICES = [
  ['howitzer shells a group of 4, not a lone zombie at the residents', 0, (sd) => firstAt(sd, 'howitzer', [150, 650], [ring(650, 250, 4, 3), [[450, 650]]],
    (w) => { for (let k = 0; k < 6; k++) w.spawn(TYPE.CIV, 462 + k * 1.5, 650); }, ['civ.walk=0.01', 'civ.run=0.01'])],
  ['gas mortar skips a stunned group for a fresh one', 1, (sd) => firstAt(sd, 'gasMortar', [177, 177], [ring(550, 150, 8, 4), ring(150, 550, 8, 4)],
    (w, ids) => { for (const i of ids[0]) w.A.stun[i] = 20; })],
  ['incendiary mortar skips a group already on fire', 1, (sd) => firstAt(sd, 'fireMortar', [177, 177], [ring(550, 150, 8, 4), ring(150, 550, 8, 4)],
    (w) => w.ignite(550, 150, 16, 1))],
  ['rail cannon fires down the line of 10, not the line of 5', 1, (sd) => firstAt(sd, 'railgun', [150, 650],
    [Array.from({ length: 5 }, (_, k) => [200 + k * 8, 650]), Array.from({ length: 10 }, (_, k) => [150, 600 - k * 8])])],
];

const M = SEEDS.map(mortars), G = SEEDS.map(garrisons), th = threatFirst();
const CH = CHOICES.map(([name, want, fn]) => { const hits = SEEDS.filter((sd) => fn(sd) === want).length; return { name, hits, ok: hits === SEEDS.length }; });
const clearM = M.filter((r) => Number.isFinite(r.clear)), clearG = G.filter((r) => Number.isFinite(r.clear));
console.log(`[${check ? 'this tree' : root}] over ${SEEDS.length} seeds`);
console.log(`  mortars (${M[0].n} guns, 5 clusters x 12): first volley hits ${f2(mean(M.map((r) => r.first)))} distinct clusters; ` +
  `${f2(mean(M.map((r) => r.perShell)))} kills per shell (${f2(mean(M.map((r) => r.shells)))} shells); ` +
  `cleared in ${clearM.length ? f2(mean(clearM.map((r) => r.clear))) : '-'} s (${clearM.length}/${M.length} runs)`);
console.log(`  garrisons (${G[0].n} guns, 20 zombies): ${f2(mean(G.map((r) => r.distinct)))} distinct targets per volley of ${f2(mean(G.map((r) => r.shooters)))} shooters; ` +
  `cleared in ${clearG.length ? f2(mean(clearG.map((r) => r.clear))) : '-'} s (${clearG.length}/${G.length} runs)`);
console.log(`  threat: first target is the ${th.picked}`);
for (const c of CH) console.log(`  ${c.hits}/${SEEDS.length} runs: ${c.name}`);

if (check) {
  assert(M.every((r) => r.first === 5), 'mortars: the first volley covers all 5 clusters in every run');
  assert(mean(M.map((r) => r.perShell)) >= 5 && clearM.length === M.length, `mortars: ${f2(mean(M.map((r) => r.perShell)))} kills per shell and every run cleared`);
  assert(mean(G.map((r) => r.distinct)) >= 4, `garrisons: volleys spread over ${f2(mean(G.map((r) => r.distinct)))} targets`);
  assert(clearG.length === G.length && mean(clearG.map((r) => r.clear)) <= 3.5, `garrisons: column cleared in ${clearG.length ? f2(mean(clearG.map((r) => r.clear))) : '-'} s`);
  assert(th.ok, 'direct fire takes the zombie next to residents before the nearer one');
  for (const c of CH) assert(c.ok, `${c.name} (${c.hits}/${SEEDS.length})`);
  assert(mortars(SEEDS[0]).hash === M[0].hash && garrisons(SEEDS[0]).hash === G[0].hash, 'same seed, same result hash (target sharing is deterministic)');
  console.log('combat_targeting: all passed');
}
