// Click picking (js/game/pick.js): builds before troops, roof footprints, minimum hit sizes, click-again cycling,
// Alt, refund / upgrade picking without troops, co-op ownership. Run: node test/picking.mjs
import { World, TYPE } from '../js/sim/world.js';
import { installCombat } from '../js/sim/units.js';
import { rebuildHash } from '../js/sim/agents.js';
import { pickList, cycleIndex, selOf, AGAIN, HIT } from '../js/game/pick.js';
import { makeTestMap, blockRect, assert } from './sim_testmap.mjs';

const map = makeTestMap({ size: 800 });
const QUIET = ['loseBelowPct=0', 'zombie.softlockSec=100000', 'outbreak.maxSites=1', 'outbreak.zombies=1', 'outbreak.zombieScaleWithPop=false',
  'outbreak.zombiesPerLevel=0', 'population.scale=0.05', 'mutation.firstSec=100000', 'abilities.paratroopers.unlock=0', 'abilities.paratroopers.delay=0'];
const kinds = (l) => l.map((c) => c.kind).join(' > ');
const members = (w, g) => { const o = []; for (let i = 0; i < w.A.n; i++) if (w.A.type[i] >= TYPE.POLICE && w.A.group[i] === g) o.push(i); return o; };

// Zone over blocks 1..2 (x, y 153..347), gate in its west wall at y = 250, a garrison on the roof at (177, 177),
// a demolition charge on the same roof, a sentry gun on the street at (250, 200), a standalone wall and painted mines.
function setup({ owners = 1 } = {}) {
  const w = installCombat(new World(map, { seed: 7, stage: 2, mutators: QUIET, sandbox: true, owners }));
  w.exec({ t: 'loadout.set', abilities: { paratroopers: 6 } });
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2) });
  const gx = w.zones.comps[0].bbox[0] * w.grid.cell + 2;
  const gate = w.exec({ t: 'gate.add', x: gx, y: 250 });
  const b = w.grid.bldg[w.cellAt(177, 177)] - 1, bd = w.buildings[b];
  const gar = w.exec({ t: 'unit.place', type: 'garrison', x: bd.cx, y: bd.cy, b });
  const c4 = w.exec({ t: 'unit.place', type: 'c4', x: bd.cx, y: bd.cy, b });
  const tur = w.exec({ t: 'unit.place', type: 'turret', x: 250, y: 200 });
  const wall = w.exec({ t: 'wall.add', p: [420, 420, 500, 420] });
  const cells = [];
  for (let x = 432; x <= 470; x += 4) cells.push(w.cellAt(x, 250));
  const mines = w.exec({ t: 'unit.paint', type: 'mine', cells });
  assert(gate.ok && gar.ok && c4.ok && tur.ok && wall.ok && mines.ok && mines.count >= 5, `setup: gate, garrison, charge, turret, wall and ${mines.count} mines placed`);
  const g = w.zones.gates.find((q) => q.id === gate.id);
  return { w, b, bd, gate: g, gar: gar.id, c4: c4.id, tur: tur.id, wall: wall.id };
}
// pickList with grid building lookup, as the session would call it
const at = (w, x, y, zoom, o = {}) => pickList(w, x, y, { zoom, owner: 0, ...o });

