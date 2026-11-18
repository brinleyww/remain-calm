// SIM core: grid rasterisation, placement commands, economy rules. Run: node test/sim_core.mjs
import { World, TYPE } from '../js/sim/world.js';
import { buildGrid } from '../js/sim/raster.js';
import { T } from '../js/map/format.js';
import { DEFAULTS } from '../js/data/config.js';
import { polyPerimeter, rectPoly } from '../js/util/geom.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });

// ---------------------------------------------------------------- grid
{
  const g = buildGrid(map, 4);
  const at = (x, y) => g.terrain[Math.floor(y / 4) * g.gw + Math.floor(x / 4)];
  assert(g.gw === 200 && g.gh === 200, 'grid is 200x200 cells for an 800 m map');
  assert(at(150, 52) === T.ROAD, 'road centre rasterises as ROAD');
  assert(at(70, 70) === T.BLDG, 'building interior rasterises as BLDG');
  assert(at(20, 400) === T.WATER, 'river rasterises as WATER');
  assert(at(150, 400) === T.BRIDGE, 'road over river becomes BRIDGE');
  assert(g.bridges.length === 8, `8 bridges detected (got ${g.bridges.length})`);
  const br = g.bridges[0];
  assert(br.len >= 24 && br.len <= 40 && br.hpMax >= DEFAULTS.bridge.hpMin && br.hpMax <= DEFAULTS.bridge.hpMax, `bridge measured: len ${br.len} m, hp ${br.hpMax}`);
  assert(g.waterBodies.area.length === 2 && g.waterBodies.area[1] > 20000, 'one water body including the cells under bridges');
  assert(g.bInfo.length === map.buildings.length && g.bInfo.every((b) => b.cells.length > 0), 'every building has cells');
  const m0 = g.levelMask(0), m1 = g.levelMask(1), m2 = g.levelMask(2);
  let nested = true, c0 = 0, c2 = 0;
  for (let c = 0; c < m0.length; c++) { if (m0[c] && !m1[c]) nested = false; if (m1[c] && !m2[c]) nested = false; c0 += m0[c]; c2 += m2[c]; }
  assert(nested && c0 < c2 && c2 === m2.length, 'stage masks are nested; last stage covers the map');
  assert(g.levelMask(1) === m1, 'stage masks are memoised');
}

// ---------------------------------------------------------------- world, economy caps
const w = new World(map, { seed: 3, stage: 2 });
{
  const e = w.cfg.economy, C = w.C;
  assert(C > 1000 && w.counts[TYPE.CIV] === Math.round(C * w.cfg.population.scale), `civilians = round(C*scale) (C=${C.toFixed(0)}, civs=${w.counts[TYPE.CIV]})`);
  assert(w.budget.cap === Math.round(e.moneyBase + e.moneyMax * C / (C + e.moneyHalf)), `budget cap from C: $${w.budget.cap}`);
  assert(w.sp.cap === e.spBase + e.spPerLevel * 2 + e.spPerSqrt10k * Math.floor(Math.sqrt(C / 10000)), `SP cap: ${w.sp.cap}`);
  assert(w.phase === 'planning' && w.stats.civStart === w.counts[TYPE.CIV], 'planning phase, civStart recorded');
}

// ---------------------------------------------------------------- zones
{
  const p = blockRect(1, 1, 2, 2);
  const q = w.quote({ t: 'zone.add', p });
  const expect = Math.round(polyPerimeter(p) * w.cfg.wall.perM);
  assert(q.ok && q.cost === expect, `zone quote = perimeter cost while free zones remain ($${q.cost})`);
  const r = w.exec({ t: 'zone.add', p });
  assert(r.ok && w.zones.comps.length === 1 && w.budget.spent === expect, 'zone placed and paid');
  const comp = w.zones.comps[0];
  assert(comp.wallCells.length > 0 && comp.interiorCells.length > comp.wallCells.length, 'zone has wall ring and interior');
  let ring = true;
  for (const c of comp.wallCells) if (w.block[c] !== 1 || w.wallHp[c] !== w.cfg.wall.hp) ring = false;
  assert(ring, 'wall cells carry block=1 and full wall HP');
  assert(comp.bldgs.length >= 12, `buildings inside the zone: ${comp.bldgs.length}`);
  const r2 = w.exec({ t: 'zone.add', p: blockRect(3, 1, 3, 2, 100, -2) });
  assert(r2.ok && w.zones.comps.length === 1 && w.zones.comps[0].polys.length === 2, 'touching polygon merges into one component');
  assert(w.zones.comps[0].interiorCells.length > comp.interiorCells.length, 'merged component grew');
  const far = w.exec({ t: 'zone.add', p: blockRect(5, 5, 5, 5) });
  assert(far.ok && w.zones.comps.length === 2, 'separate polygon makes a second component');
  const huge = w.quote({ t: 'zone.add', p: rectPoly(10, 420, 790, 790) });
  assert(!huge.ok && /land/.test(huge.reason), `land fraction limit: "${huge.reason}"`);
  const tiny = w.quote({ t: 'zone.add', p: [10, 10, 14, 10, 14, 14] });
  assert(!tiny.ok, `tiny zone rejected: "${tiny.reason}"`);
}

