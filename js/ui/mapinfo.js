// Map facts the shell shows before a session exists: record keys, stage populations, budget and SP estimates,
// and the minimap preview widget.
import { DEFAULTS } from '../data/config.js';
import { popLimit } from '../map/format.js';
import { polyArea, polyBBox, pointInPoly } from '../util/geom.js';
import { hashStr } from '../util/rng.js';
import { drawMinimap } from '../render/maprender.js';
import { gamePalette } from '../meta/settings.js';
import { h, fitCanvas, fmtInt } from './dom.js';

const stageCache = new WeakMap();

// Record key for a non-campaign map: stable for the same content.
export function mapKeyFor(map) {
  if (map.__key) return map.__key;
  const sig = `${map.name}|${map.w}x${map.h}|${map.seed}|${map.buildings.length}|${map.roads.length}|${map.levels.length}|${map.source}`;
  const key = 'map:' + hashStr(sig).toString(36);
  Object.defineProperty(map, '__key', { value: key, enumerable: false });
  return key;
}

// Nominal population C per stage (building centroids inside each stage polygon), cfg-aware.
export function stagePopulations(map, cfg = DEFAULTS) {
  let c = stageCache.get(map);
  if (c && c.cfg === cfg) return c.pops;
  const perM2 = cfg.population.perM2, mul = cfg.population.kindMul;
  const L = map.levels || [];
  const pops = new Array(Math.max(1, L.length)).fill(0);
  const boxes = L.map(l => polyBBox(l.p));
  for (const b of map.buildings) {
    const p = b.p;
    let sx = 0, sy = 0;
    for (let i = 0; i < p.length; i += 2) { sx += p[i]; sy += p[i + 1]; }
    const x = sx / (p.length / 2), y = sy / (p.length / 2);
    const pop = polyArea(p) * perM2 * (mul[b.k] ?? 1);
    let first = L.length ? L.length : 0;
    for (let k = 0; k < L.length; k++) {
      const bb = boxes[k];
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      if (pointInPoly(L[k].p, x, y)) { first = k; break; }
    }
    for (let k = first; k < pops.length; k++) pops[k] += pop;
    if (!L.length) pops[0] += pop;
  }
  stageCache.set(map, { cfg, pops });
  return pops;
}

export function stageCaps(map, stage, cfg = DEFAULTS, difficulty = 'normal', sandbox = false) {
  const C = stagePopulations(map, cfg)[Math.min(stage, (map.levels || []).length - 1)] || 0;
  const e = cfg.economy, d = cfg.difficulty[difficulty] || cfg.difficulty.normal;
  if (sandbox) return { C, money: e.sandboxMoney, sp: e.sandboxSP };
  return {
    C,
    money: Math.round((e.moneyBase + e.moneyMax * C / (C + e.moneyHalf)) * (d.moneyMul || 1)),
    sp: Math.max(0, Math.round((e.spBase + e.spPerLevel * stage + e.spPerSqrt10k * Math.floor(Math.sqrt(C / 10000))) * (d.spMul || 1))),
  };
}

export function abilitySpOf(abilities, cfg = DEFAULTS) {
  let s = 0;
  for (const id in abilities || {}) if (cfg.abilities[id]) s += (abilities[id] | 0) * cfg.abilities[id].sp;
  return s;
}

// Drops charges (most expensive first) until the loadout fits the SP cap; filters locked items.
export function fitLoadout(loadout, { spCap = Infinity, unlocked = null, cfg = DEFAULTS } = {}) {
  const ok = id => !unlocked || unlocked.has(id);
  const units = (loadout && loadout.units || []).slice(0, cfg.loadoutSlots || 7).map(u => (u && cfg.units[u] && ok(u) ? u : null));
  while (units.length && !units[units.length - 1]) units.pop();
  const abilities = {};
  for (const id in (loadout && loadout.abilities) || {}) if (cfg.abilities[id] && ok(id) && loadout.abilities[id] > 0) abilities[id] = loadout.abilities[id] | 0;
  let sp = abilitySpOf(abilities, cfg);
  const order = Object.keys(abilities).sort((a, b) => cfg.abilities[b].sp - cfg.abilities[a].sp);
  while (sp > spCap && order.length) {
    const id = order[0];
    abilities[id]--;
    sp -= cfg.abilities[id].sp;
    if (abilities[id] <= 0) { delete abilities[id]; order.shift(); }
  }
  return { units, abilities };
}

