// COMBAT abilities: SP charges, unlock timers, delivery delays and the effect of each of the 19 abilities.
// Run: node test/combat_abilities.mjs
import { World, TYPE } from '../js/sim/world.js';
import { DEFAULTS } from '../js/data/config.js';
import { T } from '../js/map/format.js';
import { installCombat, abilityState, squadMembers } from '../js/sim/units.js';
import { makeTestMap, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });
const IDS = Object.keys(DEFAULTS.abilities);
const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.05', 'mutation.firstSec=100000'];
const NOW = IDS.map((id) => `abilities.${id}.unlock=0`);
const dt = DEFAULTS.sim.dt;
const run = (w, sec) => { const n = Math.round(sec / dt); for (let k = 0; k < n && w.phase === 'battle'; k++) w.step(); };
const killKind = (w, type) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === type) w.remove(i); };
const near = (w, type, x, y, r) => { let n = 0; for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === type && Math.hypot(w.A.x[i] - x, w.A.y[i] - y) <= r) n++; return n; };
const kills = (w, id) => w.stats.killsBy['ability:' + id] || 0;

// Battle world with every ability charged. A stunned reservoir zombie in a corner keeps the stage from ending.
function battle(mut = [], setup = null, o = {}) {
  const w = installCombat(new World(map, { seed: 9, stage: 2, mutators: [...QUIET, ...(o.timers ? [] : NOW), ...mut], sandbox: o.sandbox ?? true }));
  w.exec({ t: 'loadout.set', abilities: Object.fromEntries(IDS.map((id) => [id, o.charges ?? 2])) });
  if (setup) setup(w);
  w.exec({ t: 'ready' });
  killKind(w, TYPE.ZOMBIE);
  const z = w.spawn(TYPE.ZOMBIE, 26, 774);
  w.A.stun[z] = 1e9;
  w.step();
  return w;
}
const horde = (w, x, y, n, r = 10) => {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = k * 2.399963, d = r * Math.sqrt((k + 0.5) / n);
    const c = w.cellAt(x + Math.cos(a) * d, y + Math.sin(a) * d);
    if (c >= 0 && (w.nav.pass[c] & 4)) out.push(w.spawn(TYPE.ZOMBIE, x + Math.cos(a) * d, y + Math.sin(a) * d));
  }
  return out;
};
const crowd = (w, type, x, y, n, r = 10) => {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = k * 2.399963, d = r * Math.sqrt((k + 0.5) / n), c = w.cellAt(x + Math.cos(a) * d, y + Math.sin(a) * d);
    if (c >= 0 && (w.nav.pass[c] & 2)) out.push(w.spawn(type, x + Math.cos(a) * d, y + Math.sin(a) * d));
  }
  w.step();
  return out;
};
const use = (w, id, x, y, extra = {}) => w.exec({ t: 'ability.use', id, x, y, ...extra });

// ---------------------------------------------------------------- charges, unlock timers, planning
{
  const w = installCombat(new World(map, { seed: 9, stage: 2, mutators: QUIET, sandbox: true }));
  w.exec({ t: 'loadout.set', abilities: { airstrike: 1, nuke: 1, paratroopers: 2 } });
  assert(!use(w, 'paratroopers', 150, 150).ok, 'abilities cannot be used during planning');
  const st0 = abilityState(w, 'nuke');
  assert(st0.charges === 1 && st0.unlockIn === 90 && !st0.ready && st0.delay === 45, 'planning: state shows charges and the full unlock time');
  w.exec({ t: 'ready' });
  const z = w.spawn(TYPE.ZOMBIE, 26, 774); w.A.stun[z] = 1e9;
  run(w, 1);
  const r = use(w, 'airstrike', 150, 150, { x2: 250, y2: 150 });
  assert(!r.ok && /Available in 4\d s/.test(r.reason) && abilityState(w, 'airstrike').unlockIn > 40, `locked until its unlock time (${r.reason})`);
  assert(!use(w, 'cure', 150, 150).ok && /No charges/.test(use(w, 'cure', 150, 150).reason), 'no charges, no ability');
  const p1 = use(w, 'paratroopers', 150, 150);
  assert(p1.ok && w.charges.paratroopers === 1 && abilityState(w, 'paratroopers').pending === 1, 'using spends one charge and queues a delivery');
  assert(w.effects.some((e) => e.kind === 'drop' && e.ability === 'paratroopers' && Math.abs(e.dur - 10) < 1e-6), 'a delivery countdown marker is on the map');
  assert(Math.abs(abilityState(w, 'paratroopers').deliveryIn - 10) < 0.01, 'state reports the delivery countdown');
  use(w, 'paratroopers', 250, 150);
  assert(!use(w, 'paratroopers', 350, 150).ok && w.charges.paratroopers === 0, 'charges run out');
  assert(!use(w, 'paratroopers', 150, 150 + 1e6).ok, 'targets outside the stage are rejected');
}

