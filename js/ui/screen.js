// Shared screen furniture: masthead, back link, difficulty selector, badge marks, tab folders.
import { h, keycap, sfx } from './dom.js';
import { DIFFICULTIES, badgeRank } from '../meta/progress.js';

export const DIFF_LABEL = { normal: 'Normal', hardcore: 'Hardcore', ultra: 'Ultra' };
export const BADGE_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', sapphire: 'Sapphire', emerald: 'Emerald', ruby: 'Ruby', diamond: 'Diamond' };
export const BADGE_SHORT = { bronze: 'BRZ', silver: 'SLV', gold: 'GLD', sapphire: 'SAP', emerald: 'EMR', ruby: 'RBY', diamond: 'DIA' };

// Screen frame: masthead with form number, title and back link. Returns { el, body, tools }.
export function screenFrame({ form, title, sub = '', back = 'Directory', onBack, cls = '' }) {
  const tools = h('div.mast-tools');
  const head = h('header.masthead',
    h('div.mast-id',
      h('span.form-no', `Office of Civil Preparedness · Form ${form}`),
      h('h1.mast-title', title),
      sub ? h('span.mast-sub', sub) : null),
    tools,
    onBack ? h('button.btn.btn-ghost.mast-back', { type: 'button', onclick: () => { sfx.page(); onBack(); } }, '← ' + back, keycap('Esc')) : null);
  const body = h('div.screen-body');
  const el = h('section.screen' + (cls ? '.' + cls : ''), head, body);
  return { el, body, tools, head };
}

// Segmented difficulty control. locked(d) -> reason string | null.
export function difficultySeg(value, onChange, locked = () => null) {
  const seg = h('div.seg.diff-seg', { role: 'radiogroup', 'aria-label': 'Difficulty' });
  const set = (v) => {
    value = v;
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.d === v));
  };
  for (const d of DIFFICULTIES) {
    const why = locked(d);
    const b = h('button', { type: 'button', role: 'radio', dataset: { d }, disabled: !!why, title: why || DIFF_LABEL[d] }, DIFF_LABEL[d]);
    b.addEventListener('click', () => { if (b.disabled) return; sfx.clack(); set(d); onChange(d); });
    seg.appendChild(b);
  }
  set(value);
  return { el: seg, set, get value() { return value; } };
}

// Round badge seal for a stage: tier colour if earned, dashed ring if not.
export function stageSeal(badge, label, { size = '2.6rem', title = '' } = {}) {
  const earned = badgeRank(badge) >= 0;
  return h('span.stage-seal' + (earned ? '.is-earned.tier-' + badge : ''), { style: { '--size': size }, title: title || (earned ? BADGE_LABEL[badge] : 'Not cleared') },
    h('b', label), earned ? h('small', BADGE_SHORT[badge] || '') : null);
}

// Manila folder with tabs. tabs: [{ id, label, no }]. Returns { el, body, select(id), get current }.
export function folderTabs(tabs, current, onSelect) {
  const bar = h('div.tabs', { role: 'tablist' });
  const body = h('div.folder-body', { role: 'tabpanel' });
  const btns = tabs.map((t, i) => {
    const b = h('button.tab', { type: 'button', role: 'tab', dataset: { tab: t.id } }, h('span.tab-no', t.no || String(i + 1).padStart(2, '0')), t.label);
    b.addEventListener('click', () => select(t.id, true));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const k = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      select(tabs[k].id, true);
      btns[k].focus();
    });
    bar.appendChild(b);
    return b;
  });
  function select(id, user = false) {
    current = id;
    btns.forEach(b => {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (user) sfx.page();
    onSelect(id);
  }
  const el = h('div.folder', bar, body);
  return { el, body, select, get current() { return current; } };
}

// Labelled field wrapper.
export function field(label, control, hint = '') {
  return h('div.field', h('label', label), control, hint ? (hint instanceof Node ? hint : h('span.hint', hint)) : null);
}

export function slider({ min, max, step, value, oninput, format = v => String(v), id }) {
  const out = h('output.slider-val', format(value));
  const input = h('input.slider', { type: 'range', min, max, step, value, id });
  input.value = String(value);
  input.addEventListener('input', () => { out.textContent = format(+input.value); oninput(+input.value); });
  return { el: h('div.slider-row', input, out), input, out, set(v) { input.value = String(v); out.textContent = format(v); } };
}

export function segControl(options, value, onChange, { label = '' } = {}) {
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  const set = (v) => { value = v; for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.v === String(v))); };
  for (const o of options) {
    const b = h('button', { type: 'button', role: 'radio', dataset: { v: String(o.value) }, disabled: !!o.disabled, title: o.title || '' }, o.label);
    b.addEventListener('click', () => { if (b.disabled) return; sfx.clack(); set(o.value); onChange(o.value); });
    seg.appendChild(b);
  }
  set(value);
  return { el: seg, set, get value() { return value; }, enable(v, on) { const b = [...seg.children].find(x => x.dataset.v === String(v)); if (b) b.disabled = !on; } };
}
