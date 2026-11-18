// Naval units: placement per water size, sailing on water and under bridges, patrol fire, swimmer damage, ferry rescues,
// water mines, orders, persistence and determinism. Run: node test/naval.mjs
import { World, TYPE, ZSUB } from '../js/sim/world.js';
import { T } from '../js/map/format.js';
import { rectPoly } from '../js/util/geom.js';
import { installCombat, unitBlocked, boatStatus, ferryDest } from '../js/sim/units.js';
import { navalGrid, STRANDED } from '../js/sim/naval.js';
import { spawnArmour } from '../js/sim/vehicles.js';
import { selectables } from '../js/sim/orders.js';
import { makeTestMap, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });   // river y 386..414 across the map, a bridge every 100 m (x = 50, 150, ...)
const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.03', 'mutation.firstSec=100000'];
const dt = 0.05;
const mk = (mut = [], o = {}) => installCombat(new World(o.map || map, { seed: o.seed || 21, stage: o.stage ?? 2, mutators: [...QUIET, ...mut], sandbox: o.sandbox ?? true }));
const run = (w, sec, each) => { const n = Math.round(sec / dt); for (let k = 0; k < n && w.phase === 'battle'; k++) { w.step(); if (each) each(w); } };
const killKind = (w, type) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === type) w.remove(i); };
const go = (w) => { w.exec({ t: 'ready' }); killKind(w, TYPE.ZOMBIE); const z = w.spawn(TYPE.ZOMBIE, 26, 774); w.A.stun[z] = 1e9; return z; };
const place = (w, type, x, y) => w.exec({ t: 'unit.place', type, x, y });
const boatOf = (w, r) => w.vehicles.find((v) => v.boat && v.uid === r.id);
const wetAt = (w, x, y) => { const t = w.grid.terrain[w.cellAt(x, y)]; return t === T.WATER || t === T.BRIDGE; };
const logs = (w) => { const out = []; w.events.on('log', (e) => out.push(e.msg)); return out; };
const pile = (w, x, y, n, r = 3, sub = 0) => { const out = []; for (let k = 0; k < n; k++) { const a = k * 2.4, d = r * Math.sqrt((k + 0.5) / n); const i = w.spawn(TYPE.ZOMBIE, x + Math.cos(a) * d, y + Math.sin(a) * d, sub); out.push(i); } return out; };

