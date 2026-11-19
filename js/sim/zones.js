// Safe zones (union-of-polygons components), gates, standalone walls, corridors and holds.
import { T } from '../map/format.js';
import { rasterPoly, rasterSegCover, unionBoundary, polyArea, polyPerimeter, pointInPoly, clamp } from '../util/geom.js';
import { updatePassCells, touchNav, buildCorridorField, corridorContains, corridorBBox, isWalkTerrain } from './nav.js';
import { canAfford, spend, refundPlacement } from './economy.js';
import { refreshFunctions } from './structures.js';
import { TIERS, nodeAt, stepField } from './decks.js';

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
  // wall geometry: each wall/gate cell points at the true segment through it (-1 none, -2 several: solid cell)
  world.wallSeg = new Int32Array(N).fill(-1);
  world.wallSegs = new Float64Array(0);      // per segment: ax, ay, ux, uy, length
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
// A component is the union of touching polygons. Its wall is the supercover of the union's boundary segments
// (a 4-connected band that every point of the drawn line falls in); interior = cells with their centre inside, minus the band.
export function rebuildZones(world) {
  const g = world.grid, gw = g.gw, gh = g.gh, mask = world.region.mask, cs = g.cell;
  const zc = world.zoneComp, zi = world.zoneId;
  for (const c of world._unionCells) { zc[c] = 0; zi[c] = 0; }
  const union = world._tmpKind;
  const polys = world.zones.polys;
  const first = new Int32Array(polys.length).fill(-1);
  const all = [];
  for (let k = 0; k < polys.length; k++) {
    rasterPoly(polys[k].p, cs, gw, gh, (c) => {
      if (!mask[c]) return;
      if (first[k] < 0) first[k] = c;
      if (!union[c]) all.push(c);
      union[c] |= 1;
    });
  }
  const segs = unionBoundary(polys.map((pl) => pl.p));
  for (let s = 0; s < segs.length; s += 4) {
    rasterSegCover(segs[s], segs[s + 1], segs[s + 2], segs[s + 3], cs, gw, gh, (c) => { if (!union[c]) all.push(c); union[c] |= 2; });
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
    let sx = 0, sy = 0, nu = 0;
    for (const c of cells) {
      const u = union[c];
      if (u === 1) { interiorCells.push(c); zi[c] = id; } else wallCells.push(c);
      if (u & 1) { nu++; sx += c % gw; sy += (c / gw) | 0; if (g.terrain[c] !== T.WATER) land++; }
    }
    if (!nu) { for (const c of cells) { sx += c % gw; sy += (c / gw) | 0; } nu = cells.length; }
    comps.push({
      id: id - 1, cells: Int32Array.from(cells), wallCells: Int32Array.from(wallCells), interiorCells: Int32Array.from(interiorCells),
      breached: false, wallLevel: 1, owner: 0, bldgs: [], polys: [], segs: null,
      cx: (sx / nu + 0.5) * cs, cy: (sy / nu + 0.5) * cs,
    });
  }
  for (const c of all) union[c] = 0;
  world._unionCells = Int32Array.from(all);
  world.zoneLand = land;

  // true boundary segments [ax,ay,bx,by,...] per component
  const per = comps.map(() => []);
  for (let s = 0; s < segs.length; s += 4) {
    const c = world.cellAt((segs[s] + segs[s + 2]) * 0.5, (segs[s + 1] + segs[s + 3]) * 0.5);
    const k = c >= 0 ? zc[c] - 1 : -1;
    if (k >= 0) per[k].push(segs[s], segs[s + 1], segs[s + 2], segs[s + 3]);
  }
  comps.forEach((comp, k) => { comp.segs = Float64Array.from(per[k]); });

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

// Closest point on any zone's true boundary within maxD of (x,y).
function nearestEdge(world, x, y, maxD) {
  let best = null, bd = maxD * maxD;
  for (const comp of world.zones.comps) {
    const S = comp.segs;
    for (let s = 0; s < S.length; s += 4) {
      const ax = S[s], ay = S[s + 1], dx = S[s + 2] - ax, dy = S[s + 3] - ay, l2 = dx * dx + dy * dy;
      if (l2 < 1e-9) continue;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1), px = ax + dx * t, py = ay + dy * t;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bd) { bd = d; best = { comp: comp.id, s, t, L: Math.sqrt(l2) }; }
    }
  }
  return best;
}

