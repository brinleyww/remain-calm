// Co-op lockstep over an in-memory link with latency and jitter: both worlds must stay identical.
// Run: node test/net_lockstep.mjs
import { World } from '../js/sim/world.js';
import { LockstepDriver, makeLoopbackPair, decodeSignal, INPUT_DELAY } from '../js/net/coop.js';
import { makeTestMap, blockRect } from './sim_testmap.mjs';
import { generateCity } from '../js/map/citygen.js';
import { serializeMap } from '../js/map/format.js';

let fails = 0;
const ok = (c, msg) => { if (c) console.log('ok -', msg); else { fails++; console.error('FAIL:', msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- large transfer
{
  const [a, b] = makeLoopbackPair({ latency: 5, jitter: 5 });
  await a.ready; await b.ready;
  const text = serializeMap(generateCity({ seed: 5, sizeKm: 1.5, water: 'coast' }));
  const got = new Promise(res => b.setLargeHandler((tag, t) => res([tag, t])));
  let prog = 0;
  b.onLargeProgress = (tag, f) => { prog = f; };
  const order = [];
  b.onMessage = m => order.push(m.k);
  a.send({ k: 'meta' });
  await a.sendLarge('map', text, () => {});
  a.send({ k: 'after' });
  const [tag, t] = await got;
  await sleep(30);
  ok(tag === 'map' && t === text, `large text arrives intact (${(text.length / 1024).toFixed(0)} KB)`);
  ok(prog === 1 && order.join() === 'meta,after', 'progress reaches 100% and ordinary messages keep their order');
  a.close();
  await sleep(20);
  ok(b.state === 'closed' && b.closeReason === 'left', 'closing one side closes the other (' + b.closeReason + ')');
}

// ---- signalling codes are checked
{
  let msg = '';
  try { await decodeSignal('hello', 'rc-offer'); } catch (e) { msg = e.message; }
  ok(/not a REMAIN CALM link code/.test(msg), 'junk codes are rejected with a readable message');
}

// ---- lockstep
async function session({ latency, jitter, lagB = 0, ticks = 1200, desync = false }) {
  const map = makeTestMap({ size: 800, river: true });
  const mk = () => new World(map, { seed: 99, stage: 2, owners: 2 });
  const wa = mk(), wb = mk();
  const [la, lb] = makeLoopbackPair({ latency, jitter });
  await la.ready; await lb.ready;
  const da = new LockstepDriver(wa, la, 0, { turnSec: 0.01, maxSteps: 16 });
  const db = new LockstepDriver(wb, lb, 1, { turnSec: 0.01, maxSteps: 16 });
  const results = { a: [], b: [] };
  da.onApply = (c, r, local) => { if (local) results.a.push([c.t, r.ok]); };
  db.onApply = (c, r, local) => { if (local) results.b.push([c.t, r.ok]); };
  let desyncInfo = null;
  da.onDesync = i => { desyncInfo = i; };
  db.onDesync = i => { desyncInfo = desyncInfo || i; };
  const sessionCalls = [];
  da.onSession = (c, local) => { sessionCalls.push(['a', c.t, local]); return { ok: true }; };
  db.onSession = (c, local) => { sessionCalls.push(['b', c.t, local]); return { ok: true }; };
  const peerMsgs = [];
  db.onPeer = m => peerMsgs.push(m);

  let cbHit = false;
  da.submit({ t: 'zone.add', p: blockRect(1, 1, 2, 2) }, r => { cbHit = r.ok; });
  db.submit({ t: 'hold.add', x: 650, y: 650, R: 40 });
  db.submit({ t: 'wall.add', p: [560, 120, 640, 120, 640, 200] });
  da.sendPeer({ k: 'cur', x: 1, y: 2 });
  let phase = 0, frames = 0;
  const t0 = Date.now();
  while (wa.tick < ticks && Date.now() - t0 < 60000) {
    await sleep(4);
    frames++;
    da.advance(0.012);
    if (!lagB || frames % lagB) db.advance(0.012);
    if (phase === 0 && da.turn > 30) {
      const comp = wa.zones.comps[0];
      if (comp) {
        const [x0, y0, x1, y1] = comp.bbox.map(v => v * wa.grid.cell);
        da.submit({ t: 'gate.add', x: (x0 + x1) / 2, y: y1 + 2 });
      }
      da.submit({ t: 'ready' });
      phase = 1;
    }
    if (phase === 1 && da.turn > 60) { db.submit({ t: 'ready' }); db.submit({ t: 'session.note' }); phase = 2; }
    if (phase === 2 && wa.phase === 'battle' && wa.tick > 100) { db.submit({ t: 'speed', s: 4 }); phase = 3; }
    if (phase === 3 && wa.tick > 500) { da.submit({ t: 'speed', s: 0.5 }); phase = 4; }
    if (phase === 4 && wa.tick > 560) { da.submit({ t: 'speed', s: 2 }); phase = 5; if (desync) wb.A.x[0] += 3; }
    if (wa.phase !== 'planning' && wa.phase !== 'battle') break;
  }
  for (let i = 0; i < 400 && db.turn < da.turn; i++) { await sleep(2); db.advance(0.012); }
  const common = [...da.hashLog.keys()].filter(t => db.hashLog.has(t));
  const same = common.every(t => da.hashLog.get(t).h === db.hashLog.get(t).h);
  la.close();
  return { wa, wb, da, db, common, same, results, cbHit, desyncInfo, sessionCalls, peerMsgs, frames };
}

{
  const r = await session({ latency: 15, jitter: 25, lagB: 7 });
  ok(r.cbHit, 'submit callback reports the applied result');
  ok(r.results.a.length === 5 && r.results.b.length === 5, `every submitted command applied once (${r.results.a.length} + ${r.results.b.length})`);
  ok(r.wa.phase !== 'planning' && r.wa.tick >= 600, `both READY started the battle (phase ${r.wa.phase}, tick ${r.wa.tick})`);
  const last = r.common[r.common.length - 1];
  ok(r.common.length >= 5 && r.same, `hashes equal at ${r.common.length} checkpoints (last ${last ? r.da.hashLog.get(last).h : '-'})`);
  ok(r.wa.tick !== r.wb.tick || r.wa.hash() === r.wb.hash(), 'final world hash equal when ticks equal');
  ok(!r.desyncInfo, 'no desync reported');
  ok(r.sessionCalls.length === 2 && r.sessionCalls.every(c => c[1] === 'session.note') && r.sessionCalls.find(c => c[0] === 'b')[2] === true, 'session.* commands reach onSession on both peers');
  ok(r.peerMsgs.length === 1 && r.peerMsgs[0].k === 'cur', 'sendPeer messages bypass the lockstep');
  ok(r.wa.zones.polys.length === 1 && r.wa.holds.length === 1 && r.wa.walls.length === 1 && r.wa.zones.polys[0].owner === 0 && r.wa.holds[0].owner === 1, 'placements carry the right owners');
}
{
  const r = await session({ latency: 2, jitter: 0, ticks: 1000, desync: true });
  ok(!!r.desyncInfo && r.desyncInfo.local !== r.desyncInfo.remote, `a corrupted world is reported as a desync (tick ${r.desyncInfo && r.desyncInfo.tick})`);
}
console.log(`INPUT_DELAY ${INPUT_DELAY}`);
console.log(fails ? `net_lockstep: ${fails} FAILED` : 'net_lockstep: all passed');
if (fails) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode || 0), 50);
