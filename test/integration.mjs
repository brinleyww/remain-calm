// Cross-module checks added during integration. Run: node test/integration.mjs
import { World, TYPE } from '../js/sim/world.js';
import { buildGrid } from '../js/sim/raster.js';
import { installCombat } from '../js/sim/units.js';
import { T } from '../js/map/format.js';
import { rectPoly } from '../js/util/geom.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const QUIET = ['loseBelowPct=0', 'zombie.touchRadius=0', 'civ.panicRadius=0', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0'];

// ---------------------------------------------------------------- only 'bridge' roads make bridge cells
{
  const map = makeTestMap({ size: 400, spacing: 100, stages: 3 });
  map.water.push({ p: rectPoly(0, 180, 400, 220) });
  map.roads.push({ p: [20, 160, 20, 240], w: 8, k: 'minor' }, { p: [380, 170, 380, 230], w: 8, k: 'bridge' });
  const g = buildGrid(map, 4);
  const at = (x, y) => g.terrain[Math.floor(y / 4) * g.gw + Math.floor(x / 4)];
  assert(at(20, 200) === T.ROAD, 'a plain road over water is solid road, not a bridge');
  assert(at(380, 200) === T.BRIDGE, 'a bridge road over water is a bridge');
  const own = g.bridges.filter((b) => Math.abs(b.cx - 380) < 10);
  assert(own.length === 1, `exactly one bridge for the bridge road (${g.bridges.length} bridges on the sheet)`);
}

// ---------------------------------------------------------------- a zombie that cannot move still breaches
{
  const w = new World(makeTestMap({ size: 800 }), { seed: 3, stage: 2, mutators: [...QUIET, 'zombie.speed=0'] });
  const r = w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
  assert(r.ok, 'zone placed');
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.remove(i);
  const comp = w.zones.comps[0];
  const c = comp.interiorCells[comp.interiorCells.length >> 1];
  const x = (c % w.grid.gw + 0.5) * w.grid.cell, y = (Math.floor(c / w.grid.gw) + 0.5) * w.grid.cell;
  w.spawn(TYPE.ZOMBIE, x, y);
  for (let k = 0; k < 5; k++) w.step();
  assert(w.zones.comps[0].breached, 'a stationary zombie inside the walls breaches the zone');
}

// ---------------------------------------------------------------- fire kills are credited to whoever lit it
{
  const w = new World(makeTestMap({ size: 800 }), { seed: 5, stage: 2, mutators: [...QUIET, 'zombie.speed=0', 'fire.dps=500'] });
  installCombat(w);
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.remove(i);
  const x = 150, y = 300;
  for (let k = 0; k < 12; k++) w.spawn(TYPE.ZOMBIE, x + (k % 4) * 3, y + Math.floor(k / 4) * 3);
  w.ignite(x + 5, y + 3, 20, 1, 'oil');
  for (let k = 0; k < 40; k++) w.step();
  const by = w.stats.killsBy;
  assert((by.oil || 0) >= 10, `burning zombies count for the item that lit the fire (${JSON.stringify(by)})`);
  assert(!(by.fire > 0), 'nothing is left under the anonymous fire key');
}

console.log('integration: all passed');
