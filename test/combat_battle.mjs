// COMBAT battle rules: ammo and reloads in and out of zones, Supply restock, start delay, targeting, friendly fire,
// traps and lines, unit damage, determinism, and a mixed defence winning a stage. Run: node test/combat_battle.mjs
import { World, TYPE, ZSUB } from '../js/sim/world.js';
import { DEFAULTS } from '../js/data/config.js';
import { installCombat, unitStats } from '../js/sim/units.js';
import { breachZone } from '../js/sim/zones.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });
const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.03', 'mutation.firstSec=100000'];
const TOUGH = ['zombie.speed=0', 'zombie.hpStart=1e6', 'zombie.hpMax=1e6', 'zombie.touchRadius=0'];
const dt = DEFAULTS.sim.dt;
const run = (w, sec, each) => { const n = Math.round(sec / dt); for (let k = 0; k < n && w.phase === 'battle'; k++) { w.step(); if (each) each(w); } };
const mk = (mut = [], o = {}) => installCombat(new World(o.map || map, { seed: o.seed || 13, stage: o.stage ?? 2, mutators: [...QUIET, ...mut], sandbox: o.sandbox ?? true }));
const killKind = (w, type) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === type) w.remove(i); };
const go = (w) => { w.exec({ t: 'ready' }); killKind(w, TYPE.ZOMBIE); const z = w.spawn(TYPE.ZOMBIE, 26, 774); w.A.stun[z] = 1e9; return z; };
const place = (w, type, x, y, o = {}) => w.exec({ t: 'unit.place', type, x, y, ...o });
const U = (w, r) => w.units.find((u) => u.id === r.id);
const bAt = (w, x0, y0) => w.buildings.find((b) => Math.abs(map.buildings[b.idx].p[0] - x0) < 1 && Math.abs(map.buildings[b.idx].p[1] - y0) < 1);
const pile = (w, x, y, n, r = 3) => { const out = []; for (let k = 0; k < n; k++) { const a = k * 2.4, d = r * Math.sqrt((k + 0.5) / n); out.push(w.spawn(TYPE.ZOMBIE, x + Math.cos(a) * d, y + Math.sin(a) * d)); } return out; };

// ---------------------------------------------------------------- zone garrison never runs dry; an outside one does; start delay
{
  const w = mk([...TOUGH, 'units.garrison.mag=10', 'units.garrison.reloads=2', 'units.garrison.reloadSec=0.5']);
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 1, 1) });
  const bIn = bAt(w, 204, 204), bOut = bAt(w, 258, 204);
  assert(bIn.zone === 0 && bOut.zone === -1, 'one building inside the zone, one outside');
  const gi = U(w, place(w, 'garrison', bIn.cx, bIn.cy)), go_ = U(w, place(w, 'garrison', bOut.cx, bOut.cy));
  go(w);
  pile(w, 251, 225, 12, 2);
  let dryIn = false, firstIn = -1, firstOut = -1, dryOutAt = -1;
  run(w, 60, () => {
    if (gi.dry) dryIn = true;
    if (firstIn < 0 && gi.shots) firstIn = w.t;
    if (firstOut < 0 && go_.shots) firstOut = w.t;
    if (dryOutAt < 0 && go_.dry) dryOutAt = w.t;
  });
  assert(firstIn >= 0 && firstIn < 0.5, `inside a zone: fires at once (${firstIn.toFixed(2)} s)`);
  assert(firstOut >= w.cfg.zone.outsideStartDelay - 1e-6, `outside: holds fire for ${w.cfg.zone.outsideStartDelay} s (first shot ${firstOut.toFixed(2)} s)`);
  assert(!dryIn && gi.shots > 150 && gi.reloads === 2, `inside garrison never runs dry (${gi.shots} shots, reloads still ${gi.reloads})`);
  assert(dryOutAt > 0 && go_.dry && go_.shots === 30 && go_.reloads === 0, `outside garrison runs dry after mag x (1 + reloads) = ${go_.shots} shots`);
  // breach: the zone garrison keeps only its base reloads
  const comp = w.zones.comps[0];
  breachZone(w, 0);
  run(w, 0.2);
  assert(comp.breached, 'zone breached');
  const s0 = gi.shots, left = gi.ammo;
  run(w, 30);
  assert(gi.dry && gi.shots - s0 === left + 20, `after the breach it has its ${2} base reloads left, then runs dry (${gi.shots - s0} more shots)`);
}

