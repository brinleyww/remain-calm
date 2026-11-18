// Safe zones (union-of-polygons components), gates, standalone walls, corridors and holds.
import { T } from '../map/format.js';
import { rasterPoly, rasterPolyline, polyArea, polyPerimeter, pointInPoly, clamp } from '../util/geom.js';
import { updatePassCells, touchNav, buildCorridorField, corridorContains, corridorBBox } from './nav.js';
import { canAfford, spend, refundPlacement } from './economy.js';
import { refreshFunctions } from './structures.js';

export function initZones(world) {
  const N = world.grid.gw * world.grid.gh;
  world.zones = { polys: [], comps: [], gates: [] };
  world.walls = [];
  world.corridors = [];
  world.holds = [];
  world.block = new Uint8Array(N);
  world.wallHp = new Float32Array(N);
  world.zoneId = new Int16Array(N);
  world.zoneComp = new Int16Array(N);
  world.corrGrid = new Int16Array(N);
  world.holdGrid = new Int16Array(N);
  world.gateIdx = new Int16Array(N);
  world.zoneLand = 0;
  world._blockCells = new Int32Array(0);
  world._unionCells = new Int32Array(0);
  world._featCells = [];
  world._tmpKind = new Uint8Array(N);
  world._tmpHp = new Float32Array(N);
}

const levelMul = (world, lvl) => { const m = world.cfg.wall.levelHpMul; return m[clamp(lvl - 1, 0, m.length - 1)] || 1; };
const own = (world, item, owner) => world.owners < 2 || item.owner === owner;

// ---------------------------------------------------------------- rebuild
export function rebuildZones(world) {
  const g = world.grid, gw = g.gw, gh = g.gh, mask = world.region.mask;
  const zc = world.zoneComp, zi = world.zoneId;
  for (const c of world._unionCells) { zc[c] = 0; zi[c] = 0; }
  const union = world._tmpKind;
  const polys = world.zones.polys;
  const first = new Int32Array(polys.length).fill(-1);
  const all = [];
  for (let k = 0; k < polys.length; k++) {
    rasterPoly(polys[k].p, g.cell, gw, gh, (c) => {
      if (!mask[c]) return;
      if (first[k] < 0) first[k] = c;
      if (!union[c]) { union[c] = 1; all.push(c); }
    });
  }
  all.sort((a, b) => a - b);
  const comps = [];
  const stack = [];
  let land = 0;
  for (const s of all) {
    if (zc[s]) continue;
    const id = comps.length + 1;
    const cells = [];
    zc[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const X = c % gw, Y = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = X + dx, ny = Y + dy;
        if ((dx | dy) === 0 || nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (union[n] && !zc[n]) { zc[n] = id; stack.push(n); }
      }
    }
    cells.sort((a, b) => a - b);
    const wallCells = [], interiorCells = [];
    let sx = 0, sy = 0;
    for (const c of cells) {
      const X = c % gw, Y = (c / gw) | 0;
      sx += X; sy += Y;
      if (g.terrain[c] !== T.WATER) land++;
      let edge = X === 0 || Y === 0 || X === gw - 1 || Y === gh - 1;
      if (!edge) {
        for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!union[(Y + dy) * gw + X + dx]) { edge = true; break; }
        }
      }
      if (edge) wallCells.push(c); else { interiorCells.push(c); zi[c] = id; }
    }
    comps.push({
      id: id - 1, cells: Int32Array.from(cells), wallCells: Int32Array.from(wallCells), interiorCells: Int32Array.from(interiorCells),
      breached: false, wallLevel: 1, owner: 0, bldgs: [], polys: [],
      cx: (sx / cells.length + 0.5) * g.cell, cy: (sy / cells.length + 0.5) * g.cell,
    });
  }
  for (const c of all) union[c] = 0;
  world._unionCells = Int32Array.from(all);
  world.zoneLand = land;

  for (let k = 0; k < polys.length; k++) {
    const pl = polys[k];
    const ci = first[k] >= 0 ? zc[first[k]] - 1 : -1;
    pl.comp = ci;
    if (ci < 0) continue;
    const comp = comps[ci];
    if (!comp.polys.length) comp.owner = pl.owner;
    comp.polys.push(pl.id);
    comp.wallLevel = Math.max(comp.wallLevel, pl.level || 1);
    if (pl.breached) comp.breached = true;
  }
  world.zones.comps = comps;

  // buildings inside
  const zcfg = world.cfg.zone;
  for (const b of world.buildings) b.zone = -1;
  for (const comp of comps) {
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    for (const c of comp.cells) { const X = c % gw, Y = (c / gw) | 0; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
    comp.bbox = [x0, y0, x1, y1];
    const id1 = comp.id + 1;
    for (const b of world.buildings) {
      const info = g.bInfo[b.idx], bb = info.bb;
      if (!info.cells.length || bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) continue;
      let inside = 0;
      for (const c of info.cells) if (zi[c] === id1) inside++;
      const need = info.big ? zcfg.bigBldgInsideFrac : zcfg.bldgInsideFrac;
      if (inside > 0 && inside >= need * info.cells.length - 1e-9) { b.zone = comp.id; comp.bldgs.push(b.idx); }
    }
  }

  resnapGates(world);
  rebuildBlocks(world);
  refreshFunctions(world);
  touchNav(world);
}

