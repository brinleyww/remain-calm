// Boot + screen manager: hash-routed menu screens, session launch and return, results -> progress.
import { applyDisplaySettings, onSettingsChange, popScaleMutator, gamePalette } from './meta/settings.js';
import {
  recordResult, unlockedSet, maxUpgradeLevel, setLoadout, getLoadout, setLastPlayed, markFlawless, getProgress,
} from './meta/progress.js';
import { evaluateResult } from './meta/achievements.js';
import { ALL_ITEMS, campaignMapKey, getCampaignCity } from './map/campaign.js';
import { DEFAULTS, makeConfig } from './data/config.js';
import { h, clear, toast, alertModal, modalOpen, primeAudio, sfx } from './ui/dom.js';
import { itemName } from './ui/names.js';
import { mapKeyFor, fitLoadout, stageCaps } from './ui/mapinfo.js';

const SCREENS = {
  title: () => import('./ui/title.js'),
  campaign: () => import('./ui/campaign.js'),
  freeplay: () => import('./ui/freeplay.js'),
  daily: () => import('./ui/daily.js'),
  library: () => import('./ui/library.js'),
  settings: () => import('./ui/settings_screen.js'),
  achievements: () => import('./ui/achievements_screen.js'),
  credits: () => import('./ui/credits.js'),
  editor: async () => ({ mount: mountEditor }),
  coop: async () => ({ mount: mountCoop }),
};

const appEl = document.getElementById('app');
let current = null;       // { name, params, api }
let showSeq = 0;
let pendingParams = null; // non-serialisable params for the next screen
let game = null;          // { session, root, opts, run }

// ------------------------------------------------------------ routing

function parseHash() {
  const m = /^#\/?([a-z]*)(?:\?(.*))?$/.exec(location.hash || '');
  const name = m && SCREENS[m[1]] ? m[1] : 'title';
  const params = {};
  if (m && m[2]) for (const [k, v] of new URLSearchParams(m[2])) params[k] = v;
  return { name, params };
}

function hashFor(name, params = {}) {
  const q = new URLSearchParams();
  for (const k in params) { const v = params[k]; if (typeof v === 'string' || typeof v === 'number') q.set(k, String(v)); }
  const qs = q.toString();
  return '#/' + (name === 'title' ? '' : name) + (qs ? '?' + qs : '');
}

function go(name, params = {}, { replace = false } = {}) {
  if (!SCREENS[name]) name = 'title';
  pendingParams = { name, params };
  const hash = hashFor(name, params);
  if (location.hash === hash || (hash === '#/' && !location.hash) || replace) {
    pendingParams = null;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    show(name, params);
    return;
  }
  else location.hash = hash; // hashchange -> show
}

window.addEventListener('hashchange', () => {
  if (game) return;
  const { name, params } = parseHash();
  const p = pendingParams && pendingParams.name === name ? { ...params, ...pendingParams.params } : params;
  pendingParams = null;
  show(name, p);
});

async function show(name, params = {}) {
  const seq = ++showSeq;
  if (current && current.api && current.api.destroy) { try { current.api.destroy(); } catch (e) { console.error(e); } }
  current = null;
  clear(appEl);
  appEl.dataset.screen = name;
  window.scrollTo(0, 0);
  let mod;
  try { mod = await SCREENS[name](); } catch (e) {
    console.error(e);
    if (seq !== showSeq) return;
    appEl.appendChild(failCard(`The ${name} screen failed to load.`, e));
    current = { name, params, api: null };
    return;
  }
  if (seq !== showSeq) return;
  try {
    const api = (await mod.mount(appEl, app, params || {})) || {};
    if (seq !== showSeq) { if (api.destroy) api.destroy(); return; }
    current = { name, params, api };
  } catch (e) {
    console.error(e);
    clear(appEl);
    appEl.appendChild(failCard(`The ${name} screen could not be opened.`, e));
    current = { name, params, api: null };
  }
}

function failCard(msg, err) {
  return h('section.screen.fail-screen',
    h('div.card.raised.fail-card',
      h('div.card-head', h('h2.card-title', 'Filing error'), h('span.card-no', 'OCP-500')),
      h('p', msg),
      h('pre.fail-detail', String((err && err.message) || err || '')),
      h('button.btn', { type: 'button', onclick: () => go('title') }, 'Back to directory')));
}

