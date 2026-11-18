// In-game HUD: header strip, tool rack, unit and ability slots, budget meters, minimap, log, tally, cursor label.
import { h, setText, setHTML, toggle, show, esc, fmtInt, fmtMoney, fmtPct, fmtTime } from './el.js';
import { drawUnitGlyph, drawAgentKey, KEY_KINDS } from '../render/worldrender.js';
import { drawMinimap, minimapTransform } from '../render/maprender.js';

const TOOLS = [
  ['zone', 'Safe zone'], ['wall', 'Wall'], ['gate', 'Gate'], ['corridor', 'Corridor'], ['hold', 'Hold point'],
];
const SPEEDS = [0.5, 1, 2, 4];
const SRC_LABEL = { police: 'Police', militia: 'Militia', soldier: 'Soldiers', fire: 'Fire', explosive: 'Explosive mutants', hazard: 'Hazard blasts',
  collapse: 'Collapses', drown: 'Drowned', explosion: 'Explosions', zombie: 'Infighting', unknown: 'Other' };

const TIPS = {
  'planning:select': 'Ring a crowded block with a safe zone (B), cut a gate in its wall (G), man the tall roofs (1). Space when ready.',
  'battle:select': 'Space pauses. Abilities unlock over time: F1-F8 or Shift+1-8. Keep building with what is left.',
  zone: 'Click corners; Enter or the first corner closes it. Overlapping zones merge. Drag a corner to reshape.',
  wall: 'Click points along the line; Enter or double-click finishes. Zombies must break through.',
  gate: 'Click a safe-zone wall. Only gated zones can be entered; zombies attack gates.',
  corridor: 'Drag tail to arrow head; civilians inside walk to the head. Wheel while dragging or [ ] sets width.',
  hold: 'Drag out a radius; civilians inside gather in the inner circle until you refund it.',
  unit: 'Click to place. Paint (P) mans every roof you sweep. Outside zones units cost more and reload less.',
  upgrade: 'Click or drag across your units to buy the next level.',
  refund: 'Click a placement, or drag a box to pick from a list. Planning refunds in full.',
  ability: 'Click the target. Charges come from command points in the loadout.',
};

export class Hud {
  constructor(session, root) {
    this.s = session;
    this.root = root;
    this._t = 0;
    this._mm = 0;
    this.logItems = [];
    this.build();
  }

