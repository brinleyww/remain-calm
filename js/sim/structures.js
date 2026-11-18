// Buildings, bridges, walls damage; collapses; area damage; special-building functions.
import { T } from '../map/format.js';
import { updatePassCells, nearestPassable, P_CIV } from './nav.js';
import { M_ALL, M_HUMAN, M_ZOMBIE, M_TURNING, M_CIV, M_ARMED, CIV, ZOMBIE, TURNING, MILITIA, POLICE, ZSUB, CS,
  damageAgent, removeAgent, spawnAgent, setType, cureAgent, evacuateAgent, armedStats } from './agents.js';
import { ignite } from './fire.js';
import { buildingInZone } from './zones.js';

export function initStructures(world) {
  const g = world.grid, bc = world.cfg.building, B = world.map.buildings || [];
  world.terrain0 = g.terrain.slice();
  world.buildings = g.bInfo.map((info, idx) => {
    const src = B[idx] || {};
    const hpMax = Math.round(bc.hpBase + info.area * bc.hpPerM2 + info.h * bc.hpPerM);
    return {
      idx, cx: info.cx, cy: info.cy, h: info.h, area: info.area, k: info.k, use: src.use || '', name: src.name || '',
      hp: hpMax, hpMax, alive: true, zone: -1, func: null, funcState: { stance: 'pursue' }, unitId: -1, burning: false,
      special: !!world.cfg.specials[info.k], r: Math.sqrt(info.area / Math.PI) + g.cell * 0.5,
    };
  });
  world.bridges = g.bridges.map((br, idx) => ({ idx, cx: br.cx, cy: br.cy, len: br.len, width: br.width, hp: br.hpMax, hpMax: br.hpMax, alive: true }));
  world.bcMask = new Uint8Array(world.nav.cN);
  world._bcCells = [];
  world._cq = [];
  world._cqBusy = false;
  world._crush = new Uint8Array(g.gw * g.gh);
  rebuildAuras(world);
}

export function resetStructures(world) {
  world.grid.terrain.set(world.terrain0);
  for (const b of world.buildings) {
    b.hp = b.hpMax; b.alive = true; b.burning = false;
    b.funcState = { stance: (b.funcState && b.funcState.stance) || 'pursue' };
  }
  for (const br of world.bridges) { br.hp = br.hpMax; br.alive = true; }
  world._cq.length = 0;
}

// ---------------------------------------------------------------- buildings
export function damageBuilding(world, b, dmg, src = 'explosion', dirX = 0, dirY = 0) {
  const bd = world.buildings[b];
  if (!bd || !bd.alive || !(dmg > 0)) return false;
  bd.hp -= dmg;
  if (bd.hp > 0) return false;
  collapseBuilding(world, b, dirX, dirY, src);
  return true;
}

export function collapseBuilding(world, b, dirX = 0, dirY = 0, src = 'collapse') {
  world._cq.push([b, dirX, dirY, src]);
  if (world._cqBusy) return;
  world._cqBusy = true;
  try {
    while (world._cq.length) { const [bb, dx, dy, s] = world._cq.shift(); doCollapse(world, bb, dx, dy, s); }
  } finally { world._cqBusy = false; }
}

