// Agents: SoA store with free list, per-tick spatial hash, civilian / zombie / turning / armed behaviour.
import { T } from '../map/format.js';
import { P_CIV, P_ZOM, P_SWIM, P_WALL, P_GATE, DX, DY, corridorContains, nearestPassable } from './nav.js';
import { breachZone, corridorField } from './zones.js';
import { damageWallCell } from './structures.js';
import { explodeAt } from './mutants.js';
import { fireKey } from './fire.js';

export const FREE = 0, CIV = 1, ZOMBIE = 2, TURNING = 3, POLICE = 4, MILITIA = 5, SOLDIER = 6;
export const TYPE = Object.freeze({ FREE, CIV, ZOMBIE, TURNING, POLICE, MILITIA, SOLDIER });
export const TYPE_KEYS = ['free', 'civ', 'zombie', 'turning', 'police', 'militia', 'soldier'];
export const M_CIV = 1 << CIV, M_ZOMBIE = 1 << ZOMBIE, M_TURNING = 1 << TURNING;
export const M_POLICE = 1 << POLICE, M_MILITIA = 1 << MILITIA, M_SOLDIER = 1 << SOLDIER;
export const M_ARMED = M_POLICE | M_MILITIA | M_SOLDIER, M_HUMAN = M_CIV | M_ARMED, M_ALL = M_HUMAN | M_ZOMBIE | M_TURNING;
export const CS = Object.freeze({ CALM: 0, PANIC: 1, SAFE: 2, HELD: 3, CORRIDOR: 4, BOARDING: 5, EVAC: 6 });
export const ZSUB = Object.freeze({ NORMAL: 0, EXPLOSIVE: 1, SHIELDED: 2, SWIMMER: 3, GIANT: 4 });
export const SUB_KEYS = ['normal', 'explosive', 'shielded', 'swimmer', 'giant'];

const F32 = ['x', 'y', 'vx', 'vy', 'hp', 'timer', 'panic', 'tx', 'ty', 'cd', 'stun', 'shield'];
const U8 = ['type', 'sub', 'state', 'owner', 'aux'];
const I32 = ['group', 'tgt'];

const K_CIV = 5, K_ARMED = 3;
const SAFE_ROAM = 14;

function alloc(cap, old) {
  const A = old || { n: 0, cap: 0, count: 0, nfree: 0 };
  const mk = (C, k, len) => { const a = new C(len); if (old && old[k]) a.set(old[k]); A[k] = a; };
  for (const k of F32) mk(Float32Array, k, cap);
  for (const k of U8) mk(Uint8Array, k, cap);
  for (const k of I32) mk(Int32Array, k, cap);
  mk(Int16Array, 'ammo', cap);
  mk(Float32Array, 'home', cap * 2);
  mk(Int32Array, 'free', cap);
  A.cap = cap;
  return A;
}

export function initAgents(world, cap = 4096) {
  world.A = alloc(cap);
  world.counts = new Int32Array(8);
  world.groupStats = {};
  const sh = world.cfg.sim.hashCell || 8;
  const hw = Math.ceil(world.map.w / sh) + 1, hh = Math.ceil(world.map.h / sh) + 1, hN = hw * hh;
  const b1 = Math.max(1, Math.round(32 / sh)), b2 = Math.max(1, Math.round(64 / sh));
  world.sh = {
    hcell: sh, inv: 1 / sh, hw, hh, hN,
    headH: new Int32Array(hN).fill(-1), headZ: new Int32Array(hN).fill(-1), headT: new Int32Array(hN).fill(-1),
    next: new Int32Array(cap), cntZ: new Uint16Array(hN), cntC: new Uint16Array(hN), cntP: new Uint16Array(hN),
    mark: new Uint32Array(hN), gen: 1, touched: new Int32Array(hN), nt: 0,
    bz: b1 * sh, bzw: Math.ceil(hw / b1) + 1, bzh: Math.ceil(hh / b1) + 1,
    bh: b2 * sh, bhw: Math.ceil(hw / b2) + 1, bhh: Math.ceil(hh / b2) + 1,
  };
  const S = world.sh;
  S.blkZ = new Uint16Array(S.bzw * S.bzh);
  S.blkP = new Uint16Array(S.bzw * S.bzh);
  S.blkH = new Uint16Array(S.bhw * S.bhh);
  S.zCol = Int32Array.from({ length: hw }, (_, k) => (k / b1) | 0);
  S.zRow = Int32Array.from({ length: hh }, (_, k) => ((k / b1) | 0) * S.bzw);
  S.hCol = Int32Array.from({ length: hw }, (_, k) => (k / b2) | 0);
  S.hRow = Int32Array.from({ length: hh }, (_, k) => ((k / b2) | 0) * S.bhw);
  S.panicked = 0;
}

export function clearAgents(world) {
  const A = world.A;
  A.type.fill(0, 0, A.n);
  A.n = 0; A.count = 0; A.nfree = 0;
  world.counts.fill(0);
  world.groupStats = {};
  rebuildHash(world);
}

function ensureCap(world, need) {
  const A = world.A;
  if (need <= A.cap) return;
  let cap = A.cap;
  while (cap < need) cap *= 2;
  alloc(cap, A);
  const nx = new Int32Array(cap); nx.set(world.sh.next); world.sh.next = nx;
}

export function hardCap(world) { return Math.floor((world.cfg.sim.maxAgents || 90000) * 1.5); }

