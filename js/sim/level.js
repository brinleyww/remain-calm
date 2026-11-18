// Stage lifecycle: begin (restore city, respawn civilians), READY (outbreak), win / lose / softlock, score and badge.
import { T } from '../map/format.js';
import { Rng, hash2, hashStr } from '../util/rng.js';
import { polyArea, polyBBox, pointInPoly, rectPoly, clamp } from '../util/geom.js';
import { P_ZOM, rebuildPass, computeFieldsNow, nearestPassable, isWalkTerrain } from './nav.js';
import { CIV, ZOMBIE, TURNING, POLICE, MILITIA, SOLDIER, CS, ZSUB, spawnAgent, removeAgent, clearAgents, rebuildHash, unstickAgents } from './agents.js';
import { rebuildZones, rebuildFeatureGrids } from './zones.js';
import { resetStructures } from './structures.js';
import { resetFire } from './fire.js';
import { resetMutants } from './mutants.js';
import { nominalPop, computeCaps, recomputeSpent, abilitySp } from './economy.js';

export function freshStats() {
  return {
    civStart: 0, civAlive: 0, civSafe: 0, civEvac: 0, civDead: 0, civKilled: 0, panicked: 0,
    zombies: 0, turning: 0, armed: 0, killed: 0, killsBy: {}, spentBy: {},
    converted: 0, armedLost: 0, infected: 0, cured: 0, mutants: 0, outbreaks: 0,
  };
}

export function setRegion(world, idx) {
  const map = world.map, levels = map.levels || [], g = world.grid;
  const lv = levels[idx];
  const poly = lv && lv.p && lv.p.length >= 6 ? lv.p : rectPoly(0, 0, map.w, map.h);
  const mask = g.levelMask(idx);
  let cells = 0, land = 0;
  const t0 = world.terrain0;
  for (let c = 0; c < mask.length; c++) if (mask[c]) { cells++; if (t0[c] !== T.WATER) land++; }
  world.region = { poly, bbox: polyBBox(poly), mask, cells, landCells: Math.max(1, land), areaM2: polyArea(poly), label: (lv && lv.label) || `Stage ${idx + 1}` };
}

export function beginStage(world, idx) {
  world.stage = clamp(idx | 0, 0, world.stageCount - 1);
  world.phase = 'planning';
  world.t = 0;
  world.tick = 0;
  world.rng = new Rng(hash2(world.seed, 0x5a6e + world.stage));
  world.readyFlags = new Array(world.owners).fill(false);
  world.result = null;
  setRegion(world, world.stage);
  resetStructures(world);
  resetFire(world);
  resetMutants(world);
  clearAgents(world);
  world.projectiles.length = 0;
  world.effects.length = 0;
  world.pickups.length = 0;
  world.stats = freshStats();
  for (const pl of world.zones.polys) pl.breached = false;
  rebuildZones(world);
  rebuildPass(world);
  rebuildFeatureGrids(world);
  world.C = nominalPop(world);
  computeCaps(world);
  recomputeSpent(world);
  world.charges = { ...(world.loadout.abilities || {}) };
  world.sp.spent = abilitySp(world, world.loadout.abilities);
  spawnCivilians(world);
  rebuildHash(world);
  world._soft = 0;
  world._secondaryAt = -1;
  world._edgeNext = Infinity;
  world._edgeLeft = 0;
  world._pickupVersion = 0;
  for (const s of world._systems) if (s.reset) s.reset(world, 'stage');
  world.events.emit('changed', { what: 'stage' });
  if (world.stage === 0 && world.map.welcome) world.events.emit('log', { msg: world.map.welcome, kind: 'info' });
}

