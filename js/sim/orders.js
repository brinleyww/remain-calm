// Orders for deployed troops: what a player can select, the 'order' command, and squads marching as a group.
// A move (or back-to-zone) order gives each squad formation slots around the destination and a flow field over a
// window around the squad and its slots (Dial's algorithm from nav.js, built over a few ticks when large). Members
// walk down the field (agents.js marchSteer), so walls and gates are respected and nobody needs a path of their own.
// Vehicles flagged `commandable` only get `v.order`; their own update code carries it out.
// On maps with decks the target is on the top level at the point (or the one under it, `low`), formation slots spread
// on that level, and the fields also cover the window's deck and tunnel nodes (decks.js windowGraph).
import { DialJob, P_CIV, P_GATE, DX, DY, INF } from './nav.js';
import { POLICE, MILITIA, SOLDIER, MILITIA_GROUP, SQUAD_GROUP } from './agents.js';
import { windowGraph, localOf, fieldAtT, fieldOf, nearestOnTier, orderTier, nodeAt, stepField, tierOf, groundOf } from './decks.js';

const KIND_CODE = { move: 1, hunt: 2, hold: 3, return: 4 };
const BUILD_EXEC = 150000, BUILD_TICK = 20000; // field cells expanded in the order's own tick / in each later tick
const SNAP_CELLS = 24;
const SQUAD_LABEL = { paratroopers: 'Paratroopers', callToArms: 'Militia', seekDestroy: 'Police' };
const SQUAD_KIND = { paratroopers: 'paratroopers', callToArms: 'militia', seekDestroy: 'police' };
const TYPE_KIND = { [POLICE]: 'police', [MILITIA]: 'militia', [SOLDIER]: 'soldiers' };
const KIND_LABEL = { police: 'Police', militia: 'Militia', soldiers: 'Soldiers', paratroopers: 'Paratroopers' };
const VEHICLE_LABEL = { apc: 'Armoured carrier', tank: 'Battle tank', bus: 'Evacuation bus', medevac: 'Medevac', bulldozer: 'Bulldozer',
  heli: 'Attack helicopter', gunship: 'Gunship', boat: 'Patrol boat' };
const OFF = [-0.9, -0.5, 0.9, 0.5, 0.9, -0.9, -0.9, 0.9, 0, -1.3, 0, 1.3, -1.3, 0, 1.3, 0];

function fail(reason) { return { ok: false, reason, cost: 0 }; }

export function installOrders(world) {
  const O = world.orders = {
    recs: new Map(), byGroup: new Map(), jobs: [], nextId: 1,
    cancel: (group) => cancelGroup(world, group),
    hash: (mix) => hashOrders(world, mix),
  };
  world.registerCommand('order', { quote: quoteOrder, exec: execOrder });
  world.registerSystem({ name: 'orders', order: 15, update: (w) => ordersSystem(w), reset: () => { O.recs.clear(); O.byGroup.clear(); O.jobs.length = 0; O.nextId = 1; } });
  return O;
}

// ---------------------------------------------------------------- selectables
// Every own armed group with at least one member, plus commandable vehicles: { ref, kind, label, x, y, r, n, ... }.
// x, y is the centroid; r covers the squad's extent. mode: 'moving' | 'hunting' | 'holding' (vehicles: their order kind).
export function selectables(world, owner = 0) {
  const A = world.A, type = A.type, group = A.group, own = A.owner, coop = world.owners > 1, acc = new Map(), out = [];
  for (let i = 0, n = A.n; i < n; i++) {
    const t = type[i];
    if (t < POLICE) continue;
    const g = group[i];
    if (g < 0 || (coop && own[i] !== owner)) continue;
    let e = acc.get(g);
    if (!e) { e = { sx: 0, sy: 0, n: 0, hunt: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, type: t, owner: A.owner[i] }; acc.set(g, e); }
    const x = A.x[i], y = A.y[i];
    e.sx += x; e.sy += y; e.n++;
    if (A.state[i] === 1) e.hunt++;
    if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x; if (y < e.y0) e.y0 = y; if (y > e.y1) e.y1 = y;
  }
  const sq = new Map();
  if (world.combat) for (const s of world.combat.squads) sq.set(s.group, s);
  const O = world.orders;
  for (const [g, e] of acc) {
    const { kind, label } = squadKind(world, g, e.type, sq.get(g));
    const moving = !!(O && O.byGroup.has(g));
    out.push({
      ref: 's' + g, group: g, kind, label, type: e.type, owner: e.owner, n: e.n,
      x: e.sx / e.n, y: e.sy / e.n, r: Math.hypot(e.x1 - e.x0, e.y1 - e.y0) * 0.5,
      mode: moving ? 'moving' : e.hunt * 2 > e.n ? 'hunting' : 'holding',
    });
  }
  for (const v of world.vehicles) {
    if (!v || v.alive === false || v.commandable !== true || v.offmap || (coop && (v.owner | 0) !== owner)) continue;
    out.push({ ref: 'v' + v.id, id: v.id, vehicle: true, kind: v.kind, label: v.label || VEHICLE_LABEL[v.kind] || v.kind, owner: v.owner | 0, n: 1,
      x: v.x, y: v.y, r: v.selR || 8, mode: v.order && !v.order.done ? v.order.kind : '' });
  }
  return out;
}