// ---------------------------------------------------------------- turrets only restock under a Supply aura; battleships never run out
for (const supply of [false, true]) {
  const m2 = makeTestMap({ size: 800, river: true });
  const ar = m2.buildings.findIndex((b) => b.k === 'armory');
  const w = mk([...TOUGH, 'units.turret.mag=20'], { map: m2 });
  const ab = w.buildings[ar], bx = Math.floor((ab.cx - 50) / 100), by = Math.floor((ab.cy - 50) / 100);
  w.exec({ t: 'zone.add', p: blockRect(bx, by, bx, by) });
  if (supply) assert(w.exec({ t: 'func.set', b: ar, func: 'supply' }).ok, 'arsenal set to Supply');
  const x0 = 50 + bx * 100 + 50, y0 = 50 + by * 100 + 50;
  const t = U(w, place(w, 'turret', x0, y0));
  assert(t && w.inZone(t.x, t.y) === 0, `turret inside the arsenal's zone (supply ${supply})`);
  go(w);
  pile(w, x0, 50 + by * 100 - 2 + (by ? 0 : 100), 8, 2);
  run(w, 40);
  if (supply) assert(t.shots > 40 && !t.dry, `Supply restocks the turret (${t.shots} shots)`);
  else assert(t.shots === 20 && t.dry, 'a turret inside a zone still never reloads without Supply');
}
{
  const w = mk(TOUGH);
  const s = U(w, place(w, 'battleship', 300, 400));
  go(w);
  pile(w, 300, 350, 10, 3);
  run(w, 60);
  assert(s.shots >= 11 && s.ammo === Infinity && !s.dry, `battleship: unlimited shells (${s.shots} salvos)`);
}

// ---------------------------------------------------------------- targeting: snipers want mutants; mortars respect their minimum range
{
  const w = mk(TOUGH);
  const b = bAt(w, 258, 204);
  const sn = U(w, place(w, 'sniper', b.cx, b.cy));
  go(w);
  pile(w, b.cx + 40, b.cy + 46, 5, 2);
  const m = w.spawn(TYPE.ZOMBIE, b.cx + 300, b.cy + 46);
  w.A.sub[m] = ZSUB.GIANT;
  run(w, 16);
  assert(sn.tgt === m && sn.shots > 0, 'sniper: shoots the far mutant before the near zombies');
}
{
  const w = mk(TOUGH);
  const b = bAt(w, 358, 204);
  const mo = U(w, place(w, 'mortar', b.cx, b.cy));
  go(w);
  pile(w, b.cx, b.cy + 46, 10, 3);
  run(w, 20);
  assert(mo.shots === 0, 'mortar: never fires inside its minimum range');
  pile(w, b.cx + 300, b.cy + 46, 10, 3);
  const land = [];
  run(w, 10, (ww) => { for (const s of ww.combat.shells) if (!land.includes(s)) land.push(s); });
  const minD = Math.min(...land.map((s) => Math.hypot(s.x - b.cx, s.y - b.cy)));
  assert(mo.shots >= 2 && minD > 250, `mortar: shells the far crowd (${mo.shots} shots, nearest impact ${minD.toFixed(0)} m)`);
}
{
  const w = mk(TOUGH);
  const r = U(w, place(w, 'railgun', 150, 650));
  go(w);
  const line = [];
  for (let k = 0; k < 12; k++) line.push(...pile(w, 200 + k * 30, 650, 1, 0));
  w.cfg.zombie.hpMax = w.cfg.zombie.hpStart = 1;
  run(w, 13);
  assert(r.shots === 1 && r.kills >= 10, `rail cannon: one slug through the whole line (${r.kills} kills)`);
}
{
  const w = mk(TOUGH);
  const m = U(w, place(w, 'mlrs', 150, 650));
  go(w);
  pile(w, 450, 650, 10, 4);
  run(w, 13);
  const rockets = w.combat.shells.length + 0;
  assert(m.shots === 1 && w.projectiles.filter((p) => p.kind === 'rocket').length + rockets >= unitStats(w, m).rockets, `rocket battery: one salvo of ${unitStats(w, m).rockets} rockets`);
}