// ---------------------------------------------------------------- placement validity per water size
{
  const areas = [0, 1, 2].map((st) => { const w = mk([], { stage: st }); const N = navalGrid(w); return N.maxArea; });
  console.log('  river area inside each stage (m²):', areas.join(', '));
  const at = (st, type, x = 400, y = 400) => { const w = mk([], { stage: st }); return w.quote({ t: 'unit.place', type, x, y }); };
  assert(areas[0] >= 3000 && areas[0] < 8000 && areas[1] >= 8000 && areas[1] < 15000 && areas[2] >= 15000, 'stage water areas straddle the boat minimums');
  assert(at(0, 'patrolBoat').ok && at(0, 'ferry').ok, 'patrol boat and ferry fit the stage 1 river');
  const g0 = at(0, 'gunboat');
  assert(!g0.ok && g0.reason === 'No water big enough here' && unitBlocked(mk([], { stage: 0 }), 'gunboat') === g0.reason, `gunboat refused on the stage 1 stretch: "${g0.reason}"`);
  const pm = makeTestMap({ size: 800, river: true });
  pm.water.push({ p: rectPoly(8, 8, 44, 44) });
  const pw = mk([], { map: pm }), pq = pw.quote({ t: 'unit.place', type: 'patrolBoat', x: 26, y: 26 });
  assert(!pq.ok && /at least 3,000 m²/.test(pq.reason) && pq.comp > 0, `a pond next to a big river: "${pq.reason}"`);
  assert(at(1, 'gunboat').ok && !at(1, 'rocketBarge').ok && at(2, 'rocketBarge').ok, 'gunboat fits stage 2, rocket barge only the whole river');
  const land = at(2, 'patrolBoat', 400, 300), bridge = at(2, 'patrolBoat', 450, 400);
  assert(!land.ok && land.reason === 'Place it on open water' && !bridge.ok && bridge.reason === 'Place it on open water', 'boats go on open water, not land or a bridge deck');
  const w = mk();
  assert(place(w, 'patrolBoat', 300, 400).ok, 'first patrol boat placed');
  const near = w.quote({ t: 'unit.place', type: 'patrolBoat', x: 306, y: 400 });
  assert(!near.ok && near.reason === 'Too close to another boat', 'boats keep a little apart');
  const dry = installCombat(new World(makeTestMap({ size: 600, river: false }), { seed: 3, stage: 2, mutators: QUIET, sandbox: true }));
  const q = dry.quote({ t: 'unit.place', type: 'gunboat', x: 300, y: 300 });
  assert(unitBlocked(dry, 'patrolBoat') === 'No water big enough here' && q.reason === 'No water big enough here' && unitBlocked(dry, 'waterMine'),
    `a map without water says so: "${unitBlocked(dry, 'patrolBoat')}" / "${unitBlocked(dry, 'waterMine')}"`);
  assert(unitBlocked(w, 'patrolBoat') === '' && unitBlocked(w, 'garrison') === '', 'nothing blocked on the river map');
  const mines = w.exec({ t: 'unit.paint', type: 'waterMine', path: [500, 400, 540, 400] });
  const landMine = w.quote({ t: 'unit.paint', type: 'waterMine', cells: [w.cellAt(500, 300)] });
  assert(mines.ok && mines.count >= 8 && !landMine.ok && landMine.reason === 'Water mines go on open water', `water mines paint on water only (${mines.count} cells)`);
  const b = boatOf(w, w.units.find((u) => u.type === 'patrolBoat'));
  assert(b && b.commandable === true && b.owner === 0 && b.selR >= 8 && b.hp === b.hpMax && b.hpMax === 700, 'each boat is a commandable vehicle with a hull');
  const spent = w.budget.spent, r = w.exec({ t: 'unit.refund', id: b.uid });
  assert(r.ok && w.budget.spent < spent && !w.vehicles.some((v) => v.boat && v.uid === b.uid), 'planning refund returns the money and removes the boat');
}

// ---------------------------------------------------------------- two minutes of battle: every boat stays on water; patrols move
{
  const w = mk(['outbreak.zombies=60', 'outbreak.maxSites=2']);
  const ids = [['patrolBoat', 120, 400], ['gunboat', 300, 400], ['rocketBarge', 520, 400], ['ferry', 680, 400], ['patrolBoat', 740, 402]].map(([t, x, y]) => place(w, t, x, y).id);
  w.exec({ t: 'ready' });
  const boats = ids.map((id) => w.vehicles.find((v) => v.uid === id));
  let off = 0, under = 0, travelled = 0;
  const last = boats.map((v) => [v.x, v.y]);
  run(w, 120, () => {
    boats.forEach((v, k) => {
      if (!v.alive) return;
      if (!wetAt(w, v.x, v.y)) off++;
      if (w.grid.terrain[w.cellAt(v.x, v.y)] === T.BRIDGE) under++;
      travelled += Math.hypot(v.x - last[k][0], v.y - last[k][1]); last[k] = [v.x, v.y];
      const u = v.unit;
      if (u.x !== v.x || u.y !== v.y) off += 1000;
    });
  });
  assert(off === 0, `120 s of battle: every boat stayed on water and its unit followed it (${w.t.toFixed(0)} s)`);
  assert(travelled > 400, `the boats got under way (${travelled.toFixed(0)} m in all, ${under} ticks under bridges)`);
}