function squadKind(world, g, type, sq) {
  if (g >= SQUAD_GROUP && sq) return { kind: SQUAD_KIND[sq.kind] || TYPE_KIND[type] || 'soldiers', label: SQUAD_LABEL[sq.kind] || KIND_LABEL[TYPE_KIND[type]] || 'Squad' };
  if (g >= MILITIA_GROUP && g < SQUAD_GROUP) return { kind: 'militia', label: 'Militia' };
  if (g < MILITIA_GROUP && world.buildings[g]) return { kind: 'police', label: 'Police' };
  const k = TYPE_KIND[type] || 'soldiers';
  return { kind: k, label: KIND_LABEL[k] };
}

// ---------------------------------------------------------------- command
function parseRefs(refs) {
  const groups = [], vehicles = [], seen = new Set();
  for (const r of Array.isArray(refs) ? refs : []) {
    if (typeof r !== 'string' || r.length < 2 || seen.has(r)) continue;
    const id = Number(r.slice(1));
    if (!Number.isInteger(id) || id < 0) continue;
    seen.add(r);
    if (r[0] === 's') groups.push(id); else if (r[0] === 'v') vehicles.push(id);
  }
  return { groups, vehicles };
}

function quoteOrder(w, cmd) {
  if (w.phase !== 'battle') return fail('Orders are given once the outbreak starts');
  const kind = cmd.kind;
  if (!KIND_CODE[kind]) return fail('Unknown order');
  const owner = cmd.owner | 0, coop = w.owners > 1;
  const want = parseRefs(cmd.refs);
  if (!want.groups.length && !want.vehicles.length) return fail('Nothing selected');
  const vehicles = [];
  for (const id of want.vehicles) {
    const v = w.vehicles.find((q) => q && q.id === id);
    if (!v || v.alive === false || v.commandable !== true || v.offmap) continue;
    if (coop && (v.owner | 0) !== owner) return fail("That is your partner's vehicle");
    vehicles.push(v);
  }
  const members = new Map();
  if (want.groups.length) {
    const ask = new Set(want.groups), A = w.A, type = A.type, group = A.group, own = A.owner;
    let partner = false;
    for (let i = 0, n = A.n; i < n; i++) {
      if (type[i] < POLICE || !ask.has(group[i])) continue;
      if (coop && own[i] !== owner) { partner = true; continue; }
      const g = group[i];
      let m = members.get(g);
      if (!m) members.set(g, m = []);
      m.push(i);
    }
    if (partner) return fail("That is your partner's squad");
  }
  let groups = want.groups.filter((g) => members.has(g));
  if (!groups.length && !vehicles.length) return fail('Nothing left to command');
  let cell = -1, tier = 0;
  if (kind === 'move') {
    if (!Number.isFinite(+cmd.x) || !Number.isFinite(+cmd.y)) return fail('Pick a destination');
    if (w.grid.deck) tier = orderTier(w, +cmd.x, +cmd.y, cmd.low === true);
    if (groups.length) {
      cell = w.grid.deck ? nearestOpenT(w, +cmd.x, +cmd.y, tier) : nearestOpen(w, +cmd.x, +cmd.y, SNAP_CELLS);
      if (cell < 0) { if (!vehicles.length) return fail('No open ground there'); groups = []; }
    }
  } else if (kind === 'return' && groups.length && !ownZones(w, owner).length) {
    // boats and armour go back to where they started, so only squads need a zone
    if (!vehicles.length) return fail('No safe zone with a gate to fall back to');
    groups = [];
  }
  return { ok: true, cost: 0, groups, members, vehicles, cell, tier };
}