// A gate centred on the true edge: kept on one straight segment when it fits; its cells are the comp's band cells within half a gate width.
function gateGeom(world, e) {
  const comp = world.zones.comps[e.comp], S = comp.segs, s = e.s, g = world.grid, cs = g.cell;
  const ax = S[s], ay = S[s + 1], ux = (S[s + 2] - ax) / e.L, uy = (S[s + 3] - ay) / e.L;
  const hw = world.cfg.gate.width * 0.5;
  let t = e.t * e.L;
  if (e.L >= 2 * hw) t = clamp(t, hw, e.L - hw);
  const x = ax + ux * t, y = ay + uy * t;
  const t0 = Math.max(0, t - hw), t1 = Math.min(e.L, t + hw);
  const id1 = comp.id + 1, out = [];
  const rc = Math.ceil(hw / cs) + 1, cx0 = Math.floor(x / cs), cy0 = Math.floor(y / cs);
  for (let cy = Math.max(0, cy0 - rc); cy <= Math.min(g.gh - 1, cy0 + rc); cy++) for (let cx = Math.max(0, cx0 - rc); cx <= Math.min(g.gw - 1, cx0 + rc); cx++) {
    const c = cy * g.gw + cx;
    if (world.zoneComp[c] !== id1 || world.zoneId[c]) continue;
    const qx = clamp(x, cx * cs, (cx + 1) * cs) - x, qy = clamp(y, cy * cs, (cy + 1) * cs) - y;
    if (qx * qx + qy * qy <= hw * hw) out.push(c);
  }
  out.sort((a, b) => a - b);
  return { comp: comp.id, x, y, x0: ax + ux * t0, y0: ay + uy * t0, x1: ax + ux * t1, y1: ay + uy * t1, cells: out };
}

// Does a gate with these cells join walkable ground inside the zone to open ground outside? A BFS of about 150 cells.
const OPEN_MIN = 150;
export function gateOpening(world, comp, cells) {
  if (world.grid.deck) return gateOpeningT(world, comp, cells);
  const g = world.grid, gw = g.gw, terr = g.terrain, mask = world.region.mask, id1 = comp + 1;
  const walk = (c) => mask[c] === 1 && isWalkTerrain(terr[c]);
  const free = (c) => walk(c) && !world.zoneComp[c] && !(world.block[c] && world.wallHp[c] > 0);
  const N = gw * g.gh;
  if (!world._gateMark || world._gateMark.length !== N) { world._gateMark = new Uint32Array(N); world._gateGen = 0; }
  const mark = world._gateMark, gen = ++world._gateGen;
  const gate = new Set();
  for (const c of cells) if (walk(c)) gate.add(c);
  if (!gate.size) return { ok: false, inside: false, outside: false, reason: 'The gate opens into a building' };
  const q = [];
  for (const c of gate) {
    for (const n of [c - 1, c + 1, c - gw, c + gw]) if (world.zoneId[n] === id1 && walk(n)) { mark[c] = gen; q.push(c); break; }
  }
  if (!q.length) return { ok: false, inside: false, outside: false, reason: 'Buildings block the gate on the inside' };
  const seeds = [];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const n of [c - 1, c + 1, c - gw, c + gw]) {
      if (mark[n] === gen) continue;
      if (gate.has(n)) { mark[n] = gen; q.push(n); } else if (free(n)) { mark[n] = gen; seeds.push(n); }
    }
  }
  if (!seeds.length) return { ok: false, inside: true, outside: false, reason: 'The gate opens onto a building' };
  // open ground touching the gate on the outside, in cells: one cell of a 12 m gate lets people through only in single file
  const approach = seeds.length, narrow = approach * g.cell < world.cfg.gate.width * 0.5;
  let h = 0;
  for (; h < seeds.length && h < OPEN_MIN; h++) {
    const c = seeds[h];
    for (const m of [c - 1, c + 1, c - gw, c + gw]) if (mark[m] !== gen && free(m)) { mark[m] = gen; seeds.push(m); }
  }
  const outside = h >= OPEN_MIN;
  return { ok: outside, inside: true, outside, width: gate.size, approach, narrow: outside && narrow,
    reason: !outside ? 'The gate opens onto a closed yard' : narrow ? 'Most of the gate faces a building' : '' };
}

