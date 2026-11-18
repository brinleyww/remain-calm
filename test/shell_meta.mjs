// Node tests for the shell's DOM-free logic: settings, progress, achievements, mutator validation, map facts.
// Run: node test/shell_meta.mjs
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('FAIL', msg); } };

// a player saved the old default population scale (0.35) before v2: it moves to the new default
store.set('remain-calm.settings.v1', JSON.stringify({ popScale: 0.35, volume: 0.4 }));
const S = await import('../js/meta/settings.js');
ok(S.getSettings().popScale === 1 && S.getSettings().volume === 0.4, 'old default population scale migrates to 1');
store.set('remain-calm.settings.v1', JSON.stringify({ popScale: 0.35, popV: 2 }));
ok((await import('../js/meta/settings.js?chosen')).getSettings().popScale === 0.35, 'a 0.35 chosen after v2 stays');
store.set('remain-calm.settings.v1', JSON.stringify({ popScale: 0.6 }));
ok((await import('../js/meta/settings.js?custom')).getSettings().popScale === 0.6, 'a custom old scale stays');
store.clear();
const P = await import('../js/meta/progress.js');
const A = await import('../js/meta/achievements.js');
const M = await import('../js/ui/mutators.js');
const I = await import('../js/ui/mapinfo.js');
const G = await import('../js/ui/gen.js');
const { CAMPAIGN, campaignMapKey } = await import('../js/map/campaign.js');
const { DEFAULTS, MUTATOR_PRESETS, makeConfig } = await import('../js/data/config.js');
const { generateCity } = await import('../js/map/citygen.js');

// ---------------- settings
ok(S.eventToKey({ code: 'Digit1', shiftKey: true }) === 'Shift+Digit1', 'eventToKey shift');
ok(S.eventToKey({ code: 'ShiftLeft', shiftKey: true }) === '', 'modifier alone ignored');
ok(S.actionsForEvent({ code: 'KeyB' }).includes('zone'), 'B is zone');
ok(S.actionsForEvent({ code: 'Digit1', shiftKey: true }).includes('ability1'), 'Shift+1 ability 1');
ok(S.actionsForEvent({ code: 'KeyW', shiftKey: true }).includes('panUp'), 'pan matches with modifiers');
ok(S.findConflicts('KeyD', 'detonate').length === 0, 'detonate shares D with pan right');
let r = S.bindKey('wall', 0, 'KeyB');
ok(r.ok && r.moved.includes('zone') && S.keysFor('zone').length === 0 && S.keysFor('wall')[0] === 'KeyB', 'conflict moves binding');
ok(!S.bindKey('cancel', 0, 'KeyQ').ok, 'cancel is fixed');
ok(!S.bindKey('zone', 0, 'Escape').ok, 'Escape reserved');
S.resetSettings('keys');
ok(S.keysFor('zone')[0] === 'KeyB' && S.keysFor('wall')[0] === 'KeyN', 'reset keys');
S.updateSettings({ popScale: 5, uiScale: 0.1, palette: 'bogus' });
ok(S.getSettings().popScale === 2 && S.getSettings().uiScale === 0.8 && S.getSettings().palette === 'auto', 'settings are clamped');
ok(S.popScaleMutator(0.5) === 'population.scale=0.5', 'pop scale line');
ok(S.keyLabel('Ctrl+KeyZ') === 'Ctrl + Z' && S.keyLabel('Shift+Digit3') === 'Shift + 3', 'key labels');
S.resetSettings();

// ---------------- progress + campaign unlocks
P.resetProgress();
ok(P.cityUnlocked('millbrook') && !P.cityUnlocked('port-ashby'), 'only first city open');
ok(!P.isUnlocked('spikes') && P.isUnlocked('garrison'), 'start items');
ok(P.stageAvailable('millbrook', 0) && !P.stageAvailable('millbrook', 1), 'stage gating');
let res = P.recordResult({ mapKey: campaignMapKey('millbrook'), stage: 0, difficulty: 'normal', pct: 20, badge: 'gold', lost: false });
ok(res.improved && res.firstClear && res.newUnlocks.includes('spikes'), 'clearing stage 1 issues spikes');
ok(P.stageAvailable('millbrook', 1), 'next stage opens');
res = P.recordResult({ mapKey: campaignMapKey('millbrook'), stage: 0, difficulty: 'normal', pct: 10, badge: 'silver', lost: false });
ok(!res.improved && P.bestRecord(campaignMapKey('millbrook'), 0).badge === 'gold', 'worse result keeps best');
res = P.recordResult({ mapKey: campaignMapKey('millbrook'), stage: 1, difficulty: 'normal', pct: 2, lost: true });
ok(P.getRecord(campaignMapKey('millbrook'), 'normal', 1).losses === 1 && !P.stageCleared(campaignMapKey('millbrook'), 1), 'loss recorded, not cleared');
for (let k = 1; k < 4; k++) res = P.recordResult({ mapKey: campaignMapKey('millbrook'), stage: k, difficulty: 'normal', pct: 12, badge: 'bronze' });
ok(res.cityCleared && res.nextCityUnlocked && res.nextCityUnlocked.id === 'port-ashby', 'city cleared opens next city');
ok(P.cityUnlocked('port-ashby') && P.maxUpgradeLevel() === 3, 'upgrade tier III after Millbrook');
ok(!P.difficultyUnlocked('hardcore', true) && P.difficultyUnlocked('hardcore', false), 'hardcore gating');
ok(P.markFlawless('millbrook', 'normal') && !P.markFlawless('millbrook', 'normal') && P.isFlawless('millbrook'), 'flawless once');
const lo = P.defaultLoadout();
ok(lo.units.length <= 7 && lo.units[0] === 'garrison' && lo.units.includes('spikes'), 'default loadout uses unlocked items');
P.setLoadout({ units: ['garrison', 'bogus', 'nuke'], abilities: { nuke: 2, paratroopers: 1, bad: 3 } });
const got = P.getLoadout();
ok(got.units[1] === null && got.units[2] === null && got.abilities.nuke === 2 && !('bad' in got.abilities), 'loadout sanitised');
P.unlockAll(true);
ok(P.cityUnlocked('new-corrigan') && P.isUnlocked('nuke') && P.difficultyUnlocked('ultra', true), 'unlock all');
P.unlockAll(false);