function doCollapse(world, b, dirX, dirY, src) {
  const bd = world.buildings[b];
  if (!bd || !bd.alive) return;
  bd.alive = false; bd.hp = 0; bd.burning = false;
  const rng = world.rng, bc = world.cfg.building;
  let dl = Math.hypot(dirX, dirY);
  if (dl < 1e-6) { const a = rng.next() * Math.PI * 2; dirX = Math.cos(a); dirY = Math.sin(a); }
  else { dirX /= dl; dirY /= dl; }
  const g = world.grid, info = g.bInfo[b], cs = g.cell, gw = g.gw, gh = g.gh, terr = g.terrain, crush = world._crush;
  const L = info.h * bc.toppleRange;
  const steps = Math.max(0, Math.round(L / cs));
  const changed = [], marked = [];
  const hitB = new Set(), hitBr = new Set();
  for (const c of info.cells) if (terr[c] === T.BLDG) { terr[c] = T.RUBBLE; changed.push(c); }
  for (const c of info.cells) {
    const x = (c % gw + 0.5) * cs, y = (((c / gw) | 0) + 0.5) * cs;
    for (let s = 1; s <= steps; s++) {
      const cx = Math.floor((x + dirX * s * cs) / cs), cy = Math.floor((y + dirY * s * cs) / cs);
      if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) break;
      const t = cy * gw + cx;
      if (g.bldg[t] === b + 1) continue;
      const tt = terr[t];
      if (tt === T.BLDG) { hitB.add(g.bldg[t] - 1); break; }
      if (tt === T.WATER) break;
      if (tt === T.BRIDGE) { hitBr.add(g.bridgeId[t] - 1); continue; }
      if (!crush[t]) { crush[t] = 1; marked.push(t); }
      if (tt !== T.RUBBLE) { terr[t] = T.RUBBLE; changed.push(t); }
    }
  }
  const A = world.A;
  const reach = bd.r + L + cs * 2;
  const victims = [];
  world.query(bd.cx + dirX * L * 0.5, bd.cy + dirY * L * 0.5, reach, M_ALL, (i) => {
    const c = Math.floor(A.y[i] / cs) * gw + Math.floor(A.x[i] / cs);
    if (crush[c] || g.bldg[c] === b + 1) victims.push(i);
  });
  for (const i of victims) killOutright(world, i, src);
  for (const t of marked) crush[t] = 0;
  updatePassCells(world, changed);
  if (bd.func) rebuildAuras(world);
  world.effects.push({ kind: 'collapse', x: bd.cx, y: bd.cy, r: bd.r + L * 0.5, t0: world.t, dur: 1.4, x2: bd.cx + dirX * L, y2: bd.cy + dirY * L });
  world.events.emit('collapse', { b, x: bd.cx, y: bd.cy, dirX, dirY });
  world.events.emit('sound', { name: 'collapse', x: bd.cx, y: bd.cy, vol: Math.min(1, 0.4 + bd.h / 60) });
  if (rng.next() < bc.collapseFireChance) ignite(world, bd.cx, bd.cy, bd.r * 0.9, 1);
  for (const o of [...hitB].sort((a, z) => a - z)) {
    const ob = world.buildings[o];
    if (!ob || !ob.alive) continue;
    if (rng.next() < bc.dominoChance) collapseBuilding(world, o, dirX, dirY, src);
    else damageBuilding(world, o, ob.hpMax * 0.35, src, dirX, dirY);
  }
  for (const br of [...hitBr].sort((a, z) => a - z)) if (world.bridges[br]) damageBridge(world, br, world.bridges[br].hpMax * 0.6);
  if (bd.k === 'hazard') {
    const hz = world.cfg.hazard;
    world.effects.push({ kind: 'boom', x: bd.cx, y: bd.cy, r: hz.radius + bd.r, t0: world.t, dur: 0.9 });
    world.events.emit('sound', { name: 'explosion', x: bd.cx, y: bd.cy, vol: 1 });
    world.events.emit('log', { msg: 'HAZARD SITE EXPLODED', kind: 'alert', x: bd.cx, y: bd.cy });
    damageArea(world, bd.cx, bd.cy, hz.radius + bd.r, hz.dmg, { src: 'hazard', friendly: true, bldgDmg: hz.bldgDmg, bridgeDmg: hz.bridgeDmg, wallDmg: hz.wallDmg, fire: hz.fire });
  }
}

function killOutright(world, i, src) {
  const A = world.A, t = A.type[i];
  if (!t) return;
  if (t === ZOMBIE) { A.shield[i] = 0; damageAgent(world, i, 1e9, src); return; }
  if (t === TURNING) { damageAgent(world, i, 1e9, src); return; }
  removeAgent(world, i);
  if (t === CIV) world.stats.civKilled++; else world.stats.armedLost++;
}