export function spawnAgent(world, type, x, y, sub = 0) {
  const A = world.A;
  if (!type || A.count >= hardCap(world)) return -1;
  const g = world.grid;
  x = Math.min(Math.max(x, g.cell * 1.01), world.map.w - g.cell * 1.01);
  y = Math.min(Math.max(y, g.cell * 1.01), world.map.h - g.cell * 1.01);
  let i;
  if (A.nfree > 0) i = A.free[--A.nfree];
  else { ensureCap(world, A.n + 1); i = A.n++; }
  A.x[i] = x; A.y[i] = y; A.vx[i] = 0; A.vy[i] = 0; A.tx[i] = x; A.ty[i] = y;
  A.type[i] = type; A.sub[i] = sub; A.state[i] = 0; A.owner[i] = 0; A.aux[i] = 0;
  A.hp[i] = 1; A.timer[i] = 0; A.panic[i] = 0; A.cd[i] = 0; A.stun[i] = 0; A.shield[i] = 0;
  A.ammo[i] = -1; A.group[i] = -1; A.tgt[i] = -1;
  A.home[2 * i] = x; A.home[2 * i + 1] = y;
  if (type === ZOMBIE) { A.tx[i] = 0; if (sub === ZSUB.SHIELDED) A.shield[i] = world.cfg.mutation.kinds.shielded.shield; }
  if (type >= POLICE) { const s = armedStats(world, type, -1); A.hp[i] = s.hp; A.ammo[i] = s.ammo === undefined || s.ammo === Infinity ? -1 : s.ammo; A.state[i] = type === MILITIA ? 1 : 0; }
  A.count++;
  world.counts[type]++;
  return i;
}

export function removeAgent(world, i) {
  const A = world.A, t = A.type[i];
  if (!t) return;
  world.counts[t]--;
  A.type[i] = FREE;
  A.free[A.nfree++] = i;
  A.count--;
}

export function setType(world, i, t) {
  const A = world.A, o = A.type[i];
  if (o === t || !o) return;
  world.counts[o]--; world.counts[t]++;
  A.type[i] = t;
}

export function armedStats(world, type, group) {
  if (group >= 0 && world.groupStats[group]) return world.groupStats[group];
  const c = world.cfg;
  if (type === POLICE) return c.functions.police.officer;
  if (type === MILITIA) return c.functions.militia.fighter;
  return c.abilities.paratroopers.soldier;
}

// ---------------------------------------------------------------- spatial hash
export function rebuildHash(world) {
  const sh = world.sh, A = world.A;
  const { headH, headZ, headT, cntZ, cntC, cntP, touched, mark } = sh;
  for (let k = 0; k < sh.nt; k++) { const c = touched[k]; headH[c] = -1; headZ[c] = -1; headT[c] = -1; cntZ[c] = 0; cntC[c] = 0; cntP[c] = 0; }
  sh.nt = 0;
  sh.blkZ.fill(0); sh.blkH.fill(0); sh.blkP.fill(0);
  let gen = ++sh.gen;
  if (gen > 0xFFFFFFF0) { mark.fill(0); gen = sh.gen = 1; }
  const next = sh.next, type = A.type, X = A.x, Y = A.y, st = A.state;
  const inv = sh.inv, hw = sh.hw, hh = sh.hh;
  const blkZ = sh.blkZ, blkH = sh.blkH, blkP = sh.blkP, zCol = sh.zCol, zRow = sh.zRow, hCol = sh.hCol, hRow = sh.hRow;
  let nt = 0, panicked = 0;
  for (let i = 0, n = A.n; i < n; i++) {
    const t = type[i];
    if (!t) continue;
    let cx = (X[i] * inv) | 0, cy = (Y[i] * inv) | 0;
    if (cx < 0) cx = 0; else if (cx >= hw) cx = hw - 1;
    if (cy < 0) cy = 0; else if (cy >= hh) cy = hh - 1;
    const c = cy * hw + cx;
    if (mark[c] !== gen) { mark[c] = gen; touched[nt++] = c; }
    if (t === ZOMBIE) { next[i] = headZ[c]; headZ[c] = i; cntZ[c]++; blkZ[zRow[cy] + zCol[cx]]++; }
    else if (t === TURNING) { next[i] = headT[c]; headT[c] = i; }
    else {
      next[i] = headH[c]; headH[c] = i;
      blkH[hRow[cy] + hCol[cx]]++;
      if (t === CIV) { cntC[c]++; if (st[i] === 1) { cntP[c]++; blkP[zRow[cy] + zCol[cx]]++; panicked++; } }
    }
  }
  sh.nt = nt;
  sh.panicked = panicked;
}

function blockSum(arr, bw, bh, bs, x, y, r) {
  const ib = 1 / bs;
  const bx0 = Math.max(0, ((x - r) * ib) | 0), bx1 = Math.min(bw - 1, ((x + r) * ib) | 0);
  const by0 = Math.max(0, ((y - r) * ib) | 0), by1 = Math.min(bh - 1, ((y + r) * ib) | 0);
  let s = 0;
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) s += arr[by * bw + bx];
  return s;
}

function ringNearest(sh, head, A, x, y, r, mask) {
  const hc = sh.hcell, inv = sh.inv, hw = sh.hw, hh = sh.hh, next = sh.next, type = A.type, X = A.x, Y = A.y;
  const cx0 = (x * inv) | 0, cy0 = (y * inv) | 0;
  const K = Math.ceil(r * inv);
  let best = -1, bd = r * r;
  for (let k = 0; k <= K; k++) {
    if (best >= 0 && k > 1) { const md = (k - 1) * hc; if (md * md > bd) break; }
    const y0 = cy0 - k, y1 = cy0 + k, x0 = cx0 - k, x1 = cx0 + k;
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= hh) continue;
      const step = (cy === y0 || cy === y1) ? 1 : (x1 - x0) || 1;
      for (let cx = x0; cx <= x1; cx += step) {
        if (cx < 0 || cx >= hw) continue;
        for (let j = head[cy * hw + cx]; j >= 0; j = next[j]) {
          if (!(mask & (1 << type[j]))) continue;
          const dx = X[j] - x, dy = Y[j] - y, d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; best = j; }
        }
      }
    }
  }
  return best;
}

export function nearestAgent(world, x, y, r, mask) {
  const sh = world.sh, A = world.A;
  let best = -1, bd = Infinity;
  const tryList = (head) => {
    const j = ringNearest(sh, head, A, x, y, r, mask);
    if (j >= 0) { const dx = A.x[j] - x, dy = A.y[j] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = j; } }
  };
  if (mask & M_HUMAN) tryList(sh.headH);
  if (mask & M_ZOMBIE) tryList(sh.headZ);
  if (mask & M_TURNING) tryList(sh.headT);
  return best;
}

