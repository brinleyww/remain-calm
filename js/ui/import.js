// Real-place import: search a place (or load a saved export), set the square on a map, fetch, convert, file it.
import { searchPlaces, IMPORT_RANGE, OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL, isHugeMap, snapSize, roundCoord, tileCount } from '../map/osm.js';
import { cacheList, cacheKey } from '../map/osmcache.js';
import { mapStats, popLimit } from '../map/format.js';
import { saveItem } from '../map/library.js';
import { getSettings, crowdMutators } from '../meta/settings.js';
import { makeConfig } from '../data/config.js';
import { h, clear, sfx, fmtInt, toast } from './dom.js';
import { segControl, field, slider } from './screen.js';
import { importArea } from './gen.js';
import { mapPreview, mapFacts, civEstimate, crowdLine, stagePopulations } from './mapinfo.js';
import { tileMap } from './tilemap.js';

const fmtBytes = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : (n | 0) + ' B');
const fmtSec = ms => (ms < 950 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + ' s';
const host = url => { try { return new URL(url).host; } catch (e) { return 'the map server'; } };
const sizeHint = s => {
  const n = tileCount(s);
  if (s > 5) return `A whole city, fetched in ${n} parts: about ${s >= 8 ? '1–3 minutes' : 'a minute or two'} to fetch and draw, longer when the servers are busy. The crowd is thinned so it runs smoothly.`;
  if (s >= 4.5) return `A big sheet in ${n} parts: dense city centres take a minute or so to fetch.`;
  return s >= 3.5 ? 'A big sheet: dense city centres take a while to fetch and can run slowly.' : s >= 2.5 ? 'A large district. Fetched in four parts.' : s >= 1.5 ? 'A town centre or a few neighbourhoods.' : 'A few blocks. Quick to fetch and to play.';
};

let memo = { query: '', results: [], pick: -1, size: 2, stages: 5, name: '', centre: null, map: null, res: null, saved: false, view: 'area', file: null };

// mountImport(container, { onMap(map | null) }) -> { focus, destroy }
export function mountImport(container, { onMap }) {
  // ---------------- search
  const q = h('input.input', { type: 'search', placeholder: 'Town, address or postcode', maxLength: 200, 'aria-label': 'Place to search', autocomplete: 'off' });
  q.value = memo.query;
  const searchBtn = h('button.btn', { type: 'submit' }, 'Search');
  const searchForm = h('form.imp-search', { role: 'search' }, q, searchBtn);
  const searchMsg = h('p.tiny.faint.imp-msg', 'Searches the OpenStreetMap place index when you press Search.');
  const results = h('div.imp-results', { role: 'listbox', 'aria-label': 'Search results' });

  // ---------------- file
  const fileIn = h('input', { type: 'file', accept: '.osm,.xml,.json,application/json,application/xml,text/xml', hidden: true });
  const fileBtn = h('button.btn.btn-sm', { type: 'button' }, 'Choose file…');
  const drop = h('div.imp-drop', { tabIndex: -1 },
    h('div.imp-drop-row', h('span.imp-drop-text', h('b', 'Offline?'), ' Drop an .osm or Overpass JSON file here'), fileBtn),
    h('details.imp-howto',
      h('summary', 'How to export one'),
      h('ol',
        h('li', 'On openstreetmap.org, move to the place and press ', h('b', 'Export'), '.'),
        h('li', 'Press ', h('b', 'Manually select a different area'), ', draw a square up to about 1.5 km, then ', h('b', 'Export'), ' to save map.osm.'),
        h('li', 'Bigger areas: use the ', h('b', 'Overpass API'), ' link on the same panel and save the file it returns.'),
        h('li', 'Drop the file here. The square is taken from the middle of the file.'))),
    fileIn);

  // ---------------- recent
  const recentBox = h('div.imp-recent');

  // ---------------- square options
  const sizeS = slider({ min: IMPORT_RANGE.min, max: IMPORT_RANGE.max, step: IMPORT_RANGE.step, value: memo.size, format: v => v.toFixed(1) + ' km', oninput: v => { memo.size = v; area.set({ sizeKm: v }); sizeHintEl.textContent = sizeHint(v); updateWhere(); markStale(); } });
  const sizeHintEl = h('span.hint', sizeHint(memo.size));
  const stageSeg = segControl([3, 4, 5, 6, 7].map(s => ({ value: s, label: String(s) })), memo.stages, v => { memo.stages = v; markStale(); }, { label: 'Stages' });
  const name = h('input.input', { type: 'text', maxLength: 80, placeholder: 'Map name' });
  name.value = memo.name;
  name.addEventListener('input', () => { memo.name = name.value; name.dataset.auto = '0'; });
  const importBtn = h('button.btn.btn-go', { type: 'button', disabled: true }, 'Fetch map data');
  const refreshBtn = h('button.btn.btn-ghost', { type: 'button', hidden: true, title: 'Ignore the copy kept in this browser and download the square again' }, 'Download again');
  const cancelBtn = h('button.btn.btn-ghost', { type: 'button', hidden: true }, 'Cancel');
  const where = h('p.tiny.faint.imp-where');

  // ---------------- progress / errors
  const meter = h('div.meter.thin', h('i.meter-fill'));
  const phase = h('span.imp-phase.small');
  const detail = h('span.imp-detail.tiny.faint');
  const progress = h('div.imp-progress', { hidden: true, role: 'status', 'aria-live': 'polite' }, meter, h('div.spread', phase, h('span.imp-clock.tiny.faint')), detail);
  const clock = progress.querySelector('.imp-clock');
  const errTitle = h('b.imp-err-title');
  const errList = h('ul.imp-err-list');
  const retryBtn = h('button.btn.btn-sm', { type: 'button' }, 'Retry');
  const useFileBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Use a file instead');
  const errBox = h('div.imp-err', { hidden: true, role: 'alert' }, h('span.stamp.stamp-sm', 'Failed'), h('div.imp-err-body', errTitle, errList, h('div.btn-row', retryBtn, useFileBtn)));

  // ---------------- right side
  const area = tileMap({ sizeKm: memo.size, onChange: (lat, lon) => { memo.centre = { lat, lon }; markStale(); updateWhere(); } });
  const preview = mapPreview({ cls: 'imp-preview', label: 'No sheet drawn yet' });
  const viewSeg = segControl([{ value: 'area', label: 'Area map' }, { value: 'sheet', label: 'Converted sheet' }], memo.view, v => setView(v), { label: 'View' });
  const viewBox = h('div.imp-view', area.el, preview.el);
  const factsBox = h('div.imp-facts');
  const sourceLine = h('p.tiny.faint.imp-source');
  const warnBox = h('div.imp-warn');
  const saveBtn = h('button.btn', { type: 'button', disabled: true }, 'Save to library');
  const saveNote = h('span.tiny.faint.imp-save-note');
  const attribution = h('p.tiny.attribution', 'Map data ', h('a', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener' }, OSM_ATTRIBUTION), '. Search by Nominatim, data by the Overpass API.');

  container.append(h('div.imp-grid',
    h('div.imp-left',
      h('div.imp-step', h('span.imp-step-no', '1'), h('span.label', 'Find a place')),
      searchForm, searchMsg, results, drop, recentBox,
      h('div.imp-step', h('span.imp-step-no', '2'), h('span.label', 'Set the square')),
      h('div.imp-opts',
        field('Size', sizeS.el, sizeHintEl),
        field('Stages', stageSeg.el),
        field('Name', name)),
      where,
      h('div.btn-row', importBtn, refreshBtn, cancelBtn),
      progress, errBox),
    h('div.imp-right',
      h('div.spread.imp-view-head', viewSeg.el, h('span.tiny.faint.imp-view-hint', 'Drag the square · wheel to zoom')),
      viewBox, factsBox, sourceLine, warnBox, h('div.btn-row.imp-save', saveBtn, saveNote), attribution)));
  const saveRow = container.querySelector('.imp-save');

  let busy = false, ctl = null, searching = false, tick = 0, t0 = 0, lastArgs = null, cachedKeys = new Set();

  // A copy of the current square is kept in this browser's cache (Fetch then loads it without downloading).
  function isCached() {
    const c = memo.centre;
    return !!c && !memo.file && cachedKeys.has(cacheKey(roundCoord(c.lat), roundCoord(c.lon), snapSize(memo.size)));
  }

  function setView(v) {
    memo.view = v;
    viewSeg.set(v);
    area.el.hidden = v !== 'area';
    preview.el.hidden = v !== 'sheet';
    container.querySelector('.imp-view-hint').textContent = v === 'area' ? (memo.file ? 'Square taken from the file' : 'Drag the square · wheel to zoom') : 'Stages outlined in red';
    if (v === 'area') area.redraw(); else preview.redraw();
  }

  function updateWhere() {
    const c = memo.centre;
    where.textContent = c ? `Square ${memo.size} km around ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}` : '';
    importBtn.disabled = busy || !c;
    refreshBtn.hidden = busy || !isCached();
  }

  function markStale() {
    const cached = isCached();
    refreshBtn.hidden = busy || !cached;
    if (!memo.map || !memo.res || memo.file) { importBtn.textContent = cached ? 'Load saved copy' : 'Fetch map data'; return; }
    const c = memo.centre;
    const same = c && Math.abs(roundCoord(c.lat) - memo.res.lat) < 1e-9 && Math.abs(roundCoord(c.lon) - memo.res.lon) < 1e-9 && snapSize(memo.size) === memo.res.sizeKm && memo.stages === memo.res.map.levels.length;
    importBtn.textContent = same ? (cached ? 'Draw again' : 'Fetch again') : cached ? 'Load saved copy' : 'Fetch map data';
  }

  // ---------------- search
  function renderResults() {
    clear(results);
    memo.results.forEach((r, i) => {
      const row = h('button.imp-row' + (i === memo.pick ? '.is-sel' : ''), { type: 'button', role: 'option', 'aria-selected': String(i === memo.pick) },
        h('span.check', h('input', { type: 'radio', name: 'imp-pick', checked: i === memo.pick, tabIndex: -1 })),
        h('span.imp-row-text', h('b', r.name), h('small', r.label)),
        h('span.imp-type', (r.type || r.category || '').replace(/_/g, ' ')));
      row.addEventListener('click', () => { sfx.key(); pick(i); });
      results.appendChild(row);
    });
  }
  function pick(i) {
    const r = memo.results[i];
    if (!r) return;
    memo.pick = i;
    memo.file = null;
    memo.centre = { lat: r.lat, lon: r.lon };
    area.lock(false);
    area.set({ lat: r.lat, lon: r.lon, sizeKm: memo.size, fit: true });
    if (!name.value.trim() || name.dataset.auto !== '0') { name.value = r.name; name.dataset.auto = '1'; memo.name = r.name; }
    setView('area');
    renderResults();
    updateWhere();
    markStale();
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
      searchMsg.textContent = memo.results.length ? `${memo.results.length} match${memo.results.length > 1 ? 'es' : ''}. Pick one, then move the square if you like.` : 'No place found. Try adding the city or country.';
      memo.pick = -1;
      renderResults();
      if (memo.results.length) pick(0);
    } catch (e) {
      memo.results = []; memo.pick = -1;
      renderResults();
      searchMsg.className = 'tiny err-text imp-msg';
      searchMsg.textContent = e.message || 'Search failed';
    }
    searching = false;
    searchBtn.disabled = busy;
  }

  // ---------------- recent imports (raw data cached in this browser)
  async function renderRecent() {
    let list = [];
    try { list = await cacheList(); } catch (e) { list = []; }
    cachedKeys = new Set(list.map(it => it.key));
    markStale();
    clear(recentBox);
    if (!list.length) return;
    recentBox.append(h('span.label', 'Fetched before · instant'));
    const row = h('div.imp-recent-list');
    const seen = new Set();
    for (const it of list) {
      const k = (it.name || '') + '|' + it.sizeKm;
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > 6) break;
      const b = h('button.chip.imp-recent-chip', { type: 'button', title: `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)} · ${fmtBytes(it.rawBytes || it.bytes)} · ${new Date(it.t).toLocaleDateString('en-GB')}` },
        h('b', it.name || 'Unnamed'), ` ${it.sizeKm} km`);
      b.addEventListener('click', () => {
        if (busy) return;
        sfx.key();
        memo.file = null;
        memo.size = it.sizeKm; sizeS.set(it.sizeKm); sizeHintEl.textContent = sizeHint(it.sizeKm);
        memo.centre = { lat: it.lat, lon: it.lon };
        if (it.name) { name.value = it.name; name.dataset.auto = '1'; memo.name = it.name; }
        area.lock(false);
        area.set({ lat: it.lat, lon: it.lon, sizeKm: it.sizeKm, fit: true });
        updateWhere();
        doImport();
      });
      row.appendChild(b);
    }
    recentBox.appendChild(row);
  }

  // ---------------- import
  function setBusy(on) {
    busy = on;
    importBtn.disabled = on || !memo.centre;
    refreshBtn.hidden = on || !isCached();
    searchBtn.disabled = on;
    fileBtn.disabled = on;
    cancelBtn.hidden = !on;
    progress.hidden = !on;
    container.querySelector('.imp-left').classList.toggle('is-busy', on);
    clearInterval(tick);
    if (on) { t0 = Date.now(); clock.textContent = '0 s'; tick = setInterval(() => { clock.textContent = fmtSec(Date.now() - t0); }, 500); }
  }

  function phaseText(p) {
    const part = p.tiles > 1 ? ` (part ${Math.min(p.tiles, (p.tile ?? 0) + 1)} of ${p.tiles})` : '';
    switch (p.phase) {
      case 'request': return `Asking ${host(p.endpoint)} for the map data${part}…`;
      case 'slow': return `${host(p.endpoint)} is slow to answer. Asking another server as well…`;
      case 'wait': return `Waiting for ${host(p.endpoint)}. Busy servers queue requests; this can take a minute…`;
      case 'download': return `Downloading${part} from ${host(p.endpoint)}`;
      case 'parse': return `Reading the data${part}…`;
      case 'retry': return `${host(p.endpoint)}: ${p.error}. Trying another server…`;
      case 'backoff': return `Every server is busy. Trying again in ${Math.round(p.wait / 1000)} s…`;
      case 'partwait': return `Every server is busy${part}. That part waits ${Math.round(p.wait / 1000)} s and asks again; the rest carry on…`;
      case 'tile': return p.tilesDone < p.tiles ? `Part ${p.tilesDone} of ${p.tiles} received.` : 'All parts received.';
      case 'cache': return 'Found in this browser’s cache. No download needed.';
      case 'read': return 'Reading the file…';
      case 'convert': return 'Drawing streets, water and buildings…';
      case 'done': return 'Done.';
      default: return '';
    }
  }

  function showError(e) {
    const msg = String((e && e.message) || e || 'Import failed');
    clear(errList);
    if (/cancelled/i.test(msg)) { errBox.hidden = true; toast({ kind: 'info', stamp: 'Void', title: 'Import cancelled', body: 'Nothing was changed.' }); return; }
    const m = /^No map server could deliver the data\.\s*(.*)$/.exec(msg);
    if (m) {
      errTitle.textContent = 'No map server could deliver the data right now. The public servers are run by volunteers and are sometimes full.';
      for (const part of m[1].split('; ').filter(Boolean)) errList.appendChild(h('li', part));
      errList.appendChild(h('li.imp-err-tip', 'Retry in a minute, try a smaller square, or load a file you exported yourself.'));
    } else errTitle.textContent = msg;
    useFileBtn.hidden = !!memo.file;
    retryBtn.hidden = !lastArgs;
    errBox.hidden = false;
    errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function run(args) {
    if (busy) return;
    lastArgs = args;
    errBox.hidden = true;
    setBusy(true);
    sfx.clack();
    ctl = new AbortController();
    meter.style.setProperty('--v', 0.03);
    phase.textContent = args.file ? 'Reading the file…' : 'Starting…';
    detail.textContent = '';
    const partsDone = new Set();
    area.parts(null);
    try {
      const res = await importArea(args, {
        signal: ctl.signal,
        onProgress: (p) => {
          if (p.phase === 'tile' && p.tiles > 1) { partsDone.add(p.tile); area.parts(partsDone); }
          const t = phaseText(p);
          if (t) phase.textContent = t;
          if (p.totalBytes !== undefined) detail.textContent = `${fmtBytes(p.totalBytes)} received${p.tiles > 1 ? ` · ${p.tilesDone} of ${p.tiles} parts done` : ''}`;
          let v = null;
          if (p.phase === 'cache' || p.phase === 'read') v = 0.6;
          else if (p.tiles) v = 0.05 + 0.75 * Math.min(1, (p.tilesDone + (p.phase === 'download' ? 1 - Math.exp(-(p.bytes || 0) / 2.5e6) : 0)) / p.tiles);
          if (p.phase === 'convert') v = 0.88;
          if (p.phase === 'done') v = 1;
          if (v !== null) meter.style.setProperty('--v', v);
        },
      });
      memo.res = res;
      memo.map = res.map;
      memo.saved = false;
      area.parts(null);
      if (res.lat !== undefined) memo.centre = { lat: res.lat, lon: res.lon };
      if (args.file) { area.set({ lat: res.lat, lon: res.lon, sizeKm: res.sizeKm, fit: true }); area.lock(true); memo.size = res.sizeKm; sizeS.set(res.sizeKm); }
      if (args.file && name.dataset.auto !== '0') { name.value = memo.name = res.map.name; name.dataset.auto = '1'; }
      showMap();
      setView('sheet');
      sfx.thump();
      onMap(memo.map);
      renderRecent();
    } catch (e) {
      showError(e);
    }
    setBusy(false);
    updateWhere();
    markStale();
    ctl = null;
  }

  function doImport(refresh = false) {
    const c = memo.centre;
    if (!c) return;
    const r = memo.results[memo.pick];
    run({ lat: c.lat, lon: c.lon, sizeKm: snapSize(memo.size), name: name.value.trim() || (r && r.name) || 'Imported place', stages: memo.stages, refresh });
  }

  function importFile(file) {
    if (!file || busy) return;
    memo.file = { name: file.name, size: file.size };
    if (name.dataset.auto !== '0') { name.value = ''; name.dataset.auto = '1'; }
    run({ file, stages: memo.stages, name: name.dataset.auto === '0' ? name.value.trim() : '', sizeKm: 0 });
  }

  function showMap() {
    const m = memo.map, res = memo.res;
    clear(factsBox); clear(warnBox);
    sourceLine.textContent = '';
    saveRow.hidden = !m;
    if (!m) { preview.setEmpty('No sheet drawn yet'); saveBtn.disabled = true; saveNote.textContent = ''; return; }
    preview.set(m, 0);
    const stats = mapStats(m);
    const facts = mapFacts(m, stats);
    const popScale = getSettings().popScale;
    const ccfg = makeConfig(crowdMutators());
    const lim = popLimit(m, ccfg);
    const stage1 = civEstimate(stagePopulations(m)[0] || 0, popScale, ccfg, lim.factor).n;
    const civ = civEstimate(stats.nominalPop, popScale, ccfg, lim.factor);
    facts.append(
      h('div.kv', h('span', 'Stage 1 residents'), h('i'), h('b', fmtInt(stage1))),
      h('div.kv', h('span', 'People simulated, final stage'), h('i'), h('b', fmtInt(civ.n) + (civ.capped ? ' (capped)' : ''))));
    factsBox.appendChild(facts);
    if (lim.limited) factsBox.appendChild(h('p.tiny.muted', crowdLine(m, popScale, ccfg) + '.'));
    if (res && res.info) {
      const i = res.info;
      sourceLine.textContent = res.source === 'cache' ? 'From this browser’s cache, fetched earlier. Download again for fresh data.'
        : res.source === 'file' ? `From ${memo.file ? memo.file.name : 'your file'} (${i.format === 'osm-xml' ? 'OSM XML' : 'Overpass JSON'}).`
          : `Downloaded ${fmtBytes(i.bytes || 0)} from ${(i.mirrors || []).join(', ') || 'the map server'} in ${fmtSec(i.ms || 0)}${i.tiles > 1 ? ` (${i.tiles} parts)` : ''}.`;
      if (i.convertMs !== undefined) sourceLine.textContent += ` Drawn in ${fmtSec(i.convertMs)}.`;
      if (i.stamp) sourceLine.textContent += ` Data as of ${i.stamp.slice(0, 10)}.`;
    }
    const warnings = (res && res.warnings ? res.warnings.slice() : []);
    if (isHugeMap(m) && !warnings.some(w => /large/i.test(w))) warnings.unshift('Large map: expect slower simulation on modest computers.');
    if (civ.capped) warnings.push('More residents than the simulation holds: the population is capped. Lower the population size in Settings if it stutters.');
    for (const w of warnings) warnBox.appendChild(h('p.imp-warning', h('span.stamp.stamp-sm.stamp-orange', /large|capped/i.test(w) ? 'Heavy' : 'Note'), w));
    saveBtn.disabled = memo.saved;
    saveBtn.textContent = memo.saved ? 'Saved to library' : 'Save to library';
    saveNote.textContent = memo.saved ? '' : 'Keep it to play again later or share it.';
  }

  // ---------------- events
  searchForm.addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
  importBtn.addEventListener('click', () => doImport(false));
  refreshBtn.addEventListener('click', () => doImport(true));
  cancelBtn.addEventListener('click', () => { if (ctl) ctl.abort(); });
  retryBtn.addEventListener('click', () => { if (lastArgs) run(lastArgs); });
  useFileBtn.addEventListener('click', () => { drop.querySelector('details').open = true; drop.focus(); drop.classList.add('is-flash'); setTimeout(() => drop.classList.remove('is-flash'), 900); });
  fileBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; importFile(f); });
  const pane = container;
  const isFileDrag = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const onOver = (e) => { if (!isFileDrag(e)) return; e.preventDefault(); drop.classList.add('is-over'); };
  const onLeave = (e) => { if (e.target === pane || !pane.contains(e.relatedTarget)) drop.classList.remove('is-over'); };
  const onDrop = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importFile(f);
  };
  pane.addEventListener('dragover', onOver);
  pane.addEventListener('dragleave', onLeave);
  pane.addEventListener('drop', onDrop);
  saveBtn.addEventListener('click', async () => {
    if (!memo.map) return;
    saveBtn.disabled = true;
    try {
      const it = await saveItem({ type: 'map', name: memo.map.name, data: memo.map });
      memo.saved = true;
      toast({ kind: 'info', stamp: 'Filed', title: it.name, body: `Saved to your library · ${fmtInt(it.buildings || 0)} buildings.` });
    } catch (e) {
      toast({ kind: 'error', stamp: 'Error', title: 'Could not save', body: e.message });
    }
    showMap();
  });

  // ---------------- restore
  renderResults();
  if (memo.centre) { area.set({ lat: memo.centre.lat, lon: memo.centre.lon, sizeKm: memo.size, fit: true }); if (memo.file) area.lock(true); }
  showMap();
  setView(memo.map ? memo.view : 'area');
  updateWhere();
  markStale();
  renderRecent();
  if (memo.map) onMap(memo.map);

  return {
    focus() { if (!memo.map) q.focus({ preventScroll: true }); area.redraw(); preview.redraw(); },
    destroy() { if (ctl) ctl.abort(); clearInterval(tick); preview.destroy(); area.destroy(); },
  };
}