// ---------------------------------------------------------------- bridges
export function damageBridge(world, id, dmg) {
  const br = world.bridges[id];
  if (!br || !br.alive || !(dmg > 0)) return false;
  br.hp -= dmg;
  if (br.hp > 0) return false;
  br.hp = 0; br.alive = false;
  const g = world.grid, cells = g.bridges[id].cells, cs = g.cell;
  for (const c of cells) g.terrain[c] = T.WATER;
  updatePassCells(world, cells);
  const A = world.A, victims = [];
  world.query(br.cx, br.cy, br.len * 0.5 + br.width + cs * 2, M_ALL, (i) => {
    if (A.type[i] === ZOMBIE && A.sub[i] === ZSUB.SWIMMER) return;
    const c = Math.floor(A.y[i] / cs) * g.gw + Math.floor(A.x[i] / cs);
    if (g.bridgeId[c] === id + 1) victims.push(i);
  });
  for (const i of victims) killOutright(world, i, 'drown');
  world.effects.push({ kind: 'splash', x: br.cx, y: br.cy, r: br.len * 0.5, t0: world.t, dur: 1.5 });
  world.events.emit('bridgeDown', { id });
  world.events.emit('log', { msg: 'BRIDGE DOWN', kind: 'warn', x: br.cx, y: br.cy });
  world.events.emit('sound', { name: 'collapse', x: br.cx, y: br.cy, vol: 0.9 });
  return true;
}

// ---------------------------------------------------------------- walls / gates
function damageGate(world, gt, dmg) {
  if (gt.hp <= 0) return;
  gt.hp = Math.max(0, gt.hp - dmg);
  for (const c of gt.cells) world.wallHp[c] = gt.hp;
  if (gt.hp > 0) return;
  updatePassCells(world, gt.cells);
  world.events.emit('log', { msg: 'GATE DESTROYED', kind: 'warn', x: gt.x, y: gt.y });
  world.events.emit('sound', { name: 'wall', x: gt.x, y: gt.y, vol: 0.8 });
}

export function damageWallCell(world, c, dmg) {
  const hp = world.wallHp[c];
  if (!world.block[c] || hp <= 0 || !(dmg > 0)) return;
  if (world.block[c] === 3) { const gt = world.zones.gates[world.gateIdx[c] - 1]; if (gt) damageGate(world, gt, dmg); return; }
  if (hp > dmg) { world.wallHp[c] = hp - dmg; return; }
  world.wallHp[c] = 0;
  updatePassCells(world, [c]);
  if (world.tick - (world._lastWallSound || -99) > 10) {
    world._lastWallSound = world.tick;
    const g = world.grid;
    world.events.emit('sound', { name: 'wall', x: (c % g.gw + 0.5) * g.cell, y: (((c / g.gw) | 0) + 0.5) * g.cell, vol: 0.6 });
  }
}

export function damageWallsArea(world, x, y, r, dmg) {
  const g = world.grid, cs = g.cell;
  const x0 = Math.max(0, Math.floor((x - r) / cs)), x1 = Math.min(g.gw - 1, Math.floor((x + r) / cs));
  const y0 = Math.max(0, Math.floor((y - r) / cs)), y1 = Math.min(g.gh - 1, Math.floor((y + r) / cs));
  const gates = new Set(), dead = [];
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const c = cy * g.gw + cx;
    if (!world.block[c] || world.wallHp[c] <= 0) continue;
    const dx = (cx + 0.5) * cs - x, dy = (cy + 0.5) * cs - y;
    if (dx * dx + dy * dy > r * r) continue;
    if (world.block[c] === 3) { gates.add(world.gateIdx[c] - 1); continue; }
    world.wallHp[c] -= dmg;
    if (world.wallHp[c] <= 0) { world.wallHp[c] = 0; dead.push(c); }
  }
  for (const k of [...gates].sort((a, b) => a - b)) if (world.zones.gates[k]) damageGate(world, world.zones.gates[k], dmg);
  if (dead.length) updatePassCells(world, dead);
}

