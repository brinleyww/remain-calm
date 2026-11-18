// Troop orders: selectables per owner, group moves through gates, walls, hold / hunt / back to zone, co-op owner
// checks, vehicles, hashing, restore and determinism. Run: node test/orders.mjs
import { World, TYPE } from '../js/sim/world.js';
import { installCombat } from '../js/sim/units.js';
import { selectables } from '../js/sim/orders.js';
import { LockstepDriver, makeLoopbackPair } from '../js/net/coop.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });
const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.05', 'mutation.firstSec=100000',
  'abilities.paratroopers.unlock=0', 'abilities.paratroopers.delay=0', 'abilities.callToArms.unlock=0'];
const run = (w, n, each) => { for (let k = 0; k < n && w.phase === 'battle'; k++) { w.step(); if (each) each(k); } };
const members = (w, g) => { const o = []; for (let i = 0; i < w.A.n; i++) if (w.A.type[i] >= TYPE.POLICE && w.A.group[i] === g) o.push(i); return o; };
const centroid = (w, m) => { let x = 0, y = 0; for (const i of m) { x += w.A.x[i]; y += w.A.y[i]; } return [x / m.length, y / m.length]; };
const zoneAt = (w, i) => w.zoneId[w.cellAt(w.A.x[i], w.A.y[i])];
const marching = (w) => { let n = 0; for (let i = 0; i < w.A.n; i++) if (w.A.type[i] >= TYPE.POLICE && w.A.pc[i] >= 0 && w.orders.recs.has(w.A.pc[i])) n++; return n; };

// Zone A covers blocks 1..2 (x, y 152..344) with its only gate in the west wall at y = 250.
function battle({ owners = 1, setup = null, seed = 9 } = {}) {
  const w = installCombat(new World(map, { seed, stage: 2, mutators: QUIET, sandbox: true, owners }));
  w.exec({ t: 'loadout.set', abilities: { paratroopers: 6, callToArms: 2 } });
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
  const [x0] = w.zones.comps[0].bbox.map((v) => v * w.grid.cell);
  const gate = w.exec({ t: 'gate.add', x: x0 + 2, y: 250 });
  if (setup) setup(w);
  for (let o = 0; o < owners; o++) w.exec({ t: 'ready', owner: o });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.remove(i);
  const z = w.spawn(TYPE.ZOMBIE, 26, 774);
  w.A.stun[z] = 1e9;
  w.step();
  w.gate = w.zones.gates.find((g) => g.id === gate.id);
  return w;
}
function drop(w, x, y, owner = 0) {
  const n0 = w.combat.squads.length;
  const r = w.exec({ t: 'ability.use', id: 'paratroopers', x, y, owner });
  assert(r.ok && w.combat.squads.length === n0 + 1, `paratroopers land at ${x},${y}`);
  return w.combat.squads[w.combat.squads.length - 1].group;
}

// ---------------------------------------------------------------- selectables per owner
{
  const w = battle({ owners: 2 });
  const g0 = drop(w, 250, 250, 0), g1 = drop(w, 450, 650, 1);
  const s0 = selectables(w, 0), s1 = selectables(w, 1);
  assert(s0.length === 1 && s0[0].ref === 's' + g0 && s0[0].kind === 'paratroopers' && s0[0].label === 'Paratroopers' && s0[0].n === members(w, g0).length, 'owner 0 sees only its own squad');
  assert(s1.length === 1 && s1[0].ref === 's' + g1 && Math.hypot(s1[0].x - 450, s1[0].y - 650) < 20, 'owner 1 sees only its own squad, with its centroid');
  const r = w.exec({ t: 'order', refs: ['s' + g1], kind: 'hold', owner: 0 });
  assert(!r.ok && /partner/.test(r.reason), `an order for a partner's squad is refused (${r.reason})`);
  assert(!w.exec({ t: 'order', refs: ['s' + g0, 's' + g1], kind: 'move', x: 250, y: 600, owner: 0 }).ok, 'a mixed order with a partner squad is refused');
  assert(!w.exec({ t: 'squad.mode', group: g1, mode: 'guard', owner: 0 }).ok, "squad.mode refuses a partner's squad too");
  assert(w.exec({ t: 'order', refs: ['s' + g1], kind: 'move', x: 450, y: 560, owner: 1 }).ok && w.orders.byGroup.has(g1), 'the owner can order it');
}

