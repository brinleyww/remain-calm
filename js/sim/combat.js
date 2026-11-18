// Unit weapons: stats with upgrades and auras, targeting, fire, shells, ammo and reloads, traps, unit damage.
import { T } from '../map/format.js';
import { rasterPolyline } from '../util/geom.js';
import { ZOMBIE, ZSUB, M_ZOMBIE } from './agents.js';
import { P_ZOM, P_SWIM, isWalkTerrain } from './nav.js';

export const abilityKey = (id) => 'ability:' + id;

const STAT_KEYS = ['dmg', 'rof', 'mag', 'reloads', 'reloadSec', 'range', 'minRange', 'accuracy', 'splash', 'stunSec', 'fire',
  'rockets', 'spread', 'shells', 'shellSpeed', 'bldgDmg', 'bridgeDmg', 'width', 'hp', 'trigger', 'fireRadius', 'slow',
  'durability', 'burnSec', 'autoIgnite'];
const INT_STATS = new Set(['mag', 'reloads', 'rockets', 'shells']);
const RESTOCK_SEC = 8;   // a Supply aura restocks an empty turret in this time (before the aura's reload multiplier)
const SCAN_SEC = 0.25;   // how often an idle weapon looks for a target
const UNIT_R = 1.5;      // footprint radius of ground units, added to the zombie touch radius
export const STATS_TTL = 20; // ticks a cached stat block stays valid (auras can change mid-battle)

// ---------------------------------------------------------------- definitions and stats
export function weaponKind(def) {
  if (!def) return 'none';
  if (def.manual) return 'charge';
  if (def.mount === 'line') return def.slow !== undefined ? 'spikes' : 'oil';
  if (def.trigger !== undefined) return 'trap';
  if (def.width) return 'rail';
  if (def.shellSpeed) return 'arty';
  return 'direct';
}

export function buildingAt(world, x, y) {
  const c = world.cellAt(x, y);
  if (c < 0) return -1;
  const b = world.grid.bldg[c] - 1;
  return b >= 0 && world.grid.terrain[c] === T.BLDG && world.buildings[b] && world.buildings[b].alive ? b : -1;
}

function applyUp(s, stat, f) {
  if (s[stat] === undefined) return;
  if (stat === 'rof') s.rof /= f >= 1 ? f : 1 / f;   // fire-rate upgrades always shorten the interval
  else if (INT_STATS.has(stat)) s[stat] = Number.isFinite(s[stat]) ? Math.round(s[stat] * f) : s[stat];
  else s[stat] *= f;
}

// Stats of a placed unit, or of a pseudo unit { type, x, y, b?, level? } for placement previews.
// rof is the interval between shots/salvos in seconds; reloadSec and range include auras when `auras` is true.
export function unitStats(world, u, auras = true) {
  const def = world.cfg.units[u.type];
  if (!def) return null;
  let b = u.b;
  if (b === undefined || b === null) b = def.mount === 'building' || def.mount === 'building|bridge' ? buildingAt(world, u.x, u.y) : -1;
  const bd = b >= 0 ? world.buildings[b] : null;
  const level = Math.max(1, u.level | 0 || 1);
  const s = { type: u.type, level, kind: weaponKind(def), mount: def.mount };
  for (const k of STAT_KEYS) {
    const v = def[k];
    if (v === undefined) continue;
    s[k] = typeof v === 'function' ? v(bd || { h: 0, area: 0 }) : v;
  }
  const ups = def.ups || [];
  for (let L = 2; L <= level && L - 2 < ups.length; L++) applyUp(s, ups[L - 2][0], ups[L - 2][1]);
  s.baseRange = s.range || 0;
  if (auras && world.auras) {
    if (s.range) s.range *= world.auraMul(u.x, u.y, 'range');
    if (s.rof) s.rof /= world.auraMul(u.x, u.y, 'rof');
    if (s.reloadSec) s.reloadSec *= world.auraMul(u.x, u.y, 'reload');
  }
  s.unlimited = !!def.unlimited;
  s.noZoneReload = !!def.noZoneReload;
  s.priority = def.priority || null;
  s.friendly = !!def.friendly;
  return s;
}

export function unitRange(world, u) {
  const s = unitStats(world, u);
  return s ? s.range || s.trigger || s.fireRadius || 0 : 0;
}

