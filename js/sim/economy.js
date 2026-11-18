// Money (budget), command points (SP), spending/refunds and placement pricing multipliers.
import { inZone, buildingInZone } from './zones.js';

export function nominalPop(world) {
  const pc = world.cfg.population, g = world.grid, mask = world.region.mask;
  let C = 0;
  for (const b of world.buildings) {
    const cx = Math.floor(b.cx / g.cell), cy = Math.floor(b.cy / g.cell);
    if (cx < 0 || cy < 0 || cx >= g.gw || cy >= g.gh || !mask[cy * g.gw + cx]) continue;
    const km = pc.kindMul[b.k];
    C += b.area * pc.perM2 * (km === undefined ? 1 : km);
  }
  return C;
}

export function computeCaps(world) {
  const e = world.cfg.economy, d = world.cfg.diff, C = world.C, owners = world.owners;
  const money = world.sandbox ? e.sandboxMoney : Math.round((e.moneyBase + e.moneyMax * C / (C + e.moneyHalf)) * (d.moneyMul || 1));
  const sp = world.sandbox ? e.sandboxSP : Math.max(0, Math.round((e.spBase + e.spPerLevel * world.stage + e.spPerSqrt10k * Math.floor(Math.sqrt(C / 10000))) * (d.spMul || 1)));
  world.budget.cap = money;
  world.sp.cap = sp;
  for (let o = 0; o < owners; o++) {
    world.budget.owners[o] = world.budget.owners[o] || { cap: 0, spent: 0 };
    world.budget.owners[o].cap = money / owners;
    world.sp.owners[o] = world.sp.owners[o] || { cap: 0, spent: 0 };
    world.sp.owners[o].cap = Math.floor(sp / owners);
  }
}

function ownerSlot(world, owner) { return world.budget.owners[Math.min(Math.max(owner | 0, 0), world.owners - 1)]; }

export function available(world, owner = 0) {
  if (world.sandbox) return Infinity;
  const o = ownerSlot(world, owner);
  return o ? o.cap - o.spent : world.budget.cap - world.budget.spent;
}

export function canAfford(world, cost, owner = 0) {
  if (world.sandbox || !(cost > 0)) return true;
  return cost <= available(world, owner) + 1e-6;
}

export function spend(world, cost, owner = 0, key = 'other') {
  if (!cost) return;
  world.budget.spent += cost;
  const o = ownerSlot(world, owner);
  if (o) o.spent += cost;
  world.stats.spentBy[key] = (world.stats.spentBy[key] || 0) + cost;
}

export function refundRate(world) {
  const e = world.cfg.economy;
  return world.phase === 'planning' ? e.planningRefund : e.battleRefund;
}

// Removes `item.paid` from the books at the current refund rate. Returns the money given back.
export function refundPlacement(world, item, key = 'other') {
  const amount = (item.paid || 0) * refundRate(world);
  if (amount) {
    world.budget.spent -= amount;
    const o = ownerSlot(world, item.owner);
    if (o) o.spent -= amount;
    world.stats.spentBy[key] = (world.stats.spentBy[key] || 0) - amount;
  }
  return amount;
}

// "Spent" at the start of a stage = what every current placement cost.
export function recomputeSpent(world) {
  const by = {};
  const owners = world.budget.owners;
  for (const o of owners) o.spent = 0;
  let total = 0;
  const add = (key, item, paid) => {
    if (!paid) return;
    total += paid;
    by[key] = (by[key] || 0) + paid;
    const o = ownerSlot(world, item.owner);
    if (o) o.spent += paid;
  };
  for (const pl of world.zones.polys) { add('zone', pl, pl.paid); add('wallUpgrade', pl, pl.upPaid); }
  for (const g of world.zones.gates) add('gate', g, g.paid);
  for (const w of world.walls) add('wall', w, w.paid);
  for (const c of world.corridors) add('corridor', c, c.paid);
  for (const h of world.holds) add('hold', h, h.paid);
  for (const u of world.units) if (u && u.alive !== false) add(u.type || 'unit', u, u.paid);
  world.budget.spent = total;
  world.stats.spentBy = by;
}

export function abilitySp(world, abilities) {
  let s = 0;
  for (const id in abilities || {}) {
    const a = world.cfg.abilities[id];
    if (a) s += Math.max(0, abilities[id] | 0) * a.sp;
  }
  return s;
}

// Multiplier for unit prices at (x,y): outside-zone surcharge, Budget (zone) and Reduced-cost (radius) discounts.
export function costMul(world, x, y, owner = 0, b = -1) {
  const zc = world.cfg.zone;
  const comp = b >= 0 ? buildingInZone(world, b) : inZone(world, x, y);
  let m = 1;
  if (comp < 0) m *= zc.outsideCostMul;
  else for (const a of world.auras.budget) if (a.zone === comp) m *= a.mul;
  for (const a of world.auras.reducedCost) {
    const dx = a.x - x, dy = a.y - y;
    if (dx * dx + dy * dy <= a.r * a.r) m *= a.mul;
  }
  return m;
}

export function registerEconomyCommands(world) {
  world.registerCommand('loadout.set', {
    quote(w, cmd) {
      if (w.phase !== 'planning') return { ok: false, reason: 'Loadout can only change during planning', cost: 0 };
      const units = Array.isArray(cmd.units) ? cmd.units : w.loadout.units;
      if (units.length > (w.cfg.loadoutSlots || 7)) return { ok: false, reason: `At most ${w.cfg.loadoutSlots || 7} unit slots`, cost: 0 };
      for (const u of units) if (u && !w.cfg.units[u]) return { ok: false, reason: `Unknown unit ${u}`, cost: 0 };
      const ab = cmd.abilities || w.loadout.abilities || {};
      for (const id in ab) if (!w.cfg.abilities[id]) return { ok: false, reason: `Unknown ability ${id}`, cost: 0 };
      const sp = abilitySp(w, ab);
      if (!w.sandbox && sp > w.sp.cap) return { ok: false, reason: 'Not enough command points', cost: sp };
      return { ok: true, cost: 0, sp };
    },
    exec(w, cmd, q) {
      if (Array.isArray(cmd.units)) w.loadout.units = cmd.units.slice(0, w.cfg.loadoutSlots || 7);
      if (cmd.abilities) {
        const ab = {};
        for (const id in cmd.abilities) { const n = Math.max(0, cmd.abilities[id] | 0); if (n) ab[id] = n; }
        w.loadout.abilities = ab;
        w.charges = { ...ab };
      }
      w.sp.spent = q.sp;
      return { ok: true, sp: q.sp };
    },
  });
}
