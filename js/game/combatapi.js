// Thin adapter over the combat module (js/sim/units.js): names, stats and pricing for the UI,
// with config-based fallbacks so the client keeps working when a helper is missing.
import { stat } from '../data/config.js';

const NAMES = {
  garrison: 'Garrison', sniper: 'Sniper', turret: 'Turret', mortar: 'Mortar', gasMortar: 'Gas Mortar', fireMortar: 'Fire Mortar',
  mlrs: 'Rocket Battery', howitzer: 'Howitzer', battleship: 'Battleship', railgun: 'Railgun', mine: 'Mines', chemical: 'Chemical Trap',
  napalm: 'Napalm Trap', c4: 'C4 Charge', spikes: 'Spike Strip', oil: 'Oil Slick',
  paratroopers: 'Paratroopers', callToArms: 'Call to Arms', seekDestroy: 'Seek & Destroy', apc: 'APC', bus: 'Security Bus',
  medevac: 'Medevac', bulldozer: 'Bulldozer', rally: 'Rally', demolition: 'Demolition', fireBomb: 'Fire Bomb', cruise: 'Cruise Missile',
  helicopter: 'Helicopter', gasBomb: 'Gas Bomb', tank: 'Tank', airstrike: 'Airstrike', clusterBomb: 'Cluster Bomb', gunship: 'Gunship',
  cure: 'Cure', nuke: 'Nuclear Strike',
};
const SHORT = { garrison: 'Garrison', sniper: 'Marksman', turret: 'Sentry Gun', mortar: 'Mortar', gasMortar: 'Gas Mortar', fireMortar: 'Fire Mortar',
  mlrs: 'Rockets', howitzer: 'Howitzer', battleship: 'Battleship', railgun: 'Railgun', mine: 'Mines', chemical: 'Gas Trap', napalm: 'Napalm',
  c4: 'Charge', spikes: 'Spikes', oil: 'Oil Slick',
  paratroopers: 'Paras', callToArms: 'To Arms', seekDestroy: 'Seek', apc: 'APC', bus: 'Bus', medevac: 'Medevac', bulldozer: 'Dozer', rally: 'Rally',
  demolition: 'Demolish', fireBomb: 'Fire Bomb', cruise: 'Missile', helicopter: 'Heli', gasBomb: 'Gas Bomb', tank: 'Tank', airstrike: 'Airstrike',
  clusterBomb: 'Cluster', gunship: 'Gunship', cure: 'Cure', nuke: 'Nuke' };

const titleCase = (s) => String(s).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function infoOf(table, id) {
  if (!table) return null;
  const v = table[id];
  if (v == null) return null;
  return typeof v === 'string' ? { name: v } : v;
}

export async function loadCombat() {
  let mod = null, error = null;
  try { mod = await import('../sim/units.js'); } catch (e) { error = e; }
  return new CombatApi(mod, error);
}

export class CombatApi {
  constructor(mod, error = null) {
    this.mod = mod;
    this.error = error;
    this.ok = !!(mod && typeof mod.installCombat === 'function');
  }

  install(world) {
    if (!this.ok) return false;
    this.mod.installCombat(world);
    return true;
  }

  _call(name, ...args) {
    const f = this.mod && this.mod[name];
    if (typeof f !== 'function') return undefined;
    try { return f(...args); } catch (e) { return undefined; }
  }

  unitName(type) { const i = infoOf(this.mod && this.mod.UNIT_INFO, type); return (i && (i.name || i.label || i.title)) || NAMES[type] || titleCase(type); }
  unitShort(type) { const i = infoOf(this.mod && this.mod.UNIT_INFO, type); return (i && i.short) || SHORT[type] || this.unitName(type); }
  unitDesc(type) { const i = infoOf(this.mod && this.mod.UNIT_INFO, type); return (i && (i.desc || i.description || i.blurb || i.text)) || ''; }
  abilityName(id) { const i = infoOf(this.mod && this.mod.ABILITY_INFO, id); return (i && (i.name || i.label || i.title)) || NAMES[id] || titleCase(id); }
  abilityShort(id) { const i = infoOf(this.mod && this.mod.ABILITY_INFO, id); return (i && i.short) || SHORT[id] || this.abilityName(id); }
  abilityDesc(id) { const i = infoOf(this.mod && this.mod.ABILITY_INFO, id); return (i && (i.desc || i.description || i.blurb || i.text)) || ''; }