// ---------------------------------------------------------------- 1 paratroopers
{
  const w = battle();
  const s0 = w.counts[TYPE.SOLDIER];
  use(w, 'paratroopers', 150, 150);
  run(w, 9.5);
  assert(w.counts[TYPE.SOLDIER] === s0, 'paratroopers: nobody lands before the delay');
  assert(w.effects.some((e) => e.kind === 'plane'), 'paratroopers: the transport flies over');
  run(w, 1);
  const sq = w.squads[0];
  assert(w.counts[TYPE.SOLDIER] - s0 >= 18 && sq && squadMembers(w, sq.group) === w.counts[TYPE.SOLDIER] - s0, `paratroopers: squad of ${w.counts[TYPE.SOLDIER] - s0} lands`);
  assert(w.exec({ t: 'squad.mode', group: sq.group, mode: 'guard' }).ok && sq.mode === 'guard', 'paratroopers: squad switched to Guard');
  let guard = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.group[i] === sq.group && w.A.state[i] === 0) guard++;
  assert(guard === squadMembers(w, sq.group), 'paratroopers: every member guards');
  w.exec({ t: 'squad.mode', group: sq.group, mode: 'hunt' });
  horde(w, 150, 200, 15, 6);
  run(w, 8);
  assert(kills(w, 'paratroopers') >= 10, `paratroopers: kills credited to the ability (${kills(w, 'paratroopers')})`);
}

// ---------------------------------------------------------------- 2 call to arms
{
  const w = battle();
  const civs = crowd(w, TYPE.CIV, 450, 150, 30, 8);
  const m0 = w.counts[TYPE.MILITIA], c0 = w.stats.converted;
  assert(use(w, 'callToArms', 450, 150, { r: 20 }).ok, 'call to arms: used on a circle');
  const armed = civs.filter((i) => w.A.type[i] === TYPE.MILITIA).length;
  assert(armed === civs.length && w.counts[TYPE.MILITIA] - m0 >= civs.length && w.stats.converted - c0 === w.counts[TYPE.MILITIA] - m0, `call to arms: ${armed} civilians armed and no longer counted as saved`);
  const big = battle(['abilities.callToArms.max=10']);
  crowd(big, TYPE.CIV, 450, 150, 30, 8);
  use(big, 'callToArms', 450, 150, { r: 20 });
  assert(big.counts[TYPE.MILITIA] === 10, 'call to arms: capped by max');
}

// ---------------------------------------------------------------- 3 seek & destroy
{
  const b = map.buildings.findIndex((q) => q.k === 'res' && Math.abs(q.p[1] - 158) < 1 && q.p[0] > 300);
  let gid = -1;
  const w = battle([], (w0) => { gid = w0.exec({ t: 'unit.place', type: 'garrison', x: w0.buildings[b].cx, y: w0.buildings[b].cy }).id; });
  const p0 = w.counts[TYPE.POLICE];
  assert(!use(w, 'seekDestroy', 150, 150).ok, 'seek & destroy: needs a garrison');
  const r = w.exec({ t: 'ability.use', id: 'seekDestroy', unit: gid });
  const g = w.units.find((u) => u.id === gid);
  assert(r.ok && !g.alive && w.buildings[b].unitId === -1, 'seek & destroy: the garrison leaves its building');
  assert(w.counts[TYPE.POLICE] - p0 === 25, `seek & destroy: a full garrison becomes ${w.counts[TYPE.POLICE] - p0} officers`);
  const w2 = battle([], (w0) => { gid = w0.exec({ t: 'unit.place', type: 'garrison', x: w0.buildings[b].cx, y: w0.buildings[b].cy }).id; });
  const g2 = w2.units.find((u) => u.id === gid);
  g2.ammo = 40; g2.reloads = 0;
  const q0 = w2.counts[TYPE.POLICE];
  w2.exec({ t: 'ability.use', id: 'seekDestroy', x: g2.x, y: g2.y });
  assert(w2.counts[TYPE.POLICE] - q0 === 5, 'seek & destroy: a nearly empty garrison gives the minimum');
}

