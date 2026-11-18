// SIM performance benchmark: ~40k agents in battle. Usage: node test/sim_bench.mjs [--city] [--ticks N]
// --city uses the procedural city generator (js/map/citygen.js) instead of the hand-made grid map.
import { World, TYPE } from '../js/sim/world.js';
import { makeTestMap, blockRect } from './sim_testmap.mjs';

const args = process.argv.slice(2);
const ticks = +(args[args.indexOf('--ticks') + 1] || 0) || 400;
const useCity = args.includes('--city');

let map, scale;
if (useCity) {
  const { generateCity } = await import('../js/map/citygen.js');
  map = generateCity({ seed: 7, sizeKm: 3, water: 'river', density: 0.8, stages: 5 });
  scale = 1.3;
} else {
  map = makeTestMap({ size: 3000, river: true, stages: 5, seed: 99 });
  scale = 0.4;
}

const t0 = performance.now();
const world = new World(map, {
  seed: 42, stage: map.levels.length - 1,
  mutators: [`population.scale=${scale}`, 'outbreak.zombies=700', 'sim.maxAgents=90000'],
});
const tBuild = performance.now() - t0;
if (!useCity) {
  world.exec({ t: 'zone.add', p: blockRect(5, 5, 7, 7) });
  world.exec({ t: 'zone.add', p: blockRect(20, 18, 22, 20) });
} else {
  const cx = map.w / 2, cy = map.h / 2;
  for (const [dx, dy] of [[0, 0], [-700, -500], [600, 400], [-500, 700], [800, -600]]) {
    const x = cx + dx, y = cy + dy;
    world.exec({ t: 'zone.add', p: [x - 90, y - 90, x + 90, y - 90, x + 90, y + 90, x - 90, y + 90] });
  }
}
for (const c of world.zones.comps) {
  const [x0, y0, x1, y1] = c.bbox.map((v) => v * world.grid.cell);
  world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  world.exec({ t: 'gate.add', x: x0 + 2, y: (y0 + y1) / 2 });
}
let civFields = 0;
const civF = world.nav.civ, run0 = civF.job.run.bind(civF.job);
civF.job.run = (b) => { const done = run0(b); if (done) civFields++; return done; };
world.exec({ t: 'ready' });
const n0 = world.A.count;

const times = new Map();
for (const s of world._systems) {
  const up = s.update;
  times.set(s.name, 0);
  s.update = (w, dt) => { const a = performance.now(); up(w, dt); times.set(s.name, times.get(s.name) + performance.now() - a); };
}
const warm = 60;
for (let k = 0; k < warm; k++) world.step();
for (const k of times.keys()) times.set(k, 0);
let agentSum = 0, worst = 0;
const t1 = performance.now();
for (let k = 0; k < ticks && world.phase === 'battle'; k++) {
  const a = performance.now();
  world.step();
  const d = performance.now() - a;
  if (d > worst) worst = d;
  agentSum += world.A.count;
}
const el = performance.now() - t1;
const avg = el / ticks;
console.log(`map ${useCity ? 'citygen 3 km' : 'grid 3 km'}  build ${tBuild.toFixed(0)} ms  agents at READY ${n0}  avg agents ${(agentSum / ticks) | 0}`);
console.log(`civ ${world.counts[TYPE.CIV]}  zombies ${world.counts[TYPE.ZOMBIE]}  turning ${world.counts[TYPE.TURNING]}  phase ${world.phase}`);
console.log(`ms/tick avg ${avg.toFixed(2)}  worst ${worst.toFixed(2)}  (target < 8)`);
console.log(`zones ${world.zones.comps.length} (breached ${world.zones.comps.filter((c) => c.breached).length}), gates ${world.zones.gates.length}, civ-field rebuilds ${civFields}`);
console.log('per system (ms/tick):', [...times].map(([k, v]) => `${k} ${(v / ticks).toFixed(2)}`).join('  '));