// ---------------------------------------------------------------- gates, walls, corridors, holds
{
  const comp = w.zones.comps[0];
  const [x0, y0, x1, y1] = comp.bbox.map((v) => v * 4);
  const g1 = w.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  assert(g1.ok && w.zones.gates.length === 1 && w.zones.gates[0].cells.length >= 3, 'gate placed on a zone wall');
  const gt = w.zones.gates[0];
  assert(gt.cells.every((c) => w.block[c] === 3 && w.wallHp[c] === gt.hp), 'gate cells marked block=3 with gate HP');
  assert(!w.quote({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 }).ok, 'second gate on the same spot rejected');
  assert(!w.quote({ t: 'gate.add', x: 700, y: 60 }).ok, 'gate away from any wall rejected');
  const wl = w.exec({ t: 'wall.add', p: [560, 100, 640, 100] });
  assert(wl.ok && wl.cost === Math.round(25 + 0.75 * 80) && w.walls[0].cells.length >= 18, `standalone wall placed ($${wl.cost})`);
  const longW = w.quote({ t: 'wall.add', p: [20, 20, 780, 20] });
  assert(!longW.ok && /limit/i.test(longW.reason), `standalone length limit: "${longW.reason}"`);
  const co = w.exec({ t: 'corridor.add', x0: 600, y0: 600, x1: 700, y1: 600, w: 30 });
  assert(co.ok && co.cost === Math.round(30 + 100 * 30 * 0.0045), `corridor priced from area ($${co.cost})`);
  const ho = w.exec({ t: 'hold.add', x: 450, y: 650, R: 40 });
  assert(ho.ok && ho.cost === Math.round(20 + Math.PI * 1600 * 0.002) && w.holds[0].r === 40 * 0.35, `hold placed ($${ho.cost})`);
  let inCorr = 0, inHold = 0;
  for (let c = 0; c < w.corrGrid.length; c++) { if (w.corrGrid[c]) inCorr++; if (w.holdGrid[c]) inHold++; }
  assert(inCorr > 100 && inHold > 200, 'corridor and hold rasterised');
}

// ---------------------------------------------------------------- upgrades, functions, cost multipliers
{
  const comp = w.zones.comps[0];
  const before = w.budget.spent;
  const up = w.exec({ t: 'zone.upgrade', compId: comp.id });
  assert(up.ok && up.cost === 150 && w.zones.comps[0].wallLevel === 2, 'wall upgrade to level 2 costs $150');
  assert(w.wallHp[w.zones.comps[0].wallCells[0]] === 2 * w.cfg.wall.hp && w.budget.spent === before + 150, 'upgrade doubled wall HP');
  const special = w.buildings.find((b) => b.special && b.zone < 0);
  const fOut = w.quote({ t: 'func.set', b: special.idx, func: w.cfg.specials[special.k].functions[0] });
  assert(!fOut.ok && /inside/.test(fOut.reason), 'special outside a zone cannot get a function');
  const inside = w.buildings.find((b) => b.zone === comp.id && !b.special);
  assert(!w.quote({ t: 'func.set', b: inside.idx, func: 'radio' }).ok, 'ordinary building cannot get a function');
  const zx = (comp.bbox[0] + comp.bbox[2]) * 2, zy = (comp.bbox[1] + comp.bbox[3]) * 2;
  assert(w.costMul(zx, zy) === 1 && w.costMul(700, 700) === w.cfg.zone.outsideCostMul, 'unit cost: x1 in a zone, x1.5 outside');
}

