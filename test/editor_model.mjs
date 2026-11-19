// Editor document + checks (DOM-free). Run: node test/editor_model.mjs
import { EditorDoc, findSnap, resizedMap, rectFrom, translated, rotated, cloneMap, cloneItem, insertVertex, removeVertex, setRoadLevel, addRamp } from '../js/ui/editor_model.js';
import { checkMap, stageInfo } from '../js/ui/editor_check.js';
import { emptyMap, makeStages, serializeMap, parseMap, normalizeMap } from '../js/map/format.js';
import { generateCity } from '../js/map/citygen.js';

let fails = 0;
const ok = (c, msg) => { if (c) console.log('ok -', msg); else { fails++; console.error('FAIL:', msg); } };

const base = emptyMap(1000, 800, 'Test Sheet');
base.levels = makeStages(1000, 800, 3, { seed: 1 });
const doc = new EditorDoc(base);
const m = doc.map;
ok(m.levels.length === 3 && m.buildings.length === 0, 'blank sheet with three stages');

let changes = 0;
doc.onChange(() => changes++);
doc.insert('roads', { p: [100, 400, 900, 400], w: 7, k: 'minor' });
const b0 = doc.insert('buildings', { p: rectFrom(480, 360, 520, 390), h: 12, k: 'res', use: 'Housing' });
doc.insert('buildings', { p: rectFrom(530, 360, 560, 390), h: 30, k: 'civic', use: 'Town Hall' });
ok(m.roads.length === 1 && m.buildings.length === 2 && changes === 3 && doc.dirty, 'inserts apply and notify');

doc.undo();
ok(m.buildings.length === 1 && doc.redoStack.length === 1, 'undo removes the last insert');
doc.redo();
ok(m.buildings.length === 2 && m.buildings[1].k === 'civic', 'redo restores it');

doc.patch('buildings', b0, { h: 13 }, 'h:0');
doc.patch('buildings', b0, { h: 14 }, 'h:0');
doc.patch('buildings', b0, { h: 15 }, 'h:0');
ok(m.buildings[b0].h === 15 && doc.undoStack.length === 4, 'typing into one field merges into one undo step');
doc.undo();
ok(m.buildings[b0].h === 12, 'one undo reverts the whole typing burst');
doc.redo();

doc.transact('Group', () => {
  doc.set('buildings', 0, translated('buildings', m.buildings[0], 5, 0));
  doc.set('buildings', 1, rotated('buildings', m.buildings[1], Math.PI / 2, 545, 375));
});
const moved = JSON.stringify(m.buildings);
doc.undo();
ok(m.buildings[0].p[0] === 480 && JSON.stringify(m.buildings) !== moved, 'grouped ops undo together');
doc.redo();
ok(JSON.stringify(m.buildings) === moved, 'grouped ops redo together');

doc.insert('spawns', [200, 200]);
doc.insert('spawns', [300, 300]);
doc.insert('spawns', [400, 300]);
doc.removeMany([{ coll: 'spawns', idx: 0 }, { coll: 'spawns', idx: 2 }, { coll: 'buildings', idx: 0 }]);
ok(m.spawns.length === 1 && m.spawns[0][0] === 300 && m.buildings.length === 1 && m.buildings[0].k === 'civic', 'removeMany keeps the right items');
doc.undo();
ok(m.spawns.length === 3 && m.spawns[2][0] === 400 && m.buildings.length === 2 && m.buildings[0].k === 'res', 'removeMany undoes in order');

doc.setMeta('palette', 'night');
doc.setMeta('name', 'Renamed', 'n');
doc.setMeta('name', 'Renamed again', 'n');
ok(m.palette === 'night' && m.name === 'Renamed again', 'meta edits');
doc.undo(); doc.undo();
ok(m.palette === 'paper' && m.name === 'Test Sheet', 'meta undo (merged rename)');

// live drag
const before = JSON.parse(JSON.stringify(m.buildings[1]));
doc.liveSet('buildings', 1, translated('buildings', before, 40, 0));
doc.liveSet('buildings', 1, translated('buildings', before, 80, 0));
const committed = doc.commitLive([{ coll: 'buildings', idx: 1, before }], 'Move');
ok(committed && m.buildings[1].p[0] === before.p[0] + 80, 'live drag commits its final position');
doc.undo();
ok(JSON.stringify(m.buildings[1]) === JSON.stringify(before), 'live drag undoes in one step');

