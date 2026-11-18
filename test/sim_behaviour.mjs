// SIM behaviour scenarios on the hand-made grid map. Run: node test/sim_behaviour.mjs
import { World, TYPE, CS, ZSUB } from '../js/sim/world.js';
import { T } from '../js/map/format.js';
import { rectPoly } from '../js/util/geom.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const QUIET = ['loseBelowPct=0', 'zombie.touchRadius=0', 'civ.panicRadius=0', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0'];
const mk = (mutators = [], opts = {}) => new World(opts.map || makeTestMap({ size: 800, river: !!opts.river }), { seed: opts.seed || 11, stage: opts.stage ?? 2, mutators });
const run = (w, n) => { for (let k = 0; k < n && w.phase === 'battle'; k++) w.step(); };
const cellOf = (w, i) => Math.floor(w.A.y[i] / w.grid.cell) * w.grid.gw + Math.floor(w.A.x[i] / w.grid.cell);
const civsIn = (w, comp) => { let n = 0; for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.zoneId[cellOf(w, i)] === comp + 1) n++; return n; };
const gateOn = (w, comp, side = 'bottom') => {
  const [x0, y0, x1, y1] = w.zones.comps[comp].bbox.map((v) => v * w.grid.cell);
  const at = { bottom: [(x0 + x1) / 2, y1 + 2], top: [(x0 + x1) / 2, y0 + 2], left: [x0 + 2, (y0 + y1) / 2] }[side];
  return w.exec({ t: 'gate.add', x: at[0], y: at[1] });
};
const killAll = (w, type) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === type) w.remove(i); };

// ---------------------------------------------------------------- gates lure civilians; ungated zones stay closed
{
  const w = mk([...QUIET, 'civ.gateLureRadius=3000', 'civ.seekMaxPath=4000']);
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
  w.exec({ t: 'zone.add', p: blockRect(4, 4, 5, 5) });
  const gated = w.zones.comps.findIndex((c) => c.bbox[0] < 100);
  const closed = 1 - gated;
  assert(gateOn(w, gated).ok, 'gate on the first zone only');
  w.exec({ t: 'ready' });
  const a0 = civsIn(w, gated), b0 = civsIn(w, closed);
  run(w, 4000);
  const a1 = civsIn(w, gated), b1 = civsIn(w, closed);
  assert(a1 > a0 + 150, `civilians walk into the gated zone (${a0} -> ${a1})`);
  assert(b1 === b0, `nobody enters the zone without a gate (${b0} -> ${b1})`);
  let safe = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.SAFE) safe++;
  assert(safe <= a1 + b1 && safe >= a1 + b1 - 12 && Math.abs(w.stats.civSafe - safe) <= 12, `civilians inside zones are SAFE (${safe} of ${a1 + b1})`);
}

// ---------------------------------------------------------------- zombies besiege and breach walls
{
  const w = mk(['loseBelowPct=0', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'population.scale=0.1']);
  w.exec({ t: 'zone.add', p: blockRect(2, 2, 3, 3) });
  const comp = w.zones.comps[0];
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] !== CS.SAFE) w.remove(i);
  killAll(w, TYPE.ZOMBIE);
  for (let k = 0; k < 60; k++) w.spawn(TYPE.ZOMBIE, 200 + (k % 10) * 3, 140 + (k / 10 | 0) * 3);
  let deadAtBreach = -1, hitBefore = false;
  w.events.on('breach', () => { deadAtBreach = 0; for (const c of comp.wallCells) if (w.wallHp[c] <= 0) deadAtBreach++; });
  for (let k = 0; k < 4000 && !comp.breached; k++) {
    w.step();
    if (!hitBefore) for (const c of comp.wallCells) if (w.wallHp[c] < w.cfg.wall.hp) { hitBefore = true; break; }
  }
  assert(hitBefore, 'zombies attack the wall');
  assert(comp.breached && deadAtBreach > 0, `zone breached only through a destroyed wall cell (${deadAtBreach} down, t=${w.t.toFixed(1)} s)`);
  run(w, 200);
  let panicked = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.SAFE) panicked++;
  assert(panicked === 0, 'after a breach no civilian in that zone stays SAFE');
}

