// Library ("workshop"): full management screen, plus a compact map picker used by Free Play.
import {
  listItems, getItem, saveItem, deleteItem, toggleFavourite, renameItem, downloadItem, importFile, importText,
  shareCode, fromShareCode, storageKind,
} from '../map/library.js';
import { mapStats } from '../map/format.js';
import { OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL } from '../map/osm.js';
import { h, clear, sfx, fmtDate, fmtInt, toast, confirmModal, openModal, debounce, isTyping, keycap } from './dom.js';
import { screenFrame, segControl, DIFF_LABEL } from './screen.js';
import { mapPreview, mapFacts } from './mapinfo.js';
import { openMutatorEditor } from './mutators.js';

const TYPE_LABEL = { map: 'Map', mutator: 'Mutator', scenario: 'Scenario' };
const SORT_LABEL = { newest: 'Newest', name: 'Name', size: 'Size', favourite: 'Starred' };
const fmtSize = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : n + ' B');

let memo = { sort: 'newest', type: '', search: '', favs: false };

// ------------------------------------------------------------ share / import dialogs (shared)

export function openPasteCode(onImported) {
  const ta = h('textarea.input', { rows: 5, spellcheck: 'false', placeholder: 'RC1.H4sIA... or a mutator written as path=value lines' });
  const msg = h('p.small.muted', 'Paste a share code from another player, or the text of an exported file.');
  return openModal({
    title: 'Paste share code', no: 'Form OCP-40', body: h('div.vstack', msg, ta),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Import', kind: 'go', onClick: async () => {
          const text = ta.value.trim();
          if (!text) return false;
          try {
            const item = /^RC\d+\./.test(text) ? await fromShareCode(text) : importText(text);
            const saved = await saveItem(item);
            toast({ kind: 'info', stamp: 'Filed', title: saved.name, body: `${TYPE_LABEL[saved.type]} added to the library.` });
            if (onImported) onImported(saved);
            return true;
          } catch (e) {
            msg.className = 'small err-text';
            msg.textContent = e.message || String(e);
            return false;
          }
        },
      },
    ],
  });
}

export async function copyShareCode(item) {
  const full = item.data ? item : await getItem(item.id);
  const code = await shareCode(full);
  let copied = false;
  try { await navigator.clipboard.writeText(code); copied = true; } catch (e) { copied = false; }
  const ta = h('textarea.input.share-code', { rows: 4, readOnly: true, spellcheck: 'false' });
  ta.value = code;
  openModal({
    title: 'Share code', no: 'Form OCP-41',
    body: h('div.vstack',
      h('p.small', copied ? 'Copied to the clipboard. Anyone can paste it into their library.' : 'Select the code below and copy it.'),
      ta,
      h('p.tiny.faint', `${fmtInt(code.length)} characters`)),
    actions: [{ label: 'Done', kind: 'go' }],
    initialFocus: 'textarea',
  });
  requestAnimationFrame(() => ta.select());
}

export function pickFile(onImported) {
  const input = h('input', { type: 'file', accept: '.json,.rcmap.json,application/json,text/plain', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    try {
      const item = await importFile(f);
      const saved = await saveItem(item);
      toast({ kind: 'info', stamp: 'Filed', title: saved.name, body: `${TYPE_LABEL[saved.type]} imported from ${f.name}.` });
      if (onImported) onImported(saved);
    } catch (e) {
      toast({ kind: 'error', stamp: 'Rejected', title: 'Import failed', body: e.message || String(e) });
    }
  });
  document.body.appendChild(input);
  input.click();
}

// ------------------------------------------------------------ list rendering

