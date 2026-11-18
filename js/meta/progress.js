// Local progress (localStorage): per map / stage / difficulty records, campaign unlocks, Flawless marks,
// the saved loadout, lifetime totals and awarded achievements.
import { DEFAULTS } from '../data/config.js';
import { CAMPAIGN, campaignMapKey, unlockedItems, getCampaignCity, ALL_ITEMS } from '../map/campaign.js';

const KEY = 'remain-calm.progress.v1';
export const DIFFICULTIES = ['normal', 'hardcore', 'ultra'];
export const BADGE_ORDER = DEFAULTS.badges.map(b => b.id);
export const badgeRank = b => (b ? BADGE_ORDER.indexOf(b) : -1);
export const betterBadge = (a, b) => (badgeRank(a) >= badgeRank(b) ? a : b);

const listeners = new Set();
let state = load();
let unlockCache = null;

function fresh() {
  return {
    v: 1,
    records: {},      // mapKey -> difficulty -> stageIdx -> { pct, badge, wins, losses, at }
    maps: {},         // mapKey -> { name, source, stages }
    flawless: {},     // cityId -> { difficulty: timestamp }
    unlockAll: false,
    loadout: null,    // { units: [7], abilities: { id: n } }
    totals: { wins: 0, losses: 0, kills: 0, saved: 0, evacuated: 0, stagesPlayed: 0, dailies: 0 },
    achievements: {}, // id -> timestamp
    last: null,       // { mode, cityId, stage, difficulty, mapKey, at }
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== 1) return fresh();
    const s = fresh();
    for (const k of Object.keys(s)) if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
    s.totals = { ...fresh().totals, ...(raw.totals || {}) };
    return s;
  } catch (e) { return fresh(); }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* keep in memory */ }
}

function changed(what) {
  unlockCache = null;
  save();
  for (const fn of [...listeners]) { try { fn(state, what); } catch (e) { console.error('[progress] listener failed', e); } }
}

export function onProgressChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// The live progress object; read-only for callers.
export function getProgress() { return state; }

export function resetProgress() {
  state = fresh();
  changed('reset');
}

// ------------------------------------------------------------ records

export function getRecord(mapKey, difficulty, stage) {
  const m = state.records[mapKey];
  return (m && m[difficulty] && m[difficulty][stage]) || null;
}

// Best record for a stage over every difficulty (badge rank first, then %).
export function bestRecord(mapKey, stage, difficulty = null) {
  const m = state.records[mapKey];
  if (!m) return null;
  let best = null;
  for (const d of difficulty ? [difficulty] : DIFFICULTIES) {
    const r = m[d] && m[d][stage];
    if (!r) continue;
    if (!best || badgeRank(r.badge) > badgeRank(best.badge) || (badgeRank(r.badge) === badgeRank(best.badge) && r.pct > best.pct)) best = { ...r, difficulty: d };
  }
  return best;
}

export function stageCleared(mapKey, stage, difficulty = null) {
  const r = bestRecord(mapKey, stage, difficulty);
  return !!(r && r.badge);
}

// Stores a stage outcome. Returns what changed so the shell can announce it.
export function recordResult({ mapKey, stage, difficulty = 'normal', pct = 0, badge = null, lost = false, name, source, stages, kills = 0, saved = 0, evacuated = 0 }) {
  if (!mapKey) return { improved: false, newUnlocks: [] };
  difficulty = DIFFICULTIES.includes(difficulty) ? difficulty : 'normal';
  stage = Math.max(0, stage | 0);
  pct = Number.isFinite(+pct) ? Math.max(0, Math.min(100, +pct)) : 0;
  if (badge && badgeRank(badge) < 0) badge = null;
  const before = unlockedSet();
  const cityId = mapKey.startsWith('campaign:') ? mapKey.slice(9) : null;
  const wasCityCleared = cityId ? cityCleared(cityId) : false;
  const wasCampaignDone = campaignComplete();

  const byMap = state.records[mapKey] || (state.records[mapKey] = {});
  const byDiff = byMap[difficulty] || (byMap[difficulty] = {});
  const prev = byDiff[stage] || null;
  const rec = prev ? { ...prev } : { pct: 0, badge: null, wins: 0, losses: 0, at: 0 };
  const won = !lost;
  let improved = false;
  if (won) {
    rec.wins++;
    if (!prev || badgeRank(badge) > badgeRank(prev.badge) || (badgeRank(badge) === badgeRank(prev.badge) && pct > prev.pct)) {
      improved = true;
      rec.pct = pct; rec.badge = badge; rec.at = Date.now();
    }
  } else rec.losses++;
  byDiff[stage] = rec;
  if (name || source) state.maps[mapKey] = { name: name || (state.maps[mapKey] && state.maps[mapKey].name) || mapKey, source: source || '', stages: stages || 0 };

  const t = state.totals;
  t.stagesPlayed++;
  if (won) t.wins++; else t.losses++;
  t.kills += Math.max(0, kills | 0);
  t.saved += Math.max(0, saved | 0);
  t.evacuated += Math.max(0, evacuated | 0);
  changed('record');

  const after = unlockedSet();
  const newUnlocks = [...after].filter(id => !before.has(id));
  const cityNow = cityId ? cityCleared(cityId) : false;
  return {
    record: rec, previous: prev, improved, firstClear: won && !!badge && !(prev && prev.badge),
    newUnlocks,
    cityCleared: cityNow && !wasCityCleared,
    campaignComplete: campaignComplete() && !wasCampaignDone,
    nextCityUnlocked: cityNow && !wasCityCleared ? (CAMPAIGN[getCampaignCity(cityId).index + 1] || null) : null,
  };
}

