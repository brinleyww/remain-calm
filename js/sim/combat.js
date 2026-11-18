// Unit weapons: stats with upgrades and auras, targeting, fire, shells, ammo and reloads, traps, unit damage.
import { T } from '../map/format.js';
import { rasterPolyline } from '../util/geom.js';
import { ZOMBIE, ZSUB, M_ZOMBIE, zombieHp } from './agents.js';
import { P_ZOM, P_SWIM, INF, isWalkTerrain } from './nav.js';

export const abilityKey = (id) => 'ability:' + id;

const STAT_KEYS = ['dmg', 'rof', 'mag', 'reloads', 'reloadSec', 'range', 'minRange', 'accuracy', 'splash', 'stunSec', 'fire',
  'rockets', 'spread', 'shells', 'shellSpeed', 'bldgDmg', 'bridgeDmg', 'width', 'hp', 'trigger', 'fireRadius', 'slow',
  'durability', 'burnSec', 'autoIgnite', 'hull', 'speed', 'capacity'];
const INT_STATS = new Set(['mag', 'reloads', 'rockets', 'shells']);
const RESTOCK_SEC = 8;   // a Supply aura restocks an empty turret in this time (before the aura's reload multiplier)
const SCAN_SEC = 0.25;   // how often an idle weapon looks for a target
const UNIT_R = 1.5;      // footprint radius of ground units, added to the zombie touch radius
export const STATS_TTL = 20; // ticks a cached stat block stays valid (auras can change mid-battle)