function itemRow(m, { selected, onSelect, onStar }) {
  const star = h('button.star' + (m.favourite ? '.is-on' : ''), { type: 'button', title: m.favourite ? 'Unstar' : 'Star', 'aria-pressed': String(!!m.favourite) }, m.favourite ? '★' : '☆');
  star.addEventListener('click', (e) => { e.stopPropagation(); onStar(m); });
  const meta = m.type === 'map' ? `${m.stages || '?'} stages · ${fmtInt(m.buildings || 0)} bldgs` : m.type === 'scenario' ? 'Map + mutators' : 'Overrides';
  const row = h('div.lib-row' + (selected ? '.is-sel' : ''), { role: 'option', tabIndex: 0, 'aria-selected': String(!!selected), dataset: { id: m.id } },
    star,
    h('span.lib-type.type-' + m.type, TYPE_LABEL[m.type]),
    h('span.lib-name', h('b', m.name), h('small', meta)),
    h('span.lib-size', fmtSize(m.size || 0)),
    h('span.lib-date', fmtDate(m.updated)));
  row.addEventListener('click', () => onSelect(m));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(m, e.key === 'Enter'); } });
  return row;
}

// Compact picker of maps / scenarios. onPick(item with data).
export function libraryPicker({ types = ['map', 'scenario'], onPick, selectedId = null } = {}) {
  const search = h('input.input', { type: 'search', placeholder: 'Search the library' });
  const list = h('div.lib-list.compact', { role: 'listbox' });
  const status = h('span.tiny.faint');
  const el = h('div.lib-picker',
    h('div.lib-tools', search,
      h('button.btn.btn-sm', { type: 'button', onclick: () => pickFile(it => { selectedId = it.id; refresh(); pick(it); }) }, 'Import file'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => openPasteCode(it => { selectedId = it.id; refresh(); pick(it); }) }, 'Paste code')),
    list, status);
  let items = [];
  async function refresh() {
    try {
      const all = await listItems({ sort: 'newest', search: search.value });
      items = all.filter(m => types.includes(m.type));
    } catch (e) { items = []; }
    clear(list);
    if (!items.length) list.appendChild(h('div.empty-note', search.value ? 'Nothing matches that search.' : 'No maps filed yet. Generate or import one, then save it to the library.'));
    for (const m of items) list.appendChild(itemRow(m, { selected: m.id === selectedId, onSelect: (it) => { selectedId = it.id; refresh(); pick(it); }, onStar: async (it) => { await toggleFavourite(it.id); refresh(); } }));
    status.textContent = `${items.length} item${items.length === 1 ? '' : 's'} · stored in ${storageKind === 'indexeddb' ? 'this browser' : 'memory only'}`;
  }
  async function pick(meta) {
    const item = await getItem(meta.id);
    if (item && onPick) onPick(item);
  }
  search.addEventListener('input', debounce(refresh, 150));
  refresh();
  return { el, refresh };
}

// ------------------------------------------------------------ library screen