// ---------------------------------------------------------------- friendly fire: automatic weapons never hurt people, aimed attacks do
{
  const w = mk([...TOUGH, 'civ.panicRadius=0']);
  w.exec({ t: 'zone.add', p: blockRect(5, 1, 5, 1) });
  const b = bAt(w, 258, 204);
  U(w, place(w, 'mortar', b.cx, b.cy)); U(w, place(w, 'turret', 650, 150));
  go(w);
  const wall = w.zones.comps[0].wallCells;
  const wx = (wall[0] % w.grid.gw + 0.5) * 4, wy = (((wall[0] / w.grid.gw) | 0) + 0.5) * 4;
  pile(w, wx - 2, wy - 6, 8, 3);
  for (let k = 0; k < 10; k++) w.spawn(TYPE.CIV, wx - 2 + (k % 5) * 1.5, wy - 8 + (k / 5 | 0) * 2);
  const k0 = w.stats.civKilled;
  run(w, 30);
  let chipped = 0;
  for (const c of wall) if (w.wallHp[c] > 0 && w.wallHp[c] < w.cfg.wall.hp) chipped++;
  assert(w.stats.civKilled === k0, 'mortar and turret fire never kill civilians');
  assert(chipped > 0, `heavy shells still chip the walls (${chipped} cells)`);
  w.exec({ t: 'loadout.set', abilities: {} });
  w.charges.fireBomb = 1; w.cfg.abilities.fireBomb.unlock = 0;
  w.exec({ t: 'ability.use', id: 'fireBomb', x: wx - 2, y: wy - 6 });
  run(w, 5);
  assert(w.stats.civKilled > k0, `aimed abilities hurt civilians (${w.stats.civKilled - k0})`);
}

// ---------------------------------------------------------------- unit HP: zombies tear down a ground unit they touch
{
  const w = mk(['zombie.speed=0', 'units.turret.dmg=0']);
  const t = U(w, place(w, 'turret', 150, 150));
  go(w);
  let logged = false;
  w.events.on('log', (e) => { if (/SENTRY GUN LOST/.test(e.msg)) logged = true; });
  pile(w, 151, 151, 10, 1.5);
  run(w, 6);
  assert(!t.alive && t.hp <= 0 && logged, 'turret overrun and destroyed');
  assert(w.exec({ t: 'unit.upgrade', id: t.id }).ok === false, 'a destroyed unit cannot be upgraded');
}