// ------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  primeAudio();
  if (game || modalOpen() || e.defaultPrevented) return;
  const api = current && current.api;
  if (api && api.ownsKeys) return;
  if (api && api.onKey && api.onKey(e)) { e.preventDefault(); return; }
  if (e.key === 'Escape' && current && current.name !== 'title') {
    e.preventDefault();
    sfx.page();
    go(api && api.backTo ? api.backTo : 'title');
  }
});
document.addEventListener('pointerdown', primeAudio, { passive: true });

// ------------------------------------------------------------ session launch

let gameCssReady = null;
function ensureGameCss() {
  if (gameCssReady) return gameCssReady;
  gameCssReady = new Promise((res) => {
    if (document.querySelector('link[data-game-css]')) return res();
    const link = h('link', { rel: 'stylesheet', href: 'css/game.css', 'data-game-css': '1' });
    link.onload = () => res();
    link.onerror = () => { link.remove(); res(); };
    document.head.appendChild(link);
  });
  return gameCssReady;
}

// opts: { map, mode, difficulty, mutators, loadout, cityId, startStage, net, owner, mapKey, returnTo: [screen, params], keepScreen }
// keepScreen leaves the current screen mounted (hidden) and calls its resume() when the session ends.
let launching = false;
async function launch(opts) {
  if (game || launching) return false;
  launching = true;
  try { return await launchNow(opts); } finally { launching = false; }
}

async function launchNow(opts) {
  const mode = opts.mode || 'free';
  const map = opts.map;
  if (!map) { await alertModal({ title: 'No map', message: 'Choose or generate a map first.' }); return false; }
  let mod;
  try {
    [mod] = await Promise.all([import('./game/session.js'), ensureGameCss()]);
    if (!mod || typeof mod.Session !== 'function') throw new Error('session.js has no Session export');
  } catch (e) {
    console.error(e);
    await alertModal({ title: 'Field console unavailable', no: 'OCP-503',
      message: h('div', h('p', 'The battle screen could not be loaded, so the exercise cannot start.'), h('pre.fail-detail', String(e.message || e))) });
    return false;
  }
  const sandbox = mode === 'sandbox';
  const unlocked = sandbox || mode === 'test' ? new Set(ALL_ITEMS) : unlockedSet();
  const difficulty = opts.difficulty || 'normal';
  const startStage = Math.max(0, opts.startStage | 0);
  const userLines = (opts.mutators || []).filter(Boolean);
  const mutators = mode === 'coop' ? userLines : [popScaleMutator(), ...userLines];
  const cfg = makeConfig(mutators, { difficulty, sandbox });
  const caps = stageCaps(map, startStage, cfg, difficulty, sandbox);
  const loadout = fitLoadout(opts.loadout || getLoadout(), { spCap: caps.sp, unlocked, cfg });
  const mapKey = opts.mapKey || (opts.cityId ? campaignMapKey(opts.cityId) : mapKeyFor(map));

  const kept = opts.keepScreen && current ? current : null;
  if (!kept) {
    if (current && current.api && current.api.destroy) { try { current.api.destroy(); } catch (e) { console.error(e); } }
    current = null;
    clear(appEl);
  }
  appEl.hidden = true;
  const root = h('div#game.game-root');
  document.body.appendChild(root);
  document.body.classList.add('in-game');
  game = { root, session: null, kept, opts: { ...opts, mode, difficulty, mapKey, startStage, unlocked }, run: { clean: true, lastStage: startStage - 1, startStage } };
  if (mode === 'campaign' || mode === 'free' || mode === 'daily') setLastPlayed({ mode, cityId: opts.cityId || null, stage: startStage, difficulty, mapKey });

  try {
    const session = new mod.Session(root, {
      map, mode, difficulty, mutators, loadout, startStage, net: opts.net, owner: opts.owner, makeDriver: opts.makeDriver,
      mapKey: mode === 'sandbox' || mode === 'test' ? null : mapKey,
      campaign: opts.cityId ? { cityId: opts.cityId } : undefined,
      sandbox, unlocked: [...unlocked], maxUpgradeLevel: sandbox || mode === 'test' ? 5 : maxUpgradeLevel(unlocked),
      palette: gamePalette(map),
      onStageResult: (r) => handleResult(r),
      onExit: (summary) => endSession(summary),
      openLoadout: (world, done) => openGameLoadout(world, done),
      openSettings: (done) => openGameSettings(done),
    });
    game.session = session;
    await session.start();
  } catch (e) {
    console.error(e);
    const keptScreen = game && game.kept;
    teardownGame();
    await alertModal({ title: 'Exercise aborted', no: 'OCP-504', message: h('div', h('p', 'The battle screen failed while starting.'), h('pre.fail-detail', String(e.message || e))) });
    if (keptScreen) resumeKept(keptScreen); else restoreShell(opts.returnTo);
    return false;
  }
  return true;
}