// gateOpening on a map with decks: the gate blocks every tier of its cells, so each tier it crosses is checked (the
// flood follows deck links and ramps) and the one that opens best is the answer.
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function gateOpeningT(world, comp, cells) {
  const g = world.grid, dk = g.deck, N = dk.N, terr = g.terrain, mask = world.region.mask, id1 = comp + 1, br = world.bridges;
  const gr = (f) => (f < N ? f : dk.cell[f - N]);
  const walk = (f) => {
    if (f < 0) return false;
    if (f < N) return mask[f] === 1 && isWalkTerrain(terr[f]);
    const sid = dk.sid[f - N];
    return mask[dk.cell[f - N]] === 1 && !(sid >= 0 && br && br[sid] && br[sid].alive === false);
  };
  const free = (f) => { const c = gr(f); return walk(f) && !world.zoneComp[c] && !(world.block[c] && world.wallHp[c] > 0); };
  const NN = N + dk.D;
  if (!world._gateMark || world._gateMark.length !== NN) { world._gateMark = new Uint32Array(NN); world._gateGen = 0; }
  const mark = world._gateMark, near = (f, out) => { out.length = 0; for (const [dx, dy] of SIDES) { const n = stepField(dk, f, dx, dy); if (n >= 0) out.push(n); } return out; };
  const nb = [], nb2 = [];
  let best = null, bs = -1;
  for (const t of [0, ...TIERS]) {
    const gen = ++world._gateGen, gate = new Set();
    for (const c of cells) { const f = t === 0 ? c : nodeAt(dk, t, c % g.gw, (c / g.gw) | 0); if (walk(f)) gate.add(f); }
    if (!gate.size) { if (t === 0) { best = { ok: false, inside: false, outside: false, reason: 'The gate opens into a building' }; bs = 0; } continue; }
    let o = null;
    const q = [];
    for (const f of gate) for (const n of near(f, nb)) if (world.zoneId[gr(n)] === id1 && walk(n)) { mark[f] = gen; q.push(f); break; }
    if (!q.length) o = { ok: false, inside: false, outside: false, reason: 'Buildings block the gate on the inside' };
    const seeds = [];
    for (let h = 0; !o && h < q.length; h++) {
      for (const n of near(q[h], nb)) {
        if (mark[n] === gen) continue;
        if (gate.has(n)) { mark[n] = gen; q.push(n); } else if (free(n)) { mark[n] = gen; seeds.push(n); }
      }
    }
    if (!o && !seeds.length) o = { ok: false, inside: true, outside: false, reason: 'The gate opens onto a building' };
    if (!o) {
      const approach = seeds.length, narrow = approach * g.cell < world.cfg.gate.width * 0.5;
      let h = 0;
      for (; h < seeds.length && h < OPEN_MIN; h++) for (const m of near(seeds[h], nb2)) if (mark[m] !== gen && free(m)) { mark[m] = gen; seeds.push(m); }
      const outside = h >= OPEN_MIN;
      o = { ok: outside, inside: true, outside, width: gate.size, approach, narrow: outside && narrow,
        reason: !outside ? 'The gate opens onto a closed yard' : narrow ? 'Most of the gate faces a building' : '' };
    }
    const sc = o.ok ? 2 + (o.narrow ? 0 : 1e6) + o.approach * 1000 + o.width : o.inside ? 1 : 0;
    if (sc > bs) { best = o; bs = sc; }
  }
  return best;
}