function nearestZoneWallCell(world, x, y, maxCells) {
  const g = world.grid, cx0 = Math.floor(x / g.cell), cy0 = Math.floor(y / g.cell);
  let best = -1, bd = Infinity;
  for (let dy = -maxCells; dy <= maxCells; dy++) for (let dx = -maxCells; dx <= maxCells; dx++) {
    const cx = cx0 + dx, cy = cy0 + dy;
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
    const c = cy * g.gw + cx;
    if (!world.zoneComp[c] || world.zoneId[c]) continue;
    const ex = (cx + 0.5) * g.cell - x, ey = (cy + 0.5) * g.cell - y, d = ex * ex + ey * ey;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function gateCellsAt(world, c0) {
  const g = world.grid, comp = world.zoneComp[c0];
  const cx0 = c0 % g.gw, cy0 = (c0 / g.gw) | 0;
  const r = world.cfg.gate.width * 0.5, rc = Math.ceil(r / g.cell);
  const out = [];
  for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) {
    const cx = cx0 + dx, cy = cy0 + dy;
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) continue;
    if ((dx * dx + dy * dy) * g.cell * g.cell > r * r + 1e-6) continue;
    const c = cy * g.gw + cx;
    if (world.zoneComp[c] === comp && !world.zoneId[c]) out.push(c);
  }
  return out.sort((a, b) => a - b);
}

function resnapGates(world) {
  const keep = [];
  const gcfg = world.cfg.gate;
  for (const gt of world.zones.gates) {
    const c0 = nearestZoneWallCell(world, gt.x, gt.y, 2);
    if (c0 < 0) { refundPlacement(world, gt, 'gate'); continue; }
    const comp = world.zones.comps[world.zoneComp[c0] - 1];
    if (!own(world, comp, gt.owner)) { refundPlacement(world, gt, 'gate'); continue; }
    gt.comp = comp.id;
    gt.cells = Int32Array.from(gateCellsAt(world, c0));
    const hpMax = gcfg.hp * levelMul(world, comp.wallLevel);
    gt.hp = world.phase === 'battle' && gt.hpMax ? Math.min(gt.hp, hpMax) : hpMax;
    gt.hpMax = hpMax;
    keep.push(gt);
  }
  world.zones.gates = keep;
}

// Recomposes block/wallHp from standalone walls, zone walls and gates. In battle, damage on surviving cells is kept.
export function rebuildBlocks(world) {
  const keep = world.phase === 'battle';
  const block = world.block, hp = world.wallHp, tk = world._tmpKind, th = world._tmpHp;
  const old = world._blockCells;
  for (let k = 0; k < old.length; k++) { const c = old[k]; tk[c] = block[c]; th[c] = hp[c]; block[c] = 0; hp[c] = 0; world.gateIdx[c] = 0; }
  const out = [];
  const wcfg = world.cfg.wall;
  for (const w of world.walls) for (const c of w.cells) {
    if (block[c]) continue;
    block[c] = 2; hp[c] = keep && tk[c] === 2 ? th[c] : wcfg.hp; out.push(c);
  }
  for (const comp of world.zones.comps) {
    const full = wcfg.hp * levelMul(world, comp.wallLevel);
    for (const c of comp.wallCells) {
      if (!block[c]) out.push(c);
      block[c] = 1; hp[c] = keep && tk[c] === 1 ? Math.min(th[c], full) : full;
    }
  }
  world.zones.gates.forEach((gt, k) => {
    for (const c of gt.cells) {
      if (!block[c]) out.push(c);
      block[c] = 3; hp[c] = gt.hp; world.gateIdx[c] = k + 1;
    }
  });
  for (let k = 0; k < old.length; k++) { tk[old[k]] = 0; th[old[k]] = 0; }
  world._blockCells = Int32Array.from(out);
  updatePassCells(world, old);
  updatePassCells(world, world._blockCells);
}

