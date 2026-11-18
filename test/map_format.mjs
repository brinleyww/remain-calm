// node test/map_format.mjs — MapData format, share codes, library (memory store), campaign unlock table.
import {
  T, BUILDING_KINDS, SPECIAL_KINDS, validateMap, normalizeMap, serializeMap, parseMap, mapStats, emptyMap,
  mergeHoles, clipLineRect, clipPolyRect, makeStages,
} from '../js/map/format.js';
import { encodeShareCode, decodeShareCode, toBase64Url, fromBase64Url } from '../js/util/compress.js';
import * as lib from '../js/map/library.js';
import { CAMPAIGN, getCampaignMap, unlocksFor, unlockSource, UPGRADE_TIERS, ALL_ITEMS, unlockedItems } from '../js/map/campaign.js';
import { generateCity } from '../js/map/citygen.js';
import { DEFAULTS } from '../js/data/config.js';
import { pointInPoly, polyArea } from '../js/util/geom.js';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.error('FAIL', msg); } };
const throws = (fn, re, msg) => { try { fn(); ok(false, msg + ' (no throw)'); } catch (e) { ok(re.test(e.message), msg + ' -> ' + e.message); } };
const rejects = async (p, re, msg) => { try { await p; ok(false, msg + ' (no reject)'); } catch (e) { ok(re.test(e.message), msg + ' -> ' + e.message); } };

// ---------------- format
ok(T.OPEN === 0 && T.RAIL === 7 && T.BRIDGE === 4, 'terrain codes');
ok(BUILDING_KINDS.length === 9 && SPECIAL_KINDS.join() === 'civic,trade,armory,rescue', 'kinds');
const e = emptyMap(1500, 1200, 'Blank');
ok(validateMap(e).ok && e.levels.length === 3 && e.w === 1500 && e.h === 1200, 'emptyMap valid with 3 auto stages');
const messy = normalizeMap({
  name: '  Messy  ', w: 1000, h: 1000, palette: 'neon', source: 'x', seed: '12',
  roads: [{ p: [0.04, 0.04, 100.06, 0.04], k: 'weird' }, { p: [5, 5] }, { p: [-100, 500, 1100, 500], k: 'major', w: 14 }],
  buildings: [{ p: [10, 10, 20, 10, 20, 20, 10, 20, 10, 10], k: 'nope' }, { p: [1, 1, 1.01, 1, 1, 1.01] }, { p: [990, 990, 1010, 990, 1010, 1010, 990, 1010], h: 5, k: 'civic', use: 'Police Station', __proto__: { evil: 1 } }],
  water: [{ p: [0, 0, 1, 0] }], parks: null, levels: [], spawns: [[5, 5], ['a', 2], [2000, 3]], extra: 'dropped',
});
ok(messy.name === 'Messy' && messy.palette === 'paper' && messy.source === 'editor' && messy.seed === 12, 'defaults filled');
ok(messy.roads.length === 2 && messy.roads[0].k === 'minor' && messy.roads[0].p[0] === 0 && messy.roads[0].p[2] === 100.1, 'roads normalised + rounded');
ok(messy.roads[1].p[0] === 0 && messy.roads[1].p[2] === 1000, 'roads clipped to the map');
ok(messy.buildings.length === 2 && messy.buildings[0].k === 'res' && messy.buildings[0].p.length === 8, 'degenerate building dropped, closing point removed');
ok(messy.buildings[1].p.every(v => v <= 1000), 'building clipped');
ok(messy.water.length === 0 && messy.levels.length === 3 && messy.spawns.length === 2 && !('extra' in messy), 'junk dropped, stages filled');
ok(validateMap(messy).ok, 'normalised map validates');
ok(!validateMap({ format: 'rcmap', v: 1, w: 50, h: 50 }).ok, 'tiny map rejected');
ok(!validateMap({ ...e, roads: [{ p: [0, 0, NaN, 1], w: 5, k: 'minor' }] }).ok, 'NaN coordinate rejected');
ok(validateMap({ ...e, levels: e.levels.slice(0, 2) }).warnings.length > 0, 'two stages warns');
ok(validateMap({ ...e, levels: [e.levels[2], e.levels[0], e.levels[1]] }).warnings.some(w => /contain/.test(w)), 'non-nested stages warn');
const ser = serializeMap(messy);
const back = parseMap(ser);
ok(serializeMap(back) === ser, 'serialize/parse round trip');
throws(() => parseMap('{oops'), /JSON/, 'bad json');
throws(() => parseMap('{"format":"other"}'), /Not a REMAIN CALM map/, 'wrong format');
throws(() => parseMap('{"format":"rcmap","v":9}'), /newer version/, 'newer version');
// geometry helpers
const sq = [0, 0, 100, 0, 100, 100, 0, 100];
const holed = mergeHoles(sq, [[40, 40, 60, 40, 60, 60, 40, 60]]);
ok(pointInPoly(holed, 10, 10) && !pointInPoly(holed, 50, 50) && Math.abs(polyArea(holed) - 9600) < 1e-6, 'mergeHoles keyhole');
ok(clipLineRect([-10, 50, 50, 50, 50, 150, 80, 150, 80, 50, 110, 50], 0, 0, 100, 100).length === 2, 'line clipping splits pieces');
ok(Math.abs(polyArea(clipPolyRect([-50, -50, 50, -50, 50, 50, -50, 50], 0, 0, 100, 100)) - 2500) < 1e-6, 'polygon clipping');
const stg = makeStages(3000, 3000, 6, { cx: 1200, cy: 1400, seed: 5 });
ok(stg.length === 6, 'makeStages count');
for (let i = 1; i < stg.length; i++) ok(stg[i - 1].p.every((v, k) => k % 2 || pointInPoly(stg[i].p, v, stg[i - 1].p[k + 1]) || v <= 0.01 || v >= 2999.99), `stage ${i} nested`);
ok(polyArea(stg[0].p) < polyArea(stg[1].p) && polyArea(stg[0].p) > 50000, 'stage 1 is a district');
const st = mapStats(messy);
ok(st.buildings === 2 && st.areaKm2 === 1 && st.nominalPop > 0 && st.specials.civic === 1, 'mapStats');

