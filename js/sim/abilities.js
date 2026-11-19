// Abilities bought with command points: targeting, unlock timers, delayed delivery, squads and their effects.
import { clamp } from '../util/geom.js';
import { CIV, POLICE, MILITIA, SOLDIER, CS, M_CIV, M_ZOMBIE, M_TURNING, M_ARMED, M_ALL, SQUAD_GROUP, TIER_ALL } from './agents.js';
import { P_CIV, nearestPassable } from './nav.js';
import { abilityKey, buildingAt, queueShell, destroyUnit, sound, log } from './combat.js';
import {
  edgePoint, landingCell, spawnArmour, spawnBus, spawnMedevac, spawnDozer, spawnHeli, spawnGunship, destroyVehicle,
} from './vehicles.js';

export const ABILITY_INFO = {
  paratroopers: { name: 'Paratroopers', desc: 'An airborne squad drops on the point. Switch it between Hunt and Guard.' },
  callToArms: { name: 'Call to Arms', desc: 'Arms the civilians inside the circle. Armed citizens no longer count as saved.' },
  seekDestroy: { name: 'Seek & Destroy', desc: 'Empties a garrison into police officers who hunt the infected. More ammunition, more officers.' },
  apc: { name: 'Armoured Carrier', desc: 'A machine-gun carrier patrols around the point and runs down the infected nearby.' },
  bus: { name: 'Evacuation Bus', desc: 'Pulls up at the point, boards civilians and drives them out of the city.' },
  medevac: { name: 'Medevac', desc: 'A helicopter lands at the point and flies civilians out.' },
  bulldozer: { name: 'Bulldozer', desc: 'Drives along the line, crushing the infected, pushing over buildings and clearing rubble.' },
  rally: { name: 'Rally Point', desc: 'Armed responders nearby regroup at the point and hold it for a while.' },
  demolition: { name: 'Controlled Demolition', desc: 'Topples a building toward the side you pick. Its neighbours may follow.' },
  fireBomb: { name: 'Fire Bomb', desc: 'An incendiary drop that sets the area alight. Burns everyone.' },
  cruise: { name: 'Cruise Missile', desc: 'A heavy warhead that wrecks buildings and drops bridges.' },
  helicopter: { name: 'Attack Helicopter', desc: 'Hunts around the point until out of ammunition, rearms at the map edge and comes back.' },
  gasBomb: { name: 'Gas Bomb', desc: 'Stuns every infected inside the cloud.' },
  tank: { name: 'Battle Tank', desc: 'Cannon, machine gun and tracks. Crushes the infected it drives over.' },
  airstrike: { name: 'Airstrike', desc: 'A bomber lays heavy bombs along the line you draw.' },
  clusterBomb: { name: 'Cluster Bomb', desc: 'Dozens of bomblets saturate the area.' },
  gunship: { name: 'Gunship', desc: 'Circles the point with heavy and light cannon for a minute.' },
  cure: { name: 'Cure', desc: 'Turns every infected in the circle back into a civilian.' },
  nuke: { name: 'Nuclear Strike', desc: 'Lands long after the order. Nothing in the core survives; the blast reaches far beyond.' },
};

// Abilities whose payload needs walkable ground at the target.
const NEEDS_GROUND = new Set(['paratroopers', 'apc', 'bus', 'tank', 'medevac']);
const PLANE_SPEED = 120;
const GROUP_BASE = SQUAD_GROUP; // squad group ids stay clear of building indices (police stations use their building index)

export function abilityState(world, id) {
  const a = world.cfg.abilities[id];
  if (!a) return null;
  const C = world.combat;
  const charges = Math.max(0, world.charges[id] | 0);
  const battle = world.phase === 'battle';
  const unlockIn = battle ? Math.max(0, a.unlock - world.t) : a.unlock;
  let pending = 0, nextAt = -1;
  for (const p of C.pending) if (p.ability === id) { pending++; if (nextAt < 0 || p.at < nextAt) nextAt = p.at; }
  return {
    id, charges, unlockIn, ready: battle && charges > 0 && unlockIn <= 0, delay: a.delay, target: a.target, sp: a.sp,
    maxR: a.maxR || a.radius || 0, pending, deliveryIn: nextAt >= 0 ? Math.max(0, nextAt - world.t) : -1,
  };
}