// ---------------------------------------------------------------- under-bridge passage with a move order; return to the mooring
{
  const w = mk();
  const id = place(w, 'patrolBoat', 110, 400).id;
  go(w);
  const v = w.vehicles.find((q) => q.uid === id);
  v.order = { kind: 'move', x: 690, y: 400, t: w.t, done: false };
  const bridges = new Set();
  let at = -1;
  run(w, 120, () => {
    const c = w.cellAt(v.x, v.y);
    if (w.grid.terrain[c] === T.BRIDGE) bridges.add(w.grid.bridgeId[c]);
    if (at < 0 && v.order.done) at = w.t;
  });
  assert(at > 0 && Math.hypot(v.x - 690, v.y - 400) < 6, `move: sailed 580 m along the river and stopped (${at.toFixed(1)} s)`);
  assert(bridges.size >= 5, `passed under ${bridges.size} bridges on the way`);
  const hx = v.x, hy = v.y;
  run(w, 5);
  assert(Math.hypot(v.x - hx, v.y - hy) < 0.01, 'a finished move holds its spot');
  v.order = { kind: 'return', t: w.t, done: false };
  let back = null;
  const t0 = w.t;
  run(w, 120, () => { if (v.order.done && !back) back = [v.x, v.y, w.t - t0]; });
  const u = v.unit;
  assert(back && Math.hypot(back[0] - u.hx, back[1] - u.hy) < 4, `return: back at its mooring after ${back && back[2].toFixed(1)} s`);
  assert(Math.hypot(v.x - u.hx, v.y - u.hy) > 1 && Math.hypot(v.x - u.hx, v.y - u.hy) < 150, 'after returning it patrols near its mooring again');
  v.order = { kind: 'move', x: 400, y: 120, t: w.t, done: false };
  run(w, 90);
  assert(v.order.done && wetAt(w, v.x, v.y) && Math.abs(v.x - 400) < 12 && v.y < 400, `an order onto land ends at the nearest water (${v.x.toFixed(0)}, ${v.y.toFixed(0)})`);
}

// ---------------------------------------------------------------- patrol fire: shore zombies and swimmers; hold keeps firing
{
  const w = mk(['zombie.speed=0', 'zombie.touchRadius=0']);
  const id = place(w, 'patrolBoat', 400, 400).id;
  go(w);
  const v = w.vehicles.find((q) => q.uid === id);
  const shore = pile(w, 430, 372, 6, 4), swim = pile(w, 360, 402, 3, 2, ZSUB.SWIMMER);
  run(w, 8);
  assert(v.kills === 0, 'weapons hold until the outside-zone start delay');
  run(w, 40);
  const shoreDead = shore.filter((i) => w.A.type[i] !== TYPE.ZOMBIE).length, swimDead = swim.filter((i) => w.A.type[i] !== TYPE.ZOMBIE).length;
  assert(shoreDead === 6 && swimDead === 3 && (w.stats.killsBy.patrolBoat || 0) === 9 && v.unit.kills === 9,
    `patrol boat cleared ${shoreDead} on the shore and ${swimDead} swimmers (${v.shots} rounds)`);
  v.order = { kind: 'hold', t: w.t, done: false };
  const hx = v.x, hy = v.y;
  pile(w, v.x + 20, 372, 4, 3);
  const k0 = v.kills;
  run(w, 15);
  assert(v.order.done && Math.hypot(v.x - hx, v.y - hy) < 0.01 && v.kills > k0, `hold: stays put and still shoots (${v.kills - k0} more kills)`);
}

// ---------------------------------------------------------------- hunt
{
  const w = mk(['zombie.speed=0', 'zombie.touchRadius=0', 'zombie.hpStart=1e6', 'zombie.hpMax=1e6', 'zombie.hpGraceSec=1e6']);
  const id = place(w, 'gunboat', 100, 400).id;
  go(w);
  killKind(w, TYPE.ZOMBIE);
  const v = w.vehicles.find((q) => q.uid === id);
  pile(w, 700, 372, 5, 3);
  run(w, 14);
  const d0 = Math.hypot(v.x - 700, v.y - 372);
  v.order = { kind: 'hunt', t: w.t, done: false };
  let shotAt = -1;
  run(w, 150, () => { if (shotAt < 0 && v.shots > 0) shotAt = w.t; });
  const d1 = Math.hypot(v.x - 700, v.y - 372);
  assert(d0 > 500 && d1 < v._s.range && shotAt > 0, `hunt: closed from ${d0.toFixed(0)} m to ${d1.toFixed(0)} m and opened fire`);
}