// ---------------------------------------------------------------- infection spreads, turning becomes zombie
{
  const w = mk(['outbreak.maxSites=2']);
  w.exec({ t: 'ready' });
  const z0 = w.counts[TYPE.ZOMBIE];
  let sawTurning = false;
  for (let k = 0; k < 600; k++) { w.step(); if (w.counts[TYPE.TURNING] > 0) sawTurning = true; }
  assert(sawTurning && w.stats.infected > 50, `infection spreads (${w.stats.infected} infected)`);
  assert(w.counts[TYPE.ZOMBIE] > z0 + 40, `infected civilians turn into zombies (${z0} -> ${w.counts[TYPE.ZOMBIE]})`);
  assert(w.stats.civDead === w.stats.civStart - w.stats.civAlive - w.stats.civEvac - w.stats.converted, 'civDead bookkeeping');
}

// ---------------------------------------------------------------- win and lose
{
  const w = mk(['outbreak.maxSites=1', 'outbreak.zombies=5', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0']);
  let ended = null;
  w.events.on('stageEnd', (e) => { ended = e.result; });
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.damageAgent(i, 1e6, 'test');
  w.step();
  assert(w.phase === 'won' && ended && ended.won, 'stage is won once every zombie is dead');
  assert(ended.pct > 95 && ended.badge === 'gold' && ended.killsBy.test === 5, `result: ${ended.pct.toFixed(1)}% saved, badge ${ended.badge}`);
  assert(ended.perType.some((r) => r.key === 'test' && r.kills === 5), 'result lists kills per source');
  w.step();
  assert(w.phase === 'won', 'step is a no-op after the stage ends');

  const l = mk(['loseBelowPct=90', 'outbreak.maxSites=6', 'outbreak.minSites=6'], { seed: 12 });
  l.exec({ t: 'ready' });
  run(l, 6000);
  assert(l.phase === 'lost' && l.result && !l.result.won && l.result.badge === null, `stage lost below the threshold (t=${l.t.toFixed(0)} s, ${l.result && l.result.pct.toFixed(1)}%)`);
}

// ---------------------------------------------------------------- armed humans shoot; police stations spawn officers
{
  const w = mk(['outbreak.maxSites=1', 'outbreak.zombies=40', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'population.scale=0.05']);
  w.exec({ t: 'ready' });
  let zx = 0, zy = 0, n = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) { zx += w.A.x[i]; zy += w.A.y[i]; n++; }
  zx /= n; zy /= n;
  for (let k = 0; k < 30; k++) {
    const i = w.spawn(TYPE.SOLDIER, zx + 40 + (k % 6) * 2, zy + (k / 6 | 0) * 2);
    w.A.state[i] = 1;
  }
  run(w, 400);
  assert((w.stats.killsBy.soldier || 0) > 10, `soldiers shoot zombies (${w.stats.killsBy.soldier || 0} kills)`);
  assert(w.projectiles.length >= 0 && w.stats.killed >= (w.stats.killsBy.soldier || 0), 'kills are counted');
}
{
  const m = makeTestMap({ size: 800 });
  const civic = m.buildings.findIndex((b) => b.k === 'civic');
  const w = mk(QUIET, { map: m });
  const b = w.buildings[civic];
  w.exec({ t: 'zone.add', p: rectPoly(b.cx - 35, b.cy - 35, b.cx + 35, b.cy + 35) });
  assert(w.exec({ t: 'func.set', b: civic, func: 'police' }).ok, 'police function set');
  w.exec({ t: 'ready' });
  run(w, 205);
  assert(w.counts[TYPE.POLICE] === 5, `police station spawns an officer every 2 s (${w.counts[TYPE.POLICE]} after 10 s)`);
  const r = w.exec({ t: 'stance.set', b: civic, stance: 'hold' });
  let held = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.POLICE && w.A.state[i] === 0 && w.A.group[i] === civic) held++;
  assert(r.ok && held === 5, 'stance toggle switches the whole station to hold');
}