// Civilians spawn in packs next to buildings, weighted by building population. Independent of placements.
function spawnCivilians(world) {
  const cfg = world.cfg, pc = cfg.population, g = world.grid, mask = world.region.mask;
  const rng = new Rng(hash2(world.seed, 0x71c0 + world.stage));
  let N = Math.round(world.C * pc.scale);
  const cap = cfg.sim.maxAgents || 90000;
  world.largeMap = N > cap;
  if (N > cap) N = cap;
  const blds = [], wts = [];
  let total = 0;
  for (const b of world.buildings) {
    const cx = Math.floor(b.cx / g.cell), cy = Math.floor(b.cy / g.cell);
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh || !mask[cy * g.gw + cx]) continue;
    const km = pc.kindMul[b.k];
    const w = b.area * pc.perM2 * (km === undefined ? 1 : km);
    if (!(w > 0)) continue;
    total += w; blds.push(b.idx); wts.push(total);
  }
  if (!blds.length || N <= 0) { world.stats.civStart = 0; return; }
  // terrain-only walkability so the crowd does not depend on what the player has built
  const walk = (c) => {
    const X = c % g.gw, Y = (c / g.gw) | 0;
    return X > 0 && Y > 0 && X < g.gw - 1 && Y < g.gh - 1 && mask[c] === 1 && isWalkTerrain(g.terrain[c]);
  };
  const adj = new Map();
  const doorsOf = (bi) => {
    let d = adj.get(bi);
    if (d) return d;
    const set = new Set();
    for (const c of g.bInfo[bi].cells) {
      for (const n of [c - 1, c + 1, c - g.gw, c + g.gw]) if (n >= 0 && n < mask.length && walk(n)) set.add(n);
    }
    d = Int32Array.from([...set].sort((a, z) => a - z));
    adj.set(bi, d);
    return d;
  };
  const [pmin, pmax] = pc.packSize;
  const spread = pc.packSpread;
  let placed = 0, guard = 0;
  const A = world.A;
  while (placed < N && guard++ < N * 4 + 100) {
    const r = rng.next() * total;
    let lo = 0, hi = wts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (wts[m] < r) lo = m + 1; else hi = m; }
    const doors = doorsOf(blds[lo]);
    if (!doors.length) continue;
    const dc = doors[rng.int(0, doors.length - 1)];
    const sx = (dc % g.gw + 0.5) * g.cell, sy = (((dc / g.gw) | 0) + 0.5) * g.cell;
    const size = Math.min(N - placed, rng.int(pmin, pmax));
    for (let k = 0; k < size; k++) {
      let px = sx, py = sy;
      for (let tr = 0; tr < 4; tr++) {
        const qx = sx + rng.range(-spread, spread), qy = sy + rng.range(-spread, spread);
        const c = Math.floor(qy / g.cell) * g.gw + Math.floor(qx / g.cell);
        if (qx > 0 && qy > 0 && qx < world.map.w && qy < world.map.h && walk(c)) { px = qx; py = qy; break; }
      }
      const i = spawnAgent(world, CIV, px, py);
      if (i < 0) { placed = N; break; }
      A.timer[i] = rng.range(0, 5);
      A.cd[i] = 0;
    }
    placed += size;
  }
  world.stats.civStart = world.counts[CIV];
  world.stats.civAlive = world.counts[CIV];
}

export function placementsHash(world) {
  let h = 0x9e3779b9 >>> 0;
  const mix = (v) => { h = hash2(h, Math.round(v * 10) | 0); };
  for (const pl of world.zones.polys) { mix(pl.id); for (const v of pl.p) mix(v); }
  for (const gt of world.zones.gates) { mix(gt.x); mix(gt.y); }
  for (const w of world.walls) for (const v of w.p) mix(v);
  for (const c of world.corridors) { mix(c.x0); mix(c.y0); mix(c.x1); mix(c.y1); mix(c.w); }
  for (const ho of world.holds) { mix(ho.x); mix(ho.y); mix(ho.R); }
  for (const u of world.units) if (u && u.alive !== false) { h = hash2(h, hashStr(String(u.type))); mix(u.x || 0); mix(u.y || 0); mix(u.level || 1); }
  return h >>> 0;
}

// Distance (m) from every coarse cell to the nearest zone cell (two-pass chamfer).
function zoneDistance(world) {
  const nav = world.nav, g = world.grid, R = nav.R, w = nav.cgw, h = nav.cgh;
  const d = new Float32Array(nav.cN).fill(1e9);
  for (const c of world._unionCells) d[(((c / g.gw) | 0) / R | 0) * w + ((c % g.gw) / R | 0)] = 0;
  if (!world._unionCells.length) return d;
  const D = 1.41421356;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = y * w + x; let v = d[c];
    if (x > 0 && d[c - 1] + 1 < v) v = d[c - 1] + 1;
    if (y > 0) {
      if (d[c - w] + 1 < v) v = d[c - w] + 1;
      if (x > 0 && d[c - w - 1] + D < v) v = d[c - w - 1] + D;
      if (x < w - 1 && d[c - w + 1] + D < v) v = d[c - w + 1] + D;
    }
    d[c] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const c = y * w + x; let v = d[c];
    if (x < w - 1 && d[c + 1] + 1 < v) v = d[c + 1] + 1;
    if (y < h - 1) {
      if (d[c + w] + 1 < v) v = d[c + w] + 1;
      if (x < w - 1 && d[c + w + 1] + D < v) v = d[c + w + 1] + D;
      if (x > 0 && d[c + w - 1] + D < v) v = d[c + w - 1] + D;
    }
    d[c] = v;
  }
  for (let c = 0; c < d.length; c++) d[c] *= nav.ccell;
  return d;
}

