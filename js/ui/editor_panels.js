// Editor side panels (Item, Stages, Sheet, Check) and dialogs (new sheet, confirm, share code).
import { BUILDING_KINDS, ROAD_KINDS, ROAD_WIDTH, KIND_LABEL, KIND_TAG, USES, DEFAULT_HEIGHT, DEFAULT_USE, LIMITS, mapStats, emptyMap, makeStages, normalizeMap } from '../map/format.js';
import { WATER_TYPES, generateCity } from '../map/citygen.js';
import { listItems, getItem, importFile, fromShareCode } from '../map/library.js';
import { OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL } from '../map/osm.js';
import { PALETTE_NAMES, PALETTE_LABELS } from '../render/palette.js';
import { polyArea } from '../util/geom.js';
import { DEFAULTS } from '../data/config.js';
import { COLL_LABEL, polylineLength } from './editor_model.js';
import { stageInfo } from './editor_check.js';
import { fmtM, fmtM2 } from './editor_render.js';

import { el, copyText } from './editor_dom.js';

const kv = (k, v) => el('div', { class: 'kv' }, el('span', { text: k }), el('i'), el('b', { text: v }));
const field = (lab, input, hint) => el('div', { class: 'field' }, el('label', { text: lab }), input, hint ? el('div', { class: 'hint', text: hint }) : null);
const num = v => Number(v).toLocaleString('en-GB');
const btn = (text, onclick, cls = 'btn btn-sm', extra = {}) => el('button', { class: cls, type: 'button', onclick, ...extra }, text);

function seg(options, current, onPick, key) {
  return el('div', { class: 'seg ed-seg', role: 'radiogroup', dataset: key ? { key } : undefined },
    options.map(([v, t]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(v === current), onclick: () => onPick(v) }, t)));
}

function select(options, current, onChange, key) {
  return el('select', { class: 'select', dataset: { key }, onchange: e => onChange(e.target.value), value: current },
    options.map(([v, t]) => el('option', { value: v }, t)));
}

function numInput(value, min, max, step, onInput, key, placeholder) {
  return el('input', {
    class: 'input', type: 'number', min, max, step, value: value === '' || value == null ? '' : value, placeholder, dataset: { key },
    oninput: e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onInput(Math.max(min, Math.min(max, v))); },
  });
}

function textInput(value, onInput, key, opts = {}) {
  return el(opts.area ? 'textarea' : 'input', {
    class: 'input', type: opts.area ? undefined : 'text', value: value || '', maxlength: opts.max || 80, placeholder: opts.placeholder,
    list: opts.list, rows: opts.rows, dataset: { key }, oninput: e => onInput(e.target.value),
  });
}

const kindOptions = () => BUILDING_KINDS.map(k => [k, KIND_LABEL[k] + (KIND_TAG[k] ? ` (${KIND_TAG[k]})` : '')]);
const roadOptions = () => ROAD_KINDS.map(k => [k, { major: 'Major', minor: 'Street', path: 'Path', rail: 'Rail', bridge: 'Bridge' }[k]]);

function usesList(id, kind) {
  return el('datalist', { id }, (USES[kind] || []).map(u => el('option', { value: u })));
}

// ---------------------------------------------------------------- Item tab

export function renderItemPanel(ed, host) {
  const t = ed.tool.id;
  if (t === 'road') return host.append(roadToolPanel(ed));
  if (t === 'building') return host.append(buildingToolPanel(ed));
  if (t === 'water' || t === 'park') return host.append(shapeModePanel(ed, t === 'water' ? 'water' : 'parks', t === 'water' ? 'Water' : 'Park'));
  if (t === 'erase') return host.append(erasePanel(ed));
  if (t === 'spawn') return host.append(spawnPanel(ed));
  if (t === 'stage') return host.append(el('p', { class: 'small muted', text: 'Stage boundaries are listed in the Stages tab.' }));
  host.append(selectionPanel(ed));
}

function head(title, no) {
  return el('div', { class: 'ed-panel-head' }, el('h3', { class: 'h4', text: title }), no ? el('span', { class: 'card-no', text: no }) : null);
}

function snapToggle(ed) {
  return el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: ed.opts.snap, onchange: e => { ed.opts.snap = e.target.checked; } }), el('span', { class: 'toggle-track' }), 'Snap to map');
}