// ---------------------------------------------------------------- swimmers tear at hulls; a sunk boat is gone for good
{
  const w = mk(['zombie.speed=0', 'units.patrolBoat.dmg=0'], { stage: 1 });
  const id = place(w, 'patrolBoat', 400, 400).id, keep = place(w, 'ferry', 600, 400).id;
  const said = logs(w);
  go(w);
  const v = w.vehicles.find((q) => q.uid === id);
  pile(w, v.x, v.y + 1, 2, 1.5, ZSUB.SWIMMER);
  pile(w, v.x, 372, 4, 2);
  run(w, 4);
  const hp1 = v.hp;
  assert(hp1 < v.hpMax && hp1 > 0, `two swimmers at the hull: ${Math.round(v.hpMax - hp1)} damage in 4 s; zombies on the quay do none`);
  pile(w, v.x, v.y, 8, 3, ZSUB.SWIMMER);
  run(w, 10);
  assert(!v.alive && !v.unit.alive && !w.vehicles.includes(v) && said.some((m) => /PATROL BOAT LOST/.test(m)), 'overrun by swimmers: sunk, unit lost, logged');
  w.beginStage(2);
  assert(!w.units.some((u) => u.id === id) && w.vehicles.some((q) => q.uid === keep && q.alive && q.hp === q.hpMax), 'next stage: the sunk boat stays gone, the ferry is back at full hull');
}

// ---------------------------------------------------------------- water mines go off under swimmers, not under the quay
{
  const w = mk(['zombie.speed=0', 'zombie.touchRadius=0']);
  w.exec({ t: 'unit.paint', type: 'waterMine', path: [300, 400, 330, 400] });
  w.exec({ t: 'unit.paint', type: 'waterMine', cells: [w.cellAt(500, 390)] });
  const edge = w.units.find((u) => u.type === 'waterMine' && Math.abs(u.x - 502) < 3 && Math.abs(u.y - 390) < 3);
  go(w);
  w.spawn(TYPE.ZOMBIE, 315, 400, ZSUB.SWIMMER);
  w.spawn(TYPE.ZOMBIE, 502, 385);
  run(w, 0.5);
  const gone = w.units.filter((u) => u.type === 'waterMine' && !u.alive).length;
  assert(gone >= 1 && (w.stats.killsBy.waterMine || 0) === 1 && w.effects.some((e) => e.kind === 'splash'), `water mine: a swimmer set off ${gone}, killed it`);
  assert(edge && edge.alive, 'a zombie on the quay beside a water mine does not set it off');
}

// ---------------------------------------------------------------- ferry: rescues counted like the bus; out by water or to a zone on the shore
for (const withZone of [false, true]) {
  const w = mk(['civ.panicRadius=0']);
  if (withZone) assert(w.exec({ t: 'zone.add', p: [600, 352, 700, 352, 700, 394, 600, 394] }).ok, 'a safe zone reaching into the river');
  const id = place(w, 'ferry', 420, 400).id;
  const v0 = w.vehicles.find((q) => q.uid === id);
  const d0 = ferryDest(w, v0);
  assert(d0 && d0.kind === (withZone ? 'dock' : 'exit'), `ferry destination: ${d0 && d0.kind}`);
  const said = logs(w);
  go(w);
  killKind(w, TYPE.CIV);
  for (let k = 0; k < 45; k++) { const i = w.spawn(TYPE.CIV, 280 + (k % 9) * 2.5, 366 + ((k / 9) | 0) * 3.5); w.A.panic[i] = 0; }
  const e0 = w.stats.civEvac;
  run(w, 120);
  const v = w.vehicles.find((q) => q.uid === id);
  const saved = w.stats.civEvac - e0;
  console.log(`  ferry (${withZone ? 'zone dock' : 'out by river'}): ${saved} evacuated, state ${v.state}, aboard ${v.loaded}`);
  assert(saved >= 40 && v.saved === saved && said.some((m) => (withZone ? /TO A SAFE ZONE/ : /BY WATER/).test(m)),
    `ferry ${withZone ? 'landed' : 'carried'} residents ${withZone ? 'at the zone' : 'off by water'}: ${saved} counted as evacuated`);
}
{
  const m = makeTestMap({ size: 800, river: false, seed: 77 });
  m.water.push({ p: rectPoly(357, 357, 443, 443) });
  m.buildings = m.buildings.filter((b) => !(b.p[0] > 350 && b.p[0] < 450 && b.p[1] > 350 && b.p[1] < 450));
  const w = mk(['civ.panicRadius=0'], { map: m, seed: 4 });
  const r = place(w, 'ferry', 400, 400);
  const v = w.vehicles.find((q) => q.uid === r.id);
  assert(r.ok && v && boatStatus(w, v) === STRANDED, `a pond with no zone on it: "${v && boatStatus(w, v)}"`);
  go(w);
  for (let k = 0; k < 20; k++) w.spawn(TYPE.CIV, 380 + k, 447);
  run(w, 30);
  assert(w.stats.civEvac === 0 && v.note === STRANDED, 'the stranded ferry boards nobody and says why');
}

