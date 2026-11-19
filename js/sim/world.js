// World: the deterministic simulation container and the contract every other module talks to.
import { makeConfig } from '../data/config.js';
import { Rng, hashStr } from '../util/rng.js';
import { Emitter } from '../util/events.js';
import { buildGrid } from './raster.js';
import { initNav, navSystem, computeFieldsNow, P_IN, P_CIV, P_ZOM, P_SWIM, P_SLOW, P_WALL, P_GATE, P_WATER } from './nav.js';
import {
  TYPE, TYPE_KEYS, CS, ZSUB, SUB_KEYS, M_CIV, M_ZOMBIE, M_TURNING, M_POLICE, M_MILITIA, M_SOLDIER, M_ARMED, M_HUMAN, M_ALL,
  initAgents, spawnAgent, removeAgent, infectAgent, cureAgent, evacuateAgent, damageAgent, queryAgents, nearestAgent,
  zombieHp, rebuildHash, agentSystem, releaseCivs, setType, armedStats, markWallAgents, TIER_SURFACE, TIER_ALL,
} from './agents.js';
import { surfaceAt } from './decks.js';
import { initZones, registerZoneCommands, rebuildZones, rebuildFeatureGrids, inZone, buildingInZone, savePlacements, loadPlacements, gateCheck } from './zones.js';
import {
  initStructures, registerStructureCommands, damageBuilding, collapseBuilding, damageBridge, damageWallsArea, damageWallCell,
  damageArea, auraMul, hasSupply, functionsSystem, onBreach, refreshFunctions, funcAllowed,
} from './structures.js';
import { initFire, fireSystem, ignite } from './fire.js';
import { resetMutants, mutantSystem } from './mutants.js';
import { canAfford, spend, refundPlacement, refundRate, recomputeSpent, costMul, available, abilitySp, registerEconomyCommands } from './economy.js';
import { beginStage, startBattle, levelSystem, freshStats, placementsHash, badgeFor } from './level.js';
import { installOrders } from './orders.js';

export { TYPE, TYPE_KEYS, CS, ZSUB, SUB_KEYS, M_CIV, M_ZOMBIE, M_TURNING, M_POLICE, M_MILITIA, M_SOLDIER, M_ARMED, M_HUMAN, M_ALL, TIER_SURFACE, TIER_ALL };
export const PASS = Object.freeze({ IN: P_IN, CIV: P_CIV, ZOMBIE: P_ZOM, SWIM: P_SWIM, SLOW: P_SLOW, WALL: P_WALL, GATE: P_GATE, WATER: P_WATER });
export const SYSTEM_ORDER = Object.freeze({ hash: 0, nav: 10, agents: 20, functions: 30, mutants: 40, fire: 50, combat: 60, level: 100 });

// Commands that do not change the board (they never cancel a partner's READY).
const NON_BOARD = new Set(['ready', 'speed', 'stance.set', 'squad.mode', 'ability.use', 'unit.detonate', 'order']);
const REFUND_CMD = { unit: 'unit.refund', gate: 'gate.remove', corridor: 'corridor.remove', hold: 'hold.remove', wall: 'wall.remove', zone: 'zone.remove' };

export class World {
  constructor(map, opts = {}) {
    this.map = map;
    this.difficulty = opts.difficulty || 'normal';
    this.cfg = opts.cfg || makeConfig(opts.mutators || [], { difficulty: this.difficulty, sandbox: opts.sandbox });
    if (!this.cfg.diff) this.cfg.diff = this.cfg.difficulty[this.difficulty] || this.cfg.difficulty.normal;
    this.sandbox = !!(opts.sandbox ?? this.cfg.sandbox);
    this.owners = Math.max(1, Math.min(2, opts.owners | 0 || 1));
    this.seed = (opts.seed ?? map.seed ?? hashStr(String(map.name || 'map'))) >>> 0;
    this.grid = opts.grid || buildGrid(map, this.cfg.sim.cell || 4, this.cfg);
    this.stageCount = Math.max(1, (map.levels || []).length);
    this.events = new Emitter();
    this.rng = new Rng(this.seed);
    this.tick = 0; this.t = 0; this.phase = 'planning'; this.speed = 1; this.stage = 0;
    this.units = []; this.projectiles = []; this.effects = []; this.vehicles = []; this.pickups = []; this.pits = [];
    this.budget = { cap: 0, spent: 0, owners: [] };
    this.sp = { cap: 0, spent: 0, owners: [] };
    this.charges = {};
    this.loadout = { units: [], abilities: {} };
    this.stats = freshStats();
    this.result = null;
    this.C = 0;
    this.largeMap = false;
    this.readyFlags = [false];
    this._cmds = new Map();
    this._systems = [];
    this._sysSeq = 0;
    this._ser = new Map();
    this._id = 1;
    this._onBreach = (k) => onBreach(this, k);
    this._releaseCivs = (st) => releaseCivs(this, st);
    this._onBlocks = () => { if (this.phase === 'battle') markWallAgents(this); };

    initNav(this);
    initZones(this);
    initFire(this);
    initStructures(this);
    initAgents(this, Math.max(4096, Math.min(1 << 17, ((this.cfg.sim.maxAgents || 90000) >> 2))));
    resetMutants(this);

    registerZoneCommands(this);
    registerStructureCommands(this);
    registerEconomyCommands(this);
    this._registerCoreCommands();
    installOrders(this);
    const sys = (name, update) => this.registerSystem({ name, update, order: SYSTEM_ORDER[name] });
    sys('hash', (w) => rebuildHash(w, (w.tick & 1) === 0));
    sys('nav', (w) => navSystem(w));
    sys('agents', (w, dt) => agentSystem(w, dt));
    sys('functions', (w, dt) => functionsSystem(w, dt));
    sys('mutants', (w) => mutantSystem(w));
    sys('fire', (w, dt) => fireSystem(w, dt));
    sys('level', (w, dt) => levelSystem(w, dt));

    this.beginStage(opts.stage || 0);
  }