// Where a gate clicked at (x,y) goes: the nearest spot on the true wall within 12 m; when that spot opens onto
// nothing walkable, the spot within 12 m of the click with the widest real opening. `opens`/`warn` say how it ended up.
export function gateSpot(world, x, y, owner = 0) {
  const maxD = world.grid.cell * 3;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'Place gates on a safe-zone wall' };
  const e = nearestEdge(world, x, y, maxD);
  if (!e) return { ok: false, reason: 'Place gates on a safe-zone wall' };
  if (!own(world, world.zones.comps[e.comp], owner)) return { ok: false, reason: 'Gates go on your own walls' };
  let best = gateGeom(world, e), open = gateOpening(world, best.comp, best.cells);
  if (!open.ok || open.narrow) {
    const cand = [];
    for (const comp of world.zones.comps) {
      if (!own(world, comp, owner)) continue;
      const S = comp.segs;
      for (let s = 0; s < S.length; s += 4) {
        const ax = S[s], ay = S[s + 1], dx = S[s + 2] - ax, dy = S[s + 3] - ay, L = Math.sqrt(dx * dx + dy * dy);
        if (L < 1e-6) continue;
        for (let d = 0; d <= L; d += 2) {
          const px = ax + dx * d / L, py = ay + dy * d / L, dd = (px - x) * (px - x) + (py - y) * (py - y);
          if (dd <= maxD * maxD) cand.push([dd, comp.id, s, d / L, L]);
        }
      }
    }
    cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
    const score = (o) => (o.ok ? 1 + (o.narrow ? 0 : 1e6) + o.approach * 1000 + o.width : 0);
    let bw = score(open);
    for (const [, comp, s, t, L] of cand) {
      const gg = gateGeom(world, { comp, s, t, L });
      const o = gateOpening(world, comp, gg.cells), sc = score(o);
      if (sc > bw) { best = gg; open = o; bw = sc; }
    }
  }
  return { ok: true, ...best, opens: open.ok, warn: open.reason };
}

// Checks an existing gate (by id) or a prospective one (by point): { opens, warn, x, y } — cheap enough for a cursor preview.
export function gateCheck(world, idOrX, y, owner = 0) {
  if (y === undefined) {
    const gt = world.zones.gates.find((q) => q.id === idOrX);
    if (!gt) return { ok: false, opens: false, warn: 'No such gate' };
    const o = gateOpening(world, gt.comp, gt.cells);
    return { ok: true, opens: o.ok, warn: o.reason, x: gt.x, y: gt.y };
  }
  return gateSpot(world, +idOrX, +y, owner);
}

