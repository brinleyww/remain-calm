// Mutators: preset picker, line validation against config keys, and the text editor modal.
import { DEFAULTS, MUTATOR_PRESETS, parseOverrides } from '../data/config.js';
import { listItems, saveItem, getItem } from '../map/library.js';
import { h, clear, openModal, toast, debounce, sfx } from './dom.js';

// ------------------------------------------------------------ validation

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function suggest(word, keys) {
  let best = null, bd = Infinity;
  for (const k of keys) { const d = editDistance(word, k); if (d < bd) { bd = d; best = k; } }
  return bd <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

const typeName = v => (Array.isArray(v) ? 'a list like [1,2]' : typeof v === 'function' ? 'a number' : typeof v === 'boolean' ? 'true or false' : typeof v === 'number' ? 'a number' : 'text');

// One result per source line: { n, text, kind: 'ok'|'warn'|'error'|'skip', msg }
export function validateMutatorText(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const r = { n: i + 1, text: raw, kind: 'skip', msg: '' };
    out.push(r);
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const eq = line.indexOf('=');
    if (eq < 1) { r.kind = 'error'; r.msg = 'Expected path=value'; return; }
    const path = line.slice(0, eq).trim();
    const parsed = parseOverrides(line);
    if (!parsed.length) { r.kind = 'error'; r.msg = 'Could not read this line'; return; }
    const value = parsed[0][1];
    const keys = path.split('.');
    let o = DEFAULTS;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (!isObj(o) || !(key in o)) {
        const s = isObj(o) ? suggest(key, Object.keys(o)) : null;
        const where = keys.slice(0, k).join('.') || 'top level';
        r.kind = 'error';
        r.msg = `Unknown setting "${key}" in ${where}` + (s ? `. Did you mean "${s}"?` : '');
        return;
      }
      o = o[key];
    }
    const def = o;
    if (isObj(def) && !isObj(value)) {
      r.kind = 'error';
      r.msg = `"${path}" is a group. Set one of: ${Object.keys(def).slice(0, 6).join(', ')}${Object.keys(def).length > 6 ? ', ...' : ''}`;
      return;
    }
    if (typeof def === 'number' && typeof value !== 'number') { r.kind = 'error'; r.msg = `Needs ${typeName(def)}`; return; }
    if (typeof def === 'boolean' && typeof value !== 'boolean') { r.kind = 'error'; r.msg = 'Needs true or false'; return; }
    if (Array.isArray(def) && !Array.isArray(value)) { r.kind = 'error'; r.msg = `Needs ${typeName(def)}`; return; }
    if (typeof def === 'function' && typeof value !== 'number') { r.kind = 'error'; r.msg = 'Needs a number (replaces the formula)'; return; }
    if (typeof value === 'number' && value < 0 && typeof def === 'number' && def >= 0) { r.kind = 'warn'; r.msg = 'Negative value; the default is positive'; return; }
    r.kind = typeof def === 'function' ? 'warn' : 'ok';
    r.msg = typeof def === 'function' ? 'Replaces a formula with a flat value' : '';
  });
  return out;
}

export function mutatorSummary(results) {
  let ok = 0, warn = 0, error = 0;
  for (const r of results) { if (r.kind === 'ok') ok++; else if (r.kind === 'warn') warn++; else if (r.kind === 'error') error++; }
  return { ok, warn, error, usable: ok + warn };
}

// Lines that pass validation (errors dropped).
export function cleanMutatorLines(text) {
  return validateMutatorText(text).filter(r => r.kind === 'ok' || r.kind === 'warn').map(r => r.text.trim());
}

// All leaf settings: [{ path, value }] for the settings index.
let leafCache = null;
export function settingPaths() {
  if (leafCache) return leafCache;
  const out = [];
  const walk = (o, pre) => {
    for (const k of Object.keys(o)) {
      const v = o[k], p = pre ? pre + '.' + k : k;
      if (isObj(v)) walk(v, p);
      else out.push({ path: p, value: typeof v === 'function' ? null : Array.isArray(v) ? JSON.stringify(v) : String(v) });
    }
  };
  walk(DEFAULTS, '');
  leafCache = out.filter(x => x.value !== null);
  return leafCache;
}