export function queryAgents(world, x, y, r, mask, fn) {
  const sh = world.sh, A = world.A, inv = sh.inv, hw = sh.hw, hh = sh.hh, next = sh.next;
  const type = A.type, X = A.x, Y = A.y, r2 = r * r;
  const x0 = Math.max(0, ((x - r) * inv) | 0), x1 = Math.min(hw - 1, ((x + r) * inv) | 0);
  const y0 = Math.max(0, ((y - r) * inv) | 0), y1 = Math.min(hh - 1, ((y + r) * inv) | 0);
  const lists = [];
  if (mask & M_HUMAN) lists.push(sh.headH);
  if (mask & M_ZOMBIE) lists.push(sh.headZ);
  if (mask & M_TURNING) lists.push(sh.headT);
  for (const head of lists) {
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      for (let j = head[cy * hw + cx]; j >= 0; j = next[j]) {
        if (!(mask & (1 << type[j]))) continue;
        const dx = X[j] - x, dy = Y[j] - y, d2 = dx * dx + dy * dy;
        if (d2 <= r2 && fn(j, d2) === false) return;
      }
    }
  }
}

// ---------------------------------------------------------------- life events
export function infectAgent(world, i) {
  const A = world.A, t = A.type[i];
  if (t !== CIV && t < POLICE) return false;
  setType(world, i, TURNING);
  const ts = world.cfg.zombie.turnSec;
  A.sub[i] = t;
  A.timer[i] = Array.isArray(ts) ? world.rng.range(ts[0], ts[1]) : +ts || 3;
  A.hp[i] = 1; A.vx[i] = 0; A.vy[i] = 0; A.state[i] = 0; A.tgt[i] = -1; A.group[i] = -1;
  world.stats.infected++;
  return true;
}

export function cureAgent(world, i) {
  const A = world.A, t = A.type[i];
  if (t !== ZOMBIE && t !== TURNING) return false;
  setType(world, i, CIV);
  A.sub[i] = 0; A.state[i] = CS.CALM; A.panic[i] = 0.6; A.hp[i] = 1; A.shield[i] = 0; A.stun[i] = 0; A.tgt[i] = -1; A.group[i] = -1; A.cd[i] = 0;
  A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; A.tx[i] = A.x[i]; A.ty[i] = A.y[i];
  world.stats.cured++;
  return true;
}

export function evacuateAgent(world, i) {
  if (world.A.type[i] !== CIV) return false;
  removeAgent(world, i);
  world.stats.civEvac++;
  return true;
}

export function zombieHp(world, sub = 0) {
  const z = world.cfg.zombie;
  const base = Math.min(z.hpMax, z.hpStart + Math.max(0, world.t - z.hpGraceSec) / 60 * z.hpPerMin) * (world.cfg.diff.zombieHpMul || 1);
  if (!sub) return base;
  const k = world.cfg.mutation.kinds[SUB_KEYS[sub]];
  return base * ((k && k.hpMul) || 1);
}

// Returns true when the agent died.
export function damageAgent(world, i, dmg, src = 'unknown') {
  const A = world.A, t = A.type[i];
  if (!t || !(dmg > 0)) return false;
  if (t === ZOMBIE) {
    if (A.shield[i] > 0) { const s = Math.min(A.shield[i], dmg); A.shield[i] -= s; dmg -= s; if (dmg <= 0) return false; }
    A.hp[i] -= dmg / zombieHp(world, A.sub[i]);
    if (A.hp[i] > 0) return false;
    const sub = A.sub[i], x = A.x[i], y = A.y[i];
    removeAgent(world, i);
    world.addKill(src);
    if (sub === ZSUB.EXPLOSIVE) explodeAt(world, x, y, 'explosive');
    return true;
  }
  if (t === TURNING) {
    A.hp[i] -= dmg;
    if (A.hp[i] > 0) return false;
    removeAgent(world, i);
    world.addKill(src);
    return true;
  }
  A.hp[i] -= dmg;
  if (A.hp[i] > 0) return false;
  if (src === 'zombie') return infectAgent(world, i);
  removeAgent(world, i);
  if (t === CIV) world.stats.civKilled++;
  else world.stats.armedLost++;
  return true;
}

export function releaseCivs(world, state) {
  const A = world.A;
  for (let i = 0; i < A.n; i++) {
    if (A.type[i] !== CIV || A.state[i] !== state) continue;
    A.state[i] = A.panic[i] >= world.cfg.civ.panicThreshold ? CS.PANIC : CS.CALM;
    A.group[i] = -1; A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; A.timer[i] = 0;
  }
}

// ---------------------------------------------------------------- movement
// Moves agent i by (mx,my) with grid collision against `bits`. Returns -1, or the blocking fine cell.
function moveAgent(W, i, mx, my, bits) {
  const X = W.X, Y = W.Y, x = X[i], y = Y[i], nx = x + mx, ny = y + my;
  const inv = W.inv, gw = W.gw, pass = W.pass;
  const ocx = (x * inv) | 0, ocy = (y * inv) | 0, ncx = (nx * inv) | 0, ncy = (ny * inv) | 0;
  if (ncx === ocx && ncy === ocy) { X[i] = nx; Y[i] = ny; return -1; }
  if (ncx <= 0 || ncy <= 0 || ncx >= gw - 1 || ncy >= W.gh - 1) return ocy * gw + ocx;
  const oc = ocy * gw + ocx;
  if (!(pass[oc] & bits)) { X[i] = nx; Y[i] = ny; return -1; }
  const nc = ncy * gw + ncx;
  if (ncx !== ocx && ncy !== ocy) {
    const cX = ocy * gw + ncx, cY = ncy * gw + ocx;
    const okX = (pass[cX] & bits) !== 0, okY = (pass[cY] & bits) !== 0;
    if ((pass[nc] & bits) && (okX || okY)) { X[i] = nx; Y[i] = ny; return -1; }
    if (okX) { X[i] = nx; return okY ? nc : cY; }
    if (okY) { Y[i] = ny; return cX; }
    return cX;
  }
  if (pass[nc] & bits) { X[i] = nx; Y[i] = ny; return -1; }
  if (ncx !== ocx) Y[i] = ny; else X[i] = nx;
  return nc;
}