// ---------------------------------------------------------------- upgrades, persistence across stages
{
  const w = mk([], { stage: 0 });
  const r = place(w, 'patrolBoat', 400, 400);
  for (let k = 0; k < 3; k++) assert(w.exec({ t: 'unit.upgrade', id: r.id }).ok, `upgrade ${k + 2}`);
  const v = boatOf(w, r);
  assert(v.hpMax === 1050 && v.hp === 1050, `hull upgrade reaches the vehicle (${v.hpMax})`);
  go(w);
  run(w, 30);
  const moved = Math.hypot(v.x - 400, v.y - 402);
  w.stats.zombies = 0;
  killKind(w, TYPE.ZOMBIE);
  w.step();
  assert(w.phase === 'won', 'stage won');
  w.beginStage(1);
  const v2 = boatOf(w, r), u = w.units.find((q) => q.id === r.id);
  assert(v2 && v2.alive && u.level === 4 && Math.hypot(v2.x - u.hx, v2.y - u.hy) < 0.01 && u.x === u.hx && v2.hp === v2.hpMax,
    `next stage: the boat is back at its mooring, level kept (had wandered ${moved.toFixed(0)} m)`);
}

// ---------------------------------------------------------------- through the real 'order' command (js/sim/orders.js)
{
  const w = mk(['abilities.paratroopers.unlock=0', 'abilities.paratroopers.delay=0']);
  const id = place(w, 'patrolBoat', 200, 400).id;
  w.exec({ t: 'loadout.set', abilities: { paratroopers: 1 } });
  go(w);
  const v = w.vehicles.find((q) => q.uid === id);
  const sel = selectables(w, 0).find((e) => e.id === v.id);
  assert(sel && sel.label === 'Patrol Boat' && sel.r === v.selR, `the boat is selectable as "${sel && sel.label}"`);
  const r = w.exec({ t: 'order', kind: 'move', refs: ['v' + v.id], x: 600, y: 330 });
  run(w, 70);
  assert(r.ok && v.order.kind === 'move' && v.order.done && Math.abs(v.x - 600) < 6 && wetAt(w, v.x, v.y), `order command: move ends on the water nearest the click (${v.x.toFixed(0)}, ${v.y.toFixed(0)})`);
  // no safe zone at all: boats and armour still go back, squads in the same selection stay put
  const a = spawnArmour(w, 'tank', w.cfg.abilities.tank, 250, 300, 0);
  const sq = w.exec({ t: 'ability.use', id: 'paratroopers', x: 250, y: 250 }).ok && w.combat.squads[0];
  const rb = w.exec({ t: 'order', kind: 'return', refs: ['v' + v.id, 'v' + a.id] });
  assert(rb.ok && v.order.kind === 'return' && v.order.x === v.unit.hx && a.order.x === 250 && a.order.y === 300, 'return without a zone: the boat heads for its mooring, armour for its drop point');
  const rm = sq ? w.exec({ t: 'order', kind: 'return', refs: ['s' + sq.group, 'v' + v.id] }) : null;
  const rs = sq ? w.exec({ t: 'order', kind: 'return', refs: ['s' + sq.group] }) : null;
  assert(sq && rm.ok && rm.vehicles === 1 && rm.squads === 0 && !rs.ok, `a squad still needs a zone, but a mixed selection sends the boat back (${rs && rs.reason})`);
}

// ---------------------------------------------------------------- armour takes the same orders
{
  const w = mk();
  go(w);
  const a = spawnArmour(w, 'apc', w.cfg.abilities.apc, 250, 250, 0);
  assert(a.commandable === true && a.selR > 0, 'APC is commandable');
  a.order = { kind: 'move', x: 450, y: 250, t: w.t, done: false };
  run(w, 60);
  assert(a.order.done && Math.hypot(a.x - 450, a.y - 250) < 8, `APC move order (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`);
  a.order = { kind: 'return', t: w.t, done: false };
  run(w, 60);
  assert(a.order.done && Math.hypot(a.x - 250, a.y - 250) < 8, 'APC return order');
}

