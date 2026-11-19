// Player units bought with money: placement per mount, pricing, paint mode, upgrades, refunds, C4, persistence.
// installCombat(world) wires units, abilities and vehicles into a World (commands, systems, serializer, events).
import { DEFAULTS } from '../data/config.js';
import { T } from '../map/format.js';
import { polyPerimeter, distToPolyline, rasterPolyline } from '../util/geom.js';
import { isWalkTerrain } from './nav.js';
import { LV_DECK, nodeAt } from './decks.js';
import {
  makeCombatState, combatSystem, resetCombatRuntime, unitStats, unitRange, initRuntime, indexAdd, lineCells,
  buildingAt, destroyUnit, detonate, onCollapse, onBridgeDown, placedReadyAt, kindOf,
} from './combat.js';
import { registerAbilityCommands, abilitySystem, resetAbilities, abilityState, ABILITY_INFO, squadMembers } from './abilities.js';
import { vehicleSystem, findPath, VEHICLE_NAMES, destroyVehicle } from './vehicles.js';
import { installNaval, canPlaceBoat, unitBlocked, boatStatus, ferryDest, waterOf } from './naval.js';

export { unitStats, unitRange, abilityState, ABILITY_INFO, squadMembers, findPath, VEHICLE_NAMES, unitBlocked, boatStatus, ferryDest, waterOf };

export const UNIT_INFO = {
  garrison: { name: 'Rooftop Garrison', desc: 'Riflemen on a roof. Taller buildings cost more and see further.' },
  sniper: { name: 'Marksman', desc: 'Long-range rifle on a roof. Picks off mutants first.' },
  turret: { name: 'Sentry Gun', desc: 'Automatic street gun with a huge belt. Restocks only near an arsenal on Supply.' },
  mortar: { name: 'Mortar Team', desc: 'Shells the densest crowd in range from a roof. Cannot hit anything close.' },
  gasMortar: { name: 'Gas Mortar', desc: 'Stuns the crowds it hits.' },
  fireMortar: { name: 'Incendiary Mortar', desc: 'Sets the target area alight. Fire burns everyone, friend or foe.' },
  mlrs: { name: 'Rocket Battery', desc: 'A wide rocket salvo, then a long wait for the next one.' },
  howitzer: { name: 'Field Howitzer', desc: 'Heavy gun that reaches almost anywhere. Each extra one costs more.' },
  battleship: { name: 'Battleship', desc: 'Moored on a large body of water. Unlimited shells.' },
  railgun: { name: 'Rail Cannon', desc: 'Drives a slug straight through every infected in its line.' },
  mine: { name: 'Land Mine', desc: 'Painted per cell. Explodes under the first infected.' },
  chemical: { name: 'Gas Canister', desc: 'Painted per cell. Releases a stunning cloud when stepped on.' },
  napalm: { name: 'Napalm Trap', desc: 'Bursts into flame when the infected come close.' },
  c4: { name: 'Demolition Charge', desc: 'Wired to a building or bridge. Detonate it by hand to bring it down.' },
  spikes: { name: 'Spike Strip', desc: 'Drawn as a line. Slows the infected until it wears out.' },
  oil: { name: 'Oil Slick', desc: 'Drawn as a line. Ignites a few seconds after the infected step in.' },
  patrolBoat: { name: 'Patrol Boat', short: 'Patrol Boat', desc: 'Fast launch with a machine gun. Patrols its water and shoots the shore and swimmers.' },
  gunboat: { name: 'Gunboat', short: 'Gunboat', desc: 'Slow and tough. A deck cannon with splash and a machine gun.' },
  rocketBarge: { name: 'Rocket Barge', short: 'Rkt Barge', desc: 'A rocket salvo at crowds from the water, then a long reload.' },
  ferry: { name: 'Evac Ferry', short: 'Ferry', desc: 'Boards residents on the shore and carries them to a zone on the water or out by river.' },
  waterMine: { name: 'Water Mine', short: 'W. Mines', desc: 'Painted on water. Explodes under the infected in the water.' },
};

const MAX_LINE_M = 600;
const GROUND_GAP = 5;   // minimum spacing between ground-mounted units (m)
const WATER_GAP = 30;   // minimum spacing between ships (m)
const r1 = (v) => Math.round(v * 10) / 10;
const fail = (reason, cost = 0) => ({ ok: false, reason, cost });
const phaseOk = (w) => w.phase === 'planning' || w.phase === 'battle';

