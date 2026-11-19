// What is under the cursor, in click order: builds (units, gates, walls, hold and corridor handles) first, then troops,
// the building, corridor and hold areas, the zone, a bridge, rubble. DOM-free, so test/picking.mjs checks the order.
import { distToPolyline, distToSeg, pointInPoly, polyCentroid } from '../util/geom.js';

const M_ARMED = (1 << 4) | (1 << 5) | (1 << 6);
const ALL_TIERS = 100;   // world.query's TIER_ALL (kept as a number so this module stays free of sim imports)
// Hit radii: px on screen, never smaller than the metres given (a gate's posts reach 6 m either side of the wall).
export const HIT = { unitPx: 12, unitM: 3, gatePx: 9, gateM: 6, wallPx: 8, linePx: 8, lineM: 2, troopPx: 9, troopM: 3, vehPx: 12 };
// A second click within this distance and time of the last one takes the next thing under the cursor.
export const AGAIN = { px: 6, sec: 1 };
export const TIP_SEC = 0.15;   // the hover tooltip appears once the pointer has rested this long
export const TIER = { build: 0, troop: 1, building: 2, area: 3, zone: 4, bridge: 5, rubble: 6 };
const ROOF = 0.6;      // a click anywhere on a manned roof scores this, as if it were 60% of the way out from the glyph
const PARTNER = 1;     // a partner's build sorts after every own build

export function corridorHit(co, x, y) {
  const dx = co.x1 - co.x0, dy = co.y1 - co.y0, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, px = x - co.x0, py = y - co.y0;
  const a = px * ux + py * uy, b = -px * uy + py * ux;
  return a >= 0 && a <= L && Math.abs(b) <= co.w * 0.5;
}

function gridBuilding(world, x, y, dead) {
  const c = world.cellAt(x, y);
  if (c < 0) return -1;
  const b = world.grid.bldg[c] - 1;
  return b >= 0 && world.buildings[b] && (dead || world.buildings[b].alive) ? b : -1;
}