function fail(reason) { return { ok: false, reason, cost: 0 }; }

function resolveTarget(world, id, a, cmd) {
  const C = world.combat;
  if (a.target === 'garrison') {
    let u = cmd.unit !== undefined ? C.byId.get(cmd.unit) : null;
    if (!u && Number.isFinite(+cmd.x)) { const b = buildingAt(world, +cmd.x, +cmd.y); const bd = world.buildings[b]; if (bd) u = C.byId.get(bd.unitId); }
    if (!u || !u.alive || u.type !== 'garrison') return fail('Pick a garrison');
    if (world.owners > 1 && u.owner !== (cmd.owner | 0)) return fail("That is your partner's garrison");
    return { ok: true, cost: 0, x: u.x, y: u.y, unit: u.id, b: u.b };
  }
  const x = +cmd.x, y = +cmd.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('Pick a target');
  const c = world.cellAt(x, y);
  if (c < 0 || !world.region.mask[c]) return fail('Outside the stage boundary');
  if (a.target === 'building') {
    const b = buildingAt(world, x, y);
    if (b < 0) return fail('Pick a standing building');
    const bd = world.buildings[b];
    let dx = Number.isFinite(+cmd.x2) ? +cmd.x2 - x : x - bd.cx, dy = Number.isFinite(+cmd.y2) ? +cmd.y2 - y : y - bd.cy;
    const L = Math.hypot(dx, dy);
    if (L > 1e-3) { dx /= L; dy /= L; } else { dx = 0; dy = 0; }
    return { ok: true, cost: 0, x: bd.cx, y: bd.cy, b, dx, dy };
  }
  if (a.target === 'circle') {
    const r = Number.isFinite(+cmd.r) && +cmd.r > 0 ? +cmd.r : Number.isFinite(+cmd.x2) ? Math.hypot(+cmd.x2 - x, +cmd.y2 - y) : a.maxR;
    return { ok: true, cost: 0, x, y, r: clamp(r || a.maxR, 10, a.maxR) };
  }
  if (a.target === 'line') {
    const x2 = +cmd.x2, y2 = +cmd.y2;
    if (!Number.isFinite(x2) || !Number.isFinite(y2) || Math.hypot(x2 - x, y2 - y) < 4) return fail('Drag out a direction');
    if (id === 'bulldozer') {
      const s = landingCell(world, x, y, 3);
      if (!s) return fail('Start the line on open ground');
      return { ok: true, cost: 0, x: s[0], y: s[1], x2, y2 };
    }
    return { ok: true, cost: 0, x, y, x2, y2 };
  }
  if (NEEDS_GROUND.has(id)) {
    // on a deck: land on it
    const g = world.grid;
    if (g.deck && world.surfaceAt(x, y) > 0) return { ok: true, cost: 0, x: (Math.floor(x / g.cell) + 0.5) * g.cell, y: (Math.floor(y / g.cell) + 0.5) * g.cell };
    const s = landingCell(world, x, y, id === 'medevac' ? 8 : 12);
    if (!s) return fail(id === 'medevac' ? 'No landing zone there' : 'No room to land there');
    return { ok: true, cost: 0, x: s[0], y: s[1] };
  }
  return { ok: true, cost: 0, x, y };
}

// ---------------------------------------------------------------- squads
function newSquad(world, kind, x, y, owner, stats, mode) {
  const C = world.combat;
  const group = GROUP_BASE + C.nextGroup++;
  world.setGroupStats(group, { ...stats, key: abilityKey(kind) });
  const sq = { group, kind, x, y, owner, mode, size: 0 };
  C.squads.push(sq);
  return sq;
}

function enlist(world, i, sq, type) {
  const A = world.A;
  const s = world.armedStats(type, sq.group);
  A.group[i] = sq.group; A.owner[i] = sq.owner; A.state[i] = sq.mode === 'guard' ? 0 : 1;
  A.hp[i] = s.hp; A.ammo[i] = s.ammo === undefined || s.ammo === Infinity ? -1 : s.ammo;
  A.cd[i] = 0; A.tgt[i] = -1; A.timer[i] = 0; A.pc[i] = -1;
  A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i];
  sq.size++;
}