// ---------------------------------------------------------------- 4 APC, 14 tank
for (const id of ['apc', 'tank']) {
  const w = battle(['zombie.speed=0']);
  assert(use(w, id, 350, 150).ok, `${id}: called in`);
  run(w, w.cfg.abilities[id].delay - 0.5);
  assert(!w.vehicles.some((v) => v.kind === id), `${id}: not there before the delay`);
  run(w, 1);
  const v = w.vehicles.find((q) => q.kind === id);
  assert(v && v.hp === v.hpMax, `${id}: arrives on station`);
  horde(w, 350, Math.min(360, 150 + w.cfg.abilities[id].range + 50), 25, 12);
  let far = 0;
  for (let k = 0; k < 500; k++) { w.step(); far = Math.max(far, Math.hypot(v.x - 350, v.y - 150)); }
  assert(kills(w, id) >= 10 && far > 20, `${id}: drives out ${far.toFixed(0)} m and kills (${kills(w, id)})`);
  run(w, 30);
  assert(Math.hypot(v.x - v.hx, v.y - v.hy) < 8, `${id}: returns to its post when the area is clear`);
  const w2 = battle(['zombie.speed=1']);
  use(w2, id, 350, 150);
  run(w2, w2.cfg.abilities[id].delay + 0.5);
  const v2 = w2.vehicles.find((q) => q.kind === id);
  v2.hp = 30;
  w2.cfg.abilities[id].dmg = 0; w2.cfg.abilities[id].mgDmg = 0; w2.cfg.abilities[id].crushDps = 0;
  horde(w2, v2.x, v2.y, 8, 3);
  run(w2, 0.6);
  assert(!w2.vehicles.includes(v2) && w2.effects.some((e) => e.kind === 'boom'), `${id}: zombies that reach it destroy it`);
}

// ---------------------------------------------------------------- 5 bus, 6 medevac
{
  const w = battle();
  const civs = crowd(w, TYPE.CIV, 450, 250, 60, 14);
  const e0 = w.stats.civEvac;
  assert(use(w, 'bus', 450, 250).ok && w.pickups.length === 1, 'bus: pulls up and opens a pickup');
  run(w, 6);
  const v = w.vehicles.find((q) => q.kind === 'bus');
  assert(v.loaded >= 50 && w.stats.civEvac - e0 === v.loaded, `bus: ${v.loaded} civilians boarded and counted as saved`);
  let left = -1;
  for (let k = 0; k < 2400 && left < 0; k++) { w.step(); if (v.state === 'leave') left = w.t - v.lastLoad; }
  assert(left >= 20 && !w.pickups.length, `bus: leaves ${left.toFixed(0)} s after the last civilian boarded`);
  run(w, 60);
  assert(!w.vehicles.includes(v) && v.y < 30, 'bus: drives off the map');
  const cap = battle(['abilities.bus.capacity=20']);
  crowd(cap, TYPE.CIV, 450, 250, 40, 14);
  use(cap, 'bus', 450, 250);
  run(cap, 4);
  const cv = cap.vehicles.find((q) => q.kind === 'bus');
  assert(cv && cv.loaded === 20 && cv.state === 'leave', 'bus: drives off once full');
  run(cap, 40);
  assert(!cap.vehicles.length, 'bus: gone off the map');
}
{
  const w = battle();
  crowd(w, TYPE.CIV, 550, 250, 40, 12);
  const e0 = w.stats.civEvac;
  assert(use(w, 'medevac', 550, 250).ok, 'medevac: called');
  const v = w.vehicles.find((q) => q.kind === 'medevac');
  assert(v && v.state === 'inbound' && Math.hypot(v.x - 550, v.y - 250) > 200, 'medevac: flies in from the map edge');
  run(w, 25);
  assert(w.stats.civEvac - e0 >= 30, `medevac: ${w.stats.civEvac - e0} civilians flown out`);
}

// ---------------------------------------------------------------- 7 bulldozer
{
  const b = map.buildings.findIndex((q) => Math.abs(q.p[0] - 158) < 1 && Math.abs(q.p[1] - 158) < 1);
  const w = battle(['zombie.speed=0']);
  const bd = w.buildings[b];
  w.collapseBuilding(b, 0, 1);
  const rub = w.cellAt(bd.cx, bd.cy);
  assert(w.grid.terrain[rub] === T.RUBBLE, 'bulldozer: a collapsed building left rubble');
  const next = w.buildings.find((q) => q.alive && Math.abs(q.cy - bd.cy) < 1 && q.cx > bd.cx && q.cx < bd.cx + 60);
  const zs = horde(w, 200, bd.cy, 6, 2);
  assert(use(w, 'bulldozer', 150, bd.cy, { x2: 290, y2: bd.cy }).ok, 'bulldozer: line drawn');
  run(w, 50);
  assert(w.grid.terrain[rub] !== T.RUBBLE && (w.nav.pass[rub] & 16) === 0, 'bulldozer: rubble on its line is cleared');
  assert(!next.alive, 'bulldozer: pushes over the building in its way');
  assert(zs.every((i) => w.A.type[i] !== TYPE.ZOMBIE) && kills(w, 'bulldozer') >= 5, `bulldozer: crushes the infected (${kills(w, 'bulldozer')})`);
}