// ---------------------------------------------------------------- definitions and stats
export function weaponKind(def) {
  if (!def) return 'none';
  if (def.boat) return 'boat';   // boats fire from their vehicle (js/sim/naval.js)
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
  s.wet = !!def.water;
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
    shellVer: 0, tg: null,
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

// Any zombie within r standing in the water (water mines ignore the ones on the quay or a bridge deck)?
function wetZombieNear(world, x, y, r) {
  if (!zombiesNear(world, x, y, r)) return false;
  const A = world.A, g = world.grid, terr = g.terrain, inv = 1 / g.cell;
  let hit = false;
  world.query(x, y, r, M_ZOMBIE, (i) => {
    if (terr[((A.y[i] * inv) | 0) * g.gw + ((A.x[i] * inv) | 0)] !== T.WATER) return true;
    hit = true;
    return false;
  });
  return hit;
}

function refreshMutants(world) {
  const A = world.A, list = world.combat.mutants;
  list.length = 0;
  for (let i = 0, n = A.n; i < n; i++) if (A.type[i] === ZOMBIE && A.sub[i]) list.push(i);
}

// ---------------------------------------------------------------- target choice
// Everything here is derived from sim state and rebuilt on demand (never saved): claims are the expected damage
// shooters put on each zombie slot over the last claimSec, reservations are the shells still in flight (bucketed by
// 32 m block), and threat comes from the zombie scent field (path distance to the nearest person; walls and gates
// count extra, so zombies at a zone's wall rank high).
const MAXP = 512, MAXR = 2048;

function tgState(world) {
  const C = world.combat, sh = world.sh, g = world.grid, nb = sh.bzw * sh.bzh, cap = world.A.cap, tc = world.cfg.targeting || {};
  return (C.tg = {
    win: Math.max(1, Math.round((tc.claimSec ?? 0.5) / world.cfg.sim.dt)),
    tk: tc.threatMul ?? 3, td: Math.max(1, tc.threatDist ?? 40), dm: g.cell / 10, gi: 1 / g.cell, gw: g.gw,
    cand: tc.directCand || 24, armedCand: tc.armedCand || 10, artyCand: tc.artyCand || 5,
    hpTick: -1, hp: new Float64Array(8),
    cv: new Float32Array(cap), ct: new Int32Array(cap),
    ver: -1, gen: 0, bHead: new Int32Array(nb), bStamp: new Int32Array(nb), eShell: new Int32Array(256), eNext: new Int32Array(256),
    dist: null, distRef: null, distLast: NaN, epoch: 1, thrB: new Float32Array(nb), thrStamp: new Int32Array(nb),
    cb: new Int32Array(16), cs: new Float64Array(16),
    px: new Float64Array(MAXR), py: new Float64Array(MAXR), ph: new Float64Array(MAXR), pt: new Float64Array(MAXR),
    aim: [0, 0, 0, 0],
  });
}

function tgSync(world) {
  const S = world.combat.tg || tgState(world);
  if (S.hpTick !== world.tick) {
    S.hpTick = world.tick;
    for (let k = 0; k < 5; k++) S.hp[k] = zombieHp(world, k);
    const f = world.nav && world.nav.scent, d = f && f.dist;
    if (!d || d.length !== world.grid.gw * world.grid.gh) S.dist = null;
    else {
      if (d !== S.distRef || f.last !== S.distLast) { S.distRef = d; S.distLast = f.last; S.epoch++; }
      S.dist = d;
    }
  }
  return S;
}

const hpLeft = (S, A, i) => A.hp[i] * S.hp[A.sub[i]] + A.shield[i];

function claimAt(S, tick, i) {
  if (i >= S.ct.length) return 0;
  const age = tick + 1 - S.ct[i];
  return age < 0 || age >= S.win ? 0 : S.cv[i] * (S.win - age) / S.win;
}

// Expected damage a shooter just put on zombie i; other shooters treat it as covered for claimSec.
export function addClaim(world, i, e) {
  if (!world.combat || i < 0 || !(e > 0)) return;
  const S = tgSync(world), t = world.tick;
  if (i >= S.ct.length) {
    const cap = Math.max(world.A.cap, S.ct.length * 2), cv = new Float32Array(cap), ct = new Int32Array(cap);
    cv.set(S.cv); ct.set(S.ct); S.cv = cv; S.ct = ct;
  }
  S.cv[i] = claimAt(S, t, i) + e;
  S.ct[i] = t + 1;
}

function thrOf(S, v) { return v === undefined || v === INF ? 1 : 1 + S.tk * S.td / (S.td + v * S.dm); }

function thrAt(S, x, y) {
  return S.dist ? thrOf(S, S.dist[((y * S.gi) | 0) * S.gw + ((x * S.gi) | 0)]) : 1;
}

// Threat of a 32 m block: from the lowest scent distance among its cells, cached until the scent field changes.
function thrBlock(world, S, b) {
  if (!S.dist) return 1;
  if (S.thrStamp[b] === S.epoch) return S.thrB[b];
  const sh = world.sh, g = world.grid, bz = sh.bz, bx = b % sh.bzw, by = (b / sh.bzw) | 0, d = S.dist;
  const x0 = Math.floor(bx * bz * S.gi), y0 = Math.floor(by * bz * S.gi);
  const x1 = Math.min(g.gw - 1, Math.ceil((bx + 1) * bz * S.gi) - 1), y1 = Math.min(g.gh - 1, Math.ceil((by + 1) * bz * S.gi) - 1);
  let m = INF;
  for (let cy = y0; cy <= y1; cy++) { const row = cy * g.gw; for (let cx = x0; cx <= x1; cx++) { const v = d[row + cx]; if (v < m) m = v; } }
  const t = thrOf(S, m);
  S.thrB[b] = t; S.thrStamp[b] = S.epoch;
  return t;
}

// Buckets the shells in flight by every 32 m block their blast overlaps (rebuilt whenever the shell list changes).
function shellBuckets(world, S) {
  const C = world.combat;
  if (S.ver === C.shellVer) return;
  S.ver = C.shellVer;
  const gen = ++S.gen, list = C.shells, sh = world.sh, ib = 1 / sh.bz, bw = sh.bzw, bh = sh.bzh;
  let ne = 0;
  for (let k = 0; k < list.length; k++) {
    const s = list[k], r = s.r || 0;
    const bx0 = Math.max(0, ((s.x - r) * ib) | 0), bx1 = Math.min(bw - 1, ((s.x + r) * ib) | 0);
    const by0 = Math.max(0, ((s.y - r) * ib) | 0), by1 = Math.min(bh - 1, ((s.y + r) * ib) | 0);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      if (ne >= S.eShell.length) {
        const a = new Int32Array(ne * 2), n2 = new Int32Array(ne * 2);
        a.set(S.eShell); n2.set(S.eNext); S.eShell = a; S.eNext = n2;
      }
      const b = by * bw + bx;
      S.eShell[ne] = k; S.eNext[ne] = S.bStamp[b] === gen ? S.bHead[b] : -1; S.bHead[b] = ne; S.bStamp[b] = gen; ne++;
    }
  }
}