// air: dropped from above, so a man over a deck lands on it
function spawnSquad(world, sq, type, n, x, y, spread, air = false) {
  const g = world.grid, rng = world.rng;
  let made = 0;
  for (let k = 0; k < n; k++) {
    const a = rng.next() * Math.PI * 2, r = spread * Math.sqrt(rng.next());
    if (air && g.deck) {
      const qx = x + Math.cos(a) * r, qy = y + Math.sin(a) * r, t = world.surfaceAt(qx, qy);
      if (t > 0) {
        const i = world.spawn(type, qx, qy, 0, t);
        if (i < 0) break;
        enlist(world, i, sq, type);
        made++;
        continue;
      }
    }
    const c = nearestPassable(world, x + Math.cos(a) * r, y + Math.sin(a) * r, P_CIV, 8);
    if (c < 0) continue;
    const px = (c % g.gw + 0.5) * g.cell + rng.range(-1.2, 1.2), py = (((c / g.gw) | 0) + 0.5) * g.cell + rng.range(-1.2, 1.2);
    const i = world.spawn(type, px, py);
    if (i < 0) break;
    enlist(world, i, sq, type);
    made++;
  }
  return made;
}

export function squadMembers(world, group) {
  const A = world.A;
  let n = 0;
  for (let i = 0; i < A.n; i++) if (A.type[i] >= POLICE && A.group[i] === group) n++;
  return n;
}

// ---------------------------------------------------------------- effects
function planeOver(world, x, y, dx, dy, half = 320, t0 = world.t, label) {
  const dur = (2 * half) / PLANE_SPEED;
  world.effects.push({ kind: 'plane', x: x - dx * half, y: y - dy * half, x2: x + dx * half, y2: y + dy * half, r: 12, t0, dur, ability: label });
  sound(world, 'plane', x, y, 0.6, 10);
}

function inboundDir(world, x, y) {
  const [ex, ey] = edgePoint(world, x, y, 0);
  let dx = x - ex, dy = y - ey;
  const L = Math.hypot(dx, dy);
  if (L < 1e-3) return [1, 0];
  return [dx / L, dy / L];
}

function airstrikeBombs(world, p, a) {
  const key = abilityKey('airstrike');
  let dx = p.x2 - p.x, dy = p.y2 - p.y;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L; dy /= L;
  const n = Math.max(1, a.bombs | 0), len = a.length || 240;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n, bx = p.x + dx * len * f, by = p.y + dy * len * f, dur = len * f / PLANE_SPEED;
    world.projectiles.push({ kind: 'bomb', x0: p.x - dx * 20, y0: p.y - dy * 20, x1: bx, y1: by, t0: world.t, dur, src: key });
    queueShell(world, bx, by, dur, { r: a.splash, dmg: a.dmg, src: key, friendly: true, bldgDmg: a.bldgDmg || 0, bridgeDmg: a.bridgeDmg || 0,
      wallDmg: a.dmg, fx: 'boom', fxR: a.splash * 1.3, fxDur: 0.9 });
  }
}