// Cached stat block, refreshed on a per-unit phase so big defences do not all recompute on the same tick.
function stats(world, u) {
  const t = world.tick;
  if (!u._s || u._st > t || t - u._st > STATS_TTL || ((t + u.id) % STATS_TTL === 0 && u._st !== t)) { u._s = unitStats(world, u); u._st = t; }
  return u._s;
}

// ---------------------------------------------------------------- state, index
export function makeCombatState() {
  return {
    started: false, shells: [], pending: [], squads: [], rallies: [], mutants: [], kinds: {},
    byId: new Map(), brushAt: new Map(), c4At: new Map(), spikeAt: new Map(), oilAt: new Map(),
    lineMask: null, lineCount: 0, snipers: 0, nextGroup: 1, nextVeh: 1, nextStrike: 1, snd: {}, shotN: 0, logT: {},
  };
}

export function kindOf(world, type) {
  const C = world.combat;
  let k = C.kinds[type];
  if (!k) k = C.kinds[type] = weaponKind(world.cfg.units[type]);
  return k;
}

// Fine cells a line unit (spikes / oil) covers: walkable cells inside the stage, minus cells already covered by the same type.
export function lineCells(world, type, p) {
  const g = world.grid, mask = world.region.mask, C = world.combat, own = type === 'spikes' ? C.spikeAt : C.oilAt;
  const set = new Set();
  rasterPolyline(p, g.cell * 1.5, g.cell, g.gw, g.gh, (c) => {
    if (mask[c] && isWalkTerrain(g.terrain[c]) && !(world.block[c] && world.wallHp[c] > 0) && !own.has(c)) set.add(c);
  });
  return Int32Array.from([...set].sort((a, b) => a - b));
}

export function indexAdd(world, u) {
  const C = world.combat, k = kindOf(world, u.type);
  C.byId.set(u.id, u);
  if (u.type === 'sniper') C.snipers++;
  if (k === 'trap' && world.cfg.units[u.type].mount === 'brush') C.brushAt.set(u.cell, u);
  if (k === 'charge') C.c4At.set(u.b >= 0 ? 'b' + u.b : 'r' + u.bridge, u);
  if (u.b >= 0 && world.cfg.units[u.type].mount === 'building' && world.buildings[u.b]) world.buildings[u.b].unitId = u.id;
  if (k === 'spikes' || k === 'oil') {
    if (!C.lineMask) C.lineMask = new Uint8Array(world.grid.gw * world.grid.gh);
    const bit = k === 'spikes' ? 1 : 2, map = k === 'spikes' ? C.spikeAt : C.oilAt;
    u.cells.forEach((c, j) => { C.lineMask[c] |= bit; map.set(c, k === 'spikes' ? [u, j] : u); });
    C.lineCount++;
  }
}

export function indexRemove(world, u) {
  const C = world.combat, k = kindOf(world, u.type);
  C.byId.delete(u.id);
  if (u.type === 'sniper') C.snipers--;
  if (k === 'trap' && C.brushAt.get(u.cell) === u) C.brushAt.delete(u.cell);
  if (k === 'charge') { const key = u.b >= 0 ? 'b' + u.b : 'r' + u.bridge; if (C.c4At.get(key) === u) C.c4At.delete(key); }
  if (u.b >= 0 && world.buildings[u.b] && world.buildings[u.b].unitId === u.id) world.buildings[u.b].unitId = -1;
  if ((k === 'spikes' || k === 'oil') && C.lineMask) {
    const bit = k === 'spikes' ? 1 : 2, map = k === 'spikes' ? C.spikeAt : C.oilAt;
    for (const c of u.cells) {
      const e = map.get(c);
      if (e && (e === u || e[0] === u)) { map.delete(c); C.lineMask[c] &= ~bit; }
    }
    C.lineCount--;
  }
}

// Fills ammo, HP and cooldowns. Called on placement, load and at every stage start.
export function initRuntime(world, u) {
  const s = unitStats(world, u, false);
  u.alive = true; u.kills = 0; u.shots = 0;
  u.mag = s.mag !== undefined ? s.mag : 0;
  u.ammo = u.mag;
  u.reloads = s.reloads !== undefined ? s.reloads : 0;
  u.reloadT = 0; u.cd = 0; u.dry = false;
  u.hpMax = s.hp || 0; u.hp = u.hpMax;
  u.tgt = -1; u.scanT = 0; u.readyAt = 0; u.ax = NaN; u.ay = NaN; u.fireT = -1;
  u._s = null; u._st = -1;
  const k = s.kind;
  if (k === 'spikes') { u.dur = new Float32Array(u.cells.length).fill(s.durability || 1); u.left = u.cells.length; }
  if (k === 'oil') { u.lit = false; u.igniteAt = -1; u.burnUntil = -1; u.nextFlame = 0; }
}