// ---------------------------------------------------------------- 8 rally
{
  const w = battle();
  const sol = crowd(w, TYPE.SOLDIER, 250, 550, 10, 6);
  for (const i of sol) w.A.state[i] = 1;
  assert(use(w, 'rally', 330, 550).ok, 'rally: called');
  run(w, 29);
  const at = sol.filter((i) => Math.hypot(w.A.x[i] - 330, w.A.y[i] - 550) < 25).length;
  assert(at >= 8, `rally: responders regroup at the point (${at}/${sol.length})`);
  run(w, 2);
  assert(sol.every((i) => w.A.state[i] === 1) && !w.combat.rallies.length, 'rally: they resume their stance afterwards');
}

// ---------------------------------------------------------------- 9 demolition
{
  const w = battle();
  const bd = w.buildings.find((q) => q.k === 'res' && q.cx > 300 && q.cx < 500 && q.cy > 500 && q.cy < 600);
  assert(!use(w, 'demolition', 150, 150).ok, 'demolition: must target a building');
  assert(use(w, 'demolition', bd.cx + 5, bd.cy).ok, 'demolition: building targeted');
  run(w, 2.5);
  assert(bd.alive, 'demolition: charges need time');
  run(w, 1);
  assert(!bd.alive && w.grid.terrain[w.cellAt(bd.cx + bd.r + 6, bd.cy)] !== T.ROAD, 'demolition: building toppled toward the picked side');
}

// ---------------------------------------------------------------- 10 fire bomb, 13 gas bomb
{
  const w = battle(['zombie.speed=0']);
  const zs = horde(w, 450, 550, 20, 15);
  assert(use(w, 'fireBomb', 450, 550).ok, 'fire bomb: called');
  run(w, 4.1);
  const nav = w.nav, fc = Math.floor(550 / nav.ccell) * nav.cgw + Math.floor(450 / nav.ccell);
  assert(w.fire[fc] > 0 && w.effects.some((e) => e.kind === 'fireburst'), 'fire bomb: the area is burning');
  assert(kills(w, 'fireBomb') >= 15 && zs.filter((i) => w.A.type[i] === TYPE.ZOMBIE).length <= 5, `fire bomb: the crowd burns (${kills(w, 'fireBomb')})`);
}
{
  const w = battle();
  const zs = horde(w, 650, 150, 20, 30);
  use(w, 'gasBomb', 650, 150);
  run(w, 4.1);
  assert(zs.every((i) => w.A.type[i] === TYPE.ZOMBIE && w.A.stun[i] > 9), 'gas bomb: every zombie in the cloud is stunned');
  const pos = zs.map((i) => w.A.x[i]);
  run(w, 3);
  assert(zs.every((i, k) => w.A.x[i] === pos[k]), 'gas bomb: stunned zombies do not move');
}

// ---------------------------------------------------------------- 11 cruise missile
{
  const w = battle(['zombie.speed=0']);
  const bd = w.buildings.find((q) => q.k === 'res' && q.cx > 500 && q.cy > 450 && q.cy < 600);
  horde(w, bd.cx + bd.r + 6, bd.cy, 10, 5);
  use(w, 'cruise', bd.cx + bd.r, bd.cy);
  assert(w.projectiles.some((p) => p.kind === 'missile' && Math.abs(p.dur - 6) < 1e-6), 'cruise: missile in flight');
  run(w, 6.1);
  assert(bd.hp < bd.hpMax - 600 && kills(w, 'cruise') >= 8, `cruise: building wrecked (${Math.round(bd.hp)}/${bd.hpMax}), ${kills(w, 'cruise')} killed`);
  const w2 = battle();
  const br = w2.bridges[3];
  use(w2, 'cruise', br.cx, br.cy);
  run(w2, 6.1);
  assert(!br.alive, 'cruise: drops a bridge');
}