function makeCtx(world, dt) {
  const A = world.A, g = world.grid, nav = world.nav, cfg = world.cfg;
  return {
    world, A, dt, rng: world.rng, tick: world.tick,
    X: A.x, Y: A.y, VX: A.vx, VY: A.vy, type: A.type, sub: A.sub, state: A.state, hp: A.hp, timer: A.timer, panic: A.panic,
    TX: A.tx, TY: A.ty, aux: A.aux, cd: A.cd, stun: A.stun, ammo: A.ammo, group: A.group, tgt: A.tgt, home: A.home,
    gw: g.gw, gh: g.gh, cs: g.cell, inv: 1 / g.cell, terrain: g.terrain,
    pass: nav.pass, R: nav.R, cgw: nav.cgw, ccs: nav.ccell, cinv: 1 / nav.ccell,
    civDir: nav.civ.dir, civDist: nav.civ.dist, sDir: nav.scent.dir, sDist: nav.scent.dist,
    swDir: nav.swim && nav.swim.ready ? nav.swim.dir : nav.scent.dir, swDist: nav.swim && nav.swim.ready ? nav.swim.dist : nav.scent.dist,
    zoneId: world.zoneId, comps: world.zones.comps, corrGrid: world.corrGrid, holdGrid: world.holdGrid, bcMask: world.bcMask,
    block: world.block, wallHp: world.wallHp, fire: world.fire,
    sh: world.sh,
    civ: cfg.civ, zc: cfg.zombie, armed: cfg.armed, fcfg: cfg.fire, mut: cfg.mutation,
    lureUnits: cfg.civ.gateLureRadius / g.cell * 10,
    thr: cfg.civ.panicThreshold,
    touch2: cfg.zombie.touchRadius * cfg.zombie.touchRadius,
    rt: Math.max(1, Math.round((cfg.zombie.retargetSec || 0.5) / dt)),
    giantMul: (cfg.mutation.kinds.giant && cfg.mutation.kinds.giant.wallDpsMul) || 1,
    pits: world.pits, anyFire: world._fireList.length > 0,
    safe: 0, panicked: 0, swimmers: 0, shots: 0,
  };
}

const spdVar = (i) => 0.88 + 0.24 * ((i * 0.6180339887) % 1);

function steerTo(W, i, tx, ty, spd) {
  const dx = tx - W.X[i], dy = ty - W.Y[i], d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-4) { W.VX[i] = 0; W.VY[i] = 0; return 0; }
  W.VX[i] = dx / d * spd; W.VY[i] = dy / d * spd;
  return d;
}

function steerField(W, i, dir, c, spd) {
  const d = dir[c];
  if (d >= 8) return false;
  const gw = W.gw, cs = W.cs;
  const tx = ((c % gw) + DX[d] + 0.5) * cs, ty = (((c / gw) | 0) + DY[d] + 0.5) * cs;
  steerTo(W, i, tx, ty, spd);
  return true;
}

function separate(W, i, cnt, k) {
  const sh = W.sh, hw = sh.hw;
  const cx = (W.X[i] * sh.inv) | 0, cy = (W.Y[i] * sh.inv) | 0;
  if (cx <= 0 || cy <= 0 || cx >= hw - 1 || cy >= sh.hh - 1) return;
  const c = cy * hw + cx;
  if (cnt[c] < 4) return;
  const gx = cnt[c + 1] - cnt[c - 1], gy = cnt[c + hw] - cnt[c - hw];
  const m = Math.abs(gx) + Math.abs(gy);
  if (!m) return;
  const s = k * Math.min(1, m / 8) / m;
  W.VX[i] -= gx * s; W.VY[i] -= gy * s;
}

