// COMBAT placement: every unit type placed / upgraded / refunded where valid and rejected where not; pricing; paint;
// C4; persistence across undo, retry and the next stage. Run: node test/combat_place.mjs
import { World, TYPE } from '../js/sim/world.js';
import { T } from '../js/map/format.js';
import { rectPoly } from '../js/util/geom.js';
import {
  installCombat, canPlace, unitCost, unitStats, unitRange, upgradeCost, upgradeInfo, nextUpgradeStat, unitAt, unitsInRect, UNIT_INFO, ABILITY_INFO,
} from '../js/sim/units.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });
map.water.push({ p: rectPoly(715, 12, 740, 38) }); // a pond too small for ships
const QUIET = ['loseBelowPct=0', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'population.scale=0.05'];
const mk = (mut = [], o = {}) => installCombat(new World(map, { seed: 5, stage: o.stage ?? 2, mutators: [...QUIET, ...mut], sandbox: o.sandbox }));
const run = (w, n) => { for (let k = 0; k < n && w.phase === 'battle'; k++) w.step(); };
const place = (w, type, x, y, extra = {}) => w.exec({ t: 'unit.place', type, x, y, ...extra });
const unit = (w, id) => w.units.find((u) => u.id === id);
const terrAt = (w, x, y) => w.grid.terrain[w.cellAt(x, y)];

const ROAD = [150, 150], ROAD2 = [150, 250], WATER = [300, 400], BRIDGE = [250, 400], POND = [727, 25];
const probe = mk();
const bld = probe.buildings.filter((b) => b.k === 'res' && b.cx > 100 && b.cx < 700 && b.cy > 100 && b.cy < 700 && Math.abs(b.cy - 400) > 60);
const B1 = bld[0], B2 = bld[1];
assert(terrAt(probe, ...ROAD) === T.ROAD && terrAt(probe, ...WATER) === T.WATER && terrAt(probe, ...BRIDGE) === T.BRIDGE && terrAt(probe, ...POND) === T.WATER, 'test spots: road, river, bridge and pond');
assert(Object.keys(probe.cfg.units).every((k) => UNIT_INFO[k] && UNIT_INFO[k].name) && Object.keys(probe.cfg.abilities).every((k) => ABILITY_INFO[k] && ABILITY_INFO[k].name), 'every unit and ability has display info');

