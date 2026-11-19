// Selection info card: buildings, units, safe zones, bridges, squads and the smaller placements.
import { esc, fmtInt, fmtMoney, setHTML } from './el.js';
import { KIND_LABEL, KIND_TAG } from '../map/format.js';
import { HEIGHT_LABELS, heightClass } from '../render/palette.js';
import { boatCard } from './navalcard.js';

const FUNC_LABEL = { police: 'Police', militia: 'Militia', broadcast: 'Broadcast', radio: 'Radio', budget: 'Budget office', reducedCost: 'Reduced cost',
  repair: 'Repair crews', supply: 'Supply depot', commandPost: 'Command post', medic: 'Medic', airlift: 'Airlift' };
const FUNC_DESC = {
  police: 'An officer every 2 s, up to 100.', militia: 'On a breach, armed citizens rise nearby.', broadcast: 'Civilians within 600 m head for a gate.',
  radio: '+50% range for units within 250 m.', budget: 'Units placed in this zone cost 20% less.', reducedCost: 'Units placed within 47 m cost 60% less.',
  repair: 'This zone\'s walls regain 40 HP/s.', supply: 'Reloads twice as fast within 250 m; turrets restock.', commandPost: '+30% fire rate within 250 m.',
  medic: 'Cures turning civilians, heals armed people inside the zone.', airlift: 'Flies 5 civilians out every 20 s.',
};
const STAT_ROWS = [
  ['dmg', 'Damage', (v) => (+v).toFixed(v < 10 ? 1 : 0)], ['rof', 'Fire interval', (v) => `${(+v).toFixed(2)} s`], ['range', 'Range', (v) => `${Math.round(v)} m`],
  ['minRange', 'Min. range', (v) => `${Math.round(v)} m`], ['splash', 'Blast radius', (v) => `${(+v).toFixed(0)} m`], ['stunSec', 'Stun', (v) => `${(+v).toFixed(1)} s`],
  ['rockets', 'Rockets', (v) => fmtInt(v)], ['shells', 'Shells / salvo', (v) => fmtInt(v)], ['reloadSec', 'Reload time', (v) => `${(+v).toFixed(1)} s`],
];
const num = (v) => (v === Infinity ? 'unlimited' : Number.isFinite(+v) ? fmtInt(+v) : '--');
const kv = (k, v, cls = '') => `<div class="kv ${cls}"><span>${esc(k)}</span><i></i><b>${v}</b></div>`;
const bar = (f, cls = '') => `<div class="meter thin ${cls}" style="--v:${Math.max(0, Math.min(1, f)).toFixed(3)}"><i class="meter-fill"></i></div>`;
const btn = (act, label, o = {}) => `<button type="button" class="btn btn-sm ${o.cls || ''}" data-act="${act}"${o.arg !== undefined ? ` data-arg="${esc(o.arg)}"` : ''}${o.disabled ? ' disabled' : ''}${o.title ? ` title="${esc(o.title)}"` : ''}>${label}${o.key ? ` <span class="keycap">${esc(o.key)}</span>` : ''}</button>`;