// ---------------------------------------------------------------- pricing
export function countOwned(world, type, owner = 0) {
  let n = 0;
  for (const u of world.units) if (u.alive && u.type === type && (world.owners < 2 || u.owner === owner)) n++;
  return n;
}

function basePrice(world, def, b, n) {
  const c = def.cost;
  if (typeof c !== 'function') return +c || 0;
  return c.length >= 2 ? c(world, n) : c(world.buildings[b] || { h: 0, area: 0 });
}

function priceFor(world, type, x, y, owner, b, n) {
  const def = world.cfg.units[type];
  return Math.round(basePrice(world, def, b, n) * world.costMul(x, y, owner, b));
}

// Price of one unit at (x, y) in whole dollars with every multiplier (zone / outside / Budget / Reduced cost / count).
// Line units: the price of one meter, unrounded.
export function unitCost(world, type, x, y, owner = 0) {
  const def = world.cfg.units[type];
  if (!def) return 0;
  if (def.mount === 'line') return (+def.cost || 0) * world.costMul(x, y, owner);
  const b = def.mount === 'building' || def.mount === 'building|bridge' ? buildingAt(world, x, y) : -1;
  return priceFor(world, type, x, y, owner, b, countOwned(world, type, owner));
}

function unitAllowed(world, type) {
  if (world.sandbox) return '';
  if (!world.isUnlocked(type)) return 'Not unlocked yet';
  const lo = world.loadout && world.loadout.units;
  if (lo && lo.some(Boolean) && !lo.includes(type)) return 'Not in your loadout';
  return '';
}

// ---------------------------------------------------------------- placement validity
function walkable(world, c) {
  return isWalkTerrain(world.grid.terrain[c]) && !(world.block[c] && world.wallHp[c] > 0);
}

function tooClose(world, x, y, gap, mount) {
  for (const u of world.units) {
    if (!u.alive) continue;
    const m = world.cfg.units[u.type].mount;
    if (m !== mount) continue;
    const dx = u.x - x, dy = u.y - y;
    if (dx * dx + dy * dy < gap * gap) return true;
  }
  return false;
}

// A water bridge at cell c, or the top standing deck over it (which wins: it is what the player sees there).
function bridgeAt(world, c) {
  const g = world.grid, dk = g.deck;
  if (dk && (dk.lvf[c] & LV_DECK)) {
    for (let t = 3; t >= 1; t--) {
      const f = nodeAt(dk, t, c % g.gw, (c / g.gw) | 0), sid = f >= 0 ? dk.sid[f - dk.N] : -1;
      if (sid >= 0 && world.bridges[sid] && world.bridges[sid].alive) return sid;
    }
  }
  const br = g.bridgeId[c] - 1;
  return br >= 0 && g.terrain[c] === T.BRIDGE && world.bridges[br] && world.bridges[br].alive ? br : -1;
}