export function recordMapInfo(mapKey, info) {
  state.maps[mapKey] = { ...(state.maps[mapKey] || {}), ...info };
  save();
}

// ------------------------------------------------------------ campaign

export const clearedCampaignStage = (cityId, stage) => stageCleared(campaignMapKey(cityId), stage);

export function cityCleared(cityId) {
  const c = getCampaignCity(cityId);
  if (!c) return false;
  for (let k = 0; k < c.stages; k++) if (!clearedCampaignStage(cityId, k)) return false;
  return true;
}

export function cityUnlocked(cityId) {
  if (state.unlockAll) return true;
  const c = getCampaignCity(cityId);
  if (!c) return false;
  return c.index === 0 || cityCleared(CAMPAIGN[c.index - 1].id);
}

// A stage can be started when it is the first one or the stage before it is cleared.
export function stageAvailable(cityId, stage) {
  if (!cityUnlocked(cityId)) return false;
  return state.unlockAll || stage === 0 || clearedCampaignStage(cityId, stage - 1);
}

export function campaignComplete() { return CAMPAIGN.every(c => cityCleared(c.id)); }

// Hardcore and Ultra open on campaign maps after the whole campaign; custom maps have them from the start.
export function difficultyUnlocked(difficulty, campaign = true) {
  if (difficulty === 'normal' || !campaign) return true;
  return state.unlockAll || campaignComplete();
}

export function campaignSummary() {
  let stages = 0, cleared = 0, cities = 0;
  for (const c of CAMPAIGN) {
    stages += c.stages;
    for (let k = 0; k < c.stages; k++) if (clearedCampaignStage(c.id, k)) cleared++;
    if (cityCleared(c.id)) cities++;
  }
  return { stages, cleared, cities, total: CAMPAIGN.length };
}

export function markFlawless(cityId, difficulty) {
  const f = state.flawless[cityId] || (state.flawless[cityId] = {});
  const isNew = !f[difficulty];
  if (isNew) { f[difficulty] = Date.now(); changed('flawless'); }
  return isNew;
}
export function flawlessFor(cityId) { return state.flawless[cityId] || {}; }
export function isFlawless(cityId, difficulty = null) {
  const f = state.flawless[cityId];
  return !!f && (difficulty ? !!f[difficulty] : Object.keys(f).length > 0);
}

// ------------------------------------------------------------ unlocks

export function unlockedSet() {
  if (!unlockCache) unlockCache = state.unlockAll ? new Set(ALL_ITEMS) : unlockedItems(clearedCampaignStage);
  return unlockCache;
}
export function isUnlocked(id) { return unlockedSet().has(id); }
export function unlockAll(flag = true) { state.unlockAll = !!flag; changed('unlockAll'); }

// Highest unit upgrade level allowed: 2 base, 3-5 by campaign unlocks.
export function maxUpgradeLevel(set = unlockedSet()) {
  let lv = 2;
  for (const n of [3, 4, 5]) if (set.has('upgrade' + n)) lv = n; else break;
  return lv;
}

// ------------------------------------------------------------ loadout

export function defaultLoadout(unlocked = unlockedSet()) {
  const order = ['garrison', 'sniper', 'turret', 'mortar', 'spikes', 'mine', 'gasMortar', 'c4', 'battleship', 'fireMortar', 'chemical', 'oil', 'napalm', 'mlrs', 'howitzer', 'railgun'];
  const units = order.filter(u => unlocked.has(u) && DEFAULTS.units[u]).slice(0, DEFAULTS.loadoutSlots);
  const abilities = unlocked.has('paratroopers') ? { paratroopers: 1 } : {};
  return { units, abilities };
}

export function getLoadout() {
  const l = state.loadout;
  if (!l || !Array.isArray(l.units)) return defaultLoadout();
  return { units: l.units.slice(0, DEFAULTS.loadoutSlots), abilities: { ...(l.abilities || {}) } };
}

export function setLoadout(l) {
  if (!l) return;
  const units = (Array.isArray(l.units) ? l.units : []).slice(0, DEFAULTS.loadoutSlots).map(u => (u && DEFAULTS.units[u] ? u : null));
  const abilities = {};
  for (const id in l.abilities || {}) if (DEFAULTS.abilities[id] && (l.abilities[id] | 0) > 0) abilities[id] = l.abilities[id] | 0;
  state.loadout = { units, abilities };
  changed('loadout');
}

// ------------------------------------------------------------ misc

export function setLastPlayed(info) { state.last = { ...info, at: Date.now() }; save(); }
export function getLastPlayed() { return state.last; }

export function awardAchievement(id) {
  if (state.achievements[id]) return false;
  state.achievements[id] = Date.now();
  changed('achievement');
  return true;
}
export function achievementAwarded(id) { return state.achievements[id] || 0; }

export function bumpTotal(key, n = 1) { state.totals[key] = (state.totals[key] || 0) + n; save(); }