// ---------------------------------------------------------------- traps and lines
{
  const w = mk(['zombie.touchRadius=0']);
  const mines = w.exec({ t: 'unit.paint', type: 'mine', path: [450, 150, 470, 150] });
  const gas = U(w, place(w, 'chemical', 550, 150));
  const nap = U(w, place(w, 'napalm', 650, 250));
  go(w);
  w.spawn(TYPE.ZOMBIE, 460, 150); w.spawn(TYPE.ZOMBIE, 551, 150); w.spawn(TYPE.ZOMBIE, 652, 250);
  run(w, 0.3);
  assert(w.units.filter((u) => u.type === 'mine' && !u.alive).length >= 1 && (w.stats.killsBy.mine || 0) >= 1, 'mine: goes off under a zombie and kills it');
  assert(!gas.alive && w.effects.some((e) => e.kind === 'gas'), 'gas canister: releases its cloud once');
  let stunned = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE && w.A.stun[i] > 5 && w.A.stun[i] < 1e8) stunned++;
  assert(stunned >= 1, 'gas canister: zombie stunned');
  const nav = w.nav;
  assert(!nap.alive && w.fire[Math.floor(250 / nav.ccell) * nav.cgw + Math.floor(650 / nav.ccell)] > 0, 'napalm trap: bursts into flame');
  assert(mines.count > 2 && w.units.filter((u) => u.type === 'mine' && u.alive).length >= 1, 'only the mines that were stepped on are gone');
}
{
  const speedOn = (spikes) => {
    const w = mk(['zombie.touchRadius=0', 'civ.panicRadius=0', 'zombie.speed=3', 'civ.walk=0.01', 'civ.wander=0']);
    if (spikes) w.exec({ t: 'unit.place', type: 'spikes', p: [100, 350, 300, 350] });
    go(w);
    killKind(w, TYPE.CIV);
    const c = w.spawn(TYPE.CIV, 320, 350);
    w.A.panic[c] = 0;
    const z = w.spawn(TYPE.ZOMBIE, 290, 350);
    run(w, 0.5);
    const x0 = w.A.x[z];
    run(w, 3);
    const u = w.units[0];
    return { d: Math.abs(w.A.x[z] - x0), worn: u ? u.dur.some((v) => v < w.cfg.units.spikes.durability) : false };
  };
  const plain = speedOn(false), spiked = speedOn(true);
  const ratio = spiked.d / plain.d;
  assert(Math.abs(ratio - (1 - DEFAULTS.units.spikes.slow)) < 0.12 && spiked.worn, `spike strip slows zombies to ${(ratio * 100).toFixed(0)}% and wears down`);
}
{
  const w = mk(['zombie.touchRadius=0', 'zombie.speed=0']);
  const oil = U(w, w.exec({ t: 'unit.place', type: 'oil', p: [100, 550, 200, 550] }));
  go(w);
  const zs = pile(w, 190, 550, 3, 1);
  run(w, 0.2);
  assert(!oil.lit && oil.igniteAt > 0, 'oil slick: a zombie steps in and the fuse starts');
  run(w, w.cfg.units.oil.autoIgnite + 0.2);
  const nav = w.nav;
  assert(oil.lit && w.fire[Math.floor(550 / nav.ccell) * nav.cgw + Math.floor(120 / nav.ccell)] > 0, 'oil slick: the whole line catches fire');
  run(w, 10);
  assert(zs.every((i) => w.A.type[i] !== TYPE.ZOMBIE), 'oil slick: the zombies in it burn');
  run(w, w.cfg.units.oil.burnSec);
  assert(!oil.alive, 'oil slick: burnt out after its burn time');
}