function siteOk(world, zd, x, y, minD) {
  const g = world.grid, nav = world.nav;
  if (x <= 0 || y <= 0 || x >= world.map.w || y >= world.map.h) return false;
  const c = Math.floor(y / g.cell) * g.gw + Math.floor(x / g.cell);
  if (!(nav.pass[c] & P_ZOM)) return false;
  return zd[Math.floor(y / nav.ccell) * nav.cgw + Math.floor(x / nav.ccell)] >= minD;
}

function placeHorde(world, rng, zd, x, y, radius, count, minD) {
  let made = 0;
  for (let k = 0; k < count; k++) {
    let px = x, py = y, ok = false;
    for (let tr = 0; tr < 8 && !ok; tr++) {
      const r = radius * Math.sqrt(rng.next()), a = rng.next() * Math.PI * 2;
      px = x + Math.cos(a) * r; py = y + Math.sin(a) * r;
      ok = siteOk(world, zd, px, py, minD);
    }
    if (!ok) { px = x; py = y; }
    if (spawnAgent(world, ZOMBIE, px, py) < 0) break;
    made++;
  }
  return made;
}

function humanDensity(world, x, y) {
  const sh = world.sh, bx = Math.floor(x / sh.bh), by = Math.floor(y / sh.bh);
  if (bx < 0 || by < 0 || bx >= sh.bhw || by >= sh.bhh) return 0;
  return sh.blkH[by * sh.bhw + bx];
}

export function outbreak(world, secondary = false) {
  const cfg = world.cfg, oc = cfg.outbreak, diff = cfg.diff;
  const km2 = world.region.areaM2 / 1e6;
  const sites = secondary ? 1 : Math.max(1, Math.round(clamp(Math.round(km2 * oc.perKm2), oc.minSites, oc.maxSites) * (diff.outbreakMul || 1)));
  const per = Math.max(1, Math.round((oc.zombies + oc.zombiesPerLevel * world.stage) * (oc.zombieScaleWithPop ? cfg.population.scale : 1)));
  const rng = secondary ? world.rng : new Rng(hash2(hash2(world.seed, 0x0b5e + world.stage), placementsHash(world)));
  const zd = zoneDistance(world);
  const bb = world.region.bbox, poly = world.region.poly;
  const radius = oc.radius;
  const chosen = [];
  const hints = (world.map.spawns || []).filter(([x, y]) => pointInPoly(poly, x, y));
  for (let s = 0; s < sites; s++) {
    const cands = [];
    for (const [x, y] of hints) {
      if (!siteOk(world, zd, x, y, oc.minDistFromZone + radius * 0.5)) continue;
      if (chosen.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < radius * 2)) continue;
      cands.push([x, y, 6 + Math.sqrt(humanDensity(world, x, y)) * 2]);
    }
    for (let k = 0; k < 160; k++) {
      const x = rng.range(bb[0], bb[2]), y = rng.range(bb[1], bb[3]);
      if (!pointInPoly(poly, x, y) || !siteOk(world, zd, x, y, oc.minDistFromZone + radius * 0.5)) continue;
      if (chosen.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < radius * 2)) continue;
      cands.push([x, y, 1 + Math.sqrt(humanDensity(world, x, y)) * 2]);
    }
    if (!cands.length) continue;
    const pick = rng.weighted(cands, (c) => c[2]);
    chosen.push([Math.round(pick[0] * 10) / 10, Math.round(pick[1] * 10) / 10]);
  }
  let total = 0;
  for (const [x, y] of chosen) total += placeHorde(world, rng, zd, x, y, radius, per, oc.minDistFromZone);
  world.stats.outbreaks += chosen.length;
  return { sites: chosen, zombies: total };
}