// ---------------------------------------------------------------- functions on a special inside a zone
{
  const m2 = makeTestMap({ size: 800 });
  const civic = m2.buildings.findIndex((b) => b.k === 'civic');
  const trade = m2.buildings.findIndex((b) => b.k === 'trade');
  const w2 = new World(m2, { seed: 9, stage: 2 });
  const zoneOf = {};
  for (const bi of [civic, trade]) {
    const b = w2.buildings[bi];
    const r = w2.exec({ t: 'zone.add', p: rectPoly(b.cx - 30, b.cy - 30, b.cx + 30, b.cy + 30) });
    zoneOf[bi] = r.id;
    assert(r.ok && w2.buildingInZone(bi) >= 0, `special building ${b.k} inside a new zone`);
  }
  assert(w2.exec({ t: 'func.set', b: civic, func: 'radio' }).ok, 'radio assigned to the civic building');
  const cb = w2.buildings[civic];
  assert(Math.abs(w2.auraMul(cb.cx + 50, cb.cy, 'range') - 1.5) < 1e-9 && w2.auraMul(cb.cx + 400, cb.cy, 'range') === 1, 'radio aura: x1.5 range within 250 m only');
  assert(w2.exec({ t: 'func.set', b: trade, func: 'budget' }).ok, 'budget assigned to the trade building');
  const tb = w2.buildings[trade];
  assert(Math.abs(w2.costMul(tb.cx + 20, tb.cy + 20) - 0.8) < 1e-9, 'budget function: units in that zone cost 20% less');
  assert(w2.exec({ t: 'func.set', b: trade, func: 'reducedCost' }).ok, 'reduced cost replaces budget');
  assert(Math.abs(w2.costMul(tb.cx + 10, tb.cy) - 0.4) < 1e-9, 'reduced cost: 60% off next to the building');
  w2.exec({ t: 'zone.remove', id: zoneOf[trade] });
  assert(w2.buildings[trade].func === null, 'function is dropped when the building leaves its zone');
}

// ---------------------------------------------------------------- refunds and quotes
{
  const spent = w.budget.spent;
  const id = w.corridors[0].id, paid = w.corridors[0].paid;
  const r = w.exec({ t: 'corridor.remove', id });
  assert(r.ok && r.refund === paid && Math.abs(w.budget.spent - (spent - paid)) < 1e-9, 'planning refund is 100%');
  const many = w.exec({ t: 'refund.many', items: { hold: [w.holds[0].id], wall: [w.walls[0].id] } });
  assert(many.ok && many.count === 2 && w.holds.length === 0 && w.walls.length === 0, 'refund.many removes a selection');
  const maxZ = w.cfg.zone.maxZones;
  let reason = '';
  for (let k = 0; k < 12 && !reason; k++) {
    const bx = (k % 4) * 2, by = 4 + Math.floor(k / 4) * 1;
    const q = w.exec({ t: 'zone.add', p: blockRect(bx, by, bx, by, 100, 20) });
    if (!q.ok) reason = q.reason;
  }
  assert(w.zones.comps.length <= maxZ && /At most/.test(reason), `zone count limit: "${reason}" with ${w.zones.comps.length} zones`);
  const s = w.exec({ t: 'loadout.set', units: ['garrison', 'sniper'], abilities: { paratroopers: 2, airstrike: 1 } });
  assert(s.ok && w.sp.spent === 4 && w.charges.paratroopers === 2, 'loadout charges bought with SP');
  assert(!w.exec({ t: 'loadout.set', abilities: { nuke: 1 } }).ok, 'loadout over the SP cap rejected');
}

// ---------------------------------------------------------------- battle refunds and stage boundary
{
  const w3 = new World(map, { seed: 4, stage: 0 });
  const out = w3.quote({ t: 'zone.add', p: blockRect(0, 0, 0, 0) });
  assert(!out.ok && /boundary/.test(out.reason), 'zones must lie inside the stage boundary');
  const c = w3.exec({ t: 'corridor.add', x0: 380, y0: 380, x1: 420, y1: 380, w: 20 });
  assert(c.ok, 'corridor inside stage 1');
  w3.exec({ t: 'ready' });
  assert(w3.phase === 'battle' && w3.counts[TYPE.ZOMBIE] > 0, 'READY starts the battle with an outbreak');
  const spent = w3.budget.spent;
  const r = w3.exec({ t: 'corridor.remove', id: w3.corridors[0].id });
  assert(r.ok && r.refund === 0 && w3.budget.spent === spent, 'battle refund gives nothing back');
  assert(!w3.exec({ t: 'loadout.set', abilities: {} }).ok, 'loadout is locked after READY');
}

