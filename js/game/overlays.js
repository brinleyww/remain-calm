// In-game modal cards: pause menu, welcome briefing, built-in loadout picker, quick settings.
import { h, esc, fmtInt, fmtMoney } from './el.js';

// Opens a modal inside the session overlay. o: { title, no, body (node|html), foot: [node], wide, cls, onKey(e) -> bool, onClose, dismiss }
export function openModal(s, o) {
  const body = h('div.modal-body');
  if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.append(o.body);
  const foot = o.foot && o.foot.length ? h('div.modal-foot', null, ...o.foot) : null;
  const card = h(`div.modal${o.wide ? '.wide' : ''}${o.cls ? '.' + o.cls : ''}`, { role: 'dialog', 'aria-label': o.title || '' },
    h('div.modal-head', null, h('h2.modal-title', null, o.title || ''), o.no ? h('span.form-no', null, o.no) : null),
    body, foot);
  const back = h('div.modal-backdrop.rc-modal', null, card);
  const m = {
    el: back, card, body, closed: false,
    key(e) {
      if (o.onKey && o.onKey(e)) return true;
      if (e.code === 'Escape' && o.dismiss !== false) { m.close(); return true; }
      return true;
    },
    close() {
      if (m.closed) return;
      m.closed = true;
      back.remove();
      const k = s.modals.indexOf(m);
      if (k >= 0) s.modals.splice(k, 1);
      if (o.onClose) o.onClose();
    },
  };
  if (o.dismiss !== false) back.addEventListener('pointerdown', (e) => { if (e.target === back) m.close(); });
  s.overlay.append(back);
  s.modals.push(m);
  const first = card.querySelector('[data-default]') || card.querySelector('.modal-foot .btn-primary');
  if (first) setTimeout(() => { try { first.focus({ preventScroll: true }); } catch (e) { /* detached */ } }, 0);
  return m;
}

export function button(label, onclick, o = {}) {
  return h(`button.btn${o.cls ? '.' + o.cls.split(' ').join('.') : ''}`, { type: 'button', onclick, disabled: o.disabled, 'data-default': o.primary ? '' : null }, label, o.key ? h('span.keycap', null, o.key) : null);
}

// ---------------------------------------------------------------- welcome briefing
export function showWelcome(s, onClose) {
  const w = s.world, map = s.map;
  const lines = [];
  if (map.welcome) lines.push(`<p class="rc-welcome-text">${esc(map.welcome)}</p>`);
  lines.push(`<div class="kv"><span>Stage</span><i></i><b>${w.stage + 1} of ${w.stageCount}${w.region.label ? ` &middot; ${esc(w.region.label)}` : ''}</b></div>`);
  lines.push(`<div class="kv"><span>Residents in the district</span><i></i><b>${fmtInt(w.stats.civStart)}</b></div>`);
  lines.push(`<div class="kv"><span>Budget</span><i></i><b>${w.sandbox ? 'unlimited' : fmtMoney(w.budget.cap)}</b></div>`);
  lines.push(`<div class="kv"><span>Command points</span><i></i><b>${w.sandbox ? 'unlimited' : w.sp.cap + ' SP'}</b></div>`);
  if (map.geo) lines.push('<p class="tiny faint">Map data &copy; OpenStreetMap contributors.</p>');
  lines.push('<p class="small muted">Build a safe zone with a gate, garrison tall roofs and press READY. The outbreak sites are only revealed once the clock starts.</p>');
  let m = null;
  m = openModal(s, {
    title: map.name || 'Briefing', no: 'BRIEFING / OCP-1', body: lines.join(''), cls: 'rc-welcome',
    foot: [button('Begin planning', () => m.close(), { cls: 'btn-primary', primary: true, key: 'Enter' })],
    onKey: (e) => { if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { m.close(); return true; } return false; },
    onClose,
  });
  return m;
}

// ---------------------------------------------------------------- pause menu
export function showPause(s) {
  let m = null;
  const wasPaused = s.paused;
  if (s.world.phase === 'battle') s.paused = true;
  const resume = () => m.close();
  const items = [
    button('Resume', resume, { cls: 'btn-primary btn-block', primary: true, key: 'Esc' }),
    button(s.world.phase === 'planning' ? 'Clear this stage' : 'Retry stage', () => { m.close(); s.retry(); }, { cls: 'btn-block' }),
    button('Settings', () => { m.close(); s.openSettings(); }, { cls: 'btn-block' }),
    button(s.opts.mode === 'test' ? 'Back to editor' : 'Quit to map select', () => { m.close(); s.quit('quit'); }, { cls: 'btn-ghost btn-block' }),
  ];
  const w = s.world;
  const info = h('div.rc-pause-info', null,
    h('div.kv', null, h('span', null, 'Stage'), h('i'), h('b', null, `${w.stage + 1} / ${w.stageCount}`)),
    h('div.kv', null, h('span', null, 'Difficulty'), h('i'), h('b', null, w.difficulty)),
    h('div.kv', null, h('span', null, 'Mode'), h('i'), h('b', null, s.opts.mode || 'free')));
  m = openModal(s, {
    title: 'Paused', no: 'HOLD / OCP-0', cls: 'rc-pause', body: h('div.vstack', null, ...items, h('hr.rule-faint'), info),
    onKey: (e) => { if (e.code === 'Escape') { resume(); return true; } return false; },
    onClose: () => { if (s.world.phase === 'battle') s.paused = wasPaused; },
  });
  return m;
}