// ---------------------------------------------------------------- every type: valid spot, invalid spots, upgrade, refund
const SPOTS = {
  building: { ok: () => [B1.cx, B1.cy], bad: [ROAD, WATER] },
  ground: { ok: () => ROAD, bad: [[B1.cx, B1.cy], WATER] },
  water: { ok: () => WATER, bad: [ROAD, POND, [B1.cx, B1.cy]] },
  brush: { ok: () => ROAD, bad: [[B1.cx, B1.cy], WATER] },
  'building|bridge': { ok: () => [B1.cx, B1.cy], bad: [ROAD, WATER] },
};
for (const type of Object.keys(probe.cfg.units)) {
  const w = mk(['economy.moneyBase=50000']);
  const def = w.cfg.units[type];
  if (def.mount === 'line') {
    const r0 = w.exec({ t: 'unit.place', type, p: [60, 150, 140, 150] });
    assert(r0.ok && unit(w, r0.id).cells.length >= 20, `${type}: line drawn along a street (${r0.ok && unit(w, r0.id).cells.length} cells, $${r0.cost})`);
    assert(r0.cost === Math.round(def.cost * 80 * w.cfg.zone.outsideCostMul), `${type}: priced per meter (${r0.cost})`);
    const inside = w.exec({ t: 'unit.place', type, p: [B1.cx - 8, B1.cy, B1.cx + 8, B1.cy] });
    assert(!inside.ok, `${type}: rejected inside a building (${inside.reason})`);
    const again = w.exec({ t: 'unit.place', type, p: [60, 150, 140, 150] });
    assert(!again.ok, `${type}: the same street cannot be covered twice (${again.reason})`);
    const spent = w.budget.spent;
    const rf = w.exec({ t: 'unit.refund', id: r0.id });
    assert(rf.ok && Math.abs(w.budget.spent - (spent - r0.cost)) < 1e-6 && !w.units.length, `${type}: refunded in full during planning`);
    continue;
  }
  const sp = SPOTS[def.mount];
  const [x, y] = sp.ok();
  const before = w.budget.spent;
  const q = w.quote({ t: 'unit.place', type, x, y });
  const r = place(w, type, x, y);
  assert(r.ok && q.ok && Math.abs(q.cost - r.cost) < 1e-9, `${type}: placed on ${def.mount} for $${r.cost}`);
  assert(Math.abs(w.budget.spent - before - r.cost) < 1e-6 && Math.abs(w.stats.spentBy[type] - r.cost) < 1e-6, `${type}: money spent and booked under its key`);
  for (const [bx, by] of sp.bad) {
    const bad = place(w, type, bx, by);
    assert(!bad.ok && bad.reason, `${type}: rejected at (${bx.toFixed(0)}, ${by.toFixed(0)}): ${bad.reason}`);
  }
  const twice = place(w, type, x, y);
  assert(!twice.ok, `${type}: a second one on the same spot is rejected (${twice.reason})`);
  const u = unit(w, r.id);
  if (def.mount === 'building|bridge') {
    const rb = place(w, type, ...BRIDGE);
    assert(rb.ok && unit(w, rb.id).bridge >= 0, `${type}: can also be wired to a bridge`);
  }
  if ((def.ups || []).length) {
    const [stat, mul] = nextUpgradeStat(u);
    const s0 = unitStats(w, u, false), cost = upgradeCost(w, u);
    assert(cost === Math.round(u.base * 1.5), `${type}: level-2 upgrade costs 1.5x the base ($${cost})`);
    const ur = w.exec({ t: 'unit.upgrade', id: u.id });
    const s1 = unitStats(w, u, false);
    const want = stat === 'rof' ? s0.rof / (mul >= 1 ? mul : 1 / mul) : ['mag', 'reloads', 'rockets', 'shells'].includes(stat) ? Math.round(s0[stat] * mul) : s0[stat] * mul;
    assert(ur.ok && u.level === 2 && (s1[stat] === want || Math.abs(s1[stat] - want) < 1e-6 || (!Number.isFinite(want) && s1[stat] === want)), `${type}: upgrade raises ${stat} ${s0[stat]} -> ${s1[stat]}`);
    for (let L = 3; L <= 5; L++) {
      const c = upgradeCost(w, u);
      assert(c === Math.round(u.base * Math.pow(1.5, L - 1)) && w.exec({ t: 'unit.upgrade', id: u.id }).ok, `${type}: level ${L} for $${c}`);
    }
    assert(upgradeCost(w, u) === null && !w.exec({ t: 'unit.upgrade', id: u.id }).ok && upgradeInfo(w, u).max, `${type}: level 5 is the top`);
  } else {
    const ur = w.exec({ t: 'unit.upgrade', id: u.id });
    assert(!ur.ok && upgradeCost(w, u) === null, `${type}: has no upgrades (${ur.reason})`);
  }
  const total = w.budget.spent;
  const rf = w.exec({ t: 'unit.refund', id: u.id });
  assert(rf.ok && Math.abs(rf.refund - u.paid) < 1e-6 && Math.abs(w.budget.spent - (total - u.paid)) < 1e-6, `${type}: refund returns everything paid incl. upgrades ($${rf.refund})`);
  assert(!w.units.includes(u) && !w.combat.byId.has(u.id), `${type}: refunded unit is gone`);
  if (def.mount === 'building') assert(w.buildings[u.b].unitId === -1 && place(w, type, x, y).ok, `${type}: building free again after refund`);
}