  // ------------------------------------------------------------ agents
  spawn(type, x, y, sub = 0, tier = 0) { return spawnAgent(this, type, x, y, sub, tier); }
  remove(i) { removeAgent(this, i); }
  setType(i, type) { setType(this, i, type); }
  infect(i) { return infectAgent(this, i); }
  cure(i) { return cureAgent(this, i); }
  evacuate(i) { return evacuateAgent(this, i); }
  damageAgent(i, dmg, src) { return damageAgent(this, i, dmg, src); }
  // tier: TIER_SURFACE (ground and decks, the default), TIER_ALL, or one tier (-2..3); the same on maps without decks
  query(x, y, r, typeMask, fn, tier = TIER_SURFACE) { queryAgents(this, x, y, r, typeMask, fn, tier); }
  nearest(x, y, r, typeMask, tier = TIER_SURFACE) { return nearestAgent(this, x, y, r, typeMask, tier); }
  // the top tier at a point (air drops land there; 0 on the ground and on maps without decks)
  surfaceAt(x, y) { return surfaceAt(this, x, y); }
  zombieHp(sub = 0) { return zombieHp(this, sub); }
  armedStats(type, group = -1) { return armedStats(this, type, group); }
  setGroupStats(group, stats) { if (stats) this.groupStats[group] = stats; else delete this.groupStats[group]; }

  // ------------------------------------------------------------ map state
  costMul(x, y, owner = 0, b = -1) { return costMul(this, x, y, owner, b); }
  inZone(x, y) { return inZone(this, x, y); }
  buildingInZone(b) { return buildingInZone(this, b); }
  // Gate preview / warning: gateCheck(gateId) for a placed gate, gateCheck(x, y, owner) for a click. Returns
  // { ok, opens, warn, x, y, x0, y0, x1, y1 }: where the gate would sit on the true wall and whether it joins open
  // ground inside the zone to open ground outside (warn says why not: building, closed yard...).
  gateCheck(idOrX, y, owner = 0) { return gateCheck(this, idOrX, y, owner); }
  auraMul(x, y, kind) { return auraMul(this, x, y, kind); }
  hasSupply(x, y) { return hasSupply(this, x, y); }
  funcAllowed(b, func) { const bd = this.buildings[b]; return !!bd && funcAllowed(this, bd, func); }
  cellAt(x, y) {
    const g = this.grid, cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
    return cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh ? -1 : cy * g.gw + cx;
  }
  damageArea(x, y, r, dmg, o) { damageArea(this, x, y, r, dmg, o); }
  damageBuilding(b, dmg, src, dirX = 0, dirY = 0) {
    if (Array.isArray(dirX)) [dirX, dirY] = dirX;
    return damageBuilding(this, b, dmg, src, dirX, dirY);
  }
  collapseBuilding(b, dirX = 0, dirY = 0, src = 'collapse') { collapseBuilding(this, b, dirX, dirY, src); }
  damageBridge(id, dmg) { return damageBridge(this, id, dmg); }
  damageWallsArea(x, y, r, dmg) { damageWallsArea(this, x, y, r, dmg); }
  damageWallCell(c, dmg) { damageWallCell(this, c, dmg); }
  ignite(x, y, r, intensity = 1, src = null) { ignite(this, x, y, r, intensity, src); }
  addKill(srcKey = 'unknown', n = 1) { this.stats.killed += n; this.stats.killsBy[srcKey] = (this.stats.killsBy[srcKey] || 0) + n; }