export function rebuildFeatureGrids(world) {
  const g = world.grid, cs = g.cell;
  for (const c of world._featCells) { world.corrGrid[c] = 0; world.holdGrid[c] = 0; }
  const cells = [];
  world.corridors.forEach((co, k) => {
    const [x0, y0, x1, y1] = corridorBBox(co);
    for (let cy = Math.max(0, Math.floor(y0 / cs)); cy <= Math.min(g.gh - 1, Math.floor(y1 / cs)); cy++)
      for (let cx = Math.max(0, Math.floor(x0 / cs)); cx <= Math.min(g.gw - 1, Math.floor(x1 / cs)); cx++) {
        if (!corridorContains(co, (cx + 0.5) * cs, (cy + 0.5) * cs)) continue;
        const c = cy * g.gw + cx; world.corrGrid[c] = k + 1; cells.push(c);
      }
  });
  world.holds.forEach((h, k) => {
    const rc = Math.ceil(h.R / cs);
    const hx = Math.floor(h.x / cs), hy = Math.floor(h.y / cs);
    for (let cy = Math.max(0, hy - rc); cy <= Math.min(g.gh - 1, hy + rc); cy++)
      for (let cx = Math.max(0, hx - rc); cx <= Math.min(g.gw - 1, hx + rc); cx++) {
        const dx = (cx + 0.5) * cs - h.x, dy = (cy + 0.5) * cs - h.y;
        if (dx * dx + dy * dy > h.R * h.R) continue;
        const c = cy * g.gw + cx; world.holdGrid[c] = k + 1; cells.push(c);
      }
  });
  world._featCells = cells;
  world.nav.corrFields = world.corridors.map((co) => buildCorridorField(world, co));
}

export function corridorField(world, k) {
  const f = world.nav.corrFields[k];
  if (!f || f.stale) world.nav.corrFields[k] = buildCorridorField(world, world.corridors[k]);
  return world.nav.corrFields[k];
}

// ---------------------------------------------------------------- queries
export function inZone(world, x, y) {
  const g = world.grid, cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh) return -1;
  const z = world.zoneId[cy * g.gw + cx] - 1;
  return z >= 0 && !world.zones.comps[z].breached ? z : -1;
}

export function buildingInZone(world, b) {
  const bd = world.buildings[b];
  if (!bd || bd.zone < 0) return -1;
  return world.zones.comps[bd.zone] && !world.zones.comps[bd.zone].breached ? bd.zone : -1;
}

export function breachZone(world, k) {
  const comp = world.zones.comps[k];
  if (!comp || comp.breached) return;
  comp.breached = true;
  for (const pl of world.zones.polys) if (pl.comp === k) pl.breached = true;
  world.nav.civ.dirty = true;
  world.events.emit('breach', { zoneId: k });
  world.events.emit('log', { msg: 'SAFE ZONE BREACHED', kind: 'alert', x: comp.cx, y: comp.cy });
  world.events.emit('sound', { name: 'breach', x: comp.cx, y: comp.cy, vol: 1 });
  world._onBreach(k);
}

function standaloneLen(world, except = -1) { let s = 0; for (const w of world.walls) if (w.id !== except) s += w.len; return s; }
export function standaloneLimit(world) { const c = world.cfg.wall; return c.standaloneMaxM + c.standalonePerLevelM * world.stage; }

function phaseOk(world) { return world.phase === 'planning' || world.phase === 'battle'; }
const fail = (reason) => ({ ok: false, reason, cost: 0 });
function vertsInside(world, p) {
  const poly = world.region.poly;
  for (let i = 0; i < p.length; i += 2) if (!pointInPoly(poly, p[i], p[i + 1])) return false;
  return true;
}
function isFlat(p) { if (!Array.isArray(p) && !ArrayBuffer.isView(p)) return false; for (const v of p) if (!Number.isFinite(v)) return false; return true; }