// ---------------------------------------------------------------- general rules
{
  const w0 = mk([], { stage: 0 });
  const r = place(w0, 'turret', 20, 20);
  assert(!r.ok && /boundary/.test(r.reason), `outside the stage boundary is rejected (${r.reason})`);
  const poor = mk(['economy.moneyBase=50', 'economy.moneyMax=0']);
  const p = place(poor, 'turret', ...ROAD);
  assert(!p.ok && p.reason === 'Not enough money' && p.cost === 135, 'not enough money is rejected with the price');
  const lo = mk();
  lo.exec({ t: 'loadout.set', units: ['garrison', 'mine'] });
  assert(!place(lo, 'turret', ...ROAD).ok && place(lo, 'garrison', B1.cx, B1.cy).ok, 'only loadout units can be placed');
  const lk = mk();
  lk.isUnlocked = (id) => id !== 'railgun';
  assert(/unlock/i.test(place(lk, 'railgun', ...ROAD).reason) && place(lk, 'turret', ...ROAD).ok, 'locked units are rejected through world.isUnlocked');
  assert(mk([], { sandbox: true }).exec({ t: 'unit.place', type: 'howitzer', x: ROAD[0], y: ROAD[1] }).ok, 'sandbox places anything');
  const sp = mk();
  assert(place(sp, 'turret', ...ROAD).ok && !place(sp, 'mlrs', ROAD[0] + 2, ROAD[1]).ok && place(sp, 'mlrs', ROAD[0], ROAD[1] + 12).ok, 'ground units keep their spacing');
  const at = canPlace(sp, 'garrison', B1.cx + 5, B1.cy - 5), am = canPlace(sp, 'mine', 61.3, 150.2);
  assert(at.ok && at.b === B1.idx && at.x === B1.cx && am.ok && am.x === 62 && am.y === 150, 'canPlace snaps to the building centroid / the trap cell');
}

// ---------------------------------------------------------------- pricing: zones, auras, count scaling, garrison height
{
  const w = mk();
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 1, 1) });
  const inside = w.buildings.find((b) => b.zone === 0), outside = B2;
  assert(inside && w.buildingInZone(inside.idx) === 0, 'a building inside the zone');
  const gIn = unitCost(w, 'garrison', inside.cx, inside.cy), gOut = unitCost(w, 'garrison', outside.cx, outside.cy);
  const want = (b) => Math.min(225, 15 + 2.25 * b.h);
  assert(gIn === Math.round(want(inside)) && gOut === Math.round(want(outside) * 1.5), `garrison price follows height, x1.5 outside a zone (${gIn} / ${gOut})`);
  assert(unitCost(w, 'turret', 200, 200) === 90 && unitCost(w, 'turret', ...ROAD) === 135, 'turret: $90 inside, $135 outside');
  const rIn = unitRange(w, { type: 'garrison', x: inside.cx, y: inside.cy, b: inside.idx });
  assert(Math.abs(rIn - Math.min(262.5, 30 + 2.625 * inside.h)) < 1e-6, `garrison range follows height (${rIn.toFixed(1)} m)`);
  const m = [];
  for (const b of bld.slice(2, 5)) m.push(place(w, 'mortar', b.cx, b.cy).cost);
  assert(m[0] === 113 && m[1] === 114 && m[2] === 116, `mortar cost grows with each one owned (${m.join(', ')})`);
  const h = [place(w, 'howitzer', 150, 550).cost, place(w, 'howitzer', 250, 550).cost];
  assert(h[0] === 600 && h[1] === 900, `howitzer cost grows by $200 each (${h.join(', ')})`);
}
{
  const m2 = makeTestMap({ size: 800, river: true });
  const trade = m2.buildings.findIndex((b) => b.k === 'trade');
  const w = installCombat(new World(m2, { seed: 5, stage: 2, mutators: QUIET }));
  const tb = w.buildings[trade];
  const bx = Math.floor((tb.cx - 50) / 100), by = Math.floor((tb.cy - 50) / 100);
  w.exec({ t: 'zone.add', p: blockRect(bx, by, bx, by) });
  const other = w.buildings.find((b) => b.zone === tb.zone && b.idx !== tb.idx && b.k !== 'trade');
  const full = unitCost(w, 'sniper', other.cx, other.cy);
  assert(w.exec({ t: 'func.set', b: trade, func: 'budget' }).ok && unitCost(w, 'sniper', other.cx, other.cy) === Math.round(50 * 0.8), 'Budget function: 20% off inside its zone');
  w.exec({ t: 'func.set', b: trade, func: 'reducedCost' });
  const near = unitCost(w, 'sniper', other.cx, other.cy), far = unitCost(w, 'sniper', B2.cx, B2.cy);
  assert(full === 50 && near === Math.round(50 * 0.4) && far === 75, `Reduced cost function: 60% off within its radius (${near}), not far away (${far})`);
}