// ---------------------------------------------------------------- move 300 m out through the gate
{
  const w = battle();
  const g = drop(w, 250, 250);
  const m = members(w, g);
  assert(m.every((i) => zoneAt(w, i) === 1), `the squad (${m.length}) starts inside zone A`);
  const tx = 150, ty = 520;
  assert(Math.hypot(tx - 250, ty - 250) > 280, 'target is about 300 m away');
  const r = w.exec({ t: 'order', refs: ['s' + g], kind: 'move', x: tx, y: ty });
  const rec = w.orders.byGroup.get(g);
  assert(r.ok && r.squads === 1 && rec && rec.field, 'move order accepted and its field built at once');
  const was = m.map((i) => zoneAt(w, i));
  let badExit = 0, arrived = -1, k0 = w.tick;
  run(w, 4000, () => {
    m.forEach((i, k) => {
      const z = zoneAt(w, i);
      if (was[k] === 1 && z !== 1 && Math.hypot(w.A.x[i] - w.gate.x, w.A.y[i] - w.gate.y) > 14) badExit++;
      was[k] = z;
    });
    if (arrived < 0 && !w.orders.byGroup.has(g)) arrived = w.tick - k0;
  });
  const [cx, cy] = centroid(w, m), far = Math.max(...m.map((i) => Math.hypot(w.A.x[i] - rec.dx, w.A.y[i] - rec.dy)));
  assert(badExit === 0, 'every member left the zone through the gate');
  assert(arrived > 0 && arrived * w.cfg.sim.dt < 230, `the order finished in ${(arrived * w.cfg.sim.dt).toFixed(0)} s (path about 400 m)`);
  assert(Math.hypot(cx - tx, cy - ty) < 6 && far < 14, `squad stands at the point (centroid ${Math.hypot(cx - tx, cy - ty).toFixed(1)} m off, farthest ${far.toFixed(1)} m)`);
  assert(m.every((i) => w.A.type[i] === TYPE.SOLDIER && w.A.state[i] === 0 && Math.hypot(w.A.x[i] - w.A.home[2 * i], w.A.y[i] - w.A.home[2 * i + 1]) < 4.5), 'nobody is stuck: all guard their own formation slot');
}

// ---------------------------------------------------------------- walls: a gateless zone cannot be entered
{
  let compB = -1;
  const w = battle({ setup: (ww) => { ww.exec({ t: 'zone.add', p: blockRect(4, 5, 4, 5) }); compB = ww.zones.comps.length - 1; } });
  const [bx0, by0, bx1, by1] = w.zones.comps[compB].bbox.map((v) => v * w.grid.cell);
  const bx = (bx0 + bx1) / 2, by = (by0 + by1) / 2;
  const g = drop(w, 450, 450);
  const m = members(w, g);
  assert(w.exec({ t: 'order', refs: ['s' + g], kind: 'move', x: bx, y: by }).ok, 'order into the gateless zone accepted');
  let inside = 0;
  run(w, 2500, () => { for (const i of m) if (zoneAt(w, i) === compB + 1) inside++; });
  const [cx, cy] = centroid(w, m);
  assert(inside === 0, 'nobody ever stood inside the walled zone');
  assert(!w.orders.byGroup.has(g) && Math.hypot(cx - bx, cy - by) < Math.hypot(450 - bx, 450 - by) - 10, `they went to the nearest reachable ground instead (${Math.hypot(cx - bx, cy - by).toFixed(0)} m from the target)`);
}

// ---------------------------------------------------------------- hold, hunt, back to zone
{
  const w = battle();
  const g = drop(w, 450, 250), m = members(w, g);
  for (let k = 0; k < 6; k++) { const z = w.spawn(TYPE.ZOMBIE, 535 + (k % 3) * 2, 248 + (k >> 1) * 2); w.A.stun[z] = 1e9; }
  assert(w.exec({ t: 'order', refs: ['s' + g], kind: 'hold' }).ok && m.every((i) => w.A.state[i] === 0), 'hold: every member guards');
  const p0 = m.map((i) => [w.A.x[i], w.A.y[i]]);
  run(w, 200);
  assert(m.every((i, k) => Math.hypot(w.A.x[i] - p0[k][0], w.A.y[i] - p0[k][1]) < 4.5), 'hold: they stay where they stood');
  const [hx] = centroid(w, m);
  assert(w.exec({ t: 'order', refs: ['s' + g], kind: 'hunt' }).ok && m.every((i) => w.A.state[i] === 1), 'hunt: every member pursues');
  run(w, 200);
  const alive = m.filter((i) => w.A.type[i] === TYPE.SOLDIER);
  const [ux] = centroid(w, alive);
  assert(ux > hx + 8, `hunt: the squad closes on the infected (${hx.toFixed(0)} -> ${ux.toFixed(0)})`);
  const r = w.exec({ t: 'order', refs: ['s' + g], kind: 'return' });
  assert(r.ok && w.orders.byGroup.get(g) && w.orders.byGroup.get(g).zone === 1, 'back to zone: heads for zone A');
  run(w, 4000, () => {});
  assert(!w.orders.byGroup.has(g) && alive.every((i) => zoneAt(w, i) === 1 && w.A.state[i] === 0), 'back to zone: the squad walked round to the gate and guards inside');
  const s = selectables(w, 0).find((e) => e.ref === 's' + g);
  assert(s && s.mode === 'holding', 'selectables reports the squad holding');
}