// ---------------------------------------------------------------- area damage
export function damageArea(world, x, y, r, dmg, o = {}) {
  const src = o.src || 'explosion', fall = o.falloff !== false, stun = o.stunSec || 0;
  if (!(r > 0)) return;
  if (dmg > 0 || stun > 0) {
    const mask = M_ZOMBIE | M_TURNING | (o.friendly ? M_HUMAN : 0);
    const hits = [];
    world.query(x, y, r, mask, (i, d2) => { hits.push(i, d2); });
    const A = world.A;
    for (let k = 0; k < hits.length; k += 2) {
      const i = hits[k], f = fall ? 1 - 0.75 * Math.sqrt(hits[k + 1]) / r : 1;
      if (!A.type[i]) continue;
      if (stun > 0 && A.type[i] === ZOMBIE) A.stun[i] = Math.max(A.stun[i], stun);
      if (dmg > 0) damageAgent(world, i, dmg * f, src);
    }
  }
  if (o.bldgDmg > 0) {
    for (const b of world.buildings) {
      if (!b.alive) continue;
      const dx = b.cx - x, dy = b.cy - y, d = Math.hypot(dx, dy);
      if (d > r + b.r) continue;
      const f = fall ? Math.max(0.25, 1 - 0.75 * Math.max(0, d - b.r) / r) : 1;
      damageBuilding(world, b.idx, o.bldgDmg * f, src, dx, dy);
    }
  }
  if (o.bridgeDmg > 0) {
    for (const br of world.bridges) {
      if (!br.alive) continue;
      const d = Math.hypot(br.cx - x, br.cy - y);
      if (d > r + br.len * 0.5) continue;
      const f = fall ? Math.max(0.25, 1 - 0.75 * Math.max(0, d - br.len * 0.5) / r) : 1;
      damageBridge(world, br.idx, o.bridgeDmg * f * (o.explosive === false ? 1 : world.cfg.bridge.explosiveMul));
    }
  }
  if (o.wallDmg > 0) damageWallsArea(world, x, y, r, o.wallDmg);
  if (o.fire) ignite(world, x, y, r, o.fire, o.src);
}

// ---------------------------------------------------------------- special functions
const AURA_KEYS = ['range', 'rof', 'reload', 'budget', 'reducedCost', 'repair', 'medic', 'airlift', 'police', 'militia', 'broadcast'];

export function funcAllowed(world, b, func) {
  const sp = world.cfg.specials[b.k];
  return !!(sp && sp.functions.includes(func));
}

export function refreshFunctions(world) {
  for (const b of world.buildings) {
    if (b.func && (b.zone < 0 || !funcAllowed(world, b, b.func))) { b.func = null; b.funcState = { stance: b.funcState.stance || 'pursue' }; }
  }
  rebuildAuras(world);
}

export function rebuildAuras(world) {
  const F = world.cfg.functions;
  const au = {};
  for (const k of AURA_KEYS) au[k] = [];
  for (const b of world.buildings) {
    if (!b.func || !b.alive || b.zone < 0) continue;
    const at = { b: b.idx, x: b.cx, y: b.cy, zone: b.zone };
    switch (b.func) {
      case 'radio': au.range.push({ ...at, r: F.radio.radius, mul: F.radio.rangeMul }); break;
      case 'commandPost': au.rof.push({ ...at, r: F.commandPost.radius, mul: F.commandPost.rofMul }); break;
      case 'supply': au.reload.push({ ...at, r: F.supply.radius, mul: F.supply.reloadMul, restock: !!F.supply.turretRestock }); break;
      case 'budget': au.budget.push({ ...at, mul: F.budget.costMul }); break;
      case 'reducedCost': au.reducedCost.push({ ...at, r: F.reducedCost.radius + b.r, mul: F.reducedCost.costMul }); break;
      case 'broadcast': au.broadcast.push({ ...at, r: F.broadcast.radius }); break;
      default: if (au[b.func]) au[b.func].push(at);
    }
  }
  world.auras = au;
  if (!world.bcMask) return;
  for (const c of world._bcCells) world.bcMask[c] = 0;
  const cells = [], nav = world.nav, ccs = nav.ccell;
  for (const a of au.broadcast) {
    const rc = Math.ceil(a.r / ccs), bx = Math.floor(a.x / ccs), by = Math.floor(a.y / ccs);
    for (let cy = Math.max(0, by - rc); cy <= Math.min(nav.cgh - 1, by + rc); cy++)
      for (let cx = Math.max(0, bx - rc); cx <= Math.min(nav.cgw - 1, bx + rc); cx++) {
        const dx = (cx + 0.5) * ccs - a.x, dy = (cy + 0.5) * ccs - a.y;
        if (dx * dx + dy * dy > a.r * a.r) continue;
        const c = cy * nav.cgw + cx;
        if (!world.bcMask[c]) { world.bcMask[c] = 1; cells.push(c); }
      }
  }
  world._bcCells = cells;
}