// ---------------------------------------------------------------- 12 helicopter
{
  const w = battle(['zombie.speed=0', 'abilities.helicopter.ammo=40', 'abilities.helicopter.rearmSec=3']);
  horde(w, 350, 650, 80, 25);
  use(w, 'helicopter', 350, 650);
  const v = w.vehicles.find((q) => q.kind === 'heli');
  const seen = new Set();
  for (let k = 0; k < 1600 && w.vehicles.includes(v); k++) { w.step(); seen.add(v.state); if (k === 100) assert(v.state === 'inbound' || v.state === 'hunt', 'helicopter: inbound'); }
  assert(kills(w, 'helicopter') >= 30, `helicopter: hunts the infected (${kills(w, 'helicopter')})`);
  assert(['hunt', 'rtb', 'rearm', 'return'].every((s) => seen.has(s)), `helicopter: flies to the edge to rearm and comes back (${[...seen].join(' > ')})`);
}

// ---------------------------------------------------------------- 15 airstrike, 16 cluster bomb
{
  const w = battle(['zombie.speed=0']);
  const zs = [];
  for (let x = 250; x <= 450; x += 20) zs.push(...horde(w, x, 650, 3, 2));
  assert(!use(w, 'airstrike', 230, 650).ok, 'airstrike: needs a direction');
  use(w, 'airstrike', 220, 650, { x2: 400, y2: 650 });
  run(w, 5);
  assert(w.effects.some((e) => e.kind === 'plane'), 'airstrike: the bomber is overhead');
  run(w, 3);
  const dead = zs.filter((i) => w.A.type[i] !== TYPE.ZOMBIE).length;
  assert(dead >= zs.length * 0.8 && kills(w, 'airstrike') === dead, `airstrike: bombs along the line (${dead}/${zs.length})`);
}
{
  const w = battle(['zombie.speed=0']);
  const zs = horde(w, 650, 650, 60, 50);
  use(w, 'clusterBomb', 650, 650);
  run(w, 7);
  const dead = zs.filter((i) => w.A.type[i] !== TYPE.ZOMBIE).length;
  assert(dead >= zs.length * 0.35 && kills(w, "clusterBomb") === dead, `cluster bomb: bomblets saturate the area (${dead}/${zs.length})`);
}

// ---------------------------------------------------------------- 17 gunship
{
  const w = battle(['zombie.speed=0']);
  const gz = horde(w, 550, 550, 60, 60);
  use(w, 'gunship', 550, 550);
  const v = w.vehicles.find((q) => q.kind === 'gunship');
  run(w, 6.2);
  assert(v.state === 'orbit' && Math.abs(Math.hypot(v.x - 550, v.y - 550) - w.cfg.abilities.gunship.orbitR) < 2, 'gunship: arrives on its orbit');
  run(w, 30);
  assert(kills(w, 'gunship') >= gz.length * 0.8, `gunship: cannons the crowd (${kills(w, 'gunship')}/${gz.length})`);
  run(w, 40);
  assert(!w.vehicles.includes(v), 'gunship: leaves after its time on station');
}

// ---------------------------------------------------------------- 18 cure
{
  const w = battle();
  const zs = horde(w, 250, 750, 20, 20);
  const far = horde(w, 450, 750, 5, 3);
  const c0 = w.counts[TYPE.CIV];
  use(w, 'cure', 250, 750, { r: 40 });
  run(w, 3.1);
  assert(zs.every((i) => w.A.type[i] === TYPE.CIV) && w.counts[TYPE.CIV] >= c0 + zs.length && w.stats.cured >= zs.length, `cure: ${zs.length} zombies are civilians again`);
  assert(far.every((i) => w.A.type[i] === TYPE.ZOMBIE), 'cure: only inside the circle');
}

// ---------------------------------------------------------------- 19 nuke
{
  const w = battle(['abilities.nuke.radius=500']);
  horde(w, 400, 400, 50, 60);
  horde(w, 400, 100, 20, 10);
  let ev = null;
  w.events.on('nuke', (e) => { ev = e; });
  use(w, 'nuke', 400, 400);
  run(w, 44);
  assert(!ev && w.counts[TYPE.ZOMBIE] > 60, 'nuke: nothing happens before 45 s');
  run(w, 1.1);
  const core = 500 * w.cfg.abilities.nuke.coreFrac;
  assert(ev && ev.x === 400 && w.effects.some((e) => e.kind === 'nuke'), 'nuke: detonation event and flash');
  assert(near(w, TYPE.ZOMBIE, 400, 400, core) === 0 && near(w, TYPE.CIV, 400, 400, core) === 0, 'nuke: nothing survives in the core');
  assert(w.buildings.every((b) => !b.alive || Math.hypot(b.cx - 400, b.cy - 400) - b.r > core), 'nuke: every building in the core collapsed');
  assert(kills(w, 'nuke') >= 60, `nuke: kills credited (${kills(w, 'nuke')})`);
}
console.log('combat_abilities: all passed');