export function unitInZone(world, u) {
  const def = world.cfg.units[u.type];
  if (def && def.mount === 'building' && u.b >= 0) return world.buildingInZone(u.b) >= 0;
  if (def && def.mount === 'water') return false;
  return world.inZone(u.x, u.y) >= 0;
}

// ---------------------------------------------------------------- shared helpers
export function sound(world, name, x, y, vol = 0.6, gap = 3) {
  const C = world.combat;
  if (world.tick - (C.snd[name] ?? -1e9) < gap) return;
  C.snd[name] = world.tick;
  world.events.emit('sound', { name, x, y, vol: Math.min(1, vol) });
}

export function log(world, msg, kind = 'info', x, y, gap = 0) {
  const C = world.combat;
  if (gap > 0) { if (world.t - (C.logT[msg] ?? -1e9) < gap) return; C.logT[msg] = world.t; }
  world.events.emit('log', { msg, kind, x, y });
}

// Any zombie in the 32 m blocks overlapping the square of half-size r around (x, y)? (cheap pre-check before searches)
export function zombiesNear(world, x, y, r) {
  const sh = world.sh, ib = 1 / sh.bz, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh;
  const bx0 = Math.max(0, ((x - r) * ib) | 0), bx1 = Math.min(bw - 1, ((x + r) * ib) | 0);
  const by0 = Math.max(0, ((y - r) * ib) | 0), by1 = Math.min(bh - 1, ((y + r) * ib) | 0);
  for (let by = by0; by <= by1; by++) { const row = by * bw; for (let bx = bx0; bx <= bx1; bx++) if (blk[row + bx]) return true; }
  return false;
}

export function nearestZombie(world, x, y, r) {
  return world.counts[ZOMBIE] > 0 && zombiesNear(world, x, y, r) ? world.nearest(x, y, r, M_ZOMBIE) : -1;
}

function nearestMutant(world, x, y, r) {
  const A = world.A, list = world.combat.mutants;
  let best = -1, bd = r * r;
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    if (A.type[i] !== ZOMBIE || !A.sub[i]) continue;
    const dx = A.x[i] - x, dy = A.y[i] - y, d2 = dx * dx + dy * dy;
    if (d2 <= bd) { bd = d2; best = i; }
  }
  return best;
}

function refreshMutants(world) {
  const A = world.A, list = world.combat.mutants;
  list.length = 0;
  for (let i = 0, n = A.n; i < n; i++) if (A.type[i] === ZOMBIE && A.sub[i]) list.push(i);
}

const CAND = new Int32Array(64), CANDN = new Int32Array(64);