function execOrder(w, cmd, q) {
  const O = w.orders, A = w.A, kind = cmd.kind, owner = cmd.owner | 0;
  const C = w.combat;
  if (C && C.rallies.length && q.groups.length) {
    const gs = new Set(q.groups);
    for (const r of C.rallies) r.members = r.members.filter((m) => !(A.type[m[0]] === m[1] && gs.has(A.group[m[0]])));
  }
  for (const g of q.groups) {
    cancelGroup(w, g);
    const hunt = kind === 'hunt';
    for (const i of q.members.get(g)) {
      A.state[i] = hunt ? 1 : 0; A.timer[i] = 0; A.pc[i] = -1;
      A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i];
    }
    if (C) for (const s of C.squads) if (s.group === g) s.mode = hunt ? 'hunt' : 'guard';
  }
  let squads = 0;
  if (kind === 'move' && q.groups.length) {
    const g = w.grid, list = q.groups.map((grp) => ({ group: grp, members: q.members.get(grp) })), gc = g.deck ? groundOf(g.deck, q.cell) : q.cell;
    const dx = (gc % g.gw + 0.5) * g.cell, dy = (((gc / g.gw) | 0) + 0.5) * g.cell;
    squads = march(w, list, kind, owner, +cmd.x, +cmd.y, q.cell, dx, dy, 0);
  } else if (kind === 'return' && q.groups.length) {
    const byZone = new Map();
    for (const grp of q.groups) {
      const mem = q.members.get(grp);
      let sx = 0, sy = 0;
      for (const i of mem) { sx += A.x[i]; sy += A.y[i]; }
      const zt = zoneTarget(w, owner, sx / mem.length, sy / mem.length);
      if (!zt) continue;
      let e = byZone.get(zt.comp);
      if (!e) byZone.set(zt.comp, e = { zt, list: [] });
      e.list.push({ group: grp, members: mem });
    }
    for (const { zt, list } of byZone.values()) squads += march(w, list, kind, owner, zt.x, zt.y, zt.cell, zt.x, zt.y, zt.comp + 1);
  } else squads = q.groups.length;
  let vehicles = 0;
  for (const v of q.vehicles) {
    let x = +cmd.x, y = +cmd.y;
    if (kind === 'return') {
      const home = v.boat && v.unit ? [v.unit.hx, v.unit.hy] : Number.isFinite(v.hx) ? [v.hx, v.hy] : null, zt = home ? null : zoneTarget(w, owner, v.x, v.y);
      x = home ? home[0] : zt ? zt.x : NaN; y = home ? home[1] : zt ? zt.y : NaN;
    }
    else if (kind !== 'move') { x = v.x; y = v.y; }
    v.order = { kind, x, y, t: w.t, done: false };
    if (w.grid.deck) v.order.tier = kind === 'move' ? q.tier : v.tier | 0;
    vehicles++;
  }
  if (O.jobs.length) runJobs(w, BUILD_EXEC);
  return { ok: true, kind, squads, vehicles };
}

// ---------------------------------------------------------------- marching
// One record per squad. Slots for every squad of the order are laid out together so squads stand side by side.
function march(w, list, kind, owner, tx, ty, cell, dx, dy, zone) {
  const A = w.A, O = w.orders;
  let total = 0;
  for (const e of list) total += e.members.length;
  const slots = formation(w, cell, total, zone), st = slots.tiers || null;
  let base = 0;
  for (const e of list) {
    const n = e.members.length;
    const rec = {
      id: O.nextId++, group: e.group, owner, kind, tx, ty, dx, dy, zone,
      members: Int32Array.from(e.members), slotCells: null,
      field: null, build: null, wide: false, probes: 0, ver: w.nav.version, verT: w.tick,
      med: -1, lead: -1, t0: w.t, until: Infinity, tier: st ? tierOf(w.grid.deck, cell) : 0, ht: st ? new Map() : null,
    };
    const cells = new Set();
    for (let k = 0; k < n; k++) {
      const i = rec.members[k], sx = slots[2 * (base + k)], sy = slots[2 * (base + k) + 1];
      A.home[2 * i] = sx; A.home[2 * i + 1] = sy; A.pc[i] = rec.id; A.state[i] = 0; A.vx[i] = 0; A.vy[i] = 0;
      if (st) { rec.ht.set(i, st[base + k]); cells.add(fieldAtT(w, sx, sy, st[base + k])); } else cells.add(w.cellAt(sx, sy));
    }
    rec.slotCells = Int32Array.from([...cells].filter((c) => c >= 0).sort((a, b) => a - b));
    base += n;
    O.recs.set(rec.id, rec);
    O.byGroup.set(rec.group, rec);
    startBuild(w, rec, 'dest', false);
  }
  return list.length;
}