function nukeDetonate(world, p, a) {
  const key = abilityKey('nuke'), R = a.radius, core = R * (a.coreFrac || 0.35), x = p.x, y = p.y, rng = world.rng, A = world.A;
  world.effects.push({ kind: 'nuke', x, y, r: R, t0: world.t, dur: 8, core });
  world.events.emit('nuke', { x, y, at: world.t, r: R, core });
  world.events.emit('sound', { name: 'nuke', x, y, vol: 1 });
  log(world, 'NUCLEAR DETONATION', 'alert', x, y);
  const hits = [];
  world.query(x, y, R, M_ALL, (i, d2) => { hits.push(i, d2); }, TIER_ALL);
  for (let k = 0; k < hits.length; k += 2) {
    const i = hits[k];
    if (!A.type[i]) continue;
    const d = Math.sqrt(hits[k + 1]);
    if (d > core && rng.next() >= 1 - (d - core) / (R - core)) continue;
    A.shield[i] = 0;
    world.damageAgent(i, 1e9, key);
  }
  for (const b of world.buildings) {
    if (!b.alive) continue;
    const dx = b.cx - x, dy = b.cy - y, d = Math.hypot(dx, dy), e = Math.max(0, d - b.r);
    if (e > R) continue;
    if (e <= core) world.collapseBuilding(b.idx, dx, dy, key);
    else world.damageBuilding(b.idx, b.hpMax * 1.5 * (1 - (e - core) / (R - core)), key, dx, dy);
  }
  for (const br of world.bridges) {
    if (!br.alive) continue;
    const d = Math.max(0, Math.hypot(br.cx - x, br.cy - y) - br.len * 0.5);
    if (d > R) continue;
    world.damageBridge(br.idx, d <= core ? br.hpMax * 10 : br.hpMax * 1.5 * (1 - (d - core) / (R - core)));
  }
  world.damageWallsArea(x, y, R, world.cfg.wall.hp * 0.8);
  world.damageWallsArea(x, y, core, 1e9);
  for (const u of world.units) {
    if (!u.alive) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d <= core || (d <= R && rng.next() < 1 - (d - core) / (R - core))) destroyUnit(world, u, 'nuke');
  }
  for (const v of world.vehicles) {
    if (!v.alive || v.offmap) continue;
    const d = Math.hypot(v.x - x, v.y - y);
    if (d <= core || (d <= R && rng.next() < 1 - (d - core) / (R - core))) destroyVehicle(world, v);
  }
}

function deliver(world, p) {
  const id = p.ability, a = world.cfg.abilities[id], key = abilityKey(id), t = world.t;
  switch (id) {
    case 'paratroopers': {
      const sq = newSquad(world, id, p.x, p.y, p.owner, a.soldier, 'hunt');
      const n = spawnSquad(world, sq, SOLDIER, a.squad || 20, p.x, p.y, 14, true);
      world.effects.push({ kind: 'drop', x: p.x, y: p.y, r: 16, t0: t, dur: 1.5, ability: id });
      log(world, `PARATROOPERS DOWN: ${n} SOLDIERS`, 'info', p.x, p.y);
      break;
    }
    case 'apc': case 'tank': {
      const dt = world.surfaceAt(p.x, p.y), s = dt > 0 ? [p.x, p.y] : landingCell(world, p.x, p.y, 12);
      if (!s) { log(world, 'DELIVERY ABORTED: NO ROOM TO LAND', 'warn', p.x, p.y); world.charges[id] = (world.charges[id] | 0) + 1; break; }
      spawnArmour(world, id, a, s[0], s[1], p.owner, dt);
      log(world, id === 'tank' ? 'TANK ON STATION' : 'ARMOURED CARRIER ON STATION', 'info', s[0], s[1]);
      break;
    }
    case 'bulldozer':
      spawnDozer(world, a, p.x, p.y, p.x2, p.y2, p.owner);
      log(world, 'BULLDOZER MOVING OUT', 'info', p.x, p.y);
      break;
    case 'demolition': {
      const bd = world.buildings[p.b];
      if (!bd || !bd.alive) break;
      world.effects.push({ kind: 'boom', x: bd.cx, y: bd.cy, r: bd.r * 0.8, t0: t, dur: 0.6 });
      world.collapseBuilding(p.b, p.dx, p.dy, key);
      break;
    }
    case 'fireBomb':
      world.ignite(p.x, p.y, a.radius, 1, key);
      world.damageArea(p.x, p.y, a.radius, a.dmg, { src: key, friendly: true, wallDmg: a.dmg });
      world.effects.push({ kind: 'fireburst', x: p.x, y: p.y, r: a.radius, t0: t, dur: 1.5 });
      sound(world, 'fire', p.x, p.y, 0.9, 1);
      break;
    case 'gasBomb':
      world.damageArea(p.x, p.y, a.radius, 0, { src: key, stunSec: a.stunSec });
      world.effects.push({ kind: 'gas', x: p.x, y: p.y, r: a.radius, t0: t, dur: a.stunSec });
      sound(world, 'hiss', p.x, p.y, 0.8, 1);
      break;
    case 'cruise':
      world.damageArea(p.x, p.y, a.splash, a.dmg, { src: key, friendly: true, bldgDmg: a.bldgDmg, bridgeDmg: a.bridgeDmg, wallDmg: a.dmg });
      world.effects.push({ kind: 'boom', x: p.x, y: p.y, r: a.splash * 1.5, t0: t, dur: 1.2 });
      sound(world, 'explosion', p.x, p.y, 1, 1);
      break;
    case 'airstrike': airstrikeBombs(world, p, a); break;
    case 'clusterBomb': {
      const rng = world.rng, n = Math.max(1, a.bomblets | 0);
      world.projectiles.push({ kind: 'bomb', x0: p.x - p.dx * 40, y0: p.y - p.dy * 40, x1: p.x, y1: p.y, t0: t, dur: 0.4, src: key });
      for (let k = 0; k < n; k++) {
        const ang = rng.next() * Math.PI * 2, r = a.radius * Math.sqrt(rng.next());
        queueShell(world, p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r, 0.4 + rng.next() * 1.1, {
          r: a.splash, dmg: a.dmg, src: key, friendly: true, wallDmg: a.dmg * 0.5, fx: 'boom', fxR: a.splash * 1.4, fxDur: 0.4,
        });
      }
      break;
    }
    case 'cure': {
      const hits = [];
      world.query(p.x, p.y, p.r, M_ZOMBIE | M_TURNING, (i) => { hits.push(i); });
      let n = 0;
      for (const i of hits) if (world.cure(i)) n++;
      world.effects.push({ kind: 'flash', x: p.x, y: p.y, r: p.r, t0: t, dur: 1.5, tone: 'cure' });
      log(world, `CURE DISPERSED: ${n} RESTORED`, 'info', p.x, p.y);
      break;
    }
    case 'nuke': nukeDetonate(world, p, a); break;
    default: break;
  }
}

