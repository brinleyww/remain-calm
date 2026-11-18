// CROWD performance: a default 4 km generated city on its final stage at the default population, in battle with a
// basic defence (zones, gates, a garrison line). Targets: 9 ms/tick average, 15 ms at p95.
// Usage: node test/crowd_bench.mjs [--size 4] [--scale 1] [--ticks 600] [--warm 100] [--seed 11]
import { World, TYPE } from '../js/sim/world.js';
import { generateCity } from '../js/map/citygen.js';
import { installCombat } from '../js/sim/units.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && Number.isFinite(+args[i + 1]) ? +args[i + 1] : d; };
const size = arg('size', 4), ticks = arg('ticks', 600), warm = arg('warm', 100), seed = arg('seed', 11), scale = arg('scale', 0);

const t0 = performance.now();
const map = generateCity({ seed, sizeKm: size, water: 'river', density: 0.6, bridges: 3, stages: 5 });
const tGen = performance.now() - t0;
const world = installCombat(new World(map, { seed: 42, stage: map.levels.length - 1, sandbox: true, mutators: scale ? [`population.scale=${scale}`] : [] }));
const tWorld = performance.now() - t0 - tGen;
const cx = map.w / 2, cy = map.h / 2, R = map.w * 0.3;
for (const [fx, fy] of [[0, 0], [-1, -0.7], [0.9, 0.6], [-0.7, 1], [1, -0.8], [0.1, -1]]) {
  const x = cx + fx * R, y = cy + fy * R;
  world.exec({ t: 'zone.add', p: [x - 80, y - 80, x + 80, y - 80, x + 80, y + 80, x - 80, y + 80] });
}
for (const c of world.zones.comps) {
  const [x0, y0, x1, y1] = c.bbox.map((v) => v * world.grid.cell);
  world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  world.exec({ t: 'gate.add', x: x0 + 2, y: (y0 + y1) / 2 });
}
const garrisons = world.exec({ t: 'unit.paint', type: 'garrison', path: [cx - R, cy, cx + R, cy], w: 120 }).count || 0;
world.exec({ t: 'ready' });
const civ0 = world.counts[TYPE.CIV];

const times = new Map();
for (const s of world._systems) {
  const up = s.update;
  times.set(s.name, 0);
  s.update = (w, dt) => { const a = performance.now(); up(w, dt); times.set(s.name, times.get(s.name) + performance.now() - a); };
}
for (let k = 0; k < warm && world.phase === 'battle'; k++) world.step();
for (const k of times.keys()) times.set(k, 0);
const dts = [];
let agents = 0;
for (let k = 0; k < ticks && world.phase === 'battle'; k++) {
  const a = performance.now();
  world.step();
  dts.push(performance.now() - a);
  agents += world.A.count;
}
const n = dts.length || 1, sorted = dts.slice().sort((a, b) => a - b);
const avg = dts.reduce((a, b) => a + b, 0) / n, p95 = sorted[Math.floor(n * 0.95)] || 0, worst = sorted[n - 1] || 0;
console.log(`map ${size} km seed ${seed}: ${map.buildings.length} buildings, gen ${tGen.toFixed(0)} ms, world ${tWorld.toFixed(0)} ms, C ${Math.round(world.C)}`);
console.log(`residents at READY ${civ0}, avg agents ${Math.round(agents / n)}, garrisons ${garrisons}, residents now ${world.counts[TYPE.CIV]}, zombies now ${world.counts[TYPE.ZOMBIE]}, phase ${world.phase}`);
console.log('per system (ms/tick):', [...times].map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join('  '));
console.log(`ms/tick avg ${avg.toFixed(2)}  p95 ${p95.toFixed(2)}  worst ${worst.toFixed(2)}  over ${n} ticks (targets 9 / 15)`);