// ---------------------------------------------------------------- commands
function zoneAddQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const p = cmd.p, owner = cmd.owner | 0, zcfg = world.cfg.zone;
  if (!isFlat(p) || p.length < 2 * zcfg.minCorners || p.length % 2) return fail(`Needs at least ${zcfg.minCorners} corners`);
  if (!vertsInside(world, p)) return fail('Must be inside the stage boundary');
  if (polyArea(p) < 100) return fail('Too small');
  const g = world.grid, gw = g.gw, mask = world.region.mask;
  const touched = new Set();
  let cells = 0, newLand = 0;
  rasterPoly(p, g.cell, gw, g.gh, (c) => {
    if (!mask[c]) return;
    cells++;
    if (world.zoneComp[c]) { touched.add(world.zoneComp[c] - 1); return; }
    if (g.terrain[c] !== T.WATER) newLand++;
    const X = c % gw, Y = (c / gw) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = X + dx, ny = Y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= g.gh) continue;
      const z = world.zoneComp[ny * gw + nx];
      if (z) touched.add(z - 1);
    }
  });
  if (cells < 9) return fail('Too small');
  for (const k of touched) if (!own(world, world.zones.comps[k], owner)) return fail("Touches your partner's zone");
  const comps = world.zones.comps.length;
  if (comps - touched.size + 1 > zcfg.maxZones) return fail(`At most ${zcfg.maxZones} safe zones`);
  if (world.zoneLand + newLand > zcfg.maxLandFrac * world.region.landCells) return fail(`Zones may cover at most ${Math.round(zcfg.maxLandFrac * 100)}% of the land`);
  const base = touched.size ? 0 : comps >= zcfg.freeZones ? zcfg.baseCost : 0;
  const cost = Math.round(base + polyPerimeter(p) * world.cfg.wall.perM);
  if (!canAfford(world, cost, owner)) return { ok: false, reason: 'Not enough money', cost };
  let level = 1;
  for (const k of touched) level = Math.max(level, world.zones.comps[k].wallLevel);
  return { ok: true, cost, base, level };
}

function zoneAdd(world, cmd, q) {
  const id = world.nextId();
  const pl = { id, p: Array.from(cmd.p, (v) => Math.round(v * 10) / 10), owner: cmd.owner | 0, paid: q.cost, base: q.base, level: q.level, upPaid: 0, breached: false, comp: -1 };
  world.zones.polys.push(pl);
  rebuildZones(world);
  spend(world, q.cost, pl.owner, 'zone');
  return { ok: true, id, cost: q.cost };
}

function findById(list, id) { for (let k = 0; k < list.length; k++) if (list[k].id === id) return k; return -1; }

function zoneRemoveQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const k = findById(world.zones.polys, cmd.id);
  if (k < 0) return fail('No such zone');
  if (!own(world, world.zones.polys[k], cmd.owner | 0)) return fail("That is your partner's zone");
  return { ok: true, cost: 0, refund: world.refundValue(world.zones.polys[k].paid + world.zones.polys[k].upPaid) };
}

function zoneRemove(world, cmd) {
  const k = findById(world.zones.polys, cmd.id);
  const pl = world.zones.polys[k];
  const got = refundPlacement(world, { owner: pl.owner, paid: pl.paid + pl.upPaid }, 'zone');
  world.zones.polys.splice(k, 1);
  rebuildZones(world);
  return { ok: true, refund: got };
}

