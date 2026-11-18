// Map editor ("Survey Office"): draft roads, buildings, water, parks, stage boundaries and outbreak hints
// on the paper map, check the result, test-play it, file it in the library or export it.
// openEditor(container, { map?, libId?, onExit(), onTestPlay(map) }) -> { destroy, getMap, isDirty, hide, show }
import { Camera } from '../render/camera.js';
import { drawStatic, drawMinimap, drawScaleBar, makeStaticCache } from '../render/maprender.js';
import { getPalette, applyPalette } from '../render/palette.js';
import { normalizeMap, validateMap, makeStages, ROAD_WIDTH, DEFAULT_HEIGHT } from '../map/format.js';
import { saveItem, downloadItem, shareCode } from '../map/library.js';
import { isHugeMap } from '../map/osm.js';
import { polyBBox, polyArea, pointInPoly, clamp } from '../util/geom.js';
import { DEFAULTS } from '../data/config.js';
import { EditorDoc, cloneMap, cloneItem, itemBBox, itemCentre, translated, rotated, resizedMap, DRAWN_COLLS } from './editor_model.js';
import { TOOLS, TOOL_BY_ID, drawCommon } from './editor_tools.js';
import { refreshCache, drawStageTags, drawIssuePins, drawSnap } from './editor_render.js';
import { checkMap } from './editor_check.js';
import { el, ensureEditorCss } from './editor_dom.js';
import { renderItemPanel, renderStagesPanel, renderSheetPanel, renderCheckPanel, startDialog, confirmDialog, shareDialog, shortcutsDialog } from './editor_panels.js';