// Formation slots: cells in breadth-first order from `start` over open ground (no gates; inside zone `zone` when > 0),
// two people to a cell, more per cell when the ground runs out.
export function formation(w, start, count, zone = 0) {
  if (w.grid.deck) return formationT(w, start, count, zone);
  const g = w.grid, gw = g.gw, cs = g.cell, pass = w.nav.pass, zid = w.zoneId;
  const open = (c) => (pass[c] & P_CIV) !== 0 && !(pass[c] & P_GATE) && (zone <= 0 || zid[c] === zone);
  const need = Math.max(1, Math.min(4000, Math.ceil(count / 2)));
  const cells = [start], seen = new Set(cells);
  for (let h = 0; h < cells.length && cells.length < need; h++) {
    const c = cells[h];
    for (let d = 0; d < 8 && cells.length < need; d++) {
      const nb = c + DX[d] + DY[d] * gw;
      if (seen.has(nb) || !open(nb)) continue;
      if ((d & 1) && (!open(c + DX[d]) || !open(c + DY[d] * gw))) continue;
      seen.add(nb); cells.push(nb);
    }
  }
  const out = new Float32Array(count * 2), L = cells.length;
  for (let k = 0; k < count; k++) {
    const j = k >> 1, c = cells[j % L], lap = Math.min(3, (j / L) | 0), o = (lap * 2 + (k & 1)) * 2;
    out[2 * k] = (c % gw + 0.5) * cs + OFF[o];
    out[2 * k + 1] = (((c / gw) | 0) + 0.5) * cs + OFF[o + 1];
  }
  return out;
}

// formation() on a map with decks: `start` is a field id and the slots spread over its links (up and down the ramps
// too); out.tiers holds each slot's tier.
function formationT(w, start, count, zone) {
  const g = w.grid, gw = g.gw, cs = g.cell, pass = w.nav.pass, zid = w.zoneId, dk = g.deck, N = dk.N;
  const open = (f) => f >= 0 && (pass[f] & P_CIV) !== 0 && !(pass[f] & P_GATE) && (zone <= 0 || zid[f < N ? f : dk.cell[f - N]] === zone);
  const need = Math.max(1, Math.min(4000, Math.ceil(count / 2)));
  const cells = [start], seen = new Set(cells);
  for (let h = 0; h < cells.length && cells.length < need; h++) {
    const c = cells[h];
    for (let d = 0; d < 8 && cells.length < need; d++) {
      const nb = stepField(dk, c, DX[d], DY[d]);
      if (nb < 0 || seen.has(nb) || !open(nb)) continue;
      if ((d & 1) && (c < N ? !open(c + DX[d]) || !open(c + DY[d] * gw) : !open(stepField(dk, c, DX[d], 0)) || !open(stepField(dk, c, 0, DY[d])))) continue;
      seen.add(nb); cells.push(nb);
    }
  }
  const out = new Float32Array(count * 2), L = cells.length, tiers = out.tiers = new Int8Array(count);
  for (let k = 0; k < count; k++) {
    const j = k >> 1, f = cells[j % L], c = f < N ? f : dk.cell[f - N], lap = Math.min(3, (j / L) | 0), o = (lap * 2 + (k & 1)) * 2;
    out[2 * k] = (c % gw + 0.5) * cs + OFF[o];
    out[2 * k + 1] = (((c / gw) | 0) + 0.5) * cs + OFF[o + 1];
    tiers[k] = f < N ? 0 : dk.tier[f - N];
  }
  return out;
}

// Nearest open field id on tier t near a point (else on the ground), -1 if none.
function nearestOpenT(w, x, y, t) {
  const f = nearestOnTier(w, x, y, t, P_CIV, P_GATE, SNAP_CELLS);
  return f >= 0 || t === 0 ? f : nearestOnTier(w, x, y, 0, P_CIV, P_GATE, SNAP_CELLS);
}