function roadToolPanel(ed) {
  const o = ed.opts.road;
  return el('div', { class: 'vstack gap-3' },
    head('New road', 'TOOL R'),
    field('Kind', seg(roadOptions(), o.k, k => { if (o.w === ROAD_WIDTH[o.k]) o.w = ROAD_WIDTH[k]; o.k = k; ed.panels(); }, 'road-k'),
      o.k === 'bridge' ? 'Draw bridges across water, ending on land on both banks.' : o.k === 'rail' ? 'Rail lines are walkable and slow nothing; they read as track on the map.' : null),
    field('Width (m)', numInput(o.w, 1, 60, 0.5, v => { o.w = v; ed.redraw(); }, 'road-w')),
    field('Name', textInput(o.name, v => { o.name = v.trim(); }, 'road-name', { placeholder: 'optional' })),
    snapToggle(ed));
}

function buildingFields(ed, o, onChange, multi) {
  const listId = 'ed-uses-' + o.k;
  return [
    field('Class', select(kindOptions(), o.k, k => onChange({ k }), 'b-k'),
      KIND_TAG[o.k] ? (o.k === 'hazard' ? 'Explodes when destroyed.' : 'Special building: a function can be assigned while inside a safe zone.') : null),
    field('Height (m)', numInput(o.h, 2, 900, 1, h => onChange({ h }), 'b-h', multi ? 'mixed' : undefined)),
    field('Use', el('div', null, textInput(o.use, use => onChange({ use }), 'b-use', { list: listId, placeholder: DEFAULT_USE[o.k] }), usesList(listId, o.k))),
  ];
}

function buildingToolPanel(ed) {
  const o = ed.opts.bldg;
  return el('div', { class: 'vstack gap-3' },
    head('New building', 'TOOL B'),
    field('Shape', seg([['rect', 'Rectangle'], ['poly', 'Polygon']], ed.opts.shape.buildings, v => { ed.opts.shape.buildings = v; ed.tool.cancel(ed); ed.panels(); ed.hintUpdate(); }, 'shape')),
    buildingFields(ed, o, ch => {
      if (ch.k && ch.k !== o.k) { o.h = DEFAULT_HEIGHT[ch.k]; o.use = ''; }
      Object.assign(o, ch);
      if (ch.k) ed.panels();
    }),
    field('Name', textInput(o.name, v => { o.name = v.trim(); }, 'b-name', { placeholder: 'optional' })),
    snapToggle(ed));
}

function shapeModePanel(ed, coll, name) {
  return el('div', { class: 'vstack gap-3' },
    head('New ' + name.toLowerCase(), 'TOOL ' + (coll === 'water' ? 'W' : 'G')),
    field('Shape', seg([['poly', 'Polygon'], ['rect', 'Rectangle']], ed.opts.shape[coll], v => { ed.opts.shape[coll] = v; ed.tool.cancel(ed); ed.panels(); ed.hintUpdate(); }, 'shape')),
    el('p', { class: 'small muted', text: coll === 'water'
      ? 'Water blocks walkers (swimmers excepted). Roads drawn over it must be bridges.'
      : 'Parks are open ground that burns readily.' }),
    snapToggle(ed));
}

function erasePanel(ed) {
  const o = ed.opts.erase;
  return el('div', { class: 'vstack gap-3' },
    head('Eraser', 'TOOL X'),
    el('div', { class: 'field-label', text: 'Takes' }),
    el('div', { class: 'vstack gap-2' }, ['buildings', 'roads', 'water', 'parks', 'spawns'].map(c =>
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: o[c], onchange: e => { o[c] = e.target.checked; } }), c === 'spawns' ? 'Outbreak points' : c[0].toUpperCase() + c.slice(1)))));
}

function spawnPanel(ed) {
  const n = ed.doc.map.spawns.length;
  return el('div', { class: 'vstack gap-3' },
    head('Outbreak hints', 'TOOL O'),
    el('p', { class: 'small', text: 'Optional. Marked points tell the outbreak where it may start; without marks it picks crowded streets on its own.' }),
    kv('Points marked', String(n)),
    n ? btn('Clear all points', () => { ed.doc.setColl('spawns', [], 'Clear outbreak points'); ed.toast('Outbreak points cleared'); }) : null);
}

