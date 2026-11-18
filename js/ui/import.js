// Real-place import: search a place, choose a square, fetch OpenStreetMap data, convert, preview, file it.
import { searchPlaces, IMPORT_SIZES, OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL, isHugeMap } from '../map/osm.js';
import { mapStats } from '../map/format.js';
import { saveItem } from '../map/library.js';
import { h, clear, sfx, fmtInt, toast } from './dom.js';
import { segControl, field } from './screen.js';
import { importArea } from './gen.js';
import { mapPreview, mapFacts } from './mapinfo.js';

const fmtBytes = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : n + ' B');
const host = url => { try { return new URL(url).host; } catch (e) { return 'the map server'; } };

let memo = { query: '', results: [], pick: -1, size: 2, stages: 5, map: null, warnings: [], name: '' };

// mountImport(container, { onMap(map | null) }) -> { destroy }
export function mountImport(container, { onMap }) {
  const q = h('input.input', { type: 'search', placeholder: 'Town, address, postcode or "Street & Street, City"', maxLength: 200, 'aria-label': 'Place to search' });
  q.value = memo.query;
  const searchBtn = h('button.btn', { type: 'button' }, 'Search');
  const searchMsg = h('p.tiny.faint.imp-msg', 'Searches OpenStreetMap’s place index. Nothing is sent until you press Search.');
  const results = h('div.imp-results', { role: 'listbox', 'aria-label': 'Search results' });

  const sizeSeg = segControl(IMPORT_SIZES.map(s => ({ value: s, label: s + ' km' })), memo.size, v => { memo.size = v; updateHint(); }, { label: 'Square size' });
  const stageSeg = segControl([3, 4, 5, 6, 7].map(s => ({ value: s, label: String(s) })), memo.stages, v => { memo.stages = v; }, { label: 'Stages' });
  const name = h('input.input', { type: 'text', maxLength: 80, placeholder: 'Map name' });
  name.value = memo.name;
  name.addEventListener('input', () => { memo.name = name.value; name.dataset.auto = '0'; });
  const hint = h('span.hint');
  const importBtn = h('button.btn.btn-go', { type: 'button', disabled: true }, 'Fetch map data');
  const cancelBtn = h('button.btn.btn-ghost', { type: 'button', hidden: true }, 'Cancel');
  const progress = h('div.imp-progress', { hidden: true }, h('div.meter.thin', h('i.meter-fill')), h('span.imp-phase.small'));
  const errBox = h('p.err-text.imp-err', { hidden: true });

  const preview = mapPreview({ cls: 'imp-preview', label: 'No area fetched yet' });
  const factsBox = h('div.imp-facts');
  const warnBox = h('div.imp-warn');
  const saveBtn = h('button.btn', { type: 'button', disabled: true }, 'Save to library');
  const attribution = h('p.tiny.attribution', 'Map data ', h('a', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener' }, OSM_ATTRIBUTION), ', fetched through Nominatim and the Overpass API.');

  container.append(h('div.imp-grid',
    h('div.imp-left',
      h('div.field', h('label', 'Find a place'), h('div.imp-search', q, searchBtn), searchMsg),
      results,
      h('div.imp-opts',
        field('Square size', sizeSeg.el, hint),
        field('Stages', stageSeg.el),
        field('Name', name)),
      h('div.btn-row', importBtn, cancelBtn),
      progress, errBox),
    h('div.imp-right', preview.el, factsBox, warnBox, h('div.btn-row', saveBtn), attribution)));

  let busy = false, ctl = null, searching = false;

  function updateHint() {
    const s = memo.size;
    hint.textContent = s >= 4 ? 'Large squares in dense cities can take a minute and run slowly.' : s >= 3 ? 'A city centre this size is a big map.' : 'Good for a first try.';
  }
  updateHint();

  function renderResults() {
    clear(results);
    if (!memo.results.length) return;
    memo.results.forEach((r, i) => {
      const row = h('button.imp-row' + (i === memo.pick ? '.is-sel' : ''), { type: 'button', role: 'option', 'aria-selected': String(i === memo.pick) },
        h('span.check', h('input', { type: 'radio', name: 'imp-pick', checked: i === memo.pick, tabIndex: -1 })),
        h('span.imp-row-text', h('b', r.name), h('small', r.label)),
        h('span.imp-type', r.type || r.category || ''));
      row.addEventListener('click', () => { sfx.key(); memo.pick = i; if (!name.value.trim() || name.dataset.auto === '1') { name.value = r.name; name.dataset.auto = '1'; memo.name = r.name; } renderResults(); importBtn.disabled = busy; });
      results.appendChild(row);
    });
  }

  async function doSearch() {
    const text = q.value.trim();
    if (!text || searching || busy) return;
    memo.query = text;
    searching = true;
    searchBtn.disabled = true;
    searchMsg.className = 'tiny faint imp-msg';
    searchMsg.textContent = 'Searching…';
    try {
      memo.results = await searchPlaces(text);
      memo.pick = memo.results.length ? 0 : -1;
      searchMsg.textContent = memo.results.length ? `${memo.results.length} match${memo.results.length > 1 ? 'es' : ''}. Pick one, choose a size, then fetch.` : 'No place found. Try adding the city or country.';
      if (memo.results.length) { name.value = memo.results[0].name; name.dataset.auto = '1'; memo.name = name.value; }
    } catch (e) {
      memo.results = []; memo.pick = -1;
      searchMsg.className = 'tiny err-text imp-msg';
      searchMsg.textContent = e.message || 'Search failed';
    }
    searching = false;
    searchBtn.disabled = false;
    importBtn.disabled = memo.pick < 0;
    renderResults();
  }

  function setBusy(on) {
    busy = on;
    importBtn.disabled = on || memo.pick < 0;
    searchBtn.disabled = on;
    cancelBtn.hidden = !on;
    progress.hidden = !on;
    sizeSeg.el.classList.toggle('is-disabled', on);
  }

  function phaseText(p) {
    if (p.phase === 'request') return `Requesting data from ${host(p.endpoint)}…`;
    if (p.phase === 'download') return `Downloading · ${fmtBytes(p.bytes)}`;
    if (p.phase === 'parse') return `Reading ${fmtBytes(p.bytes)} of map data…`;
    if (p.phase === 'retry') return `${host(p.endpoint)} did not answer (${p.error}). Trying another server…`;
    if (p.phase === 'convert') return 'Drawing streets and buildings…';
    if (p.phase === 'done') return 'Done.';
    return '';
  }

  async function doImport() {
    const r = memo.results[memo.pick];
    if (!r || busy) return;
    errBox.hidden = true;
    setBusy(true);
    sfx.clack();
    ctl = new AbortController();
    const fill = progress.querySelector('.meter');
    const phase = progress.querySelector('.imp-phase');
    let pv = 0.05;
    fill.style.setProperty('--v', pv);
    phase.textContent = 'Starting…';
    try {
      const res = await importArea({ lat: r.lat, lon: r.lon, sizeKm: memo.size, name: name.value.trim() || r.name, stages: memo.stages }, {
        signal: ctl.signal,
        onProgress: (p) => {
          phase.textContent = phaseText(p);
          pv = p.phase === 'request' ? 0.1 : p.phase === 'download' ? Math.min(0.75, 0.15 + p.bytes / 4e7) : p.phase === 'parse' ? 0.8 : p.phase === 'convert' ? 0.9 : p.phase === 'done' ? 1 : pv;
          fill.style.setProperty('--v', pv);
        },
      });
      memo.map = res.map;
      memo.warnings = res.warnings || [];
      if (res.huge || isHugeMap(res.map)) { if (!memo.warnings.some(w => /large/i.test(w))) memo.warnings.unshift('Large map: expect slower simulation on modest computers.'); }
      showMap();
      sfx.thump();
      onMap(memo.map);
    } catch (e) {
      errBox.hidden = false;
      errBox.textContent = (e && e.message) || 'Import failed';
    }
    setBusy(false);
    ctl = null;
  }

  function showMap() {
    const m = memo.map;
    clear(factsBox); clear(warnBox);
    if (!m) { preview.setEmpty('No area fetched yet'); saveBtn.disabled = true; return; }
    preview.set(m, null);
    factsBox.appendChild(mapFacts(m, mapStats(m)));
    for (const w of memo.warnings) warnBox.appendChild(h('p.imp-warning', h('span.stamp.stamp-sm.stamp-orange', 'Note'), w));
    saveBtn.disabled = false;
  }

  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  searchBtn.addEventListener('click', doSearch);
  importBtn.addEventListener('click', doImport);
  cancelBtn.addEventListener('click', () => { if (ctl) ctl.abort(); });
  saveBtn.addEventListener('click', async () => {
    if (!memo.map) return;
    saveBtn.disabled = true;
    try {
      const it = await saveItem({ type: 'map', name: memo.map.name, data: memo.map });
      toast({ kind: 'info', stamp: 'Filed', title: it.name, body: `Saved to your library · ${fmtInt(it.buildings || 0)} buildings.` });
    } catch (e) {
      toast({ kind: 'error', stamp: 'Error', title: 'Could not save', body: e.message });
    }
    saveBtn.disabled = false;
  });

  renderResults();
  importBtn.disabled = memo.pick < 0;
  showMap();
  if (memo.map) onMap(memo.map);

  return {
    focus() { q.focus(); },
    destroy() { if (ctl) ctl.abort(); preview.destroy(); },
  };
}