function zoneMoveEval(world, cmd, apply) {
  if (world.phase !== 'planning') return fail('Zones can only be reshaped during planning');
  const k = findById(world.zones.polys, cmd.id);
  if (k < 0) return fail('No such zone');
  const pl = world.zones.polys[k], owner = pl.owner, zcfg = world.cfg.zone, p = cmd.p;
  if (!own(world, pl, cmd.owner | 0)) return fail("That is your partner's zone");
  if (!isFlat(p) || p.length < 2 * zcfg.minCorners || p.length % 2) return fail(`Needs at least ${zcfg.minCorners} corners`);
  if (!vertsInside(world, p)) return fail('Must be inside the stage boundary');
  if (polyArea(p) < 100) return fail('Too small');
  const oldP = pl.p;
  // a trial rebuild may drop gates and functions; keep what is needed to undo it exactly
  const saved = {
    gates: world.zones.gates.map((gt) => ({ ...gt })),
    funcs: world.buildings.filter((b) => b.func).map((b) => [b.idx, b.func, b.funcState]),
    spent: world.budget.spent, owners: world.budget.owners.map((o) => o.spent), by: { ...world.stats.spentBy },
  };
  const revert = () => {
    pl.p = oldP;
    world.zones.gates = saved.gates;
    rebuildZones(world);
    for (const [idx, func, fs] of saved.funcs) { world.buildings[idx].func = func; world.buildings[idx].funcState = fs; }
    refreshFunctions(world);
    world.budget.spent = saved.spent;
    saved.owners.forEach((s, o) => { world.budget.owners[o].spent = s; });
    world.stats.spentBy = saved.by;
  };
  pl.p = Array.from(p, (v) => Math.round(v * 10) / 10);
  rebuildZones(world);
  let reason = '';
  if (pl.comp < 0) reason = 'Too small';
  else if (world.zones.comps.length > zcfg.maxZones) reason = `At most ${zcfg.maxZones} safe zones`;
  else if (world.zoneLand > zcfg.maxLandFrac * world.region.landCells) reason = `Zones may cover at most ${Math.round(zcfg.maxLandFrac * 100)}% of the land`;
  else if (world.owners > 1 && world.zones.comps[pl.comp].polys.some((id) => world.zones.polys[findById(world.zones.polys, id)].owner !== owner)) reason = "Touches your partner's zone";
  const cost = Math.round(pl.base + polyPerimeter(pl.p) * world.cfg.wall.perM);
  const delta = cost - pl.paid;
  if (!reason && delta > 0 && !canAfford(world, delta, owner)) reason = 'Not enough money';
  if (reason || !apply) { revert(); return reason ? { ok: false, reason, cost: delta } : { ok: true, cost: delta }; }
  spend(world, delta, owner, 'zone');
  pl.paid = cost;
  return { ok: true, id: pl.id, cost: delta };
}

function zoneUpgradeQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const comp = world.zones.comps[cmd.compId ?? cmd.id];
  if (!comp) return fail('No such zone');
  if (!own(world, comp, cmd.owner | 0)) return fail("That is your partner's zone");
  const lv = comp.wallLevel, costs = world.cfg.wall.levelCost;
  if (lv >= world.cfg.wall.levelHpMul.length) return fail('Walls are at the top level');
  const cost = costs[lv] || 0;
  if (!canAfford(world, cost, comp.owner)) return { ok: false, reason: 'Not enough money', cost };
  return { ok: true, cost };
}

function zoneUpgrade(world, cmd, q) {
  const comp = world.zones.comps[cmd.compId ?? cmd.id];
  const before = levelMul(world, comp.wallLevel);
  comp.wallLevel++;
  const after = levelMul(world, comp.wallLevel);
  let firstPoly = null;
  for (const pl of world.zones.polys) if (pl.comp === comp.id) { pl.level = comp.wallLevel; if (!firstPoly) firstPoly = pl; }
  if (firstPoly) firstPoly.upPaid += q.cost;
  const hp = world.wallHp, ratio = after / before;
  for (const c of comp.wallCells) if (world.block[c] === 1 && hp[c] > 0) hp[c] *= ratio;
  for (const gt of world.zones.gates) if (gt.comp === comp.id) {
    gt.hpMax = world.cfg.gate.hp * after;
    if (gt.hp > 0) gt.hp = gt.hp * ratio;
    for (const c of gt.cells) hp[c] = gt.hp;
  }
  spend(world, q.cost, comp.owner, 'wallUpgrade');
  return { ok: true, level: comp.wallLevel, cost: q.cost };
}

function gateAddQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const c0 = nearestZoneWallCell(world, +cmd.x, +cmd.y, 3);
  if (c0 < 0) return fail('Place gates on a safe-zone wall');
  const comp = world.zones.comps[world.zoneComp[c0] - 1];
  if (!own(world, comp, cmd.owner | 0)) return fail('Gates go on your own walls');
  const cells = gateCellsAt(world, c0);
  for (const c of cells) if (world.block[c] === 3) return fail('There is already a gate here');
  const cost = world.cfg.gate.cost;
  if (!canAfford(world, cost, cmd.owner | 0)) return { ok: false, reason: 'Not enough money', cost };
  return { ok: true, cost, c0, cells, comp: comp.id };
}

