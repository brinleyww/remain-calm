// Multi-level roads: map format z, the deck grid, fields over decks and tunnels, a leak suite across tiers,
// agents on decks, blasts, destroyed decks, determinism. Run: node test/decks.mjs  (-v for numbers)
import { normalizeMap, serializeMap, parseMap, validateMap, clipLineRect, zAt, T } from '../js/map/format.js';
import { buildGrid } from '../js/sim/raster.js';
import { nodeAt, portalOf, tierOf, LV_DECK, LV_PORTAL, fieldOf } from '../js/sim/decks.js';
import { World, TYPE, CS, TIER_ALL } from '../js/sim/world.js';
import { installCombat } from '../js/sim/units.js';
import { INF } from '../js/sim/nav.js';
import { rectPoly } from '../js/util/geom.js';
import { rebuildHash } from '../js/sim/agents.js';
import { assert } from './sim_testmap.mjs';
import { generateCity } from '../js/map/citygen.js';
import { encodeShareCode, decodeShareCode } from '../js/util/compress.js';

const verbose = process.argv.includes('-v');
const log = (...a) => { if (verbose) console.log('  ', ...a); };
const FULL = [{ p: [0, 0, 400, 0, 400, 400, 0, 400] }];
const mk = (roads, extra = {}) => normalizeMap({ format: 'rcmap', v: 2, name: 'decks', source: 'editor', seed: 5, w: 400, h: 400, roads, water: [], parks: [], buildings: [], levels: FULL, ...extra });
// a north-south flyover: ground at both ends, ramps of 90 m, a deck (z 1) from y 130 to 270, over an east-west street
const FLY = { p: [200, 10, 200, 40, 200, 130, 200, 270, 200, 360, 200, 390], z: [0, 0, 1, 1, 0, 0], w: 8, k: 'major' };
const STREET = { p: [0, 200, 400, 200], w: 12, k: 'major' };
const STRONG = ['population.scale=0', 'loseBelowPct=0', 'wall.hp=1e9', 'gate.hp=1e9', 'outbreak.maxSites=1', 'outbreak.zombies=1',
  'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'outbreak.minDistFromZone=0', 'mutation.firstSec=1e9'];
const world = (map, extra = []) => new World(map, { seed: 1, sandbox: true, mutators: [...STRONG, ...extra] });
const cellOf = (w, x, y) => Math.floor(y / w.grid.cell) * w.grid.gw + Math.floor(x / w.grid.cell);
const fid = (w, t, x, y) => nodeAt(w.grid.deck, t, Math.floor(x / w.grid.cell), Math.floor(y / w.grid.cell));
const battle = (w) => { w.exec({ t: 'ready' }); for (let i = 0; i < w.A.n; i++) if (w.A.type[i]) w.remove(i); w.A.stun[w.spawn(TYPE.ZOMBIE, 390, 390)] = 1e9; };

// ---------------------------------------------------------------- 1. format
{
  const m = mk([FLY, STREET]);
  assert(m.v === 2 && JSON.stringify(m.roads[0].z) === '[0,0,1,1,0,0]' && !m.roads[1].z, 'z kept per vertex; flat roads carry none; v2');
  assert(JSON.parse(serializeMap(m)).v === 2 && serializeMap(parseMap(serializeMap(m))) === serializeMap(m), 'a map with z saves as v2 and round-trips');
  const flat = mk([{ ...FLY, z: [0, 0, 0, 0, 0, 0] }, STREET]);
  assert(flat.v === 1 && !flat.roads[0].z && JSON.parse(serializeMap(flat)).v === 1, 'all-ground z is dropped and the map stays v1');
  assert(!mk([{ ...FLY, z: [0, 1, 'x', 1, 0, 0] }]).roads[0].z && !mk([{ ...FLY, z: [0, 1] }]).roads[0].z, 'a bad or short z falls back to ground');
  assert(mk([{ ...FLY, z: [0, 0, 7, -9, 0, 0] }]).roads[0].z.join() === '0,0,3,-2,0,0', 'z clamped to -2..3');
  assert(validateMap(m).ok && !validateMap({ ...m, roads: [{ ...FLY, z: [0, 0, 1] }] }).ok, 'validation checks heights');
  const pc = clipLineRect([-100, 0, 100, 0], 0, -1, 400, 1, [0, 2]);
  assert(pc.length === 1 && Math.abs(pc[0].z[0] - 1) < 1e-9 && pc[0].z[1] === 2, 'clipping interpolates z at the cut');
  const cut = mk([{ p: [-200, 100, 200, 100], z: [0, 2], w: 8, k: 'minor' }]);
  assert(cut.roads[0].p[0] === 0 && cut.roads[0].z[0] === 1, 'normalize clips a road with z at the sheet edge');
  assert(Math.abs(zAt(m.roads[0], 30 + 45) - 0.5) < 1e-9 && zAt(m.roads[1], 50) === 0, 'zAt interpolates along the road');
  // an old (v1) map file loads and saves byte for byte as before, and a map with heights survives a share code
  const old = serializeMap(generateCity({ seed: 21, sizeKm: 1, water: 'river', density: 0.5, bridges: 2, stages: 3 }));
  assert(JSON.parse(old).v === 1 && serializeMap(parseMap(old)) === old, 'a v1 map file round-trips unchanged');
  const code = await encodeShareCode(serializeMap(m));
  assert(serializeMap(parseMap(await decodeShareCode(code))) === serializeMap(m), 'a map with heights survives a share code');
}

// ---------------------------------------------------------------- 2. grid
{
  const m = mk([FLY, STREET]), g = buildGrid(m, 4), dk = g.deck;
  const flatG = buildGrid(mk([{ ...FLY, z: [0, 0, 0, 0, 0, 0] }, STREET]), 4), flat2 = buildGrid(mk([{ ...FLY, z: undefined }, STREET]), 4);
  assert(!flatG.deck && Buffer.compare(Buffer.from(flatG.terrain), Buffer.from(flat2.terrain)) === 0, 'a flat map rasterises byte for byte as before');
  let ramp = 0;
  for (const t of g.terrain) if (t === T.RAMP) ramp++;
  log('nodes', dk.D, 'portals', dk.portals.length, 'ramp cells', ramp, 'structures', g.bridges.length);
  assert(dk && dk.D === 116 && dk.portals.length === 4 && ramp === 16, `deck nodes ${dk && dk.D}, portals ${dk && dk.portals.length}, ramp cells ${ramp}`);
  assert(g.bridges.length === 1 && g.bridges[0].deck && g.bridges[0].nodes.length === dk.D, 'the deck is one destructible structure');
  assert(g.terrain[cellOf({ grid: g }, 200, 200)] === T.ROAD && (dk.lvf[cellOf({ grid: g }, 200, 200)] & LV_DECK), 'the street runs on under the deck');
  let asym = 0;
  for (let k = 0; k < dk.D; k++) for (let d = 0; d < 8; d++) {
    const m2 = dk.nb[8 * k + d];
    if (m2 < 0) continue;
    if (m2 >= dk.N) { if (dk.nb[8 * (m2 - dk.N) + ((d + 4) & 7)] !== dk.N + k) asym++; }
    else if (portalOf(dk, m2, (d + 4) & 7) !== dk.N + k) asym++;
  }
  assert(asym === 0, `every link and portal is two-way (${asym} not)`);
  const tun = buildGrid(mk([{ p: [10, 200, 60, 200, 130, 200, 270, 200, 340, 200, 390, 200], z: [0, 0, -1, -1, 0, 0], w: 8, k: 'minor' }]), 4);
  assert(tun.deck && tun.deck.D > 0 && tun.bridges.length === 0 && [...tun.deck.tier].every((t) => t === -1), 'a tunnel makes tier -1 nodes and no structure');
  const rail = buildGrid(mk([{ p: [10, 100, 390, 100], z: [1, 1], w: 6, k: 'rail' }]), 4);
  assert(!rail.deck && rail.terrain[cellOf({ grid: rail }, 200, 100)] === T.OPEN, 'elevated rail is scenery: no nodes, nothing on the ground');
}

// ---------------------------------------------------------------- 3. fields over decks
{
  const w = world(mk([FLY, STREET]));
  battle(w);
  const i = w.spawn(TYPE.SOLDIER, 200, 220, 0, 1);
  w.A.stun[i] = 1e9;
  w.computeFields();
  const d = w.nav.scent.dist;
  const onDeck = d[fid(w, 1, 200, 214)], under = d[cellOf(w, 200, 214)], foot = d[cellOf(w, 200, 30)];
  log('scent: deck', onDeck, 'ground under', under, 'south ground end', foot);
  assert(onDeck < 40 && foot < 600 && under > 400, `path distance runs over the deck (${onDeck}), not through the ground under it (${under})`);
  assert(fieldOf(w, i) === fid(w, 1, 200, 220), 'fieldOf finds the deck node');
}

// ---------------------------------------------------------------- 4. leak suite
// For every case: with no gate, no field id outside the zone (on any tier) reaches it on the civilian field, and the
// zombie scent from people inside must pay a wall crossing everywhere outside. With a gate the civilian field gets out.
function leakCase(name, map, zonePoly, inside, gateAt, wallLine) {
  for (const withGate of [false, true]) {
    if (withGate && !gateAt) continue;
    const w = world(map);
    if (wallLine) assert(w.exec({ t: 'wall.add', p: wallLine }).ok, `${name}: wall placed`);
    if (zonePoly) assert(w.exec({ t: 'zone.add', p: zonePoly }).ok, `${name}: zone placed`);
    if (withGate) assert(w.exec({ t: 'gate.add', x: gateAt[0], y: gateAt[1] }).ok, `${name}: gate placed`);
    battle(w);
    for (const [x, y, t] of inside) { const i = w.spawn(TYPE.CIV, x, y, 0, t); w.A.stun[i] = 1e9; w.A.state[i] = CS.SAFE; }
    w.computeFields();
    const N = w.grid.gw * w.grid.gh, NN = w.nav.pass.length, dk = w.grid.deck, civ = w.nav.civ.dist, sc = w.nav.scent.dist;
    const wallCost = 10 * w.cfg.scent.wallCost;
    let civOut = 0, scentLow = 0, outside = 0, reachOut = 0, nodesOut = 0;
    for (let f = 0; f < NN; f++) {
      const gc = f < N ? f : dk.cell[f - N];
      if (w.zoneComp[gc] || !w.nav.pass[f]) continue;
      outside++;
      if (f >= N) nodesOut++;
      if (civ[f] !== INF) { civOut++; reachOut++; }
      if (!wallLine && sc[f] < wallCost) scentLow++;
    }
    log(name, withGate ? 'gate' : 'no gate', 'outside ids', outside, 'nodes', nodesOut, 'civ reach', reachOut, 'scent below a wall', scentLow);
    if (!withGate) assert(civOut === 0 && scentLow === 0 && nodesOut > 0, `${name}: sealed on every tier (civ field reaches ${civOut} outside ids, scent skips the wall at ${scentLow})`);
    else assert(reachOut > 0, `${name}: with a gate the civilian field reaches outside (${reachOut})`);
  }
}
{
  const fly = mk([FLY, STREET]);
  leakCase('flyover over a zone', fly, rectPoly(150, 160, 250, 240), [[200, 200, 1], [180, 200, 0]], [250, 200]);
  const TUN = { p: [10, 200, 60, 200, 130, 200, 270, 200, 340, 200, 390, 200], z: [0, 0, -1, -1, 0, 0], w: 8, k: 'minor' };
  leakCase('tunnel under a zone', mk([TUN, { p: [200, 0, 200, 400], w: 10, k: 'major' }]), rectPoly(160, 150, 240, 250), [[200, 200, -1], [200, 170, 0]], [200, 250]);
  leakCase('ramp inside a zone', fly, rectPoly(150, 20, 250, 110), [[200, 60, 0], [200, 100, 1]], [150, 60]);
  leakCase('deck end inside a zone', fly, rectPoly(160, 100, 240, 300), [[200, 200, 1]], [160, 200]);
  // the deck over a building block: with a wall across it, the far half of the deck is sealed off from the near half
  const blocked = mk([{ ...FLY, p: [200, 10, 200, 40, 200, 130, 200, 380], z: [0, 0, 1, 1] }], { buildings: [{ p: rectPoly(120, 100, 280, 395), h: 10, k: 'ind' }] });
  {
    const w = world(blocked);
    assert(w.exec({ t: 'wall.add', p: [150, 250, 250, 250] }).ok, 'wall across a deck placed');
    battle(w);
    const i = w.spawn(TYPE.CIV, 200, 200, 0, 1); w.A.stun[i] = 1e9;
    w.computeFields();
    const far = fid(w, 1, 200, 300), wallNode = fid(w, 1, 200, 250), sc = w.nav.scent.dist;
    log('wall across a deck: wall node pass', w.nav.pass[wallNode], 'scent beyond', sc[far]);
    assert((w.nav.pass[wallNode] & 32) && sc[far] >= 10 * w.cfg.scent.wallCost, `a wall blocks the deck tier in its cells (scent beyond ${sc[far]})`);
  }
  {
    const w = world(blocked);
    assert(w.exec({ t: 'zone.add', p: rectPoly(150, 260, 250, 390) }).ok, 'zone over the deck end placed');
    const g0 = w.exec({ t: 'gate.add', x: 200, y: 260 });
    assert(g0.ok, 'gate on a deck placed');
    battle(w);
    w.computeFields();
    const near = fid(w, 1, 200, 200), civ = w.nav.civ.dist, ground = cellOf(w, 100, 200);
    log('gate on a deck: civ field on the deck', civ[near], 'on open ground', civ[ground]);
    assert(civ[near] !== INF && civ[ground] > civ[near], 'a gate on a deck lets the deck in (the ground under it is a building, so the open ground goes up the ramp)');
    const c = w.spawn(TYPE.CIV, 200, 160, 0, 1);
    w.A.panic[c] = 1; w.A.state[c] = CS.PANIC;
    for (let k = 0; k < 2400 && w.A.state[c] !== CS.SAFE; k++) w.step();
    assert(w.A.type[c] === TYPE.CIV && w.A.state[c] === CS.SAFE && w.A.tier[c] === 1 && w.A.y[c] > 262, `a resident on the deck walks through the deck gate and is safe (y ${w.A.y[c].toFixed(1)})`);
  }
}

// ---------------------------------------------------------------- 5. agents walk up, over and down
const RIVER = mk([{ p: [200, 10, 200, 40, 200, 110, 200, 290, 200, 360, 200, 390], z: [0, 0, 1, 1, 0, 0], w: 8, k: 'major' }], { water: [{ p: rectPoly(0, 130, 400, 270) }] });
{
  const w = world(RIVER);
  battle(w);
  const h = w.spawn(TYPE.SOLDIER, 200, 380); w.A.stun[h] = 1e9;
  const z = w.spawn(TYPE.ZOMBIE, 200, 20);
  let maxT = 0, t = 0;
  for (; t < 3200 && w.A.type[h] === TYPE.SOLDIER && w.A.type[z] === TYPE.ZOMBIE; t++) { w.step(); if (w.A.tier[z] > maxT) maxT = w.A.tier[z]; }
  log('zombie crossing: ticks', t, 'max tier', maxT, 'at', w.A.x[z].toFixed(1), w.A.y[z].toFixed(1));
  assert(maxT === 1 && w.A.y[z] > 300 && w.A.tier[z] === 0, `a zombie goes up the ramp, over the river on the deck and down to its target (y ${w.A.y[z].toFixed(0)})`);
}
{
  const w = world(mk([FLY, STREET]), ['civ.panicRadius=0']);
  battle(w);
  const c = w.spawn(TYPE.CIV, 200, 200, 0, 1); w.A.stun[c] = 1e9;
  const z = w.spawn(TYPE.ZOMBIE, 200.5, 201);
  for (let k = 0; k < 40; k++) { w.step(); w.A.x[c] = 200; w.A.y[c] = 200; w.A.vx[c] = 0; w.A.vy[c] = 0; }
  assert(w.A.type[c] === TYPE.CIV && w.A.type[z] === TYPE.ZOMBIE && w.A.tier[z] === 0, 'a zombie under a deck cannot touch the resident on it');
  const z2 = w.spawn(TYPE.ZOMBIE, 200.5, 199, 0, 1);
  for (let k = 0; k < 40 && w.A.type[c] === TYPE.CIV; k++) w.step();
  assert(w.A.type[c] === TYPE.TURNING && w.A.tier[z2] === 1, 'a zombie on the same deck can');
  let n0 = 0, n1 = 0;
  w.query(200, 200, 5, 1 << TYPE.ZOMBIE, () => { n0++; }, 0);
  w.query(200, 200, 5, 1 << TYPE.ZOMBIE, () => { n1++; }, 1);
  assert(n0 === 1 && n1 === 1, 'world.query picks one tier');
}
{
  const w = world(mk([FLY, STREET]), ['civ.panicRadius=0']);
  battle(w);
  const z = w.spawn(TYPE.ZOMBIE, 200, 200, 0, 1); w.A.stun[z] = 1e9;
  const h1 = w.hash();
  w.A.tier[z] = 0;
  assert(w.hash() !== h1, 'tier is part of world.hash on maps with decks');
}

// ---------------------------------------------------------------- 6. tunnels
{
  const TUN = { p: [10, 200, 60, 200, 130, 200, 270, 200, 340, 200, 390, 200], z: [0, 0, -1, -1, 0, 0], w: 8, k: 'minor' };
  const w = world(mk([TUN], { buildings: [{ p: rectPoly(100, 150, 300, 250), h: 10, k: 'ind' }] }));
  battle(w);
  const h = w.spawn(TYPE.SOLDIER, 380, 200); w.A.stun[h] = 1e9;
  const z = w.spawn(TYPE.ZOMBIE, 20, 200);
  let minT = 0, t = 0;
  for (; t < 2400 && w.A.type[h] === TYPE.SOLDIER && w.A.type[z] === TYPE.ZOMBIE; t++) { w.step(); if (w.A.tier[z] < minT) minT = w.A.tier[z]; }
  assert(minT === -1 && w.A.x[z] > 300, `a zombie goes through the tunnel under a building (x ${w.A.x[z].toFixed(0)})`);
  assert(w.sh2 !== null, 'the tunnel hash exists once someone is underground');
  let seen = 0;
  w.query(200, 200, 400, 1 << TYPE.ZOMBIE, () => { seen++; }, TIER_ALL);
  assert(seen >= 1, 'TIER_ALL also searches the tunnels');
}

// ---------------------------------------------------------------- 7. blasts and a destroyed deck
{
  const w = installCombat(world(mk([FLY, STREET], { water: [] }), ['civ.panicRadius=0']));
  battle(w);
  const top = w.spawn(TYPE.ZOMBIE, 200, 180, 0, 1), low = w.spawn(TYPE.ZOMBIE, 205, 180);
  w.A.stun[top] = w.A.stun[low] = 1e9;
  rebuildHash(w);
  w.damageArea(200, 180, 8, 1e6, { src: 'test' });
  assert(!w.A.type[top] && w.A.type[low] === TYPE.ZOMBIE, 'a small blast lands on the deck and spares the street under it');
  const top2 = w.spawn(TYPE.ZOMBIE, 200, 230, 0, 1), low2 = w.spawn(TYPE.ZOMBIE, 205, 230);
  w.A.stun[top2] = w.A.stun[low2] = 1e9;
  rebuildHash(w);
  w.damageArea(205, 230, 6, 1e6, { src: 'test', tier: 0 });
  assert(w.A.type[top2] === TYPE.ZOMBIE && !w.A.type[low2], 'o.tier puts a blast on the ground');
  w.damageArea(200, 230, 30, 1e6, { src: 'test' });
  assert(!w.A.type[top2], 'a big blast reaches the deck');
  const c = w.spawn(TYPE.CIV, 200, 200, 0, 1), g = w.spawn(TYPE.CIV, 210, 200);
  w.A.stun[c] = w.A.stun[g] = 1e9;
  rebuildHash(w);
  const id = w.bridges.findIndex((b) => b.deck);
  w.damageBridge(id, 1e9);
  assert(!w.bridges[id].alive && !w.A.type[c] && w.A.type[g] === TYPE.CIV, 'a destroyed deck: the resident on it falls, the one below lives');
  assert(w.nav.pass[fid(w, 1, 200, 200)] === 0 && w.grid.terrain[cellOf(w, 198, 150)] === T.RUBBLE, 'its nodes close and the open land under it is rubble');
  w.beginStage(0);
  assert(w.bridges[id].alive && w.nav.pass[fid(w, 1, 200, 200)] !== 0 && w.grid.terrain[cellOf(w, 198, 150)] === T.OPEN, 'the next stage start rebuilds it');
}
{
  const w = installCombat(world(RIVER, ['civ.panicRadius=0']));
  battle(w);
  const s = w.spawn(TYPE.ZOMBIE, 200, 200, 3, 1), n = w.spawn(TYPE.ZOMBIE, 200, 180, 0, 1);
  w.A.stun[s] = w.A.stun[n] = 1e9;
  rebuildHash(w);
  w.damageBridge(w.bridges.findIndex((b) => b.deck), 1e9);
  assert(w.A.type[s] === TYPE.ZOMBIE && w.A.tier[s] === 0 && !w.A.type[n], 'over water a swimmer drops into the river, a plain zombie is gone');
  assert(w.grid.terrain[cellOf(w, 200, 200)] === T.WATER, 'the river under a fallen deck is still water');
}

// ---------------------------------------------------------------- 8. determinism, retry
{
  const run = () => {
    const w = installCombat(new World(RIVER, { seed: 9, sandbox: true, mutators: ['population.scale=0', 'outbreak.zombies=40', 'outbreak.zombieScaleWithPop=false', 'outbreak.minDistFromZone=0'] }));
    w.exec({ t: 'zone.add', p: rectPoly(150, 300, 250, 390) });
    w.exec({ t: 'gate.add', x: 200, y: 300 });
    const snap = w.snapshot();
    w.exec({ t: 'ready' });
    for (let k = 0; k < 40; k++) { w.spawn(TYPE.CIV, 200, 140 + k * 3, 0, 1); w.spawn(TYPE.CIV, 120 + k, 60); }
    const hs = [];
    for (let k = 0; k < 600 && w.phase === 'battle'; k++) { w.step(); if (k % 100 === 99) hs.push(w.hash()); }
    let onDeck = 0;
    for (let i = 0; i < w.A.n; i++) if (w.A.type[i] && w.A.tier[i] > 0) onDeck++;
    w.restore(snap);
    return { hs: hs.join(','), restored: w.hash(), onDeck };
  };
  const a = run(), b = run();
  log('determinism', a.hs, 'on deck', a.onDeck);
  assert(a.hs === b.hs && a.restored === b.restored, 'two runs on a deck map give the same hashes, and restore matches');
}

console.log('decks: all passed');