export function mount(root, app, params) {
  const frame = screenFrame({ form: 'OCP-40', title: 'Library', sub: 'Maps, mutators and scenarios filed in this browser', onBack: () => app.go('title') });
  root.appendChild(frame.el);

  const search = h('input.input.lib-search', { type: 'search', placeholder: 'Search by name, author or notes' });
  search.value = memo.search;
  const sortSeg = segControl(Object.keys(SORT_LABEL).map(v => ({ value: v, label: SORT_LABEL[v] })), memo.sort, v => { memo.sort = v; refresh(); }, { label: 'Sort' });
  const typeSeg = segControl([{ value: '', label: 'All' }, { value: 'map', label: 'Maps' }, { value: 'mutator', label: 'Mutators' }, { value: 'scenario', label: 'Scenarios' }], memo.type, v => { memo.type = v; refresh(); }, { label: 'Type' });
  const favInput = h('input', { type: 'checkbox', checked: memo.favs });
  favInput.addEventListener('change', () => { memo.favs = favInput.checked; refresh(); });
  const favToggle = h('label.toggle', favInput, h('span.toggle-track'), 'Starred only');

  frame.tools.append(
    h('button.btn.btn-sm', { type: 'button', onclick: () => pickFile(it => { selectedId = it.id; refresh(); }) }, 'Import file'),
    h('button.btn.btn-sm', { type: 'button', onclick: () => openPasteCode(it => { selectedId = it.id; refresh(); }) }, 'Paste share code'),
    h('button.btn.btn-sm', { type: 'button', onclick: () => openMutatorEditor({ onSaved: it => { selectedId = it.id; refresh(); } }) }, 'New mutator'));

  const list = h('div.lib-list', { role: 'listbox', 'aria-label': 'Library items' });
  const head = h('div.lib-row.lib-head', h('span'), h('span', 'Type'), h('span', 'Name'), h('span', 'Size'), h('span', 'Filed'));
  const count = h('span.tiny.faint');
  const detail = h('div.card.raised.lib-detail');
  frame.body.appendChild(h('div.lib-grid',
    h('div.lib-main',
      h('div.lib-toolbar', search, typeSeg.el, sortSeg.el, favToggle),
      h('div.lib-table', head, list),
      count),
    detail));

  let items = [];
  let selectedId = params.id || null;
  let preview = null;
  let detailReq = 0;

  async function refresh() {
    memo.search = search.value;
    try { items = await listItems({ type: memo.type || undefined, sort: memo.sort, search: memo.search, favouritesOnly: memo.favs }); } catch (e) { items = []; }
    clear(list);
    if (!items.length) {
      list.appendChild(h('div.empty-note', memo.search || memo.type || memo.favs ? 'Nothing matches these filters.'
        : 'The library is empty. Save a generated city, a real-place import or a mutator, or import a file someone shared.'));
    }
    for (const m of items) {
      list.appendChild(itemRow(m, {
        selected: m.id === selectedId,
        onSelect: (it, open) => { selectedId = it.id; markSel(); showDetail(it.id); if (open) play(); },
        onStar: async (it) => { await toggleFavourite(it.id); refresh(); },
      }));
    }
    count.textContent = `${items.length} item${items.length === 1 ? '' : 's'} · ${storageKind === 'indexeddb' ? 'kept in this browser' : 'browser storage unavailable: items last until you close this tab'}`;
    if (!items.find(m => m.id === selectedId)) selectedId = items.length ? items[0].id : null;
    markSel();
    showDetail(selectedId);
  }
  function markSel() {
    for (const r of list.querySelectorAll('.lib-row')) { const on = r.dataset.id === selectedId; r.classList.toggle('is-sel', on); r.setAttribute('aria-selected', String(on)); }
  }

  let current = null;
  async function showDetail(id) {
    const req = ++detailReq;
    if (preview) { preview.destroy(); preview = null; }
    clear(detail);
    current = null;
    if (!id) { detail.appendChild(h('div.empty-note', 'Select an item to see its file.')); return; }
    const item = await getItem(id);
    if (req !== detailReq) return;
    if (!item) { detail.appendChild(h('div.empty-note', 'This item is gone.')); return; }
    current = item;
    const nameInput = h('input.input.line.lib-title', { type: 'text', value: item.name, maxLength: 80, 'aria-label': 'Name' });
    nameInput.value = item.name;
    nameInput.addEventListener('change', async () => { await renameItem(item.id, nameInput.value); refresh(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); e.stopPropagation(); });
    detail.append(h('div.card-head', h('span.card-title', TYPE_LABEL[item.type] + ' file'), h('span.card-no', item.id.slice(-8).toUpperCase())), nameInput);
    const metaBits = [`Filed ${fmtDate(item.created)}`, `Updated ${fmtDate(item.updated, true)}`, fmtSize(item.size || 0)];
    if (item.author) metaBits.unshift('By ' + item.author);
    detail.appendChild(h('p.tiny.muted.lib-meta', metaBits.join(' · ')));

    const map = item.type === 'map' ? item.data : item.type === 'scenario' ? item.data.map : null;
    if (map) {
      preview = mapPreview({ cls: 'lib-preview' });
      detail.appendChild(preview.el);
      preview.set(map, null);
      detail.appendChild(mapFacts(map, mapStats(map)));
      if (map.geo) detail.appendChild(h('p.tiny.attribution', 'Map data ', h('a', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener' }, OSM_ATTRIBUTION)));
    }
    if (item.desc) detail.appendChild(h('p.small.lib-desc', item.desc));
    if (item.type === 'scenario') {
      detail.appendChild(h('div.kv', h('span', 'Difficulty'), h('i'), h('b', DIFF_LABEL[item.data.difficulty] || 'Normal')));
      detail.appendChild(h('div.kv', h('span', 'Mutator lines'), h('i'), h('b', String(item.data.mutators.length))));
    }
    if (item.type === 'mutator' || item.type === 'scenario') {
      const lines = item.type === 'mutator' ? item.data.lines : item.data.mutators;
      if (lines.length) detail.appendChild(h('pre.lib-lines', lines.join('\n')));
    }
    const isPlayable = !!map;
    detail.appendChild(h('div.btn-row.lib-actions',
      isPlayable ? h('button.btn.btn-primary', { type: 'button', onclick: () => play() }, 'Play', keycap('Enter')) : null,
      item.type === 'map' ? h('button.btn', { type: 'button', onclick: () => app.go('editor', { map: item.data }) }, 'Open in editor') : null,
      item.type === 'mutator' ? h('button.btn', { type: 'button', onclick: () => openMutatorEditor({ initial: { id: item.id, name: item.name, text: item.data.lines.join('\n') }, onSaved: () => refresh() }) }, 'Edit') : null,
      h('button.btn', { type: 'button', onclick: () => { try { downloadItem(item); } catch (e) { toast({ kind: 'error', title: 'Export failed', body: e.message }); } } }, 'Export file'),
      h('button.btn', { type: 'button', onclick: () => copyShareCode(item).catch(e => toast({ kind: 'error', stamp: 'Error', title: 'Share code failed', body: e.message })) }, 'Share code'),
      h('span.grow'),
      h('button.btn.btn-ghost.danger', { type: 'button', onclick: () => remove() }, 'Delete')));
  }

  function play() {
    if (!current) return;
    if (current.type === 'map') app.go('freeplay', { lib: current.id });
    else if (current.type === 'scenario') app.go('freeplay', { lib: current.id });
  }

  async function remove() {
    if (!current) return;
    const ok = await confirmModal({
      title: 'Delete from library', no: 'Form OCP-42', danger: true, confirmLabel: 'Delete',
      message: h('div', h('p', `"${current.name}" will be removed from this browser's library.`), h('p.small.muted', 'This cannot be undone. Export it first if you may want it back.')),
    });
    if (!ok) return;
    await deleteItem(current.id);
    sfx.thump();
    toast({ kind: 'info', stamp: 'Shredded', title: current.name, body: 'Removed from the library.' });
    selectedId = null;
    refresh();
  }

  search.addEventListener('input', debounce(refresh, 150));
  refresh();
  requestAnimationFrame(() => search.focus({ preventScroll: true }));

  return {
    onKey(e) {
      if (e.key === 'Escape' && isTyping(e) && search.value) { search.value = ''; refresh(); return true; }
      if (isTyping(e)) {
        if (e.key === 'ArrowDown' && e.target === search) { const r = list.querySelector('.lib-row'); if (r) r.focus(); return true; }
        return false;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const k = items.findIndex(m => m.id === selectedId);
        const n = items.length;
        if (!n) return true;
        const next = items[(k + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n];
        selectedId = next.id; markSel(); showDetail(next.id);
        const row = list.querySelector(`[data-id="${next.id}"]`);
        if (row) row.focus();
        return true;
      }
      if (e.key === 'Delete' && current) { remove(); return true; }
      if (e.key === '/') { search.focus(); return true; }
      return false;
    },
    destroy() { detailReq++; if (preview) preview.destroy(); },
  };
}