// Effects that start the moment the ability is called. Returns true when nothing is left to deliver later.
function launch(world, id, a, q, owner) {
  const t = world.t, key = abilityKey(id);
  switch (id) {
    case 'callToArms': {
      const A = world.A, picks = [];
      world.query(q.x, q.y, q.r, M_CIV, (i, d2) => { picks.push([d2, i]); });
      picks.sort((m, n) => m[0] - n[0] || m[1] - n[1]);
      const sq = newSquad(world, id, q.x, q.y, owner, world.cfg.functions.militia.fighter, 'hunt');
      let n = 0;
      for (const [, i] of picks) {
        if (n >= (a.max || 150)) break;
        if (A.type[i] !== CIV || A.state[i] === CS.EVAC) continue;
        world.setType(i, MILITIA);
        enlist(world, i, sq, MILITIA);
        n++;
      }
      world.stats.converted += n;
      world.effects.push({ kind: 'flash', x: q.x, y: q.y, r: q.r, t0: t, dur: 1, tone: 'arms' });
      log(world, `CALL TO ARMS: ${n} CITIZENS ARMED`, 'info', q.x, q.y);
      return true;
    }
    case 'seekDestroy': {
      const C = world.combat, u = C.byId.get(q.unit);
      const bd = world.buildings[u.b];
      const left = u.ammo + (u.reloads === Infinity || world.buildingInZone(u.b) >= 0 ? Infinity : u.reloads * u.mag);
      const n = clamp(Math.round(left / (a.perAmmo || 30)) || 0, a.min || 1, a.max || 25);
      destroyUnit(world, u, 'consumed');
      const sq = newSquad(world, id, bd.cx, bd.cy, owner, { ...world.cfg.functions.police.officer, ammo: a.perAmmo || 30 }, 'hunt');
      const made = spawnSquad(world, sq, POLICE, n, bd.cx, bd.cy, bd.r + 4);
      log(world, `SEEK AND DESTROY: ${made} OFFICERS DEPLOYED`, 'info', bd.cx, bd.cy);
      return true;
    }
    case 'rally': {
      const A = world.A, rng = world.rng, members = [];
      world.query(q.x, q.y, a.radius, M_ARMED, (i) => { members.push(i); });
      members.sort((m, n) => m - n);
      const rec = { x: q.x, y: q.y, until: t + a.sec, members: [] };
      for (const i of members) {
        const ang = rng.next() * Math.PI * 2, r = 4 + 10 * Math.sqrt(rng.next());
        rec.members.push([i, A.type[i], A.state[i]]);
        A.pc[i] = -1;
        A.home[2 * i] = q.x + Math.cos(ang) * r; A.home[2 * i + 1] = q.y + Math.sin(ang) * r; A.state[i] = 0;
      }
      world.combat.rallies.push(rec);
      world.effects.push({ kind: 'drop', x: q.x, y: q.y, r: 14, t0: t, dur: a.sec, ability: id });
      log(world, `RALLY: ${members.length} RESPONDERS REGROUPING`, 'info', q.x, q.y);
      return true;
    }
    case 'bus':
      spawnBus(world, a, q.x, q.y, owner);
      log(world, 'EVACUATION BUS BOARDING', 'info', q.x, q.y);
      return true;
    case 'medevac':
      spawnMedevac(world, a, q.x, q.y, owner);
      log(world, 'MEDEVAC INBOUND', 'info', q.x, q.y);
      sound(world, 'heli', q.x, q.y, 0.6, 10);
      return true;
    case 'helicopter':
      spawnHeli(world, a, q.x, q.y, owner);
      log(world, 'ATTACK HELICOPTER INBOUND', 'info', q.x, q.y);
      sound(world, 'heli', q.x, q.y, 0.6, 10);
      return true;
    case 'gunship':
      spawnGunship(world, a, q.x, q.y, owner);
      log(world, 'GUNSHIP INBOUND', 'info', q.x, q.y);
      return true;
    case 'cruise': {
      const [dx, dy] = inboundDir(world, q.x, q.y), L = Math.max(600, a.delay * 160);
      world.projectiles.push({ kind: 'missile', x0: q.x - dx * L, y0: q.y - dy * L, x1: q.x, y1: q.y, t0: t, dur: a.delay, src: key });
      return false;
    }
    default: return false;
  }
}