// ---------------------------------------------------------------- militia on breach, broadcast lure
{
  const m = makeTestMap({ size: 800 });
  const civic = m.buildings.findIndex((b) => b.k === 'civic');
  const w = mk(['outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0'], { map: m });
  const b = w.buildings[civic];
  w.exec({ t: 'zone.add', p: rectPoly(b.cx - 60, b.cy - 60, b.cx + 60, b.cy + 60) });
  w.exec({ t: 'func.set', b: civic, func: 'militia' });
  w.exec({ t: 'ready' });
  const comp = w.zones.comps[b.zone];
  const ic = comp.interiorCells.find((c) => w.nav.pass[c] & 2);
  w.spawn(TYPE.ZOMBIE, (ic % w.grid.gw + 0.5) * 4, (((ic / w.grid.gw) | 0) + 0.5) * 4);
  run(w, 2);
  assert(comp.breached && w.stats.converted > 10 && w.counts[TYPE.MILITIA] === w.stats.converted, `breach raises militia (${w.stats.converted})`);
}
{
  const runLure = (func) => {
    const m = makeTestMap({ size: 800 });
    const civic = m.buildings.findIndex((b) => b.k === 'civic');
    const w = mk(QUIET, { map: m, seed: 21 });
    const b = w.buildings[civic];
    const bx = Math.floor((b.cx - 50) / 100), by = Math.floor((b.cy - 50) / 100);
    w.exec({ t: 'zone.add', p: blockRect(bx, by, bx, by) });
    assert(gateOn(w, 0, 'bottom').ok && b.zone === 0, 'zone with gate around the civic block');
    w.exec({ t: 'func.set', b: civic, func });
    w.exec({ t: 'ready' });
    const pathSum = () => {
      let sum = 0;
      for (let i = 0; i < w.A.n; i++) {
        if (w.A.type[i] !== TYPE.CIV) continue;
        const d = w.nav.civ.dist[cellOf(w, i)];
        if (d < 1e9) sum += d * w.grid.cell / 10;
      }
      return sum;
    };
    const p0 = pathSum();
    run(w, 1200);
    return (p0 - pathSum()) / 1000;
  };
  const withB = runLure('broadcast'), without = runLure('radio');
  assert(withB > without * 3 && withB > 20, `broadcast sends far civilians toward the gate (${withB.toFixed(0)} km walked vs ${without.toFixed(0)} km)`);
}

// ---------------------------------------------------------------- corridor and hold
{
  const w = mk(QUIET);
  w.exec({ t: 'corridor.add', x0: 80, y0: 350, x1: 230, y1: 350, w: 24 });
  for (let k = 0; k < 24; k++) w.spawn(TYPE.CIV, 90 + (k % 8) * 4, 344 + (k >> 3) * 5);
  w.exec({ t: 'ready' });
  run(w, 10);
  const caught = [];
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.CORRIDOR) caught.push([i, w.A.x[i]]);
  run(w, 2400);
  let moved = 0;
  for (const [i] of caught) if (w.A.x[i] > 205) moved++;
  assert(caught.length > 5 && moved >= caught.length * 0.8, `corridor carries civilians to its head (${moved}/${caught.length})`);
}
{
  const w = mk(QUIET);
  w.exec({ t: 'hold.add', x: 400, y: 350, R: 60 });
  const h = w.holds[0];
  for (let k = 0; k < 24; k++) w.spawn(TYPE.CIV, 350 + (k % 12) * 4, 346 + (k / 12 | 0) * 6);
  w.exec({ t: 'ready' });
  run(w, 10);
  const held = [];
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.HELD) held.push(i);
  run(w, 800);
  const inside = held.filter((i) => Math.hypot(w.A.x[i] - h.x, w.A.y[i] - h.y) <= h.r * 1.25).length;
  assert(held.length > 10 && inside >= held.length * 0.85, `hold gathers civilians into its inner circle (${inside}/${held.length})`);
  w.exec({ t: 'hold.remove', id: h.id });
  assert(held.every((i) => w.A.state[i] !== CS.HELD), 'removing the hold releases them');
}