// ---------------------------------------------------------------- civilians
function civReplan(W, i, cell) {
  const world = W.world, A = W.A, rng = W.rng, civ = W.civ, X = W.X, Y = W.Y;
  const x = X[i], y = Y[i];
  const dtK = W.dt * K_CIV;
  let p = W.panic[i];
  const sh = W.sh;
  let seen = false;
  if (world.counts[ZOMBIE] > 0 && blockSum(sh.blkZ, sh.bzw, sh.bzh, sh.bz, x, y, civ.panicRadius) > 0) {
    const z = ringNearest(sh, sh.headZ, A, x, y, civ.panicRadius, M_ZOMBIE);
    if (z >= 0) { p = 1; W.tgt[i] = z; seen = true; }
  }
  if (!seen && p > 0) p = Math.max(0, p - civ.calmDecayPerSec * dtK);
  if (p < W.thr && sh.panicked > 0 && blockSum(sh.blkP, sh.bzw, sh.bzh, sh.bz, x, y, civ.panicSpreadRadius) > 0) {
    const r = civ.panicSpreadRadius, hw = sh.hw;
    const cx = (x * sh.inv) | 0, cy = (y * sh.inv) | 0, k = Math.ceil(r * sh.inv);
    let pc = 0;
    for (let yy = Math.max(0, cy - k); yy <= Math.min(sh.hh - 1, cy + k) && !pc; yy++)
      for (let xx = Math.max(0, cx - k); xx <= Math.min(hw - 1, cx + k); xx++) pc += sh.cntP[yy * hw + xx];
    if (pc > 0 && rng.next() < civ.panicSpreadChance * dtK) p = Math.min(1, p + 0.6);
  }
  W.panic[i] = p;
  let panicked = p >= W.thr;
  const walk = civ.walk * spdVar(i), run = civ.run * spdVar(i);
  let st = W.state[i];
  const zid = W.zoneId[cell];

  if (st === CS.SAFE) {
    if (zid && !W.comps[zid - 1].breached) {
      W.timer[i] -= dtK;
      if (W.timer[i] <= 0) {
        W.timer[i] = rng.range(3, 9);
        const ang = rng.next() * 6.2832, rr = rng.next() * SAFE_ROAM;
        W.TX[i] = x + Math.cos(ang) * rr; W.TY[i] = y + Math.sin(ang) * rr;
      }
      if (steerTo(W, i, W.TX[i], W.TY[i], walk * 0.6) < 0.6) { W.VX[i] = 0; W.VY[i] = 0; }
      separate(W, i, sh.cntC, civ.separation);
      return;
    }
    st = CS.PANIC; p = W.panic[i] = 1; panicked = true;
  } else if (st === CS.HELD) {
    const h = world.holds[W.group[i]];
    if (h) {
      const dx = x - h.x, dy = y - h.y;
      if (dx * dx + dy * dy > h.r * h.r * 0.7) { steerTo(W, i, h.x, h.y, panicked ? run : walk); return; }
      W.timer[i] -= dtK;
      if (W.timer[i] <= 0) {
        W.timer[i] = rng.range(2, 6);
        const ang = rng.next() * 6.2832, rr = Math.sqrt(rng.next()) * h.r * 0.75;
        W.TX[i] = h.x + Math.cos(ang) * rr; W.TY[i] = h.y + Math.sin(ang) * rr;
      }
      if (steerTo(W, i, W.TX[i], W.TY[i], walk * 0.5) < 0.6) { W.VX[i] = 0; W.VY[i] = 0; }
      separate(W, i, sh.cntC, civ.separation);
      return;
    }
    st = panicked ? CS.PANIC : CS.CALM; W.group[i] = -1;
  } else if (st === CS.CORRIDOR) {
    const k = W.group[i], co = world.corridors[k];
    if (co && corridorContains(co, x, y)) {
      const f = corridorField(world, k);
      const lx = ((x * W.inv) | 0) - f.ox, ly = ((y * W.inv) | 0) - f.oy;
      const d = (lx >= 0 && ly >= 0 && lx < f.lw && ly < f.lh) ? f.dir[ly * f.lw + lx] : 255;
      if (d !== 8) {
        const spd = panicked ? run : walk;
        if (d < 8) steerTo(W, i, (lx + f.ox + DX[d] + 0.5) * W.cs, (ly + f.oy + DY[d] + 0.5) * W.cs, spd);
        else { W.VX[i] = f.ux * spd; W.VY[i] = f.uy * spd; }
        return;
      }
    }
    st = panicked ? CS.PANIC : CS.CALM; W.group[i] = -1; W.cd[i] = 4;
    W.home[2 * i] = x; W.home[2 * i + 1] = y;
  } else if (st === CS.BOARDING) {
    if (!zid && W.civDir[cell] === 8) { W.VX[i] = 0; W.VY[i] = 0; return; }
    st = panicked ? CS.PANIC : CS.CALM;
  }

  if (zid && !W.comps[zid - 1].breached) {
    W.state[i] = CS.SAFE;
    const comp = W.comps[zid - 1], ic = comp.interiorCells;
    W.TX[i] = x; W.TY[i] = y;
    for (let tr = 0; tr < 6 && ic.length; tr++) {
      const c = ic[rng.int(0, ic.length - 1)];
      if (!(W.pass[c] & P_CIV)) continue;
      W.TX[i] = (c % W.gw + 0.5) * W.cs; W.TY[i] = (((c / W.gw) | 0) + 0.5) * W.cs;
      break;
    }
    W.timer[i] = rng.range(6, 14);
    steerTo(W, i, W.TX[i], W.TY[i], walk * 0.8);
    return;
  }
  if (W.cd[i] <= 0 && W.corrGrid[cell]) { W.state[i] = CS.CORRIDOR; W.group[i] = W.corrGrid[cell] - 1; return; }
  if (W.holdGrid[cell]) { W.state[i] = CS.HELD; W.group[i] = W.holdGrid[cell] - 1; W.timer[i] = 0; return; }

  const d = W.civDir[cell];
  if (panicked) {
    W.state[i] = CS.PANIC;
    if (d < 8) { steerField(W, i, W.civDir, cell, run); separate(W, i, sh.cntC, civ.separation * 0.5); return; }
    if (d === 8) { W.state[i] = CS.BOARDING; W.VX[i] = 0; W.VY[i] = 0; return; }
    const z = W.tgt[i];
    if (z >= 0 && W.type[z] === ZOMBIE) {
      const dx = x - X[z], dy = y - Y[z], dd = Math.sqrt(dx * dx + dy * dy) || 1;
      W.VX[i] = dx / dd * run; W.VY[i] = dy / dd * run;
    } else if (W.VX[i] === 0 && W.VY[i] === 0) {
      const ang = rng.next() * 6.2832; W.VX[i] = Math.cos(ang) * run; W.VY[i] = Math.sin(ang) * run;
    }
    return;
  }
  if (st === CS.PANIC) { W.home[2 * i] = x; W.home[2 * i + 1] = y; W.timer[i] = 0; }
  W.state[i] = CS.CALM;
  if (d === 8) { W.state[i] = CS.BOARDING; W.VX[i] = 0; W.VY[i] = 0; return; }
  if (d < 8 && (W.civDist[cell] <= W.lureUnits || (W.bcMask && W.bcMask[((y * W.cinv) | 0) * W.cgw + ((x * W.cinv) | 0)]))) {
    steerField(W, i, W.civDir, cell, walk);
    separate(W, i, sh.cntC, civ.separation * 0.5);
    return;
  }
  W.timer[i] -= dtK;
  if (W.timer[i] <= 0) {
    W.timer[i] = rng.range(2, 7);
    const spread = world.cfg.population.packSpread;
    W.TX[i] = W.home[2 * i] + rng.range(-spread, spread) * 0.5;
    W.TY[i] = W.home[2 * i + 1] + rng.range(-spread, spread) * 0.5;
  }
  if (steerTo(W, i, W.TX[i], W.TY[i], walk * 0.5 * (civ.wander || 1)) < 0.6) { W.VX[i] = 0; W.VY[i] = 0; }
}

