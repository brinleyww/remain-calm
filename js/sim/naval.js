// Naval units: boats that sail one connected body of water inside the stage (under bridges), each a vehicle in
// world.vehicles tied to its unit record. A "water body" here is a 4-connected set of water + bridge cells inside the
// stage boundary; it never changes during a stage (rubble stops at the shore, a fallen bridge becomes water).
import { T } from '../map/format.js';
import { ZOMBIE, ZSUB, M_ZOMBIE } from './agents.js';
import { isWalkTerrain, lineClear } from './nav.js';
import { unitStats, pickArty, queueShell, nearestZombie, zombiesNear, sound, log } from './combat.js';
import { addVehicle, findPath, gunTarget, gunHit, shellAim, cannon, loadCivs } from './vehicles.js';

const TAU = Math.PI * 2;
const BOAT_ID = 1e7;   // vehicle id = BOAT_ID + unit id, so a boat keeps its id through undo and retry
const BOAT_GAP = 12;   // placement spacing between boats (m); 30 m to a battleship
const SHIP_GAP = 30;
const ORDERS = new Set(['move', 'hunt', 'hold', 'return']);
const fail = (reason, comp = 0) => ({ ok: false, reason, cost: 0, comp });

export const isBoat = (def) => !!(def && def.boat);

// ---------------------------------------------------------------- water bodies of the current stage
// Built lazily (the client may ask first), so everything cached here reads the stage-start terrain, never live cells.
export function navalGrid(world) {
  const C = world.combat, mask = world.region.mask;
  if (C.naval && C.naval.mask === mask) return C.naval;
  const g = world.grid, gw = g.gw, gh = g.gh, n = gw * gh, terr = world.terrain0 || g.terrain, cs = g.cell;
  const wet = new Uint8Array(n), comp = new Int32Array(n);
  let nw = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let c = y * gw + 1, e = y * gw + gw - 1; c < e; c++) {
      const t = terr[c];
      if (mask[c] && (t === T.WATER || t === T.BRIDGE)) { wet[c] = 1; nw++; }
    }
  }
  const cells = new Int32Array(nw), start = [0], end = [0], area = [0], body = [0], bodyArea = [0], bbox = [null];
  let h = 0, t = 0, maxArea = 0, maxBody = 0;
  for (let s = 0; s < n && t < nw; s++) {
    if (!wet[s] || comp[s]) continue;
    const id = start.length;
    start.push(t);
    comp[s] = id; cells[t++] = s;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (h < t) {
      const c = cells[h++], X = c % gw, Y = (c / gw) | 0;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (wet[c - 1] && !comp[c - 1]) { comp[c - 1] = id; cells[t++] = c - 1; }
      if (wet[c + 1] && !comp[c + 1]) { comp[c + 1] = id; cells[t++] = c + 1; }
      if (wet[c - gw] && !comp[c - gw]) { comp[c - gw] = id; cells[t++] = c - gw; }
      if (wet[c + gw] && !comp[c + gw]) { comp[c + gw] = id; cells[t++] = c + gw; }
    }
    end.push(t);
    const a = (t - start[id]) * cs * cs, b = g.waterBodies.id[s], ba = g.waterBodies.area[b] || 0;
    area.push(a); body.push(b); bodyArea.push(ba); bbox.push([x0, y0, x1, y1]);
    if (a > maxArea) maxArea = a;
    if (ba > maxBody) maxBody = ba;
  }
  C.naval = { mask, gw, gh, cs, wet, comp, cells, start, end, area, body, bodyArea, bbox, maxArea, maxBody, count: start.length - 1,
    shore: [], exits: [], edgeBodies: null };
  return C.naval;
}

export const cellX = (N, c) => (c % N.gw + 0.5) * N.cs;
export const cellY = (N, c) => (((c / N.gw) | 0) + 0.5) * N.cs;

// Water cells of body k beside open land: { all: [water, land, ...], pick: the same thinned to one per 12 m }.
function shoreOf(world, N, k) {
  if (N.shore[k]) return N.shore[k];
  const gw = N.gw, gh = N.gh, terr = world.terrain0 || world.grid.terrain, mask = N.mask, wet = N.wet;
  const all = [], pick = [], seen = new Set();
  const land = (c) => {
    const X = c % gw, Y = (c / gw) | 0;
    return X > 0 && Y > 0 && X < gw - 1 && Y < gh - 1 && !wet[c] && mask[c] && isWalkTerrain(terr[c]);
  };
  for (let j = N.start[k]; j < N.end[k]; j++) {
    const c = N.cells[j];
    const l = land(c + gw) ? c + gw : land(c - gw) ? c - gw : land(c + 1) ? c + 1 : land(c - 1) ? c - 1 : -1;
    if (l < 0) continue;
    all.push(c, l);
    const key = ((((c / gw) | 0) / 3) | 0) * 65536 + (((c % gw) / 3) | 0);
    if (!seen.has(key)) { seen.add(key); pick.push(c, l); }
  }
  return (N.shore[k] = { all: Int32Array.from(all), pick: Int32Array.from(pick) });
}