export class InfoCard {
  constructor(session, el) {
    this.s = session;
    this.el = el;
    this.sel = null;
    this.pressed = false;
    this._t = 0;
    el.addEventListener('pointerdown', () => { this.pressed = true; });
    window.addEventListener('pointerup', this._up = () => { this.pressed = false; });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      this.act(b.getAttribute('data-act'), b.getAttribute('data-arg'));
    });
  }

  destroy() { window.removeEventListener('pointerup', this._up); }

  show(sel) { this.sel = sel; this.render(true); }

  frame(dt) {
    this._t += dt;
    if (this._t < 0.25) return;
    this._t = 0;
    if (!this.pressed) this.render(false);
  }

  render() {
    const sel = this.sel;
    if (!sel) { setHTML(this.el, ''); this.el.hidden = true; return; }
    let html = '';
    try { html = this[`_${sel.kind}`] ? this[`_${sel.kind}`](sel) : ''; } catch (e) { console.error(e); html = ''; }
    if (!html) { this.s.select(null); return; }
    this.el.hidden = false;
    setHTML(this.el, `<div class="card rc-card">${html}</div>`);
  }

  head(title, no, sub = '') {
    return `<div class="card-head"><h3 class="card-title">${esc(title)}</h3><span class="card-no">${esc(no)}</span><button type="button" class="rc-x" data-act="close" title="Close">x</button></div>${sub ? `<div class="rc-card-sub">${sub}</div>` : ''}`;
  }

  // ---------------------------------------------------------------- buildings
  _building(sel) {
    const s = this.s, w = s.world, b = w.buildings[sel.b];
    if (!b) return '';
    const map = w.map.buildings[sel.b] || {};
    const title = map.name || b.use || KIND_LABEL[b.k] || 'Building';
    const tag = KIND_TAG[b.k];
    const sub = `${esc(KIND_LABEL[b.k] || b.k)}${tag ? ` <span class="rc-tag">${tag}</span>` : ''}`;
    let o = this.head(title, `BLDG ${String(sel.b).padStart(5, '0')}`, sub);
    o += kv('Height', `${Math.round(b.h)} m <span class="faint">(${HEIGHT_LABELS[heightClass(b.h)]})</span>`);
    o += kv('Footprint', `${fmtInt(b.area)} m&sup2;`);
    if (!b.alive) o += `<p class="rc-stampline"><span class="stamp stamp-sm">Collapsed</span></p>`;
    else {
      o += kv('Structure', `${fmtInt(b.hp)} / ${fmtInt(b.hpMax)}`);
      o += bar(b.hp / b.hpMax, b.hp < b.hpMax * 0.35 ? 'over' : '');
    }
    const zone = w.buildingInZone(sel.b);
    o += kv('Zone', zone >= 0 ? `inside zone ${zone + 1}` : b.zone >= 0 ? `zone ${b.zone + 1} (breached)` : 'outside');
    if (b.burning) o += kv('Status', '<span class="red">burning</span>');
    const unit = w.units.find((u) => u && u.alive !== false && u.b === sel.b);
    if (unit) o += `<div class="rc-row">${kv('Occupied', esc(`${s.combat.unitName(unit.type)} L${unit.level || 1}`))}${btn('selunit', 'Open', { arg: unit.id })}</div>`;
    const spec = w.cfg.specials[b.k];
    if (spec && b.alive) {
      o += `<div class="rc-sec">Function <span class="faint">(${esc(spec.label)})</span></div>`;
      const can = zone >= 0;
      if (!can) o += '<p class="small faint">Draw a safe zone around this building to assign a function. Choosing is free.</p>';
      o += '<div class="rc-funcs">';
      for (const f of spec.functions) {
        const on = b.func === f;
        o += `<button type="button" class="rc-func${on ? ' is-on' : ''}" data-act="func" data-arg="${f}"${can ? '' : ' disabled'}><b>${esc(FUNC_LABEL[f] || f)}</b><span>${esc(FUNC_DESC[f] || '')}</span></button>`;
      }
      o += '</div>';
      if (b.func) o += btn('func', 'Clear function', { arg: '', cls: 'btn-ghost' });
      if (b.func === 'police') {
        const fs = b.funcState || {};
        const officers = this.countGroup(sel.b);
        o += kv('Officers', `${officers} on duty, ${fs.spawned || 0} of ${w.cfg.functions.police.max} sent`);
        o += `<div class="seg rc-stance"><button type="button" data-act="stance" data-arg="pursue" class="${fs.stance !== 'hold' ? 'is-on' : ''}">Pursue</button><button type="button" data-act="stance" data-arg="hold" class="${fs.stance === 'hold' ? 'is-on' : ''}">Hold</button></div>`;
      }
    }
    if (b.alive && !unit && w.phase !== 'won' && w.phase !== 'lost') {
      const types = (w.loadout.units || []).filter((t) => t && w.cfg.units[t] && /building/.test(w.cfg.units[t].mount));
      if (types.length && s.combat.ok) {
        o += '<div class="rc-sec">Place here</div><div class="rc-place">';
        for (const t of types) {
          const q = w.quote({ t: 'unit.place', type: t, x: b.cx, y: b.cy, b: sel.b, owner: s.owner });
          o += btn('place', `${esc(s.combat.unitShort(t))} ${q.ok ? fmtMoney(q.cost) : ''}`, { arg: t, disabled: !q.ok, title: q.ok ? '' : q.reason });
        }
        o += '</div>';
      }
    }
    return o;
  }

  countGroup(g) {
    const A = this.s.world.A;
    let n = 0;
    for (let i = 0; i < A.n; i++) if (A.type[i] >= 4 && A.group[i] === g) n++;
    return n;
  }

  // ---------------------------------------------------------------- units
  _unit(sel) {
    const s = this.s, w = s.world, u = w.units.find((q) => q && q.id === sel.id);
    if (!u || u.alive === false) return '';
    if ((w.cfg.units[u.type] || {}).boat) return boatCard(this, u, { kv, bar, btn });
    const name = s.combat.unitName(u.type);
    const lv = u.level || 1;
    const notches = Array.from({ length: 5 }, (_, k) => `<i class="${k < lv ? 'on' : ''}"></i>`).join('');
    // several units on one roof (a crew and a demolition charge): "1 of 2" steps to the next
    const roof = u.b >= 0 ? w.units.filter((q) => q && q.alive !== false && q.b === u.b) : [];
    const k = roof.indexOf(u);
    const step = roof.length > 1 ? ` ${btn('selunit', `${k + 1} of ${roof.length} &rsaquo;`, { arg: roof[(k + 1) % roof.length].id, cls: 'btn-ghost rc-step', title: 'Next unit on this building' })}` : '';
    let o = this.head(name, `UNIT ${String(u.id).padStart(4, '0')}`, `<span class="rc-notches">${notches}</span> level ${lv} of 5${step}`);
    const st = s.combat.unitStats(w, u) || {};
    for (const [k, label, f] of STAT_ROWS) if (st[k] !== undefined && st[k] !== null && st[k] !== 0 && Number.isFinite(+st[k])) o += kv(label, f(st[k]));
    const inZone = u.b >= 0 ? w.buildingInZone(u.b) >= 0 : w.inZone(u.x, u.y) >= 0;
    if (u.mag !== undefined || st.mag !== undefined) {
      const mag = st.mag === Infinity || u.mag === Infinity ? 'unlimited' : `${num(u.mag)} / ${num(st.mag)}`;
      o += kv('Magazine', mag);
    }
    if (u.reloads !== undefined || st.reloads !== undefined) {
      const unl = st.reloads === Infinity || (inZone && !(w.cfg.units[u.type] || {}).noZoneReload && u.type !== 'turret');
      o += kv('Reloads left', unl ? 'unlimited' : num(u.reloads));
    }
    if (u.reloadT > 0) o += kv('Reloading', `${(+u.reloadT).toFixed(1)} s`);
    if (u.hpMax > 0) { o += kv('Armour', `${fmtInt(u.hp)} / ${fmtInt(u.hpMax)}`); o += bar(u.hp / u.hpMax); }
    const kills = u.kills || 0, paid = u.paid || 0;
    o += kv('Kills', fmtInt(kills));
    o += kv('Cost', fmtMoney(paid));
    o += kv('Cost per kill', kills ? fmtMoney(paid / kills) : '--');
    o += `<p class="small ${inZone ? 'green' : 'faint'}">${inZone ? 'Inside a safe zone: full reloads, fires at once.' : 'Outside the zones: limited reloads, opens fire after a delay.'}</p>`;
    const over = w.phase === 'won' || w.phase === 'lost';
    const cfgU = w.cfg.units[u.type] || {};
    let acts = '';
    if (cfgU.ups && cfgU.ups.length) {
      const q = w.quote({ t: 'unit.upgrade', id: u.id, owner: s.owner });
      const nx = s.combat.nextUpgradeStat(u);
      const label = lv >= 5 ? 'Max level' : q.ok ? `Upgrade ${fmtMoney(q.cost)}` : 'Upgrade';
      acts += btn('upgrade', label, { disabled: !q.ok || over, title: q.ok ? (nx ? `${nx[0]} x${nx[1]}` : '') : q.reason, key: s.prefs.keyLabel('upgrade') });
      if (nx && lv < 5) o += kv('Next level', `${esc(nx[0])} x${nx[1]}`);
    }
    if (cfgU.manual || u.type === 'c4') acts += btn('detonate', 'Detonate', { cls: 'btn-primary', disabled: w.phase !== 'battle', key: s.prefs.keyLabel('detonate') });
    const rq = w.quote({ t: 'unit.refund', id: u.id, owner: s.owner });
    const back = rq.ok ? (rq.refund !== undefined ? rq.refund : w.refundValue(paid)) : 0;
    acts += btn('refund', rq.ok ? (back > 0 ? `Refund ${fmtMoney(back)}` : 'Remove') : 'Refund', { cls: 'btn-ghost', disabled: !rq.ok || over, title: rq.ok ? '' : rq.reason });
    o += `<div class="rc-acts">${acts}</div>`;
    return o;
  }

  // ---------------------------------------------------------------- safe zones
  _zone(sel) {
    const s = this.s, w = s.world, c = w.zones.comps[sel.comp];
    if (!c) return '';
    let o = this.head(`Safe zone ${c.id + 1}`, `ZONE ${String(c.id + 1).padStart(2, '0')}`, c.breached ? '<span class="stamp stamp-sm tilt-2">Breached</span>' : '<span class="green">holding</span>');
    const wc = w.cfg.wall, lm = wc.levelHpMul, full = wc.hp * (lm[c.wallLevel - 1] || 1);
    let hp = 0, down = 0;
    for (const cell of c.wallCells) { if (w.block[cell] === 1) { hp += Math.max(0, w.wallHp[cell]); if (w.wallHp[cell] <= 0) down++; } }
    const n = c.wallCells.length || 1;
    const integ = hp / (full * n);
    o += kv('Wall level', `${c.wallLevel} of ${lm.length}`);
    o += kv('Wall integrity', `${Math.round(integ * 100)}%${down ? ` <span class="red">(${down} cells down)</span>` : ''}`);
    o += bar(integ, integ < 0.4 ? 'over' : integ < 0.75 ? 'warn' : 'go');
    const gates = w.zones.gates.filter((g) => g.comp === c.id);
    o += kv('Gates', gates.length ? `${gates.length} (${gates.filter((g) => g.hp <= 0).length} broken)` : '<span class="red">none: nobody can enter</span>');
    o += kv('Area', `${fmtInt(c.interiorCells.length * w.grid.cell * w.grid.cell)} m&sup2;`);
    o += kv('Buildings inside', fmtInt(c.bldgs.length));
    if (w.phase !== 'planning') o += kv('Civilians inside', fmtInt(this.civsIn(c.id)));
    const specials = c.bldgs.filter((b) => w.buildings[b].special);
    if (specials.length) o += kv('Special buildings', `${specials.length} (${specials.filter((b) => w.buildings[b].func).length} assigned)`);
    const over = w.phase === 'won' || w.phase === 'lost';
    let acts = '';
    const uq = w.quote({ t: 'zone.upgrade', compId: c.id, owner: s.owner });
    acts += btn('zoneup', c.wallLevel >= lm.length ? 'Walls at top level' : uq.ok ? `Upgrade walls ${fmtMoney(uq.cost)}` : 'Upgrade walls', { disabled: !uq.ok || over, title: uq.ok ? `HP x${lm[c.wallLevel]}` : uq.reason });
    const polys = w.zones.polys.filter((p) => p.comp === c.id).map((p) => p.id);
    const back = w.phase === 'planning' ? polys.reduce((a, id) => { const p = w.zones.polys.find((q) => q.id === id); return a + w.refundValue((p.paid || 0) + (p.upPaid || 0)); }, 0) : 0;
    acts += btn('zonerefund', back > 0 ? `Refund ${fmtMoney(back)}` : 'Remove zone', { cls: 'btn-ghost', disabled: over, arg: polys.join(',') });
    o += `<div class="rc-acts">${acts}</div>`;
    return o;
  }

  civsIn(comp) {
    const w = this.s.world, A = w.A, g = w.grid, id = comp + 1;
    let n = 0;
    for (let i = 0; i < A.n; i++) {
      if (A.type[i] !== 1) continue;
      if (w.zoneId[Math.floor(A.y[i] / g.cell) * g.gw + Math.floor(A.x[i] / g.cell)] === id) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- bridges
  _bridge(sel) {
    const w = this.s.world, br = w.bridges[sel.id];
    if (!br) return '';
    const road = sel.road >= 0 ? w.map.roads[sel.road] : null;
    let o = this.head((road && road.name) || (br.deck ? 'Overpass' : 'Bridge'), `${br.deck ? 'DECK' : 'SPAN'} ${String(sel.id + 1).padStart(3, '0')}`, br.alive ? 'standing' : '<span class="red">destroyed</span>');
    if (br.deck) o += kv('Overpass', `level ${br.tier || 1}`);
    o += kv('Span', `${Math.round(br.len)} m`);
    o += kv('Deck width', `${Math.round(br.width)} m`);
    const f = br.hpMax ? br.hp / br.hpMax : 0;
    o += kv('Structural integrity', `${Math.round(f * 100)}%`);
    o += bar(f, f < 0.35 ? 'over' : f < 0.7 ? 'warn' : 'go');
    o += kv('Rating', `${fmtInt(br.hp)} / ${fmtInt(br.hpMax)} HP`);
    o += br.deck ? '<p class="small faint">Explosives do double damage to overpasses. Whoever is on a fallen deck falls with it; the ground under it turns to rubble.</p>'
      : '<p class="small faint">Explosives do double damage to bridges. Falling buildings hit them too.</p>';
    return o;
  }

  // ---------------------------------------------------------------- squads
  _squad(sel) {
    const s = this.s, w = s.world, A = w.A;
    let n = 0, ammo = 0, hunt = 0, type = 6;
    for (let i = 0; i < A.n; i++) {
      if (A.type[i] < 4 || A.group[i] !== sel.group) continue;
      n++; type = A.type[i];
      if (A.ammo[i] > 0) ammo += A.ammo[i];
      if (A.state[i] === 1) hunt++;
    }
    if (!n) return '';
    const label = type === 4 ? 'Police officers' : type === 5 ? 'Militia' : 'Squad';
    let o = this.head(label, `GROUP ${String(sel.group).padStart(4, '0')}`, `${n} active`);
    o += kv('Strength', fmtInt(n));
    if (ammo) o += kv('Rounds carried', fmtInt(ammo));
    const huntMode = hunt * 2 >= n;
    o += kv('Orders', huntMode ? 'hunt' : 'guard');
    if (type === 6) {
      o += `<div class="seg rc-stance"><button type="button" data-act="squad" data-arg="hunt" class="${huntMode ? 'is-on' : ''}">Hunt</button><button type="button" data-act="squad" data-arg="guard" class="${huntMode ? '' : 'is-on'}">Guard</button></div>`;
      o += '<p class="small faint">Hunt pursues zombies within a leash; Guard holds the drop point.</p>';
    }
    return o;
  }

  // ---------------------------------------------------------------- small placements
  _simple(sel, title, item, extra = '') {
    const w = this.s.world;
    let o = this.head(title, `${sel.kind.toUpperCase()} ${String(item.id).padStart(4, '0')}`);
    o += extra;
    o += kv('Cost', fmtMoney(item.paid || 0));
    const cmd = { corridor: 'corridor.remove', hold: 'hold.remove', wall: 'wall.remove', gate: 'gate.remove' }[sel.kind];
    const q = w.quote({ t: cmd, id: item.id, owner: this.s.owner });
    const back = q.ok ? (q.refund !== undefined ? q.refund : w.refundValue(item.paid)) : 0;
    o += `<div class="rc-acts">${btn('remove', back > 0 ? `Refund ${fmtMoney(back)}` : 'Remove', { cls: 'btn-ghost', disabled: !q.ok, title: q.ok ? '' : q.reason, arg: cmd })}</div>`;
    return o;
  }

  _corridor(sel) {
    const c = this.s.world.corridors.find((q) => q.id === sel.id);
    return c ? this._simple(sel, 'Evac corridor', c, kv('Length', `${Math.round(Math.hypot(c.x1 - c.x0, c.y1 - c.y0))} m`) + kv('Width', `${Math.round(c.w)} m`)) : '';
  }
  _hold(sel) {
    const h = this.s.world.holds.find((q) => q.id === sel.id);
    return h ? this._simple(sel, 'Hold point', h, kv('Radius', `${Math.round(h.R)} m`) + kv('Gathering circle', `${Math.round(h.r)} m`)) : '';
  }
  _wall(sel) {
    const wl = this.s.world.walls.find((q) => q.id === sel.id);
    if (!wl) return '';
    const w = this.s.world;
    let hp = 0, n = 0;
    for (const c of wl.cells) if (w.block[c] === 2) { hp += Math.max(0, w.wallHp[c]); n++; }
    const f = n ? hp / (n * w.cfg.wall.hp) : 0;
    return this._simple(sel, 'Wall', wl, kv('Length', `${Math.round(wl.len)} m`) + kv('Integrity', `${Math.round(f * 100)}%`) + bar(f));
  }
  _gate(sel) {
    const g = this.s.world.zones.gates.find((q) => q.id === sel.id);
    return g ? this._simple(sel, 'Gate', g, kv('Integrity', `${fmtInt(g.hp)} / ${fmtInt(g.hpMax)}`) + bar(g.hpMax ? g.hp / g.hpMax : 0) + kv('Zone', `${g.comp + 1}`)) : '';
  }

  // ---------------------------------------------------------------- actions
  act(a, arg) {
    const s = this.s, w = s.world, sel = this.sel;
    if (!sel && a !== 'close') return;
    switch (a) {
      case 'close': s.select(null); return;
      case 'selunit': s.select({ kind: 'unit', id: +arg }); return;
      case 'func': s.issue({ t: 'func.set', b: sel.b, func: arg || null }); break;
      case 'stance': s.issue({ t: 'stance.set', b: sel.b, stance: arg }); break;
      case 'place': { const b = w.buildings[sel.b]; s.issue({ t: 'unit.place', type: arg, x: b.cx, y: b.cy, b: sel.b, owner: s.owner }); break; }
      case 'upgrade': s.issue({ t: 'unit.upgrade', id: sel.id, owner: s.owner }); break;
      case 'detonate': s.issue({ t: 'unit.detonate', id: sel.id, owner: s.owner }); break;
      case 'refund': if (s.issue({ t: 'unit.refund', id: sel.id, owner: s.owner }).ok) { s.select(null); return; } break;
      case 'zoneup': s.issue({ t: 'zone.upgrade', compId: sel.comp, owner: s.owner }); break;
      case 'zonerefund': {
        const ids = String(arg || '').split(',').filter(Boolean).map(Number);
        if (ids.length && s.issue({ t: 'refund.many', items: { zone: ids }, owner: s.owner }).ok) { s.select(null); return; }
        break;
      }
      case 'squad': {
        const cmd = { t: 'squad.mode', group: sel.group, mode: arg, owner: s.owner };
        if (w.quote(cmd).reason === 'Unknown command') s.issue({ t: 'stance.set', group: sel.group, stance: arg === 'hunt' ? 1 : 0, owner: s.owner });
        else s.issue(cmd);
        break;
      }
      case 'remove': if (s.issue({ t: arg, id: sel.id, owner: s.owner }).ok) { s.select(null); return; } break;
      default: return;
    }
    this.render(true);
  }
}