// ---------------------------------------------------------------- quick settings (used when the shell provides no settings screen)
export function showQuickSettings(s) {
  const p = s.prefs.get();
  const vol = h('input.slider', { type: 'range', min: 0, max: 100, value: Math.round(p.volume * 100) });
  const ap = h('input', { type: 'checkbox' }); ap.checked = p.autoPause;
  const tips = h('input', { type: 'checkbox' }); tips.checked = p.showTips;
  vol.addEventListener('input', () => { s.prefs.set({ volume: +vol.value / 100 }); s.sfxEngine.setVolume(+vol.value / 100); });
  ap.addEventListener('change', () => s.prefs.set({ autoPause: ap.checked }));
  tips.addEventListener('change', () => s.prefs.set({ showTips: tips.checked }));
  const body = h('div.vstack.gap-4', null,
    h('div.field', null, h('label', null, 'Volume'), vol),
    h('label.toggle', null, ap, h('span.toggle-track'), 'Pause when the outbreak starts'),
    h('label.toggle', null, tips, h('span.toggle-track'), 'Show tips'),
    h('p.small.faint', null, 'Key bindings and population size are set from the main menu settings.'));
  let m = null;
  m = openModal(s, { title: 'Settings', no: 'PREFS / OCP-3', body, foot: [button('Done', () => m.close(), { cls: 'btn-primary', primary: true })] });
  return m;
}

// ---------------------------------------------------------------- built-in loadout picker
export function showLoadoutPicker(s, done) {
  const w = s.world, cfg = w.cfg, slots = cfg.loadoutSlots || 7;
  const all = Object.keys(cfg.units);
  const allowed = s.opts.unlocked ? all.filter((id) => s.opts.unlocked.has ? s.opts.unlocked.has(id) : s.opts.unlocked.includes(id)) : all;
  const abilitiesAll = Object.keys(cfg.abilities);
  const abAllowed = s.opts.unlocked ? abilitiesAll.filter((id) => s.opts.unlocked.has ? s.opts.unlocked.has(id) : s.opts.unlocked.includes(id)) : abilitiesAll;
  const units = new Set((w.loadout.units || []).filter(Boolean));
  const ab = { ...(w.loadout.abilities || {}) };
  const spCap = w.sandbox ? Infinity : w.sp.cap;
  const spUsed = () => Object.entries(ab).reduce((a, [id, n]) => a + (cfg.abilities[id] ? cfg.abilities[id].sp * n : 0), 0);
  const uList = h('div.rc-lo-units');
  const aList = h('div.rc-lo-abilities');
  const spLine = h('div.meter-row');
  const render = () => {
    const scrolled = [];
    for (let n = aList.parentElement; n; n = n.parentElement) if (n.scrollTop) scrolled.push([n, n.scrollTop]);
    const focusAt = document.activeElement && aList.contains(document.activeElement) ? [...aList.querySelectorAll('button')].indexOf(document.activeElement) : -1;
    draw();
    for (const [n, t] of scrolled) n.scrollTop = t;
    const f = focusAt >= 0 ? aList.querySelectorAll('button')[focusAt] : null;
    if (f && !f.disabled) f.focus({ preventScroll: true });
  };
  const draw = () => {
    uList.textContent = '';
    for (const id of allowed) {
      const c = cfg.units[id];
      const chk = h('input', { type: 'checkbox' });
      chk.checked = units.has(id);
      chk.disabled = !chk.checked && units.size >= slots;
      chk.addEventListener('change', () => { if (chk.checked) units.add(id); else units.delete(id); render(); });
      const pr = s.combat.basePrice(w, id, s.owner);
      uList.append(h('label.check.rc-lo-item', null, chk, h('span', null, s.combat.unitName(id)), h('span.faint', null, `${c.mount.replace('|', ' / ')} · ${pr.from ? 'from ' : ''}$${Math.round(pr.cost)}${c.perM ? '/m' : ''}`)));
    }
    aList.textContent = '';
    for (const id of abAllowed) {
      const a = cfg.abilities[id];
      const n = ab[id] || 0;
      const minus = h('button.btn.btn-sm.btn-icon', { type: 'button', disabled: n <= 0, onclick: () => { ab[id] = Math.max(0, n - 1); if (!ab[id]) delete ab[id]; render(); } }, '-');
      const plus = h('button.btn.btn-sm.btn-icon', { type: 'button', disabled: spUsed() + a.sp > spCap, onclick: () => { ab[id] = n + 1; render(); } }, '+');
      aList.append(h('div.rc-lo-ab', null, h('span', null, s.combat.abilityName(id)), h('span.faint', null, `${a.sp} SP`), minus, h('b.rc-lo-n', null, String(n)), plus));
    }
    spLine.innerHTML = `<span class="label">Command points</span><span class="meter-val">${spUsed()} <small>/ ${spCap === Infinity ? 'unlimited' : spCap + ' SP'}</small></span>`;
  };
  render();
  const body = h('div.rc-lo', null,
    h('div', null, h('div.rc-sec', null, `Unit slots (${slots})`), uList),
    h('div', null, h('div.rc-sec', null, 'Ability charges'), spLine, aList));
  let m = null;
  const apply = () => {
    const order = (w.loadout.units || []).filter((u) => units.has(u));
    for (const u of allowed) if (units.has(u) && !order.includes(u)) order.push(u);
    m.close();
    done({ units: order.slice(0, slots), abilities: ab });
  };
  m = openModal(s, { title: 'Loadout', no: 'REQUISITION / OCP-4', wide: true, body, foot: [button('Cancel', () => m.close(), { cls: 'btn-ghost' }), button('Confirm', apply, { cls: 'btn-primary', primary: true, key: 'Enter' })],
    onKey: (e) => { if (e.code === 'Enter') { apply(); return true; } return false; } });
  return m;
}