const ICONS = {
  select: '<path d="M4 2.5v12.2l3.3-3.1 2.4 5.4 2-.9-2.4-5.3h4.6z"/>',
  road: '<path d="M5.5 2 3 16M12.5 2 15 16"/><path d="M9 3v2.4M9 7.8v2.4M9 12.6V15" stroke-dasharray="0"/>',
  building: '<rect x="3" y="5" width="12" height="10"/><path d="M3 11l6-6M6 15l9-9M11 15l4-4"/>',
  water: '<path d="M2 6c2.3-2 4.7 2 7 0s4.7 2 7 0M2 10c2.3-2 4.7 2 7 0s4.7 2 7 0M2 14c2.3-2 4.7 2 7 0s4.7 2 7 0"/>',
  park: '<circle cx="9" cy="7.5" r="4.5"/><path d="M9 12v4.5M6 16.5h6"/><circle cx="9" cy="7.5" r="1"/>',
  erase: '<path d="M3 3l12 12M15 3 3 15"/>',
  stage: '<path d="M9 2l6.5 3.8v6.4L9 16l-6.5-3.8V5.8z" stroke-dasharray="2.2 1.6"/><path d="M9 6l3 1.8v3.4L9 13l-3-1.8V7.8z"/>',
  spawn: '<circle cx="9" cy="9" r="4"/><path d="M9 1.5v4M9 12.5v4M1.5 9h4M12.5 9h4"/>',
  heights: '<path d="M3 16V10h3v6M7.5 16V5h3v11M12 16V8h3v8"/>',
  specials: '<circle cx="9" cy="9" r="6.5"/><circle cx="9" cy="9" r="4.2"/><path d="M10.6 7.4a2.2 2.2 0 1 0 0 3.2"/>',
  stages: '<rect x="2.5" y="2.5" width="13" height="13" stroke-dasharray="2.4 1.6"/><rect x="6" y="6" width="6" height="6"/>',
  fit: '<path d="M2.5 6.5v-4h4M11.5 2.5h4v4M15.5 11.5v4h-4M6.5 15.5h-4v-4"/>',
};
const icon = name => `<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const boxUnion = (a, b) => (!a ? b && b.slice() : !b ? a.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const isTextField = t => t && (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'file'].includes(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export function openEditor(container, opts = {}) {
  ensureEditorCss();
  const root = el('div', { class: 'ed-root', 'data-palette': 'paper' });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  if (container.clientHeight < 200) root.classList.add('ed-fixed');

  // ---------------------------------------------------------------- DOM
  const nameIn = el('input', { class: 'input line ed-name', type: 'text', maxlength: 80, 'aria-label': 'Map name', dataset: { key: 'head-name' } });
  const formNo = el('span', { class: 'form-no ed-formno' });
  const dirtyChip = el('span', { class: 'chip ed-dirty', hidden: true, text: 'UNSAVED' });
  const undoBtn = el('button', { class: 'btn btn-sm', type: 'button', title: 'Undo (Ctrl+Z)', dataset: { act: 'undo' } }, 'Undo');
  const redoBtn = el('button', { class: 'btn btn-sm', type: 'button', title: 'Redo (Ctrl+Y)', dataset: { act: 'redo' } }, 'Redo');
  const checkBtn = el('button', { class: 'btn btn-sm', type: 'button', dataset: { act: 'check' } }, 'Inspect');
  const playBtn = el('button', { class: 'btn btn-sm btn-go', type: 'button', dataset: { act: 'play' } }, 'Test play');
  const saveBtn = el('button', { class: 'btn btn-sm', type: 'button', title: 'Save to library (Ctrl+S)', dataset: { act: 'save' } }, 'Save');
  const fileMenu = el('div', { class: 'ed-menu', hidden: true, role: 'menu' });
  const fileBtn = el('button', { class: 'btn btn-sm', type: 'button', 'aria-haspopup': 'menu', dataset: { act: 'file' } }, 'File ▾');
  const exitBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', dataset: { act: 'exit' } }, 'Exit');
  const head = el('header', { class: 'ed-head' },
    el('div', { class: 'ed-brand' }, el('span', { class: 'ed-mark', text: 'RC' }), el('div', null, el('b', { text: 'Survey Office' }), el('small', { text: 'Map drafting table' }))),
    el('div', { class: 'ed-titlebox' }, nameIn, el('div', { class: 'hstack gap-2' }, formNo, dirtyChip)),
    el('div', { class: 'ed-headbtns' }, undoBtn, redoBtn, el('span', { class: 'ed-sep' }), checkBtn, playBtn, saveBtn,
      el('div', { class: 'ed-menuwrap' }, fileBtn, fileMenu), exitBtn));

  const toolBtns = {};
  const toolbar = el('nav', { class: 'ed-tools', 'aria-label': 'Drafting tools' });
  for (const t of TOOLS) {
    const b = el('button', { class: 'ed-tool', type: 'button', title: `${t.name} (${t.hotkey})`, 'aria-pressed': 'false', dataset: { tool: t.id }, onclick: () => setTool(t.id) },
      el('span', { class: 'ed-ico', svg: icon(t.id) }), el('span', { class: 'ed-tlabel', text: t.name }), el('kbd', { class: 'keycap', text: t.hotkey }));
    toolBtns[t.id] = b;
    toolbar.append(b);
  }
  const viewBtns = {
    height: el('button', { class: 'ed-tool ed-view-btn', type: 'button', title: 'Colour by height (V)', 'aria-pressed': 'false', onclick: () => toggleView('height') }, el('span', { class: 'ed-ico', svg: icon('heights') }), el('span', { class: 'ed-tlabel', text: 'Heights' }), el('kbd', { class: 'keycap', text: 'V' })),
    specials: el('button', { class: 'ed-tool ed-view-btn', type: 'button', title: 'Show special buildings (C)', 'aria-pressed': 'false', onclick: () => toggleView('specials') }, el('span', { class: 'ed-ico', svg: icon('specials') }), el('span', { class: 'ed-tlabel', text: 'Specials' }), el('kbd', { class: 'keycap', text: 'C' })),
    stages: el('button', { class: 'ed-tool ed-view-btn', type: 'button', title: 'Show stage boundaries', 'aria-pressed': 'true', onclick: () => { ed.showStages = !ed.showStages; syncToolbar(); redraw(); } }, el('span', { class: 'ed-ico', svg: icon('stages') }), el('span', { class: 'ed-tlabel', text: 'Bounds' })),
    fit: el('button', { class: 'ed-tool ed-view-btn', type: 'button', title: 'Fit the sheet (F)', onclick: () => fitSheet(true) }, el('span', { class: 'ed-ico', svg: icon('fit') }), el('span', { class: 'ed-tlabel', text: 'Fit' }), el('kbd', { class: 'keycap', text: 'F' })),
  };
  toolbar.append(el('div', { class: 'ed-tools-sep' }), viewBtns.height, viewBtns.specials, viewBtns.stages, viewBtns.fit,
    el('button', { class: 'ed-tool ed-help', type: 'button', title: 'Keyboard shortcuts (?)', onclick: () => shortcutsDialog(root) }, el('span', { class: 'ed-ico', text: '?' }), el('span', { class: 'ed-tlabel', text: 'Keys' })));

  const canvas = el('canvas', { class: 'ed-canvas' });
  const ctx = canvas.getContext('2d');
  const mini = el('canvas', { class: 'ed-mini', title: 'Click to move the view' });
  const mctx = mini.getContext('2d');
  const toastEl = el('div', { class: 'ed-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  const miniWrap = el('div', { class: 'ed-mini-wrap', hidden: true }, mini);
  const view = el('main', { class: 'ed-view' }, canvas, miniWrap, toastEl);

  const tabs = [['item', 'Item'], ['stages', 'Stages'], ['sheet', 'Sheet'], ['check', 'Check']];
  const tabBar = el('div', { class: 'tabs', role: 'tablist' });
  const tabBtns = {};
  tabs.forEach(([id, txt], i) => {
    const b = el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { tab: id }, onclick: () => setTab(id) },
      el('span', { class: 'tab-no', text: String(i + 1).padStart(2, '0') }), txt);
    tabBtns[id] = b;
    tabBar.append(b);
  });
  const panel = el('div', { class: 'folder-body ed-panel' });
  const side = el('aside', { class: 'ed-side folder' }, tabBar, panel);

  const stCoords = el('span', { class: 'ed-st-coords', text: 'E ---- · S ----' });
  const stZoom = el('span', { class: 'ed-st-zoom' });
  const stCounts = el('span', { class: 'ed-st-counts' });
  const stHint = el('span', { class: 'ed-st-hint' });
  const status = el('footer', { class: 'ed-status' }, stCoords, stZoom, stCounts, stHint);

  root.append(head, toolbar, view, side, status);
  container.append(root);

  // ---------------------------------------------------------------- state
  const cam = new Camera({ maxZoom: 24, minZoomFit: 0.5 });
  let doc = null, dpr = 1, raf = 0, last = 0, needDraw = true, destroyed = false, hidden = false;
  let pendingRects = [], pendingFull = false, lastIndexMs = 0, panelQueued = false, fromPanelDepth = 0;
  let live = null;
  let toastTimer = 0;
  const keysDown = new Set();

  const ed = {
    get doc() { return doc; },
    cam,
    tool: TOOLS[0],
    tools: TOOL_BY_ID,
    sel: [], selKeys: new Set(), hover: null, snap: null,
    activeStage: 0, view: 'normal', showStages: true, dimOutside: true, tab: 'item',
    cacheFresh: true, issues: null,
    outbreakRadius: DEFAULTS.outbreak.radius,
    opts: {
      snap: true,
      road: { k: 'minor', w: ROAD_WIDTH.minor, name: '' },
      bldg: { k: 'res', h: DEFAULT_HEIGHT.res, use: '', name: '' },
      shape: { buildings: 'rect', water: 'poly', parks: 'poly' },
      erase: { buildings: true, roads: true, water: true, parks: true, spawns: true },
    },
    get pal() { return getPalette(doc ? doc.map.palette : 'paper'); },
    px: n => n / cam.zoom,
    redraw,
    toast,
    panels: () => queuePanels(),
    hintUpdate: () => updateHint(),
    setCursor: c => { if (canvas.style.cursor !== c) canvas.style.cursor = c; },
    isSelected: r => !!r && ed.selKeys.has(r.coll + ':' + r.idx),
    setSel(refs) {
      ed.sel = refs.map(r => ({ coll: r.coll, idx: r.idx }));
      ed.selKeys = new Set(ed.sel.map(r => r.coll + ':' + r.idx));
      if (ed.tab !== 'item' && ed.sel.length && ed.tool.id === 'select') setTab('item');
      queuePanels();
      updateHint();
      redraw();
    },
    toggleSel(r) {
      if (ed.isSelected(r)) ed.setSel(ed.sel.filter(s => !(s.coll === r.coll && s.idx === r.idx)));
      else ed.setSel(ed.sel.concat([r]));
    },
    setHover(h) {
      const a = ed.hover, same = (!a && !h) || (a && h && a.coll === h.coll && a.idx === h.idx);
      if (!same) { ed.hover = h ? { coll: h.coll, idx: h.idx } : null; redraw(); }
    },
    setActiveStage(k, keepFocus) {
      if (!doc) return;
      ed.activeStage = clamp(k, 0, Math.max(0, doc.map.levels.length - 1));
      if (!keepFocus) queuePanels(); else markStageRows();
      redraw();
    },
    fromPanel(fn) { fromPanelDepth++; try { return fn(); } finally { fromPanelDepth--; } },
    liveChanged(box, orig) {
      if (box) {
        if (!live) live = { prev: orig || box, rect: null };
        live.rect = boxUnion(boxUnion(live.rect, live.prev), box);
        live.prev = box;
      }
      redraw();
    },
    liveEnd() {
      if (live && live.prev) pendingRects.push(live.prev);
      if (live && live.rect) pendingRects.push(live.rect);
      live = null;
      ed.snap = null;
      redraw();
    },
    deleteSelection() {
      if (!ed.sel.length) return;
      const n = ed.sel.length;
      doc.removeMany(ed.sel, n > 1 ? `Delete ${n} items` : 'Delete');
      ed.setSel([]);
      ed.setHover(null);
      toast(`Deleted ${n} item${n > 1 ? 's' : ''}`);
    },
    duplicateSelection() {
      const refs = ed.sel.filter(r => r.coll !== 'levels');
      if (!refs.length) return;
      const m = doc.map, out = [];
      doc.transact('Duplicate', () => {
        for (const r of refs) {
          const it = m[r.coll][r.idx];
          if (!it) continue;
          const idx = doc.insert(r.coll, translated(r.coll, it, 10, 10));
          out.push({ coll: r.coll, idx });
        }
      });
      ed.setSel(out);
      toast(`Duplicated ${out.length} item${out.length > 1 ? 's' : ''}`);
    },
    transformSelection(fn, label) {
      const m = doc.map;
      doc.transact(label, () => { for (const r of ed.sel) { const it = m[r.coll][r.idx]; if (it) doc.set(r.coll, r.idx, fn(r.coll, it)); } });
    },
    rotateSelection(deg) {
      const [cx, cy] = ed.selectionCentre();
      ed.transformSelection((coll, it) => rotated(coll, it, deg * Math.PI / 180, cx, cy), 'Rotate');
    },
    selectionCentre() {
      let bb = null;
      for (const r of ed.sel) { const it = doc.map[r.coll][r.idx]; if (it) bb = boxUnion(bb, itemBBox(r.coll, it)); }
      return bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : [0, 0];
    },
    convertSelection(to) {
      const refs = ed.sel.filter(r => r.coll === 'water' || r.coll === 'parks');
      if (!refs.length) return;
      const out = [];
      doc.transact('Convert', () => {
        const items = refs.map(r => ({ p: doc.map[r.coll][r.idx].p.slice() }));
        doc.removeMany(refs);
        for (const it of items) out.push({ coll: to, idx: doc.insert(to, it) });
      });
      ed.setSel(out);
    },
    // ---- stages
    startStageDraw() {
      if (!doc.map.levels.length) return;
      if (ed.tool.id !== 'stage') setTool('stage');
      TOOL_BY_ID.stage.startDrawing(ed);
      queuePanels();
      updateHint();
    },
    stageWholeSheet() {
      const k = ed.activeStage, lv = doc.map.levels[k], m = doc.map;
      if (!lv) return;
      doc.set('levels', k, { ...lv, p: [0, 0, m.w, 0, m.w, m.h, 0, m.h] });
      toast(`Stage ${k + 1} now covers the whole sheet`);
    },
    addStage() {
      const m = doc.map, L = m.levels;
      if (L.length >= 7) return;
      const k = Math.min(ed.activeStage, L.length - 1);
      let p;
      if (k < 0) p = [0, 0, m.w, 0, m.w, m.h, 0, m.h];
      else {
        const src = L[k].p, [cx, cy] = itemCentre('levels', L[k]);
        const grow = Math.sqrt(L[k + 1] ? polyArea(L[k + 1].p) / Math.max(1, polyArea(src)) : 1.6);
        const f = clamp((1 + grow) / 2, 1.05, 1.8);
        p = [];
        for (let i = 0; i < src.length; i += 2) p.push(clamp(Math.round((cx + (src[i] - cx) * f) * 10) / 10, 0, m.w), clamp(Math.round((cy + (src[i + 1] - cy) * f) * 10) / 10, 0, m.h));
      }
      doc.insert('levels', { p }, k + 1);
      ed.setActiveStage(k + 1);
      toast(`Stage ${k + 2} added; adjust its boundary`);
    },
    removeStage(k) {
      if (doc.map.levels.length <= 1) return;
      doc.remove('levels', k);
      ed.setActiveStage(Math.min(k, doc.map.levels.length - 1));
    },
    moveStage(k, dir) {
      const L = doc.map.levels, j = k + dir;
      if (j < 0 || j >= L.length) return;
      const list = L.map(cloneItem);
      [list[k], list[j]] = [list[j], list[k]];
      doc.setColl('levels', list, 'Reorder stages');
      ed.setActiveStage(j);
    },
    autoStages(count, around) {
      const m = doc.map;
      const [cx, cy] = around === 'view' ? [clamp(cam.cx, 0, m.w), clamp(cam.cy, 0, m.h)] : [m.w / 2, m.h / 2];
      const water = m.water.map(w => ({ p: w.p, bb: polyBBox(w.p) }));
      const land = (x, y) => {
        for (const w of water) if (x >= w.bb[0] && x <= w.bb[2] && y >= w.bb[1] && y <= w.bb[3] && pointInPoly(w.p, x, y)) return 0;
        return 1;
      };
      const labels = m.levels.map(l => l.label);
      const levels = makeStages(m.w, m.h, count, { cx, cy, seed: m.seed, weight: land, labels });
      doc.setColl('levels', levels, 'Auto stages');
      ed.setActiveStage(0);
      toast(`${count} stage boundaries drawn around the ${around === 'view' ? 'view' : 'sheet'} centre`);
    },
    resizeSheet: (w, h) => resizeSheet(w, h),
    runCheck: () => runCheck(),
    gotoIssue(it) {
      if (it.at) cam.flyTo(it.at[0], it.at[1], Math.max(cam.zoom, 1.2), 0.4);
      if (it.ref && it.ref.coll === 'levels') { ed.setActiveStage(it.ref.idx); }
      else if (it.ref && doc.map[it.ref.coll] && doc.map[it.ref.coll][it.ref.idx]) {
        setTool('select');
        ed.setSel([it.ref]);
        setTab('check');
      }
      redraw();
    },
  };

  // ---------------------------------------------------------------- doc lifecycle
  function load(map, libId = null) {
    doc = new EditorDoc(map);
    doc.libId = libId;
    doc.onChange(onDocChange);
    makeStaticCache(doc.map, null);
    lastIndexMs = 0;
    ed.sel = []; ed.selKeys = new Set(); ed.hover = null; ed.issues = null; ed.activeStage = 0;
    for (const t of TOOLS) if (t.cancel) t.cancel(ed);
    applyPalette(doc.map.palette, root);
    miniWrap.hidden = false;
    syncToolbar();
    cam.setMap(doc.map);
    resize();
    fitSheet(false);
    syncHeader();
    queuePanels();
    updateHint();
    if (isHugeMap(doc.map)) toast(`Large map: ${doc.map.buildings.length.toLocaleString('en-GB')} buildings. Edits may take a moment to redraw.`, 'warn', 5000);
    redraw();
  }

  function onDocChange(info) {
    let structural = false;
    for (const i of info.infos) {
      if (i.full) pendingFull = true;
      else if (i.rect && DRAWN_COLLS.has(i.coll)) pendingRects.push(i.rect);
      if (i.meta === 'palette' || i.meta === '*') applyPalette(doc.map.palette, root);
      if (i.meta === 'w' || i.meta === 'h' || i.meta === '*') cam.setMap(doc.map);
      if (i.structural) structural = true;
    }
    if (structural && (info.undo || info.redo)) { ed.sel = []; ed.selKeys = new Set(); ed.hover = null; }
    ed.sel = ed.sel.filter(r => doc.map[r.coll] && doc.map[r.coll][r.idx] !== undefined);
    ed.selKeys = new Set(ed.sel.map(r => r.coll + ':' + r.idx));
    if (ed.hover && !(doc.map[ed.hover.coll] && doc.map[ed.hover.coll][ed.hover.idx])) ed.hover = null;
    if (ed.activeStage >= doc.map.levels.length) ed.activeStage = Math.max(0, doc.map.levels.length - 1);
    if (ed.issues) ed.issues.stale = true;
    if (info.undo || info.redo) toast(`${info.undo ? 'Undone' : 'Redone'}${info.label ? ': ' + info.label : ''}`);
    syncHeader();
    if (!fromPanelDepth || structural) queuePanels();
    else if (ed.tab === 'check') queuePanels();
    redraw();
  }

  function syncHeader() {
    if (!doc) return;
    const m = doc.map;
    if (document.activeElement !== nameIn) nameIn.value = m.name;
    formNo.textContent = `SHEET ${(m.w / 1000).toFixed(1)} × ${(m.h / 1000).toFixed(1)} KM · ${m.levels.length} STAGES${doc.libId ? ' · FILED' : ''}`;
    dirtyChip.hidden = !doc.dirty;
    undoBtn.disabled = !doc.undoStack.length;
    redoBtn.disabled = !doc.redoStack.length;
    undoBtn.title = doc.undoStack.length ? `Undo ${doc.undoStack[doc.undoStack.length - 1].label || 'edit'} (Ctrl+Z)` : 'Nothing to undo';
    stCounts.textContent = `${m.buildings.length.toLocaleString('en-GB')} bldgs · ${m.roads.length.toLocaleString('en-GB')} roads · ${m.water.length} water · ${m.parks.length} parks`;
  }

  // ---------------------------------------------------------------- tools, tabs, views
  function setTool(id) {
    const t = TOOL_BY_ID[id];
    if (!t || !doc) return;
    if (ed.tool !== t) {
      if (ed.tool.cancel) ed.tool.cancel(ed);
      ed.tool = t;
    }
    ed.hover = null;
    ed.snap = null;
    canvas.style.cursor = t.cursor;
    if (id === 'stage') setTab('stages');
    else if (ed.tab === 'stages' || ed.tab === 'sheet') setTab('item');
    syncToolbar();
    queuePanels();
    updateHint();
    redraw();
  }

  function syncToolbar() {
    for (const t of TOOLS) toolBtns[t.id].setAttribute('aria-pressed', String(ed.tool.id === t.id));
    viewBtns.height.setAttribute('aria-pressed', String(ed.view === 'height'));
    viewBtns.specials.setAttribute('aria-pressed', String(ed.view === 'specials'));
    viewBtns.stages.setAttribute('aria-pressed', String(ed.showStages));
  }

  function toggleView(v) { ed.view = ed.view === v ? 'normal' : v; syncToolbar(); redraw(); }

  function setTab(id) {
    ed.tab = id;
    for (const [t] of tabs) tabBtns[t].setAttribute('aria-selected', String(t === id));
    queuePanels();
    redraw();
  }

  function queuePanels() {
    if (panelQueued) return;
    panelQueued = true;
    requestAnimationFrame(() => { panelQueued = false; renderPanels(); });
  }

  function renderPanels() {
    if (!doc || destroyed) return;
    const active = document.activeElement;
    const key = active && panel.contains(active) ? active.dataset.key : null;
    let selStart = null, selEnd = null;
    try { if (key && active.selectionStart != null) { selStart = active.selectionStart; selEnd = active.selectionEnd; } } catch (e) { /* number inputs have no selection */ }
    const scroll = panel.scrollTop;
    panel.replaceChildren();
    if (ed.tab === 'item') renderItemPanel(ed, panel);
    else if (ed.tab === 'stages') renderStagesPanel(ed, panel);
    else if (ed.tab === 'sheet') renderSheetPanel(ed, panel);
    else renderCheckPanel(ed, panel);
    panel.scrollTop = scroll;
    if (key) {
      const again = panel.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (again) {
        again.focus();
        try { if (selStart != null) again.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text field */ }
      }
    }
  }

  function markStageRows() {
    panel.querySelectorAll('.ed-stage-table tbody tr').forEach((tr, i) => tr.classList.toggle('is-sel', i === ed.activeStage));
  }

  function updateHint() { stHint.textContent = doc && ed.tool.hint ? ed.tool.hint(ed) : ''; }

  function toast(msg, kind = 'info', ms = 2600) {
    toastEl.textContent = msg;
    toastEl.className = 'ed-toast ' + kind;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- camera + drawing
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = view.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    cam.resize(w, h);
    if (doc) {
      const s = Math.min(1, 168 / Math.max(doc.map.w, doc.map.h));
      const mw = Math.max(60, Math.round(doc.map.w * s)), mh = Math.max(60, Math.round(doc.map.h * s));
      mini.style.width = mw + 'px';
      mini.style.height = mh + 'px';
      mini.width = Math.round(mw * dpr);
      mini.height = Math.round(mh * dpr);
    }
    redraw();
  }

  function fitSheet(smooth) {
    if (!doc) return;
    const bb = [0, 0, doc.map.w, doc.map.h];
    if (smooth) cam.fitSmooth(bb, 48, 0.4); else cam.fit(bb, cam.w, cam.h, 48);
    redraw();
  }

  function redraw() { needDraw = true; }

  function draw() {
    const m = doc.map, pal = ed.pal;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const hoverB = ed.tool.id === 'select' && ed.cacheFresh && ed.hover && ed.hover.coll === 'buildings' && !ed.isSelected(ed.hover) ? ed.hover.idx : null;
    const res = drawStatic(ctx, m, null, cam, {
      palette: m.palette, view: ed.view,
      stageMask: ed.showStages && m.levels.length ? ed.activeStage : null,
      allStages: ed.showStages, dimOutside: ed.tool.id === 'stage' && ed.dimOutside, hover: hoverB,
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ed.showStages) drawStageTags(ctx, cam, m, ed.activeStage, pal);
    drawCommon(ctx, ed);
    if (ed.tool.draw) ed.tool.draw(ctx, ed);
    drawSnap(ctx, cam, ed.snap, pal);
    if (ed.tab === 'check' && ed.issues) drawIssuePins(ctx, cam, ed.issues.list, pal);
    drawScaleBar(ctx, cam, { palette: pal, x: 16, y: cam.h - 14 });
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMinimap(mctx, m, mini.width / dpr, mini.height / dpr, { palette: pal, stage: ed.showStages && m.levels.length ? ed.activeStage : null, camera: cam });
    stZoom.textContent = scaleText();
    return res;
  }

  function scaleText() {
    const mPerPx = 1 / cam.zoom;
    return `1 px = ${mPerPx >= 1 ? mPerPx.toFixed(1) : mPerPx.toFixed(2)} m`;
  }

  function frame(t) {
    raf = 0;
    if (destroyed || hidden) return;
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    if (doc) {
      if (live && live.rect) {
        if (lastIndexMs < 14) {
          lastIndexMs = refreshCache(doc.map, [live.rect], false);
          live.rect = null;
          ed.cacheFresh = true;
        } else ed.cacheFresh = false;
      }
      if (!live && (pendingFull || pendingRects.length)) {
        lastIndexMs = refreshCache(doc.map, pendingRects, pendingFull);
        pendingRects = []; pendingFull = false;
        ed.cacheFresh = true;
        needDraw = true;
      }
      const pan = keyPan(dt);
      const moved = cam.update(dt) || pan;
      if (moved || needDraw) {
        needDraw = false;
        const res = draw();
        if (res.pending > 0) needDraw = true;
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function keyPan(dt) {
    if (!keysDown.size) return false;
    const s = 700 * dt;
    let dx = 0, dy = 0;
    if (keysDown.has('ArrowLeft')) dx += s;
    if (keysDown.has('ArrowRight')) dx -= s;
    if (keysDown.has('ArrowUp')) dy += s;
    if (keysDown.has('ArrowDown')) dy -= s;
    if (!dx && !dy) return false;
    cam.pan(dx, dy);
    return true;
  }

  // ---------------------------------------------------------------- pointer input
  let ptr = null;
  const evOf = e => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: cam.toWorldX(sx), y: cam.toWorldY(sy), button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  };

  canvas.addEventListener('pointerdown', e => {
    if (!doc) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    const ev = evOf(e);
    const panMode = e.button === 1 || (e.button === 0 && keysDown.has(' '));
    ptr = { id: e.pointerId, button: e.button, sx: ev.sx, sy: ev.sy, moved: 0, pan: panMode, maybePan: e.button === 2 };
    if (panMode) { canvas.style.cursor = 'grabbing'; e.preventDefault(); return; }
    if (e.button === 0) { ed.tool.down && ed.tool.down(ed, ev); updateHint(); redraw(); }
  });

  canvas.addEventListener('pointermove', e => {
    if (!doc) return;
    const ev = evOf(e);
    stCoords.textContent = `E ${Math.round(clamp(ev.x, 0, doc.map.w)).toString().padStart(4, '0')} · S ${Math.round(clamp(ev.y, 0, doc.map.h)).toString().padStart(4, '0')} m`;
    if (ptr && ptr.id === e.pointerId) {
      const dx = ev.sx - ptr.sx, dy = ev.sy - ptr.sy;
      ptr.moved += Math.abs(dx) + Math.abs(dy);
      if (ptr.maybePan && ptr.moved > 4) { ptr.pan = true; ptr.maybePan = false; canvas.style.cursor = 'grabbing'; }
      if (ptr.pan) { cam.pan(dx, dy); ptr.sx = ev.sx; ptr.sy = ev.sy; redraw(); return; }
      if (ptr.maybePan) return;
    }
    if (ed.tool.move) ed.tool.move(ed, ev);
    redraw();
  });

  const endPointer = (e, cancelled) => {
    if (!ptr || ptr.id !== e.pointerId) return;
    const p = ptr;
    ptr = null;
    const ev = evOf(e);
    if (p.pan) { canvas.style.cursor = ed.tool.cursor; return; }
    if (cancelled) { ed.tool.cancel && ed.tool.cancel(ed); return; }
    if (p.maybePan) { if (ed.tool.right) ed.tool.right(ed, ev); }
    else if (p.button === 0 && ed.tool.up) ed.tool.up(ed, ev);
    updateHint();
    redraw();
  };
  canvas.addEventListener('pointerup', e => endPointer(e, false));
  canvas.addEventListener('pointercancel', e => endPointer(e, true));
  canvas.addEventListener('pointerleave', () => { if (!ptr) { ed.setHover(null); ed.snap = null; redraw(); } });
  canvas.addEventListener('dblclick', e => { if (doc && e.button === 0 && ed.tool.dbl) { ed.tool.dbl(ed, evOf(e)); updateHint(); redraw(); } });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!doc) return;
    const ev = evOf(e);
    if (ed.tool.wheel && ed.tool.wheel(ed, ev, e.deltaY)) { redraw(); return; }
    cam.wheel(e.deltaY, ev.sx, ev.sy, e.deltaMode);
    redraw();
  }, { passive: false });
  canvas.tabIndex = 0;

  const miniPick = e => {
    if (!doc) return;
    const r = mini.getBoundingClientRect();
    const s = Math.min((r.width - 6) / doc.map.w, (r.height - 6) / doc.map.h);
    const ox = (r.width - doc.map.w * s) / 2, oy = (r.height - doc.map.h * s) / 2;
    cam.centerOn((e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s);
    redraw();
  };
  mini.addEventListener('pointerdown', e => { mini.setPointerCapture(e.pointerId); miniPick(e); });
  mini.addEventListener('pointermove', e => { if (e.buttons & 1) miniPick(e); });

  // ---------------------------------------------------------------- keyboard
  const onKeyDown = e => {
    if (destroyed || hidden || !doc || root.querySelector('.ed-modal')) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); save(e.shiftKey); return; }
    if (isTextField(e.target)) {
      if (k === 'Escape') e.target.blur();
      return;
    }
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (ctrl && (k === 'e' || k === 'E')) { e.preventDefault(); exportFile(); return; }
    if (ed.tool.key && ed.tool.key(ed, e)) { e.preventDefault(); updateHint(); redraw(); return; }
    if (k === 'Escape') {
      if (!(ed.tool.cancel && ed.tool.cancel(ed))) { if (ed.sel.length) ed.setSel([]); else if (ed.tool.id !== 'select') setTool('select'); }
      e.preventDefault();
      updateHint();
      redraw();
      return;
    }
    if (k === ' ') { keysDown.add(' '); canvas.style.cursor = 'grab'; e.preventDefault(); return; }
    if (k.startsWith('Arrow')) { keysDown.add(k); e.preventDefault(); return; }
    if (ctrl || e.altKey) return;
    const low = k.toLowerCase();
    const t = TOOLS.find(x => x.hotkey.toLowerCase() === low);
    if (t) { setTool(t.id); e.preventDefault(); return; }
    if (/^[1-8]$/.test(k)) { setTool(TOOLS[+k - 1].id); e.preventDefault(); return; }
    if (low === 'v') { toggleView('height'); return; }
    if (low === 'c') { toggleView('specials'); return; }
    if (low === 'f' || k === 'Home') { fitSheet(true); return; }
    if (k === '?' || k === 'h' || k === 'H') { shortcutsDialog(root); return; }
  };
  const onKeyUp = e => {
    keysDown.delete(e.key);
    if (e.key === ' ' && doc) canvas.style.cursor = ed.tool.cursor;
  };
  const onBlur = () => keysDown.clear();
  const onBeforeUnload = e => { if (doc && doc.dirty && !destroyed) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('beforeunload', onBeforeUnload);
  const ro = new ResizeObserver(() => resize());
  ro.observe(view);

  // ---------------------------------------------------------------- header actions
  function undo() { if (doc && doc.undo()) { for (const t of TOOLS) if (t.cancel) t.cancel(ed); } }
  function redo() { if (doc) doc.redo(); }
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  nameIn.addEventListener('input', () => { if (doc) ed.fromPanel(() => doc.setMeta('name', nameIn.value.slice(0, 80), 'meta-name')); });
  nameIn.addEventListener('change', () => { if (doc && !nameIn.value.trim()) { doc.setMeta('name', 'Untitled'); nameIn.value = 'Untitled'; } });
  checkBtn.addEventListener('click', () => runCheck());
  playBtn.addEventListener('click', () => testPlay());
  saveBtn.addEventListener('click', () => save(false));
  exitBtn.addEventListener('click', () => exit());

  const menuItems = [
    ['Save as new copy', () => save(true)],
    ['Export map file', () => exportFile()],
    ['Copy share code', () => shareMap()],
    ['New sheet…', () => newSheet()],
  ];
  for (const [txt, fn] of menuItems) fileMenu.append(el('button', { class: 'ed-menu-item', type: 'button', role: 'menuitem', onclick: () => { fileMenu.hidden = true; fn(); } }, txt));
  fileBtn.addEventListener('click', e => { e.stopPropagation(); fileMenu.hidden = !fileMenu.hidden; });
  const closeMenu = e => { if (!fileMenu.hidden && !fileMenu.contains(e.target) && e.target !== fileBtn) fileMenu.hidden = true; };
  document.addEventListener('pointerdown', closeMenu, true);

  function runCheck() {
    if (!doc) return null;
    const r = checkMap(doc.map);
    r.list = [...r.errors.map(i => ({ ...i, level: 'error' })), ...r.warnings.map(i => ({ ...i, level: 'warn' }))];
    ed.issues = r;
    setTab('check');
    toast(r.ok ? `Approved · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : `Rejected · ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`, r.ok ? 'good' : 'alert');
    return r;
  }

  function exportedMap() { return normalizeMap(cloneMap(doc.map)); }

  function testPlay() {
    if (!doc) return;
    const r = runCheck();
    if (!r.ok) { toast('Fix the errors in the Check tab before test play', 'alert', 3600); return; }
    if (opts.onTestPlay) opts.onTestPlay(exportedMap());
  }

  async function save(asNew) {
    if (!doc) return null;
    const data = exportedMap();
    const v = validateMap(data);
    if (!v.ok) { runCheck(); toast('This map cannot be filed yet: ' + v.errors[0], 'alert', 4000); return null; }
    saveBtn.disabled = true;
    try {
      const item = await saveItem({ id: asNew ? undefined : doc.libId || undefined, type: 'map', name: data.name, author: data.author, desc: data.desc, data });
      doc.libId = item.id;
      doc.markSaved();
      syncHeader();
      toast(`Filed in the library as "${item.name}"${asNew ? ' (new copy)' : ''}`, 'good');
      return item;
    } catch (e) {
      toast('Could not save: ' + (e.message || e), 'alert', 4000);
      return null;
    } finally { saveBtn.disabled = false; }
  }

  function exportFile() {
    if (!doc) return;
    try {
      const data = exportedMap();
      downloadItem({ type: 'map', name: data.name, data });
      toast('Map file exported', 'good');
    } catch (e) { toast('Export failed: ' + (e.message || e), 'alert', 4000); }
  }

  async function shareMap() {
    if (!doc) return;
    try {
      const data = exportedMap();
      const code = await shareCode({ type: 'map', name: data.name, author: data.author, desc: data.desc, data });
      shareDialog(root, code);
    } catch (e) { toast('Could not make a share code: ' + (e.message || e), 'alert', 4000); }
  }

  async function newSheet() {
    if (doc && doc.dirty) {
      const ok = await confirmDialog(root, { title: 'Start a new sheet?', text: 'The current map has unsaved changes. Starting a new sheet discards them.', ok: 'Discard and start', extra: 'Save first' });
      if (!ok) return;
      if (ok === 'extra' && !(await save(false))) return;
    }
    const pick = await startDialog(root, {});
    if (pick) load(pick.map, pick.libId || null);
  }

  function resizeSheet(w, h) {
    if (!doc) return;
    const m = doc.map;
    if (!(w > 0 && h > 0)) return;
    const shrink = w < m.w || h < m.h;
    const doIt = () => {
      doc.replaceAll(resizedMap(m, w, h), 'Resize sheet');
      cam.setMap(doc.map);
      resize();
      fitSheet(true);
      toast(`Sheet is now ${(doc.map.w / 1000).toFixed(2)} × ${(doc.map.h / 1000).toFixed(2)} km`);
    };
    if (!shrink) return doIt();
    confirmDialog(root, { title: 'Crop the sheet?', text: 'Everything beyond the new edge will be cut away. You can undo this.', ok: 'Crop' }).then(ok => { if (ok) doIt(); });
  }

  async function exit() {
    if (doc && doc.dirty) {
      const ok = await confirmDialog(root, { title: 'Leave the drafting table?', text: 'This map has unsaved changes.', ok: 'Discard changes', extra: 'Save and leave', cancel: 'Keep editing' });
      if (!ok) return;
      if (ok === 'extra' && !(await save(false))) return;
    }
    destroy();
    if (opts.onExit) opts.onExit();
  }

  // ---------------------------------------------------------------- lifecycle
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(toastTimer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('pointerdown', closeMenu, true);
    ro.disconnect();
    root.remove();
  }

  const api = {
    destroy,
    getMap: () => (doc ? exportedMap() : null),
    isDirty: () => !!(doc && doc.dirty),
    hide() { hidden = true; root.hidden = true; keysDown.clear(); },
    show() { if (destroyed) return; hidden = false; root.hidden = false; resize(); redraw(); if (!raf) raf = requestAnimationFrame(frame); },
    // test / debug access
    get _ed() { return ed; },
    _check: () => runCheck(),
    _save: asNew => save(asNew),
  };

  resize();
  raf = requestAnimationFrame(frame);
  if (opts.map) load(opts.map, opts.libId || null);
  else {
    startDialog(root, { cancelText: 'Back' }).then(pick => {
      if (destroyed) return;
      if (pick) load(pick.map, pick.libId || null);
      else { destroy(); if (opts.onExit) opts.onExit(); }
    });
  }
  return api;
}