const NAME_LOG = {
  paratroopers: 'PARATROOPERS INBOUND', apc: 'ARMOURED CARRIER INBOUND', tank: 'TANK INBOUND', bulldozer: 'BULLDOZER INBOUND',
  demolition: 'DEMOLITION CHARGES SET', fireBomb: 'FIRE BOMB INBOUND', cruise: 'CRUISE MISSILE LAUNCHED', gasBomb: 'GAS BOMB INBOUND',
  airstrike: 'AIRSTRIKE INBOUND', clusterBomb: 'CLUSTER BOMB INBOUND', cure: 'CURE DISPERSAL INBOUND', nuke: 'NUCLEAR STRIKE AUTHORISED',
};

function useAbility(world, cmd, q) {
  const id = cmd.id || cmd.ability, a = world.cfg.abilities[id], owner = cmd.owner | 0, C = world.combat;
  world.charges[id] = (world.charges[id] | 0) - 1;
  const done = launch(world, id, a, q, owner);
  const at = world.t + (a.delay || 0);
  if (done) return { ok: true, id, at: world.t };
  const [dx, dy] = id === 'airstrike' ? [0, 0] : inboundDir(world, q.x, q.y);
  const p = { seq: C.nextStrike++, ability: id, x: q.x, y: q.y, x2: q.x2, y2: q.y2, r: q.r || a.radius || 0, b: q.b, dx: q.dx ?? dx, dy: q.dy ?? dy,
    owner, t0: world.t, at, planeAt: -1 };
  if (id === 'paratroopers' || id === 'fireBomb' || id === 'gasBomb' || id === 'clusterBomb') p.planeAt = at - 320 / PLANE_SPEED;
  if (id === 'airstrike') p.planeAt = at - 200 / PLANE_SPEED;
  if (id === 'clusterBomb' || id === 'fireBomb' || id === 'gasBomb' || id === 'paratroopers') { p.dx = dx; p.dy = dy; }
  C.pending.push(p);
  if (a.delay > 0) world.effects.push({ kind: 'drop', x: q.x, y: q.y, r: q.r || a.radius || a.splash || 20, t0: world.t, dur: a.delay, ability: id, x2: q.x2, y2: q.y2 });
  log(world, `${NAME_LOG[id] || id.toUpperCase()} (${Math.round(a.delay)} S)`, id === 'nuke' ? 'alert' : 'info', q.x, q.y);
  if (id === 'nuke') world.events.emit('sound', { name: 'siren', x: q.x, y: q.y, vol: 1 });
  if (p.planeAt <= world.t) firePlane(world, p);
  if (at <= world.t) { C.pending.pop(); deliver(world, p); }
  return { ok: true, id, at };
}

