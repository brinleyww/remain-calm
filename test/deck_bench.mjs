// Multi-level roads: sim cost and memory of decks. Each variant runs in its own process, alternating, on one 4 km city:
//   flat   the city with every road on the ground (its motorway at grade)
//   mway   the same city with its motorway on viaducts, slip roads and underpasses (as generated)
//   heavy  the motorway city with every long main road also raised onto a deck (a synthetic worst case)
// Usage: node test/deck_bench.mjs [--rounds N] [--ticks N] [--size km]   (one variant: --variant name)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ticks = +opt('--ticks', 400), size = +opt('--size', 4), variant = opt('--variant', null);

if (!variant) {
  const rounds = +opt('--rounds', 3), res = { flat: [], mway: [], heavy: [] };
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 ? ['heavy', 'mway', 'flat'] : ['flat', 'mway', 'heavy'];
    for (const v of order) {
      const out = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--variant', v, '--ticks', String(ticks), '--size', String(size)], { encoding: 'utf8', maxBuffer: 1 << 26 });
      const line = (out.stdout || '').trim().split('\n').pop();
      if (r === 0) console.log(line);
      const m = /ms\/tick ([\d.]+)/.exec(line || '');
      if (m) res[v].push(+m[1]); else console.log(out.stdout, out.stderr);
    }
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const f = med(res.flat);
  console.log(`median ms/tick: flat ${f.toFixed(2)}  mway ${med(res.mway).toFixed(2)} (${((med(res.mway) / f - 1) * 100).toFixed(1)}%)  heavy ${med(res.heavy).toFixed(2)} (${((med(res.heavy) / f - 1) * 100).toFixed(1)}%)`);
} else {
  const { World } = await import('../js/sim/world.js');
  const { generateCity } = await import('../js/map/citygen.js');
  const { normalizeMap } = await import('../js/map/format.js');
  let map = generateCity({ seed: 7, sizeKm: size, water: 'river', density: 0.8, stages: 5 });
  if (variant === 'flat') map = normalizeMap({ ...map, roads: map.roads.map(({ z, ...r }) => r) });
  if (variant === 'heavy') {
    const len = (p) => { let s = 0; for (let i = 0; i + 3 < p.length; i += 2) s += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]); return s; };
    map = normalizeMap({ ...map, roads: map.roads.map((r) => {
      if (r.z || r.k !== 'major' || len(r.p) < 300) return r;
      const n = r.p.length >> 1, L = len(r.p), z = [];
      let s = 0;
      for (let i = 0; i < n; i++) { if (i) s += Math.hypot(r.p[2 * i] - r.p[2 * i - 2], r.p[2 * i + 1] - r.p[2 * i - 1]); z.push(Math.min(1, s / 60, (L - s) / 60)); }
      return { ...r, z: z.map((v) => Math.round(v * 10) / 10) };
    }) });
  }
  if (global.gc) global.gc();
  const h0 = process.memoryUsage();
  const t0 = performance.now();
  const world = new World(map, { seed: 42, stage: map.levels.length - 1, mutators: ['population.scale=1.3', 'outbreak.zombies=700', 'sim.maxAgents=90000'] });
  const tBuild = performance.now() - t0;
  const cx = map.w / 2, cy = map.h / 2;
  for (const [dx, dy] of [[0, 0], [-700, -500], [600, 400], [-500, 700], [800, -600]]) {
    const x = cx + dx, y = cy + dy;
    world.exec({ t: 'zone.add', p: [x - 90, y - 90, x + 90, y - 90, x + 90, y + 90, x - 90, y + 90] });
  }
  for (const c of world.zones.comps) {
    const [x0, y0, x1, y1] = c.bbox.map((v) => v * world.grid.cell);
    world.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  }
  world.exec({ t: 'ready' });
  const times = new Map();
  for (const sy of world._systems) {
    const up = sy.update;
    times.set(sy.name, 0);
    sy.update = (w, dt) => { const a = performance.now(); up(w, dt); times.set(sy.name, times.get(sy.name) + performance.now() - a); };
  }
  for (let k = 0; k < 60; k++) world.step();
  for (const k of times.keys()) times.set(k, 0);
  const t1 = performance.now();
  let done = 0;
  for (; done < ticks && world.phase === 'battle'; done++) world.step();
  const ms = (performance.now() - t1) / Math.max(1, done);
  if (global.gc) global.gc();
  const h1 = process.memoryUsage();
  const g = world.grid, dk = g.deck, N = g.gw * g.gh, D = dk ? dk.D : 0;
  const bytes = (o) => Object.values(o).reduce((s, v) => s + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
  const deckMB = dk ? bytes(dk) / 1e6 : 0;
  // per node in nav: pass, under, civCost, zCost, sCost, civDyn (1 B each), two fields x (dist 4 B + dir 1 B) x (field + job)
  const navMB = D * (6 + 2 * 2 * 5 + (world.nav.swim ? 10 : 0)) / 1e6, hash2MB = world.sh2 ? bytes(world.sh2) / 1e6 : 0;
  let onDeck = 0, under = 0;
  for (let i = 0; i < world.A.n; i++) if (world.A.type[i]) { if (world.A.tier[i] > 0) onDeck++; else if (world.A.tier[i] < 0) under++; }
  console.log(`${variant.padEnd(5)} ${size} km  nodes ${D} (${(D / N * 100).toFixed(2)}% of ${N} cells)  build ${tBuild.toFixed(0)} ms  agents ${world.A.count} (on decks ${onDeck}, in tunnels ${under})` +
    `  ms/tick ${ms.toFixed(2)} (${['hash', 'nav', 'agents'].map((k) => k + ' ' + (times.get(k) / Math.max(1, done)).toFixed(2)).join(' ')})  decks ${deckMB.toFixed(1)} MB + nav ${navMB.toFixed(1)} MB + tunnel hash ${hash2MB.toFixed(1)} MB  heap+arrays ${((h1.heapUsed + h1.arrayBuffers - h0.heapUsed - h0.arrayBuffers) / 1e6).toFixed(0)} MB`);
}