  build() {
    const s = this.s, P = (a) => s.prefs.keyLabel(a);
    const key = (a) => h('span.keycap', { 'data-key': a }, P(a));

    // ---------------- header
    this.el = {};
    const E = this.el;
    E.stage = h('span.rc-stage-no');
    E.stageLabel = h('span.rc-stage-label');
    E.phase = h('span.stamp.stamp-sm.rc-phase');
    E.civ = h('b'); E.safe = h('b'); E.zom = h('b'); E.time = h('b');
    const stat = (label, el, cls = '') => h(`div.rc-stat${cls}`, null, h('span.label', null, label), el);
    E.speed = h('div.seg.rc-speed');
    E.pause = h('button', { type: 'button', title: 'Pause / resume', onclick: () => s.togglePause() }, 'Pause');
    E.speed.append(E.pause);
    E.speedBtns = SPEEDS.map((v) => {
      const b = h('button', { type: 'button', onclick: () => s.setSpeed(v) }, `${v}x`);
      E.speed.append(b);
      return b;
    });
    E.real = h('span.rc-real');
    E.menu = h('button.btn.btn-sm', { type: 'button', onclick: () => s.openPause() }, 'Menu ', h('span.keycap', null, 'Esc'));
    E.top = h('header.rc-top', null,
      h('div.rc-brand', null, h('span.rc-brand-name', null, 'Remain Calm'), h('span.form-no', null, `OCP-7 / ${esc(s.map.name || 'Untitled')}`)),
      h('div.rc-stagebox', null, E.stage, E.stageLabel),
      E.phase,
      h('div.rc-stats', null, stat('Civilians', E.civ), stat('Safe', E.safe), stat('Infected', E.zom, '.rc-zom'), stat('Clock', E.time)),
      h('div.rc-speedbox', null, E.speed, E.real),
      E.menu);

    // ---------------- left rack
    E.toolBtns = {};
    const toolBtn = (name, label, act) => {
      const b = h('button.rc-tool', { type: 'button', 'data-tool': name, onclick: () => s.setTool(s.toolName === name ? 'select' : name) },
        h('span.rc-tool-name', null, label), key(act || name));
      E.toolBtns[name] = b;
      return b;
    };
    E.units = h('div.rc-slots');
    E.paint = h('button.rc-tool.rc-toggle', { type: 'button', onclick: () => s.togglePaint() }, h('span.rc-tool-name', null, 'Paint'), key('paint'));
    E.loadout = h('button.rc-tool', { type: 'button', onclick: () => s.openLoadout() }, h('span.rc-tool-name', null, 'Loadout'), key('loadout'));
    E.viewH = h('button.rc-tool.rc-toggle', { type: 'button', onclick: () => s.toggleView('height') }, h('span.rc-tool-name', null, 'Heights'), key('viewHeights'));
    E.viewC = h('button.rc-tool.rc-toggle', { type: 'button', onclick: () => s.toggleView('specials') }, h('span.rc-tool-name', null, 'Specials'), key('viewSpecials'));
    E.viewR = h('button.rc-tool.rc-toggle', { type: 'button', onclick: () => s.toggleRings() }, h('span.rc-tool-name', null, 'Ranges'), key('viewRanges'));
    E.viewK = h('button.rc-tool.rc-toggle', { type: 'button', title: 'Map key: people, zombies and mutants', onclick: () => this.toggleKey() }, h('span.rc-tool-name', null, 'Key'));
    E.undo = h('button.rc-tool', { type: 'button', onclick: () => s.undo() }, h('span.rc-tool-name', null, 'Undo'), key('undo'));
    E.rack = h('aside.rc-rack.card.flat', null,
      h('div.rc-sec', null, 'Works'), ...TOOLS.map(([n, l]) => toolBtn(n, l)),
      h('div.rc-sec', null, 'Units'), E.units,
      h('div.rc-sec', null, 'Orders'), toolBtn('upgrade', 'Upgrade'), toolBtn('refund', 'Refund'), E.paint, E.loadout, E.undo,
      h('div.rc-sec', null, 'View'), E.viewH, E.viewC, E.viewR, E.viewK);

    // ---------------- right column
    E.money = h('b.meter-val'); E.moneyCap = h('small');
    E.meter = h('div.meter', { style: '--v:0;--q:0' }, h('i.meter-fill'), h('i.meter-quote'));
    E.sp = h('b.meter-val'); E.spCap = h('small');
    E.spMeter = h('div.meter.thin', { style: '--v:0' }, h('i.meter-fill'));
    E.budget = h('section.rc-budget.card.flat', null,
      h('div.meter-row', null, h('span.label', null, 'Funds spent'), h('span', null, E.money, ' ', E.moneyCap)), E.meter,
      h('div.meter-row.rc-sp-row', null, h('span.label', null, 'Command pts'), h('span', null, E.sp, ' ', E.spCap)), E.spMeter);
    E.mini = h('canvas.rc-minimap');
    E.miniBox = h('section.rc-minibox.card.flat', null, E.mini);
    E.info = h('section.rc-info');
    E.tally = h('section.rc-tally.card.flat', { hidden: true });
    E.key = this.buildKey();
    E.side = h('aside.rc-side', null, E.budget, E.miniBox, E.key, E.info, E.tally);

    // ---------------- bottom
    E.abilities = h('div.rc-abilities');
    E.ready = h('button.btn.btn-primary.btn-lg.rc-ready', { type: 'button', onclick: () => s.ready() }, 'Ready', key('ready'));
    E.readyNote = h('div.rc-ready-note');
    E.readyBox = h('div.rc-readybox', null, E.readyNote, E.ready);
    E.log = h('ul.log.rc-log');
    E.logBox = h('section.rc-logbox', null, E.log);
    E.tip = h('div.rc-tipline');
    E.flash = h('div.rc-flash', { hidden: true });
    E.banner = h('div.rc-banner', { hidden: true });
    E.qlabel = h('div.rc-qlabel', { hidden: true });
    E.tooltip = h('div.tooltip.rc-tooltip', { hidden: true });
    E.paused = h('div.rc-pausedmark', { hidden: true }, h('span.stamp.stamp-ink.tilt-2', null, 'Paused', h('small', null, 'Space to resume')));

    this.root.append(E.top, E.rack, E.side, E.abilities, E.readyBox, E.logBox, E.tip, E.flash, E.banner, E.paused, E.qlabel, E.tooltip);
    this.bindMinimap();
    this.rebuildSlots();
  }