function selectionPanel(ed) {
  const sel = ed.sel, m = ed.doc.map;
  if (!sel.length) {
    const s = mapStats(m);
    return el('div', { class: 'vstack gap-3' },
      head('Nothing selected', 'TOOL S'),
      el('p', { class: 'small muted', text: 'Click an item on the sheet to edit it. Drag across empty ground to select a group; Shift adds to it.' }),
      el('div', null, kv('Buildings', num(s.buildings)), kv('Roads', num(s.roads)), kv('Bridges', num(s.bridges)),
        kv('Water areas', num(m.water.length)), kv('Parks', num(m.parks.length)), kv('Outbreak points', num(m.spawns.length)), kv('Nominal population', num(s.nominalPop))));
  }
  const colls = [...new Set(sel.map(r => r.coll))];
  const actions = el('div', { class: 'hstack gap-2 ed-actions-row' },
    sel.some(r => r.coll !== 'spawns') ? btn('Duplicate', () => ed.duplicateSelection(), 'btn btn-sm', { title: 'Ctrl+D' }) : null,
    colls.every(c => c === 'buildings' || c === 'water' || c === 'parks') ? [
      btn('Rotate −15°', () => ed.rotateSelection(-15)), btn('Rotate +15°', () => ed.rotateSelection(15))] : null,
    btn('Delete', () => ed.deleteSelection(), 'btn btn-sm btn-primary', { title: 'Del' }));
  if (colls.length > 1) {
    return el('div', { class: 'vstack gap-3' }, head(`${sel.length} items selected`, 'MIXED'),
      el('div', null, colls.map(c => kv(COLL_LABEL[c] + 's', String(sel.filter(r => r.coll === c).length)))), actions);
  }
  const coll = colls[0], items = sel.map(r => m[r.coll][r.idx]).filter(Boolean);
  const one = items.length === 1;
  const title = one ? `${COLL_LABEL[coll]} ${sel[0].idx + 1}` : `${items.length} ${COLL_LABEL[coll].toLowerCase()}s`;
  const patchAll = (fields, key) => ed.fromPanel(() => {
    if (one) ed.doc.patch(sel[0].coll, sel[0].idx, fields, key);
    else ed.doc.transact('Edit', () => { for (const r of sel) ed.doc.patch(r.coll, r.idx, fields); }, key);
  });
  const out = el('div', { class: 'vstack gap-3' }, head(title, coll.toUpperCase()));
  if (coll === 'buildings') {
    const same = f => items.every(b => b[f] === items[0][f]) ? items[0][f] : '';
    const o = { k: same('k') || items[0].k, h: same('h'), use: same('use') };
    out.append(...buildingFields(ed, o, ch => {
      if (ch.k) { patchAll({ k: ch.k }); ed.panels(); return; }
      if (ch.h != null) patchAll({ h: ch.h }, `b-h:${sel.map(r => r.idx).join(',')}`);
      if (ch.use != null) patchAll({ use: ch.use.slice(0, 60) || undefined }, `b-use:${sel.map(r => r.idx).join(',')}`);
    }, !one && o.h === ''));
    if (one) out.append(field('Name', textInput(items[0].name, v => patchAll({ name: v.trim() || undefined }, `b-name:${sel[0].idx}`), 'b-name', { placeholder: 'optional' })));
    const area = items.reduce((s, b) => s + polyArea(b.p), 0);
    const pop = items.reduce((s, b) => s + polyArea(b.p) * DEFAULTS.population.perM2 * (DEFAULTS.population.kindMul[b.k] ?? 1), 0);
    out.append(el('div', null, kv('Footprint', fmtM2(area)), kv('Nominal population', num(Math.round(pop))), one ? kv('Corners', String(items[0].p.length / 2)) : null));
  } else if (coll === 'roads') {
    const k = items.every(r => r.k === items[0].k) ? items[0].k : '';
    const w = items.every(r => r.w === items[0].w) ? items[0].w : '';
    out.append(field('Kind', seg(roadOptions(), k, nk => {
      ed.fromPanel(() => ed.doc.transact('Edit', () => { for (const r of sel) { const it = m.roads[r.idx]; ed.doc.patch('roads', r.idx, it.w === ROAD_WIDTH[it.k] ? { k: nk, w: ROAD_WIDTH[nk] } : { k: nk }); } }));
      ed.panels();
    }, 'r-k')));
    out.append(field('Width (m)', numInput(w, 1, 60, 0.5, v => patchAll({ w: v }, `r-w:${sel.map(r => r.idx).join(',')}`), 'r-w', w === '' ? 'mixed' : undefined)));
    if (one) out.append(field('Name', textInput(items[0].name, v => patchAll({ name: v.trim() || undefined }, `r-name:${sel[0].idx}`), 'r-name', { placeholder: 'optional' })));
    out.append(el('div', null, kv('Length', fmtM(items.reduce((s, r) => s + polylineLength(r.p), 0))), one ? kv('Nodes', String(items[0].p.length / 2)) : null));
  } else if (coll === 'water' || coll === 'parks') {
    out.append(el('div', null, kv('Area', fmtM2(items.reduce((s, x) => s + polyArea(x.p), 0))), one ? kv('Corners', String(items[0].p.length / 2)) : null));
    out.append(btn(coll === 'water' ? 'Turn into park' : 'Turn into water', () => ed.convertSelection(coll === 'water' ? 'parks' : 'water')));
  } else if (coll === 'spawns') {
    if (one) out.append(el('div', null, kv('East', fmtM(items[0][0])), kv('South', fmtM(items[0][1]))));
  }
  out.append(actions);
  return out;
}