function edgeWave(world) {
  const cfg = world.cfg, oc = cfg.outbreak, rng = world.rng, poly = world.region.poly;
  const n = poly.length / 2;
  let per = 0;
  const lens = [];
  for (let k = 0; k < n; k++) { const j = (k + 1) % n; per += Math.hypot(poly[2 * j] - poly[2 * k], poly[2 * j + 1] - poly[2 * k + 1]); lens.push(per); }
  const zd = zoneDistance(world);
  for (let tries = 0; tries < 12; tries++) {
    const r = rng.next() * per;
    let k = 0;
    while (k < n - 1 && lens[k] < r) k++;
    const j = (k + 1) % n, t = rng.next();
    const x = poly[2 * k] + (poly[2 * j] - poly[2 * k]) * t, y = poly[2 * k + 1] + (poly[2 * j + 1] - poly[2 * k + 1]) * t;
    const c = nearestPassable(world, x, y, P_ZOM, 20);
    if (c < 0) continue;
    const g = world.grid, cx = (c % g.gw + 0.5) * g.cell, cy = (((c / g.gw) | 0) + 0.5) * g.cell;
    if (!siteOk(world, zd, cx, cy, oc.minDistFromZone)) continue;
    const count = Math.max(1, Math.round((oc.edgeWaveZombies || 60) * (+oc.edgeWaves || 1) * (oc.zombieScaleWithPop ? cfg.population.scale : 1)));
    placeHorde(world, rng, zd, cx, cy, 30, count, 0);
    world.events.emit('outbreak', { sites: [[cx, cy]], edge: true });
    world.events.emit('log', { msg: 'HORDE AT THE CITY LIMITS', kind: 'alert', x: cx, y: cy });
    world.events.emit('sound', { name: 'siren', x: cx, y: cy, vol: 0.7 });
    return true;
  }
  return false;
}

export function startBattle(world) {
  const A = world.A, g = world.grid;
  world.phase = 'battle';
  world.t = 0;
  for (let i = 0; i < A.n; i++) {
    if (A.type[i] !== CIV) continue;
    const z = world.zoneId[Math.floor(A.y[i] / g.cell) * g.gw + Math.floor(A.x[i] / g.cell)];
    if (z) { A.state[i] = CS.SAFE; A.timer[i] = world.rng.range(0, 4); A.tx[i] = A.x[i]; A.ty[i] = A.y[i]; }
  }
  unstickAgents(world);
  rebuildHash(world);
  const ob = outbreak(world, false);
  rebuildHash(world);
  computeFieldsNow(world);
  const oc = world.cfg.outbreak;
  if (world.stage > 0 && world.rng.next() < oc.secondaryChancePerLevel * world.stage) {
    const r = oc.secondaryAfterSec;
    world._secondaryAt = Array.isArray(r) ? world.rng.range(r[0], r[1]) : +r || 120;
  }
  if (+oc.edgeWaves > 0) { world._edgeNext = oc.edgeWaveEvery || 60; world._edgeLeft = oc.edgeWaveCount || 5; }
  world.events.emit('outbreak', { sites: ob.sites, zombies: ob.zombies });
  world.events.emit('log', { msg: `OUTBREAK CONFIRMED: ${ob.sites.length} SITE${ob.sites.length === 1 ? '' : 'S'}`, kind: 'alert', x: ob.sites[0] && ob.sites[0][0], y: ob.sites[0] && ob.sites[0][1] });
  world.events.emit('sound', { name: 'siren', x: ob.sites[0] ? ob.sites[0][0] : 0, y: ob.sites[0] ? ob.sites[0][1] : 0, vol: 1 });
  world.events.emit('changed', { what: 'ready' });
}

export function badgeFor(world, pct) {
  let best = null;
  for (const b of world.cfg.badges) {
    if (b.minPop && world.C < b.minPop) continue;
    const m = typeof b.min === 'function' ? b.min(world.stage) : +b.min;
    if (pct >= m - 1e-9) best = b.id;
  }
  return best;
}

function countByKey(world) {
  const n = { zone: world.zones.polys.length, gate: world.zones.gates.length, wall: world.walls.length, corridor: world.corridors.length, hold: world.holds.length };
  for (const u of world.units) if (u) n[u.type] = (n[u.type] || 0) + 1;
  return n;
}