function updateCiv(W, i) {
  const dt = W.dt, X = W.X, Y = W.Y;
  const cell = ((Y[i] * W.inv) | 0) * W.gw + ((X[i] * W.inv) | 0);
  const fc = ((Y[i] * W.cinv) | 0) * W.cgw + ((X[i] * W.cinv) | 0);
  if (W.anyFire && W.fire[fc] > 0 && damageAgent(W.world, i, W.fcfg.dps * W.fire[fc] * dt, fireKey(W.world, fc))) return;
  if (W.cd[i] > 0) W.cd[i] -= dt;
  if ((i + W.tick) % K_CIV === 0) civReplan(W, i, cell);
  const st = W.state[i];
  if (st === CS.SAFE) W.safe++;
  else if (st === CS.PANIC) W.panicked++;
  const vx = W.VX[i], vy = W.VY[i];
  if (vx === 0 && vy === 0) return;
  if (st === CS.SAFE) {
    const nx = X[i] + vx * dt, ny = Y[i] + vy * dt;
    const nc = ((ny * W.inv) | 0) * W.gw + ((nx * W.inv) | 0);
    if (W.zoneId[nc] !== W.zoneId[cell]) { W.VX[i] = 0; W.VY[i] = 0; W.timer[i] = 0; return; }
  }
  if (moveAgent(W, i, vx * dt, vy * dt, P_CIV) >= 0 && st !== CS.PANIC) W.timer[i] = 0;
}

// ---------------------------------------------------------------- zombies
// Local search used when an agent is blocked by buildings or water: BFS over the fine cells around it
// (corner-safe 8-connectivity) toward the cell with the lowest goal value. Returns the first step, or -1.
const DQ = new Int32Array(512), DPREV = new Int32Array(512), DSTEP = new Int16Array(512), DSEEN = new Uint32Array(512);
let dGen = 1;
function findDetour(W, i, bits, dist, gx, gy) {
  const gw = W.gw, gh = W.gh, pass = W.pass, cs = W.cs;
  const fx = (W.X[i] * W.inv) | 0, fy = (W.Y[i] * W.inv) | 0;
  const half = 5;
  const x0 = Math.max(1, fx - half), y0 = Math.max(1, fy - half), x1 = Math.min(gw - 2, fx + half), y1 = Math.min(gh - 2, fy + half);
  const lw = x1 - x0 + 1;
  if (++dGen > 0xFFFFFFF0) { DSEEN.fill(0); dGen = 1; }
  const gen = dGen, stop = P_WALL | P_GATE;
  const value = (X, Y) => {
    if (dist) return dist[Y * gw + X];
    const ex = (X + 0.5) * cs - gx, ey = (Y + 0.5) * cs - gy;
    return ex * ex + ey * ey;
  };
  const s0 = (fy - y0) * lw + (fx - x0);
  let head = 0, tail = 0, best = s0, bestV = value(fx, fy), bestS = 0;
  DQ[tail++] = s0; DSEEN[s0] = gen; DPREV[s0] = -1; DSTEP[s0] = 0;
  while (head < tail) {
    const l = DQ[head++], lx = l % lw, ly = (l / lw) | 0, X = lx + x0, Y = ly + y0;
    if (l !== s0 && !(pass[Y * gw + X] & bits)) continue;
    for (let d = 0; d < 8; d++) {
      const nx = X + DX[d], ny = Y + DY[d];
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const nl = (ny - y0) * lw + (nx - x0);
      if (DSEEN[nl] === gen) continue;
      if (!(pass[ny * gw + nx] & (bits | stop))) continue;
      if ((d & 1) && (!(pass[Y * gw + nx] & bits) || !(pass[ny * gw + X] & bits))) continue;
      DSEEN[nl] = gen; DPREV[nl] = l; DSTEP[nl] = DSTEP[l] + 1; DQ[tail++] = nl;
      const v = value(nx, ny);
      if (v < bestV || (v === bestV && best !== s0 && DSTEP[nl] < bestS)) { bestV = v; best = nl; bestS = DSTEP[nl]; }
    }
  }
  if (best === s0) return -1;
  let l = best;
  while (DPREV[l] !== s0 && DPREV[l] >= 0) l = DPREV[l];
  return (((l / lw) | 0) + y0) * gw + (l % lw) + x0;
}