export function auraMul(world, x, y, kind) {
  const list = world.auras[kind];
  if (!list || !list.length || kind === 'budget') return 1;
  let m = 1;
  for (const a of list) { const dx = a.x - x, dy = a.y - y; if (dx * dx + dy * dy <= a.r * a.r) m *= a.mul; }
  return m;
}

export function hasSupply(world, x, y) {
  for (const a of world.auras.reload) { const dx = a.x - x, dy = a.y - y; if (a.restock && dx * dx + dy * dy <= a.r * a.r) return true; }
  return false;
}

function spawnOfficer(world, b) {
  const g = world.grid;
  const c = nearestPassable(world, b.cx, b.cy, P_CIV, Math.ceil(b.r / g.cell) + 6);
  if (c < 0) return -1;
  const x = (c % g.gw + 0.5) * g.cell, y = (((c / g.gw) | 0) + 0.5) * g.cell;
  const i = spawnAgent(world, POLICE, x, y);
  if (i < 0) return -1;
  const A = world.A;
  A.group[i] = b.idx;
  A.state[i] = b.funcState.stance === 'hold' ? 0 : 1;
  const comp = world.zones.comps[b.zone];
  A.owner[i] = comp ? comp.owner : 0;
  return i;
}

export function onBreach(world, k) {
  const F = world.cfg.functions.militia, A = world.A;
  for (const a of world.auras.militia) {
    const b = world.buildings[a.b];
    if (b.zone !== k || b.funcState.fired) continue;
    b.funcState.fired = true;
    const picks = [];
    world.query(b.cx, b.cy, F.radius, M_CIV, (i) => { picks.push(i); });
    picks.sort((a, z) => a - z);
    let n = 0;
    for (const i of picks) {
      if (A.type[i] !== CIV || world.rng.next() >= F.convertFrac) continue;
      setType(world, i, MILITIA);
      A.hp[i] = F.fighter.hp; A.ammo[i] = F.fighter.ammo; A.state[i] = 1; A.group[i] = -1; A.cd[i] = 0; A.tgt[i] = -1;
      A.home[2 * i] = A.x[i]; A.home[2 * i + 1] = A.y[i];
      n++;
    }
    world.stats.converted += n;
    if (n) world.events.emit('log', { msg: `MILITIA RAISED: ${n} ARMED CITIZENS`, kind: 'info', x: b.cx, y: b.cy });
  }
}