// Can a unit of `type` go at (x, y)? Returns { ok, reason, b, bridge, x, y } with the snapped position. Money is not checked.
export function canPlace(world, type, x, y, owner = 0) {
  const def = world.cfg.units[type];
  if (!def) return fail('Unknown unit');
  if (!phaseOk(world)) return fail('Stage is over');
  x = +x; y = +y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('Pick a spot');
  const g = world.grid, c = world.cellAt(x, y);
  if (c < 0) return fail('Outside the map');
  if (!world.region.mask[c]) return fail('Outside the stage boundary');
  const C = world.combat, terr = g.terrain[c];
  const cellX = (c % g.gw + 0.5) * g.cell, cellY = (((c / g.gw) | 0) + 0.5) * g.cell;
  switch (def.mount) {
    case 'building': {
      const b = buildingAt(world, x, y);
      if (b < 0) return fail('Place it on a building');
      const bd = world.buildings[b];
      if (bd.unitId >= 0 && C.byId.has(bd.unitId)) return fail('That building is already manned');
      return { ok: true, reason: '', b, bridge: -1, x: bd.cx, y: bd.cy, cell: c };
    }
    case 'building|bridge': {
      const deckBr = g.deck ? bridgeAt(world, c) : -1;
      const b = deckBr >= 0 && world.bridges[deckBr].deck ? -1 : buildingAt(world, x, y);
      if (b >= 0) {
        if (C.c4At.has('b' + b)) return fail('That building is already wired');
        const bd = world.buildings[b];
        return { ok: true, reason: '', b, bridge: -1, x: bd.cx, y: bd.cy, cell: c };
      }
      const br = bridgeAt(world, c);
      if (br >= 0) {
        if (C.c4At.has('r' + br)) return fail('That bridge is already wired');
        return { ok: true, reason: '', b: -1, bridge: br, x: world.bridges[br].cx, y: world.bridges[br].cy, cell: c };
      }
      return fail('Place it on a building or a bridge');
    }
    case 'water': {
      if (def.boat) return canPlaceBoat(world, type, x, y, c);
      if (terr !== T.WATER) return fail('Place it on open water');
      const area = g.waterBodies.area[g.waterBodies.id[c]] || 0;
      if (area < (def.minWaterM2 || 0)) return fail(`Needs open water of at least ${Math.round(def.minWaterM2).toLocaleString('en-US')} m²`);
      if (tooClose(world, x, y, WATER_GAP, 'water')) return fail('Too close to another ship');
      return { ok: true, reason: '', b: -1, bridge: -1, x: r1(x), y: r1(y), cell: c };
    }
    case 'brush': {
      if (def.water ? terr !== T.WATER : !walkable(world, c)) return fail(def.water ? 'Water mines go on open water' : 'Traps go on streets and open ground');
      if (C.brushAt.has(c)) return fail('There is already a trap here');
      return { ok: true, reason: '', b: -1, bridge: bridgeAt(world, c), x: cellX, y: cellY, cell: c };
    }
    case 'line': {
      if (!walkable(world, c)) return fail('Lines go on streets and open ground');
      return { ok: true, reason: '', b: -1, bridge: -1, x: r1(x), y: r1(y), cell: c };
    }
    default: {
      if (terr === T.WATER) return fail('Cannot be placed on water');
      if (!walkable(world, c)) return fail('Place it on a street or open ground');
      if (tooClose(world, x, y, GROUND_GAP, def.mount)) return fail('Too close to another unit');
      return { ok: true, reason: '', b: -1, bridge: bridgeAt(world, c), x: r1(x), y: r1(y), cell: c };
    }
  }
}

function lineQuote(world, type, p, owner) {
  const def = world.cfg.units[type];
  if (!Array.isArray(p) && !ArrayBuffer.isView(p)) return fail('Draw a line');
  p = Array.from(p, Number);
  if (p.length < 4 || p.length % 2 || !p.every(Number.isFinite)) return fail('Draw a line');
  const len = polyPerimeter(p, false);
  if (len < 4) return fail('Too short');
  if (len > MAX_LINE_M) return fail(`At most ${MAX_LINE_M} m per line`);
  let mx = 0, my = 0;
  for (let i = 0; i < p.length; i += 2) {
    const c = world.cellAt(p[i], p[i + 1]);
    if (c < 0 || !world.region.mask[c]) return fail('Must be inside the stage boundary');
    mx += p[i]; my += p[i + 1];
  }
  mx /= p.length / 2; my /= p.length / 2;
  const cells = lineCells(world, type, p);
  if (!cells.length) return fail('Nothing to cover: lines go on streets and open ground');
  const cost = Math.round((def.perM ? def.cost * len : def.cost) * world.costMul(mx, my, owner));
  if (!world.canAfford(cost, owner)) return fail('Not enough money', cost);
  return { ok: true, reason: '', cost, p: p.map(r1), cells, len, x: r1(mx), y: r1(my), b: -1, bridge: -1 };
}

// ---------------------------------------------------------------- creation
function createUnit(world, type, owner, at, cost) {
  const def = world.cfg.units[type];
  const u = {
    id: world.nextId(), type, owner, x: at.x, y: at.y, b: at.b ?? -1, bridge: at.bridge ?? -1, level: 1, paid: cost, base: cost,
    ups: def.ups || [],
  };
  if (at.p) { u.p = at.p; u.cells = at.cells || lineCells(world, type, at.p); }
  if (def.mount === 'brush') u.cell = world.cellAt(u.x, u.y);
  initRuntime(world, u);
  if (world.phase === 'battle') u.readyAt = placedReadyAt(world, u);
  world.units.push(u);
  indexAdd(world, u);
  world.spend(cost, owner, type);
  return u;
}

