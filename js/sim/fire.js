// Fire on the coarse grid: intensity 0..1 per cell, spreads into parks and buildings, burns out after burnSec.
import { T } from '../map/format.js';
import { damageBuilding, damageWallCell } from './structures.js';

const STEP = 5; // fire updates every STEP ticks

export function initFire(world) {
  const nav = world.nav;
  world.fire = new Float32Array(nav.cN);
  world._fireT = new Float32Array(nav.cN);
  world._burnt = new Uint8Array(nav.cN);
  world._fuel = new Uint8Array(nav.cN);
  world._fireList = [];
  world._burningB = [];
  world._fireSrc = new Uint8Array(nav.cN);  // index into _fireKeys: who lit it, for kill credit
  world._fireKeys = ['fire'];
}

// fuel: 2 building, 1 park/grass, 0 bare
function computeFuel(world) {
  const nav = world.nav, g = world.grid, R = nav.R, fuel = world._fuel;
  fuel.fill(0);
  for (let c = 0; c < g.gw * g.gh; c++) {
    const t = g.terrain[c];
    if (t !== T.BLDG && t !== T.PARK) continue;
    const cc = (((c / g.gw) | 0) / R | 0) * nav.cgw + ((c % g.gw) / R | 0);
    const f = t === T.BLDG ? 2 : 1;
    if (fuel[cc] < f) fuel[cc] = f;
  }
}

export function resetFire(world) {
  world.fire.fill(0); world._fireT.fill(0); world._burnt.fill(0); world._fireSrc.fill(0);
  world._fireKeys = ['fire'];
  world._fireList.length = 0;
  for (const b of world._burningB) if (world.buildings[b]) world.buildings[b].burning = false;
  world._burningB.length = 0;
  computeFuel(world);
}

function lightCell(world, c, intensity, src) {
  const fire = world.fire;
  if (fire[c] >= intensity) return;
  if (fire[c] === 0) world._fireList.push(c);
  fire[c] = intensity;
  world._fireSrc[c] = src;
  const burn = world.cfg.fire.burnSec;
  world._fireT[c] = Math.max(world._fireT[c], world._fuel[c] ? burn : burn * 0.4);
}

function srcId(world, key) {
  if (!key || typeof key !== 'string') return 0;
  let k = world._fireKeys.indexOf(key);
  if (k < 0) { if (world._fireKeys.length >= 255) return 0; k = world._fireKeys.push(key) - 1; }
  return k;
}

export function fireKey(world, c) { return world._fireKeys[world._fireSrc[c]] || 'fire'; }

export function ignite(world, x, y, r, intensity = 1, srcKey = null) {
  const nav = world.nav, ccs = nav.ccell, src = srcId(world, srcKey);
  intensity = Math.min(1, Math.max(0.05, +intensity || 1));
  r = Math.max(r, ccs * 0.5);
  const x0 = Math.max(1, Math.floor((x - r) / ccs)), x1 = Math.min(nav.cgw - 2, Math.floor((x + r) / ccs));
  const y0 = Math.max(1, Math.floor((y - r) / ccs)), y1 = Math.min(nav.cgh - 2, Math.floor((y + r) / ccs));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const dx = (cx + 0.5) * ccs - x, dy = (cy + 0.5) * ccs - y;
    if (dx * dx + dy * dy > r * r) continue;
    const c = cy * nav.cgw + cx;
    if (!world.region.mask[Math.min(world.grid.gh - 1, cy * nav.R) * world.grid.gw + Math.min(world.grid.gw - 1, cx * nav.R)]) continue;
    world._burnt[c] = 0;
    lightCell(world, c, intensity, src);
  }
}

export function fireSystem(world, dt) {
  if (world.tick % STEP !== 0 || !world._fireList.length) return;
  const step = dt * STEP, fc = world.cfg.fire, rng = world.rng, nav = world.nav, g = world.grid;
  const fire = world.fire, ft = world._fireT, fuel = world._fuel, burnt = world._burnt, list = world._fireList;
  const cgw = nav.cgw, R = nav.R;
  for (const b of world._burningB) if (world.buildings[b]) world.buildings[b].burning = false;
  world._burningB.length = 0;
  const bDmg = new Map();
  const n0 = list.length;
  for (let k = 0; k < n0; k++) {
    const c = list[k];
    const I = fire[c];
    if (I <= 0) continue;
    ft[c] -= step;
    if (ft[c] <= 0) { fire[c] = 0; burnt[c] = 1; continue; }
    const cx = c % cgw, cy = (c / cgw) | 0;
    if (cx > 1 && cy > 1 && cx < cgw - 2 && cy < nav.cgh - 2) {
      for (const n of [c + 1, c - 1, c + cgw, c - cgw]) {
        const f = fuel[n];
        if (!f || fire[n] > 0 || burnt[n]) continue;
        if (rng.next() < fc.spreadChance * step * I * (f === 1 ? fc.grassMul : 1)) lightCell(world, n, Math.max(0.3, I * 0.9), world._fireSrc[c]);
      }
    }
    let lastB = -1;
    for (let dy = 0; dy < R; dy++) for (let dx = 0; dx < R; dx++) {
      const fx = cx * R + dx, fy = cy * R + dy;
      if (fx >= g.gw || fy >= g.gh) continue;
      const f = fy * g.gw + fx;
      const b = g.bldg[f] - 1;
      if (b >= 0 && b !== lastB && g.terrain[f] === T.BLDG) {
        lastB = b;
        const e = bDmg.get(b);
        if (e) { e[0]++; if (I > e[1]) e[1] = I; } else bDmg.set(b, [1, I]);
      }
      if (world.block[f] && world.wallHp[f] > 0) damageWallCell(world, f, fc.wallDps * step * I);
    }
  }
  let w = 0;
  for (let k = 0; k < list.length; k++) if (fire[list[k]] > 0) list[w++] = list[k];
  list.length = w;
  for (const [b, e] of [...bDmg.entries()].sort((a, z) => a[0] - z[0])) {
    const bd = world.buildings[b];
    if (!bd || !bd.alive) continue;
    bd.burning = true;
    world._burningB.push(b);
    damageBuilding(world, b, fc.buildingDps * step * e[1] * Math.sqrt(e[0]), 'fire');
  }
}