// Water cells of body k where the water carries on past the stage boundary, when that water reaches the map edge.
function exitsOf(world, N, k) {
  if (N.exits[k]) return N.exits[k];
  const g = world.grid, gw = g.gw, gh = g.gh, terr = world.terrain0 || g.terrain, wb = g.waterBodies.id;
  if (!N.edgeBodies) {
    const set = new Set();
    for (let x = 0; x < gw; x++) { if (wb[x]) set.add(wb[x]); if (wb[(gh - 1) * gw + x]) set.add(wb[(gh - 1) * gw + x]); }
    for (let y = 0; y < gh; y++) { if (wb[y * gw]) set.add(wb[y * gw]); if (wb[y * gw + gw - 1]) set.add(wb[y * gw + gw - 1]); }
    N.edgeBodies = set;
  }
  const out = [];
  if (N.edgeBodies.has(N.body[k])) {
    const open = (c) => !N.wet[c] && (terr[c] === T.WATER || terr[c] === T.BRIDGE);
    for (let j = N.start[k]; j < N.end[k]; j++) {
      const c = N.cells[j];
      if (open(c - 1) || open(c + 1) || open(c - gw) || open(c + gw)) out.push(c);
    }
  }
  return (N.exits[k] = Int32Array.from(out));
}

// Nearest cell of body k to (x, y) within maxR cells (ring search), or -1.
export function snapCell(N, k, x, y, maxR) {
  const cs = N.cs, gw = N.gw, gh = N.gh, comp = N.comp;
  const cx0 = Math.floor(x / cs), cy0 = Math.floor(y / cs);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR; r++) {
    if (best >= 0 && (r - 1) * cs > Math.sqrt(bd)) break;
    for (let dy = -r; dy <= r; dy++) {
      const cy = cy0 + dy;
      if (cy < 1 || cy >= gh - 1) continue;
      const step = dy === -r || dy === r ? 1 : 2 * r;
      for (let dx = -r; dx <= r; dx += step) {
        const cx = cx0 + dx;
        if (cx < 1 || cx >= gw - 1) continue;
        const c = cy * gw + cx;
        if (comp[c] !== k) continue;
        const ex = (cx + 0.5) * cs - x, ey = (cy + 0.5) * cs - y, d = ex * ex + ey * ey;
        if (d < bd) { bd = d; best = c; }
      }
    }
  }
  return best;
}

// Nearest cell of body k anywhere (orders to far or unreachable spots).
function nearestCell(N, k, x, y) {
  let c = snapCell(N, k, x, y, 16);
  if (c >= 0) return c;
  let bd = Infinity;
  for (let j = N.start[k]; j < N.end[k]; j++) {
    const q = N.cells[j], dx = cellX(N, q) - x, dy = cellY(N, q) - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; c = q; }
  }
  return c;
}

// ---------------------------------------------------------------- placement
export function canPlaceBoat(world, type, x, y, c) {
  const def = world.cfg.units[type], g = world.grid, N = navalGrid(world);
  const need = def.minWaterM2 || 0;
  if (!N.count || N.maxArea < need) return fail('No water big enough here');
  const k = N.comp[c];
  if (!k || g.terrain[c] !== T.WATER) return fail('Place it on open water', k);
  if (N.area[k] < need) return fail(`Needs open water of at least ${Math.round(need).toLocaleString('en-US')} m²`, k);
  const px = cellX(N, c), py = cellY(N, c);
  for (const u of world.units) {
    if (!u.alive) continue;
    const ud = world.cfg.units[u.type];
    if (!ud || ud.mount !== 'water') continue;
    const gap = ud.boat ? BOAT_GAP : SHIP_GAP, dx = u.x - px, dy = u.y - py;
    if (dx * dx + dy * dy < gap * gap) return fail(ud.boat ? 'Too close to another boat' : 'Too close to a ship', k);
  }
  return { ok: true, reason: '', b: -1, bridge: -1, x: px, y: py, cell: c, comp: k };
}

