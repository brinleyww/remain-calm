// Loadout (requisition form): seven unit slots and ability charges bought with command points.
// Used from the menus and in game (Tab) through openLoadout.
import { DEFAULTS } from '../data/config.js';
import { h, clear, sfx, keycap } from './dom.js';
import { unitName, unitDesc, abilityName, abilityDesc, abilityCode, unitSymbol, unitPriceText, unlockHint, MOUNT_TEXT, loadCombatInfo } from './names.js';

const UNIT_ORDER = ['garrison', 'sniper', 'turret', 'mortar', 'gasMortar', 'fireMortar', 'mlrs', 'howitzer', 'battleship', 'railgun', 'mine', 'chemical', 'napalm', 'c4', 'spikes', 'oil'];

// openLoadout(container, { world?, unlocked: Set|array, current: {units, abilities}, spCap, cfg?, note?, onDone(loadout|null) }) -> { close }
export function openLoadout(container, opts = {}) {
  const world = opts.world || null;
  const cfg = opts.cfg || (world && world.cfg) || DEFAULTS;
  const slotsN = cfg.loadoutSlots || 7;
  const unlocked = opts.unlocked instanceof Set ? opts.unlocked : new Set(opts.unlocked || Object.keys(cfg.units).concat(Object.keys(cfg.abilities)));
  const spCap = opts.spCap === undefined || opts.spCap === null ? null : opts.spCap;
  const readOnly = !!(world && world.phase && world.phase !== 'planning');
  const cur = opts.current || { units: [], abilities: {} };

  const units = new Array(slotsN).fill(null);
  (cur.units || []).slice(0, slotsN).forEach((u, i) => { if (u && cfg.units[u]) units[i] = u; });
  const ab = {};
  for (const id in cur.abilities || {}) if (cfg.abilities[id] && cur.abilities[id] > 0) ab[id] = cur.abilities[id] | 0;
  let sel = units.findIndex(u => !u);
  if (sel < 0) sel = 0;

  const spUsed = () => Object.entries(ab).reduce((s, [id, n]) => s + (cfg.abilities[id] ? cfg.abilities[id].sp * n : 0), 0);
  const unitIds = UNIT_ORDER.filter(id => cfg.units[id]).concat(Object.keys(cfg.units).filter(id => !UNIT_ORDER.includes(id)));
  const abilityIds = Object.keys(cfg.abilities);

  // ---------------- skeleton
  const slotRow = h('div.lo-slots', { role: 'list' });
  const catalogue = h('div.lo-cat', { role: 'listbox', 'aria-label': 'Units' });
  const spMeter = h('div.meter', h('i.meter-fill'), h('i.meter-quote'));
  const spVal = h('span.meter-val');
  const abList = h('div.lo-abilities');
  const signBtn = h('button.btn.btn-primary', { type: 'button', disabled: readOnly }, 'Sign requisition', keycap('Enter'));
  const cancelBtn = h('button.btn.btn-ghost', { type: 'button' }, readOnly ? 'Close' : 'Cancel', keycap('Esc'));
  const clearBtn = h('button.btn.btn-sm', { type: 'button', disabled: readOnly }, 'Clear slots');
  const resetBtn = h('button.btn.btn-sm', { type: 'button', disabled: readOnly }, 'Standard issue');

  const sheet = h('div.lo-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Loadout' },
    h('header.lo-head',
      h('div', h('span.form-no', 'Office of Civil Preparedness · Form OCP-14'), h('h2.lo-title', 'Requisition of materiel'),
        opts.note ? h('span.small.muted', opts.note) : null),
      h('button.modal-close', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '×')),
    readOnly ? h('p.lo-locked', h('span.stamp.stamp-sm', 'Locked'), 'The outbreak has begun. The loadout can change again in the next planning phase.') : null,
    h('section.lo-sec',
      h('div.section-head', h('span.h3', 'Unit slots'), h('span.tiny.faint', 'Number keys pick a slot · click a unit below to issue it · Del clears')),
      slotRow),
    h('div.lo-body',
      h('section.lo-sec.lo-units', h('div.section-head', h('span.h3', 'Catalogue'), h('span.tiny.faint', 'Prices are before zone and aura modifiers')), catalogue),
      h('section.lo-sec.lo-abcol',
        h('div.section-head', h('span.h3', 'Abilities'), h('span.tiny.faint', 'Charges cost command points')),
        h('div.meter-row', h('span.label', 'Command points'), spVal), spMeter,
        abList)),
    h('footer.lo-foot', clearBtn, resetBtn, h('span.grow'), cancelBtn, signBtn));

  const layer = h('div.lo-layer', sheet);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(null); });
  container.appendChild(layer);

  // ---------------- render
  function renderSlots() {
    clear(slotRow);
    for (let i = 0; i < slotsN; i++) {
      const u = units[i];
      const slot = h('button.lo-slot' + (i === sel ? '.is-sel' : '') + (u ? '' : '.is-empty'), { type: 'button', role: 'listitem', disabled: readOnly && !u, dataset: { i } },
        keycap(String(i + 1), 'lo-slot-key'),
        h('span.lo-slot-sym', { html: u ? unitSymbol(u, 26) : '' }),
        h('span.lo-slot-name', u ? unitName(u) : 'Empty'),
        h('span.lo-slot-price', u ? unitPriceText(u, cfg) : '—'),
        u && !readOnly ? h('span.lo-slot-x', { title: 'Clear slot', role: 'button', onclick: (e) => { e.stopPropagation(); units[i] = null; sel = i; sfx.clack(); render(); } }, '×') : null);
      slot.addEventListener('click', () => { sel = i; sfx.key(); render(); });
      slotRow.appendChild(slot);
    }
  }

  function renderCatalogue() {
    clear(catalogue);
    for (const id of unitIds) {
      const locked = !unlocked.has(id);
      const at = units.indexOf(id);
      const u = cfg.units[id];
      const card = h('button.lo-card' + (locked ? '.is-locked' : '') + (at >= 0 ? '.is-issued' : ''), { type: 'button', role: 'option', disabled: readOnly || locked, dataset: { id }, 'aria-selected': String(at >= 0) },
        h('span.lo-card-sym', { html: unitSymbol(id, 30) }),
        h('span.lo-card-text',
          h('b', unitName(id)),
          h('span.lo-card-meta', `${unitPriceText(id, cfg)} · ${MOUNT_TEXT[u.mount] || u.mount}`),
          h('small', locked ? (unlockHint(id) || 'Not issued yet') : unitDesc(id))),
        at >= 0 ? h('span.lo-card-slot', String(at + 1)) : null,
        locked ? h('span.stamp.stamp-sm.lo-card-stamp', 'Restricted') : null);
      card.addEventListener('click', () => issue(id));
      catalogue.appendChild(card);
    }
  }

  function renderAbilities() {
    clear(abList);
    const used = spUsed();
    const cap = spCap === null ? null : spCap;
    for (const id of abilityIds) {
      const a = cfg.abilities[id];
      const locked = !unlocked.has(id);
      const n = ab[id] || 0;
      const canAdd = !readOnly && !locked && (cap === null || cap === Infinity || used + a.sp <= cap) && a.sp < 999;
      const minus = h('button.btn.btn-sm.btn-icon', { type: 'button', disabled: readOnly || n <= 0, 'aria-label': 'Remove a charge' }, '−');
      const plus = h('button.btn.btn-sm.btn-icon', { type: 'button', disabled: !canAdd, 'aria-label': 'Add a charge' }, '+');
      minus.addEventListener('click', () => { if (ab[id] > 0) { ab[id]--; if (!ab[id]) delete ab[id]; sfx.key(); render(); } });
      plus.addEventListener('click', () => { if (canAdd) { ab[id] = (ab[id] || 0) + 1; sfx.key(); render(); } });
      const row = h('div.lo-ab' + (locked ? '.is-locked' : '') + (n ? '.has' : ''),
        h('span.lo-ab-code', abilityCode(id)),
        h('span.lo-ab-text', h('b', abilityName(id)),
          h('small', locked ? (unlockHint(id) || 'Not issued yet') : `${a.sp >= 999 ? 'Unavailable' : a.sp + ' SP'} · ${a.unlock ? `after ${a.unlock} s` : 'from the start'}${a.delay ? ` · ${a.delay} s to arrive` : ''}`)),
        locked ? h('span.lo-ab-lock', 'Restricted') : h('span.lo-ab-step', minus, h('b.lo-ab-n', String(n)), plus));
      row.title = abilityDesc(id);
      abList.appendChild(row);
    }
    const capTxt = cap === null ? 'set per stage' : cap === Infinity ? 'unlimited' : `${cap} SP`;
    spVal.innerHTML = '';
    spVal.append(String(used), h('small', ` / ${capTxt}`));
    const frac = cap && cap !== Infinity ? used / cap : 0;
    spMeter.style.setProperty('--v', String(Math.min(1, frac)));
    spMeter.classList.toggle('over', cap !== null && cap !== Infinity && used > cap);
  }

  function render() {
    const a = document.activeElement;
    const keep = a && layer.contains(a) ? (a.dataset.id ? `.lo-card[data-id="${a.dataset.id}"]` : a.dataset.i ? `.lo-slot[data-i="${a.dataset.i}"]` : null) : null;
    const abKeep = a && a.classList && a.classList.contains('btn-icon') ? [...abList.querySelectorAll('.btn-icon')].indexOf(a) : -1;
    // emptying a list collapses it for a moment, which resets every scroll position to the top
    const scrolled = [layer, ...layer.querySelectorAll('*')].filter((n) => n.scrollTop || n.scrollLeft).map((n) => [n, n.scrollTop, n.scrollLeft]);
    renderSlots(); renderCatalogue(); renderAbilities();
    for (const [n, t, l] of scrolled) { n.scrollTop = t; n.scrollLeft = l; }
    const f = keep ? layer.querySelector(keep) : abKeep >= 0 ? abList.querySelectorAll('.btn-icon')[abKeep] : null;
    if (f && !f.disabled) f.focus({ preventScroll: true });
  }

  function issue(id) {
    if (readOnly || !unlocked.has(id)) return;
    const at = units.indexOf(id);
    if (at >= 0) { sel = at; sfx.key(); render(); return; }
    let slot = units[sel] ? units.findIndex(u => !u) : sel;
    if (slot < 0) slot = sel;
    units[slot] = id;
    const nextEmpty = units.findIndex(u => !u);
    sel = nextEmpty >= 0 ? nextEmpty : slot;
    sfx.clack();
    render();
  }

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    if (opts.onDone) opts.onDone(result);
  }
  function sign() {
    if (readOnly) return;
    if (spCap !== null && spCap !== Infinity && spUsed() > spCap) return;
    sfx.thump();
    const out = units.slice();
    while (out.length && !out[out.length - 1]) out.pop();
    close({ units: out, abilities: { ...ab } });
  }

  signBtn.addEventListener('click', sign);
  cancelBtn.addEventListener('click', () => close(null));
  clearBtn.addEventListener('click', () => { units.fill(null); sel = 0; sfx.clack(); render(); });
  resetBtn.addEventListener('click', () => {
    const pool = unitIds.filter(id => unlocked.has(id));
    units.fill(null);
    ['garrison', 'sniper', 'turret', 'mortar', 'spikes', 'mine', 'gasMortar'].filter(id => pool.includes(id)).concat(pool).filter((v, i, a) => a.indexOf(v) === i).slice(0, slotsN).forEach((id, i) => { units[i] = id; });
    sel = 0; sfx.clack(); render();
  });

  function onKey(e) {
    if (closed) return;
    e.stopPropagation();
    const t = e.target;
    if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
    if (e.key === 'Tab' && !e.shiftKey && !layer.contains(t)) { e.preventDefault(); signBtn.focus(); return; }
    if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey && !e.ctrlKey) {
      const i = +e.code.slice(5) - 1;
      if (i < slotsN) { e.preventDefault(); sel = i; sfx.key(); render(); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) { e.preventDefault(); units[sel] = null; sfx.clack(); render(); return; }
    if (e.key === 'Enter') {
      if (t && t.classList && (t.classList.contains('lo-card') || t.classList.contains('lo-slot') || t.classList.contains('btn-icon') || t === cancelBtn || t === clearBtn || t === resetBtn)) return;
      e.preventDefault(); sign(); return;
    }
    if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key) && t && t.classList && t.classList.contains('lo-card')) {
      e.preventDefault();
      const cards = [...catalogue.querySelectorAll('.lo-card')];
      const k = cards.indexOf(t);
      const cols = Math.max(1, Math.round(catalogue.clientWidth / (cards[0].offsetWidth + 8)));
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : -cols;
      const nk = Math.max(0, Math.min(cards.length - 1, k + d));
      cards[nk].focus();
    }
  }
  window.addEventListener('keydown', onKey, true);

  render();
  loadCombatInfo().then(() => { if (!closed) render(); });
  requestAnimationFrame(() => { const f = catalogue.querySelector('.lo-card:not(:disabled)') || cancelBtn; f.focus({ preventScroll: true }); });
  return { close: () => close(null) };
}