// ---------------------------------------------------------------- police keep their station
{
  const civic = map.buildings.findIndex((b, k) => b.k === 'civic');
  let station = -1;
  const w = battle({ setup: (ww) => {
    const b = ww.buildings[civic];
    ww.exec({ t: 'zone.add', p: [b.cx - 40, b.cy - 40, b.cx + 40, b.cy - 40, b.cx + 40, b.cy + 40, b.cx - 40, b.cy + 40] });
    const c = ww.zones.comps.find((q) => q.bldgs.includes(civic));
    const [x0, y0, x1, y1] = c.bbox.map((v) => v * ww.grid.cell);
    ww.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
    assert(ww.exec({ t: 'func.set', b: civic, func: 'police' }).ok, 'police station assigned');
    station = civic;
  } });
  run(w, 200);
  const sel = selectables(w, 0).find((e) => e.ref === 's' + station);
  assert(sel && sel.kind === 'police' && sel.n >= 3, `officers are selectable as the station's squad (${sel && sel.n})`);
  const b = w.buildings[station];
  const tx = b.cx + 100, ty = b.cy;
  assert(w.exec({ t: 'order', refs: ['s' + station], kind: 'move', x: tx, y: ty }).ok, 'officers take a move order');
  const m = members(w, station);
  run(w, 1500);
  const [cx, cy] = centroid(w, m.filter((i) => w.A.type[i] === TYPE.POLICE));
  assert(Math.hypot(cx - tx, cy - ty) < 25, `officers reached the point (${Math.hypot(cx - tx, cy - ty).toFixed(0)} m off)`);
  assert(m.every((i) => w.A.type[i] !== TYPE.POLICE || w.A.group[i] === station), 'they keep their station link');
  assert(w.exec({ t: 'stance.set', b: station, stance: 'pursue' }).ok && members(w, station).every((i) => w.A.state[i] === 1), 'stance.set still sets every officer');
}

// ---------------------------------------------------------------- commandable vehicles (stub)
{
  const w = battle({ owners: 2 });
  w.vehicles.push({ id: 9001, kind: 'boat', x: 400, y: 400, alive: true, owner: 0, hp: 1, hpMax: 1, commandable: true, selR: 10 });
  w.vehicles.push({ id: 9002, kind: 'boat', x: 420, y: 400, alive: true, owner: 1, hp: 1, hpMax: 1, commandable: true });
  w.vehicles.push({ id: 9003, kind: 'bus', x: 440, y: 400, alive: true, owner: 0, hp: 1, hpMax: 1 });
  const s = selectables(w, 0);
  assert(s.length === 1 && s[0].ref === 'v9001' && s[0].vehicle && s[0].r === 10, 'only own commandable vehicles are selectable');
  const h0 = w.hash();
  assert(w.exec({ t: 'order', refs: ['v9001'], kind: 'move', x: 380, y: 405 }).ok, 'move order for a vehicle');
  const o = w.vehicles[0].order;
  assert(o && o.kind === 'move' && o.x === 380 && o.y === 405 && o.t === w.t && o.done === false, 'exec sets v.order');
  assert(w.hash() !== h0, 'v.order is in the hash');
  assert(!w.exec({ t: 'order', refs: ['v9002'], kind: 'hold', owner: 0 }).ok, "a partner's vehicle is refused");
  assert(!w.exec({ t: 'order', refs: ['v9003'], kind: 'hold', owner: 0 }).ok, 'a vehicle that is not commandable is ignored');
  assert(w.exec({ t: 'order', refs: ['v9001'], kind: 'hold' }).ok && w.vehicles[0].order.kind === 'hold' && w.vehicles[0].order.x === 400, 'hold: v.order at the current position');
  assert(w.exec({ t: 'order', refs: ['v9001'], kind: 'return' }).ok && Number.isFinite(w.vehicles[0].order.x), 'back to zone: v.order points into the zone');
}