function teardownGame() {
  if (!game) return;
  const g = game;
  game = null;
  try { if (g.session && g.session.destroy) g.session.destroy(); } catch (e) { console.error(e); }
  g.root.remove();
  document.body.classList.remove('in-game');
  if (window.__rc === g.session) window.__rc = undefined;
  appEl.hidden = false;
  applyDisplaySettings();
}

function restoreShell(returnTo) {
  const [name, params] = returnTo || ['title', {}];
  pendingParams = null;
  history.replaceState(null, '', hashFor(name, params || {}));
  show(name, params || {});
}

function resumeKept(kept) {
  if (current !== kept) return restoreShell(null);
  try { if (kept.api && kept.api.resume) kept.api.resume(); } catch (e) { console.error(e); }
}

function endSession() {
  const back = game && game.opts.returnTo;
  const kept = game && game.kept;
  teardownGame();
  if (kept) resumeKept(kept); else restoreShell(back);
}

function handleResult(result) {
  if (!game || !result) return null;
  const o = game.opts, run = game.run;
  const won = result.won !== undefined ? !!result.won : !result.lost;
  const stage = result.stage | 0;
  const out = { recorded: false, newUnlocks: [], achievements: [], improved: false, flawless: false };
  if (o.mode === 'sandbox' || o.mode === 'test') return out;

  if (stage <= run.lastStage || !won) run.clean = false;
  if (won) run.lastStage = Math.max(run.lastStage, stage);
  const rec = recordResult({
    mapKey: o.mapKey, stage, difficulty: o.difficulty, pct: result.pct, badge: won ? result.badge : null, lost: !won,
    name: o.map.name, source: o.map.source, stages: o.map.levels.length,
    kills: result.zombiesKilled, saved: result.saved, evacuated: result.evacuated,
  });
  out.recorded = true;
  out.improved = rec.improved;
  out.best = rec.record;
  out.newUnlocks = rec.newUnlocks;

  const lastStage = result.last !== undefined ? !!result.last : stage >= o.map.levels.length - 1;
  let flawless = false;
  if (o.mode === 'campaign' && won && lastStage && run.clean && run.startStage === 0 && o.cityId) flawless = markFlawless(o.cityId, o.difficulty);
  out.flawless = flawless;
  if (o.mode !== 'coop') setLastPlayed({ mode: o.mode, cityId: o.cityId || null, stage: won && !lastStage ? stage + 1 : stage, difficulty: o.difficulty, mapKey: o.mapKey });

  const ach = evaluateResult({ ...result, won, difficulty: o.difficulty }, {
    mode: o.mode, source: o.map.source, difficulty: o.difficulty,
    cityCleared: rec.cityCleared, campaignComplete: rec.campaignComplete, flawless,
  });
  out.achievements = ach;

  for (const id of rec.newUnlocks) toast({ kind: 'unlock', stamp: 'Issued', title: itemName(id), body: 'Now available in your loadout.' });
  if (rec.nextCityUnlocked) {
    toast({ kind: 'unlock', stamp: 'File open', title: rec.nextCityUnlocked.name, body: 'A new city is open on the regional map.' });
    if (o.mode === 'campaign') o.returnTo = ['campaign', { city: rec.nextCityUnlocked.id }];
  }
  if (flawless) toast({ kind: 'award', stamp: 'Flawless', title: getCampaignCity(o.cityId).name, body: 'Every stage held without a single loss.' });
  for (const a of ach) toast({ kind: 'award', stamp: 'Awarded', title: a.name, body: a.desc, ms: 6500 });
  return out;
}

async function openGameLoadout(world, done) {
  if (!game) return;
  const g = game;
  let mod;
  try { mod = await import('./ui/loadout.js'); } catch (e) { console.error(e); done(world.loadout); return; }
  const owners = world.owners || 1;
  const spCap = world.sandbox ? Infinity : owners > 1 ? Math.floor(world.sp.cap / owners) : world.sp.cap;
  mod.openLoadout(g.root, {
    world, unlocked: g.opts.unlocked, current: world.loadout, spCap, cfg: world.cfg,
    onDone: (l) => { if (l && g.opts.mode !== 'sandbox' && g.opts.mode !== 'test') setLoadout(l); done(l || null); },
  });
}