// ---------------------------------------------------------------- structures: collapse, bridges, hazards, fire
{
  const w = mk(QUIET);
  w.exec({ t: 'ready' });
  const b = w.buildings.find((q) => q.h >= 20 && q.k === 'res' && q.cx > 200 && q.cx < 600 && q.cy > 200 && q.cy < 600);
  const victim = w.spawn(TYPE.CIV, b.cx + Math.sqrt(b.area) / 2 + 3, b.cy);
  const z = w.spawn(TYPE.ZOMBIE, b.cx + Math.sqrt(b.area) / 2 + 5, b.cy + 2);
  let ev = null;
  w.events.on('collapse', (e) => { ev = e; });
  w.step();
  w.damageBuilding(b.idx, b.hpMax + 1, 'test', 1, 0);
  const info = w.grid.bInfo[b.idx];
  assert(!b.alive && ev && ev.b === b.idx, 'building collapses at 0 HP');
  assert(info.cells.every((c) => w.grid.terrain[c] === T.RUBBLE), 'footprint becomes rubble');
  const strip = Math.floor(b.cy / 4) * w.grid.gw + Math.floor((b.cx + Math.sqrt(b.area) / 2 + 6) / 4);
  assert(w.grid.terrain[strip] === T.RUBBLE || w.grid.terrain[strip] === T.BLDG, 'topple strip in the fall direction is rubble');
  assert(w.A.type[victim] !== TYPE.CIV && w.A.type[z] !== TYPE.ZOMBIE && w.stats.killsBy.test >= 1, 'agents under the collapse are crushed');
  assert(w.nav.pass[info.cells[0]] & 16, 'rubble is walkable and slow');
}
{
  const w = mk(QUIET, { river: true });
  w.exec({ t: 'ready' });
  const br = w.bridges[2];
  const zs = [];
  for (let k = 0; k < 5; k++) zs.push(w.spawn(TYPE.ZOMBIE, br.cx, br.cy - 8 + k * 4));
  w.step();
  let down = false;
  w.events.on('bridgeDown', () => { down = true; });
  w.damageBridge(br.idx, br.hpMax * 0.4);
  assert(br.alive && br.hp > 0, 'bridge survives partial damage');
  w.damageBridge(br.idx, br.hpMax);
  const cells = w.grid.bridges[br.idx].cells;
  assert(down && !br.alive && cells.every((c) => w.grid.terrain[c] === T.WATER), 'bridge down: its cells become water');
  assert(zs.every((i) => w.A.type[i] !== TYPE.ZOMBIE) && (w.stats.killsBy.drown || 0) >= 5, 'agents on the bridge drown');
}
{
  const m = makeTestMap({ size: 800 });
  const hz = m.buildings.findIndex((b) => b.k === 'hazard');
  const w = mk(QUIET, { map: m });
  w.exec({ t: 'ready' });
  const before = w.buildings.map((b) => b.hp);
  let logged = false;
  w.events.on('log', (e) => { if (/HAZARD/.test(e.msg)) logged = true; });
  w.collapseBuilding(hz, 1, 0);
  const hurt = w.buildings.filter((b, k) => k !== hz && (b.hp < before[k] || !b.alive)).length;
  assert(logged && hurt >= 2, `hazard site explodes and damages neighbours (${hurt} buildings hit)`);
  let burning = 0;
  for (const f of w.fire) if (f > 0) burning++;
  assert(burning > 0, 'the blast starts a fire');
}
{
  const w = mk([...QUIET, 'fire.burnSec=6']);
  w.exec({ t: 'ready' });
  const b = w.buildings.find((q) => q.cx > 300 && q.cy > 300 && q.k === 'res');
  w.ignite(b.cx, b.cy, 10, 1);
  let peak = 0;
  for (let k = 0; k < 120; k++) { w.step(); let n = 0; for (const f of w.fire) if (f > 0) n++; if (n > peak) peak = n; }
  assert(peak > 6 && b.hp < b.hpMax, `fire spreads through the building and burns it (${peak} cells, hp ${b.hp.toFixed(0)}/${b.hpMax})`);
  run(w, 600);
  let left = 0;
  for (const f of w.fire) if (f > 0) left++;
  assert(left === 0, 'fire burns out');
}