// Densest zombie cluster inside the ring [minR, maxR] around (x, y), sampled from the spatial hash's 32 m block counts.
// Picks among the strongest blocks with world.rng so several guns spread their fire. Returns [x, y, count] or null.
export function pickCluster(world, x, y, minR, maxR) {
  if (world.counts[ZOMBIE] <= 0) return null;
  const sh = world.sh, bz = sh.bz, ib = 1 / bz, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh;
  const bx0 = Math.max(0, ((x - maxR) * ib) | 0), bx1 = Math.min(bw - 1, ((x + maxR) * ib) | 0);
  const by0 = Math.max(0, ((y - maxR) * ib) | 0), by1 = Math.min(bh - 1, ((y + maxR) * ib) | 0);
  const lo = Math.max(0, minR - bz * 0.5), hi = maxR + bz * 0.25, lo2 = lo * lo, hi2 = hi * hi;
  let best = 0;
  for (let by = by0; by <= by1; by++) {
    const cy = (by + 0.5) * bz - y, row = by * bw;
    for (let bx = bx0; bx <= bx1; bx++) {
      const n = blk[row + bx];
      if (n <= best) continue;
      const cx = (bx + 0.5) * bz - x, d2 = cx * cx + cy * cy;
      if (d2 < lo2 || d2 > hi2) continue;
      best = n;
    }
  }
  if (!best) return null;
  let nc = 0, tot = 0;
  const floor = Math.max(1, best * 0.5);
  for (let by = by0; by <= by1 && nc < 64; by++) {
    const cy = (by + 0.5) * bz - y, row = by * bw;
    for (let bx = bx0; bx <= bx1 && nc < 64; bx++) {
      const n = blk[row + bx];
      if (n < floor) continue;
      const cx = (bx + 0.5) * bz - x, d2 = cx * cx + cy * cy;
      if (d2 < lo2 || d2 > hi2) continue;
      CAND[nc] = row + bx; CANDN[nc] = n; nc++; tot += n;
    }
  }
  let r = world.rng.next() * tot, pick = CAND[0];
  for (let k = 0; k < nc; k++) { r -= CANDN[k]; if (r <= 0) { pick = CAND[k]; break; } }
  const px = (pick % bw + 0.5) * bz, py = (((pick / bw) | 0) + 0.5) * bz;
  const A = world.A;
  let sx = 0, sy = 0, n = 0;
  const lo1 = Math.max(0, minR), hi1 = maxR;
  world.query(px, py, bz * 0.75, M_ZOMBIE, (i) => {
    const dx = A.x[i] - x, dy = A.y[i] - y, d2 = dx * dx + dy * dy;
    if (d2 < lo1 * lo1 || d2 > hi1 * hi1) return;
    sx += A.x[i]; sy += A.y[i]; n++;
  });
  if (!n) return null;
  const ax = sx / n, ay = sy / n, d = Math.hypot(ax - x, ay - y);
  if (d < lo1 || d > hi1) {
    let j = -1;
    world.query(px, py, bz * 0.75, M_ZOMBIE, (i) => {
      const dx = A.x[i] - x, dy = A.y[i] - y, d2 = dx * dx + dy * dy;
      if (d2 >= lo1 * lo1 && d2 <= hi1 * hi1) { j = i; return false; }
    });
    return j >= 0 ? [A.x[j], A.y[j], n] : null;
  }
  return [ax, ay, n];
}

// Queues an exploding shell that lands at world.t + dur and calls world.damageArea.
// o: { r, dmg, src, friendly, stunSec, fire, bldgDmg, bridgeDmg, wallDmg, fx, fxR, snd, u }
export function queueShell(world, x, y, dur, o) {
  world.combat.shells.push({ at: world.t + Math.max(0, dur), x, y, ...o });
}

// Kills credited to one source key during fn() (damageArea does not report them).
export function creditKills(world, key, fn) {
  const by = world.stats.killsBy, k0 = by[key] || 0;
  fn();
  return (by[key] || 0) - k0;
}

function landShells(world) {
  const list = world.combat.shells;
  if (!list.length) return;
  const t = world.t;
  let w = 0, booms = 0;
  const due = [];
  for (let k = 0; k < list.length; k++) { const s = list[k]; if (s.at <= t + 1e-9) due.push(s); else list[w++] = s; }
  list.length = w;
  for (const s of due) {
    const kills = creditKills(world, s.src, () => world.damageArea(s.x, s.y, s.r, s.dmg || 0, s));
    if (s.u) s.u.kills += kills;
    if (s.fx !== null) world.effects.push({ kind: s.fx || 'boom', x: s.x, y: s.y, r: s.fxR || s.r, t0: t, dur: s.fxDur || 0.6 });
    booms++;
  }
  if (booms) sound(world, due[0].snd || 'explosion', due[0].x, due[0].y, 0.35 + booms * 0.08, 2);
}

// ---------------------------------------------------------------- destruction
export function destroyUnit(world, u, why = 'destroyed') {
  if (!u.alive) return;
  u.alive = false;
  u.hp = 0;
  indexRemove(world, u);
  if (why === 'consumed') return;
  const def = world.cfg.units[u.type];
  if (def && def.mount !== 'brush') {
    world.effects.push({ kind: 'boom', x: u.x, y: u.y, r: 8, t0: world.t, dur: 0.7 });
    const name = (world.combat.names && world.combat.names[u.type]) || u.type;
    log(world, `${String(name).toUpperCase()} LOST`, 'warn', u.x, u.y, 2);
  }
}

