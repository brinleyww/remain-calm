// Big-sheet benchmark (not part of test/all.mjs). Usage: node --expose-gc test/bigmap_bench.mjs [sizes, default 4,8,10] [--ticks N]
// Per size: generation, world build, each stage's begin time and crowd, READY, battle ms/tick per system, peak memory.
import { generateCity } from '../js/map/citygen.js';
import { mapStats, serializeMap } from '../js/map/format.js';
import { World, TYPE } from '../js/sim/world.js';
import { installCombat } from '../js/sim/units.js';

const args = process.argv.slice(2);
const ticks = +(args[args.indexOf('--ticks') + 1] || 0) || 400;
const sizes = (args.find(a => /^[\d.,]+$/.test(a) && a !== String(ticks)) || '4,8,10').split(',').map(Number);
const gc = () => { if (global.gc) global.gc(); };
const mb = (b) => Math.round(b / 1e6);

for (const km of sizes) {
  gc();
  let peak = 0;
  const track = () => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers); };
  const iv = setInterval(track, 5);
  let t = performance.now();
  const map = generateCity({ seed: 7, sizeKm: km, water: 'river', density: 0.6, bridges: 4, stages: 5 });
  const genMs = performance.now() - t;
  const st = mapStats(map);
  t = performance.now();
  const world = new World(map, { seed: 42, stage: 0 });
  installCombat(world);
  const worldMs = performance.now() - t;
  const stages = [];
  for (let s = 0; s < map.levels.length; s++) { t = performance.now(); world.beginStage(s); stages.push(`${Math.round(performance.now() - t)} ms/${world.stats.civStart}`); track(); }
  const cx = map.w / 2, cy = map.h / 2;
  for (const [dx, dy] of [[0, 0], [-700, -500], [600, 400]]) {
    const x = cx + dx, y = cy + dy;
    world.exec({ t: 'zone.add', p: [x - 90, y - 90, x + 90, y - 90, x + 90, y + 90, x - 90, y + 90] });
  }
  for (const c of world.zones.comps) { const [x0, y0, x1, y1] = c.bbox.map(v => v * world.grid.cell); world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 }); }
  t = performance.now();
  world.exec({ t: 'ready' });
  const readyMs = performance.now() - t;
  const times = new Map();
  for (const s of world._systems) { const up = s.update; times.set(s.name, 0); s.update = (w, dt) => { const a = performance.now(); up(w, dt); times.set(s.name, times.get(s.name) + performance.now() - a); }; }
  let worst = 0, n = 0;
  t = performance.now();
  for (; n < ticks && world.phase === 'battle'; n++) { const a = performance.now(); world.step(); worst = Math.max(worst, performance.now() - a); if (n % 25 === 0) track(); }
  const avg = (performance.now() - t) / Math.max(1, n);
  clearInterval(iv);
  gc();
  const m = process.memoryUsage();
  console.log(`${km} km  gen ${Math.round(genMs)} ms  ${st.buildings} buildings  nominal ${st.nominalPop}  json ${(serializeMap(map).length / 1e6).toFixed(1)} MB  factor ${world.popFactor.toFixed(3)}`);
  console.log(`  world ${Math.round(worldMs)} ms  grid ${world.grid.gw}x${world.grid.gh}  stages ${stages.join(', ')}  READY ${Math.round(readyMs)} ms`);
  console.log(`  battle ${n} ticks  avg ${avg.toFixed(2)} ms  worst ${worst.toFixed(1)} ms  zombies ${world.counts[TYPE.ZOMBIE]}  agents ${world.A.count}`);
  console.log('  per system ms/tick: ' + [...times].filter(([, v]) => v / n >= 0.01).map(([k, v]) => `${k} ${(v / n).toFixed(2)}`).join('  '));
  console.log(`  memory: heap ${mb(m.heapUsed)} MB, typed arrays ${mb(m.arrayBuffers)} MB, peak heap+typed ${mb(peak)} MB`);
}