export function presetLines(ids) { return ids.flatMap(id => (MUTATOR_PRESETS[id] ? MUTATOR_PRESETS[id].lines : [])); }

// ------------------------------------------------------------ picker

// selection: { presets: Set<id>, custom: Map<libraryId, {name, lines}>, extra: { name, lines } | null }
export function newSelection() { return { presets: new Set(), custom: new Map(), extra: null }; }
export function selectionLines(sel) {
  return [...presetLines([...sel.presets]), ...[...sel.custom.values()].flatMap(c => c.lines), ...(sel.extra ? sel.extra.lines : [])];
}
export function selectionNames(sel) {
  return [...[...sel.presets].map(id => MUTATOR_PRESETS[id].name), ...[...sel.custom.values()].map(c => c.name), ...(sel.extra ? [sel.extra.name || 'Custom lines'] : [])];
}

export function mutatorPicker(sel, onChange) {
  const el = h('div.mut-picker');
  const list = h('div.mut-list');
  const count = h('span.mut-count.tiny');
  const writeBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => openEditor() }, 'Write mutator…');
  el.append(h('div.spread', h('span.label', 'Mutators'), count), list, h('div.btn-row', writeBtn));

  let customs = [];
  const refreshCount = () => {
    const n = sel.presets.size + sel.custom.size + (sel.extra ? 1 : 0);
    count.textContent = n ? `${n} active · ${selectionLines(sel).length} lines` : 'None active';
  };

  function row(id, name, desc, checked, toggle, extra = null) {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => { sfx.key(); toggle(input.checked); refreshCount(); onChange(); });
    return h('label.mut-row', { title: desc }, h('span.check', input), h('span.mut-text', h('b', name), h('small', desc)), extra);
  }

  async function render() {
    clear(list);
    for (const [id, p] of Object.entries(MUTATOR_PRESETS)) {
      list.appendChild(row(id, p.name, p.desc, sel.presets.has(id), on => { if (on) sel.presets.add(id); else sel.presets.delete(id); }));
    }
    try { customs = await listItems({ type: 'mutator', sort: 'name' }); } catch (e) { customs = []; }
    if (customs.length) list.appendChild(h('div.mut-sep.label', 'From your library'));
    for (const m of customs) {
      list.appendChild(row(m.id, m.name, m.desc || 'Custom mutator', sel.custom.has(m.id), async on => {
        if (on) {
          const item = await getItem(m.id);
          if (item) sel.custom.set(m.id, { name: m.name, lines: item.data.lines });
        } else sel.custom.delete(m.id);
        refreshCount(); onChange();
      }));
    }
    if (sel.extra) {
      list.appendChild(h('div.mut-sep.label', 'Unsaved'));
      list.appendChild(row('extra', sel.extra.name || 'Custom lines', `${sel.extra.lines.length} lines`, true, on => { if (!on) { sel.extra = null; render(); } },
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: (e) => { e.preventDefault(); openEditor(sel.extra); } }, 'Edit')));
    }
    refreshCount();
  }

  function openEditor(initial = null) {
    openMutatorEditor({
      initial: initial ? { name: initial.name, text: initial.lines.join('\n') } : null,
      onApply: (lines, name) => { sel.extra = { name, lines }; render(); onChange(); },
      onSaved: (item) => { sel.custom.set(item.id, { name: item.name, lines: item.data.lines }); if (initial === sel.extra) sel.extra = null; render(); onChange(); },
    });
  }

  render();
  return { el, render };
}

// ------------------------------------------------------------ editor modal