export function functionsSystem(world, dt) {
  const F = world.cfg.functions, au = world.auras, A = world.A;
  for (const a of au.police) {
    const b = world.buildings[a.b], fs = b.funcState;
    fs.t = (fs.t || 0) + dt;
    if (fs.t < F.police.every) continue;
    fs.t -= F.police.every;
    if ((fs.spawned || 0) >= F.police.max) continue;
    if (spawnOfficer(world, b) >= 0) fs.spawned = (fs.spawned || 0) + 1;
  }
  if (world.tick % 10 === 0 && au.repair.length) {
    const amt = F.repair.wallHpPerSec * dt * 10, wc = world.cfg.wall;
    for (const a of au.repair) {
      const comp = world.zones.comps[world.buildings[a.b].zone];
      if (!comp) continue;
      const full = wc.hp * (wc.levelHpMul[comp.wallLevel - 1] || 1), hp = world.wallHp;
      for (const c of comp.wallCells) if (world.block[c] === 1 && hp[c] > 0 && hp[c] < full) hp[c] = Math.min(full, hp[c] + amt);
      for (const gt of world.zones.gates) {
        if (gt.comp !== comp.id || gt.hp <= 0 || gt.hp >= gt.hpMax) continue;
        gt.hp = Math.min(gt.hpMax, gt.hp + amt);
        for (const c of gt.cells) hp[c] = gt.hp;
      }
    }
  }
  if (world.tick % 20 !== 0) return;
  const g = world.grid, cs = g.cell;
  for (const a of au.medic) {
    const b = world.buildings[a.b], z1 = b.zone + 1, list = [];
    world.query(b.cx, b.cy, F.medic.radius, M_TURNING | M_ARMED, (i) => { list.push(i); });
    for (const i of list) {
      const c = Math.floor(A.y[i] / cs) * g.gw + Math.floor(A.x[i] / cs);
      if (world.zoneId[c] !== z1) continue;
      if (A.type[i] === TURNING) { if (F.medic.cureTurning && cureAgent(world, i)) A.state[i] = CS.SAFE; }
      else { const mx = armedStats(world, A.type[i], A.group[i]).hp; A.hp[i] = Math.min(mx, A.hp[i] + F.medic.healPerSec * 20 * dt); }
    }
  }
  for (const a of au.airlift) {
    const b = world.buildings[a.b], fs = b.funcState, comp = world.zones.comps[b.zone];
    fs.t = (fs.t || 0) + 20 * dt;
    if (fs.t < F.airlift.every || !comp) continue;
    fs.t = 0;
    const [x0, y0, x1, y1] = comp.bbox;
    const cxm = (x0 + x1 + 1) * 0.5 * cs, cym = (y0 + y1 + 1) * 0.5 * cs, rr = Math.hypot(x1 - x0 + 1, y1 - y0 + 1) * 0.5 * cs;
    const picks = [];
    world.query(cxm, cym, rr, M_CIV, (i, d2) => {
      if (A.state[i] !== CS.SAFE) return;
      const c = Math.floor(A.y[i] / cs) * g.gw + Math.floor(A.x[i] / cs);
      if (world.zoneId[c] === b.zone + 1) picks.push(i);
    });
    picks.sort((a, z) => a - z);
    let n = 0;
    for (const i of picks) { if (n >= F.airlift.count) break; if (evacuateAgent(world, i)) n++; }
    if (n) {
      world.effects.push({ kind: 'heli', x: b.cx, y: b.cy, r: 20, t0: world.t, dur: 3 });
      world.events.emit('sound', { name: 'heli', x: b.cx, y: b.cy, vol: 0.5 });
    }
  }
}

// ---------------------------------------------------------------- commands
export function registerStructureCommands(world) {
  world.registerCommand('func.set', {
    quote(w, cmd) {
      if (w.phase !== 'planning' && w.phase !== 'battle') return { ok: false, reason: 'Stage is over', cost: 0 };
      const b = w.buildings[cmd.b];
      if (!b) return { ok: false, reason: 'No such building', cost: 0 };
      if (!b.special) return { ok: false, reason: 'Not a special building', cost: 0 };
      if (!b.alive) return { ok: false, reason: 'Building destroyed', cost: 0 };
      const f = cmd.func || null;
      if (f && !funcAllowed(w, b, f)) return { ok: false, reason: 'Not available for this building', cost: 0 };
      if (f && buildingInZone(w, b.idx) < 0) return { ok: false, reason: 'Must be inside a safe zone', cost: 0 };
      return { ok: true, cost: 0 };
    },
    exec(w, cmd) {
      const b = w.buildings[cmd.b];
      b.func = cmd.func || null;
      b.funcState = { stance: b.funcState.stance || 'pursue' };
      rebuildAuras(w);
      return { ok: true, b: b.idx, func: b.func };
    },
  });
  world.registerCommand('stance.set', {
    quote(w, cmd) {
      if (cmd.b === undefined && cmd.group === undefined) return { ok: false, reason: 'Nothing selected', cost: 0 };
      return { ok: true, cost: 0 };
    },
    exec(w, cmd) {
      const s = cmd.stance === 1 || cmd.stance === 'pursue' || cmd.stance === 'hunt' ? 1 : 0;
      const grp = cmd.b !== undefined ? cmd.b | 0 : cmd.group | 0;
      if (cmd.b !== undefined && w.buildings[grp]) w.buildings[grp].funcState.stance = s ? 'pursue' : 'hold';
      const A = w.A;
      let n = 0;
      for (let i = 0; i < A.n; i++) if (A.type[i] >= POLICE && A.group[i] === grp) { A.state[i] = s; n++; }
      return { ok: true, stance: s ? 'pursue' : 'hold', count: n };
    },
  });
}