// ---------------------------------------------------------------- upgrade locks, battle rules
{
  const w = mk();
  w.isUnlocked = (id) => id !== 'upgrade3';
  const r = place(w, 'garrison', B1.cx, B1.cy);
  assert(w.exec({ t: 'unit.upgrade', id: r.id }).ok, 'tier II is always available');
  const q = w.exec({ t: 'unit.upgrade', id: r.id });
  assert(!q.ok && /locked/.test(q.reason) && upgradeCost(w, unit(w, r.id)) === null && upgradeInfo(w, unit(w, r.id)).locked, `tier III locked by world.isUnlocked (${q.reason})`);
}
{
  const w = mk();
  const r = place(w, 'turret', ...ROAD);
  w.exec({ t: 'ready' });
  run(w, 5);
  const s0 = w.budget.spent;
  const b = place(w, 'turret', ...ROAD2);
  assert(b.ok && w.budget.spent > s0, 'units can still be bought during the battle');
  const rf = w.exec({ t: 'unit.refund', id: r.id });
  assert(rf.ok && rf.refund === 0 && w.budget.spent === s0 + b.cost, 'refunds during the battle return nothing');
  assert(w.exec({ t: 'refund.many', items: { unit: [b.id] } }).ok && !w.units.length, 'refund.many removes units');
}

// ---------------------------------------------------------------- paint mode
{
  const w = mk();
  const row = w.buildings.filter((b) => Math.abs(b.cy - B1.cy) < 1).sort((a, z) => a.cx - z.cx);
  const path = [row[0].cx, row[0].cy, row[row.length - 1].cx, row[0].cy];
  place(w, 'sniper', row[1].cx, row[1].cy);
  const q = w.quote({ t: 'unit.paint', type: 'garrison', path });
  const r = w.exec({ t: 'unit.paint', type: 'garrison', path });
  const bs = new Set(w.units.filter((u) => u.type === 'garrison').map((u) => u.b));
  assert(r.ok && r.count === row.length - 1 && bs.size === r.count && Math.abs(q.cost - r.cost) < 1e-6, `garrisons painted onto ${r.count} buildings, skipping the manned one`);
  const poor = mk(['economy.moneyBase=200', 'economy.moneyMax=0']);
  const pr = poor.exec({ t: 'unit.paint', type: 'garrison', path });
  assert(pr.ok && pr.count < row.length && poor.budget.spent <= poor.budget.cap, `painting stops when the money runs out (${pr.count} placed)`);
  const mines = w.exec({ t: 'unit.paint', type: 'mine', path: [60, 250, 140, 250] });
  const cells = new Set(w.units.filter((u) => u.type === 'mine').map((u) => u.cell));
  assert(mines.ok && mines.count >= 18 && cells.size === mines.count, `mines painted one per cell (${mines.count})`);
  assert(!w.exec({ t: 'unit.paint', type: 'turret', path: [60, 250, 140, 250] }).ok, 'ground units cannot be painted');
  assert(unitAt(w, row[2].cx, row[2].cy).type === 'garrison' && unitAt(w, 100, 250).type === 'mine', 'unitAt picks units under the cursor');
  assert(unitsInRect(w, 55, 240, 145, 260).length === mines.count, 'unitsInRect finds units in a drag box');
}