function gateAdd(world, cmd, q) {
  const g = world.grid, comp = world.zones.comps[q.comp];
  const hpMax = world.cfg.gate.hp * levelMul(world, comp.wallLevel);
  const id = world.nextId();
  const gt = { id, x: (q.c0 % g.gw + 0.5) * g.cell, y: (((q.c0 / g.gw) | 0) + 0.5) * g.cell, comp: q.comp, cells: Int32Array.from(q.cells), hp: hpMax, hpMax, owner: cmd.owner | 0, paid: q.cost };
  world.zones.gates.push(gt);
  rebuildBlocks(world);
  touchNav(world);
  spend(world, q.cost, gt.owner, 'gate');
  return { ok: true, id, cost: q.cost };
}

function simpleRemoveQuote(list, label) {
  return (world, cmd) => {
    if (!phaseOk(world)) return fail('Stage is over');
    const k = findById(list(world), cmd.id);
    if (k < 0) return fail(`No such ${label}`);
    if (!own(world, list(world)[k], cmd.owner | 0)) return fail(`That ${label} belongs to your partner`);
    return { ok: true, cost: 0, refund: world.refundValue(list(world)[k].paid) };
  };
}

function gateRemove(world, cmd) {
  const k = findById(world.zones.gates, cmd.id);
  const got = refundPlacement(world, world.zones.gates[k], 'gate');
  world.zones.gates.splice(k, 1);
  rebuildBlocks(world);
  touchNav(world);
  return { ok: true, refund: got };
}

function wallCells(world, p) {
  const g = world.grid, mask = world.region.mask, set = new Set();
  rasterPolyline(p, g.cell * 1.5, g.cell, g.gw, g.gh, (c) => { if (mask[c]) set.add(c); });
  return Int32Array.from([...set].sort((a, b) => a - b));
}

function wallAddQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const p = cmd.p;
  if (!isFlat(p) || p.length < 4 || p.length % 2) return fail('Draw at least two points');
  if (!vertsInside(world, p)) return fail('Must be inside the stage boundary');
  const len = polyPerimeter(p, false);
  if (len < world.grid.cell) return fail('Too short');
  const left = standaloneLimit(world) - standaloneLen(world);
  if (len > left + 1e-6) return fail(`Wall limit: ${Math.max(0, Math.floor(left))} m left`);
  const wc = world.cfg.wall;
  const cost = Math.round(wc.baseCost + wc.perM * len);
  if (!canAfford(world, cost, cmd.owner | 0)) return { ok: false, reason: 'Not enough money', cost };
  return { ok: true, cost, len };
}

function wallAdd(world, cmd, q) {
  const p = Array.from(cmd.p, (v) => Math.round(v * 10) / 10);
  const cells = wallCells(world, p);
  if (!cells.length) return fail('Nothing to build here');
  const id = world.nextId();
  world.walls.push({ id, p, cells, len: q.len, owner: cmd.owner | 0, paid: q.cost });
  rebuildBlocks(world);
  touchNav(world);
  spend(world, q.cost, cmd.owner | 0, 'wall');
  return { ok: true, id, cost: q.cost };
}

function wallRemove(world, cmd) {
  const k = findById(world.walls, cmd.id);
  const got = refundPlacement(world, world.walls[k], 'wall');
  world.walls.splice(k, 1);
  rebuildBlocks(world);
  touchNav(world);
  return { ok: true, refund: got };
}

function corridorQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const cc = world.cfg.corridor;
  const x0 = +cmd.x0, y0 = +cmd.y0, x1 = +cmd.x1, y1 = +cmd.y1;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return fail('Drag from tail to head');
  const w = clamp(Number.isFinite(+cmd.w) && cmd.w ? +cmd.w : cc.defaultWidth, cc.minWidth, cc.maxWidth);
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 8) return fail('Too short');
  if (!vertsInside(world, [x0, y0, x1, y1])) return fail('Must be inside the stage boundary');
  const cost = Math.round(cc.baseCost + L * w * cc.perM2);
  if (!canAfford(world, cost, cmd.owner | 0)) return { ok: false, reason: 'Not enough money', cost };
  return { ok: true, cost, w };
}

function corridorAdd(world, cmd, q) {
  const r = (v) => Math.round(v * 10) / 10;
  const id = world.nextId();
  world.corridors.push({ id, x0: r(+cmd.x0), y0: r(+cmd.y0), x1: r(+cmd.x1), y1: r(+cmd.y1), w: q.w, owner: cmd.owner | 0, paid: q.cost });
  rebuildFeatureGrids(world);
  spend(world, q.cost, cmd.owner | 0, 'corridor');
  return { ok: true, id, cost: q.cost };
}