// Shells in flight at (x, y): expected damage (kind 0), or 1 if a gas (kind 1) / fire (kind 2) shell already covers it.
function incoming(world, S, x, y, kind) {
  const sh = world.sh, bx = (x / sh.bz) | 0, by = (y / sh.bz) | 0;
  if (bx < 0 || by < 0 || bx >= sh.bzw || by >= sh.bzh) return 0;
  const b = by * sh.bzw + bx;
  if (S.bStamp[b] !== S.gen) return 0;
  const list = world.combat.shells;
  let v = 0;
  for (let e = S.bHead[b]; e >= 0; e = S.eNext[e]) {
    const s = list[S.eShell[e]], r = s.r, dx = s.x - x, dy = s.y - y, d2 = dx * dx + dy * dy;
    if (!(r > 0) || d2 > r * r) continue;
    if (kind === 0) { if (s.dmg > 0) v += s.dmg * (1 - 0.75 * Math.sqrt(d2) / r); }
    else if (kind === 1 ? s.stunSec > 0 : s.fire > 0) return 1;
  }
  return v;
}

// Rough share of a block's zombies that shells in flight will already deal with.
function blockCover(world, S, b, kind, hp0) {
  if (S.bStamp[b] !== S.gen) return 0;
  const sh = world.sh, bz = sh.bz, x0 = (b % sh.bzw) * bz, y0 = ((b / sh.bzw) | 0) * bz, list = world.combat.shells;
  let f = 0;
  for (let e = S.bHead[b]; e >= 0; e = S.eNext[e]) {
    const s = list[S.eShell[e]], r = s.r;
    let k;
    if (kind === 0) { if (!(s.dmg > 0)) continue; k = Math.min(1, s.dmg * 0.6 / hp0); }
    else if (kind === 1 ? s.stunSec > 0 : s.fire > 0) k = 1;
    else continue;
    const ox = Math.min(s.x + r, x0 + bz) - Math.max(s.x - r, x0), oy = Math.min(s.y + r, y0 + bz) - Math.max(s.y - r, y0);
    if (ox <= 0 || oy <= 0) continue;
    f += ox * oy * 1.18 * k / (bz * bz);
    if (f >= 1) return 1;
  }
  return f;
}

// Direct fire: among the nearest `cap` zombies within r of (x, y), the one most dangerous to people that other
// shooters have not already covered (claims), nearer first. mode 1 (snipers) prefers far targets with HP to spare.
// shot = expected damage of one shot. Falls back to a covered zombie rather than idling.
export function pickDirect(world, x, y, r, shot, mode = 0, cap = 0) {
  if (world.counts[ZOMBIE] <= 0 || !(r > 0)) return -1;
  const S = tgSync(world), tick = world.tick;
  const sh = world.sh, bz = sh.bz, ib = 1 / bz, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh;
  const hw = sh.hw, hh = sh.hh, headZ = sh.headZ, next = sh.next, per = Math.max(1, Math.round(bz / sh.hcell));
  const A = world.A, type = A.type, X = A.x, Y = A.y;
  const r2 = r * r, ir = 1 / r, bx0 = (x * ib) | 0, by0 = (y * ib) | 0, K = Math.ceil(r * ib) + 1, lim = cap || S.cand;
  const sp = shot > 0 ? shot : 1;
  let best = -1, bs = -1, seen = 0;
  for (let k = 0; k <= K && seen < lim; k++) {
    const ya = by0 - k, yb = by0 + k;
    for (let by = ya; by <= yb; by++) {
      if (by < 0 || by >= bh) continue;
      const step = by === ya || by === yb ? 1 : 2 * k, ny = y < by * bz ? by * bz - y : y > (by + 1) * bz ? y - (by + 1) * bz : 0;
      for (let bx = bx0 - k; bx <= bx0 + k; bx += step) {
        if (bx < 0 || bx >= bw || !blk[by * bw + bx]) continue;
        const nx = x < bx * bz ? bx * bz - x : x > (bx + 1) * bz ? x - (bx + 1) * bz : 0;
        if (nx * nx + ny * ny > r2) continue;
        const cy1 = Math.min(hh, (by + 1) * per), cx1 = Math.min(hw, (bx + 1) * per);
        for (let cy = by * per; cy < cy1; cy++) for (let cx = bx * per; cx < cx1; cx++) {
          for (let j = headZ[cy * hw + cx]; j >= 0; j = next[j]) {
            if (type[j] !== ZOMBIE) continue;
            const dx = X[j] - x, dy = Y[j] - y, d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            seen++;
            const unc = hpLeft(S, A, j) - claimAt(S, tick, j), f = Math.sqrt(d2) * ir, thr = thrAt(S, X[j], Y[j]);
            let s = mode === 1 ? thr * (0.4 + 0.6 * Math.max(0, Math.min(1, unc / sp))) * (0.6 + 0.4 * f) : thr * (1 - 0.4 * f);
            if (unc <= 0) s *= 0.02;
            if (s > bs) { bs = s; best = j; }
          }
        }
      }
    }
  }
  return best;
}