// ---------------- share codes
const small = generateCity({ seed: 3, sizeKm: 1, water: 'river', density: 0.5, bridges: 2, stages: 3 });
const txt = serializeMap(small);
const code = await encodeShareCode(txt);
ok(code.startsWith('RC1.') && /^[A-Za-z0-9._-]+$/.test(code), 'share code alphabet');
ok(code.length < txt.length / 2, `share code compresses (${txt.length} -> ${code.length})`);
ok(await decodeShareCode('  ' + code.replace(/(.{80})/g, '$1\n') + '\n') === txt, 'share code round trip (with pasted line breaks)');
await rejects(decodeShareCode('hello'), /Not a REMAIN CALM/, 'garbage code');
await rejects(decodeShareCode('RC1.AAAA'), /damaged/, 'truncated code');
const u8 = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
ok(fromBase64Url(toBase64Url(u8)).join() === u8.join(), 'base64url bytes');

// ---------------- library (memory store in node)
lib.useMemoryStore();
const m1 = await lib.saveItem({ type: 'map', data: small, author: 'Tester' });
ok(m1.id && m1.name === small.name && m1.size > 1000 && m1.data.buildings.length === small.buildings.length, 'save map');
await new Promise(r => setTimeout(r, 3));
const mut = await lib.saveItem({ type: 'mutator', name: 'Zippy', data: { lines: ['zombie.speed=5', '# comment'] } });
await new Promise(r => setTimeout(r, 3));
const scen = await lib.saveItem({ type: 'scenario', name: 'Alpha', data: { map: small, mutators: ['zombie.speed=5'], difficulty: 'ultra' } });
await rejects(lib.saveItem({ type: 'mutator', name: 'Empty', data: { lines: ['nothing here'] } }), /path=value/, 'mutator needs override lines');
await rejects(lib.saveItem({ type: 'map', data: { format: 'other', w: 10, h: 10 } }), /Not a REMAIN CALM map/, 'non-map rejected');
let list = await lib.listItems();
ok(list.length === 3 && list[0].id === scen.id && !('data' in list[0]), 'list newest first, metadata only');
ok((await lib.listItems({ sort: 'name' })).map(i => i.name).join() === ['Alpha', small.name, 'Zippy'].sort((a, b) => a.localeCompare(b)).join(), 'sort by name');
ok((await lib.listItems({ sort: 'size' }))[0].type !== 'mutator', 'sort by size');
ok((await lib.listItems({ type: 'mutator' })).length === 1, 'filter by type');
ok((await lib.listItems({ search: 'zip' })).length === 1 && (await lib.listItems({ search: 'tester' })).length === 1, 'search name/author');
await lib.toggleFavourite(mut.id);
ok((await lib.listItems({ sort: 'favourite' }))[0].id === mut.id, 'favourite sorts first');
ok((await lib.getItem(scen.id)).data.difficulty === 'ultra', 'get item with data');
const resaved = await lib.saveItem({ ...m1, name: 'Renamed', data: m1.data });
ok(resaved.id === m1.id && resaved.created === m1.created && (await lib.listItems()).length === 3, 'overwrite keeps id');
// export / import
const mapText = lib.exportText(resaved);
const imp = lib.importText(mapText);
ok(imp.type === 'map' && imp.data.buildings.length === small.buildings.length && lib.exportFileName(resaved).endsWith('.rcmap.json'), 'map export/import');
const scText = lib.exportText(await lib.getItem(scen.id));
ok(lib.importText(scText).type === 'scenario' && lib.exportFileName(scen).endsWith('.rcscenario.json'), 'scenario export/import');
ok(lib.importText('zombie.speed=9\nwall.hp=100').type === 'mutator', 'bare mutator text import');
throws(() => lib.importText('{"kind":"rc-library","item":{"type":"virus"}}'), /Not a REMAIN CALM/, 'unknown type rejected');
const sc = await lib.shareCode(await lib.getItem(scen.id));
const fromSc = await lib.fromShareCode(sc);
ok(fromSc.type === 'scenario' && fromSc.name === 'Alpha' && fromSc.data.mutators[0] === 'zombie.speed=5', 'library share code round trip');
await lib.deleteItem(mut.id);
ok((await lib.listItems()).length === 2 && (await lib.getItem(mut.id)) === null, 'delete');