function corridorRemove(world, cmd) {
  const k = findById(world.corridors, cmd.id);
  const got = refundPlacement(world, world.corridors[k], 'corridor');
  world.corridors.splice(k, 1);
  world._releaseCivs(4);
  rebuildFeatureGrids(world);
  return { ok: true, refund: got };
}

function holdQuote(world, cmd) {
  if (!phaseOk(world)) return fail('Stage is over');
  const hc = world.cfg.hold;
  const x = +cmd.x, y = +cmd.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('Drag out a radius');
  const R = clamp(+cmd.R || hc.minR, hc.minR, hc.maxR);
  if (!pointInPoly(world.region.poly, x, y)) return fail('Must be inside the stage boundary');
  const cost = Math.round(hc.baseCost + Math.PI * R * R * hc.perM2);
  if (!canAfford(world, cost, cmd.owner | 0)) return { ok: false, reason: 'Not enough money', cost };
  return { ok: true, cost, R };
}

function holdAdd(world, cmd, q) {
  const id = world.nextId();
  const R = Math.round(q.R * 10) / 10;
  world.holds.push({ id, x: Math.round(+cmd.x * 10) / 10, y: Math.round(+cmd.y * 10) / 10, R, r: R * world.cfg.hold.innerFrac, owner: cmd.owner | 0, paid: q.cost });
  rebuildFeatureGrids(world);
  spend(world, q.cost, cmd.owner | 0, 'hold');
  return { ok: true, id, cost: q.cost };
}

function holdRemove(world, cmd) {
  const k = findById(world.holds, cmd.id);
  const got = refundPlacement(world, world.holds[k], 'hold');
  world.holds.splice(k, 1);
  world._releaseCivs(3);
  rebuildFeatureGrids(world);
  return { ok: true, refund: got };
}

export function registerZoneCommands(world) {
  const reg = (name, quote, exec) => world.registerCommand(name, { quote, exec });
  reg('zone.add', zoneAddQuote, zoneAdd);
  reg('zone.remove', zoneRemoveQuote, zoneRemove);
  reg('zone.move', (w, c) => zoneMoveEval(w, c, false), (w, c) => zoneMoveEval(w, c, true));
  reg('zone.upgrade', zoneUpgradeQuote, zoneUpgrade);
  reg('gate.add', gateAddQuote, gateAdd);
  reg('gate.remove', simpleRemoveQuote((w) => w.zones.gates, 'gate'), gateRemove);
  reg('wall.add', wallAddQuote, wallAdd);
  reg('wall.remove', simpleRemoveQuote((w) => w.walls, 'wall'), wallRemove);
  reg('corridor.add', corridorQuote, corridorAdd);
  reg('corridor.remove', simpleRemoveQuote((w) => w.corridors, 'corridor'), corridorRemove);
  reg('hold.add', holdQuote, holdAdd);
  reg('hold.remove', simpleRemoveQuote((w) => w.holds, 'hold'), holdRemove);
}

// ---------------------------------------------------------------- persistence
export function savePlacements(world) {
  const cp = (o) => JSON.parse(JSON.stringify(o));
  return {
    polys: world.zones.polys.map((pl) => ({ id: pl.id, p: pl.p.slice(), owner: pl.owner, paid: pl.paid, base: pl.base, level: pl.level, upPaid: pl.upPaid })),
    gates: world.zones.gates.map((gt) => ({ id: gt.id, x: gt.x, y: gt.y, owner: gt.owner, paid: gt.paid })),
    walls: world.walls.map((w) => ({ id: w.id, p: w.p.slice(), len: w.len, owner: w.owner, paid: w.paid })),
    corridors: cp(world.corridors),
    holds: cp(world.holds),
  };
}

export function loadPlacements(world, d) {
  world.zones.polys = (d.polys || []).map((pl) => ({ ...pl, p: pl.p.slice(), breached: false, comp: -1 }));
  world.zones.gates = (d.gates || []).map((gt) => ({ ...gt, comp: -1, cells: new Int32Array(0), hp: 0, hpMax: 0 }));
  world.walls = (d.walls || []).map((w) => ({ ...w, p: w.p.slice(), cells: wallCells(world, w.p) }));
  world.corridors = (d.corridors || []).map((c) => ({ ...c }));
  world.holds = (d.holds || []).map((h) => ({ ...h }));
}
