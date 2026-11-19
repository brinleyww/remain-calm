// COMBAT performance: a generated 3 km city with a large defence (hundreds of units, traps, lines) and vehicles in battle.
// Usage: node test/combat_bench.mjs [--ticks N] [--flat (the city without its motorway)]
import { World, TYPE } from '../js/sim/world.js';
import { DEFAULTS } from '../js/data/config.js';
import { generateCity } from '../js/map/citygen.js';
import { installCombat } from '../js/sim/units.js';

const args = process.argv.slice(2);
const ticks = +(args[args.indexOf('--ticks') + 1] || 0) || 1200;
const map = generateCity({ seed: 7, sizeKm: 3, water: 'river', density: 0.8, stages: 5, motorways: !args.includes('--flat') });
const world = installCombat(new World(map, {
  seed: 42, stage: map.levels.length - 1, sandbox: true,
  mutators: ['population.scale=1.3', 'outbreak.zombies=700', 'sim.maxAgents=90000', ...Object.keys(DEFAULTS.abilities).map((id) => `abilities.${id}.unlock=0`)],
}));
const cx = map.w / 2, cy = map.h / 2;
for (const [dx, dy] of [[0, 0], [-700, -500], [600, 400]]) {
  const x = cx + dx, y = cy + dy;
  world.exec({ t: 'zone.add', p: [x - 90, y - 90, x + 90, y - 90, x + 90, y + 90, x - 90, y + 90] });
}
for (const c of world.zones.comps) {
  const [x0, y0, x1, y1] = c.bbox.map((v) => v * world.grid.cell);
  world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
}
const tB = performance.now();
const paint = (type, path, w) => world.exec({ t: 'unit.paint', type, path, w }).count || 0;
let n = 0;
n += paint('garrison', [300, 300, map.w - 300, map.h - 300], 300);
n += paint('garrison', [300, map.h - 300, map.w - 300, 300], 300);
n += paint('sniper', [cx - 600, cy, cx + 600, cy], 60);
n += paint('mortar', [cx, cy - 600, cx, cy + 600], 60);
n += paint('mine', [cx - 400, cy + 250, cx + 400, cy + 250], 8);
for (let k = 0; k < 30; k++) n += world.exec({ t: 'unit.place', type: 'turret', x: cx - 450 + k * 30, y: cy - 150 }).ok ? 1 : 0;
for (let k = 0; k < 10; k++) n += world.exec({ t: 'unit.place', type: 'spikes', p: [cx - 500 + k * 100, cy + 300, cx - 420 + k * 100, cy + 300] }).ok ? 1 : 0;
world.exec({ t: 'loadout.set', abilities: { tank: 2, apc: 2, helicopter: 2, gunship: 1, bus: 2 } });
const tPlace = performance.now() - tB;
world.exec({ t: 'ready' });
const times = new Map();
for (const s of world._systems) {
  const up = s.update;
  times.set(s.name, 0);
  s.update = (w, dt) => { const a = performance.now(); up(w, dt); times.set(s.name, times.get(s.name) + performance.now() - a); };
}
for (let k = 0; k < 60; k++) world.step();
for (const [id, x, y] of [['tank', cx + 300, cy], ['apc', cx - 300, cy], ['helicopter', cx, cy + 400], ['gunship', cx + 500, cy - 500], ['bus', cx - 200, cy + 200], ['tank', cx - 800, cy - 300]]) {
  world.exec({ t: 'ability.use', id, x, y });
}
for (const k of times.keys()) times.set(k, 0);
let worst = 0, worstCombat = 0;
const t1 = performance.now();
let done = 0;
for (let k = 0; k < ticks && world.phase === 'battle'; k++, done++) {
  const c0 = times.get('combat') + times.get('support');
  const a = performance.now();
  world.step();
  const d = performance.now() - a;
  if (d > worst) worst = d;
  const dc = times.get('combat') + times.get('support') - c0;
  if (dc > worstCombat) worstCombat = dc;
}
const el = performance.now() - t1;
console.log(`citygen 3 km: ${world.units.length} units placed (${n} commands, ${tPlace.toFixed(0)} ms), ${world.vehicles.length} vehicles, ${world.A.count} agents, phase ${world.phase}`);
console.log(`ms/tick avg ${(el / done).toFixed(2)}  worst ${worst.toFixed(2)}  over ${done} ticks`);
console.log(`combat+support ms/tick avg ${((times.get('combat') + times.get('support')) / done).toFixed(3)}  worst ${worstCombat.toFixed(2)}`);
console.log('per system (ms/tick):', [...times].map(([k, v]) => `${k} ${(v / done).toFixed(2)}`).join('  '));
console.log('kills:', JSON.stringify(world.stats.killsBy), ' zombies left', world.counts[TYPE.ZOMBIE]);