  // Rescue pickups (bus, medevac): civilians path to them like to a gate. r = pickup radius in meters.
  addPickup(id, x, y, r = 12) {
    let p = this.pickups.find((q) => q.id === id);
    if (!p) { p = { id, x, y, r, fx: NaN, fy: NaN }; this.pickups.push(p); this.nav.civ.dirty = true; }
    p.x = x; p.y = y; p.r = r;
    return p;
  }
  removePickup(id) {
    const k = this.pickups.findIndex((q) => q.id === id);
    if (k >= 0) { this.pickups.splice(k, 1); this.nav.civ.dirty = true; }
  }

  // ------------------------------------------------------------ money
  nextId() { return this._id++; }
  available(owner = 0) { return available(this, owner); }
  canAfford(cost, owner = 0) { return canAfford(this, cost, owner); }
  spend(cost, owner = 0, key = 'other') { spend(this, cost, owner, key); }
  refundPlacement(item, key = 'other') { return refundPlacement(this, item, key); }
  refundValue(paid) { return (paid || 0) * refundRate(this); }

  // ------------------------------------------------------------ commands
  registerCommand(name, handler, quote) {
    if (typeof handler === 'function') this._cmds.set(name, { exec: (w, c) => handler(w, c), quote: quote || null, raw: true });
    else this._cmds.set(name, { exec: handler.exec, quote: handler.quote || quote || null, raw: !handler.quote && !quote });
  }

  quote(cmd) {
    const h = cmd && this._cmds.get(cmd.t);
    if (!h) return { ok: false, reason: 'Unknown command', cost: 0 };
    if (!h.quote) return { ok: true, cost: 0, reason: '' };
    const q = h.quote(this, cmd) || { ok: false, reason: '' };
    return { cost: 0, reason: '', ...q };
  }

  exec(cmd) {
    const h = cmd && this._cmds.get(cmd.t);
    if (!h) return { ok: false, reason: 'Unknown command' };
    let res;
    if (h.quote) {
      const q = h.quote(this, cmd);
      if (!q || !q.ok) return { reason: '', cost: 0, ...(q || {}), ok: false };
      res = h.exec(this, cmd, q);
    } else res = h.exec(this, cmd);
    res = res || { ok: false, reason: '' };
    if (res.ok && !NON_BOARD.has(cmd.t)) {
      const owner = cmd.owner | 0;
      if (this.phase === 'planning') for (let o = 0; o < this.readyFlags.length; o++) if (o !== owner) this.readyFlags[o] = false;
      this.events.emit('changed', { what: cmd.t });
    }
    return res;
  }

  _registerCoreCommands() {
    this.registerCommand('ready', {
      quote: (w) => (w.phase === 'planning' ? { ok: true, cost: 0 } : { ok: false, reason: 'Already running', cost: 0 }),
      exec: (w, cmd) => {
        const o = Math.min(w.owners - 1, Math.max(0, cmd.owner | 0));
        w.readyFlags[o] = cmd.ready !== false;
        const all = w.readyFlags.every(Boolean);
        if (all) startBattle(w);
        return { ok: true, started: all, ready: w.readyFlags.slice() };
      },
    });
    this.registerCommand('speed', {
      quote: (w, cmd) => (Number.isFinite(+cmd.s) ? { ok: true, cost: 0 } : { ok: false, reason: 'Bad speed', cost: 0 }),
      exec: (w, cmd) => { w.speed = Math.max(0, Math.min(8, +cmd.s)); return { ok: true, speed: w.speed }; },
    });
    this.registerCommand('refund.many', {
      quote: (w) => (w.phase === 'planning' || w.phase === 'battle' ? { ok: true, cost: 0 } : { ok: false, reason: 'Stage is over', cost: 0 }),
      exec: (w, cmd) => {
        const items = cmd.items || cmd;
        let refund = 0, count = 0, reason = '';
        for (const kind of Object.keys(REFUND_CMD)) {
          const ids = items[kind];
          if (!Array.isArray(ids)) continue;
          for (const id of ids) {
            const r = w.exec({ t: REFUND_CMD[kind], id, owner: cmd.owner | 0 });
            if (r.ok) { count++; refund += r.refund || 0; } else if (!reason) reason = r.reason || '';
          }
        }
        return { ok: count > 0, refund, count, reason: count ? '' : reason || 'Nothing to refund' };
      },
    });
  }

  // ------------------------------------------------------------ systems
  registerSystem(sys) {
    const s = { order: SYSTEM_ORDER.combat, ...sys, _seq: this._sysSeq++ };
    this._systems = this._systems.filter((q) => q.name !== s.name || !s.name);
    this._systems.push(s);
    this._systems.sort((a, b) => a.order - b.order || a._seq - b._seq);
  }

  registerSerializer(name, s) { this._ser.set(name, s); }