function resnapGates(world) {
  const keep = [];
  const gcfg = world.cfg.gate;
  for (const gt of world.zones.gates) {
    const e = nearestEdge(world, gt.x, gt.y, world.grid.cell * 2);
    if (!e) { refundPlacement(world, gt, 'gate'); continue; }
    const comp = world.zones.comps[e.comp];
    if (!own(world, comp, gt.owner)) { refundPlacement(world, gt, 'gate'); continue; }
    const gg = gateGeom(world, e);
    gt.comp = comp.id;
    gt.cells = Int32Array.from(gg.cells);
    gt.x0 = gg.x0; gt.y0 = gg.y0; gt.x1 = gg.x1; gt.y1 = gg.y1;
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
  rebuildWallSegs(world, old);
  updatePassCells(world, old);
  updatePassCells(world, world._blockCells);
  if (world._onBlocks) world._onBlocks();
}

// Per-cell references to the true wall segments (standalone polylines and zone boundaries).
function rebuildWallSegs(world, old) {
  const ws = world.wallSeg, g = world.grid, cs = g.cell, mask = world.region.mask;
  for (let k = 0; k < old.length; k++) ws[old[k]] = -1;
  const S = [];
  const add = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-6) return -1;
    S.push(ax, ay, dx / L, dy / L, L);
    return S.length / 5 - 1;
  };
  const same = (a, b) => {
    const ka = a * 5, kb = b * 5;
    if (Math.abs(S[ka + 2] * S[kb + 3] - S[ka + 3] * S[kb + 2]) > 1e-6) return false;
    return Math.abs((S[kb] - S[ka]) * S[ka + 3] - (S[kb + 1] - S[ka + 1]) * S[ka + 2]) < 1e-3;
  };
  const ref = (c, id) => { const r = ws[c]; if (r === -1) ws[c] = id; else if (r >= 0 && r !== id && !same(r, id)) ws[c] = -2; };
  for (const w of world.walls) {
    const p = w.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const id = add(p[i], p[i + 1], p[i + 2], p[i + 3]);
      if (id >= 0) rasterSegCover(p[i], p[i + 1], p[i + 2], p[i + 3], cs, g.gw, g.gh, (c) => { if (mask[c]) ref(c, id); });
    }
  }
  for (const comp of world.zones.comps) {
    const P = comp.segs, id1 = comp.id + 1;
    for (let s = 0; s < P.length; s += 4) {
      const id = add(P[s], P[s + 1], P[s + 2], P[s + 3]);
      if (id >= 0) rasterSegCover(P[s], P[s + 1], P[s + 2], P[s + 3], cs, g.gw, g.gh, (c) => { if (world.zoneComp[c] === id1) ref(c, id); });
    }
  }
  world.wallSegs = Float64Array.from(S);
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
  const touch = (c) => {
    const X = c % gw, Y = (c / gw) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = X + dx, ny = Y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= g.gh) continue;
      const z = world.zoneComp[ny * gw + nx];
      if (z) touched.add(z - 1);
    }
  };
  rasterPoly(p, g.cell, gw, g.gh, (c) => {
    if (!mask[c]) return;
    cells++;
    if (world.zoneComp[c]) { touched.add(world.zoneComp[c] - 1); return; }
    if (g.terrain[c] !== T.WATER) newLand++;
    touch(c);
  });
  // rebuildZones also floods the wall band along the edges, so zones a few metres apart still merge
  for (let i = 0, n = p.length; i < n; i += 2) rasterSegCover(p[i], p[i + 1], p[(i + 2) % n], p[(i + 3) % n], g.cell, gw, g.gh, touch);
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
  const sp = gateSpot(world, +cmd.x, +cmd.y, cmd.owner | 0);
  if (!sp.ok) return fail(sp.reason);
  if (!sp.cells.length) return fail('Place gates on a safe-zone wall');
  for (const c of sp.cells) if (world.block[c] === 3) return fail('There is already a gate here');
  const cost = world.cfg.gate.cost;
  if (!canAfford(world, cost, cmd.owner | 0)) return { ok: false, reason: 'Not enough money', cost, x: sp.x, y: sp.y, opens: sp.opens, warn: sp.warn };
  return { ...sp, ok: true, cost };
}

function gateAdd(world, cmd, q) {
  const comp = world.zones.comps[q.comp];
  const hpMax = world.cfg.gate.hp * levelMul(world, comp.wallLevel);
  const id = world.nextId();
  const gt = { id, x: q.x, y: q.y, x0: q.x0, y0: q.y0, x1: q.x1, y1: q.y1, comp: q.comp, cells: Int32Array.from(q.cells), hp: hpMax, hpMax, owner: cmd.owner | 0, paid: q.cost };
  world.zones.gates.push(gt);
  rebuildBlocks(world);
  touchNav(world);
  spend(world, q.cost, gt.owner, 'gate');
  return { ok: true, id, cost: q.cost, opens: q.opens, warn: q.warn };
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
  for (let i = 0; i + 3 < p.length; i += 2) rasterSegCover(p[i], p[i + 1], p[i + 2], p[i + 3], g.cell, g.gw, g.gh, (c) => { if (mask[c]) set.add(c); });
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