  // Range in metres of a placed unit (with auras), or a config estimate.
  unitRange(world, u) {
    const r = this._call('unitRange', world, u);
    if (Number.isFinite(r)) return r;
    const c = world.cfg.units[u.type];
    if (!c || c.range === undefined) return 0;
    const b = u.b >= 0 ? world.buildings[u.b] : null;
    return +stat(c.range, b || { h: 10 }) || 0;
  }

  minRange(world, u) {
    const s = this.unitStats(world, u);
    if (s && Number.isFinite(s.minRange)) return s.minRange;
    const c = world.cfg.units[u.type];
    return (c && +c.minRange) || 0;
  }

  unitStats(world, u) {
    const s = this._call('unitStats', world, u);
    if (s && typeof s === 'object') return s;
    const c = world.cfg.units[u.type] || {};
    const b = u.b >= 0 ? world.buildings[u.b] : null;
    const out = {};
    for (const k of ['dmg', 'rof', 'mag', 'reloads', 'reloadSec', 'splash', 'stunSec', 'minRange', 'rockets', 'shells', 'hp']) if (c[k] !== undefined) out[k] = stat(c[k], b);
    out.range = this.unitRange(world, u);
    return out;
  }

  upgradeCost(world, u) {
    if (!this.mod || typeof this.mod.upgradeCost !== 'function') return null;
    const v = this._call('upgradeCost', world, u);
    return Number.isFinite(v) ? v : null;
  }

  nextUpgradeStat(u) {
    const v = this._call('nextUpgradeStat', u);
    return Array.isArray(v) ? v : null;
  }

  // Unit under a world point (building units by their building, lines by distance); r in metres.
  unitAt(world, x, y, r = 6) {
    if (this.mod && typeof this.mod.unitAt === 'function') { try { return this.mod.unitAt(world, x, y, r) || null; } catch (e) { /* fallback */ } }
    let best = null, bd = r;
    for (const u of world.units) {
      if (!u || u.alive === false) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d <= bd) { bd = d; best = u; }
    }
    return best;
  }

  unitsInRect(world, x0, y0, x1, y1) {
    if (this.mod && typeof this.mod.unitsInRect === 'function') { try { return this.mod.unitsInRect(world, x0, y0, x1, y1) || []; } catch (e) { /* fallback */ } }
    return world.units.filter((u) => u && u.alive !== false && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1);
  }

  canPlace(world, type, x, y, owner = 0) { return this._call('canPlace', world, type, x, y, owner) || null; }

  // Why a unit cannot be used anywhere on this stage (water units on dry maps), '' when it can.
  unitBlocked(world, type) { const r = this._call('unitBlocked', world, type); return typeof r === 'string' ? r : ''; }

  // Boat helpers for the info card: status line, water area, and whether a ferry has somewhere to land.
  boatStatus(world, v) { return this._call('boatStatus', world, v) || ''; }
  boatWater(world, v) { return +this._call('waterOf', world, v) || 0; }

  abilityState(world, id) {
    const s = this._call('abilityState', world, id);
    if (s && typeof s === 'object') return { charges: s.charges | 0, unlockIn: Math.max(0, +s.unlockIn || 0), ready: !!s.ready, ...s };
    const a = world.cfg.abilities[id] || {};
    const charges = (world.charges && world.charges[id]) | 0;
    const unlockIn = world.phase === 'battle' ? Math.max(0, (a.unlock || 0) - world.t) : a.unlock || 0;
    return { charges, unlockIn, ready: this.ok && world.phase === 'battle' && charges > 0 && unlockIn <= 0 };
  }

  // Display price for a toolbar slot: exact for flat prices, "from" for height- or count-scaled ones.
  basePrice(world, type, owner = 0) {
    const c = world.cfg.units[type];
    if (!c) return { cost: 0, from: false };
    if (typeof c.cost !== 'function') return { cost: +c.cost || 0, from: false, perM: !!c.perM };
    if (c.cost.length >= 2) {
      let n = 0;
      for (const u of world.units) if (u && u.alive !== false && u.type === type && (world.owners < 2 || u.owner === owner)) n++;
      return { cost: +c.cost(world, n) || 0, from: false };
    }
    return { cost: +c.cost({ h: 4, area: 100 }) || 0, from: true };
  }

  // Estimated range of a unit about to be placed (for the cursor preview ring).
  previewRange(world, type, b = null) {
    const c = world.cfg.units[type];
    if (!c || c.range === undefined) return 0;
    let r = +stat(c.range, b || { h: 10 }) || 0;
    return r;
  }
}

export const UNIT_FALLBACK_NAMES = NAMES;