// Nearest open (walkable, not a gate) cell within maxR cells of a point, -1 if none.
export function nearestOpen(w, x, y, maxR = SNAP_CELLS) {
  const g = w.grid, pass = w.nav.pass, cx0 = Math.floor(x / g.cell), cy0 = Math.floor(y / g.cell);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= maxR && best < 0; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const cx = cx0 + dx, cy = cy0 + dy;
      if (cx < 1 || cy < 1 || cx >= g.gw - 1 || cy >= g.gh - 1) continue;
      const c = cy * g.gw + cx;
      if (!(pass[c] & P_CIV) || (pass[c] & P_GATE)) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
  }
  return best;
}

function ownZones(w, owner) {
  const gated = new Set();
  for (const gt of w.zones.gates) gated.add(gt.comp);
  return w.zones.comps.filter((c) => gated.has(c.id) && (w.owners < 2 || c.owner === owner));
}

// The own gated zone nearest to (x, y) by its nearest gate, intact zones first: { comp, cell, x, y } of the interior
// cell nearest the zone's middle, or null.
function zoneTarget(w, owner, x, y) {
  const comps = ownZones(w, owner);
  if (!comps.length) return null;
  const g = w.grid, cs = g.cell, gw = g.gw, pass = w.nav.pass;
  let best = null, bd = Infinity;
  for (const c of comps) {
    let d = Infinity;
    for (const gt of w.zones.gates) if (gt.comp === c.id) d = Math.min(d, Math.hypot(gt.x - x, gt.y - y));
    if (c.breached) d += 1e7;
    if (d < bd) { bd = d; best = c; }
  }
  const [x0, y0, x1, y1] = best.bbox;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, ic = best.interiorCells;
  let cell = -1, cd = Infinity;
  for (let k = 0; k < ic.length; k++) {
    const c = ic[k];
    if (!(pass[c] & P_CIV)) continue;
    const ex = c % gw - mx, ey = ((c / gw) | 0) - my, d = ex * ex + ey * ey;
    if (d < cd) { cd = d; cell = c; }
  }
  if (cell < 0) return null;
  return { comp: best.id, cell, x: (cell % gw + 0.5) * cs, y: (((cell / gw) | 0) + 0.5) * cs };
}

// ---------------------------------------------------------------- fields
function startBuild(w, rec, phase, wide) {
  const g = w.grid, gw = g.gw, gh = g.gh, nav = w.nav, A = w.A;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (c) => { const cx = c % gw, cy = (c / gw) | 0; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy; };
  let live = 0;
  for (const i of rec.members) if (marching(A, i, rec)) { take(w.cellAt(A.x[i], A.y[i])); live++; }
  if (!live) return;
  if (phase === 'probe') take(w.cellAt(rec.tx, rec.ty)); else for (const c of rec.slotCells) take(c);
  const span = Math.max(x1 - x0, y1 - y0);
  const m = wide ? Math.max(120, Math.round(span * 0.75)) : Math.min(64, Math.max(24, Math.round(span * 0.35)));
  let ox = Math.max(0, x0 - m), oy = Math.max(0, y0 - m), ex = Math.min(gw - 1, x1 + m), ey = Math.min(gh - 1, y1 + m);
  if (wide && (ex - ox + 1) * (ey - oy + 1) > 0.6 * gw * gh) { ox = 0; oy = 0; ex = gw - 1; ey = gh - 1; }
  const lw = ex - ox + 1, lh = ey - oy + 1, LN = lw * lh, dk = g.deck, wg = dk ? windowGraph(dk, ox, oy, lw, lh) : null;
  const cost = new Uint8Array(LN + (wg ? wg.D : 0)), src = nav.civCost;
  let open = 0;
  for (let y = 1; y < lh - 1; y++) {
    const row = (y + oy) * gw + ox;
    for (let x = 1; x < lw - 1; x++) { const k = src[row + x]; if (k) { cost[y * lw + x] = k; open++; } }
  }
  if (wg) for (let j = 0; j < wg.D; j++) { const k = src[wg.gid[j]]; if (k) { cost[LN + j] = k; open++; } }
  const job = new DialJob(cost.length, lw);
  job.begin(cost, Math.max(1, nav.k.rubble), INF, wg);
  const N = gw * gh, local = (c) => (c < 0 ? -1 : localOf(wg, c, N, gw, ox, oy, lw, lh));
  if (phase === 'probe') {
    for (const i of rec.members) if (marching(A, i, rec)) { const l = local(dk ? fieldOf(w, i) : w.cellAt(A.x[i], A.y[i])); if (l >= 0 && cost[l]) job.source(l); }
  } else for (const c of rec.slotCells) { const l = local(c); if (l >= 0 && cost[l]) job.source(l); }
  if (!rec.build) w.orders.jobs.push(rec);
  rec.build = { phase, wide, job, ox, oy, lw, lh, cost, open, used: 0, wg };
}