function nearestMutant(world, x, y, r) {
  const A = world.A, list = world.combat.mutants, S = tgSync(world), tick = world.tick;
  let best = -1, bd = r * r, alt = -1, ad = r * r;
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    if (A.type[i] !== ZOMBIE || !A.sub[i]) continue;
    const dx = A.x[i] - x, dy = A.y[i] - y, d2 = dx * dx + dy * dy;
    if (hpLeft(S, A, i) - claimAt(S, tick, i) > 0) { if (d2 <= bd) { bd = d2; best = i; } }
    else if (d2 <= ad) { ad = d2; alt = i; }
  }
  return best >= 0 ? best : alt;
}

// Artillery: the aim point inside the ring [minR, maxR] around (x, y) with the highest expected value, i.e.
// zombies the salvo would hurt that shells already in flight will not, times their threat. Blocks are ranked cheaply
// first, then the best few are refined on zombie positions predicted at landing (lead by flight time).
// w: { r, dmg, n, spread (salvo scatter), speed, kind 0 damage / 1 gas / 2 fire, minC (heavy guns), ox, oy (muzzle) }.
// Returns a shared [x, y, value, count] or null when nothing in range is left uncovered.
export function pickArty(world, x, y, minR, maxR, w) {
  if (world.counts[ZOMBIE] <= 0) return null;
  const S = tgSync(world);
  shellBuckets(world, S);
  const sh = world.sh, bz = sh.bz, ib = 1 / bz, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh, kind = w.kind | 0;
  const bx0 = Math.max(0, ((x - maxR) * ib) | 0), bx1 = Math.min(bw - 1, ((x + maxR) * ib) | 0);
  const by0 = Math.max(0, ((y - maxR) * ib) | 0), by1 = Math.min(bh - 1, ((y + maxR) * ib) | 0);
  const lo = Math.max(0, minR - bz * 0.5), hi = maxR + bz * 0.25, lo2 = lo * lo, hi2 = hi * hi;
  const K = Math.min(16, kind ? S.artyCand + 3 : S.artyCand), cb = S.cb, cs = S.cs, hp0 = S.hp[0] || 1, minC = w.minC || 1;
  let nc = 0;
  for (let by = by0; by <= by1; by++) {
    const cy = (by + 0.5) * bz - y, row = by * bw;
    for (let bx = bx0; bx <= bx1; bx++) {
      const n = blk[row + bx];
      if (!n) continue;
      const cx = (bx + 0.5) * bz - x, d2 = cx * cx + cy * cy;
      if (d2 < lo2 || d2 > hi2) continue;
      const b = row + bx, ne = n * (1 - blockCover(world, S, b, kind, hp0));
      if (ne < 0.25) continue;
      let sc = ne * thrBlock(world, S, b) * (1 - 0.15 * Math.sqrt(d2) / hi);
      if (ne < minC) sc *= 0.1;
      if (nc === K && sc <= cs[K - 1]) continue;
      let p = nc < K ? nc++ : K - 1;
      while (p > 0 && cs[p - 1] < sc) { cs[p] = cs[p - 1]; cb[p] = cb[p - 1]; p--; }
      cs[p] = sc; cb[p] = b;
    }
  }
  if (!nc) return null;
  const A = world.A, X = A.x, Y = A.y, VX = A.vx, VY = A.vy, ST = A.stun;
  const ox = w.ox ?? x, oy = w.oy ?? y, r = w.r || 8, spread = w.spread || 0, salvo = spread > r * 0.5, shells = Math.max(1, w.n || 1);
  const Rev = salvo ? spread + r : r, Rev2 = Rev * Rev, q = bz * 0.75 + Rev, speed = w.speed || 150, lo1 = Math.max(0, minR), hi1 = maxR;
  const hit = salvo ? shells * Math.min(1, (r * r) / (spread * spread)) * 0.6 : shells;
  const fire = world.fire, nav = world.nav, cinv = 1 / nav.ccell, cgw = nav.cgw, mw = world.map.w - 1, mh = world.map.h - 1;
  const PX = S.px, PY = S.py, PH = S.ph, PT = S.pt, own2 = bz * bz * 0.5625;
  let bev = 0, bax = 0, bay = 0, bn = 0;
  for (let c = 0; c < nc; c++) {
    const b = cb[c], cx = (b % bw + 0.5) * bz, cy = (((b / bw) | 0) + 0.5) * bz;
    const T0 = Math.hypot(cx - ox, cy - oy) / speed;
    let np = 0;
    world.query(cx, cy, q, M_ZOMBIE, (i) => {
      if (np >= MAXP) return false;
      const mv = T0 - ST[i];
      let px = X[i], py = Y[i];
      if (mv > 0) { px += VX[i] * mv; py += VY[i] * mv; px = px < 1 ? 1 : px > mw ? mw : px; py = py < 1 ? 1 : py > mh ? mh : py; }
      let h = 1;
      if (kind === 0) { h = hpLeft(S, A, i) - incoming(world, S, px, py, 0); if (h <= 0) return; }
      else if (kind === 1) { if (ST[i] > T0 + 0.5 || incoming(world, S, px, py, 1)) return; }
      else if (fire[((py * cinv) | 0) * cgw + ((px * cinv) | 0)] > 0 || incoming(world, S, px, py, 2)) return;
      PX[np] = px; PY[np] = py; PH[np] = h; PT[np] = thrAt(S, px, py); np++;
    });
    if (!np) continue;
    let ax = 0, ay = 0, sw = 0;
    for (let k = 0; k < np; k++) {
      const dx = PX[k] - cx, dy = PY[k] - cy;
      if (dx * dx + dy * dy <= own2) { ax += PX[k] * PT[k]; ay += PY[k] * PT[k]; sw += PT[k]; }
    }
    if (!sw) continue;
    ax /= sw; ay /= sw;
    for (let it = 0; it < 2; it++) {
      let sx = 0, sy = 0, s2 = 0;
      for (let k = 0; k < np; k++) {
        const dx = PX[k] - ax, dy = PY[k] - ay;
        if (dx * dx + dy * dy <= Rev2) { sx += PX[k] * PT[k]; sy += PY[k] * PT[k]; s2 += PT[k]; }
      }
      if (s2) { ax = sx / s2; ay = sy / s2; }
    }
    const dd = Math.hypot(ax - x, ay - y);
    if (dd < lo1 || dd > hi1) {
      let kb = -1, tb = -1;
      for (let k = 0; k < np; k++) {
        const d = Math.hypot(PX[k] - x, PY[k] - y);
        if (d >= lo1 && d <= hi1 && PT[k] > tb) { tb = PT[k]; kb = k; }
      }
      if (kb < 0) continue;
      ax = PX[kb]; ay = PY[kb];
    }
    let ev = 0, n = 0;
    for (let k = 0; k < np; k++) {
      const dx = PX[k] - ax, dy = PY[k] - ay, d2 = dx * dx + dy * dy;
      if (d2 > Rev2) continue;
      n++;
      if (kind) { ev += PT[k]; continue; }
      const d = Math.sqrt(d2);
      const dmg = (w.dmg || 0) * hit * (salvo ? Math.min(1, Math.max(0, (spread + r - d) / (2 * r))) : 1 - 0.75 * d / r);
      ev += PT[k] * Math.max(0.2, Math.min(1, dmg / PH[k]));
    }
    if (ev > bev) { bev = ev; bax = ax; bay = ay; bn = n; }
  }
  if (!(bev > 0)) return null;
  const out = S.aim;
  out[0] = bax; out[1] = bay; out[2] = bev; out[3] = bn;
  return out;
}