// Why a water unit cannot be used anywhere on this stage ('' when it can).
export function unitBlocked(world, type) {
  const def = world.cfg.units[type];
  if (!def || !world.combat || !world.region) return '';
  if (def.mount !== 'water' && !def.water) return '';
  const N = navalGrid(world);
  if (def.water) return N.count ? '' : 'No open water here';
  if (def.boat) return N.maxArea >= (def.minWaterM2 || 0) ? '' : 'No water big enough here';
  return N.maxBody >= (def.minWaterM2 || 0) ? '' : 'No water big enough here';
}

// ---------------------------------------------------------------- boat vehicles <-> unit records
// Called on every board change (placement, refund, upgrade, undo, retry, stage start): one vehicle per live boat unit.
export function syncBoats(world) {
  const C = world.combat;
  if (!C) return;
  const want = new Map();
  for (const u of world.units) if (u.alive && isBoat(world.cfg.units[u.type])) want.set(u.id, u);
  const list = world.vehicles;
  let w = 0, any = false;
  for (let k = 0; k < list.length; k++) {
    const v = list[k];
    if (v.boat) {
      any = true;
      const u = v.alive ? want.get(v.uid) : null;
      if (!u) { v.alive = false; if (v.pickup) { world.removePickup(v.pickup); v.pickup = null; } continue; }
      want.delete(v.uid);
      if (v.unit !== u) {
        if (u.hx === undefined) { u.hx = u.x; u.hy = u.y; }
        v.unit = u; u.veh = v;
        if (world.phase === 'planning') { v.x = u.hx; v.y = u.hy; }
      }
      refreshHull(world, v, u);
    }
    if (v.alive) list[w++] = v;
  }
  list.length = w;
  for (const u of want.values()) { spawnBoat(world, u); any = true; }
  if (C.navalLoad) {
    for (const v of list) {
      if (!v.boat) continue;
      const o = C.navalLoad.get(v.uid);
      v.order = o && ORDERS.has(o.kind) ? { kind: o.kind, x: o.x ?? undefined, y: o.y ?? undefined, t: +o.t || 0, done: false } : undefined;
      v.path = null;
    }
    C.navalLoad = null;
  }
  C.boats = any;
}

function refreshHull(world, v, u) {
  const s = unitStats(world, u, false), hull = s.hull || 1;
  if (hull !== v.hpMax) { v.hp = v.hpMax > 0 ? v.hp * hull / v.hpMax : hull; v.hpMax = hull; }
  v._s = null;
}

// Mooring heading: along the longest straight run of water through the anchor.
function mooring(N, x, y) {
  let best = 0, bl = -1;
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 8, ux = Math.cos(a), uy = Math.sin(a);
    let len = 0;
    for (const sgn of [1, -1]) {
      for (let d = 4; d <= 40; d += 4) {
        const c = Math.floor((y + uy * d * sgn) / N.cs) * N.gw + Math.floor((x + ux * d * sgn) / N.cs);
        if (c < 0 || c >= N.wet.length || !N.wet[c]) break;
        len += 4;
      }
    }
    if (len > bl) { bl = len; best = a; }
  }
  return best;
}

function spawnBoat(world, u) {
  const def = world.cfg.units[u.type], N = navalGrid(world);
  if (u.hx === undefined) { u.hx = u.x; u.hy = u.y; }
  u.x = u.hx; u.y = u.hy;
  const s = unitStats(world, u, false), size = def.size || [16, 5];
  const c = world.cellAt(u.x, u.y);
  const v = addVehicle(world, u.type, u.x, u.y, {
    id: BOAT_ID + u.id, boat: true, uid: u.id, unit: u, owner: u.owner | 0, commandable: true, selR: Math.max(8, size[0] * 0.5 + 2),
    label: (world.combat.names && world.combat.names[u.type]) || u.type,
    hpMax: s.hull || 1, hp: s.hull || 1, key: u.type, comp: c >= 0 ? N.comp[c] : 0, len: size[0], beam: size[1],
    heading: mooring(N, u.x, u.y), turn: 24 / size[0], spd: 0, state: def.capacity ? 'seek' : 'patrol', pState: 'wait', waitUntil: 0,
    readyAt: (world.cfg.zone.outsideStartDelay || 0) + (u.id % 8) * world.cfg.sim.dt,
    mgCd: 0, mgT: -1, shots: 0, ax: NaN, ay: NaN, fireT: -1, loaded: 0, saved: 0, acc: 0, lastLoad: 0, scanT: 0, destT: 0, dest: null,
    spot: null, tried: null, note: '', huntT: 0, hc: -1, order: undefined,
  });
  u.veh = v;
  return v;
}