// ---------------------------------------------------------------- determinism with units, vehicles and abilities
{
  const fresh = () => installCombat(new World(map, { seed: 77, stage: 2, mutators: ['loseBelowPct=0', 'population.scale=0.1', 'outbreak.zombieScaleWithPop=false', 'outbreak.minSites=2', ...Object.keys(DEFAULTS.abilities).map((id) => `abilities.${id}.unlock=0`)], sandbox: true }));
  const build = (w) => {
    w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
    w.exec({ t: 'gate.add', x: 250, y: 352 });
    w.exec({ t: 'unit.paint', type: 'garrison', path: [180, 180, 330, 330], w: 30 });
    w.exec({ t: 'unit.place', type: 'mortar', x: w.buildings[40].cx, y: w.buildings[40].cy });
    w.exec({ t: 'unit.place', type: 'turret', x: 450, y: 450 });
    w.exec({ t: 'unit.paint', type: 'mine', path: [550, 150, 650, 150] });
    w.exec({ t: 'unit.place', type: 'spikes', p: [460, 250, 540, 250] });
    w.exec({ t: 'loadout.set', abilities: { airstrike: 1, tank: 1, helicopter: 1, gunship: 1, bus: 1 } });
    return w;
  };
  const script = (w = build(fresh())) => {
    w.exec({ t: 'ready' });
    const hs = [];
    for (let k = 1; k <= 1500 && w.phase === 'battle'; k++) {
      if (k === 50) w.exec({ t: 'ability.use', id: 'tank', x: 450, y: 550 });
      if (k === 80) w.exec({ t: 'ability.use', id: 'helicopter', x: 550, y: 550 });
      if (k === 120) w.exec({ t: 'ability.use', id: 'gunship', x: 400, y: 600 });
      if (k === 160) w.exec({ t: 'ability.use', id: 'bus', x: 650, y: 650 });
      if (k === 200) w.exec({ t: 'ability.use', id: 'airstrike', x: 350, y: 650, x2: 550, y2: 650 });
      w.step();
      if (k % 300 === 0) hs.push(w.hash());
    }
    hs.push(w.hash(), w.tick);
    return { hs, kills: w.stats.killed };
  };
  const a = script(), b = script();
  assert(a.hs.length >= 4 && a.hs.join() === b.hs.join() && a.kills > 0, `same seed and commands give the same hashes (${a.hs.length} checkpoints, ${a.kills} kills)`);
  const r = build(fresh()), snap = r.snapshot();
  script(r);
  r.restore(snap);
  assert(r.phase === 'planning' && !r.vehicles.length && !r.strikes.length && !r.squads.length, 'retry clears vehicles, pending strikes and squads');
  const c = script(r);
  assert(c.hs.join() === a.hs.join(), 'a retried battle with units and abilities replays exactly like a fresh one');
}

// ---------------------------------------------------------------- a mixed defence wins a small stage
{
  const m = makeTestMap({ size: 800, river: false, seed: 4321 });
  const w = installCombat(new World(m, { seed: 4321, stage: 1 }));
  w.exec({ t: 'zone.add', p: blockRect(3, 3, 3, 3) });
  assert(w.exec({ t: 'gate.add', x: 400, y: 452 }).ok, 'zone with a gate in the district');
  const inside = w.buildings.filter((b) => b.zone === 0);
  for (const b of inside.slice(0, 2)) w.exec({ t: 'unit.place', type: 'sniper', x: b.cx, y: b.cy });
  for (const b of inside.slice(2)) w.exec({ t: 'unit.place', type: 'mortar', x: b.cx, y: b.cy });
  const tur = [[350, 350], [450, 350], [350, 450], [450, 450]].map(([x, y]) => w.exec({ t: 'unit.place', type: 'turret', x, y }).ok).filter(Boolean).length;
  const paint = w.exec({ t: 'unit.paint', type: 'garrison', path: [230, 230, 570, 230, 570, 570, 230, 570, 230, 230], w: 60 });
  assert(paint.ok && w.budget.spent <= w.budget.cap, `defence built: 2 snipers, ${inside.length - 2} mortars, ${tur} turrets, ${paint.count} garrisons ($${Math.round(w.budget.spent)} of $${w.budget.cap})`);
  let result = null;
  w.events.on('stageEnd', (e) => { result = e.result; });
  w.exec({ t: 'ready' });
  const z0 = w.counts[TYPE.ZOMBIE];
  assert(z0 >= 50, `an outbreak of ${z0} zombies`);
  run(w, 900);
  assert(result && result.won, `stage won (t=${w.t.toFixed(0)} s, ${result && result.pct.toFixed(1)}% saved, badge ${result && result.badge})`);
  const row = (k) => result.perType.find((r) => r.key === k) || { kills: 0, spent: 0, count: 0 };
  assert(row('garrison').kills > 0 && row('garrison').spent > 0 && row('garrison').count === paint.count, `result table lists the garrisons (${row('garrison').kills} kills, $${row('garrison').spent})`);
  console.log('  kills by source:', JSON.stringify(result.killsBy));
}
console.log('combat_battle: all passed');