function placeQuote(world, cmd) {
  const type = cmd.type, def = world.cfg.units[type], owner = cmd.owner | 0;
  if (!def) return fail('Unknown unit');
  if (!phaseOk(world)) return fail('Stage is over');
  const why = unitAllowed(world, type);
  if (why) return fail(why);
  if (def.mount === 'line') return lineQuote(world, type, cmd.p || [cmd.x, cmd.y, cmd.x2, cmd.y2], owner);
  const at = canPlace(world, type, cmd.x, cmd.y, owner);
  if (!at.ok) return { ...at, cost: 0 };
  const cost = priceFor(world, type, at.x, at.y, owner, at.b, countOwned(world, type, owner));
  if (!world.canAfford(cost, owner)) return fail('Not enough money', cost);
  return { ...at, cost };
}

function placeExec(world, cmd, q) {
  const u = createUnit(world, cmd.type, cmd.owner | 0, q, q.cost);
  return { ok: true, id: u.id, cost: q.cost };
}

// Paint mode: every building (building units) or every cell (brush units) the stroke sweeps; line units draw one line.
function paintQuote(world, cmd) {
  const type = cmd.type, def = world.cfg.units[type], owner = cmd.owner | 0;
  if (!def) return fail('Unknown unit');
  if (!phaseOk(world)) return fail('Stage is over');
  const why = unitAllowed(world, type);
  if (why) return fail(why);
  const path = cmd.path || cmd.p;
  if (def.mount === 'line') return lineQuote(world, type, path, owner);
  if (!(def.paint || def.mount === 'brush')) return fail('This unit cannot be painted');
  const g = world.grid, cells = [];
  if (Array.isArray(cmd.cells) || ArrayBuffer.isView(cmd.cells)) for (const c of cmd.cells) cells.push(c | 0);
  else if (Array.isArray(path) && path.length >= 2 && path.every(Number.isFinite)) {
    const seen = new Set(), w = Math.max(g.cell, +cmd.w || g.cell);
    const put = (c) => { if (!seen.has(c)) { seen.add(c); cells.push(c); } };
    if (path.length < 4) { const c = world.cellAt(path[0], path[1]); if (c >= 0) put(c); }
    else rasterPolyline(path, w, g.cell, g.gw, g.gh, put);
  } else return fail('Paint over the map');
  const items = [];
  const taken = new Set();
  let total = 0, n = countOwned(world, type, owner), reason = '';
  const avail = world.available(owner);
  for (const c of cells) {
    if (c < 0 || c >= g.gw * g.gh) continue;
    const x = (c % g.gw + 0.5) * g.cell, y = (((c / g.gw) | 0) + 0.5) * g.cell;
    if (def.mount === 'building') { const b = g.bldg[c] - 1; if (b < 0 || taken.has(b)) continue; taken.add(b); }
    else if (taken.has(c)) continue; else taken.add(c);
    const at = canPlace(world, type, x, y, owner);
    if (!at.ok) { if (!reason) reason = at.reason; continue; }
    const cost = priceFor(world, type, at.x, at.y, owner, at.b, n);
    if (!world.sandbox && total + cost > avail + 1e-6) { reason = 'Not enough money'; break; }
    total += cost; n++;
    items.push({ ...at, cost });
  }
  if (!items.length) return fail(reason || 'Nothing to place here');
  return { ok: true, reason: '', cost: total, count: items.length, items };
}

function paintExec(world, cmd, q) {
  const owner = cmd.owner | 0;
  if (!q.items) { const u = createUnit(world, cmd.type, owner, q, q.cost); return { ok: true, ids: [u.id], count: 1, cost: q.cost }; }
  const ids = [];
  let cost = 0;
  for (const it of q.items) {
    const at = canPlace(world, cmd.type, it.x, it.y, owner);
    if (!at.ok) continue;
    ids.push(createUnit(world, cmd.type, owner, at, it.cost).id);
    cost += it.cost;
  }
  return { ok: ids.length > 0, ids, count: ids.length, cost, reason: ids.length ? '' : 'Nothing placed' };
}

// ---------------------------------------------------------------- upgrades
export function nextUpgradeStat(unit) {
  if (!unit) return null;
  const ups = unit.ups || (DEFAULTS.units[unit.type] && DEFAULTS.units[unit.type].ups) || [];
  const up = ups[(unit.level || 1) - 1];
  return up && (unit.level || 1) < 5 ? [up[0], up[1]] : null;
}

