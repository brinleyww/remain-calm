// Free Play / Sandbox setup: choose a map (generated, real place, library), mutators, difficulty, loadout.
import { WATER_TYPES } from '../map/citygen.js';
import { mapStats, popLimit } from '../map/format.js';
import { getItem, saveItem } from '../map/library.js';
import { OSM_ATTRIBUTION, OSM_ATTRIBUTION_URL } from '../map/osm.js';
import { makeConfig } from '../data/config.js';
import { getSettings } from '../meta/settings.js';
import { bestRecord, getLoadout, freePlaySet } from '../meta/progress.js';
import { ALL_ITEMS } from '../map/campaign.js';
import { h, append, clear, sfx, fmtInt, fmtMoney, toast, debounce, isTyping, keycap, openModal } from './dom.js';
import { screenFrame, folderTabs, difficultySeg, segControl, slider, field, stageSeal, DIFF_LABEL } from './screen.js';
import { generate } from './gen.js';
import { mapPreview, mapFacts, mapKeyFor, stageCaps, civEstimate, crowdLine, fitLoadout, abilitySpOf, WATER_LABEL } from './mapinfo.js';
import { mutatorPicker, newSelection, selectionLines, selectionNames } from './mutators.js';
import { libraryPicker } from './library.js';
import { mountImport } from './import.js';
import { unitSymbol, unitName, abilityCode } from './names.js';

const SOURCE_LABEL = { gen: 'Generated', osm: 'Real place', editor: 'Drawn', library: 'Library' };
const randomSeed = () => String(100000 + Math.floor(Math.random() * 900000));

const memo = {
  tab: 'generated',
  gen: { seed: randomSeed(), sizeKm: 2, water: 'river', density: 0.6, bridges: 3, stages: 5, name: '' },
  difficulty: 'normal',
  sel: newSelection(),
  startStage: 0,
  sandbox: false,
  maps: { generated: null, osm: null, library: null },
  libId: null,
};