// ---------------------------------------------------------------- planning: order and footprint
{
  const { w, b, bd, gate, gar, c4, tur, wall } = setup();
  let l = at(w, bd.cx, bd.cy, 4);
  assert(l[0].kind === 'unit' && l[0].id === gar && l[1].kind === 'unit' && l[1].id === c4, `roof centre: the garrison, then the charge on the same roof (${kinds(l)})`);
  assert(l.some((c) => c.kind === 'building' && c.b === b) && l[l.length - 1].kind === 'zone', 'then the building and last the zone');
  const corner = [bd.cx - 15, bd.cy - 15];
  for (const z of [2, 6, 12]) {
    l = at(w, corner[0], corner[1], z);
    assert(l[0] && l[0].kind === 'unit' && l[0].id === gar, `zoom ${z}: a click on the roof corner, ${Math.round(Math.hypot(15, 15) * z)} px from the glyph, picks the garrison`);
  }
  l = at(w, gate.x, gate.y, 1);
  assert(l[0].kind === 'gate' && l[0].id === gate.id && l.some((c) => c.kind === 'zone'), `gate centre: the gate first (${kinds(l)})`);
  l = at(w, gate.x1, gate.y1, 4);
  assert(l[0].kind === 'gate', 'the gate leaf end picks the gate too, not only its centre');
  // minimum on-screen size: 7 px off (a 14 px target) still hits, at every zoom
  for (const z of [0.25, 0.6, 1, 3, 10]) {
    const d = 7 / z;
    const u = w.units.find((q) => q.id === tur);
    const okU = [[d, 0], [0, d], [-d, 0], [0, -d]].every(([dx, dy]) => at(w, u.x + dx, u.y + dy, z).some((c) => c.kind === 'unit' && c.id === tur));
    const nx = -(gate.y1 - gate.y0), ny = gate.x1 - gate.x0, nl = Math.hypot(nx, ny) || 1;
    const okG = [1, -1].every((s) => at(w, gate.x + s * nx / nl * d, gate.y + s * ny / nl * d, z).some((c) => c.kind === 'gate'));
    const okW = [1, -1].every((s) => at(w, 460, 420 + s * d, z).some((c) => c.kind === 'wall' && c.id === wall));
    assert(okU && okG && okW, `zoom ${z}: turret, gate and wall are hit 7 px off on every side`);
  }
  const z = 1, far = (HIT.unitPx + 2) / z;
  assert(!at(w, 250 + far, 200, z).some((c) => c.kind === 'unit' && c.id === tur), `zoom 1: ${HIT.unitPx + 2} px away the turret is not hit`);
  l = at(w, 450, 250, 3);
  assert(l.filter((c) => c.kind === 'unit').length === 1, 'painted mines: only the nearest mine is a candidate, so cycling reaches the rest');
}