// { cost, stat, mul, next, locked, max } for the info card; cost is null when no upgrade can be bought.
export function upgradeInfo(world, unit) {
  const up = nextUpgradeStat(unit), next = (unit.level || 1) + 1;
  if (!up) return { cost: null, stat: null, mul: 1, next, locked: false, max: true };
  const locked = next > 2 && !world.sandbox && !world.isUnlocked('upgrade' + next);
  const cost = Math.round((unit.base || 0) * Math.pow(1.5, next - 1));
  return { cost: locked || unit.alive === false ? null : cost, stat: up[0], mul: up[1], next, locked, max: false };
}

export function upgradeCost(world, unit) { return upgradeInfo(world, unit).cost; }

function ownedUnit(world, cmd) {
  const u = world.combat.byId.get(cmd.id);
  if (!u || !u.alive) return [null, 'No such unit'];
  if (world.owners > 1 && u.owner !== (cmd.owner | 0)) return [null, 'That unit belongs to your partner'];
  return [u, ''];
}

function upgradeQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const [u, why] = ownedUnit(world, cmd);
  if (!u) return fail(why);
  const info = upgradeInfo(world, u);
  if (info.max) return fail(nextUpgradeStat({ ...u, level: 1 }) ? 'Fully upgraded' : 'Cannot be upgraded');
  if (info.locked) return fail(`Upgrade tier ${['', 'I', 'II', 'III', 'IV', 'V'][info.next]} is locked`);
  if (!world.canAfford(info.cost, u.owner)) return fail('Not enough money', info.cost);
  return { ok: true, reason: '', cost: info.cost, stat: info.stat, level: info.next };
}

function upgradeExec(world, cmd, q) {
  const u = world.combat.byId.get(cmd.id);
  const before = unitStats(world, u, false);
  u.level++;
  u.paid += q.cost;
  u._s = null;
  world.spend(q.cost, u.owner, u.type);
  const after = unitStats(world, u, false);
  if (after.mag !== before.mag) { u.mag = after.mag; if (u.reloadT <= 0) u.ammo = Math.min(u.mag, u.ammo + (after.mag - before.mag)); }
  if (Number.isFinite(after.reloads) && after.reloads !== before.reloads) u.reloads += after.reloads - before.reloads;
  if (after.hp && after.hp !== before.hp) { u.hp = u.hpMax > 0 ? u.hp * after.hp / u.hpMax : after.hp; u.hpMax = after.hp; }
  if (kindOf(world, u.type) === 'spikes' && after.durability !== before.durability) for (let k = 0; k < u.dur.length; k++) if (u.dur[k] > 0) u.dur[k] *= after.durability / before.durability;
  return { ok: true, id: u.id, level: u.level, stat: q.stat, cost: q.cost };
}

// ---------------------------------------------------------------- refund / detonate
function refundQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const [u, why] = ownedUnit(world, cmd);
  if (!u) return fail(why);
  return { ok: true, reason: '', cost: 0, refund: world.refundValue(u.paid) };
}

function refundExec(world, cmd) {
  const u = world.combat.byId.get(cmd.id);
  const got = world.refundPlacement(u, u.type);
  destroyUnit(world, u, 'consumed');
  const k = world.units.indexOf(u);
  if (k >= 0) world.units.splice(k, 1);
  return { ok: true, id: u.id, refund: got };
}

function detonateQuote(world, cmd) {
  if (world.phase !== 'battle') return fail('Charges are detonated once the outbreak starts');
  const [u, why] = ownedUnit(world, cmd);
  if (!u) return fail(why);
  if (kindOf(world, u.type) !== 'charge') return fail('Not a demolition charge');
  return { ok: true, reason: '', cost: 0 };
}

function detonateExec(world, cmd) {
  const u = world.combat.byId.get(cmd.id);
  const kills = detonate(world, u);
  return { ok: true, id: u.id, kills };
}