  step() {
    if (this.phase !== 'battle') return;
    const dt = this.cfg.sim.dt;
    this.tick++;
    this.t += dt;
    for (const s of this._systems) {
      s.update(this, dt);
      if (this.phase !== 'battle') break;
    }
    const t = this.t;
    for (const list of [this.projectiles, this.effects]) {
      let w = 0;
      for (let k = 0; k < list.length; k++) { const e = list[k]; if (e.t0 + (e.dur || 0) >= t) list[w++] = e; }
      list.length = w;
    }
  }

  beginStage(idx) { beginStage(this, idx); }
  computeFields() { computeFieldsNow(this); }
  placementsHash() { return placementsHash(this); }
  badgeFor(pct) { return badgeFor(this, pct); }

  // ------------------------------------------------------------ persistence
  snapshot() {
    const ser = {};
    for (const [name, s] of this._ser) ser[name] = s.save(this);
    return JSON.parse(JSON.stringify({
      v: 1, stage: this.stage, nextId: this._id,
      placements: savePlacements(this),
      funcs: this.buildings.filter((b) => b.func).map((b) => [b.idx, b.func, b.funcState.stance || 'pursue']),
      stances: this.buildings.filter((b) => !b.func && b.funcState.stance === 'hold').map((b) => b.idx),
      loadout: this.loadout, charges: this.charges, ser,
    }));
  }

  restore(snap) {
    if (!snap || !snap.placements) return false;
    const full = this.phase !== 'planning' || (snap.stage | 0) !== this.stage;
    loadPlacements(this, snap.placements);
    this._id = snap.nextId || this._id;
    this.loadout = { units: [...((snap.loadout && snap.loadout.units) || [])], abilities: { ...((snap.loadout && snap.loadout.abilities) || {}) } };
    for (const b of this.buildings) { b.func = null; b.funcState = { stance: 'pursue' }; }
    for (const idx of snap.stances || []) if (this.buildings[idx]) this.buildings[idx].funcState.stance = 'hold';
    for (const [name, s] of this._ser) s.load(this, snap.ser ? snap.ser[name] : undefined);
    if (full) beginStage(this, snap.stage | 0);
    else { rebuildZones(this); rebuildFeatureGrids(this); }
    for (const [idx, func, stance] of snap.funcs || []) {
      const b = this.buildings[idx];
      if (!b || !b.alive || b.zone < 0 || !funcAllowed(this, b, func)) continue;
      b.func = func; b.funcState = { stance };
    }
    refreshFunctions(this);
    this.charges = { ...(snap.charges || this.loadout.abilities) };
    this.sp.spent = abilitySp(this, this.loadout.abilities);
    recomputeSpent(this);
    this.events.emit('changed', { what: 'restore' });
    return true;
  }

  // Checksum of agents, placements, units and money for desync / determinism checks.
  hash() {
    let h = 2166136261 >>> 0;
    const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
    mix(this.tick); mix(['planning', 'battle', 'won', 'lost'].indexOf(this.phase)); mix(this.stage);
    const A = this.A, TR = this.grid.deck ? A.tier : null;
    for (let i = 0; i < A.n; i++) {
      const t = A.type[i];
      if (!t) continue;
      mix(i); mix(t); mix(A.sub[i]); mix(A.state[i]); mix(Math.round(A.x[i] * 16)); mix(Math.round(A.y[i] * 16));
      if (TR) mix(TR[i]);
    }
    for (const pl of this.zones.polys) { mix(pl.id); mix(pl.level); for (const v of pl.p) mix(Math.round(v * 10)); }
    for (const gt of this.zones.gates) { mix(gt.id); mix(Math.round(gt.hp)); }
    for (const w of this.walls) { mix(w.id); mix(w.cells.length); }
    for (const c of this.corridors) { mix(c.id); mix(Math.round(c.w)); }
    for (const ho of this.holds) { mix(ho.id); mix(Math.round(ho.R)); }
    for (const u of this.units) if (u) { mix(hashStr(String(u.type))); mix(Math.round((u.x || 0) * 10)); mix(Math.round((u.y || 0) * 10)); mix(u.level || 0); mix(u.alive === false ? 0 : 1); mix(u.kills || 0); }
    for (const b of this.buildings) if (!b.alive) mix(b.idx);
    mix(Math.round(this.budget.spent * 100)); mix(this.stats.killed); mix(this.stats.civEvac);
    // vehicles (boats, armour, aircraft): ids are left out because retry does not reset the counter that hands them out
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      mix(hashStr(String(v.kind))); mix(Math.round(v.x * 10)); mix(Math.round(v.y * 10)); mix(Math.round(v.hp || 0)); mix(v.loaded | 0);
      if (v.order) { mix(hashStr(String(v.order.kind))); mix(v.order.done ? 1 : 0); }
    }
    if (this.orders) this.orders.hash(mix);
    return h >>> 0;
  }
}