export function onCollapse(world, e) {
  const bd = world.buildings[e.b];
  const L = bd ? bd.h * world.cfg.building.toppleRange : 0;
  const x0 = bd ? bd.cx : e.x, y0 = bd ? bd.cy : e.y, x1 = x0 + (e.dirX || 0) * L, y1 = y0 + (e.dirY || 0) * L;
  const reach = (bd ? bd.r : 10) + 2;
  const g = world.grid;
  for (const u of world.units) {
    if (!u.alive) continue;
    if (u.b === e.b) { destroyUnit(world, u, 'collapse'); continue; }
    if (u.b >= 0 || !bd || u.p) continue;
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    let tt = l2 > 0 ? ((u.x - x0) * dx + (u.y - y0) * dy) / l2 : 0;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    if (Math.hypot(u.x - (x0 + tt * dx), u.y - (y0 + tt * dy)) > reach) continue;
    const c = world.cellAt(u.x, u.y);
    if (c >= 0 && g.terrain[c] === T.RUBBLE) destroyUnit(world, u, 'collapse');
  }
}

export function onBridgeDown(world, e) {
  for (const u of world.units) if (u.alive && u.bridge === e.id && world.cfg.units[u.type].mount !== 'water') destroyUnit(world, u, 'bridge');
}

// ---------------------------------------------------------------- ammo
function startReload(world, u, s) {
  if (s.unlimited) { u.ammo = u.mag; u.dry = false; return; }
  if (s.noZoneReload) {
    if (world.hasSupply(u.x, u.y)) { u.reloadT = Math.max(s.reloadSec || 0, RESTOCK_SEC * world.auraMul(u.x, u.y, 'reload')); u.dry = false; }
    else u.dry = true;
    return;
  }
  const dt = world.cfg.sim.dt;
  if (unitInZone(world, u)) { u.reloadT = Math.max(dt, s.reloadSec || 0); u.dry = false; return; }
  if (u.reloads > 0) { u.reloads--; u.reloadT = Math.max(dt, s.reloadSec || 0); u.dry = false; return; }
  u.dry = true;
}

// Returns true when the gun may fire this tick (loaded, cooled down, past its start delay).
function gunReady(world, u, s, dt) {
  if (u.reloadT > 0) {
    u.reloadT -= dt;
    if (u.reloadT > 0) return false;
    u.reloadT = 0; u.ammo = u.mag; u.dry = false;
  }
  if (u.ammo <= 0) {
    if (!u.dry || (world.tick + u.id) % 20 === 0) startReload(world, u, s);
    return false;
  }
  if (u.cd > 0) { u.cd -= dt; if (u.cd > 0) return false; }
  return world.t >= u.readyAt;
}

// ---------------------------------------------------------------- weapons
function acquireDirect(world, u, s) {
  const A = world.A, r = s.range, r2 = r * r;
  let t = u.tgt;
  if (t >= 0) {
    if (A.type[t] !== ZOMBIE) t = -1;
    else { const dx = A.x[t] - u.x, dy = A.y[t] - u.y; if (dx * dx + dy * dy > r2) t = -1; }
  }
  const wantMutant = s.priority === 'mutant' && world.combat.mutants.length > 0;
  if (t >= 0 && !(wantMutant && !A.sub[t] && world.t >= u.scanT)) return t;
  if (t < 0 && world.t < u.scanT) return -1;
  u.scanT = world.t + SCAN_SEC + (u.id % 5) * 0.04;
  let n = wantMutant ? nearestMutant(world, u.x, u.y, r) : -1;
  if (n < 0 && t < 0) n = nearestZombie(world, u.x, u.y, r);
  if (n >= 0) t = n;
  u.tgt = t;
  return t;
}

function fireDirect(world, u, s, dt) {
  if (!gunReady(world, u, s, dt)) return;
  const t = acquireDirect(world, u, s);
  if (t < 0) { u.cd = 0; return; }
  const A = world.A, rng = world.rng, acc = s.accuracy ?? world.cfg.armed.accuracy ?? 0.8;
  const tx = A.x[t], ty = A.y[t];
  let shots = 0;
  while (u.cd <= 0 && u.ammo > 0 && shots < 6) {
    shots++; u.ammo--; u.shots++;
    u.cd += s.rof;
    if (rng.next() < acc && world.damageAgent(t, s.dmg, u.type)) { u.kills++; u.tgt = -1; u.scanT = 0; break; }
  }
  u.ax = tx; u.ay = ty; u.fireT = world.t;
  const sniper = u.type === 'sniper';
  world.projectiles.push({ kind: 'tracer', x0: u.x, y0: u.y, x1: tx, y1: ty, t0: world.t, dur: sniper ? 0.12 : 0.06, src: u.type });
  if (sniper) sound(world, 'snipe', u.x, u.y, 0.5, 4);
  else world.combat.shotN += shots;
}