// openMutatorEditor({ initial: { name, text, id? }, onApply(lines, name), onSaved(item) })
export function openMutatorEditor({ initial = null, onApply = null, onSaved = null } = {}) {
  const name = h('input.input', { type: 'text', maxLength: 80, placeholder: 'Name, e.g. Long Night' });
  name.value = initial ? initial.name || '' : '';
  const ta = h('textarea.input.mut-text-area', { spellcheck: 'false', rows: 12, placeholder: '# One setting per line, later lines win\nzombie.speed=4.2\neconomy.moneyMax=18000' });
  ta.value = initial ? initial.text || '' : '';
  const gutter = h('div.mut-gutter', { 'aria-hidden': 'true' });
  const report = h('ol.mut-report');
  const status = h('span.mut-status.small');
  const presetSel = h('select.select', h('option', { value: '' }, 'Insert a preset…'),
    Object.entries(MUTATOR_PRESETS).map(([id, p]) => h('option', { value: id }, p.name)));
  presetSel.addEventListener('change', () => {
    const p = MUTATOR_PRESETS[presetSel.value];
    if (p) { insertLines([`# ${p.name}`, ...p.lines]); }
    presetSel.value = '';
  });

  const filter = h('input.input', { type: 'search', placeholder: 'Find a setting (e.g. speed)' });
  const index = h('ul.mut-index');
  const renderIndex = () => {
    clear(index);
    const q = filter.value.trim().toLowerCase();
    const all = settingPaths().filter(p => !q || p.path.toLowerCase().includes(q));
    for (const p of all.slice(0, 120)) {
      index.appendChild(h('li', h('button', { type: 'button', title: 'Insert this line', onclick: () => insertLines([`${p.path}=${p.value}`]) }, h('code', p.path), h('span', p.value))));
    }
    if (all.length > 120) index.appendChild(h('li.tiny.faint', `${all.length - 120} more: narrow the search`));
    if (!all.length) index.appendChild(h('li.tiny.faint', 'No setting matches.'));
  };
  filter.addEventListener('input', debounce(renderIndex, 100));

  function insertLines(lines) {
    const v = ta.value;
    ta.value = (v && !v.endsWith('\n') ? v + '\n' : v) + lines.join('\n') + '\n';
    validate();
    ta.focus();
  }

  let results = [];
  function validate() {
    results = validateMutatorText(ta.value);
    const n = Math.max(results.length, 1);
    clear(gutter);
    for (let i = 0; i < n; i++) {
      const r = results[i];
      gutter.appendChild(h('span.g-' + (r ? r.kind : 'skip'), String(i + 1)));
    }
    clear(report);
    for (const r of results) if (r.kind === 'error' || r.kind === 'warn') report.appendChild(h('li.' + r.kind, h('b', `Line ${r.n}`), ' ', r.msg));
    const s = mutatorSummary(results);
    status.className = 'mut-status small ' + (s.error ? 'err-text' : s.usable ? 'ok-text' : 'faint');
    status.textContent = s.error ? `${s.error} line${s.error > 1 ? 's' : ''} will be ignored` : s.usable ? `${s.usable} setting${s.usable > 1 ? 's' : ''} ready` : 'No settings yet';
    if (modal) {
      for (const b of modal.buttons.slice(1)) b.disabled = !s.usable;
    }
  }
  ta.addEventListener('input', debounce(validate, 120));
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); }
  });

  const body = h('div.mut-editor',
    h('div.mut-main',
      h('div.field', h('label', 'Name'), name),
      h('div.field', h('label', 'Settings (path=value, one per line)'), h('div.mut-code', gutter, ta)),
      h('div.spread', status, presetSel),
      report),
    h('aside.mut-side',
      h('span.label', 'Settings index'),
      filter,
      index,
      h('p.tiny.faint', 'Click a setting to add it with its default value. Lists use brackets: mutation.intervalSec=[15,25].')));

  const actions = [{ label: 'Cancel', kind: 'ghost' }];
  if (onApply) actions.push({ label: 'Use without saving', onClick: () => { const lines = cleanMutatorLines(ta.value); if (!lines.length) return false; onApply(lines, name.value.trim() || 'Custom lines'); } });
  actions.push({
    label: 'Save to library', kind: 'go',
    onClick: () => {
      const lines = cleanMutatorLines(ta.value);
      if (!lines.length) return false;
      return saveItem({ type: 'mutator', id: initial && initial.id, name: name.value.trim() || 'Untitled mutator', data: { lines } })
        .then(item => { toast({ kind: 'info', stamp: 'Filed', title: item.name, body: 'Saved to your library.' }); if (onSaved) onSaved(item); return true; })
        .catch(err => { toast({ kind: 'error', stamp: 'Error', title: 'Could not save', body: err.message }); return false; });
    },
  });
  let modal = null;
  modal = openModal({ title: 'Mutator editor', no: 'Form OCP-31', body, actions, wide: true, initialFocus: 'textarea' });
  renderIndex();
  validate();
  return modal;
}