// ---------------------------------------------------------------- orders snapshot (serializer)
function saveOrders(world) {
  const out = [];
  for (const v of world.vehicles) {
    const o = v.boat && v.alive ? v.order : null;
    if (!o || !ORDERS.has(o.kind)) continue;
    out.push([v.uid, { kind: o.kind, x: Number.isFinite(+o.x) ? +o.x : null, y: Number.isFinite(+o.y) ? +o.y : null, t: +o.t || 0 }]);
  }
  return out;
}

function loadOrders(world, data) {
  world.combat.navalLoad = new Map((Array.isArray(data) ? data : []).filter((e) => Array.isArray(e) && e[1]).map(([id, o]) => [id, o]));
}

export function installNaval(world) {
  const C = world.combat;
  C.naval = null; C.navalLoad = null; C.boats = false;
  world.registerSerializer('naval', { save: saveOrders, load: loadOrders });
  world.events.on('changed', () => syncBoats(world));
}

// ---------------------------------------------------------------- movement on water
// Follows an A* route over the boat's water, cutting corners wherever the straight line stays on water.
// Returns 'moving' | 'arrived' | 'stuck'.
function sail(world, v, N, tx, ty, spd, dt) {
  if (!v.path || Math.abs(tx - v.goalX) + Math.abs(ty - v.goalY) > 4) {
    if (!v.path || world.t >= v.replanAt) {
      v.path = findPath(world, v.x, v.y, tx, ty, 1, 80000, { pass: N.wet, margin: 80, maxWin: 640 });
      v.pi = 0; v.goalX = tx; v.goalY = ty; v.replanAt = world.t + 1;
      if (!v.path) return 'stuck';
    }
  }
  const path = v.path, gw = N.gw, cs = N.cs;
  for (let k = 0; k < 6 && v.pi + 1 < path.length; k++) {
    const c = path[v.pi + 1];
    if (!lineClear(N.wet, gw, cs, v.x, v.y, (c % gw + 0.5) * cs, (((c / gw) | 0) + 0.5) * cs, 1)) break;
    v.pi++;
  }
  if (v.pi >= path.length) {
    if (Math.hypot(tx - v.x, ty - v.y) < 4) return 'arrived';
    // a route cut short by the search window: plan again from here; an empty one means this is as close as it gets
    if (path.length > 0 || v.goalX !== tx || v.goalY !== ty) { v.path = null; return 'moving'; }
    return 'stuck';
  }
  const c0 = path[v.pi], hx = (c0 % gw + 0.5) * cs, hy = (((c0 / gw) | 0) + 0.5) * cs;
  let diff = Math.atan2(hy - v.y, hx - v.x) - v.heading;
  diff -= Math.round(diff / TAU) * TAU;
  const turn = v.turn * dt;
  v.heading += diff > turn ? turn : diff < -turn ? -turn : diff;
  let budget = spd * dt * (0.35 + 0.65 * Math.max(0, Math.cos(diff)));
  while (budget > 1e-6 && v.pi < path.length) {
    const c = path[v.pi], wx = (c % gw + 0.5) * cs, wy = (((c / gw) | 0) + 0.5) * cs;
    const dx = wx - v.x, dy = wy - v.y, d = Math.hypot(dx, dy);
    if (d <= budget) { v.x = wx; v.y = wy; budget -= d; v.pi++; } else { v.x += dx / d * budget; v.y += dy / d * budget; budget = 0; }
  }
  return 'moving';
}

function pointOf(N, c) { return c >= 0 ? [cellX(N, c), cellY(N, c)] : null; }

// Where a move order ends: the nearest water of the boat's own body to the ordered point.
function orderPoint(N, v, o) {
  if (v._oRef !== o || v._oc === undefined) {
    v._oRef = o;
    v._oc = Number.isFinite(+o.x) && Number.isFinite(+o.y) ? nearestCell(N, v.comp, +o.x, +o.y) : -1;
  }
  return pointOf(N, v._oc);
}