function fireArty(world, u, s, dt) {
  if (!gunReady(world, u, s, dt)) return;
  if (world.t < u.scanT) return;
  const aim = pickCluster(world, u.x, u.y, s.minRange || 0, s.range);
  if (!aim) { u.scanT = world.t + 0.5 + (u.id % 5) * 0.05; u.cd = 0; return; }
  const rng = world.rng, ff = world.cfg.friendlyFire, mul = ff.autoStructureMul;
  const n = Math.max(1, s.shells || s.rockets || 1);
  const dist0 = Math.hypot(aim[0] - u.x, aim[1] - u.y);
  const spread = s.spread || (n > 1 ? (s.splash || 10) * 1.5 : 1.5 + dist0 * 0.004);
  const rocket = !!s.rockets;
  const chip = (s.bldgDmg ?? s.dmg ?? 0) * mul;
  for (let k = 0; k < n; k++) {
    const a = rng.next() * Math.PI * 2, rr = spread * Math.sqrt(rng.next());
    const lx = aim[0] + Math.cos(a) * rr, ly = aim[1] + Math.sin(a) * rr;
    const dur = Math.hypot(lx - u.x, ly - u.y) / (s.shellSpeed || 150) + (rocket ? k * 0.05 : 0);
    world.projectiles.push({ kind: rocket ? 'rocket' : 'shell', x0: u.x, y0: u.y, x1: lx, y1: ly, t0: world.t, dur, src: u.type });
    queueShell(world, lx, ly, dur, {
      r: s.splash || 8, dmg: s.dmg || 0, src: u.type, friendly: !!ff.auto, stunSec: s.stunSec || 0, fire: s.fire || 0,
      bldgDmg: chip, bridgeDmg: chip, wallDmg: (s.dmg || 0) * mul, u,
      fx: s.stunSec ? 'gas' : s.fire ? 'fireburst' : 'boom', fxDur: s.stunSec ? Math.min(3, s.stunSec) : 0.6,
    });
  }
  u.ammo--; u.shots++;
  u.cd = s.rof;
  u.ax = aim[0]; u.ay = aim[1]; u.fireT = world.t;
  sound(world, rocket ? 'rocket' : 'thump', u.x, u.y, 0.5, 3);
}

function fireRail(world, u, s, dt) {
  if (!gunReady(world, u, s, dt)) return;
  if (world.t < u.scanT) return;
  const aim = pickCluster(world, u.x, u.y, 0, s.range);
  if (!aim) { u.scanT = world.t + 0.5; u.cd = 0; return; }
  let dx = aim[0] - u.x, dy = aim[1] - u.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  const x1 = u.x + dx * s.range, y1 = u.y + dy * s.range, hw = (s.width || 3) * 0.5 + 0.5;
  const A = world.A, hits = [], seen = new Set(), step = 6;
  for (let k = 0; k * step <= s.range + step; k++) {
    const px = u.x + dx * k * step, py = u.y + dy * k * step;
    world.query(px, py, step * 0.75 + hw, M_ZOMBIE, (i) => {
      if (seen.has(i)) return;
      const ox = A.x[i] - u.x, oy = A.y[i] - u.y, along = ox * dx + oy * dy;
      if (along < 0 || along > s.range || Math.abs(-ox * dy + oy * dx) > hw) return;
      seen.add(i); hits.push(i);
    });
  }
  for (const i of hits) if (A.type[i] === ZOMBIE && world.damageAgent(i, s.dmg, u.type)) u.kills++;
  world.projectiles.push({ kind: 'rail', x0: u.x, y0: u.y, x1, y1, t0: world.t, dur: 0.3, src: u.type });
  u.ammo--; u.shots++;
  u.cd = s.rof;
  u.ax = aim[0]; u.ay = aim[1]; u.fireT = world.t;
  sound(world, 'rail', u.x, u.y, 0.8, 4);
}