// Ordered candidates under world point (wx, wy): [{ kind, key, tier, d, ... }], d is 0 at the centre and 1 at the edge.
// o: { zoom, owner, builds, troops, rest (building, areas, zone, bridge, rubble), mine (own items only), units (units only),
//      filter (unit => bool), boats (boat vehicles in the troop tier), zonePolys (zone polygons instead of zones),
//      pickBuilding(x, y, dead), pickBridge(x, y) }
export function pickList(world, wx, wy, o = {}) {
  const z = o.zoom || 1, owner = o.owner | 0, coop = world.owners > 1, out = [];
  const builds = o.builds !== false, troops = o.troops !== false && !o.units, rest = o.rest !== false && !o.units;
  const theirs = (it) => coop && (it.owner | 0) !== owner;
  const skip = (it) => o.mine && theirs(it);
  const bat = o.pickBuilding || ((x, y, dead) => gridBuilding(world, x, y, dead));
  const foot = bat(wx, wy, false);
  if (builds) {
    const Ru = Math.max(HIT.unitM, HIT.unitPx / z), Rl = Math.max(HIT.lineM, HIT.linePx / z);
    const brush = new Map(), R2 = Ru * Ru;
    for (const u of world.units || []) {
      if (!u || u.alive === false) continue;
      if (!u.p && !u.veh && !(u.bridge >= 0) && (u.b < 0 || u.b !== foot) && (u.x - wx) ** 2 + (u.y - wy) ** 2 > R2) continue;
      if (skip(u) || (o.filter && !o.filter(u))) continue;
      const def = world.cfg.units[u.type] || {};
      let d;
      if (u.p) d = distToPolyline(u.p, wx, wy) / Rl;
      else {
        let R = Ru;
        if (u.veh) R = Math.max(R, (u.veh.selR || 8) + 2);
        else if (u.bridge >= 0 && def.manual) R += 8;
        const ux = u.veh ? u.veh.x : u.x, uy = u.veh ? u.veh.y : u.y;
        d = Math.hypot(ux - wx, uy - wy) / R;
        if (u.b >= 0 && u.b === foot) d = Math.min(d, ROOF + (def.manual ? 0.001 : 0));
      }
      if (!(d <= 1)) continue;
      if (theirs(u)) d += PARTNER;
      const c = { kind: 'unit', id: u.id, key: 'u' + u.id, tier: TIER.build, d, b: u.b };
      if (def.mount === 'brush') {
        const k = brush.get(u.type);
        if (!k || d < k.d) brush.set(u.type, c);
        continue;
      }
      out.push(c);
    }
    for (const c of brush.values()) out.push(c);
    if (!o.units) {
      const Rg = Math.max(HIT.gateM, HIT.gatePx / z);
      for (const g of (world.zones && world.zones.gates) || []) {
        if (skip(g)) continue;
        let d = (Number.isFinite(g.x0) ? distToSeg(wx, wy, g.x0, g.y0, g.x1, g.y1) : Math.hypot(g.x - wx, g.y - wy)) / Rg;
        if (!(d <= 1)) continue;
        if (theirs(g)) d += PARTNER;
        out.push({ kind: 'gate', id: g.id, key: 'g' + g.id, tier: TIER.build, d });
      }
      const cell = (world.grid && world.grid.cell) || 2;
      const Rw = Math.max(HIT.wallPx / z, cell * 0.53 + 3 / z);
      for (const wl of world.walls || []) {
        if (skip(wl) || !wl.p) continue;
        let d = distToPolyline(wl.p, wx, wy) / Rw;
        if (!(d <= 1)) continue;
        if (theirs(wl)) d += PARTNER;
        out.push({ kind: 'wall', id: wl.id, key: 'w' + wl.id, tier: TIER.build, d });
      }
      // the centre marks of hold points and corridors are handles, like a unit's glyph
      for (const ho of world.holds || []) {
        if (skip(ho)) continue;
        const d = Math.hypot(ho.x - wx, ho.y - wy) / Ru;
        if (d <= 1) out.push({ kind: 'hold', id: ho.id, key: 'h' + ho.id, tier: TIER.build, d: d + (theirs(ho) ? PARTNER : 0) });
      }
      for (const co of world.corridors || []) {
        if (skip(co)) continue;
        const d = Math.hypot((co.x0 + co.x1) / 2 - wx, (co.y0 + co.y1) / 2 - wy) / Ru;
        if (d <= 1) out.push({ kind: 'corridor', id: co.id, key: 'c' + co.id, tier: TIER.build, d: d + (theirs(co) ? PARTNER : 0) });
      }
    }
  }
  if (troops) {
    const A = world.A, r = Math.max(HIT.troopM, HIT.troopPx / z), best = new Map();
    // on maps with decks: the squad on the highest tier first; in a tunnel only your own squads can be picked
    const TR = world.grid && world.grid.deck ? A.tier : null;
    if (A && A.n > 0 && world.sh) world.query(wx, wy, r, M_ARMED, (j, d2) => {
      const g = A.group[j];
      if (g < 0) return;
      const own = !coop || A.owner[j] === owner;
      if (TR && TR[j] < 0 && !own) return;
      const d = Math.max(0, Math.sqrt(d2) / r - (TR ? TR[j] * 0.25 : 0)), e = best.get(g);
      if (!e || d < e.d) best.set(g, { d, own });
    }, ALL_TIERS);
    for (const [g, e] of best) {
      if (e.own) out.push({ kind: 'troop', ref: 's' + g, group: g, key: 's' + g, tier: TIER.troop, d: e.d });
      else if (!o.mine) out.push({ kind: 'squad', group: g, key: 'q' + g, tier: TIER.troop, d: e.d + PARTNER });
    }
    for (const v of world.vehicles || []) {
      if (!v || v.alive === false || v.commandable !== true || v.offmap || (v.boat && !o.boats) || (coop && (v.owner | 0) !== owner)) continue;
      const d = Math.hypot(v.x - wx, v.y - wy) / Math.max(v.selR || 8, HIT.vehPx / z);
      if (d <= 1) out.push({ kind: 'troop', ref: 'v' + v.id, vid: v.id, key: 'v' + v.id, tier: TIER.troop, d });
    }
  }
  if (rest) {
    if (foot >= 0 && !o.mine) out.push({ kind: 'building', b: foot, key: 'b' + foot, tier: TIER.building, d: 0 });
    const seen = new Set(out.map((c) => c.key));
    for (const co of world.corridors || []) if (!skip(co) && !seen.has('c' + co.id) && corridorHit(co, wx, wy)) out.push({ kind: 'corridor', id: co.id, key: 'c' + co.id, tier: TIER.area, d: theirs(co) ? PARTNER : 0 });
    for (const ho of world.holds || []) {
      if (skip(ho) || seen.has('h' + ho.id)) continue;
      const d = Math.hypot(ho.x - wx, ho.y - wy) / (ho.R || 1);
      if (d <= 1) out.push({ kind: 'hold', id: ho.id, key: 'h' + ho.id, tier: TIER.area, d: d + (theirs(ho) ? PARTNER : 0) });
    }
    if (o.zonePolys) {
      const polys = (world.zones && world.zones.polys) || [];
      for (let k = polys.length - 1; k >= 0; k--) {
        const pl = polys[k];
        if (skip(pl) || !pointInPoly(pl.p, wx, wy)) continue;
        out.push({ kind: 'zonepoly', id: pl.id, key: 'p' + pl.id, tier: TIER.zone, d: theirs(pl) ? PARTNER : 0 });
        break;
      }
    } else if (!o.mine && world.zoneComp) {
      const c = world.cellAt(wx, wy);
      if (c >= 0 && world.zoneComp[c]) out.push({ kind: 'zone', comp: world.zoneComp[c] - 1, key: 'z' + (world.zoneComp[c] - 1), tier: TIER.zone, d: 0 });
    }
    if (!o.mine) {
      const br = o.pickBridge ? o.pickBridge(wx, wy) : null;
      if (br && br.id >= 0) out.push({ kind: 'bridge', id: br.id, road: br.road, key: 'r' + br.id, tier: TIER.bridge, d: 0 });
      if (foot < 0) {
        const dead = bat(wx, wy, true);
        if (dead >= 0) out.push({ kind: 'building', b: dead, key: 'b' + dead, tier: TIER.rubble, d: 0 });
      }
    }
  }
  out.sort((a, b) => a.tier - b.tier || a.d - b.d);
  return out;
}