// Kept for callers that only need a plain damage aim point. Returns [x, y, count] or null.
export function pickCluster(world, x, y, minR, maxR) {
  const a = pickArty(world, x, y, minR, maxR, { r: 12, dmg: 40, n: 1, speed: 150, kind: 0 });
  return a ? [a[0], a[1], a[3]] : null;
}

// Rail cannon: the line from (x, y) that crosses the most uncovered zombies (weighted by threat), tried through a
// sample of the zombies in range. Returns a shared [x, y, value, count] aim point on that line, or null.
export function pickRail(world, x, y, range, hw) {
  if (world.counts[ZOMBIE] <= 0) return null;
  const S = tgSync(world), tick = world.tick;
  shellBuckets(world, S);
  const sh = world.sh, bz = sh.bz, ib = 1 / bz, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh;
  const hcw = sh.hw, hch = sh.hh, headZ = sh.headZ, next = sh.next, per = Math.max(1, Math.round(bz / sh.hcell));
  const A = world.A, type = A.type, X = A.x, Y = A.y, r2 = range * range, reach = range + bz * 0.71, reach2 = reach * reach;
  const bx0 = Math.max(0, ((x - range) * ib) | 0), bx1 = Math.min(bw - 1, ((x + range) * ib) | 0);
  const by0 = Math.max(0, ((y - range) * ib) | 0), by1 = Math.min(bh - 1, ((y + range) * ib) | 0);
  const PX = S.px, PY = S.py, PT = S.pt;
  let np = 0;
  for (let by = by0; by <= by1 && np < MAXR; by++) {
    const cy = (by + 0.5) * bz - y;
    for (let bx = bx0; bx <= bx1 && np < MAXR; bx++) {
      if (!blk[by * bw + bx]) continue;
      const cx = (bx + 0.5) * bz - x;
      if (cx * cx + cy * cy > reach2) continue;
      const cy1 = Math.min(hch, (by + 1) * per), cx1 = Math.min(hcw, (bx + 1) * per);
      for (let gy = by * per; gy < cy1; gy++) for (let gx = bx * per; gx < cx1; gx++) {
        for (let j = headZ[gy * hcw + gx]; j >= 0 && np < MAXR; j = next[j]) {
          if (type[j] !== ZOMBIE) continue;
          const dx = X[j] - x, dy = Y[j] - y;
          if (dx * dx + dy * dy > r2) continue;
          if (hpLeft(S, A, j) - incoming(world, S, X[j], Y[j], 0) - claimAt(S, tick, j) <= 0) continue;
          PX[np] = X[j]; PY[np] = Y[j]; PT[np] = thrAt(S, X[j], Y[j]); np++;
        }
      }
    }
  }
  if (!np) return null;
  const step = Math.max(1, Math.ceil(np / 48));
  let bv = 0, ba = -1, bc = 0;
  for (let a = 0; a < np; a += step) {
    let dx = PX[a] - x, dy = PY[a] - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1) continue;
    dx /= d; dy /= d;
    let v = 0, c = 0;
    for (let k = 0; k < np; k++) {
      const ox = PX[k] - x, oy = PY[k] - y, along = ox * dx + oy * dy;
      if (along < 0 || along > range) continue;
      const perp = oy * dx - ox * dy;
      if (perp > hw || perp < -hw) continue;
      v += PT[k]; c++;
    }
    if (v > bv) { bv = v; ba = a; bc = c; }
  }
  if (ba < 0) return null;
  const out = S.aim;
  out[0] = PX[ba]; out[1] = PY[ba]; out[2] = bv; out[3] = bc;
  return out;
}