function pickWaypoint(world, v, u, def, s, N) {
  const R = def.patrolR || 100, ax = u.hx, ay = u.hy, rng = world.rng, A = world.A, range = s.range || 0;
  const z = range > 0 ? nearestZombie(world, ax, ay, R + Math.min(range, 200)) : -1;
  if (z >= 0) {
    const zx = A.x[z], zy = A.y[z], d = Math.hypot(zx - ax, zy - ay) || 1;
    const f = Math.min(R, Math.max(0, d - range * 0.6)) / d;
    const c = snapCell(N, v.comp, ax + (zx - ax) * f, ay + (zy - ay) * f, 10);
    if (c >= 0) return c;
  }
  for (let k = 0; k < 4; k++) {
    const a = rng.next() * TAU, r = R * Math.sqrt(rng.next());
    const c = snapCell(N, v.comp, ax + Math.cos(a) * r, ay + Math.sin(a) * r, 6);
    if (c >= 0) return c;
  }
  return snapCell(N, v.comp, ax, ay, 4);
}

function patrol(world, v, u, def, s, N, dt) {
  if (v.pState === 'go') {
    if (sail(world, v, N, v.wx, v.wy, s.speed * 0.7, dt) !== 'moving') { v.pState = 'wait'; v.waitUntil = world.t + world.rng.range(1, 3.5); }
    return;
  }
  if (world.t < v.waitUntil) return;
  const c = pickWaypoint(world, v, u, def, s, N);
  if (c < 0) { v.waitUntil = world.t + 2; return; }
  v.wx = cellX(N, c); v.wy = cellY(N, c); v.pState = 'go';
}

// Hunt: steam toward the nearest zombie until it is in reach from the water (or as close as this water gets).
function hunt(world, v, s, N, dt) {
  const A = world.A, range = s.range || s.mgRange || 80;
  if (world.t >= v.huntT) {
    v.huntT = world.t + 1;
    const z = nearestZombie(world, v.x, v.y, 900);
    v.hc = -1;
    if (z >= 0 && Math.hypot(A.x[z] - v.x, A.y[z] - v.y) > range * 0.85) {
      let c = snapCell(N, v.comp, A.x[z], A.y[z], Math.min(40, Math.ceil(range * 0.75 / N.cs)));
      if (c < 0) {
        const sh = shoreOf(world, N, v.comp).all;
        let bd = Infinity;
        for (let k = 0; k < sh.length; k += 2) {
          const q = sh[k], dx = cellX(N, q) - A.x[z], dy = cellY(N, q) - A.y[z], d = dx * dx + dy * dy;
          if (d < bd) { bd = d; c = q; }
        }
      }
      v.hc = c;
    }
  }
  if (v.hc >= 0) sail(world, v, N, cellX(N, v.hc), cellY(N, v.hc), s.speed, dt);
}

// Movement for an explicit order. Returns false when there is none to follow (autonomous behaviour).
function followOrder(world, v, u, s, N, mode, dt) {
  const o = v.order;
  if (mode === 'move') {
    const p = orderPoint(N, v, o);
    if (!p || sail(world, v, N, p[0], p[1], s.speed, dt) !== 'moving') { o.done = true; v.path = null; }
    return true;
  }
  if (mode === 'return') {
    if (sail(world, v, N, u.hx, u.hy, s.speed, dt) !== 'moving') { o.done = true; v.path = null; v.pState = 'wait'; v.waitUntil = world.t + 1; }
    return true;
  }
  if (mode === 'hold') { if (!o.done) { o.done = true; v.path = null; } return true; }
  if (mode === 'hunt') { hunt(world, v, s, N, dt); return true; }
  return false;
}

function modeOf(v) {
  const o = v.order;
  if (!o || !ORDERS.has(o.kind)) return 'auto';
  if (o.kind === 'move') return o.done ? 'hold' : 'move';
  if (o.kind === 'return') return o.done ? 'auto' : 'return';
  return o.kind;
}

// ---------------------------------------------------------------- weapons
function mg(world, v, dmg, rof, range, acc, dt) {
  v.mgCd -= dt;
  if (v.mgCd > 0) return;
  const t = gunTarget(world, v, 'mgT', range, dmg * acc);
  if (t < 0) { v.mgCd = 0.25; return; }
  const A = world.A;
  v.ax = A.x[t]; v.ay = A.y[t]; v.fireT = world.t;
  gunHit(world, v, t, dmg, acc, v.key);
  v.shots++; world.combat.shotN++;
  v.mgCd += rof;
  if (v.mgCd < 0) v.mgCd = 0;
}

function deckGun(world, v, s, dt) {
  v.cd -= dt;
  if (v.cd > 0) return;
  const splash = s.splash || 10, speed = s.shellSpeed || 260;
  const aim = shellAim(world, v, v.x, v.y, Math.max(s.minRange || 0, splash + 4), s.range, splash, s.dmg, speed);
  if (!aim) { v.cd = 0.4; return; }
  v.ax = aim[0]; v.ay = aim[1]; v.fireT = world.t;
  cannon(world, v, aim[0], aim[1], s.dmg, splash, speed, v.key);
  v.cd = s.rof; v.shots++;
  sound(world, 'thump', v.x, v.y, 0.6, 4);
}