function runJobs(w, budget) {
  const O = w.orders;
  while (O.jobs.length && budget > 0) {
    const rec = O.jobs[0], b = rec.build;
    if (!b || O.recs.get(rec.id) !== rec) { O.jobs.shift(); if (b) rec.build = null; continue; }
    if (!b.job.run(budget)) { b.used += budget; break; }
    budget -= Math.max(1, Math.min(budget, b.open - b.used));
    O.jobs.shift();
    rec.build = null;
    finishBuild(w, rec, b);
  }
}

const marching = (A, i, rec) => A.type[i] >= POLICE && A.group[i] === rec.group && A.pc[i] === rec.id;

// Local index of the field cell a member uses (its own cell or node, else a covered neighbour), -1 when none.
function memberCell(w, F, i) {
  const g = w.grid, A = w.A;
  if (g.deck && A.tier[i] !== 0) {
    const f = nodeAt(g.deck, A.tier[i], Math.floor(A.x[i] / g.cell), Math.floor(A.y[i] / g.cell));
    const l = f < 0 || !F.wg ? -1 : localOf(F.wg, f, g.deck.N, g.gw, F.ox, F.oy, F.lw, F.lh);
    if (l < 0) return -1;
    if (F.dir[l] !== 255) return l;
    for (let d = 0; d < 8; d++) { const n = stepField(F.wg, l, DX[d], DY[d]); if (n >= 0 && F.dir[n] !== 255) return n; }
    return -1;
  }
  const cx = Math.floor(A.x[i] / g.cell) - F.ox, cy = Math.floor(A.y[i] / g.cell) - F.oy;
  if (cx < 1 || cy < 1 || cx >= F.lw - 1 || cy >= F.lh - 1) return -1;
  const l = cy * F.lw + cx;
  if (F.dir[l] !== 255) return l;
  for (let d = 0; d < 8; d++) { const n = l + DX[d] + DY[d] * F.lw; if (F.dir[n] !== 255) return n; }
  return -1;
}

// True when the walkable ground around cell c is a small closed pocket (a yard someone was dropped into): no wider
// field would reach it either.
function boxedIn(w, c, limit = 400) {
  const pass = w.nav.pass, gw = w.grid.gw, seen = new Set([c]), q = [c];
  for (let h = 0; h < q.length; h++) {
    const k = q[h];
    for (const nb of [k + 1, k - 1, k + gw, k - gw]) {
      if (seen.has(nb) || !(pass[nb] & P_CIV)) continue;
      if (q.length >= limit) return false;
      seen.add(nb); q.push(nb);
    }
  }
  return true;
}