function triggerTrap(world, u, s) {
  const ff = world.cfg.friendlyFire, x = u.x, y = u.y;
  let kills = 0;
  if (s.fireRadius) {
    world.ignite(x, y, s.fireRadius, 1, u.type);
    kills = creditKills(world, u.type, () => world.damageArea(x, y, s.fireRadius, s.dmg || 0, { src: u.type, friendly: !!ff.auto, fire: 1 }));
    world.effects.push({ kind: 'fireburst', x, y, r: s.fireRadius, t0: world.t, dur: 1.2 });
    sound(world, 'fire', x, y, 0.7, 2);
  } else if (s.stunSec && !s.dmg) {
    world.damageArea(x, y, s.splash || 8, 0, { src: u.type, stunSec: s.stunSec });
    world.effects.push({ kind: 'gas', x, y, r: s.splash || 8, t0: world.t, dur: s.stunSec });
    sound(world, 'hiss', x, y, 0.4, 2);
  } else {
    kills = creditKills(world, u.type, () => world.damageArea(x, y, s.splash || 6, s.dmg || 0,
      { src: u.type, friendly: !!ff.auto, wallDmg: (s.dmg || 0) * ff.autoStructureMul }));
    world.effects.push({ kind: 'boom', x, y, r: (s.splash || 6) * 1.2, t0: world.t, dur: 0.5 });
    sound(world, 'explosion', x, y, 0.4, 2);
  }
  u.kills += kills;
  destroyUnit(world, u, 'consumed');
}

// Detonates a demolition charge on its building or bridge. Aimed: hurts everyone in the blast.
export function detonate(world, u) {
  const s = stats(world, u);
  destroyUnit(world, u, 'consumed');
  const x = u.x, y = u.y, key = u.type;
  const bd = u.b >= 0 ? world.buildings[u.b] : null, br = u.bridge >= 0 ? world.bridges[u.bridge] : null;
  const r = (s.splash || 30) + (bd ? bd.r : br ? br.width * 0.5 : 0);
  let kills = creditKills(world, key, () => world.damageArea(x, y, r, s.dmg || 0, { src: key, friendly: true, wallDmg: s.dmg || 0 }));
  if (u.b >= 0) {
    const a = world.rng.next() * Math.PI * 2;
    kills += creditKills(world, key, () => world.damageBuilding(u.b, s.bldgDmg || 0, key, Math.cos(a), Math.sin(a)));
  }
  if (u.bridge >= 0) world.damageBridge(u.bridge, s.bridgeDmg || 0);
  u.kills += kills;
  world.effects.push({ kind: 'boom', x, y, r: r * 1.2, t0: world.t, dur: 1 });
  sound(world, 'explosion', x, y, 1, 1);
  return kills;
}

function updateOil(world, u, s) {
  const t = world.t;
  if (u.lit) {
    if (t >= u.nextFlame) {
      u.nextFlame = t + 1;
      const p = u.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], L = Math.hypot(dx, dy), n = Math.max(1, Math.ceil(L / 6));
        for (let k = 0; k <= n; k++) world.ignite(p[i] + dx * k / n, p[i + 1] + dy * k / n, 4, 1, u.type);
      }
    }
    if (t >= u.burnUntil) destroyUnit(world, u, 'consumed');
    return;
  }
  let light = u.igniteAt >= 0 && t >= u.igniteAt;
  if (!light && world._fireList.length && (world.tick + u.id) % 10 === 0) {
    const nav = world.nav, inv = 1 / nav.ccell;
    for (const c of u.cells) {
      const x = (c % world.grid.gw + 0.5) * world.grid.cell, y = (((c / world.grid.gw) | 0) + 0.5) * world.grid.cell;
      if (world.fire[((y * inv) | 0) * nav.cgw + ((x * inv) | 0)] > 0) { light = true; break; }
    }
  }
  if (!light) return;
  u.lit = true; u.burnUntil = t + (s.burnSec || 30); u.nextFlame = t;
  world.effects.push({ kind: 'fireburst', x: u.x, y: u.y, r: 12, t0: t, dur: 1 });
  sound(world, 'fire', u.x, u.y, 0.7, 4);
}