function firePlane(world, p) {
  if (p.planeAt < 0) return;
  p.planeAt = -1;
  if (p.ability === 'airstrike') {
    let dx = p.x2 - p.x, dy = p.y2 - p.y;
    const L = Math.hypot(dx, dy) || 1, len = world.cfg.abilities.airstrike.length || 240;
    dx /= L; dy /= L;
    const half = (len + 400) / 2;
    planeOver(world, p.x + dx * (len / 2), p.y + dy * (len / 2), dx, dy, half, world.t, 'airstrike');
  } else planeOver(world, p.x, p.y, p.dx, p.dy, 320, world.t, p.ability);
}

export function abilitySystem(world) {
  const C = world.combat, t = world.t;
  if (C.pending.length) {
    const due = [];
    let w = 0;
    for (let k = 0; k < C.pending.length; k++) {
      const p = C.pending[k];
      if (p.planeAt >= 0 && t >= p.planeAt) firePlane(world, p);
      if (t >= p.at) due.push(p); else C.pending[w++] = p;
    }
    C.pending.length = w;
    for (const p of due) deliver(world, p);
  }
  if (C.rallies.length) {
    const A = world.A;
    let w = 0;
    for (const r of C.rallies) {
      if (t < r.until) { C.rallies[w++] = r; continue; }
      for (const [i, type, st] of r.members) if (A.type[i] === type) A.state[i] = st;
    }
    C.rallies.length = w;
  }
}

export function registerAbilityCommands(world) {
  world.registerCommand('ability.use', {
    quote(w, cmd) {
      const id = cmd.id || cmd.ability, a = w.cfg.abilities[id];
      if (!a) return fail('Unknown ability');
      if (w.phase !== 'battle') return fail('Abilities are used once the outbreak starts');
      if ((w.charges[id] | 0) <= 0) return fail('No charges left');
      if (w.t < a.unlock) return fail(`Available in ${Math.ceil(a.unlock - w.t)} s`);
      return resolveTarget(w, id, a, cmd);
    },
    exec: (w, cmd, q) => useAbility(w, cmd, q),
  });
  world.registerCommand('squad.mode', {
    quote(w, cmd) {
      const g = cmd.group | 0;
      const sq = w.combat.squads.find((s) => s.group === g);
      if (!sq && !squadMembers(w, g)) return fail('No such squad');
      if (w.owners > 1 && sq && sq.owner !== (cmd.owner | 0)) return fail("That is your partner's squad");
      return { ok: true, cost: 0 };
    },
    exec(w, cmd) {
      const g = cmd.group | 0, hunt = cmd.mode === 'hunt' || cmd.mode === 'pursue' || cmd.mode === 1 || cmd.mode === true;
      const A = w.A;
      if (w.orders) w.orders.cancel(g);
      let n = 0;
      for (let i = 0; i < A.n; i++) if (A.type[i] >= POLICE && A.group[i] === g) { A.state[i] = hunt ? 1 : 0; if (!hunt) { A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; } n++; }
      for (const s of w.combat.squads) if (s.group === g) s.mode = hunt ? 'hunt' : 'guard';
      return { ok: true, group: g, mode: hunt ? 'hunt' : 'guard', count: n };
    },
  });
}

export function resetAbilities(world) {
  const C = world.combat;
  C.pending.length = 0;
  C.squads.length = 0;
  C.rallies.length = 0;
  for (const v of world.vehicles) if (v.pickup) world.removePickup(v.pickup);
  world.vehicles.length = 0;
}