const SALVO = { r: 8, dmg: 0, n: 1, spread: 0, speed: 220, kind: 0, minC: 1, ox: 0, oy: 0 };
function salvo(world, v, def, s, dt) {
  v.cd -= dt;
  if (v.cd > 0 || world.t < v.scanT) return;
  const n = Math.max(1, s.rockets | 0), W = SALVO, speed = s.shellSpeed || 220;
  W.r = s.splash || 10; W.dmg = s.dmg || 0; W.n = n; W.spread = s.spread || 40; W.speed = speed; W.minC = def.minCluster || 1; W.ox = v.x; W.oy = v.y;
  const pick = pickArty(world, v.x, v.y, s.minRange || 0, s.range, W);
  if (!pick) { v.scanT = world.t + 0.5; v.cd = 0; return; }
  const ax = pick[0], ay = pick[1], rng = world.rng, ff = world.cfg.friendlyFire, mul = ff.autoStructureMul;
  for (let k = 0; k < n; k++) {
    const a = rng.next() * TAU, rr = W.spread * Math.sqrt(rng.next());
    const lx = ax + Math.cos(a) * rr, ly = ay + Math.sin(a) * rr;
    const dur = Math.hypot(lx - v.x, ly - v.y) / speed + k * 0.05;
    world.projectiles.push({ kind: 'rocket', x0: v.x, y0: v.y, x1: lx, y1: ly, t0: world.t, dur, src: v.key });
    queueShell(world, lx, ly, dur, { r: W.r, dmg: W.dmg, src: v.key, friendly: !!ff.auto, bldgDmg: W.dmg * mul, bridgeDmg: W.dmg * mul, wallDmg: W.dmg * mul, fx: 'boom', u: v });
  }
  v.ax = ax; v.ay = ay; v.fireT = world.t;
  v.cd = s.rof; v.shots++;
  sound(world, 'rocket', v.x, v.y, 0.6, 3);
}

function weapons(world, v, def, s, dt) {
  if (world.t < v.readyAt || world.counts[ZOMBIE] <= 0) { v.mgCd = Math.max(0, v.mgCd - dt); v.cd = Math.max(0, v.cd - dt); return; }
  const acc = s.accuracy ?? world.cfg.armed.accuracy ?? 0.8;
  if (s.rockets) salvo(world, v, def, s, dt);
  else if (s.shellSpeed) {
    deckGun(world, v, s, dt);
    if (def.mgDmg) mg(world, v, def.mgDmg, def.mgRof || 0.15, def.mgRange || 60, acc, dt);
  } else if (s.dmg) mg(world, v, s.dmg, s.rof, s.range, acc, dt);
}

// ---------------------------------------------------------------- ferry
// Shore spot with the biggest crowd of residents outside the zones, weighed by distance. null when none.
function pickShore(world, v, def, N) {
  const list = shoreOf(world, N, v.comp).pick, sh = world.sh, cnt = sh.cntC, hw = sh.hw, hh = sh.hh, inv = sh.inv;
  const R = def.searchR || 600, R2 = R * R, zid = world.zoneId;
  let best = -1, bs = 0;
  for (let k = 0; k < list.length; k += 2) {
    const wc = list[k], lc = list[k + 1];
    const wx = cellX(N, wc), wy = cellY(N, wc), dx = wx - v.x, dy = wy - v.y, d2 = dx * dx + dy * dy;
    if (d2 > R2 || zid[lc]) continue;
    if (v.tried && v.tried.get(wc) > world.t) continue;
    const hx = (cellX(N, lc) * inv) | 0, hy = (cellY(N, lc) * inv) | 0;
    let n = 0;
    for (let y = Math.max(0, hy - 2); y <= Math.min(hh - 1, hy + 2); y++) for (let x = Math.max(0, hx - 2); x <= Math.min(hw - 1, hx + 2); x++) n += cnt[y * hw + x];
    if (n < 3) continue;
    const sc = n / (1 + Math.sqrt(d2) / 150);
    if (sc > bs) { bs = sc; best = k; }
  }
  if (best < 0) return null;
  const wc = list[best], lc = list[best + 1];
  return { w: wc, wx: cellX(N, wc), wy: cellY(N, wc), lx: cellX(N, lc), ly: cellY(N, lc) };
}