// ---------------------------------------------------------------- snapshot mid-battle: retry replays exactly; determinism
const fleet = (w) => {
  w.exec({ t: 'zone.add', p: [600, 352, 700, 352, 700, 394, 600, 394] });
  w.exec({ t: 'gate.add', x: 650, y: 352 });
  for (const [t, x, y] of [['patrolBoat', 120, 400], ['gunboat', 300, 400], ['rocketBarge', 480, 400], ['ferry', 560, 400]]) w.exec({ t: 'unit.place', type: t, x, y });
  w.exec({ t: 'unit.paint', type: 'waterMine', path: [200, 400, 240, 400] });
  return w;
};
const OUT = ['outbreak.zombies=90', 'outbreak.maxSites=2', 'population.scale=0.15', 'mutation.firstSec=20', 'mutation.intervalSec=[20,30]', 'mutation.kinds.swimmer.weight=8'];
{
  const w = fleet(mk(OUT));
  w.exec({ t: 'ready' });
  run(w, 30);
  const pb = w.vehicles.find((v) => v.kind === 'patrolBoat');
  pb.order = { kind: 'move', x: 700, y: 400, t: w.t, done: false };
  run(w, 5);
  const snap = w.snapshot();
  assert(snap.ser.naval.length === 1 && snap.ser.naval[0][1].kind === 'move', 'the snapshot carries the boat order');
  run(w, 20);
  w.restore(snap);
  assert(w.phase === 'planning' && w.vehicles.filter((v) => v.boat).length === 4 && w.vehicles.find((v) => v.kind === 'patrolBoat').order.kind === 'move',
    'restore: back to planning with the boats moored and the order kept');
  assert(JSON.stringify(w.snapshot()) === JSON.stringify(snap), 'snapshot after restore is identical');
  w.exec({ t: 'ready' });
  const hA = [];
  run(w, 90, (ww) => { if (ww.tick % 300 === 0) hA.push(ww.hash()); });
  const f = fleet(mk(OUT));
  f.vehicles.find((v) => v.kind === 'patrolBoat').order = { kind: 'move', x: 700, y: 400, t: 0, done: false };
  f.exec({ t: 'ready' });
  const hB = [];
  run(f, 90, (ww) => { if (ww.tick % 300 === 0) hB.push(ww.hash()); });
  assert(hA.length >= 5 && hA.join() === hB.join(), `restored mid-battle snapshot replays exactly like a fresh world (${hA.length} hashes, last ${hA[hA.length - 1]})`);
}
{
  const script = (seed) => {
    const w = fleet(mk(OUT, { seed }));
    w.exec({ t: 'ready' });
    const hs = [];
    for (let k = 1; k <= 2400 && w.phase === 'battle'; k++) {
      if (k === 400) { const v = w.vehicles.find((q) => q.kind === 'gunboat'); v.order = { kind: 'hunt', t: w.t, done: false }; }
      if (k === 700) { const v = w.vehicles.find((q) => q.kind === 'patrolBoat'); v.order = { kind: 'move', x: 650, y: 405, t: w.t, done: false }; }
      if (k === 900) w.exec({ t: 'unit.place', type: 'patrolBoat', x: 380, y: 404 });
      if (k === 1500) { const v = w.vehicles.find((q) => q.kind === 'patrolBoat'); v.order = { kind: 'return', t: w.t, done: false }; }
      w.step();
      if (k % 400 === 0) hs.push(w.hash());
    }
    const kills = Object.entries(w.stats.killsBy).filter(([k]) => /Boat|boat|Barge|Mine/.test(k));
    return { hs: hs.join(), kills, evac: w.stats.civEvac, mut: w.stats.mutants };
  };
  const a = script(41), b = script(41), c = script(42);
  console.log('  boat kills:', JSON.stringify(a.kills), 'ferry evacuated', a.evac);
  assert(a.hs === b.hs, 'same seed and commands give the same hashes with boats, orders, mines and a ferry');
  assert(a.hs !== c.hs, 'a different seed diverges');
}

console.log(process.exitCode ? 'naval: FAILED' : 'naval: all passed');