// Queues an exploding shell that lands at world.t + dur and calls world.damageArea.
// o: { r, dmg, src, friendly, stunSec, fire, bldgDmg, bridgeDmg, wallDmg, fx, fxR, snd, u }
export function queueShell(world, x, y, dur, o) {
  world.combat.shells.push({ at: world.t + Math.max(0, dur), x, y, ...o });
  world.combat.shellVer++;
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
  if (due.length) world.combat.shellVer++;
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
// Keeps its target while it lives and stays in range; re-picks at once when it is lost (a kill by anyone).
function acquireDirect(world, u, s, acc) {
  const A = world.A, r = s.range, r2 = r * r;
  let t = u.tgt, lost = false;
  if (t >= 0) {
    if (A.type[t] !== ZOMBIE) { t = -1; lost = true; }
    else { const dx = A.x[t] - u.x, dy = A.y[t] - u.y; if (dx * dx + dy * dy > r2) { t = -1; lost = true; } }
  }
  const wantMutant = s.priority === 'mutant' && world.combat.mutants.length > 0;
  if (t >= 0 && !(wantMutant && !A.sub[t] && world.t >= u.scanT)) return t;
  if (t < 0 && !lost && world.t < u.scanT) return -1;
  u.scanT = world.t + SCAN_SEC + (u.id % 5) * 0.04;
  let n = wantMutant ? nearestMutant(world, u.x, u.y, r) : -1;
  if (n < 0 && t < 0) n = pickDirect(world, u.x, u.y, r, (s.dmg || 0) * acc, s.priority === 'mutant' ? 1 : 0);
  if (n >= 0) t = n;
  u.tgt = t;
  return t;
}

function fireDirect(world, u, s, dt) {
  if (!gunReady(world, u, s, dt)) return;
  const acc = s.accuracy ?? world.cfg.armed.accuracy ?? 0.8;
  const t = acquireDirect(world, u, s, acc);
  if (t < 0) { u.cd = 0; return; }
  const A = world.A, rng = world.rng;
  const tx = A.x[t], ty = A.y[t];
  let shots = 0;
  while (u.cd <= 0 && u.ammo > 0 && shots < 6) {
    shots++; u.ammo--; u.shots++;
    u.cd += s.rof;
    if (rng.next() < acc && world.damageAgent(t, s.dmg, u.type)) { u.kills++; u.tgt = -1; u.scanT = 0; break; }
  }
  if (A.type[t] === ZOMBIE) addClaim(world, t, shots * s.dmg * acc);
  u.ax = tx; u.ay = ty; u.fireT = world.t;
  const sniper = u.type === 'sniper';
  world.projectiles.push({ kind: 'tracer', x0: u.x, y0: u.y, x1: tx, y1: ty, t0: world.t, dur: sniper ? 0.12 : 0.06, src: u.type });
  if (sniper) sound(world, 'snipe', u.x, u.y, 0.5, 4);
  else world.combat.shotN += shots;
}

const ARTY_W = { r: 8, dmg: 0, n: 1, spread: 0, speed: 150, kind: 0, minC: 1, ox: 0, oy: 0 };

function fireArty(world, u, s, dt) {
  if (!gunReady(world, u, s, dt)) return;
  if (world.t < u.scanT) return;
  const n = Math.max(1, s.shells || s.rockets || 1), W = ARTY_W;
  W.r = s.splash || 8; W.dmg = s.dmg || 0; W.n = n; W.spread = s.spread || (n > 1 ? (s.splash || 10) * 1.5 : 0);
  W.speed = s.shellSpeed || 150; W.kind = s.stunSec ? 1 : s.fire ? 2 : 0; W.minC = world.cfg.units[u.type].minCluster || 1;
  W.ox = u.x; W.oy = u.y;
  const pick = pickArty(world, u.x, u.y, s.minRange || 0, s.range, W);
  if (!pick) { u.scanT = world.t + 0.5 + (u.id % 5) * 0.05; u.cd = 0; return; }
  const aim = [pick[0], pick[1]];
  const rng = world.rng, ff = world.cfg.friendlyFire, mul = ff.autoStructureMul;
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
  const hw = (s.width || 3) * 0.5 + 0.5, aim = pickRail(world, u.x, u.y, s.range, hw);
  if (!aim) { u.scanT = world.t + 0.5; u.cd = 0; return; }
  let dx = aim[0] - u.x, dy = aim[1] - u.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  const x1 = u.x + dx * s.range, y1 = u.y + dy * s.range;
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
    world.effects.push({ kind: s.wet ? 'splash' : 'boom', x, y, r: (s.splash || 6) * 1.2, t0: world.t, dur: s.wet ? 1 : 0.5 });
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
      if (s.wet ? wetZombieNear(world, u.x, u.y, s.trigger || 3) : world.nearest(u.x, u.y, s.trigger || 3, M_ZOMBIE) >= 0) triggerTrap(world, u, s);
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
  C.shellVer++;
  C.tg = null;
  C.mutants.length = 0;
  C.shotN = 0;
  C.snd = {};
  C.logT = {};
}