  // ---------------------------------------------------------------- slots
  rebuildSlots() {
    const s = this.s, w = s.world, E = this.el, pal = s.pal;
    E.units.textContent = '';
    E.unitBtns = [];
    const units = (w.loadout.units || []).slice(0, w.cfg.loadoutSlots || 7);
    const n = w.cfg.loadoutSlots || 7;
    for (let k = 0; k < n; k++) {
      const type = units[k];
      const act = `unit${k + 1}`;
      if (!type) {
        E.units.append(h('div.rc-slot.is-empty', null, h('span.keycap', null, s.prefs.keyLabel(act)), h('span.rc-slot-name', null, 'Empty slot')));
        E.unitBtns.push(null);
        continue;
      }
      const cv = h('canvas.rc-glyph', { width: 26, height: 26 });
      const price = h('span.rc-slot-price');
      const count = h('span.rc-slot-count');
      const b = h('button.rc-slot', { type: 'button', 'data-tool': 'unit:' + type, title: s.combat.unitDesc(type) || s.combat.unitName(type),
        onclick: () => s.setTool(s.toolName === 'unit:' + type ? 'select' : 'unit:' + type) },
      cv, h('span.rc-slot-name', null, s.combat.unitShort(type)), price, count, h('span.keycap', null, s.prefs.keyLabel(act)));
      b._type = type; b._price = price; b._count = count; b._cv = cv;
      E.units.append(b);
      E.unitBtns.push(b);
    }
    this.paintGlyphs();

    E.abilities.textContent = '';
    E.abBtns = [];
    const ids = s.abilityOrder();
    ids.forEach((id, k) => {
      const status = h('span.rc-ab-status');
      const charges = h('b.rc-ab-charges');
      const bar = h('i.rc-ab-bar');
      const b = h('button.rc-ab', { type: 'button', title: s.combat.abilityDesc(id) || s.combat.abilityName(id), onclick: () => s.pickAbility(id) },
        h('span.keycap', null, s.prefs.keyLabel(`ability${k + 1}`)), h('span.rc-ab-name', null, s.combat.abilityShort(id)), charges, status, bar);
      b._id = id; b._status = status; b._charges = charges; b._bar = bar;
      E.abilities.append(b);
      E.abBtns.push(b);
    });
    show(E.abilities, ids.length > 0);
    this.update(true);
  }