// picking
const hit = doc.pick(500, 375, 2);
ok(hit && hit.coll === 'buildings' && hit.idx === 0, 'pick finds the building under the cursor');
const road = doc.pick(200, 402, 2);
ok(road && road.coll === 'roads', 'pick finds a road within its width');
const box = doc.pickBox(470, 350, 570, 400);
ok(box.filter(r => r.coll === 'buildings').length === 2 && !box.some(r => r.coll === 'roads'), 'box select takes items fully inside');
const snap = findSnap(doc, 103, 404, 10);
ok(snap && snap.kind === 'node' && snap.x === 100 && snap.y === 400, 'snaps to a road end node');
const esnap = findSnap(doc, 300, 405, 10, { polys: false });
ok(esnap && esnap.kind === 'edge' && Math.abs(esnap.y - 400) < 1e-9, 'snaps onto a road edge');
const v = doc.vertexAt('buildings', 0, 486, 361, 3);
ok(v && v.k === 0, 'vertex lookup');
const e = doc.edgeAt('buildings', 0, 500, 359, 3);
ok(e && e.k === 0, 'edge lookup');

// resize
const r = resizedMap(m, 520, 800);
ok(r.w === 520 && r.roads[0].p[2] === 520 && r.buildings.length === 1 && r.levels[2].p.includes(520), 'resize crops geometry and keeps the last stage whole');
doc.replaceAll(r, 'Resize');
ok(m.w === 520 && m.buildings.length === 1, 'replaceAll applies');
doc.undo();
ok(m.w === 1000 && m.buildings.length === 2, 'replaceAll undoes');

// checks
let res = checkMap(m);
ok(res.ok, 'small hand-drawn sheet passes (' + res.errors.map(x => x.msg).join('; ') + ')');
doc.insert('water', { p: rectFrom(0, 300, 1000, 340) });
doc.insert('roads', { p: [700, 100, 700, 700], w: 7, k: 'minor' });
doc.insert('roads', { p: [800, 280, 800, 360], w: 10, k: 'bridge' });
doc.insert('roads', { p: [900, 100, 900, 200], w: 10, k: 'bridge' });
res = checkMap(m);
const msgs = res.warnings.map(w => w.msg).join(' | ');
ok(/Road 2 crosses water/.test(msgs), 'warns about a plain road over water');
ok(/Bridge 4 does not cross any water/.test(msgs), 'warns about a dry bridge');
ok(!/Bridge 3/.test(msgs), 'a proper bridge is fine');
const emptyStage = cloneMap(m);
emptyStage.levels[0] = { p: rectFrom(10, 10, 60, 60) };
res = checkMap(emptyStage);
ok(!res.ok && res.errors.some(x => /Stage 1 has no buildings/.test(x.msg)), 'a stage without buildings is an error');
const notNested = cloneMap(m);
notNested.levels[1] = { p: rectFrom(400, 300, 600, 500) };
notNested.levels[0] = { p: rectFrom(300, 300, 700, 500) };
res = checkMap(notNested);
ok(res.warnings.some(x => /Stage 2 does not fully contain stage 1/.test(x.msg)), 'warns when a stage does not contain the previous one');
const two = cloneMap(m);
two.levels = two.levels.slice(0, 2);
ok(!checkMap(two).ok, 'fewer than three stages is an error');
const bad = cloneMap(m);
bad.buildings[0].k = 'castle';
res = checkMap(bad);
ok(!res.ok && res.errors[0].ref && res.errors[0].ref.coll === 'buildings', 'format errors point at the item');

// round trip through the file format
const text = serializeMap(normalizeMap(cloneMap(m)));
const back = parseMap(text);
ok(back.buildings.length === m.buildings.length && back.roads.length === m.roads.length && back.levels.length === 3, 'export/import round trip');