// Index in `list` a click at (sx, sy) at time t picks: the next one after the last pick when clicked again on the spot,
// one further with Alt. last: { sx, sy, t, key } or null.
export function cycleIndex(list, last, sx, sy, t, alt = false) {
  if (!list.length) return -1;
  let i = 0;
  if (last && Math.hypot(sx - last.sx, sy - last.sy) <= AGAIN.px && t - last.t <= AGAIN.sec) {
    const k = list.findIndex((c) => c.key === last.key);
    i = k + 1;
  }
  if (alt) i++;
  return i % list.length;
}

// What the info card / map selection holds for a candidate (troops are selected by ref instead).
export function selOf(c) {
  if (!c) return null;
  switch (c.kind) {
    case 'unit': case 'gate': case 'wall': case 'corridor': case 'hold': return { kind: c.kind, id: c.id };
    case 'building': return { kind: 'building', b: c.b };
    case 'zone': return { kind: 'zone', comp: c.comp };
    case 'bridge': return { kind: 'bridge', id: c.id, road: c.road };
    case 'squad': case 'troop': return c.group !== undefined ? { kind: 'squad', group: c.group } : null;
    default: return null;
  }
}

// World point a refund marker sits on for a candidate.
export function anchorOf(world, c, wx, wy) {
  const find = (list, id) => (list || []).find((q) => q && q.id === id);
  switch (c.kind) {
    case 'unit': { const u = find(world.units, c.id); return u ? (u.veh ? [u.veh.x, u.veh.y] : [u.x, u.y]) : [wx, wy]; }
    case 'gate': { const g = find(world.zones.gates, c.id); return g ? [g.x, g.y] : [wx, wy]; }
    case 'corridor': { const co = find(world.corridors, c.id); return co ? [(co.x0 + co.x1) / 2, (co.y0 + co.y1) / 2] : [wx, wy]; }
    case 'hold': { const h = find(world.holds, c.id); return h ? [h.x, h.y] : [wx, wy]; }
    case 'zonepoly': { const pl = find(world.zones.polys, c.id); return pl ? polyCentroid(pl.p) : [wx, wy]; }
    default: return [wx, wy];
  }
}