// ---------------------------------------------------------------- C4, collapse kills the garrison on it
{
  const w = mk();
  const c = place(w, 'c4', B1.cx, B1.cy), g = place(w, 'garrison', B1.cx, B1.cy), cb = place(w, 'c4', ...BRIDGE);
  assert(c.ok && g.ok && cb.ok, 'charge and garrison on the same building; a charge on a bridge');
  assert(!w.exec({ t: 'unit.detonate', id: c.id }).ok, 'charges cannot go off during planning');
  w.exec({ t: 'ready' });
  run(w, 2);
  const zs = [];
  for (let k = 0; k < 8; k++) zs.push(w.spawn(TYPE.ZOMBIE, B1.cx + B1.r + 4 + (k % 4) * 2, B1.cy + (k >> 2) * 3));
  run(w, 1);
  const d = w.exec({ t: 'unit.detonate', id: c.id });
  assert(d.ok && !w.buildings[B1.idx].alive, 'detonation brings the building down');
  assert(!unit(w, g.id).alive && w.buildings[B1.idx].unitId === -1, 'the garrison on it is destroyed');
  assert((w.stats.killsBy.c4 || 0) >= 6 && d.kills >= 6, `the blast kills nearby zombies (${w.stats.killsBy.c4})`);
  const br = unit(w, cb.id).bridge;
  w.exec({ t: 'unit.detonate', id: cb.id });
  assert(!w.bridges[br].alive, 'a charge drops its bridge');
}

// ---------------------------------------------------------------- persistence: undo, retry, next stage
{
  const w = mk();
  place(w, 'garrison', B1.cx, B1.cy);
  w.exec({ t: 'unit.place', type: 'spikes', p: [60, 150, 140, 150] });
  const s1 = w.snapshot(), h1 = w.hash(), spent1 = w.budget.spent;
  place(w, 'turret', ...ROAD); place(w, 'mine', ...ROAD2);
  w.exec({ t: 'unit.upgrade', id: w.units[0].id });
  w.restore(s1);
  assert(w.hash() === h1 && w.budget.spent === spent1 && w.units.length === 2 && w.units[0].level === 1, 'undo restores units, levels and money');
  assert(w.buildings[B1.idx].unitId === w.units[0].id && w.combat.spikeAt.size === w.units[1].cells.length, 'undo rebuilds the building and line indexes');
  assert(JSON.stringify(w.snapshot()) === JSON.stringify(s1), 'snapshot after undo is identical');

  const t = place(w, 'turret', ...ROAD);
  const sP = w.snapshot(), hP = w.hash();
  w.exec({ t: 'ready' });
  run(w, 300);
  unit(w, t.id).hp = 1;
  w.collapseBuilding(B1.idx, 1, 0);
  assert(!w.units[0].alive, 'collapse destroys the unit on the building');
  w.restore(sP);
  assert(w.phase === 'planning' && w.hash() === hP && w.units.every((u) => u.alive && u.ammo === u.mag) && unit(w, t.id).hp === unit(w, t.id).hpMax, 'retry restores every unit fully stocked');

  w.exec({ t: 'ready' });
  run(w, 100);
  w.collapseBuilding(B1.idx, 1, 0);
  const tu = unit(w, t.id);
  tu.ammo = 3; tu.hp = 10;
  const n0 = w.units.length;
  w.beginStage(w.stage);
  assert(w.units.length === n0 - 1 && !w.units.some((u) => u.type === 'garrison'), 'next stage: destroyed units are gone');
  assert(tu.ammo === tu.mag && tu.hp === tu.hpMax && w.budget.spent === w.units.reduce((s, u) => s + u.paid, 0), 'next stage: survivors restocked, spent = what they cost');
}
console.log('combat_place: all passed');