function updateZombie(W, i) {
  const world = W.world, dt = W.dt, X = W.X, Y = W.Y, zc = W.zc;
  const x = X[i], y = Y[i];
  if (W.anyFire) {
    const fc = ((y * W.cinv) | 0) * W.cgw + ((x * W.cinv) | 0);
    if (W.fire[fc] > 0 && damageAgent(world, i, W.fcfg.dps * W.fire[fc] * dt, fireKey(world, fc))) return;
  }
  const sub = W.sub[i];
  const swimmer = sub === ZSUB.SWIMMER;
  if (swimmer) W.swimmers++;
  if (W.stun[i] > 0) { W.stun[i] -= dt; return; }
  if (W.cd[i] > 0) W.cd[i] -= dt;
  if (W.timer[i] > 0) W.timer[i] -= dt;
  const sh = W.sh;
  if ((i + W.tick) % W.rt === 0) {
    W.tgt[i] = world.counts[CIV] + world.counts[POLICE] + world.counts[MILITIA] + world.counts[SOLDIER] > 0 &&
      blockSum(sh.blkH, sh.bhw, sh.bhh, sh.bh, x, y, zc.sight) > 0 ? ringNearest(sh, sh.headH, W.A, x, y, zc.sight, M_HUMAN) : -1;
  }
  let tg = W.tgt[i];
  if (tg >= 0 && !(M_HUMAN & (1 << W.type[tg]))) { tg = -1; W.tgt[i] = -1; }
  const cell = ((y * W.inv) | 0) * W.gw + ((x * W.inv) | 0);
  let spd = zc.speed * spdVar(i);
  if (swimmer && W.terrain[cell] === T.WATER) spd *= zc.swimSpeedMul;
  let vx = 0, vy = 0, chasing = false, gx = 0, gy = 0, mode = 0;
  if (tg >= 0) {
    const dx = X[tg] - x, dy = Y[tg] - y, d2 = dx * dx + dy * dy;
    gx = X[tg]; gy = Y[tg];
    if (d2 <= W.touch2) {
      if (W.cd[i] <= 0) {
        W.cd[i] = zc.attackSec || 1;
        if (W.type[tg] === CIV) infectAgent(world, tg);
        else damageAgent(world, tg, zc.armedDmg || 1, 'zombie');
      }
      W.VX[i] = 0; W.VY[i] = 0;
      zombieBreach(W, x, y);
      return;
    }
    if (W.timer[i] <= 0) { const d = Math.sqrt(d2); vx = dx / d * spd; vy = dy / d * spd; chasing = true; mode = 1; }
  }
  const bits = swimmer ? P_SWIM : P_ZOM;
  if (W.state[i] > 0) {
    W.state[i]--;
    let dx = W.home[2 * i] - x, dy = W.home[2 * i + 1] - y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.6) {
      let wp = -1;
      if (W.aux[i] > 0) { W.aux[i]--; wp = mode === 1 ? findDetour(W, i, bits, null, gx, gy) : findDetour(W, i, bits, swimmer ? W.swDist : W.sDist, 0, 0); }
      if (wp < 0) W.state[i] = 0;
      else {
        W.home[2 * i] = (wp % W.gw + 0.5) * W.cs; W.home[2 * i + 1] = (((wp / W.gw) | 0) + 0.5) * W.cs;
        dx = W.home[2 * i] - x; dy = W.home[2 * i + 1] - y; d = Math.sqrt(dx * dx + dy * dy) || 1;
        W.state[i] = 60;
      }
    }
    if (W.state[i] > 0) { vx = dx / d * spd; vy = dy / d * spd; chasing = true; if (!mode) mode = 2; }
  }
  if (!chasing) {
    let pitted = false;
    if (tg < 0 && W.pits.length) {
      for (const p of W.pits) {
        const dx = p.x - x, dy = p.y - y, d2 = dx * dx + dy * dy;
        if (d2 < W.mut.pitAttract * W.mut.pitAttract) {
          if (d2 > p.r * p.r * 0.16) { const d = Math.sqrt(d2); vx = dx / d * spd; vy = dy / d * spd; }
          pitted = true; mode = 1; gx = p.x; gy = p.y; break;
        }
      }
    }
    if (!pitted) {
      const dir = swimmer ? W.swDir : W.sDir;
      const d = dir[cell];
      if (d < 8) {
        const tx = (cell % W.gw + DX[d] + 0.5) * W.cs, ty = (((cell / W.gw) | 0) + DY[d] + 0.5) * W.cs;
        const dx = tx - x, dy = ty - y, dd = Math.sqrt(dx * dx + dy * dy) || 1;
        vx = dx / dd * spd; vy = dy / dd * spd;
        mode = 2;
      } else {
        W.TX[i] -= dt;
        if (W.TX[i] <= 0) { W.TX[i] = W.rng.range(2, 5); W.TY[i] = W.rng.next() * 6.2832; }
        vx = Math.cos(W.TY[i]) * spd * 0.4; vy = Math.sin(W.TY[i]) * spd * 0.4;
      }
    }
  }
  W.VX[i] = vx; W.VY[i] = vy;
  separate(W, i, sh.cntZ, zc.separation);
  vx = W.VX[i]; vy = W.VY[i];
  if (vx === 0 && vy === 0) { zombieBreach(W, x, y); return; }
  const ox = X[i], oy = Y[i];
  const b = moveAgent(W, i, vx * dt, vy * dt, bits);
  if (b >= 0) {
    if (W.block[b] && W.wallHp[b] > 0 && (W.pass[b] & (P_WALL | P_GATE))) {
      if (sub === ZSUB.EXPLOSIVE) { const ex = X[i], ey = Y[i]; removeAgent(world, i); explodeAt(world, ex, ey, 'explosive'); return; }
      damageWallCell(world, b, zc.wallDps * dt * (sub === ZSUB.GIANT ? W.giantMul : 1), 'zombie');
      W.state[i] = 0;
    } else if (mode && ((X[i] - ox) * (X[i] - ox) + (Y[i] - oy) * (Y[i] - oy)) < 0.09 * (vx * vx + vy * vy) * dt * dt) {
      const wp = mode === 1 ? findDetour(W, i, bits, null, gx, gy) : findDetour(W, i, bits, swimmer ? W.swDist : W.sDist, 0, 0);
      if (wp >= 0) { W.home[2 * i] = (wp % W.gw + 0.5) * W.cs; W.home[2 * i + 1] = (((wp / W.gw) | 0) + 0.5) * W.cs; W.state[i] = 60; W.aux[i] = 8; }
      else if (mode === 1 && tg >= 0) { W.timer[i] = 1.5; W.state[i] = 0; }
      else W.state[i] = 0;
    } else W.TX[i] = 0;
  }
  zombieBreach(W, X[i], Y[i]);
}

function zombieBreach(W, x, y) {
  const z = W.zoneId[((y * W.inv) | 0) * W.gw + ((x * W.inv) | 0)];
  if (z && !W.comps[z - 1].breached) breachZone(W.world, z - 1);
}

function updateTurning(W, i) {
  const world = W.world, dt = W.dt;
  if (W.anyFire) {
    const fc = ((W.Y[i] * W.cinv) | 0) * W.cgw + ((W.X[i] * W.cinv) | 0);
    if (W.fire[fc] > 0 && damageAgent(world, i, W.fcfg.dps * W.fire[fc] * dt, fireKey(world, fc))) return;
  }
  W.timer[i] -= dt;
  if (W.timer[i] <= 0) {
    setType(world, i, ZOMBIE);
    W.sub[i] = 0; W.hp[i] = 1; W.tgt[i] = -1; W.cd[i] = 0.5; W.stun[i] = 0; W.TX[i] = 0; W.state[i] = 0; W.timer[i] = 0;
    world.A.shield[i] = 0;
    return;
  }
  if (((i + W.tick) & 7) === 0) {
    const ang = W.rng.next() * 6.2832;
    moveAgent(W, i, Math.cos(ang) * 0.12, Math.sin(ang) * 0.12, P_CIV | P_ZOM);
  }
}