// ---------------------------------------------------------------- battle: troops standing on builds
{
  const { w, bd, gate, gar, tur } = setup();
  w.exec({ t: 'ready', owner: 0 });
  for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) w.remove(i);
  const drop = (x, y) => { const r = w.exec({ t: 'ability.use', id: 'paratroopers', x, y }); assert(r.ok, `paratroopers land at ${Math.round(x)},${Math.round(y)}`); return w.combat.squads[w.combat.squads.length - 1].group; };
  const gA = drop(gate.x + 6, gate.y), gB = drop(bd.cx, bd.cy + 30), gC = drop(250, 210), gD = drop(560, 650);
  // stand them right on top: on the gate, on the garrisoned roof, on the turret
  const put = (g, x, y) => members(w, g).forEach((i, k) => { w.A.x[i] = x + (k % 5) * 0.6 - 1.2; w.A.y[i] = y + ((k / 5) | 0) * 0.6 - 1.2; });
  put(gA, gate.x, gate.y); put(gB, bd.cx, bd.cy); put(gC, 250, 200);
  rebuildHash(w);
  for (const [name, x, y, first, g] of [['gate', gate.x, gate.y, 'gate', gA], ['garrisoned roof', bd.cx, bd.cy, 'unit', gB], ['turret', 250, 200, 'unit', gC]]) {
    for (const z of [0.5, 2, 8]) {
      const l = at(w, x, y, z);
      const ti = l.findIndex((c) => c.kind === 'troop' && c.group === g);
      assert(l[0].kind === first && (first !== 'unit' || l[0].id === (name === 'turret' ? tur : gar)) && ti > 0 && l.slice(0, ti).every((c) => c.tier === 0),
        `zoom ${z}, men on the ${name}: the build first, the squad after the builds (${kinds(l)})`);
    }
  }
  // click again cycles: build, then the next thing, then the squad ... and wraps
  const l = at(w, bd.cx, bd.cy, 2);
  let last = null, t = 100, seen = [];
  for (let k = 0; k < l.length + 1; k++) {
    const i = cycleIndex(l, last, 300, 300, t, false);
    seen.push(l[i].key);
    last = { sx: 300 + (k % 2), sy: 300, t, key: l[i].key };
    t += 0.4;
  }
  assert(seen.slice(0, l.length).join() === l.map((c) => c.key).join() && seen[l.length] === l[0].key, `clicking again on the spot steps through all ${l.length} and wraps (${kinds(l)})`);
  assert(cycleIndex(l, { sx: 300, sy: 300, t: 100, key: l[0].key }, 300, 300, 100 + AGAIN.sec + 0.1) === 0, 'after the time window a click starts again at the top');
  assert(cycleIndex(l, { sx: 300, sy: 300, t: 100, key: l[0].key }, 300 + AGAIN.px + 2, 300, 100.2) === 0, 'a click a few px away starts again at the top');
  assert(cycleIndex(l, null, 300, 300, 100, true) === 1 && cycleIndex(l, { sx: 300, sy: 300, t: 100, key: l[0].key }, 300, 300, 100.3, true) === 2, 'Alt+click takes the next candidate directly, and one further when clicked again');
  assert(cycleIndex([], null, 0, 0, 0) === -1, 'nothing under the cursor: no pick');
  // troops only (shift-click, double-click, box): the squad on the gate is found despite the gate
  const tr = at(w, gate.x, gate.y, 2, { builds: false, rest: false, boats: true });
  assert(tr[0] && tr[0].kind === 'troop' && tr[0].ref === 's' + gA, 'troops-only picking finds the squad standing on the gate');
  // a man with no build under him is picked by a plain click
  put(gD, 560, 650); rebuildHash(w);
  const open = at(w, 560, 650, 2);
  assert(open[0].kind === 'troop' && open[0].group === gD, `a squad on an empty street is the first pick (${kinds(open)})`);
  // refund and upgrade: builds only, troops never in the way
  for (const [x, y, want] of [[gate.x, gate.y, 'gate'], [bd.cx, bd.cy, 'unit'], [250, 200, 'unit']]) {
    const rl = at(w, x, y, 2, { mine: true, troops: false, zonePolys: true });
    assert(rl[0].kind === want && !rl.some((c) => c.kind === 'troop' || c.kind === 'squad' || c.kind === 'building') && rl[rl.length - 1].kind === 'zonepoly', `refund at the ${want} with men on it: ${kinds(rl)}`);
    const ul = at(w, x, y, 2, { units: true, mine: true });
    assert(ul.every((c) => c.kind === 'unit') && (want === 'gate' ? !ul.length : ul[0].kind === 'unit'), `upgrade at the ${want}: units only (${kinds(ul) || 'none'})`);
  }
  assert(at(w, 560, 650, 2, { mine: true, troops: false, zonePolys: true }).length === 0, 'refund on a squad in the street: nothing');
  // card selections
  assert(JSON.stringify(selOf(l[0])) === JSON.stringify({ kind: 'unit', id: gar }) && selOf({ kind: 'zone', comp: 0 }).comp === 0 && selOf({ kind: 'troop', ref: 'v3', vid: 3 }) === null, 'selOf maps candidates to card selections');
}

// ---------------------------------------------------------------- co-op: a partner's builds
{
  const w = installCombat(new World(map, { seed: 7, stage: 2, mutators: QUIET, sandbox: true, owners: 2 }));
  w.exec({ t: 'zone.add', p: blockRect(1, 1, 2, 2), owner: 1 });
  const b = w.grid.bldg[w.cellAt(177, 177)] - 1, bd = w.buildings[b];
  const theirs = w.exec({ t: 'unit.place', type: 'garrison', x: bd.cx, y: bd.cy, b, owner: 1 });
  const mine = w.exec({ t: 'unit.place', type: 'turret', x: 250, y: 200, owner: 0 });
  assert(theirs.ok && mine.ok, 'co-op: partner garrison and own turret placed');
  const l = at(w, bd.cx, bd.cy, 2);
  assert(l[0].kind === 'unit' && l[0].id === theirs.id, "a partner's garrison still opens its card on a plain click");
  assert(!at(w, bd.cx, bd.cy, 2, { mine: true, troops: false, zonePolys: true }).length, "refund never offers a partner's unit or zone");
  assert(!at(w, bd.cx, bd.cy, 2, { units: true, mine: true }).length, "upgrade never offers a partner's unit");
  const near = at(w, 250, 200, 0.3);
  const ki = near.findIndex((c) => c.id === mine.id), kt = near.findIndex((c) => c.id === theirs.id);
  assert(ki >= 0 && (kt < 0 || ki < kt), 'zoomed out with both in reach, the own build sorts first');
}
console.log('picking: all ok');
