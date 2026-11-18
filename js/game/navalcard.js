// Info card for a boat: hull, weapons, what it is doing (or why a ferry cannot work), its water, orders, kills.
import { esc, fmtInt, fmtMoney } from './el.js';

const ORDER_LABEL = { move: 'move to a point', hunt: 'hunt', hold: 'hold position', return: 'return to mooring' };

// card: the InfoCard (head(), session); u: the boat's unit; ui: { kv, bar, btn } helpers from infocard.js.
export function boatCard(card, u, ui) {
  const { kv, bar, btn } = ui, s = card.s, w = s.world, v = u.veh, def = w.cfg.units[u.type] || {};
  const lv = u.level || 1;
  const notches = Array.from({ length: 5 }, (_, k) => `<i class="${k < lv ? 'on' : ''}"></i>`).join('');
  let o = card.head(s.combat.unitName(u.type), `BOAT ${String(u.id).padStart(4, '0')}`, `<span class="rc-notches">${notches}</span> level ${lv} of 5`);
  const status = v ? s.combat.boatStatus(w, v) : '';
  const stranded = def.capacity && /no way out/.test(status);
  if (status) o += `<p class="small ${stranded ? 'red' : ''}">${esc(status)}</p>`;
  const st = s.combat.unitStats(w, u) || {};
  if (v) { o += kv('Hull', `${fmtInt(v.hp)} / ${fmtInt(v.hpMax)}`); o += bar(v.hpMax ? v.hp / v.hpMax : 0, v.hp < v.hpMax * 0.35 ? 'over' : ''); }
  if (st.speed) o += kv('Speed', `${(+st.speed).toFixed(1)} m/s`);
  if (def.capacity) {
    o += kv('Capacity', `${fmtInt(st.capacity || def.capacity)} residents`);
    if (v) { o += kv('Aboard', fmtInt(v.loaded || 0)); o += kv('Evacuated', fmtInt(v.saved || 0)); }
  } else {
    if (st.rockets) o += kv('Salvo', `${fmtInt(st.rockets)} rockets x ${(+st.dmg).toFixed(0)}`);
    else if (st.dmg) o += kv(st.splash ? 'Deck gun' : 'Machine gun', `${(+st.dmg).toFixed(st.dmg < 10 ? 1 : 0)} dmg`);
    if (st.rof) o += kv(st.rockets ? 'Reload' : 'Fire interval', `${(+st.rof).toFixed(st.rof < 1 ? 2 : 1)} s`);
    if (st.range) o += kv('Range', `${Math.round(st.range)} m${st.minRange ? ` (min ${Math.round(st.minRange)} m)` : ''}`);
    if (st.splash) o += kv('Blast radius', `${Math.round(st.splash)} m`);
    if (def.mgDmg) o += kv('Machine gun', `${def.mgDmg} dmg, ${Math.round(def.mgRange || 60)} m`);
    o += kv('Ammunition', 'unlimited');
  }
  const area = v ? s.combat.boatWater(w, v) : 0;
  if (area) o += kv('Water', `${fmtInt(area)} m&sup2;`);
  if (v && w.phase === 'battle') o += kv('Orders', v.order && ORDER_LABEL[v.order.kind] ? `${ORDER_LABEL[v.order.kind]}${v.order.done && v.order.kind !== 'hold' ? ' (done)' : ''}` : def.capacity ? 'none: runs the ferry' : 'none: patrols');
  const kills = u.kills || 0, paid = u.paid || 0;
  if (!def.capacity) { o += kv('Kills', fmtInt(kills)); o += kv('Cost per kill', kills ? fmtMoney(paid / kills) : '--'); }
  o += kv('Cost', fmtMoney(paid));
  if (!def.capacity && w.phase === 'planning') o += `<p class="small faint">Opens fire ${w.cfg.zone.outsideStartDelay} s after READY, like every unit outside the zones.</p>`;
  const over = w.phase === 'won' || w.phase === 'lost';
  let acts = '';
  if (def.ups && def.ups.length) {
    const q = w.quote({ t: 'unit.upgrade', id: u.id, owner: s.owner }), nx = s.combat.nextUpgradeStat(u);
    acts += btn('upgrade', lv >= 5 ? 'Max level' : q.ok ? `Upgrade ${fmtMoney(q.cost)}` : 'Upgrade',
      { disabled: !q.ok || over, title: q.ok ? (nx ? `${nx[0]} x${nx[1]}` : '') : q.reason, key: s.prefs.keyLabel('upgrade') });
    if (nx && lv < 5) o += kv('Next level', `${esc(nx[0])} x${nx[1]}`);
  }
  const rq = w.quote({ t: 'unit.refund', id: u.id, owner: s.owner });
  const back = rq.ok ? (rq.refund !== undefined ? rq.refund : w.refundValue(paid)) : 0;
  acts += btn('refund', rq.ok ? (back > 0 ? `Refund ${fmtMoney(back)}` : 'Scrap') : 'Refund', { cls: 'btn-ghost', disabled: !rq.ok || over, title: rq.ok ? '' : rq.reason });
  o += `<div class="rc-acts">${acts}</div>`;
  return o;
}