// ---------------------------------------------------------------- Stages tab

export function renderStagesPanel(ed, host) {
  const m = ed.doc.map, info = stageInfo(m);
  const n = m.levels.length;
  const rows = info.map(s => {
    const k = s.idx, on = k === ed.activeStage;
    return el('tr', { class: on ? 'is-sel' : '', onclick: e => { if (!e.target.closest('button,input')) ed.setActiveStage(k); } },
      el('td', { class: 'num' }, el('b', { text: String(k + 1) })),
      el('td', null, el('input', { class: 'input line ed-stage-label', type: 'text', maxlength: 60, value: m.levels[k].label || '', placeholder: `Stage ${k + 1}`, dataset: { key: 'stage-label-' + k },
        onfocus: () => { if (ed.activeStage !== k) ed.setActiveStage(k, true); },
        oninput: e => ed.fromPanel(() => ed.doc.patch('levels', k, { label: e.target.value.trim().slice(0, 60) || undefined }, 'stage-label-' + k)) })),
      el('td', { class: 'num', text: s.areaKm2 < 0.1 ? s.areaKm2.toFixed(3) : s.areaKm2.toFixed(2) }),
      el('td', { class: 'num', text: num(s.civilians) },
        !s.nested ? el('span', { class: 'chip ed-chip-warn', title: `Does not contain stage ${k}`, text: 'NEST' }) : null,
        s.buildings === 0 ? el('span', { class: 'chip ed-chip-err', title: 'No buildings inside', text: 'EMPTY' }) : null),
      el('td', { class: 'ed-row-btns' },
        btn('↑', () => ed.moveStage(k, -1), 'btn btn-icon btn-sm', { disabled: k === 0, title: 'Move inward', 'aria-label': 'Move stage up' }),
        btn('↓', () => ed.moveStage(k, 1), 'btn btn-icon btn-sm', { disabled: k === n - 1, title: 'Move outward', 'aria-label': 'Move stage down' }),
        btn('✕', () => ed.removeStage(k), 'btn btn-icon btn-sm', { disabled: n <= 1, title: 'Remove stage', 'aria-label': 'Remove stage' })));
  });
  const countSel = el('select', { class: 'select ed-auto-count', value: String(Math.max(3, Math.min(7, n || 5))) }, [3, 4, 5, 6, 7].map(c => el('option', { value: String(c) }, c + ' stages')));
  const drawing = ed.tools.stage.drawing;
  host.append(
    head('Stage boundaries', `${n} / ${LIMITS.maxLevels}`),
    el('p', { class: 'small muted', text: 'Stage 1 is the first district. Each later stage must contain the one before it; the last is usually the whole sheet.' }),
    el('table', { class: 'table compact ed-stage-table' },
      el('colgroup', null, el('col', { style: 'width:1.7rem' }), el('col'), el('col', { style: 'width:3.3rem' }), el('col', { style: 'width:3.6rem' }), el('col', { style: 'width:4.9rem' })),
      el('thead', null, el('tr', null, el('th', { class: 'num', text: '#' }), el('th', { text: 'Label' }), el('th', { class: 'num', text: 'km²' }), el('th', { class: 'num', text: 'Civ.' }), el('th'))),
      el('tbody', null, rows)),
    el('div', { class: 'hstack gap-2' },
      btn(drawing ? 'Drawing…' : 'Redraw', () => ed.startStageDraw(), 'btn btn-sm' + (drawing ? ' is-on' : ''), { disabled: !n, title: 'Trace a new boundary for the selected stage', dataset: { act: 'stage-redraw' } }),
      btn('Whole sheet', () => ed.stageWholeSheet(), 'btn btn-sm', { disabled: !n, dataset: { act: 'stage-whole' } }),
      btn('Add stage', () => ed.addStage(), 'btn btn-sm', { disabled: n >= LIMITS.maxLevels, dataset: { act: 'stage-add' } })),
    el('hr', { class: 'rule-faint' }),
    el('div', { class: 'field' }, el('label', { text: 'Auto-draw all stages' }),
      countSel,
      el('div', { class: 'ed-grid2 ed-auto' },
        btn('Around view centre', () => ed.autoStages(+countSel.value, 'view'), 'btn btn-sm', { dataset: { act: 'stage-auto-view' } }),
        btn('Around sheet centre', () => ed.autoStages(+countSel.value, 'sheet'), 'btn btn-sm', { dataset: { act: 'stage-auto-sheet' } })),
      el('div', { class: 'hint', text: 'Replaces every boundary with nested rings sized by land area.' })),
    el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: ed.dimOutside, onchange: e => { ed.dimOutside = e.target.checked; ed.redraw(); } }), el('span', { class: 'toggle-track' }), 'Shade outside the selected stage'));
}