// ---------------------------------------------------------------- mosh pit -> giant; explosive at walls; swimmers
{
  const w = mk([...QUIET, 'mutation.firstSec=2', 'mutation.pitSec=4', 'mutation.pitMin=8', 'mutation.kinds.explosive.weight=0',
    'mutation.kinds.shielded.weight=0', 'mutation.kinds.swimmer.weight=0', 'population.scale=0.02']);
  let pit = null, mut = null;
  w.events.on('pit', (e) => { pit = e; });
  w.events.on('mutation', (e) => { mut = e; });
  w.exec({ t: 'ready' });
  killAll(w, TYPE.CIV);
  for (let k = 0; k < 30; k++) w.spawn(TYPE.ZOMBIE, 300 + (k % 6) * 2, 352 + (k / 6 | 0) * 1.5);
  const before = w.counts[TYPE.ZOMBIE];
  run(w, 200);
  let giants = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE && w.A.sub[i] === ZSUB.GIANT) giants++;
  assert(pit && mut && mut.kind === 'giant' && giants === 1, 'a mosh pit ends in a giant');
  assert(w.counts[TYPE.ZOMBIE] === before - (w.cfg.mutation.kinds.giant.merge - 1), 'the giant merged its pit-mates');
  assert(Math.abs(w.zombieHp(ZSUB.GIANT) - w.zombieHp(0) * 9) < 1e-9, 'giant HP multiplier');
}
{
  const w = mk(['loseBelowPct=0', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'population.scale=0.1']);
  w.exec({ t: 'zone.add', p: blockRect(2, 2, 3, 3) });
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] !== CS.SAFE) w.remove(i);
  killAll(w, TYPE.ZOMBIE);
  const comp = w.zones.comps[0];
  const wc = comp.wallCells[Math.floor(comp.wallCells.length / 8)];
  const wx = (wc % w.grid.gw + 0.5) * 4, wy = (((wc / w.grid.gw) | 0) + 0.5) * 4;
  w.spawn(TYPE.ZOMBIE, wx, wy - 12, ZSUB.EXPLOSIVE);
  let boom = false;
  w.events.on('sound', (e) => { if (e.name === 'explosion') boom = true; });
  run(w, 300);
  let dmg = 0;
  for (const c of comp.wallCells) if (w.wallHp[c] < w.cfg.wall.hp) dmg++;
  assert(boom && dmg >= 3, `explosive mutant blows up at the wall (${dmg} wall cells damaged)`);
}
{
  const w = mk([...QUIET, 'zombie.touchRadius=3'], { river: true });
  w.exec({ t: 'ready' });
  for (const br of w.bridges) w.damageBridge(br.idx, 1e9);
  killAll(w, TYPE.CIV); killAll(w, TYPE.ZOMBIE);
  w.spawn(TYPE.CIV, 300, 300);
  const sw = w.spawn(TYPE.ZOMBIE, 300, 500, ZSUB.SWIMMER);
  const nz = w.spawn(TYPE.ZOMBIE, 320, 500);
  w.computeFields();
  run(w, 2000);
  assert(w.A.type[sw] === TYPE.ZOMBIE && w.A.y[sw] < 380, `swimmer crosses the river (y=${w.A.y[sw].toFixed(0)})`);
  assert(w.A.y[nz] > 410, 'an ordinary zombie stays on its bank');
}

// ---------------------------------------------------------------- softlock, airlift, medic, pickups
{
  const w = mk([...QUIET, 'zombie.softlockSec=5'], { river: true });
  w.exec({ t: 'ready' });
  for (const br of w.bridges) w.damageBridge(br.idx, 1e9);
  killAll(w, TYPE.ZOMBIE);
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.y[i] > 400) w.remove(i);
  for (let k = 0; k < 10; k++) w.spawn(TYPE.ZOMBIE, 300 + k * 3, 600);
  w.computeFields();
  run(w, 400);
  assert(w.phase === 'won' && w.result.softlock && w.counts[TYPE.ZOMBIE] === 0, 'softlock: unreachable zombies end the stage as a win');
}
{
  const m = makeTestMap({ size: 800 });
  const rescue = m.buildings.findIndex((b) => b.k === 'rescue');
  const w = mk(QUIET, { map: m });
  const b = w.buildings[rescue];
  w.exec({ t: 'zone.add', p: rectPoly(b.cx - 60, b.cy - 60, b.cx + 60, b.cy + 60) });
  w.exec({ t: 'func.set', b: rescue, func: 'airlift' });
  w.exec({ t: 'ready' });
  run(w, 420);
  assert(w.stats.civEvac >= 5, `airlift evacuates civilians from the zone (${w.stats.civEvac})`);
  w.exec({ t: 'func.set', b: rescue, func: 'medic' });
  let target = -1;
  for (let i = 0; i < w.A.n && target < 0; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.SAFE && Math.hypot(w.A.x[i] - b.cx, w.A.y[i] - b.cy) < 60) target = i;
  w.infect(target);
  w.A.timer[target] = 30;
  run(w, 25);
  assert(w.A.type[target] === TYPE.CIV && w.stats.cured === 1, 'medic cures a turning civilian inside the zone');
}
{
  const w = mk(QUIET);
  w.exec({ t: 'ready' });
  w.addPickup('bus1', 400, 350, 12);
  run(w, 900);
  let boarding = 0;
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && w.A.state[i] === CS.BOARDING && Math.hypot(w.A.x[i] - 400, w.A.y[i] - 350) < 20) boarding++;
  assert(boarding > 20, `civilians gather at a rescue pickup (${boarding})`);
  let ev = 0;
  w.query(400, 350, 20, 1 << TYPE.CIV, (i) => { if (w.evacuate(i)) ev++; });
  assert(ev === boarding || ev >= boarding, 'evacuate() removes them and counts them saved');
  assert(w.stats.civEvac === ev, 'evacuated civilians are counted');
  w.removePickup('bus1');
}

console.log(process.exitCode ? 'sim_behaviour: FAILED' : 'sim_behaviour: all passed');