// Where the ferry takes people: shore inside a holding safe zone first, else water that leads off the map.
export function ferryDest(world, v, N = navalGrid(world)) {
  if (!v.comp) return null;
  const sh = shoreOf(world, N, v.comp).all, zid = world.zoneId, comps = world.zones.comps;
  let best = -1, bd = Infinity;
  for (let k = 0; k < sh.length; k += 2) {
    const z = zid[sh[k + 1]];
    if (!z || !comps[z - 1] || comps[z - 1].breached) continue;
    const dx = cellX(N, sh[k]) - v.x, dy = cellY(N, sh[k]) - v.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = sh[k]; }
  }
  if (best >= 0) return { kind: 'dock', c: best, x: cellX(N, best), y: cellY(N, best) };
  const ex = exitsOf(world, N, v.comp);
  for (let k = 0; k < ex.length; k++) {
    const dx = cellX(N, ex[k]) - v.x, dy = cellY(N, ex[k]) - v.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = ex[k]; }
  }
  return best >= 0 ? { kind: 'exit', c: best, x: cellX(N, best), y: cellY(N, best) } : null;
}

export const STRANDED = 'No safe zone touches this water and it has no way out to open water';

function endLoad(world, v) {
  if (v.pickup) { world.removePickup(v.pickup); v.pickup = null; }
}

function ferry(world, v, u, def, s, N, mode, dt) {
  if (mode === 'move' || mode === 'hold' || mode === 'return') {
    endLoad(world, v);
    if (v.state === 'load' || v.state === 'unload') v.state = v.loaded > 0 ? 'deliver' : 'seek';
    followOrder(world, v, u, s, N, mode, dt);
    return;
  }
  if (world.t >= v.destT) { v.destT = world.t + 3; v.dest = ferryDest(world, v, N); }
  if (!v.dest) {
    v.note = STRANDED;
    endLoad(world, v);
    if (v.state === 'load' || v.state === 'unload' || v.state === 'deliver') v.state = 'seek';
    log(world, 'FERRY HAS NOWHERE SAFE TO LAND', 'warn', v.x, v.y, 30);
    if (Math.hypot(u.hx - v.x, u.hy - v.y) > 6) sail(world, v, N, u.hx, u.hy, s.speed * 0.6, dt);
    return;
  }
  v.note = '';
  const cap = s.capacity || 40;
  switch (v.state) {
    case 'seek': {
      if (v.loaded >= cap) { v.state = 'deliver'; break; }
      if (world.t >= v.scanT) { v.scanT = world.t + 2; v.spot = pickShore(world, v, def, N); }
      if (!v.spot) {
        if (v.loaded > 0) v.state = 'deliver';
        else if (Math.hypot(u.hx - v.x, u.hy - v.y) > 6) sail(world, v, N, u.hx, u.hy, s.speed * 0.6, dt);
        break;
      }
      if (sail(world, v, N, v.spot.wx, v.spot.wy, s.speed, dt) !== 'moving') {
        v.state = 'load'; v.t0 = world.t; v.lastLoad = world.t; v.acc = 0;
        v.pickup = 'ferry' + v.uid;
        world.addPickup(v.pickup, v.spot.lx, v.spot.ly, 10);
        log(world, 'FERRY BOARDING AT THE SHORE', 'info', v.x, v.y, 15);
      }
      break;
    }
    case 'load': {
      const before = v.loaded;
      const done = loadCivs(world, v, { capacity: cap, loadPerSec: def.loadPerSec || 6, loadRadius: def.loadRadius || 20 }, dt);
      v.saved += v.loaded - before;
      if (done || world.t - v.lastLoad > 15) {
        endLoad(world, v);
        (v.tried || (v.tried = new Map())).set(v.spot ? v.spot.w : -1, world.t + 30);
        v.spot = null; v.scanT = 0;
        v.state = v.loaded > 0 ? 'deliver' : 'seek';
        if (v.loaded > 0) log(world, `FERRY UNDER WAY WITH ${v.loaded} ABOARD`, 'info', v.x, v.y);
      }
      break;
    }
    case 'deliver': {
      if (sail(world, v, N, v.dest.x, v.dest.y, s.speed, dt) !== 'moving') { v.state = 'unload'; v.until = world.t + (def.unloadSec || 4); }
      break;
    }
    case 'unload': {
      if (world.t < v.until) break;
      if (v.loaded > 0) log(world, `FERRY EVACUATED ${v.loaded} RESIDENTS ${v.dest.kind === 'dock' ? 'TO A SAFE ZONE' : 'BY WATER'}`, 'info', v.x, v.y);
      v.loaded = 0; v.state = 'seek'; v.scanT = 0;
      break;
    }
    default: v.state = 'seek';
  }
}