export function mount(root, app, params) {
  let ordersReady = false; // tab, importer and library callbacks can fire before the orders panel exists
  memo.sandbox = params.sandbox === true || params.sandbox === '1' || params.sandbox === 1;
  if (params.lib) { memo.tab = 'library'; memo.libId = params.lib; }
  if (params.tab === 'osm' || params.tab === 'generated') memo.tab = params.tab;
  const sandboxMode = () => memo.sandbox;

  const frame = screenFrame({
    form: 'OCP-22', title: memo.sandbox ? 'Sandbox' : 'Free Play',
    sub: 'Exercise order: pick a city, set the conditions, sign it off', onBack: () => app.go('title'),
  });
  root.appendChild(frame.el);

  // ---------------- tab panes (kept alive so an import keeps running when switching tabs)
  const panes = { generated: h('div.fp-pane'), osm: h('div.fp-pane'), library: h('div.fp-pane') };
  const folder = folderTabs([
    { id: 'generated', label: 'Generated', no: 'A' },
    { id: 'osm', label: 'Real place', no: 'B' },
    { id: 'library', label: 'Library', no: 'C' },
  ], memo.tab, (id) => {
    memo.tab = id;
    for (const k in panes) panes[k].hidden = k !== id;
    if (id === 'osm' && importer) importer.focus();
    if (id === 'library' && picker) picker.refresh();
    updateOrders();
  });
  for (const k in panes) folder.body.appendChild(panes[k]);

  const orders = h('aside.card.raised.orders');
  frame.body.appendChild(h('div.fp-grid', folder.el, orders));

  const currentMap = () => memo.maps[memo.tab];

  // ---------------- generated
  const g = memo.gen;
  const genPreview = mapPreview({ cls: 'gen-preview', label: 'Plotting' });
  const genFacts = h('div.gen-facts');
  const genStatus = h('span.tiny.faint.gen-status');
  const seedIn = h('input.input', { type: 'text', maxLength: 24, 'aria-label': 'Seed' });
  seedIn.value = g.seed;
  const nameIn = h('input.input', { type: 'text', maxLength: 80, placeholder: 'Leave blank for a generated name' });
  nameIn.value = g.name;
  const sizeHint = h('span.hint');
  const sizeNote = (map) => {
    if (map && Math.abs(map.w / 1000 - g.sizeKm) < 0.05) sizeHint.textContent = crowdLine(map, getSettings().popScale, cfgNow());
    else sizeHint.textContent = g.sizeKm > 5 ? `${g.sizeKm.toFixed(1)} km sheet · a city this size takes a few seconds to draw and runs with a thinned crowd` : `${g.sizeKm.toFixed(1)} km sheet`;
  };
  const sizeS = slider({ min: 1, max: 10, step: 0.1, value: g.sizeKm, format: v => v.toFixed(1) + ' km', oninput: v => { g.sizeKm = v; sizeNote(null); regen(); } });
  const densS = slider({ min: 0, max: 1, step: 0.05, value: g.density, format: v => Math.round(v * 100) + '%', oninput: v => { g.density = v; regen(); } });
  const bridgeS = slider({ min: 0, max: 8, step: 1, value: g.bridges, format: v => String(v), oninput: v => { g.bridges = v; regen(); } });
  const waterSeg = segControl(WATER_TYPES.map(w => ({ value: w, label: WATER_LABEL[w] || w })), g.water, v => { g.water = v; syncBridges(); regen(); }, { label: 'Water' });
  const stagesSeg = segControl([3, 4, 5, 6, 7].map(n => ({ value: n, label: String(n) })), g.stages, v => { g.stages = v; regen(); }, { label: 'Stages' });
  const syncBridges = () => { bridgeS.input.disabled = g.water === 'none'; };
  syncBridges();
  seedIn.addEventListener('input', () => { g.seed = seedIn.value.trim() || '1'; regen(); });
  nameIn.addEventListener('input', debounce(() => { g.name = nameIn.value.trim(); regen(); }, 400));
  const reroll = h('button.btn.btn-sm', { type: 'button', title: 'New random seed', onclick: () => { g.seed = randomSeed(); seedIn.value = g.seed; sfx.clack(); regen(true); } }, 'Reroll');
  const saveGen = h('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => saveMap(memo.maps.generated) }, 'Save to library');
  const editGen = h('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => memo.maps.generated && app.go('editor', { map: memo.maps.generated }) }, 'Open in editor');
  panes.generated.append(h('div.gen-grid',
    h('div.gen-form',
      field('Seed', h('div.seed-row', seedIn, reroll), 'Any word or number. The same seed always draws the same city.'),
      field('Size', sizeS.el, sizeHint),
      field('Water', waterSeg.el),
      field('Density', densS.el),
      field('Bridges', bridgeS.el, 'Crossings over the water, when there is any.'),
      field('Stages', stagesSeg.el),
      field('Name', nameIn)),
    h('div.gen-side', genPreview.el, h('div.spread', genStatus, h('span')), genFacts, h('div.btn-row', saveGen, editGen))));

  let genSeq = 0;
  const regen = debounce(async (instant) => {
    const seq = ++genSeq;
    genStatus.textContent = 'Plotting…';
    genPreview.el.classList.add('is-busy');
    const t0 = performance.now();
    try {
      const map = await generate({ ...g });
      if (seq !== genSeq || !root.isConnected) return;
      memo.maps.generated = map;
      genPreview.set(map, memo.startStage < map.levels.length ? memo.startStage : 0);
      clear(genFacts);
      genFacts.appendChild(mapFacts(map, mapStats(map)));
      genStatus.textContent = `${map.name} · drawn in ${Math.round(performance.now() - t0)} ms`;
      sizeNote(map);
      saveGen.disabled = false; editGen.disabled = false;
      if (memo.tab === 'generated') updateOrders();
    } catch (e) {
      if (e.superseded || seq !== genSeq) return;
      genStatus.textContent = 'Plotting failed: ' + e.message;
    }
    genPreview.el.classList.remove('is-busy');
  }, 260);

  // ---------------- real place
  const importer = mountImport(panes.osm, { onMap: (map) => { memo.maps.osm = map; if (memo.tab === 'osm') updateOrders(); } });

  // ---------------- library
  const libPreview = mapPreview({ cls: 'lib-pick-preview', label: 'Pick a map from the list' });
  const libInfo = h('div.lib-pick-info');
  const picker = libraryPicker({
    types: ['map', 'scenario'], selectedId: memo.libId,
    onPick: (item) => applyLibraryItem(item),
  });
  panes.library.append(h('div.lib-pick-grid', picker.el, h('div.lib-pick-side', libPreview.el, libInfo)));

  function applyLibraryItem(item) {
    memo.libId = item.id;
    const map = item.type === 'scenario' ? item.data.map : item.data;
    memo.maps.library = map;
    libPreview.set(map, null);
    clear(libInfo);
    libInfo.append(h('b.lib-pick-name', item.name), mapFacts(map, mapStats(map)));
    if (item.type === 'scenario') {
      memo.difficulty = item.data.difficulty || 'normal';
      memo.sel.extra = item.data.mutators.length ? { name: item.name + ' (scenario)', lines: item.data.mutators.slice() } : null;
      libInfo.appendChild(h('p.tiny.muted', `Scenario: ${DIFF_LABEL[memo.difficulty]}, ${item.data.mutators.length} mutator lines applied.`));
      muts.render();
    }
    if (memo.tab === 'library') updateOrders();
  }
  if (memo.libId) getItem(memo.libId).then(it => { if (it && root.isConnected) applyLibraryItem(it); });

  // ---------------- orders card
  const muts = mutatorPicker(memo.sel, () => updateOrders());
  const diff = difficultySeg(memo.difficulty, (d) => { memo.difficulty = d; updateOrders(); });
  const sandboxIn = h('input', { type: 'checkbox', checked: memo.sandbox });
  sandboxIn.addEventListener('change', () => { memo.sandbox = sandboxIn.checked; sfx.clack(); frame.el.querySelector('.mast-title').textContent = memo.sandbox ? 'Sandbox' : 'Free Play'; updateOrders(); });
  const mapLine = h('div.orders-map');
  const stageBox = h('div.orders-stage');
  const estimate = h('div.orders-est');
  const loadSum = h('div.orders-loadout');
  const startBtn = h('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onclick: () => begin() }, 'Begin exercise', keycap('Enter'));
  const scenBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => saveScenario() }, 'Save as scenario');
  const loadBtn = h('button.btn.btn-sm', { type: 'button', onclick: () => requisition() }, 'Requisition…');

  orders.append(
    h('div.card-head', h('h2.card-title', 'Exercise orders'), h('span.card-no', 'OCP-22/B')),
    mapLine,
    stageBox,
    h('div.orders-sec', h('span.label', 'Difficulty'), diff.el),
    h('label.toggle.orders-sandbox', sandboxIn, h('span.toggle-track'), 'Sandbox · unlimited, not recorded'),
    h('div.orders-sec', muts.el),
    h('div.orders-sec', h('div.spread', h('span.label', 'Loadout'), loadBtn), loadSum),
    estimate,
    h('div.orders-foot', scenBtn, startBtn));

  function cfgNow() { return makeConfig(selectionLines(memo.sel), { difficulty: memo.difficulty, sandbox: memo.sandbox }); }

  function updateOrders() {
    if (!ordersReady) return;
    const map = currentMap();
    clear(mapLine); clear(stageBox); clear(estimate); clear(loadSum);
    startBtn.disabled = !map;
    scenBtn.disabled = !map;
    if (!map) {
      mapLine.appendChild(h('p.empty-note', memo.tab === 'osm' ? 'Fetch a real place to plan on it.' : memo.tab === 'library' ? 'Pick a map from your library.' : 'Plotting a city…'));
      return;
    }
    append(mapLine, [
      h('div.orders-map-name', h('b', map.name), h('span.chip', SOURCE_LABEL[memo.tab === 'library' ? 'library' : map.source] || 'Map')),
      h('div.tiny.muted', `${(map.w / 1000).toFixed(1)} km × ${(map.h / 1000).toFixed(1)} km · ${map.levels.length} stages · ${fmtInt(map.buildings.length)} buildings`),
      map.geo ? h('p.tiny.attribution', 'Map data ', h('a', { href: OSM_ATTRIBUTION_URL, target: '_blank', rel: 'noopener' }, OSM_ATTRIBUTION)) : null]);
    if (memo.startStage >= map.levels.length) memo.startStage = 0;
    const key = mapKeyFor(map);
    const seals = h('div.orders-seals');
    for (let k = 0; k < map.levels.length; k++) {
      const r = bestRecord(key, k, memo.difficulty);
      const s = stageSeal(r ? r.badge : null, String(k + 1), { size: '2.1rem', title: r ? `Best ${r.pct.toFixed(1)}%` : 'No record' });
      const b = h('button.seal-btn' + (k === memo.startStage ? '.is-sel' : ''), { type: 'button', title: `Start at stage ${k + 1}`, onclick: () => { memo.startStage = k; sfx.key(); updateOrders(); previewStage(); } }, s);
      seals.appendChild(b);
    }
    stageBox.append(h('div.spread', h('span.label', 'Start at stage'), h('span.tiny.faint', 'Seals show your best badge')), seals);

    const cfg = cfgNow();
    const caps = stageCaps(map, memo.startStage, cfg, memo.difficulty, memo.sandbox);
    const lim = popLimit(map, cfg);
    const civ = civEstimate(caps.C, getSettings().popScale, cfg, lim.factor);
    estimate.append(
      h('div.kv', h('span', `Stage ${memo.startStage + 1} residents`), h('i'), h('b', fmtInt(caps.C))),
      h('div.kv', h('span', 'Civilians on the map'), h('i'), h('b', fmtInt(civ.n) + (civ.capped ? ' (capped)' : ''))),
      h('div.kv', h('span', 'Budget'), h('i'), h('b', memo.sandbox ? 'Unlimited' : fmtMoney(caps.money))),
      h('div.kv', h('span', 'Command points'), h('i'), h('b', memo.sandbox ? 'Unlimited' : caps.sp + ' SP')));
    const names = selectionNames(memo.sel);
    if (names.length) estimate.appendChild(h('p.tiny.muted.orders-muts', 'Mutators: ' + names.join(', ')));
    if (lim.limited) estimate.appendChild(h('p.tiny.muted', `Big sheet: residents thinned to ${Math.max(1, Math.round(lim.factor * 100))}% so it runs smoothly. A higher population scale in Settings adds more, at your own risk.`));
    if (civ.n > 40000) estimate.appendChild(h('p.tiny.err-text', 'Heavy simulation: lower the population scale in Settings if it stutters.'));

    const unlocked = memo.sandbox ? new Set(ALL_ITEMS) : freePlaySet();
    const lo = fitLoadout(getLoadout(), { spCap: memo.sandbox ? Infinity : caps.sp, unlocked, cfg });
    const slots = h('div.lo-mini');
    for (let i = 0; i < (cfg.loadoutSlots || 7); i++) {
      const u = lo.units[i];
      slots.appendChild(h('span.lo-mini-slot' + (u ? '' : '.is-empty'), { title: u ? unitName(u) : 'Empty slot', html: u ? unitSymbol(u, 18) : '' }));
    }
    const abil = Object.entries(lo.abilities);
    loadSum.append(slots, h('div.tiny.muted', abil.length ? abil.map(([id, n]) => `${abilityCode(id)} ×${n}`).join('  ') + ` · ${abilitySpOf(lo.abilities, cfg)} SP` : 'No ability charges'));
  }

  function previewStage() {
    const p = memo.tab === 'generated' ? genPreview : memo.tab === 'library' ? libPreview : null;
    if (p && p.map) p.setStage(memo.startStage);
  }

  async function saveMap(map) {
    if (!map) return;
    try {
      const it = await saveItem({ type: 'map', name: map.name, data: map });
      toast({ kind: 'info', stamp: 'Filed', title: it.name, body: 'Saved to your library.' });
    } catch (e) { toast({ kind: 'error', stamp: 'Error', title: 'Could not save', body: e.message }); }
  }

  function saveScenario() {
    const map = currentMap();
    if (!map) return;
    const nm = h('input.input', { type: 'text', maxLength: 80 });
    nm.value = `${map.name} · ${DIFF_LABEL[memo.difficulty]}`;
    openModal({
      title: 'Save scenario', no: 'Form OCP-43',
      body: h('div.vstack', h('p.small', 'A scenario files the map with the current mutators and difficulty so you or a friend can replay the same exercise.'), field('Name', nm)),
      actions: [{ label: 'Cancel', kind: 'ghost' }, {
        label: 'Save', kind: 'go', onClick: () => saveItem({ type: 'scenario', name: nm.value.trim() || map.name, data: { map, mutators: selectionLines(memo.sel), difficulty: memo.difficulty } })
          .then(it => { toast({ kind: 'info', stamp: 'Filed', title: it.name, body: 'Scenario saved to your library.' }); return true; })
          .catch(e => { toast({ kind: 'error', stamp: 'Error', title: 'Could not save', body: e.message }); return false; }),
      }],
    });
  }

  async function requisition() {
    sfx.page();
    await app.editLoadout({ map: currentMap(), stage: memo.startStage, cfg: cfgNow(), difficulty: memo.difficulty, sandbox: memo.sandbox, free: true });
    updateOrders();
  }

  function begin() {
    const map = currentMap();
    if (!map) return;
    sfx.thump();
    app.launch({
      map, mode: sandboxMode() ? 'sandbox' : 'free', difficulty: memo.difficulty, mutators: selectionLines(memo.sel),
      startStage: memo.startStage, returnTo: ['freeplay', memo.sandbox ? { sandbox: 1 } : {}],
    });
  }

  folder.select(memo.tab);
  sizeNote(memo.maps.generated);
  if (memo.maps.generated) {
    const m = memo.maps.generated;
    genPreview.set(m, 0);
    genFacts.appendChild(mapFacts(m, mapStats(m)));
    genStatus.textContent = m.name;
    saveGen.disabled = false; editGen.disabled = false;
  } else regen(true);
  ordersReady = true;
  updateOrders();

  return {
    onKey(e) {
      if (isTyping(e)) return false;
      if (e.key === 'Enter' && !(document.activeElement && /^(BUTTON|A|LABEL)$/.test(document.activeElement.tagName))) { begin(); return true; }
      if (e.key === 'r' || e.key === 'R') { if (memo.tab === 'generated') { reroll.click(); return true; } }
      return false;
    },
    destroy() { genSeq++; regen.cancel(); importer.destroy(); genPreview.destroy(); libPreview.destroy(); },
  };
}
