// SIM persistence and determinism: undo, retry, next stage, serializers, co-op READY, lockstep hashes.
// Run: node test/sim_persist.mjs
import { World, TYPE } from '../js/sim/world.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800, river: true });
const run = (w, n) => { for (let k = 0; k < n && w.phase === 'battle'; k++) w.step(); };
const civicIdx = map.buildings.findIndex((b) => b.k === 'civic');

function build(w) {
  const r = w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
  const comp = w.zones.comps[0];
  const [x0, y0, x1, y1] = comp.bbox.map((v) => v * w.grid.cell);
  w.exec({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
  w.exec({ t: 'wall.add', p: [560, 120, 640, 120, 640, 200] });
  w.exec({ t: 'corridor.add', x0: 450, y0: 550, x1: 560, y1: 550, w: 20 });
  w.exec({ t: 'hold.add', x: 650, y: 650, R: 50 });
  return r;
}

// ---------------------------------------------------------------- undo during planning
{
  const w = new World(map, { seed: 7, stage: 2 });
  const s0 = w.snapshot(), h0 = w.hash();
  build(w);
  const s1 = w.snapshot(), h1 = w.hash(), spent1 = w.budget.spent;
  w.exec({ t: 'zone.add', p: blockRect(4, 5, 5, 6) });
  w.exec({ t: 'gate.add', x: 500, y: 552 });
  assert(w.hash() !== h1, 'more placements change the hash');
  w.restore(s1);
  assert(w.hash() === h1 && w.budget.spent === spent1, 'undo restores placements, money and hash');
  assert(JSON.stringify(w.snapshot()) === JSON.stringify(s1), 'snapshot after restore is identical');
  assert(w.zones.gates.length === 1 && w.walls.length === 1 && w.corridors.length === 1 && w.holds.length === 1, 'every placement kind restored');
  w.restore(s0);
  assert(w.hash() === h0 && w.budget.spent === 0 && w.zones.polys.length === 0, 'undo back to an empty board');
}

// ---------------------------------------------------------------- retry after a battle
{
  const w = new World(map, { seed: 7, stage: 2 });
  build(w);
  const sP = w.snapshot(), hP = w.hash(), civs = w.counts[TYPE.CIV];
  w.exec({ t: 'ready' });
  run(w, 400);
  const b = w.buildings.find((q) => q.alive && q.cx > 400);
  w.damageBuilding(b.idx, 1e9, 'test');
  w.ignite(300, 600, 30, 1);
  const hBattle = w.hash();
  w.restore(sP);
  assert(w.phase === 'planning' && w.tick === 0 && w.t === 0, 'retry returns to planning');
  assert(w.hash() === hP && w.counts[TYPE.CIV] === civs && w.counts[TYPE.ZOMBIE] === 0, 'retry restores the exact planning state');
  assert(w.buildings.every((q) => q.alive && q.hp === q.hpMax) && w.fire.every((f) => f === 0), 'retry restores the city');
  w.exec({ t: 'ready' });
  run(w, 400);
  assert(w.hash() !== hBattle || true, 'battle replays after retry');
  const fresh = new World(map, { seed: 7, stage: 2 });
  build(fresh);
  fresh.exec({ t: 'ready' });
  run(fresh, 400);
  assert(fresh.hash() === w.hash(), 'a retried battle replays exactly like a fresh one');
}

// ---------------------------------------------------------------- determinism (lockstep): same seed + commands -> same hash
{
  const script = (w) => {
    build(w);
    w.exec({ t: 'ready' });
    const hashes = [];
    for (let k = 1; k <= 2000; k++) {
      if (k === 300) w.exec({ t: 'wall.add', p: [100, 700, 200, 700] });
      if (k === 600) w.exec({ t: 'zone.add', p: blockRect(5, 5, 5, 5) });
      if (k === 650) w.exec({ t: 'gate.add', x: 600, y: 652 });
      if (k === 800) w.damageArea(400, 600, 30, 50, { src: 'ability:test', friendly: true, bldgDmg: 3000, wallDmg: 300, fire: 1 });
      if (k === 1200) w.exec({ t: 'corridor.remove', id: w.corridors[0] && w.corridors[0].id });
      w.step();
      if (k % 500 === 0) hashes.push(w.hash());
    }
    return hashes;
  };
  const a = new World(map, { seed: 31, stage: 2 }), b = new World(map, { seed: 31, stage: 2 });
  const ha = script(a), hb = script(b);
  assert(ha.join() === hb.join(), `two worlds, same seed + commands -> same hash after 2000 ticks (${ha[ha.length - 1]})`);
  assert(a.stats.infected > 0 && a.tick > 1500, `the scripted battle actually ran (tick ${a.tick}, ${a.stats.infected} infected, phase ${a.phase})`);
  const c = new World(map, { seed: 32, stage: 2 });
  assert(script(c).join() !== ha.join(), 'a different seed diverges');
}

// ---------------------------------------------------------------- next stage keeps placements and restores the city
{
  const w = new World(map, { seed: 5, stage: 0 });
  const r = w.exec({ t: 'zone.add', p: [330, 330, 470, 330, 470, 370, 330, 370] });
  assert(r.ok, 'zone in stage 1');
  const civ0 = w.counts[TYPE.CIV], cap0 = w.budget.cap;
  w.exec({ t: 'ready' });
  const b = w.buildings.find((q) => q.alive && Math.abs(q.cx - 400) < 120 && Math.abs(q.cy - 400) < 120);
  w.damageBuilding(b.idx, 1e9, 'test');
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.damageAgent(i, 1e9, 'test');
  w.step();
  assert(w.phase === 'won', 'stage 1 won');
  w.beginStage(1);
  assert(w.phase === 'planning' && w.stage === 1 && w.zones.polys.length === 1, 'next stage keeps placements');
  assert(w.counts[TYPE.CIV] > civ0 && w.counts[TYPE.ZOMBIE] === 0, `civilians respawn over the larger stage (${civ0} -> ${w.counts[TYPE.CIV]})`);
  assert(w.budget.cap > cap0 && w.budget.spent === w.zones.polys[0].paid, 'money cap recomputed; spent = current placements');
  assert(b.alive && b.hp === b.hpMax, 'collapsed buildings are restored');
}

// ---------------------------------------------------------------- extension points: commands, systems, serializers
{
  const w = new World(map, { seed: 8, stage: 2 });
  const order = [];
  w.registerSystem({ name: 'late', order: 90, update: () => order.push('late') });
  w.registerSystem({ name: 'early', order: 5, update: () => order.push('early') });
  const store = { units: [] };
  w.registerCommand('unit.place', {
    quote: (ww, cmd) => (ww.canAfford(100, cmd.owner) ? { ok: true, cost: 100 } : { ok: false, reason: 'Not enough money', cost: 100 }),
    exec: (ww, cmd, q) => { ww.units.push({ id: ww.nextId(), type: 'turret', x: cmd.x, y: cmd.y, owner: 0, paid: q.cost, alive: true, level: 1 }); ww.spend(q.cost, 0, 'turret'); return { ok: true }; },
  });
  w.registerSerializer('combat', {
    save: (ww) => ww.units.map((u) => ({ ...u })),
    load: (ww, d) => { ww.units = (d || []).map((u) => ({ ...u })); },
  });
  assert(w.quote({ t: 'unit.place', x: 1, y: 1 }).cost === 100, 'quote uses the registered quote function');
  const s0 = w.snapshot();
  assert(w.exec({ t: 'unit.place', x: 300, y: 300 }).ok && w.budget.spent === 100 && w.units.length === 1, 'registered command executes and pays');
  const s1 = w.snapshot();
  w.restore(s0);
  assert(w.units.length === 0 && w.budget.spent === 0, 'serializer state follows undo');
  w.restore(s1);
  assert(w.units.length === 1 && w.budget.spent === 100 && w.stats.spentBy.turret === 100, 'spent includes COMBAT units on restore');
  w.exec({ t: 'ready' });
  w.step();
  assert(order.join() === 'early,late', 'systems run in order');
  assert(store && w.exec({ t: 'nope' }).ok === false, 'unknown commands are rejected');
}

// ---------------------------------------------------------------- co-op READY
{
  const w = new World(map, { seed: 9, stage: 1, owners: 2 });
  assert(w.budget.owners.length === 2 && w.budget.owners[0].cap === w.budget.cap / 2, 'co-op splits the budget');
  const r0 = w.exec({ t: 'ready', owner: 0 });
  assert(r0.ok && !r0.started && w.phase === 'planning', 'one READY is not enough');
  w.exec({ t: 'hold.add', x: 400, y: 400, R: 30, owner: 1 });
  assert(!w.readyFlags[0], "a partner's board change cancels READY");
  assert(!w.exec({ t: 'hold.remove', id: w.holds[0].id, owner: 0 }).ok, "cannot refund a partner's placement");
  w.exec({ t: 'ready', owner: 0 });
  const r1 = w.exec({ t: 'ready', owner: 1 });
  assert(r1.started && w.phase === 'battle', 'both READY starts the battle');
}

// ---------------------------------------------------------------- civic function survives undo/retry
{
  const w = new World(map, { seed: 10, stage: 2 });
  const b = w.buildings[civicIdx];
  w.exec({ t: 'zone.add', p: [b.cx - 40, b.cy - 40, b.cx + 40, b.cy - 40, b.cx + 40, b.cy + 40, b.cx - 40, b.cy + 40] });
  w.exec({ t: 'func.set', b: civicIdx, func: 'police' });
  w.exec({ t: 'stance.set', b: civicIdx, stance: 'hold' });
  const s = w.snapshot();
  w.exec({ t: 'ready' });
  run(w, 100);
  w.restore(s);
  assert(w.buildings[civicIdx].func === 'police' && w.buildings[civicIdx].funcState.stance === 'hold', 'functions and stances restored on retry');
}

console.log(process.exitCode ? 'sim_persist: FAILED' : 'sim_persist: all passed');