// ---------------------------------------------------------------- Sheet tab

export function renderSheetPanel(ed, host) {
  const m = ed.doc.map, s = mapStats(m);
  const meta = (key, v, merge) => ed.fromPanel(() => ed.doc.setMeta(key, v, merge ? 'meta-' + key : null));
  const wIn = el('input', { class: 'input', type: 'number', min: LIMITS.minSize, max: LIMITS.maxSize, step: 10, value: m.w });
  const hIn = el('input', { class: 'input', type: 'number', min: LIMITS.minSize, max: LIMITS.maxSize, step: 10, value: m.h });
  host.append(
    head('Sheet details', (m.source || 'editor').toUpperCase()),
    field('Map name', textInput(m.name, v => meta('name', v.slice(0, 80), true), 'm-name', { max: 80 })),
    field('Author', textInput(m.author, v => meta('author', v.slice(0, 60), true), 'm-author', { max: 60, placeholder: 'optional' })),
    field('Description', textInput(m.desc, v => meta('desc', v.slice(0, 2000), true), 'm-desc', { area: true, rows: 3, max: 2000, placeholder: 'Shown in the library' })),
    field('Welcome message', textInput(m.welcome, v => meta('welcome', v.slice(0, 2000), true), 'm-welcome', { area: true, rows: 3, max: 2000, placeholder: 'Shown when the map starts' })),
    field('Print preset', seg(PALETTE_NAMES.map(p => [p, PALETTE_LABELS[p]]), m.palette, p => { meta('palette', p); ed.panels(); }, 'm-pal')),
    field('Seed', el('div', { class: 'hstack gap-2' },
      numInput(m.seed, 0, 4294967295, 1, v => meta('seed', Math.floor(v) >>> 0, true), 'm-seed'),
      btn('Reroll', () => { meta('seed', (Math.random() * 4294967296) >>> 0); ed.panels(); })), 'Seeds the outbreak sites and civilian packs.'),
    field('Sheet size (m)', el('div', { class: 'hstack gap-2 ed-size' }, wIn, el('span', { class: 'muted', text: '×' }), hIn,
      btn('Apply', () => ed.resizeSheet(+wIn.value, +hIn.value))), 'Shrinking crops anything outside the new edge.'),
    el('hr', { class: 'rule-faint' }),
    el('div', null,
      kv('Sheet', `${(m.w / 1000).toFixed(2)} × ${(m.h / 1000).toFixed(2)} km`), kv('Buildings', num(s.buildings)), kv('Roads', `${num(s.roads)} · ${s.roadKm} km`),
      kv('Bridges', num(s.bridges)), kv('Water', s.waterKm2.toFixed(3) + ' km²'), kv('Parks', s.parkKm2.toFixed(3) + ' km²'),
      kv('Specials', `${s.specials.civic} CIV · ${s.specials.trade} COM · ${s.specials.armory} ARS · ${s.specials.rescue} REL · ${s.specials.hazard} HAZ`),
      kv('Nominal population', num(s.nominalPop))),
    m.geo ? el('p', { class: 'tiny muted ed-attrib' }, 'Map data ', el('a', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener', text: OSM_ATTRIBUTION })) : null);
}

// ---------------------------------------------------------------- Check tab

export function renderCheckPanel(ed, host) {
  const r = ed.issues;
  host.append(head('Inspection', r ? (r.stale ? 'OUT OF DATE' : 'CURRENT') : 'NOT RUN'),
    el('div', { class: 'hstack gap-2' }, btn('Run inspection', () => ed.runCheck(), 'btn btn-sm'), r && r.stale ? el('span', { class: 'small muted', text: 'The map changed since the last run.' }) : null));
  if (!r) { host.append(el('p', { class: 'small muted', text: 'Checks the format, nested stages, civilians in every stage and bridges over water. Test Play runs it too.' })); return; }
  host.append(el('div', { class: 'ed-verdict' },
    el('span', { class: `stamp stamp-sm ${r.ok ? 'stamp-green tilt-2' : 'tilt-3'}`, text: r.ok ? 'Approved' : 'Rejected' }),
    el('span', { class: 'small', text: `${r.errors.length} error${r.errors.length === 1 ? '' : 's'} · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` })));
  const list = el('ol', { class: 'log ed-issues' });
  r.list.forEach((it, i) => {
    list.append(el('li', { class: it.level === 'error' ? 'alert' : 'warn', tabindex: it.at ? '0' : undefined, onclick: () => ed.gotoIssue(it), onkeydown: e => { if (e.key === 'Enter') ed.gotoIssue(it); } },
      el('span', { class: 't', text: String(i + 1).padStart(2, '0') }), el('span', { text: it.msg })));
  });
  if (!r.list.length) list.append(el('li', { class: 'good' }, el('span', { class: 't', text: '--' }), el('span', { text: 'No problems found.' })));
  host.append(list);
}

// ---------------------------------------------------------------- dialogs

function modal(root, title, body, foot, opts = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (opts.onClose) opts.onClose(); };
  const onKey = e => { if (e.key === 'Escape' && opts.escape !== false) { e.stopPropagation(); e.preventDefault(); close(); } };
  const back = el('div', { class: 'modal-backdrop ed-modal' },
    el('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'modal-head' }, el('h3', { class: 'modal-title', text: title }),
        opts.closable === false ? null : el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
      el('div', { class: 'modal-body' }, body), foot ? el('div', { class: 'modal-foot' }, foot) : null));
  document.addEventListener('keydown', onKey, true);
  root.append(back);
  const first = back.querySelector('[autofocus]') || back.querySelector('.modal-foot .btn-primary, .modal-foot .btn-go');
  if (first) setTimeout(() => first.focus(), 0);
  return { close, el: back };
}

export function confirmDialog(root, { title, text, ok = 'OK', cancel = 'Cancel', extra = null, danger = true }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(root, title, el('p', { text }), [
      btn(cancel, () => finish(false), 'btn btn-ghost'),
      extra ? btn(extra, () => finish('extra'), 'btn') : null,
      btn(ok, () => finish(true), danger ? 'btn btn-primary' : 'btn btn-go'),
    ], { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export function shareDialog(root, code) {
  const ta = el('textarea', { class: 'input ed-code', readOnly: true, rows: 6, value: code });
  const status = el('span', { class: 'small muted' });
  const copy = async () => { status.textContent = (await copyText(code, ta)) ? 'Copied to the clipboard.' : 'Select the code and copy it by hand.'; };
  const m = modal(root, 'Share code', el('div', { class: 'vstack gap-2' },
    el('p', { class: 'small', text: `Anyone can paste this code into Open > Share code. ${code.length.toLocaleString('en-GB')} characters.` }),
    code.length > 200000 ? el('p', { class: 'small red', text: 'This map is large; sending the exported file is easier than a code this long.' }) : null,
    ta, status), [btn('Close', () => m.close(), 'btn btn-ghost'), btn('Copy', copy, 'btn btn-go')]);
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}

export function shortcutsDialog(root) {
  const rows = [
    ['S', 'Select / move / reshape'], ['R', 'Road'], ['B', 'Building'], ['W', 'Water'], ['G', 'Park'], ['X', 'Erase'], ['T', 'Stage boundaries'], ['O', 'Outbreak hints'],
    ['Enter', 'Finish the road or shape'], ['Backspace', 'Remove the last node'], ['Esc', 'Cancel / clear selection'], ['Shift', 'Lock to 15° / square / axis'], ['Alt', 'Place without snapping'],
    ['Del', 'Delete selection'], ['Ctrl+D', 'Duplicate selection'], ['Arrows', 'Nudge selection (Shift ×10) or pan'], ['[ ]', 'Rotate selection 5° (Shift 15°)'],
    ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+S', 'Save to library'], ['Ctrl+E', 'Export file'],
    ['V', 'Heights view'], ['C', 'Specials view'], ['F', 'Fit the sheet'], ['Wheel', 'Zoom'], ['Right / middle drag, Space+drag', 'Pan'], ['?', 'This card'],
  ];
  const m = modal(root, 'Drafting keys', el('table', { class: 'table compact ed-keys' }, el('tbody', null,
    rows.map(([k, t]) => el('tr', null, el('td', null, k.length > 12 ? el('span', { class: 'small', text: k }) : el('kbd', { class: 'keycap', text: k })), el('td', { text: t }))))),
    [btn('Close', () => m.close(), 'btn btn-go')], { wide: false });
}

// New-sheet dialog: blank, generated or opened from the library / a file / a share code.
// Resolves to { map, libId? } or null when cancelled.
export function startDialog(root, opts = {}) {
  return new Promise(resolve => {
    let done = false, importer = null;
    const dropImporter = () => { if (importer) { importer.destroy(); importer = null; } };
    const finish = v => { if (done) return; done = true; dropImporter(); m.close(); resolve(v); };
    const err = el('div', { class: 'error ed-start-error', role: 'alert' });
    const fail = e => { err.textContent = e && e.message ? e.message : String(e); };
    const tabs = [['blank', 'Blank sheet'], ['gen', 'Generate'], ['osm', 'Real place'], ['open', 'Open']];
    let tab = opts.tab || 'blank';
    const body = el('div', { class: 'ed-start' });
    const tabBar = el('div', { class: 'tabs', role: 'tablist' });
    const folder = el('div', { class: 'folder-body' });

    const blankForm = () => {
      const name = el('input', { class: 'input', type: 'text', maxlength: 80, value: 'Untitled district', autofocus: true, dataset: { key: 'blank-name' } });
      const size = el('select', { class: 'select', value: '1000', dataset: { key: 'blank-size' } },
        [[500, '0.5 × 0.5 km'], [1000, '1 × 1 km'], [1500, '1.5 × 1.5 km'], [2000, '2 × 2 km'], [3000, '3 × 3 km'], [4000, '4 × 4 km'], [5000, '5 × 5 km'], ['custom', 'Custom…']]
          .map(([v, t]) => el('option', { value: String(v) }, t)));
      const cw = el('input', { class: 'input', type: 'number', min: LIMITS.minSize, max: LIMITS.maxSize, step: 10, value: 1200, dataset: { key: 'blank-w' } });
      const ch = el('input', { class: 'input', type: 'number', min: LIMITS.minSize, max: LIMITS.maxSize, step: 10, value: 800, dataset: { key: 'blank-h' } });
      const custom = el('div', { class: 'hstack gap-2', hidden: true }, cw, el('span', { class: 'muted', text: '×' }), ch, el('span', { class: 'small muted', text: 'metres' }));
      size.addEventListener('change', () => { custom.hidden = size.value !== 'custom'; });
      const stages = el('select', { class: 'select', value: '4', dataset: { key: 'blank-stages' } }, [3, 4, 5, 6, 7].map(c => el('option', { value: String(c) }, String(c))));
      const go = () => {
        let w = +size.value, h = w;
        if (size.value === 'custom') { w = +cw.value; h = +ch.value; }
        if (!(w >= LIMITS.minSize && w <= LIMITS.maxSize && h >= LIMITS.minSize && h <= LIMITS.maxSize)) return fail(`Size must be ${LIMITS.minSize}-${LIMITS.maxSize} m`);
        const map = emptyMap(w, h, name.value.trim() || 'Untitled');
        map.levels = makeStages(w, h, +stages.value, { seed: map.seed });
        finish({ map: normalizeMap(map) });
      };
      return el('div', { class: 'vstack gap-3' },
        el('p', { class: 'small', text: 'An empty survey sheet with nested stage rings ready to adjust.' }),
        field('Name', name), field('Sheet size', size), custom, field('Stages', stages),
        el('div', { class: 'hstack' }, btn('Rule the sheet', go, 'btn btn-go', { dataset: { act: 'blank-go' } })));
    };

    const genForm = () => {
      const seed = el('input', { class: 'input', type: 'text', maxlength: 40, value: String((Math.random() * 1e6) | 0), dataset: { key: 'gen-seed' } });
      const size = el('select', { class: 'select', value: '2', dataset: { key: 'gen-size' } }, [1, 1.5, 2, 3, 4, 5].map(v => el('option', { value: String(v) }, `${v} × ${v} km`)));
      const water = el('select', { class: 'select', value: 'river', dataset: { key: 'gen-water' } }, WATER_TYPES.map(w => el('option', { value: w }, w[0].toUpperCase() + w.slice(1))));
      const dens = el('input', { class: 'slider', type: 'range', min: 0, max: 1, step: 0.05, value: 0.6, dataset: { key: 'gen-density' } });
      const bridges = el('input', { class: 'input', type: 'number', min: 0, max: 16, step: 1, value: 3, dataset: { key: 'gen-bridges' } });
      const stages = el('select', { class: 'select', value: '5', dataset: { key: 'gen-stages' } }, [3, 4, 5, 6, 7].map(c => el('option', { value: String(c) }, String(c))));
      const go = async e => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Drafting…';
        await new Promise(r => setTimeout(r, 30));
        try {
          const map = generateCity({ seed: seed.value.trim() || 1, sizeKm: +size.value, water: water.value, density: +dens.value, bridges: +bridges.value, stages: +stages.value });
          finish({ map });
        } catch (x) { fail(x); b.disabled = false; b.textContent = 'Draft the city'; }
      };
      return el('div', { class: 'vstack gap-3' },
        el('p', { class: 'small', text: 'Start from a generated town and redraw it to taste.' }),
        el('div', { class: 'ed-grid2' }, field('Seed', seed), field('Size', size), field('Water', water), field('Bridges', bridges), field('Density', dens), field('Stages', stages)),
        el('div', { class: 'hstack' }, btn('Draft the city', go, 'btn btn-go', { dataset: { act: 'gen-go' } })));
    };

    const openForm = () => {
      const list = el('div', { class: 'ed-lib-list', role: 'list' }, el('p', { class: 'small muted', text: 'Reading the library…' }));
      const search = el('input', { class: 'input', type: 'search', placeholder: 'Search maps', dataset: { key: 'lib-search' } });
      const load = async () => {
        try {
          const items = (await listItems({ sort: 'newest', search: search.value })).filter(i => i.type === 'map' || i.type === 'scenario');
          list.replaceChildren();
          if (!items.length) list.append(el('p', { class: 'small muted', text: search.value ? 'No maps match.' : 'The library has no maps yet.' }));
          for (const it of items.slice(0, 200)) {
            list.append(el('button', { class: 'ed-lib-row', type: 'button', role: 'listitem', onclick: async () => {
              try {
                const full = await getItem(it.id);
                if (!full) throw new Error('That item is no longer in the library');
                finish(full.type === 'scenario' ? { map: full.data.map } : { map: full.data, libId: full.id });
              } catch (x) { fail(x); }
            } },
              el('b', { text: it.name }), el('span', { class: 'small muted', text: `${it.type === 'scenario' ? 'Scenario · ' : ''}${it.w ? (it.w / 1000).toFixed(1) + ' km · ' : ''}${it.buildings != null ? num(it.buildings) + ' bldgs · ' : ''}${new Date(it.updated).toLocaleDateString('en-GB')}` })));
          }
        } catch (x) { fail(x); }
      };
      search.addEventListener('input', () => load());
      load();
      const file = el('input', { class: 'input', type: 'file', accept: '.json,.rcmap.json,application/json', dataset: { key: 'import-file' } });
      file.addEventListener('change', async () => {
        try {
          const it = await importFile(file.files[0]);
          if (it.type === 'map') finish({ map: it.data });
          else if (it.type === 'scenario') finish({ map: it.data.map });
          else throw new Error('That file holds a mutator, not a map');
        } catch (x) { fail(x); }
      });
      const code = el('textarea', { class: 'input', rows: 3, placeholder: 'RC1.…', dataset: { key: 'share-code' } });
      const fromCode = async () => {
        try {
          const it = await fromShareCode(code.value);
          if (it.type === 'map') finish({ map: it.data });
          else if (it.type === 'scenario') finish({ map: it.data.map });
          else throw new Error('That code holds a mutator, not a map');
        } catch (x) { fail(x); }
      };
      return el('div', { class: 'vstack gap-3' }, field('Library', el('div', { class: 'vstack gap-2' }, search, list)),
        field('Map file', file, 'A .rcmap.json export.'), field('Share code', code), el('div', { class: 'hstack' }, btn('Open code', fromCode, 'btn', { dataset: { act: 'code-go' } })));
    };

    // The same real-place finder as Free Play: search, square picker, mirrors, cache and .osm / Overpass files.
    const osmForm = () => {
      const box = el('div', { class: 'ed-osm' }, el('p', { class: 'small muted', text: 'Opening the place finder…' }));
      let picked = null;
      const go = btn('Draft from this place', () => { if (picked) finish({ map: picked }); }, 'btn btn-go', { dataset: { act: 'osm-go' }, disabled: true });
      import('./import.js').then(mod => {
        if (done || tab !== 'osm' || !box.isConnected) return;
        box.replaceChildren();
        importer = mod.mountImport(box, { onMap: map => { picked = map || null; go.disabled = !picked; } });
      }).catch(fail);
      return el('div', { class: 'vstack gap-3' }, box, el('div', { class: 'hstack' }, go));
    };

    const show = id => {
      dropImporter();
      tab = id;
      err.textContent = '';
      m.el.querySelector('.modal').classList.toggle('ed-modal-xl', id === 'osm');
      tabBar.replaceChildren(...tabs.map(([t, txt], i) => el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(t === tab), dataset: { tab: t }, onclick: () => show(t) },
        el('span', { class: 'tab-no', text: String(i + 1).padStart(2, '0') }), txt)));
      folder.replaceChildren(id === 'blank' ? blankForm() : id === 'gen' ? genForm() : id === 'osm' ? osmForm() : openForm());
    };
    body.append(el('div', { class: 'folder' }, tabBar, folder), err);
    const m = modal(root, 'New drafting sheet', body, [btn(opts.cancelText || 'Cancel', () => finish(null), 'btn btn-ghost')],
      { wide: true, onClose: () => { if (!done) { done = true; dropImporter(); resolve(null); } } });
    show(tab);
  });
}

export { el, copyText, modal };