export function buildResult(world, won, extra = {}) {
  const s = world.stats;
  const saved = world.counts[CIV] + s.civEvac;
  const pct = s.civStart > 0 ? saved / s.civStart * 100 : 100;
  const counts = countByKey(world);
  const keys = [...new Set([...Object.keys(s.killsBy), ...Object.keys(s.spentBy)])].sort();
  const perType = keys.map((key) => {
    const kills = s.killsBy[key] || 0, spent = Math.round(s.spentBy[key] || 0);
    return { key, count: counts[key] || 0, kills, spent, perKill: kills ? spent / kills : null };
  });
  return {
    won, lost: !won, stage: world.stage, stageCount: world.stageCount, last: world.stage >= world.stageCount - 1,
    pct, badge: won ? badgeFor(world, pct) : null,
    civStart: s.civStart, saved, civLost: Math.max(0, s.civStart - saved), evacuated: s.civEvac, converted: s.converted,
    zombiesKilled: s.killed, killsBy: { ...s.killsBy }, spentBy: { ...s.spentBy }, perType,
    spent: Math.round(world.budget.spent), budget: world.budget.cap,
    time: world.t, C: world.C, difficulty: world.difficulty, sandbox: world.sandbox, seed: world.seed, map: world.map.name || '',
    ...extra,
  };
}

export function endStage(world, won, extra) {
  if (world.phase !== 'battle') return;
  world.phase = won ? 'won' : 'lost';
  world.result = buildResult(world, won, extra);
  world.events.emit('log', { msg: won ? 'AREA SECURED' : 'CITY LOST', kind: won ? 'info' : 'alert' });
  world.events.emit('sound', { name: won ? 'win' : 'lose', x: 0, y: 0, vol: 1 });
  world.events.emit('stageEnd', { result: world.result });
}

export function levelSystem(world, dt) {
  if (world.phase !== 'battle') return;
  const s = world.stats, counts = world.counts, cfg = world.cfg;
  if (world._secondaryAt >= 0 && world.t >= world._secondaryAt) {
    world._secondaryAt = -1;
    const ob = outbreak(world, true);
    if (ob.sites.length) {
      world.events.emit('outbreak', { sites: ob.sites, zombies: ob.zombies, secondary: true });
      world.events.emit('log', { msg: 'SECOND OUTBREAK REPORTED', kind: 'alert', x: ob.sites[0][0], y: ob.sites[0][1] });
      world.events.emit('sound', { name: 'siren', x: ob.sites[0][0], y: ob.sites[0][1], vol: 1 });
    }
  }
  if (world._edgeLeft > 0 && world.t >= world._edgeNext) {
    world._edgeLeft--;
    world._edgeNext = world.t + (cfg.outbreak.edgeWaveEvery || 60);
    edgeWave(world);
  }
  s.civAlive = counts[CIV];
  s.zombies = counts[ZOMBIE];
  s.turning = counts[TURNING];
  s.armed = counts[POLICE] + counts[MILITIA] + counts[SOLDIER];
  s.civDead = Math.max(0, s.civStart - s.civAlive - s.civEvac - s.converted);
  if (s.civStart > 0 && s.civAlive + s.civEvac < cfg.loseBelowPct / 100 * s.civStart) { endStage(world, false); return; }
  if (s.zombies === 0 && s.turning === 0) { endStage(world, true); return; }
  if (world.tick % 20 === 0 && s.zombies > 0) {
    const A = world.A, nav = world.nav, g = world.grid, inv = 1 / g.cell, sd = nav.scent.dir, wd = nav.swim && nav.swim.ready ? nav.swim.dir : sd;
    let reach = false;
    for (let i = 0; i < A.n && !reach; i++) {
      if (A.type[i] !== ZOMBIE) continue;
      const c = ((A.y[i] * inv) | 0) * g.gw + ((A.x[i] * inv) | 0);
      if ((A.sub[i] === ZSUB.SWIMMER ? wd : sd)[c] !== 255) reach = true;
    }
    world._soft = reach ? 0 : world._soft + 20 * dt;
    if (world._soft >= cfg.zombie.softlockSec) {
      for (let i = 0; i < A.n; i++) if (A.type[i] === ZOMBIE || A.type[i] === TURNING) removeAgent(world, i);
      world.events.emit('log', { msg: 'REMAINING INFECTED ARE CUT OFF', kind: 'info' });
      s.zombies = 0; s.turning = 0;
      endStage(world, true, { softlock: true });
    }
  }
}