// ---------------------------------------------------------------- hash, restore mid-move, determinism
const script = (w, until, onTick) => {
  let g1 = -1, g2 = -1;
  for (let k = 1; k <= until && w.phase === 'battle'; k++) {
    if (k === 2) { g1 = drop(w, 250, 250); g2 = drop(w, 450, 300); }
    if (k === 30) w.exec({ t: 'order', refs: ['s' + g1, 's' + g2], kind: 'move', x: 600, y: 200 });
    if (k === 260) w.exec({ t: 'order', refs: ['s' + g2], kind: 'hunt' });
    if (k === 300) w.exec({ t: 'order', refs: ['s' + g2], kind: 'return' });
    if (k === 420) w.exec({ t: 'order', refs: ['s' + g1], kind: 'move', x: 150, y: 600 });
    if (k === 500) w.exec({ t: 'wall.add', p: [100, 470, 200, 470] });
    if (k === 700) w.exec({ t: 'order', refs: ['s' + g1], kind: 'hold' });
    w.step();
    if (onTick) onTick(k);
  }
};
{
  const a = battle(), b = battle();
  const ha = [], hb = [];
  script(a, 900, (k) => { if (k % 150 === 0) ha.push(a.hash()); });
  script(b, 900, (k) => { if (k % 150 === 0) hb.push(b.hash()); });
  assert(ha.join() === hb.join(), `two worlds, same orders -> same hashes (${ha[ha.length - 1]})`);
  const c = battle();
  script(c, 31);
  const h = c.hash();
  const d = battle();
  script(d, 29); d.step(); d.step();
  assert(h !== d.hash(), 'an order changes the hash at once');
}
{
  const w = battle();
  let snap = null;
  script(w, 200, (k) => { if (k === 200) snap = w.snapshot(); });
  assert(w.orders.recs.size > 0, 'the snapshot was taken mid-move');
  w.restore(snap);
  assert(w.phase === 'planning' && w.orders.recs.size === 0 && w.counts[TYPE.SOLDIER] === 0, 'restore clears the battle, orders included');
  w.exec({ t: 'ready' });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.remove(i);
  const z = w.spawn(TYPE.ZOMBIE, 26, 774); w.A.stun[z] = 1e9;
  w.step();
  const fresh = battle();
  fresh.charges = { ...w.charges };
  script(w, 600); script(fresh, 600);
  assert(w.hash() === fresh.hash(), `a restored world replays the same orders like a fresh one (${w.hash()})`);
}

// ---------------------------------------------------------------- co-op lockstep with orders
{
  const mk = () => battle({ owners: 2, seed: 31 });
  const wa = mk(), wb = mk();
  const [la, lb] = makeLoopbackPair({ latency: 6, jitter: 6 });
  await la.ready; await lb.ready;
  const da = new LockstepDriver(wa, la, 0, { turnSec: 0.01, maxSteps: 16 });
  const db = new LockstepDriver(wb, lb, 1, { turnSec: 0.01, maxSteps: 16 });
  let desync = null;
  da.onDesync = (e) => { desync = e; }; db.onDesync = (e) => { desync = desync || e; };
  const res = [];
  da.onApply = (c, r, local) => { if (local) res.push(['a', c.t, c.kind, r.ok]); };
  db.onApply = (c, r, local) => { if (local) res.push(['b', c.t, c.kind, r.ok]); };
  da.submit({ t: 'ability.use', id: 'paratroopers', x: 250, y: 250 });
  db.submit({ t: 'ability.use', id: 'paratroopers', x: 450, y: 300 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let phase = 0;
  const t0 = Date.now();
  while (wa.tick < 700 && Date.now() - t0 < 30000) {
    await sleep(3);
    da.advance(0.012); db.advance(0.012);
    if (phase === 0 && wa.combat.squads.length === 2 && wb.combat.squads.length === 2) {
      const [s0, s1] = wa.combat.squads;
      da.submit({ t: 'order', refs: ['s' + s0.group], kind: 'move', x: 600, y: 200 });
      db.submit({ t: 'order', refs: ['s' + s1.group], kind: 'move', x: 450, y: 600 });
      db.submit({ t: 'order', refs: ['s' + s0.group], kind: 'hold' });
      phase = 1;
    }
  }
  for (let i = 0; i < 300 && db.turn < da.turn; i++) { await sleep(2); db.advance(0.012); }
  const common = [...da.hashLog.keys()].filter((t) => db.hashLog.has(t));
  la.close();
  assert(common.length >= 5 && common.every((t) => da.hashLog.get(t).h === db.hashLog.get(t).h) && !desync, `lockstep with orders: hashes equal at ${common.length} checkpoints`);
  const orders = res.filter((r) => r[1] === 'order');
  assert(orders.length === 3 && orders.filter((r) => r[3]).length === 2 && orders.some((r) => r[0] === 'b' && r[2] === 'hold' && !r[3]), 'orders applied on both peers; the partner squad order is refused');
}

console.log(process.exitCode ? 'orders: FAILED' : 'orders: all passed');
setTimeout(() => process.exit(process.exitCode || 0), 30);