// generated city
const city = generateCity({ seed: 77, sizeKm: 1.5, water: 'river', bridges: 2, stages: 4 });
const t0 = Date.now();
const cdoc = new EditorDoc(city);
res = checkMap(cdoc.map);
ok(res.ok, `generated city passes the inspection in ${Date.now() - t0} ms (${res.warnings.length} warnings)`);
const info = stageInfo(cdoc.map);
ok(info.length === 4 && info.every((s, i) => s.nested && s.buildings > 0 && (i === 0 || s.buildings >= info[i - 1].buildings)), 'stage info is nested and growing');
const t1 = Date.now();
cdoc.index();
const hits = cdoc.pickAll(city.w / 2, city.h / 2, 5);
ok(Date.now() - t1 < 400 && Array.isArray(hits), `index + pick on ${city.buildings.length} buildings in ${Date.now() - t1} ms`);

// ---------------- road levels
{
  const road = { p: [0, 100, 100, 100, 300, 100], w: 8, k: 'major', z: [0, 1, 1] };
  const c = cloneItem(road);
  ok(c.z && c.z !== road.z && c.z.join() === '0,1,1' && !('z' in cloneItem({ p: [0, 0, 1, 1], w: 6, k: 'minor' })), 'cloneItem copies heights, and adds none to flat roads');
  const ins = insertVertex(road, 0, 50, 100);
  ok(ins.p.length === 8 && ins.z.join() === '0,0.5,1,1', 'inserting a node interpolates its height');
  const rem = removeVertex(ins, 2);
  ok(rem.p.join() === road.p.join() && rem.z.join() === '0,1,1', 'removing a node drops its height');
  ok(!('z' in removeVertex({ p: [0, 0, 10, 0, 20, 0], w: 6, k: 'minor', z: [0, 1, 0] }, 2)), 'a road left all on the ground loses its heights');
  const deck = setRoadLevel({ p: [0, 0, 200, 0, 400, 0], w: 8, k: 'major' }, 1);
  ok(deck.z.join() === '1,1,1' && !('z' in setRoadLevel(deck, 0)), 'Level sets every node, Ground removes the heights');
  const r1 = addRamp(deck, 0, 60);
  ok(r1.p.length === 8 && r1.p[2] === 60 && r1.z.join() === '0,1,1,1', 'a ramp at the start inserts a node 60 m in and grounds the start');
  const r2 = addRamp(r1, 1, 90, 0);
  ok(r2.p.length === 10 && r2.z[r2.z.length - 1] === 0 && r2.p[r2.p.length - 4] === 310 && r2.z[r2.z.length - 2] === 1, 'a ramp at the end does the same at the other end');
  const r3 = addRamp(setRoadLevel({ p: [0, 0, 400, 0], w: 8, k: 'major' }, 2), 0, 100, 1);
  ok(r3.z.join() === '1,2,2', 'a ramp can end at the height of the road it meets');
  const big = { ...emptyMap(1000, 1000, 'Levels'), roads: [{ p: [500, 100, 1500, 100], w: 8, k: 'major', z: [0, 2] }] };
  const small = resizedMap(normalizeMap(big), 800, 800);
  ok(small.roads[0].p[2] === 800 && Math.abs(small.roads[0].z[1] - 0.6) < 1e-9, 'resizing the sheet clips heights with the road');
  const lm = normalizeMap({ ...emptyMap(1000, 1000, 'Checks'), buildings: [{ p: rectFrom(600, 600, 700, 700), h: 10, k: 'res' }],
    roads: [{ p: [100, 300, 400, 300], w: 8, k: 'major', z: [0, 1] }, { p: [100, 500, 120, 500, 300, 500], w: 8, k: 'major', z: [0, 1, 1] }, { p: [650, 500, 650, 800], w: 8, k: 'minor', z: [-1, 0] }] });
  const w = checkMap(lm).warnings.map(x => x.msg);
  ok(w.some(m => /Road 1 ends in mid-air/.test(m)) && w.some(m => /Road 2 has a ramp steeper/.test(m)) && w.some(m => /Road 3 meets the ground inside a building/.test(m)), 'checks: mid-air deck end, steep ramp, ramp in a building');
}

console.log(fails ? `editor_model: ${fails} FAILED` : 'editor_model: all passed');
if (fails) process.exitCode = 1;