// ---------------------------------------------------------------- armed humans
function updateArmed(W, i, t) {
  const world = W.world, dt = W.dt, X = W.X, Y = W.Y, ac = W.armed;
  const x = X[i], y = Y[i];
  if (W.anyFire) {
    const fc = ((y * W.cinv) | 0) * W.cgw + ((x * W.cinv) | 0);
    if (W.fire[fc] > 0 && damageAgent(world, i, W.fcfg.dps * W.fire[fc] * dt, fireKey(world, fc))) return;
  }
  if (W.stun[i] > 0) { W.stun[i] -= dt; return; }
  if (W.cd[i] > 0) W.cd[i] -= dt;
  const grp = W.group[i];
  const s = armedStats(world, t, grp);
  const pursue = W.state[i] === 1;
  const sh = W.sh;
  if ((i + W.tick) % K_ARMED === 0) {
    const sr = pursue ? Math.max(s.range, ac.sight) : s.range;
    W.tgt[i] = world.counts[ZOMBIE] > 0 && blockSum(sh.blkZ, sh.bzw, sh.bzh, sh.bz, x, y, sr) > 0 ? ringNearest(sh, sh.headZ, W.A, x, y, sr, M_ZOMBIE) : -1;
    const z = W.tgt[i], hx = W.home[2 * i], hy = W.home[2 * i + 1];
    const spd = (ac.speed || 3) * spdVar(i);
    if (W.ammo[i] === 0) {
      const cell = ((y * W.inv) | 0) * W.gw + ((x * W.inv) | 0);
      if (!steerField(W, i, W.civDir, cell, spd)) {
        if (z >= 0) { const dx = x - X[z], dy = y - Y[z], d = Math.sqrt(dx * dx + dy * dy) || 1; W.VX[i] = dx / d * spd; W.VY[i] = dy / d * spd; }
        else { W.VX[i] = 0; W.VY[i] = 0; }
      }
    } else if (W.timer[i] > 0) {
      if (steerTo(W, i, W.TX[i], W.TY[i], spd) < 0.6) W.timer[i] = 0;
    } else if (pursue && z >= 0) {
      const dx = X[z] - x, dy = Y[z] - y, d = Math.sqrt(dx * dx + dy * dy);
      const lx = X[z] - hx, ly = Y[z] - hy;
      if (d > s.range * 0.8 && lx * lx + ly * ly < ac.pursueLeash * ac.pursueLeash) { W.VX[i] = dx / d * spd; W.VY[i] = dy / d * spd; }
      else { W.VX[i] = 0; W.VY[i] = 0; }
    } else {
      const dx = hx - x, dy = hy - y;
      if (dx * dx + dy * dy > 16) steerTo(W, i, hx, hy, spd); else { W.VX[i] = 0; W.VY[i] = 0; }
    }
  }
  if (W.timer[i] > 0) W.timer[i] -= dt;
  const z = W.tgt[i];
  if (z >= 0 && W.type[z] === ZOMBIE && W.cd[i] <= 0 && W.ammo[i] !== 0) {
    const dx = X[z] - x, dy = Y[z] - y;
    if (dx * dx + dy * dy <= s.range * s.range) {
      W.cd[i] = s.rof;
      if (W.ammo[i] > 0) W.ammo[i]--;
      const key = s.key || TYPE_KEYS[t];
      if (W.rng.next() < (s.accuracy || ac.accuracy || 0.8)) damageAgent(world, z, s.dmg, key);
      world.projectiles.push({ kind: 'tracer', x0: x, y0: y, x1: X[z], y1: Y[z], t0: world.t, dur: 0.06 });
      W.shots++;
    }
  }
  if (W.VX[i] === 0 && W.VY[i] === 0) return;
  const ox = X[i], oy = Y[i], mx = W.VX[i] * dt, my = W.VY[i] * dt;
  if (moveAgent(W, i, mx, my, P_CIV) >= 0 && W.ammo[i] !== 0 && W.timer[i] <= 0 &&
      (X[i] - ox) * (X[i] - ox) + (Y[i] - oy) * (Y[i] - oy) < 0.09 * (mx * mx + my * my)) {
    const gz = W.tgt[i], pz = pursue && gz >= 0 && W.type[gz] === ZOMBIE;
    const wp = findDetour(W, i, P_CIV, null, pz ? X[gz] : W.home[2 * i], pz ? Y[gz] : W.home[2 * i + 1]);
    if (wp >= 0) { W.TX[i] = (wp % W.gw + 0.5) * W.cs; W.TY[i] = (((wp / W.gw) | 0) + 0.5) * W.cs; W.timer[i] = 2; }
  }
}

export function agentSystem(world, dt) {
  const W = makeCtx(world, dt);
  const type = W.type, n = world.A.n;
  for (let i = 0; i < n; i++) {
    const t = type[i];
    if (t === CIV) updateCiv(W, i);
    else if (t === ZOMBIE) updateZombie(W, i);
    else if (t === TURNING) updateTurning(W, i);
    else if (t >= POLICE) updateArmed(W, i, t);
  }
  world.stats.civSafe = W.safe;
  world.stats.panicked = W.panicked;
  world.nav.swimmers = W.swimmers;
  if (W.shots && world.tick - (world._lastShotSound || 0) >= 2) {
    world._lastShotSound = world.tick;
    world.events.emit('sound', { name: 'shot', x: 0, y: 0, vol: Math.min(1, W.shots / 6) });
  }
}

// Moves agents that stand on cells they cannot use (after walls were drawn over them) to the nearest usable cell.
export function unstickAgents(world) {
  const A = world.A, g = world.grid, pass = world.nav.pass;
  for (let i = 0; i < A.n; i++) {
    const t = A.type[i];
    if (!t) continue;
    const bits = t === ZOMBIE ? (A.sub[i] === ZSUB.SWIMMER ? P_SWIM : P_ZOM) : P_CIV;
    const c = Math.floor(A.y[i] / g.cell) * g.gw + Math.floor(A.x[i] / g.cell);
    if (pass[c] & bits) continue;
    const m = nearestPassable(world, A.x[i], A.y[i], bits, 10);
    if (m < 0) continue;
    A.x[i] = (m % g.gw + 0.5) * g.cell; A.y[i] = (((m / g.gw) | 0) + 0.5) * g.cell;
    A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; A.tx[i] = A.x[i]; A.ty[i] = A.y[i];
  }
}