// Spike strips slow zombies standing on them and wear out; oil slicks catch alight a few seconds after a zombie steps in.
function lineSystem(world, dt) {
  const C = world.combat, A = world.A, mask = C.lineMask, g = world.grid, inv = 1 / g.cell, gw = g.gw, pass = world.nav.pass;
  const X = A.x, Y = A.y, VX = A.vx, VY = A.vy, type = A.type, sub = A.sub, stun = A.stun;
  const giantMul = (world.cfg.mutation.kinds.giant && world.cfg.mutation.kinds.giant.wallDpsMul) || 1;
  for (let i = 0, n = A.n; i < n; i++) {
    if (type[i] !== ZOMBIE) continue;
    const c = ((Y[i] * inv) | 0) * gw + ((X[i] * inv) | 0), m = mask[c];
    if (!m) continue;
    if (m & 1) {
      const e = C.spikeAt.get(c);
      if (e && stun[i] <= 0) {
        const u = e[0], k = e[1], slow = stats(world, u).slow || 0;
        const nx = X[i] - VX[i] * dt * slow, ny = Y[i] - VY[i] * dt * slow;
        const nc = ((ny * inv) | 0) * gw + ((nx * inv) | 0);
        if (pass[nc] & (P_ZOM | P_SWIM)) { X[i] = nx; Y[i] = ny; }
        u.dur[k] -= dt * (sub[i] === ZSUB.GIANT ? giantMul : 1);
        if (u.dur[k] <= 0) {
          C.spikeAt.delete(c); mask[c] &= ~1;
          if (--u.left <= 0) destroyUnit(world, u, 'consumed');
        }
      }
    }
    if (m & 2) {
      const u = C.oilAt.get(c);
      if (u && u.alive && !u.lit && u.igniteAt < 0) u.igniteAt = world.t + (stats(world, u).autoIgnite || 0);
    }
  }
}

// Zombies scratch at ground units they touch (wall damage per zombie; giants hit harder).
function touchDamage(world, dt) {
  if (world.counts[ZOMBIE] <= 0) return;
  const A = world.A, zc = world.cfg.zombie, R = zc.touchRadius + UNIT_R;
  const giantMul = (world.cfg.mutation.kinds.giant && world.cfg.mutation.kinds.giant.wallDpsMul) || 1;
  for (const u of world.units) {
    if (!u.alive || !u.hpMax || !zombiesNear(world, u.x, u.y, R)) continue;
    let n = 0;
    world.query(u.x, u.y, R, M_ZOMBIE, (i) => { if (A.stun[i] <= 0) n += A.sub[i] === ZSUB.GIANT ? giantMul : 1; });
    if (!n) continue;
    u.hp -= zc.wallDps * dt * n;
    if (u.hp <= 0) destroyUnit(world, u, 'overrun');
  }
}

// ---------------------------------------------------------------- system
// Seconds since READY before a unit may fire: guns outside a safe zone wait outsideStartDelay
// (spread over a few ticks so a large defence does not acquire targets all at once).
export function placedReadyAt(world, u) {
  const k = kindOf(world, u.type);
  if (!(k === 'direct' || k === 'arty' || k === 'rail') || unitInZone(world, u)) return 0;
  return (world.cfg.zone.outsideStartDelay || 0) + (u.id % 8) * world.cfg.sim.dt;
}

function beginBattle(world) {
  world.combat.started = true;
  for (const u of world.units) if (u.alive) u.readyAt = placedReadyAt(world, u);
}

export function combatSystem(world, dt) {
  const C = world.combat;
  if (!C.started) beginBattle(world);
  if (C.snipers > 0 && world.tick % 10 === 0) refreshMutants(world);
  const units = world.units;
  const anyZ = world.counts[ZOMBIE] > 0;
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (!u.alive) continue;
    const kind = kindOf(world, u.type);
    if (kind === 'direct' || kind === 'arty' || kind === 'rail') {
      if (!anyZ && u.reloadT <= 0 && u.ammo > 0) { if (u.cd > 0) u.cd -= dt; continue; }
      const s = stats(world, u);
      if (kind === 'direct') fireDirect(world, u, s, dt);
      else if (kind === 'arty') fireArty(world, u, s, dt);
      else fireRail(world, u, s, dt);
    } else if (kind === 'trap') {
      if (!anyZ || ((world.tick + u.id) & 1)) continue;
      const s = stats(world, u);
      if (world.nearest(u.x, u.y, s.trigger || 3, M_ZOMBIE) >= 0) triggerTrap(world, u, s);
    } else if (kind === 'oil') updateOil(world, u, stats(world, u));
  }
  landShells(world);
  if (C.lineCount > 0 && anyZ) lineSystem(world, dt);
  if ((world.tick & 1) === 0) touchDamage(world, dt * 2);
  if (C.shotN && world.tick - (C.snd.shot ?? -1e9) >= 2) {
    sound(world, 'shot', 0, 0, Math.min(1, C.shotN / 8), 2);
    C.shotN = 0;
  }
}

export function resetCombatRuntime(world) {
  const C = world.combat;
  C.started = false;
  C.shells.length = 0;
  C.mutants.length = 0;
  C.shotN = 0;
  C.snd = {};
  C.logT = {};
}