  paintGlyphs() {
    const pal = this.s.pal, dpr = window.devicePixelRatio || 1;
    for (const b of this.el.unitBtns) {
      if (!b) continue;
      const cv = b._cv;
      cv.width = 26 * dpr; cv.height = 26 * dpr;
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, 26, 26);
      drawUnitGlyph(g, b._type, 13, 13, b._type === 'mine' || b._type === 'chemical' ? 6 : 7, pal.ink, pal.card, { level: 1, angle: -Math.PI / 4 });
    }
  }

  // ---------------------------------------------------------------- map key
  buildKey() {
    const pal = this.s.pal, dpr = window.devicePixelRatio || 1;
    const swatch = (kind, r, tier) => {
      const cv = h('canvas', { width: Math.round(20 * dpr), height: Math.round(20 * dpr) });
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawAgentKey(g, kind, 10, 10, pal, r, tier);
      return cv;
    };
    const rows = KEY_KINDS.map(([kind, label]) => {
      const mut = kind === 'explosive' || kind === 'shielded' || kind === 'swimmer' || kind === 'giant';
      const r = kind === 'giant' ? 7.5 : mut ? 5 : kind === 'zombie' ? 3.6 : 3.3;
      return h('div.rc-key-row', null, swatch(kind, r, 2), mut ? swatch(kind, r, 0) : null, h('span', null, label));
    });
    const el = h('section.rc-key.card.flat', { hidden: true },
      h('div.rc-sec', null, 'Map key'), h('div.rc-key-grid', null, ...rows),
      h('p.rc-key-note', null, 'Mutants: full health beside wounded. Deeper colour and a heavier ring mean more health.'));
    let on = false;
    try { on = localStorage.getItem('rc.mapKey') === '1'; } catch (e) { /* storage blocked */ }
    this.keyOn = on;
    el.hidden = !on;
    return el;
  }

  toggleKey() {
    this.keyOn = !this.keyOn;
    this.el.key.hidden = !this.keyOn;
    toggle(this.el.viewK, 'is-on', this.keyOn);
    try { localStorage.setItem('rc.mapKey', this.keyOn ? '1' : '0'); } catch (e) { /* storage blocked */ }
  }

  refreshKeys() {
    for (const k of this.root.querySelectorAll('.keycap[data-key]')) k.textContent = this.s.prefs.keyLabel(k.getAttribute('data-key'));
    this.rebuildSlots();
  }

  // ---------------------------------------------------------------- per-frame
  frame(dt) {
    this._t += dt;
    this.cursorLabel();
    if (this._t >= 0.12) { this._t = 0; this.update(false); }
    this._mm += dt;
    if (this._mm >= 0.2) { this._mm = 0; this.minimap(); }
  }

  update() {
    const s = this.s, w = s.world, E = this.el, st = w.stats;
    const battle = w.phase === 'battle', planning = w.phase === 'planning';
    setText(E.stage, `Stage ${w.stage + 1} / ${w.stageCount}`);
    setText(E.stageLabel, (w.region && w.region.label) || '');
    const ph = { planning: ['Planning', 'stamp-blue'], battle: ['Outbreak', ''], won: ['Secured', 'stamp-green'], lost: ['City lost', ''] }[w.phase] || ['', ''];
    setText(E.phase, ph[0]);
    if (E.phase._c !== ph[1]) { E.phase.classList.remove('stamp-blue', 'stamp-green'); if (ph[1]) E.phase.classList.add(ph[1]); E.phase._c = ph[1]; }
    const civAlive = planning ? w.counts[1] : st.civAlive;
    setText(E.civ, fmtInt(civAlive));
    const start = st.civStart || 0;
    const safe = planning ? 0 : (st.civSafe + st.civEvac);
    setText(E.safe, start ? fmtPct(safe / start * 100) : '--');
    setText(E.zom, planning ? '--' : fmtInt(st.zombies + st.turning));
    setText(E.time, fmtTime(w.t));

    const sp = s.paused ? 0 : w.speed;
    toggle(E.pause, 'is-on', s.paused);
    E.speedBtns.forEach((b, k) => toggle(b, 'is-on', !s.paused && Math.abs(SPEEDS[k] - w.speed) < 1e-6));
    const lag = battle && !s.paused && s.realSpeed > 0 && s.realSpeed < w.speed * 0.85;
    setText(E.real, lag ? `real ${s.realSpeed.toFixed(1)}x` : '');
    toggle(E.real, 'is-lag', lag);
    show(E.paused, battle && s.paused && !s.modalOpen());

    // tools
    for (const [name, b] of Object.entries(E.toolBtns)) toggle(b, 'is-on', s.toolName === name);
    toggle(E.paint, 'is-on', s.paint);
    toggle(E.viewH, 'is-on', s.view === 'height');
    toggle(E.viewC, 'is-on', s.view === 'specials');
    toggle(E.viewR, 'is-on', s.rings);
    toggle(E.viewK, 'is-on', !!this.keyOn);
    E.undo.disabled = !planning || !s.undoStack.length || !!s.net;
    E.loadout.disabled = !planning;
    const over = w.phase === 'won' || w.phase === 'lost';
    for (const b of Object.values(E.toolBtns)) b.disabled = over;

    // unit slots
    const counts = {};
    for (const u of w.units) if (u && u.alive !== false) counts[u.type] = (counts[u.type] || 0) + 1;
    for (const b of E.unitBtns) {
      if (!b) continue;
      const pr = s.combat.basePrice(w, b._type, s.owner);
      const c = w.cfg.units[b._type] || {};
      setText(b._price, c.perM ? `$${pr.cost}/m` : `${pr.from ? 'from ' : ''}$${fmtInt(pr.cost)}`);
      setText(b._count, counts[b._type] ? `x${counts[b._type]}` : '');
      toggle(b, 'is-on', s.toolName === 'unit:' + b._type);
      b.disabled = !s.combat.ok || over;
      toggle(b, 'is-broke', !w.sandbox && pr.cost > w.available(s.owner));
    }

    // abilities
    for (const b of E.abBtns) {
      const a = s.combat.abilityState(w, b._id);
      const cfg = w.cfg.abilities[b._id] || {};
      setText(b._charges, `x${a.charges}`);
      let status = '', v = 0;
      if (planning) { status = cfg.unlock ? `after ${cfg.unlock} s` : 'at once'; }
      else if (!battle) status = '';
      else if (a.deliveryIn >= 0) { status = `lands in ${Math.ceil(a.deliveryIn)} s`; v = 1; }
      else if (a.charges <= 0) status = 'spent';
      else if (a.unlockIn > 0) { status = `${Math.ceil(a.unlockIn)} s`; v = 1 - a.unlockIn / Math.max(1, cfg.unlock || 1); }
      else { status = 'ready'; v = 1; }
      setText(b._status, status);
      b._bar.style.setProperty('--v', v.toFixed(3));
      toggle(b, 'is-ready', battle && a.ready);
      toggle(b, 'is-on', s.toolName === 'ability:' + b._id);
      b.disabled = !battle || a.charges <= 0 || !s.combat.ok;
    }

    // budget
    const cap = w.budget.cap, spent = w.budget.spent;
    const own = w.owners > 1 ? w.budget.owners[s.owner] : null;
    const mcap = own ? own.cap : cap, mspent = own ? own.spent : spent;
    setText(E.money, fmtMoney(mspent));
    setText(E.moneyCap, w.sandbox ? '/ unlimited' : `/ ${fmtMoney(mcap)}`);
    const v = w.sandbox || !mcap ? 0 : Math.min(1, mspent / mcap);
    const lab = s.currentLabel;
    const qv = lab && lab.cost > 0 && !w.sandbox && mcap ? lab.cost / mcap : 0;
    E.meter.style.setProperty('--v', v.toFixed(4));
    E.meter.style.setProperty('--q', qv.toFixed(4));
    toggle(E.meter, 'warn', v > 0.8 && v < 0.999);
    toggle(E.meter, 'over', v >= 0.999 || (lab && lab.reason === 'Not enough money'));
    const spc = w.sp.cap, sps = w.sp.spent;
    setText(E.sp, String(sps));
    setText(E.spCap, w.sandbox ? '/ unlimited' : `/ ${spc} SP`);
    E.spMeter.style.setProperty('--v', (w.sandbox || !spc ? 0 : Math.min(1, sps / spc)).toFixed(3));

    // ready
    show(E.readyBox, planning);
    if (planning) {
      const flags = w.readyFlags || [];
      const mine = !!flags[s.owner];
      setText(E.ready.firstChild, mine && w.owners > 1 ? 'Waiting' : 'Ready');
      const zones = w.zones.comps.length, gates = w.zones.gates.length;
      let note = '';
      if (!zones) note = 'No safe zone drawn yet';
      else if (!gates) note = 'Your zones have no gate: nobody can get in';
      else note = `${zones} zone${zones === 1 ? '' : 's'}, ${gates} gate${gates === 1 ? '' : 's'}, ${w.units.filter((u) => u && u.alive !== false).length} units`;
      if (w.owners > 1) note += flags[1 - s.owner] ? ' · partner is ready' : ' · partner planning';
      setText(E.readyNote, note);
      toggle(E.readyNote, 'red', !zones || !gates);
    }

    // tally
    show(E.tally, !planning);
    if (!planning) this.tally();

    // tip
    const tips = s.prefs.get().showTips;
    const tn = s.toolName;
    const tk = tn === 'select' ? `${planning ? 'planning' : 'battle'}:select` : tn.startsWith('unit:') ? 'unit' : tn.startsWith('ability:') ? 'ability' : tn;
    setText(E.tip, tips && !over ? TIPS[tk] || '' : '');
    show(E.tip, tips && !over && !!TIPS[tk]);
  }

  tally() {
    const s = this.s, w = s.world, by = w.stats.killsBy;
    const rows = Object.entries(by).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const label = (k) => {
      if (k.startsWith('ability:')) return s.combat.abilityName(k.slice(8));
      if (w.cfg.units[k]) return s.combat.unitName(k);
      if (w.cfg.abilities[k]) return s.combat.abilityName(k);
      return SRC_LABEL[k] || k.replace(/^./, (c) => c.toUpperCase());
    };
    const html = `<div class="rc-sec">Kill tally <span class="faint">${fmtInt(w.stats.killed)}</span></div>` + (rows.length
      ? `<table class="table compact rc-tally-t"><tbody>${rows.map(([k, n]) => `<tr><td>${esc(label(k))}</td><td class="num">${fmtInt(n)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="faint small">No kills yet.</p>');
    setHTML(this.el.tally, html);
  }

  // ---------------------------------------------------------------- cursor label (price / reason at the pointer)
  cursorLabel() {
    const s = this.s, E = this.el, lab = s.currentLabel, m = s.input && s.input.mouse;
    if (!lab || !m || s.modalOpen()) { show(E.qlabel, false); return; }
    show(E.qlabel, true);
    const cost = lab.cost > 0 ? `<b class="rc-q-cost">${fmtMoney(lab.cost)}</b>` : '';
    const reason = lab.reason ? `<span class="rc-q-reason">${esc(lab.reason)}</span>` : '';
    const note = lab.note ? `<span class="rc-q-note">${esc(lab.note)}</span>` : '';
    setHTML(E.qlabel, `<span class="rc-q-title">${esc(lab.title)}</span>${cost}${reason}${note}`);
    toggle(E.qlabel, 'is-bad', lab.ok === false);
    toggle(E.qlabel, 'is-ok', lab.ok === true);
    const x = Math.min(m.sx + 18, s.cam.w - 220), y = Math.min(m.sy + 20, s.cam.h - 60);
    const tr = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (E.qlabel._tr !== tr) { E.qlabel._tr = tr; E.qlabel.style.transform = tr; }
  }

  tooltip(html, sx, sy) {
    const E = this.el;
    if (!html) { show(E.tooltip, false); return; }
    setHTML(E.tooltip, html);
    show(E.tooltip, true);
    const w = E.tooltip.offsetWidth || 200, hh = E.tooltip.offsetHeight || 60;
    let x = sx + 16, y = sy - hh - 12;
    if (y < 50) y = sy + 22;
    if (x + w > this.s.cam.w - 4) x = sx - w - 16;
    E.tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // ---------------------------------------------------------------- log + flash + banner
  log(msg, kind = 'info', t = 0) {
    const cls = kind === 'alert' ? 'alert' : kind === 'warn' ? 'warn' : kind === 'good' ? 'good' : '';
    const li = h(`li${cls ? '.' + cls : ''}.is-new`, null, h('time', null, fmtTime(t)), h('span', null, msg));
    this.el.log.prepend(li);
    while (this.el.log.children.length > 6) this.el.log.lastChild.remove();
  }

  clearLog() { this.el.log.textContent = ''; }

  flash(msg, kind = 'warn') {
    const E = this.el;
    if (!msg) return;
    setText(E.flash, msg);
    E.flash.className = `rc-flash is-${kind}`;
    show(E.flash, true);
    clearTimeout(this._ft);
    this._ft = setTimeout(() => show(E.flash, false), kind === 'alert' ? 3200 : 2200);
  }

  banner(html, kind = 'warn') {
    const E = this.el;
    if (!html) { show(E.banner, false); return; }
    E.banner.className = `rc-banner card raised is-${kind}`;
    E.banner.innerHTML = html;
    show(E.banner, true);
    const x = E.banner.querySelector('[data-close]');
    if (x) x.onclick = () => show(E.banner, false);
  }

  // ---------------------------------------------------------------- minimap
  bindMinimap() {
    const cv = this.el.mini;
    let down = false;
    const go = (e) => {
      const r = cv.getBoundingClientRect();
      const T = minimapTransform(this.s.map, r.width, r.height);
      const [x, y] = T.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.s.cam.centerOn(x, y);
    };
    cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); go(e); });
    cv.addEventListener('pointermove', (e) => { if (down) go(e); });
    cv.addEventListener('pointerup', () => { down = false; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const c = this.s.cam; c.wheel(e.deltaY, c.w / 2, c.h / 2, e.deltaMode); }, { passive: false });
  }

  minimap() {
    const s = this.s, cv = this.el.mini, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 220, hh = cv.clientHeight || 180;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const world = s.world, pal = s.pal;
    const T = drawMinimap(g, s.map, w, hh, { palette: pal, stage: world.region.poly, camera: s.cam, grid: world.grid });
    g.save();
    g.fillStyle = pal.zone.wall;
    for (const c of world.zones.comps) {
      const [x0, y0, x1, y1] = c.bbox || [0, 0, 0, 0];
      const cs = world.grid.cell;
      const [a, b] = T.toMini(x0 * cs, y0 * cs), [cx, cy] = T.toMini((x1 + 1) * cs, (y1 + 1) * cs);
      g.globalAlpha = 0.35; g.fillRect(a, b, Math.max(2, cx - a), Math.max(2, cy - b));
      g.globalAlpha = 1; g.strokeStyle = c.breached ? pal.stamp : pal.zone.wall; g.lineWidth = 1; g.strokeRect(a + 0.5, b + 0.5, Math.max(2, cx - a) - 1, Math.max(2, cy - b) - 1);
    }
    if (world.phase !== 'planning') {
      const A = world.A, n = A.n, step = Math.max(1, Math.floor(world.counts[2] / 2500));
      g.fillStyle = pal.agent.zombie;
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (A.type[i] !== 2) continue;
        if (k++ % step) continue;
        const [x, y] = T.toMini(A.x[i], A.y[i]);
        g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
    for (const m of s.markers.list) {
      if (m.kind !== 'outbreak') continue;
      const [x, y] = T.toMini(m.x, m.y);
      g.strokeStyle = pal.stamp; g.lineWidth = 1.25;
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }
}