// ---------------- campaign
ok(CAMPAIGN.length === 6, 'six cities');
ok(CAMPAIGN.every(c => c.gen.stages >= 4 && c.gen.stages <= 7 && c.unlocks.length === c.gen.stages), 'stage counts + unlock rows');
for (let i = 1; i < CAMPAIGN.length; i++) ok(CAMPAIGN[i].gen.sizeKm >= CAMPAIGN[i - 1].gen.sizeKm, 'cities grow');
ok(new Set(CAMPAIGN.map(c => c.gen.water)).size >= 4, 'variety of water');
const everything = [...Object.keys(DEFAULTS.units), ...Object.keys(DEFAULTS.abilities), ...Object.values(UPGRADE_TIERS)];
for (const id of everything) ok(ALL_ITEMS.includes(id), `unlockable: ${id}`);
ok(ALL_ITEMS.length === new Set(ALL_ITEMS).size, 'no item unlocked twice');
ok(ALL_ITEMS.every(id => everything.includes(id)), 'no unknown ids in the table');
ok(unlocksFor('millbrook', 0).join() === 'spikes' && unlocksFor('nope', 0).length === 0, 'unlocksFor');
ok(unlockSource('nuke').cityId === 'new-corrigan' && unlockSource('garrison') === null, 'unlockSource');
ok(unlockedItems(() => true).size === everything.length && unlockedItems(() => false).size === DEFAULTS.startUnlocked.length, 'unlockedItems');
const battleshipCity = CAMPAIGN.find(c => c.unlocks.flat().includes('battleship'));
ok(battleshipCity.gen.water !== 'none', 'battleship unlocked on a city with water');

console.log(`map_format: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