async function openGameSettings(done) {
  if (!game) return;
  try {
    const mod = await import('./ui/settings_screen.js');
    mod.openSettingsOverlay(game.root, { onClose: () => { if (done) done(); } });
  } catch (e) { console.error(e); if (done) done(); }
}

// Menu-side loadout editor: resolves with the new loadout or null.
function editLoadout({ map = null, stage = 0, cfg = DEFAULTS, difficulty = 'normal', sandbox = false } = {}) {
  return import('./ui/loadout.js').then(mod => new Promise(res => {
    const unlocked = sandbox ? new Set(ALL_ITEMS) : unlockedSet();
    const spCap = sandbox ? Infinity : map ? stageCaps(map, stage, cfg, difficulty).sp : null;
    mod.openLoadout(document.body, {
      unlocked, current: getLoadout(), spCap, cfg, note: map ? `Stage ${stage + 1} of ${map.name}` : '',
      onDone: (l) => { if (l) setLoadout(l); res(l || null); },
    });
  }));
}

// ------------------------------------------------------------ editor / co-op hosts (other owners' modules)

function unavailable(root, title, err) {
  const back = h('button.btn', { type: 'button', onclick: () => go('title') }, '← Back to directory');
  root.appendChild(h('section.screen.fail-screen',
    h('div.card.raised.fail-card',
      h('div.card-head', h('h2.card-title', title), h('span.card-no', 'OCP-503')),
      h('p', 'This desk is not staffed yet: its module failed to load.'),
      h('pre.fail-detail', String((err && err.message) || err || '')),
      back)));
  requestAnimationFrame(() => back.focus());
}

async function mountEditor(root, _app, params) {
  let mod;
  try {
    mod = await import('./ui/editor.js');
    if (typeof mod.openEditor !== 'function') throw new Error('editor.js has no openEditor export');
  } catch (e) { console.error(e); unavailable(root, 'Map editor', e); return {}; }
  const box = h('div.host-root.editor-host');
  root.appendChild(box);
  let ed = null;
  try {
    ed = mod.openEditor(box, {
      map: params.map || null,
      onExit: () => go('title'),
      onTestPlay: (map) => {
        const keep = !!(ed && ed.hide && ed.show);
        if (keep) ed.hide();
        launch({ map, mode: 'test', returnTo: ['editor', { map }], keepScreen: keep }).then(ok => { if (!ok && keep) ed.show(); });
      },
    });
  } catch (e) { console.error(e); clear(root); unavailable(root, 'Map editor', e); return {}; }
  return {
    ownsKeys: true,
    resume() { if (ed && ed.show) ed.show(); },
    destroy() { try { if (ed && ed.destroy) ed.destroy(); } catch (e) { console.error(e); } },
  };
}

async function mountCoop(root) {
  let mod;
  try {
    mod = await import('./ui/coop_lobby.js');
    if (typeof mod.openCoopLobby !== 'function') throw new Error('coop_lobby.js has no openCoopLobby export');
  } catch (e) { console.error(e); unavailable(root, 'Co-operative play', e); return {}; }
  const box = h('div.host-root.coop-host');
  root.appendChild(box);
  let lobby = null;
  try {
    lobby = mod.openCoopLobby(box, {
      onStart: ({ link, map, role, owner, difficulty, mutators, makeDriver } = {}) => launch({ map, mode: 'coop', net: link, role, owner, makeDriver, difficulty, mutators, returnTo: ['coop', {}] }),
      onExit: () => go('title'),
    });
  } catch (e) { console.error(e); clear(root); unavailable(root, 'Co-operative play', e); return {}; }
  return { ownsKeys: true, destroy() { try { if (lobby && lobby.destroy) lobby.destroy(); else if (lobby && lobby.close) lobby.close(); } catch (e) { console.error(e); } } };
}

// ------------------------------------------------------------ boot

export const app = {
  go, launch, editLoadout,
  get inGame() { return !!game; },
  get screen() { return current ? current.name : null; },
  progress: getProgress,
};

applyDisplaySettings();
onSettingsChange((s, changed) => { if (!game && changed.some(k => k === 'uiScale' || k === 'palette' || k === 'reduceMotion')) applyDisplaySettings(); });
window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('remain-calm.') && !game && current && current.name === 'title') show('title'); });

const first = parseHash();
show(first.name, first.params);