function finishBuild(w, rec, b) {
  const A = w.A, F = { ox: b.ox, oy: b.oy, lw: b.lw, lh: b.lh, cost: b.cost, dir: b.job.dir, dist: b.job.dist, wg: b.wg };
  if (b.phase === 'probe') {
    // nothing could reach the slots: walk to the reachable cell nearest the target instead
    const g = w.grid, cs = g.cell;
    let best = -1, bd = Infinity;
    for (let ly = 1; ly < F.lh - 1; ly++) for (let lx = 1; lx < F.lw - 1; lx++) {
      const l = ly * F.lw + lx;
      if (F.dir[l] === 255 || !F.cost[l]) continue;
      const c = (ly + F.oy) * g.gw + lx + F.ox;
      if (w.nav.pass[c] & P_GATE) continue;
      const ex = (lx + F.ox + 0.5) * cs - rec.tx, ey = (ly + F.oy + 0.5) * cs - rec.ty, d = ex * ex + ey * ey;
      if (d < bd) { bd = d; best = c; }
    }
    const wg = F.wg, LN = F.lw * F.lh;
    if (wg) for (let j = 0; j < wg.D; j++) {
      const l = LN + j, f = wg.gid[j];
      if (F.dir[l] === 255 || !F.cost[l] || (w.nav.pass[f] & P_GATE)) continue;
      const lx = wg.cell[j] % F.lw, ly = (wg.cell[j] / F.lw) | 0;
      const ex = (lx + F.ox + 0.5) * cs - rec.tx, ey = (ly + F.oy + 0.5) * cs - rec.ty, d = ex * ex + ey * ey;
      if (d < bd) { bd = d; best = f; }
    }
    if (best < 0) { releaseRec(w, rec); return; }
    const bc = g.deck ? groundOf(g.deck, best) : best;
    rec.dx = (bc % g.gw + 0.5) * cs; rec.dy = (((bc / g.gw) | 0) + 0.5) * cs;
    const live = [];
    for (const i of rec.members) if (marching(A, i, rec)) live.push(i);
    const slots = formation(w, best, live.length, 0), cells = new Set(), st = slots.tiers || null;
    if (st) rec.tier = tierOf(g.deck, best);
    live.forEach((i, k) => {
      A.home[2 * i] = slots[2 * k]; A.home[2 * i + 1] = slots[2 * k + 1];
      if (st) { rec.ht.set(i, st[k]); cells.add(fieldAtT(w, slots[2 * k], slots[2 * k + 1], st[k])); } else cells.add(w.cellAt(slots[2 * k], slots[2 * k + 1]));
    });
    rec.slotCells = Int32Array.from([...cells].filter((c) => c >= 0).sort((a, z) => a - z));
    startBuild(w, rec, 'dest', true);
    return;
  }
  let live = 0, reached = 0, far = 0, open = 0;
  for (const i of rec.members) {
    if (!marching(A, i, rec)) continue;
    live++;
    const l = memberCell(w, F, i);
    if (l >= 0) { reached++; if (F.dist[l] > far) far = F.dist[l]; } else if (!b.wide && ((w.grid.deck && A.tier[i] !== 0) || !boxedIn(w, w.cellAt(A.x[i], A.y[i])))) open++;
  }
  if (!live) { releaseRec(w, rec); return; }
  if ((open || !reached) && !b.wide) { startBuild(w, rec, 'dest', true); return; }
  if (!reached) {
    if (rec.probes++ < 2) { startBuild(w, rec, 'probe', true); return; }
    releaseRec(w, rec);
    return;
  }
  rec.wide = b.wide;
  rec.field = F;
  rec.ver = w.nav.version; rec.verT = w.tick;
  const spd = w.cfg.armed.speed || 3;
  rec.until = w.t + 40 + 3 * (far / 10 * w.grid.cell) / spd;
  // whoever the field cannot reach holds where they stand
  for (const i of rec.members) if (marching(A, i, rec) && memberCell(w, F, i) < 0) { A.pc[i] = -1; A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; }
  paceRec(w, rec);
}

// Median field distance of the members still marching (the squad's pace) and the member at it (lead, for the map line).
const PACE = [];
function paceRec(w, rec) {
  const A = w.A, F = rec.field;
  PACE.length = 0;
  let n = 0;
  for (const i of rec.members) {
    if (!marching(A, i, rec)) continue;
    n++;
    if (!F) continue;
    const l = memberCell(w, F, i);
    if (l >= 0 && F.dir[l] < 8) PACE.push([F.dist[l], i]);
  }
  if (PACE.length) {
    PACE.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const mid = PACE[(PACE.length - 1) >> 1];
    rec.med = mid[0]; rec.lead = mid[1];
  }
  return n;
}

function releaseRec(w, rec) {
  const A = w.A;
  for (const i of rec.members) if (marching(A, i, rec)) { A.pc[i] = -1; A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i]; }
  dropRec(w, rec);
}

function dropRec(w, rec) {
  const O = w.orders;
  O.recs.delete(rec.id);
  if (O.byGroup.get(rec.group) === rec) O.byGroup.delete(rec.group);
  if (rec.build) { const k = O.jobs.indexOf(rec); if (k >= 0) O.jobs.splice(k, 1); rec.build = null; }
}

// A new order or stance for the group: members still walking stop where they are.
function cancelGroup(w, group) {
  const rec = w.orders && w.orders.byGroup.get(group);
  if (!rec) return;
  const A = w.A;
  for (const i of rec.members) if (marching(A, i, rec)) { A.vx[i] = 0; A.vy[i] = 0; }
  releaseRec(w, rec);
}