// ---------------------------------------------------------------- reshaping zones, dependent gates
{
  const w4 = new World(map, { seed: 6, stage: 2 });
  const r = w4.exec({ t: 'zone.add', p: blockRect(1, 1, 1, 1) });
  const [x0, y0, x1, y1] = w4.zones.comps[0].bbox.map((v) => v * 4);
  w4.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  const spent = w4.budget.spent;
  const bigger = blockRect(1, 1, 2, 1);
  const q = w4.quote({ t: 'zone.move', id: r.id, p: bigger });
  assert(q.ok && q.cost === Math.round(polyPerimeter(bigger) * 0.75) - w4.zones.polys[0].paid, `zone.move quotes the price difference ($${q.cost})`);
  assert(w4.zones.comps[0].bbox[2] * 4 < 250, 'quoting a move leaves the zone untouched');
  assert(w4.exec({ t: 'zone.move', id: r.id, p: bigger }).ok && w4.budget.spent === spent + q.cost, 'zone reshaped and the difference paid');
  assert(w4.zones.gates.length === 1, 'gate survives a reshape that keeps its wall');
  w4.exec({ t: 'zone.move', id: r.id, p: blockRect(4, 4, 4, 4) });
  assert(w4.zones.gates.length === 0 && Math.abs(w4.budget.spent - w4.zones.polys[0].paid) < 1e-9, 'a gate whose wall moved away is refunded');
  w4.exec({ t: 'ready' });
  assert(!w4.exec({ t: 'zone.move', id: r.id, p: bigger }).ok, 'zones cannot be reshaped in battle');
}

// ---------------------------------------------------------------- outbreak placement rules
{
  const sites = (extra) => {
    const w5 = new World(map, { seed: 77, stage: 2, mutators: ['outbreak.maxSites=3', 'outbreak.minSites=3'] });
    w5.exec({ t: 'zone.add', p: blockRect(2, 1, 4, 2) });
    if (extra) w5.exec({ t: 'hold.add', x: 700, y: 700, R: 20 });
    let got = null;
    w5.events.on('outbreak', (e) => { got = e.sites; });
    w5.exec({ t: 'ready' });
    return { w5, got };
  };
  const a = sites(false), b = sites(false), c = sites(true);
  assert(JSON.stringify(a.got) === JSON.stringify(b.got) && a.got.length === 3, 'same layout -> same outbreak sites');
  assert(JSON.stringify(a.got) !== JSON.stringify(c.got), 'changing the layout re-rolls the outbreak');
  const w5 = a.w5, g = w5.grid, minD = w5.cfg.outbreak.minDistFromZone;
  let worst = Infinity;
  const zc = [...w5._unionCells].filter((_, k) => k % 3 === 0).map((cc) => [(cc % g.gw + 0.5) * 4, (((cc / g.gw) | 0) + 0.5) * 4]);
  for (let i = 0; i < w5.A.n; i++) {
    if (w5.A.type[i] !== TYPE.ZOMBIE) continue;
    for (const [x, y] of zc) worst = Math.min(worst, Math.hypot(w5.A.x[i] - x, w5.A.y[i] - y));
  }
  assert(worst >= minD - 12, `no zombie starts within ${minD} m of a zone (closest ${worst.toFixed(0)} m)`);
}

// ---------------------------------------------------------------- secondary outbreak and edge waves
{
  const w6 = new World(map, { seed: 3, stage: 1, mutators: ['outbreak.secondaryChancePerLevel=1', 'outbreak.secondaryAfterSec=[2,2]', 'outbreak.edgeWaves=1', 'outbreak.edgeWaveEvery=3', 'loseBelowPct=0'] });
  const evs = [];
  w6.events.on('outbreak', (e) => evs.push(e));
  w6.exec({ t: 'ready' });
  for (let k = 0; k < 70 && w6.phase === 'battle'; k++) w6.step();
  assert(evs.some((e) => e.secondary) && evs.some((e) => e.edge), 'a secondary outbreak and an edge wave arrive on schedule');
}

// ---------------------------------------------------------------- repair, shield
{
  const m7 = makeTestMap({ size: 800 });
  const trade = m7.buildings.findIndex((b) => b.k === 'trade');
  const w7 = new World(m7, { seed: 2, stage: 2, mutators: ['loseBelowPct=0'] });
  const b = w7.buildings[trade];
  w7.exec({ t: 'zone.add', p: rectPoly(b.cx - 40, b.cy - 40, b.cx + 40, b.cy + 40) });
  w7.exec({ t: 'func.set', b: trade, func: 'repair' });
  w7.exec({ t: 'ready' });
  const c = w7.zones.comps[0].wallCells[5];
  w7.damageWallCell(c, 500);
  for (let k = 0; k < 40; k++) w7.step();
  assert(w7.wallHp[c] > w7.cfg.wall.hp - 500 + 60, `repair restores wall HP (${w7.wallHp[c].toFixed(0)})`);
  const z = w7.spawn(TYPE.ZOMBIE, 700, 700, 2);
  w7.damageAgent(z, 50, 'test');
  assert(w7.A.type[z] === TYPE.ZOMBIE && w7.A.hp[z] === 1 && w7.A.shield[z] === 10, 'shield absorbs damage first');
  w7.damageAgent(z, 1e6, 'test');
  assert(w7.A.type[z] !== TYPE.ZOMBIE, 'then the zombie dies');
}

console.log(process.exitCode ? 'sim_core: FAILED' : 'sim_core: all passed');