// ---------------------------------------------------------------- picking helpers for tools
// Nearest live unit under (x, y): building units by their building, lines by distance to the line, others within r.
export function unitAt(world, x, y, r = 6) {
  const b = buildingAt(world, x, y);
  let best = null, bd = r;
  for (const u of world.units) {
    if (!u.alive) continue;
    let d;
    if (u.b >= 0 && b === u.b) d = 0;
    else if (u.p) d = distToPolyline(u.p, x, y);
    else if (u.bridge >= 0 && kindOf(world, u.type) === 'charge') d = Math.hypot(u.x - x, u.y - y) - 8;
    else if (u.b >= 0) continue;
    else d = Math.hypot(u.x - x, u.y - y) - (u.veh ? Math.max(0, u.veh.selR - 4) : 0);
    if (d <= bd) { bd = d; best = u; }
  }
  return best;
}

export function unitsInRect(world, x0, y0, x1, y1) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  return world.units.filter((u) => u.alive && u.x >= ax && u.x <= bx && u.y >= ay && u.y <= by);
}

// ---------------------------------------------------------------- persistence and stage reset
function save(world) {
  return world.units.filter((u) => u.alive).map((u) => {
    // a boat's x, y follow it around; its mooring (hx, hy) is what gets saved
    const o = { id: u.id, type: u.type, x: u.hx ?? u.x, y: u.hy ?? u.y, b: u.b, bridge: u.bridge, owner: u.owner, level: u.level, paid: u.paid, base: u.base };
    if (u.p) o.p = u.p.slice();
    return o;
  });
}

function clearIndex(world) {
  const C = world.combat;
  C.byId.clear(); C.brushAt.clear(); C.c4At.clear(); C.spikeAt.clear(); C.oilAt.clear();
  if (C.lineMask) C.lineMask.fill(0);
  C.lineCount = 0; C.snipers = 0;
  for (const b of world.buildings) b.unitId = -1;
}

// Line cells are recomputed from the drawn polyline in placement order, so a restored board matches a fresh one.
function adopt(world, u) {
  const def = world.cfg.units[u.type];
  u.ups = def.ups || [];
  if (u.p) u.cells = lineCells(world, u.type, u.p);
  if (def.mount === 'brush') u.cell = world.cellAt(u.x, u.y);
  initRuntime(world, u);
  indexAdd(world, u);
}

function load(world, data) {
  clearIndex(world);
  world.units = [];
  for (const d of Array.isArray(data) ? data : []) {
    if (!world.cfg.units[d.type]) continue;
    const u = { id: d.id, type: d.type, owner: d.owner | 0, x: d.x, y: d.y, b: d.b ?? -1, bridge: d.bridge ?? -1, level: Math.max(1, d.level | 0),
      paid: +d.paid || 0, base: +d.base || +d.paid || 0 };
    if (d.p) u.p = d.p.slice();
    world.units.push(u);
    adopt(world, u);
  }
}

// Stage start: destroyed units are gone for good, the rest are restocked and repaired.
function resetStage(world) {
  world.units = world.units.filter((u) => u.alive);
  clearIndex(world);
  for (const u of world.units) adopt(world, u);
  resetCombatRuntime(world);
  resetAbilities(world);
}

export function installCombat(world) {
  if (world.combat) return world;
  const C = world.combat = makeCombatState();
  C.names = Object.fromEntries(Object.entries(UNIT_INFO).map(([k, v]) => [k, v.name]));
  C.dropVehicle = (v) => destroyVehicle(world, v);
  if (typeof world.isUnlocked !== 'function') world.isUnlocked = () => true;
  world.squads = C.squads;
  world.strikes = C.pending;
  const reg = (name, quote, exec) => world.registerCommand(name, { quote, exec });
  reg('unit.place', placeQuote, placeExec);
  reg('unit.paint', paintQuote, paintExec);
  reg('unit.upgrade', upgradeQuote, upgradeExec);
  reg('unit.refund', refundQuote, refundExec);
  reg('unit.detonate', detonateQuote, detonateExec);
  registerAbilityCommands(world);
  world.registerSystem({ name: 'combat', order: 60, update: (w, dt) => combatSystem(w, dt), reset: (w) => resetStage(w) });
  world.registerSystem({ name: 'support', order: 61, update: (w, dt) => { abilitySystem(w); vehicleSystem(w, dt); } });
  world.registerSerializer('combat', { save, load });
  installNaval(world);
  world.events.on('collapse', (e) => onCollapse(world, e));
  world.events.on('bridgeDown', (e) => onBridgeDown(world, e));
  resetStage(world);
  return world;
}