// factor: the big-sheet thinning from popLimit(map, cfg) (1 = none).
export function civEstimate(C, popScale, cfg = DEFAULTS, factor = 1) {
  const n = Math.round(C * popScale * factor);
  return { n: Math.min(n, cfg.sim.maxAgents), capped: n > cfg.sim.maxAgents };
}

// What the final stage will hold: { n, capped, limited, factor, full } (full = people without the big-sheet limit).
export function crowdEstimate(map, popScale, cfg = DEFAULTS) {
  const lim = popLimit(map, cfg);
  const civ = civEstimate(lim.nominal, popScale, cfg, lim.factor);
  return { ...civ, limited: lim.limited, factor: lim.factor, full: Math.round(lim.nominal * popScale) };
}

// One line for size pickers: "8 km · about 140,000 residents at the final stage · population limited for speed".
export function crowdLine(map, popScale, cfg = DEFAULTS) {
  const c = crowdEstimate(map, popScale, cfg);
  const km = Math.max(map.w, map.h) / 1000;
  const parts = [`${km % 1 ? km.toFixed(1) : km} km`, `about ${fmtInt(roundSig(c.n))} residents at the final stage`];
  if (c.limited) parts.push('population limited for speed');
  else if (c.capped) parts.push('crowd capped');
  return parts.join(' · ');
}

const roundSig = n => (n >= 10000 ? Math.round(n / 1000) * 1000 : n >= 1000 ? Math.round(n / 100) * 100 : n);

export const WATER_LABEL = { none: 'Inland', river: 'River', coast: 'Coast', lake: 'Lake', islands: 'Islands' };

// ------------------------------------------------------------ minimap preview widget

// A canvas that draws a map's minimap with an optional stage outline. Returns { el, set(map, stage), redraw, destroy }.
export function mapPreview({ cls = '', label = '' } = {}) {
  const canvas = h('canvas.preview-canvas');
  const empty = h('div.preview-empty', h('span.label', label || 'No map selected'));
  const el = h('div.preview' + (cls ? '.' + cls : ''), canvas, empty);
  let map = null, stage = null, raf = 0;
  const draw = () => {
    raf = 0;
    if (!el.isConnected) return;
    empty.hidden = !!map;
    canvas.hidden = !map;
    if (!map) return;
    const { ctx, w, h: hh } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, hh);
    try { drawMinimap(ctx, map, w, hh, { palette: gamePalette(map), stage: stage ?? undefined, grid: null }); } catch (e) { console.error('[preview] draw failed', e); }
  };
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(redraw) : null;
  if (ro) ro.observe(el);
  return {
    el, redraw,
    set(m, s = null) { map = m; stage = s; redraw(); },
    setStage(s) { stage = s; redraw(); },
    setLoading(text) { map = null; empty.firstChild.textContent = text; empty.classList.add('is-busy'); redraw(); },
    setEmpty(text) { map = null; empty.firstChild.textContent = text || label || 'No map selected'; empty.classList.remove('is-busy'); redraw(); },
    get map() { return map; },
    destroy() { if (ro) ro.disconnect(); cancelAnimationFrame(raf); },
  };
}

// Small ledger of map facts.
export function mapFacts(map, stats) {
  const s = stats || {};
  return h('div.facts',
    h('div.kv', h('span', 'Sheet'), h('i'), h('b', `${(map.w / 1000).toFixed(1)} × ${(map.h / 1000).toFixed(1)} km`)),
    h('div.kv', h('span', 'Stages'), h('i'), h('b', String(map.levels.length))),
    h('div.kv', h('span', 'Buildings'), h('i'), h('b', fmtInt(map.buildings.length))),
    h('div.kv', h('span', 'Residents'), h('i'), h('b', fmtInt(s.nominalPop ?? stagePopulations(map).at(-1)))),
    s.bridges !== undefined ? h('div.kv', h('span', 'Bridges'), h('i'), h('b', String(s.bridges))) : null);
}
