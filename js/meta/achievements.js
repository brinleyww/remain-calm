// Fourteen commendations, evaluated from stage results and shell-level events (city cleared, Flawless, ...).
import { getProgress, awardAchievement, achievementAwarded, badgeRank, campaignSummary } from './progress.js';

// test(result, ctx) -> bool. ctx: { mode, source, difficulty, cityCleared, campaignComplete, flawless }.
// progress(p) -> [current, goal] for the screen's progress line.
export const ACHIEVEMENTS = [
  { id: 'first-response', name: 'First Response', desc: 'Win any stage.', no: '01',
    test: r => r.won },
  { id: 'by-the-book', name: 'By the Book', desc: 'Earn a gold badge or better.', no: '02',
    test: r => r.won && badgeRank(r.badge) >= badgeRank('gold') },
  { id: 'diamond-standard', name: 'Diamond Standard', desc: 'Earn a diamond badge.', no: '03',
    test: r => r.won && r.badge === 'diamond' },
  { id: 'city-secured', name: 'City Secured', desc: 'Clear every stage of a campaign city.', no: '04',
    test: (r, c) => !!c.cityCleared,
    progress: () => { const s = campaignSummary(); return [Math.min(1, s.cities), 1]; } },
  { id: 'regional-command', name: 'Regional Command', desc: 'Clear all six campaign cities.', no: '05',
    test: (r, c) => !!c.campaignComplete,
    progress: () => { const s = campaignSummary(); return [s.cities, s.total]; } },
  { id: 'clean-record', name: 'Clean Record', desc: 'Finish a campaign city without losing or retrying a stage.', no: '06',
    test: (r, c) => !!c.flawless },
  { id: 'hard-line', name: 'Hard Line', desc: 'Win a stage on Hardcore or Ultra.', no: '07',
    test: r => r.won && (r.difficulty === 'hardcore' || r.difficulty === 'ultra') },
  { id: 'orderly-exit', name: 'Orderly Exit', desc: 'Evacuate 300 civilians in a single stage.', no: '08',
    test: r => (r.evacuated | 0) >= 300 },
  { id: 'attrition-ledger', name: 'Attrition Ledger', desc: 'Destroy 10,000 infected in total.', no: '09',
    test: () => getProgress().totals.kills >= 10000,
    progress: p => [Math.min(10000, p.totals.kills | 0), 10000] },
  { id: 'quarantine-line', name: 'Quarantine Line', desc: 'Win a stage because the remaining infected are cut off.', no: '10',
    test: r => r.won && !!r.softlock },
  { id: 'thrift', name: 'Thrift', desc: 'Win a stage after spending under a quarter of the budget.', no: '11',
    test: (r, c) => r.won && c.mode !== 'sandbox' && r.budget > 0 && r.spent < r.budget * 0.25 },
  { id: 'local-knowledge', name: 'Local Knowledge', desc: 'Win a stage on an imported real place.', no: '12',
    test: (r, c) => r.won && c.source === 'osm' },
  { id: 'morning-edition', name: 'Morning Edition', desc: 'Win a stage of the daily challenge.', no: '13',
    test: (r, c) => r.won && c.mode === 'daily' },
  { id: 'joint-operation', name: 'Joint Operation', desc: 'Win a stage in co-op.', no: '14',
    test: (r, c) => r.won && c.mode === 'coop' },
];
const BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));

const pub = a => ({ id: a.id, name: a.name, desc: a.desc, no: a.no });

// Awards every achievement the result earns. Returns the newly awarded ones.
export function evaluateResult(result, ctx = {}) {
  if (!result || ctx.mode === 'test' || ctx.mode === 'sandbox') return [];
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (achievementAwarded(a.id)) continue;
    let ok = false;
    try { ok = !!a.test(result, ctx); } catch (e) { ok = false; }
    if (ok && awardAchievement(a.id)) out.push(pub(a));
  }
  return out;
}

// Shell events outside a stage result (e.g. 'flawless', 'cityCleared'); same rules as evaluateResult.
export function evaluateEvent(name, data = {}) {
  return evaluateResult({ won: false, ...data.result }, { ...data, [name]: true });
}

export function getAchievements() {
  const p = getProgress();
  return ACHIEVEMENTS.map(a => ({ ...pub(a), awarded: achievementAwarded(a.id) || 0, progress: a.progress ? a.progress(p) : null }));
}

export function achievementCount() {
  let n = 0;
  for (const a of ACHIEVEMENTS) if (achievementAwarded(a.id)) n++;
  return { awarded: n, total: ACHIEVEMENTS.length };
}

export const getAchievement = id => (BY_ID.has(id) ? pub(BY_ID.get(id)) : null);