// ---------------- achievements
const before = A.achievementCount().awarded;
let aw = A.evaluateResult({ won: true, badge: 'gold', pct: 30, difficulty: 'normal', spent: 100, budget: 2000, evacuated: 320 }, { mode: 'campaign', source: 'gen', cityCleared: true });
const ids = aw.map(a => a.id);
ok(ids.includes('first-response') && ids.includes('by-the-book') && ids.includes('orderly-exit') && ids.includes('city-secured') && ids.includes('thrift'), 'result awards');
ok(A.evaluateResult({ won: true, badge: 'gold' }, { mode: 'campaign' }).length === 0, 'no double award');
ok(A.evaluateResult({ won: true, badge: 'diamond' }, { mode: 'sandbox' }).length === 0, 'sandbox awards nothing');
ok(A.ACHIEVEMENTS.length === 14 && A.achievementCount().awarded > before, '14 achievements');

// ---------------- mutator validation
const v = M.validateMutatorText(['# comment', 'zombie.speed=4', 'zombie.sped=4', 'economy.moneyMax=lots', 'mutation.intervalSec=[1,2]', 'zombie=3', 'units.garrison.cost=40', 'nonsense'].join('\n'));
ok(v[0].kind === 'skip' && v[1].kind === 'ok', 'comment skipped, valid ok');
ok(v[2].kind === 'error' && /speed/.test(v[2].msg), 'typo suggestion');
ok(v[3].kind === 'error' && v[4].kind === 'ok', 'number check + list ok');
ok(v[5].kind === 'error' && v[6].kind === 'warn' && v[7].kind === 'error', 'group / formula / malformed');
ok(M.cleanMutatorLines('zombie.speed=4\nbad.key=1').length === 1, 'clean lines drop errors');
for (const p of Object.values(MUTATOR_PRESETS)) ok(M.validateMutatorText(p.lines.join('\n')).every(x => x.kind !== 'error'), 'preset valid: ' + p.name);

// ---------------- map facts
const map = generateCity({ seed: 7, sizeKm: 1.2, water: 'river', stages: 4 });
const pops = I.stagePopulations(map);
ok(pops.length === 4 && pops[0] > 0 && pops.every((x, i) => i === 0 || x >= pops[i - 1]), 'stage populations nested');
const caps = I.stageCaps(map, 0, DEFAULTS, 'normal');
ok(caps.money > DEFAULTS.economy.moneyBase && caps.sp >= DEFAULTS.economy.spBase, 'stage caps');
const fit = I.fitLoadout({ units: ['garrison', 'nuke'], abilities: { nuke: 1, paratroopers: 2 } }, { spCap: 2, unlocked: new Set(['garrison', 'paratroopers']) });
ok(fit.units.length === 1 && !fit.abilities.nuke && fit.abilities.paratroopers === 2, 'fit loadout');
const fit2 = I.fitLoadout({ units: [], abilities: { airstrike: 3, paratroopers: 1 } }, { spCap: 3, cfg: makeConfig([]) });
ok(I.abilitySpOf(fit2.abilities) <= 3, 'fit drops expensive charges first');
ok(I.mapKeyFor(map) === I.mapKeyFor(generateCity({ seed: 7, sizeKm: 1.2, water: 'river', stages: 4 })), 'map key stable');

// ---------------- daily spec
const d1 = G.dailySpec(20261117, MUTATOR_PRESETS), d2 = G.dailySpec(20261117, MUTATOR_PRESETS), d3 = G.dailySpec(20261118, MUTATOR_PRESETS);
ok(JSON.stringify(d1) === JSON.stringify(d2), 'daily deterministic');
ok(d1.mutators.length === 2 && d1.mutators[0] !== d1.mutators[1], 'two distinct mutators');
ok(JSON.stringify(d1.opts) !== JSON.stringify(d3.opts) || d1.mutators.join() !== d3.mutators.join(), 'days differ');
ok(G.todayKey(new Date(2026, 10, 7)) === 20261107 && G.dateFromKey(20261107).getDate() === 7, 'date keys');

console.log(`shell_meta: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