// ---------------------------------------------------------------- damage
// Swimmers (and anything else in the water) that touch the hull tear at it like at a wall.
function hullDamage(world, v, dt) {
  if (world.counts[ZOMBIE] <= 0) return;
  const zc = world.cfg.zombie, L = v.len * 0.5 + zc.touchRadius, B = v.beam * 0.5 + zc.touchRadius;
  if (!zombiesNear(world, v.x, v.y, L)) return;
  const A = world.A, g = world.grid, terr = g.terrain, gw = g.gw, inv = 1 / g.cell;
  const giant = (world.cfg.mutation.kinds.giant && world.cfg.mutation.kinds.giant.wallDpsMul) || 1;
  const hx = Math.cos(v.heading), hy = Math.sin(v.heading);
  let n = 0;
  world.query(v.x, v.y, L, M_ZOMBIE, (i) => {
    if (A.stun[i] > 0) return;
    if (A.sub[i] !== ZSUB.SWIMMER && terr[((A.y[i] * inv) | 0) * gw + ((A.x[i] * inv) | 0)] !== T.WATER) return;
    const dx = A.x[i] - v.x, dy = A.y[i] - v.y, a = dx * hx + dy * hy, p = dy * hx - dx * hy;
    if (a > L || a < -L || p > B || p < -B) return;
    n += A.sub[i] === ZSUB.GIANT ? giant : 1;
  });
  if (!n) return;
  v.hp -= zc.wallDps * dt * n;
  v.hitT = world.t;
  if (v.hp <= 0) { v.hp = 0; v.sinking = true; }
}

// ---------------------------------------------------------------- per tick
function boatStats(world, v, u) {
  const t = world.tick;
  if (!v._s || v._st > t || (t + v.uid) % 20 === 0) {
    v._s = unitStats(world, u); v._st = t;
    const hull = v._s.hull || 1;
    if (hull !== v.hpMax) { v.hp = v.hpMax > 0 ? v.hp * hull / v.hpMax : hull; v.hpMax = hull; }
  }
  return v._s;
}

// Returns true when the boat sank this tick (the caller destroys it).
export function updateBoat(world, v, dt) {
  const u = v.unit;
  if (!u || !u.alive) { v.alive = false; endLoad(world, v); return false; }
  const def = world.cfg.units[u.type], N = navalGrid(world), s = boatStats(world, v, u);
  const x0 = v.x, y0 = v.y, mode = modeOf(v);
  if (def.capacity) ferry(world, v, u, def, s, N, mode, dt);
  else {
    if (mode === 'auto') patrol(world, v, u, def, s, N, dt);
    else followOrder(world, v, u, s, N, mode, dt);
    weapons(world, v, def, s, dt);
  }
  v.spd = Math.hypot(v.x - x0, v.y - y0) / dt;
  u.x = v.x; u.y = v.y; u.kills = v.kills; u.shots = v.shots;
  if ((world.tick & 1) === 0) hullDamage(world, v, dt * 2);
  return !!v.sinking;
}

// Status line for the info card.
export function boatStatus(world, v) {
  if (!v || !v.unit) return '';
  const def = world.cfg.units[v.unit.type] || {}, mode = modeOf(v);
  if (mode === 'move') return 'Under way to the ordered point';
  if (mode === 'hold') return 'Holding position';
  if (mode === 'return') return 'Returning to its mooring';
  if (def.capacity) {
    if (!ferryDest(world, v)) return STRANDED;
    if (world.phase === 'planning') return 'Will ferry residents from the shore to safety';
    if (v.state === 'load') return `Boarding at the shore: ${v.loaded} aboard`;
    if (v.state === 'deliver') return `Carrying ${v.loaded} ${v.dest && v.dest.kind === 'dock' ? 'to a safe zone' : 'out by water'}`;
    if (v.state === 'unload') return 'Landing residents';
    return v.loaded ? `Looking for more residents: ${v.loaded} aboard` : 'Looking for residents on the shore';
  }
  if (mode === 'hunt') return 'Hunting the nearest infected';
  return world.phase === 'planning' ? 'Moored; patrols nearby once the outbreak starts' : 'Patrolling near its mooring';
}

export function waterOf(world, v) {
  const N = world.combat && world.combat.naval;
  return N && v && v.comp ? N.area[v.comp] || 0 : 0;
}