function fieldStale(w, F) {
  const src = w.nav.civCost, gw = w.grid.gw, cost = F.cost;
  for (let y = 1; y < F.lh - 1; y++) {
    const row = (y + F.oy) * gw + F.ox, lr = y * F.lw;
    for (let x = 1; x < F.lw - 1; x++) if (src[row + x] !== cost[lr + x]) return true;
  }
  const wg = F.wg, LN = F.lw * F.lh;
  if (wg) for (let j = 0; j < wg.D; j++) if (src[wg.gid[j]] !== cost[LN + j]) return true;
  return false;
}

function ordersSystem(w) {
  const O = w.orders;
  if (O.jobs.length) runJobs(w, BUILD_TICK);
  for (const rec of O.recs.values()) {
    if ((w.tick + rec.id) % 3 !== 0) continue;
    if (!paceRec(w, rec)) { dropRec(w, rec); continue; }
    if (w.t > rec.until) { releaseRec(w, rec); continue; }
    const F = rec.field;
    if (F && !rec.build && w.nav.version !== rec.ver && w.tick - rec.verT >= 10) {
      rec.ver = w.nav.version; rec.verT = w.tick;
      if (fieldStale(w, F)) startBuild(w, rec, 'dest', rec.wide);
    }
  }
}

// Points from (x, y) on tier `tier` down the squad's field to its destination: [x0, y0, x1, y1, ...] (for the map
// line); out.tiers has the tier of each point on maps with decks.
export function marchPath(w, rec, x, y, maxSteps = 1500, tier = 0) {
  const F = rec && rec.field, g = w.grid, cs = g.cell, out = [x, y], wg = F ? F.wg : null, LN = F ? F.lw * F.lh : 0;
  const tiers = out.tiers = g.deck ? [tier] : null;
  const end = () => { out.push(rec.dx, rec.dy); if (tiers) tiers.push(rec.tier | 0); return out; };
  if (!F) return end();
  let cx = Math.floor(x / cs) - F.ox, cy = Math.floor(y / cs) - F.oy, l;
  if (tier !== 0 && g.deck) {
    const f = nodeAt(g.deck, tier, cx + F.ox, cy + F.oy);
    l = f < 0 || !wg ? -1 : localOf(wg, f, g.deck.N, g.gw, F.ox, F.oy, F.lw, F.lh);
  } else l = cx < 1 || cy < 1 || cx >= F.lw - 1 || cy >= F.lh - 1 ? -1 : cy * F.lw + cx;
  if (l < 0) return end();
  let last = -1;
  const at = () => { if (l >= LN) { const c = wg.cell[l - LN]; cx = c % F.lw; cy = (c / F.lw) | 0; } else { cx = l % F.lw; cy = (l / F.lw) | 0; } };
  const put = () => { out.push((cx + F.ox + 0.5) * cs, (cy + F.oy + 0.5) * cs); if (tiers) tiers.push(l >= LN ? wg.tier[l - LN] : 0); };
  at();
  for (let s = 0; s < maxSteps; s++) {
    const d = F.dir[l];
    if (d >= 8) break;
    if (d !== last && s) put();
    last = d;
    const n = wg ? stepField(wg, l, DX[d], DY[d]) : l + DX[d] + DY[d] * F.lw;
    if (n < 0) break;
    l = n; at();
  }
  put();
  return end();
}

// Squad group and vehicle ids stay out: their counters are not reset by a retry, so a replay would hash differently.
function hashOrders(w, mix) {
  for (const r of w.orders.recs.values()) {
    mix(r.id); mix(KIND_CODE[r.kind]); mix(Math.round(r.dx * 4)); mix(Math.round(r.dy * 4)); mix(r.field ? 1 : 0); mix(r.members.length); mix(r.med);
    if (r.ht) mix(r.tier);
  }
  for (const v of w.vehicles) {
    const o = v && v.alive !== false && v.order;
    if (!o) continue;
    mix(KIND_CODE[o.kind] || 0); mix(Number.isFinite(o.x) ? Math.round(o.x * 4) : -1); mix(Number.isFinite(o.y) ? Math.round(o.y * 4) : -1);
    if (o.tier !== undefined) mix(o.tier);
  }
}
