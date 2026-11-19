// node test/trains.mjs  — rail network, decorative trains, train clock.
import { generateCity } from '../js/map/citygen.js';
import { analyseRails, railNetFor, nearestOnLine, MIN_ROUTE, JOIN } from '../js/render/railnet.js';
import { planTrains, trainAt, carPoints, TrainClock, TrainLayer, MAX_TRAINS } from '../js/render/trains.js';
import { World } from '../js/sim/world.js';
import { rectPoly } from '../js/util/geom.js';
import { makeTestMap } from './sim_testmap.mjs';

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.error('FAIL', msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Distance from (x, y) to the nearest rail polyline of the map.
function railDist(net, x, y) {
  let best = Infinity;
  const o = [0, 0, 0, 0];
  for (const ln of net.lines) {
    if (x < ln.bb[0] - 40 || x > ln.bb[2] + 40 || y < ln.bb[1] - 40 || y > ln.bb[3] + 40) continue;
    nearestOnLine(ln, x, y, o);
    if (o[1] < best) best = o[1];
  }
  return best;
}

// Trains stay on the track, cars keep their length and coupling gap along curves.
function checkTrains(label, map, net, trains) {
  const geo = new Float64Array(64 * 4);
  let worst = 0, badLen = 0, badGap = 0, samples = 0, onMap = 0;
  for (const tr of trains) {
    for (let k = 0; k < 160; k++) {
      const tau = k * tr.P / 160 + 0.37;
      const n = carPoints(tr, tau, geo);
      if (!n) continue;
      samples++;
      for (let c = 0; c < n; c++) {
        const fx = geo[4 * c], fy = geo[4 * c + 1], bx = geo[4 * c + 2], by = geo[4 * c + 3];
        for (const [x, y] of [[fx, fy], [bx, by]]) {
          if (x < 2 || y < 2 || x > map.w - 2 || y > map.h - 2) continue;
          onMap++;
          worst = Math.max(worst, railDist(net, x, y));
        }
        const chord = Math.hypot(fx - bx, fy - by), len = tr.cars[c].len;
        if (chord > len + 1e-6 || chord < len * 0.95) badLen++;
        if (c > 0) {
          const gap = Math.hypot(geo[4 * c - 2] - fx, geo[4 * c - 1] - fy);
          if (gap > 1.2 + 1e-6 || gap < 0.6) badGap++;
        }
      }
    }
  }
  ok(samples > 0, `${label}: trains appear on the map`);
  ok(onMap > 0 && worst <= JOIN + 0.6, `${label}: every bogie on the map sits on a rail line (worst ${worst.toFixed(2)} m)`);
  ok(badLen === 0, `${label}: car bodies keep their length along curves (${badLen} bad)`);
  ok(badGap === 0, `${label}: couplings stay about 1.2 m apart (${badGap} bad)`);
}

// ---------------------------------------------------------------- generated cities
const CITIES = [[7, 4, 'river'], [3, 4, 'none'], [11, 3, 'coast'], [9, 4, 'islands'], [1, 2, 'river']];
for (const [seed, size, water] of CITIES) {
  const label = `city ${seed} ${size}km ${water}`;
  const map = generateCity({ seed, sizeKm: size, water });
  const rails = map.roads.filter(r => r.k === 'rail');
  const net = analyseRails(map);
  ok(net.lines.length === rails.length, `${label}: one line per rail polyline (${net.lines.length}/${rails.length})`);
  for (const e of net.edges) ok(e.a < net.nodes.length && e.b < net.nodes.length && e.L > 0, `${label}: edge ends are nodes`);
  net.lines.forEach((ln, i) => {
    const sum = ln.edges.reduce((a, e) => a + net.edges[e].L, 0);
    ok(near(sum, ln.L, 0.6), `${label}: line ${i} edges cover it (${sum.toFixed(1)} of ${ln.L.toFixed(1)})`);
  });
  ok(net.routes.length > 0, `${label}: at least one route`);
  for (const rt of net.routes) {
    ok(rt.L >= MIN_ROUTE, `${label}: route long enough (${rt.L.toFixed(0)})`);
    let off = 0;
    for (let s = 0; s <= rt.L; s += 10) {
      let i = 0;
      while (i < rt.cum.length - 2 && rt.cum[i + 1] < s) i++;
      const t = (s - rt.cum[i]) / Math.max(1e-9, rt.cum[i + 1] - rt.cum[i]);
      const x = rt.p[2 * i] + (rt.p[2 * i + 2] - rt.p[2 * i]) * t, y = rt.p[2 * i + 1] + (rt.p[2 * i + 3] - rt.p[2 * i + 1]) * t;
      off = Math.max(off, railDist(net, x, y));
    }
    ok(off <= JOIN + 0.5, `${label}: route follows the rails (max ${off.toFixed(2)} m off)`);
  }
  const main = net.lines.find(l => l.w === 8 && l.L > size * 900);
  if (main && net.nodes.filter(n => n.portal).length >= 2) ok(net.routes.some(r => r.portalA && r.portalB), `${label}: a through route edge to edge`);
  const st = map.buildings.filter(b => b.use === 'Rail Station');
  if (st.length) ok(net.stops.length > 0 && net.routes.some(r => r.stops.length), `${label}: the station is a stop`);
  const { trains } = planTrains(map, net);
  ok(trains.length >= 1 && trains.length <= MAX_TRAINS, `${label}: ${trains.length} trains`);
  for (const tr of trains) ok(tr.V >= 11 && tr.V <= 24.5, `${label}: sensible speed ${tr.V.toFixed(1)} m/s`);
  checkTrains(label, map, net, trains);

  // deterministic: an independently generated copy of the same city gives the same trains at the same clock
  const map2 = generateCity({ seed, sizeKm: size, water });
  const t2 = planTrains(map2).trains;
  let same = t2.length === trains.length;
  const a = [0, 0, 0, 0, 0], b = [0, 0, 0, 0, 0];
  for (let i = 0; same && i < trains.length; i++) for (const tau of [0, 13.25, 400, 12345.6]) {
    trainAt(trains[i], tau, a); trainAt(t2[i], tau, b);
    if (Math.abs(a[0] - b[0]) > 1e-9 || a[1] !== b[1]) same = false;
  }
  ok(same, `${label}: same map, same clock, same trains`);
}

// ---------------------------------------------------------------- synthetic OSM-like set
function curve(P, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, s = 1 - t;
    out.push(s * s * s * P[0][0] + 3 * s * s * t * P[1][0] + 3 * s * t * t * P[2][0] + t * t * t * P[3][0],
      s * s * s * P[0][1] + 3 * s * s * t * P[1][1] + 3 * s * t * t * P[2][1] + t * t * t * P[3][1]);
  }
  return out;
}
{
  const W = 2000, H = 2000;
  const map = { format: 'rcmap', v: 1, name: 'Rail sample', seed: 99, w: W, h: H, palette: 'paper', parks: [], levels: [], spawns: [],
    water: [{ p: rectPoly(800, 950, 860, 1250) }],
    roads: [
      { p: [0, 500, 400, 500, 1000, 500], w: 6, k: 'rail' },                       // A1
      { p: [1001.5, 500.8, 1600, 500, 2000, 500], w: 6, k: 'rail' },               // A2, after a 1.7 m gap
      { p: curve([[600, 500], [900, 500], [1300, 1100], [1300, 2000]], 40), w: 6, k: 'rail' },   // B: branch off A1 to the south edge
      { p: [1500, 500, 1540, 503, 1580, 509, 1610, 514], w: 5, k: 'rail' },         // C: a tiny siding off A2
      { p: [200, 1500, 400, 1500], w: 6, k: 'rail' },                               // D: isolated stub
      { p: [300, 1050, 900, 1100, 1500, 1100], w: 6, k: 'rail' },                   // E: shuttle line over the water
      { p: [1200, 0, 1200, 300, 1200, 1000], w: 6, k: 'rail' },                     // F: crosses A on the flat, no junction
      { p: [300, 300, 300, 700], w: 7, k: 'minor' },
      { p: [1000, 900, 1000, 1300], w: 12, k: 'major' },
      { p: [0, 1800, 2000, 1800], w: 7, k: 'minor' },
    ],
    buildings: [{ p: rectPoly(560, 1000, 680, 1060), h: 14, k: 'rescue', use: 'Rail Station' }] };
  const net = analyseRails(map);
  const label = 'synthetic';
  const nodeNear = (x, y, r = 6) => net.nodes.filter(n => Math.hypot(n.x - x, n.y - y) < r);
  ok(net.lines.length === 7, `${label}: seven lines`);
  ok(nodeNear(1000.7, 500.4).length === 1 && nodeNear(1000.7, 500.4)[0].deg === 2, `${label}: ends 1.7 m apart are joined`);
  ok(nodeNear(600, 500).length === 1 && nodeNear(600, 500)[0].deg === 3, `${label}: a branch starting part way along a line makes a junction`);
  ok(nodeNear(1500, 500).length === 1 && nodeNear(1500, 500)[0].deg === 3, `${label}: the siding hangs off a junction`);
  ok(nodeNear(1200, 500, 20).length === 0, `${label}: a flat crossing is not a junction`);
  ok(net.nodes.filter(n => n.portal).length === 4, `${label}: four ends leave the sheet (${net.nodes.filter(n => n.portal).length})`);
  const through = net.routes.find(r => r.portalA && r.portalB && Math.abs(r.p[1] - 500) < 2 && Math.abs(r.p[r.p.length - 1] - 500) < 2);
  ok(through && near(through.L, 2000, 6), `${label}: the main line runs edge to edge across the gap (${through && through.L.toFixed(0)})`);
  const fromSouth = net.routes.find(r => r.portalA && (Math.abs(r.p[1] - H) < 2 || Math.abs(r.p[r.p.length - 1] - H) < 2));
  ok(!!fromSouth && fromSouth.share.length > 0, `${label}: the branch runs onto the main line and shares it`);
  const ends = net.routes.flatMap(r => [[r.p[0], r.p[1]], [r.p[r.p.length - 2], r.p[r.p.length - 1]]]);
  ok(!ends.some(([x, y]) => Math.hypot(x - 1610, y - 514) < 10), `${label}: no route ends in the tiny siding`);
  ok(!net.routes.some(r => { for (let k = 0; k < r.p.length; k += 2) if (Math.hypot(r.p[k] - 300, r.p[k + 1] - 1500) < 120) return true; return false; }), `${label}: the stub has no route`);
  const shuttle = net.routes.find(r => !r.portalA && !r.portalB);
  ok(!!shuttle && shuttle.stops.length === 1, `${label}: the line with both ends in town is a shuttle with a station stop`);
  const fRoute = net.routes.find(r => r.portalA && !r.portalB && Math.abs(r.p[0] - 1200) < 2);
  ok(!!fRoute && near(fRoute.L, 1000, 3), `${label}: the line from the north edge ends at a buffer (${fRoute && fRoute.L.toFixed(0)})`);
  const E = net.lines[net.byRoad[5]], C = net.lines[net.byRoad[3]], D = net.lines[net.byRoad[4]];
  ok(E.spans.length === 1 && near(E.spans[0][1] - E.spans[0][0], 66, 6), `${label}: a rail bridge over the water (${E.spans.map(s => (s[1] - s[0]).toFixed(1))})`);
  ok(E.buf0 && E.buf1 && C.buf1 && !C.buf0 && D.buf0 && D.buf1, `${label}: buffer stops at the dead ends`);
  ok(net.crossings.length === 3, `${label}: three level crossings (${net.crossings.length})`);
  ok(net.crossings.some(c => c.k === 'minor' && near(c.x, 300, 0.5) && near(c.y, 500, 0.5)), `${label}: minor road over the main line`);
  ok(net.crossings.some(c => c.k === 'major' && near(c.x, 1000, 0.5)), `${label}: major road over the shuttle line`);
  ok(net.platforms.length === 1 && net.platforms[0].o1 - net.platforms[0].o0 >= 2.2, `${label}: a platform beside the station`);
  const { trains } = planTrains(map, net);
  ok(trains.length >= 3, `${label}: ${trains.length} trains`);
  checkTrains(label, map, net, trains);
  // shared track: the branch train and the main line trains never stand on the same stretch at once
  const shared = trains.filter(t => t.route.share && t.route.share.length);
  let clash = 0, pairs = 0;
  for (let i = 0; i < shared.length; i++) for (let j = i + 1; j < shared.length; j++) {
    const A = shared[i], B = shared[j];
    if (A.route === B.route) continue;
    const segA = A.route.segs, segB = B.route.segs, common = new Set(segA.map(g => g.e).filter(e => segB.some(g => g.e === e)));
    if (!common.size) continue;
    pairs++;
    const sa = [0, 0, 0, 0, 0], sb = [0, 0, 0, 0, 0];
    for (let tau = 0; tau < A.P * 2; tau += 1) {
      trainAt(A, tau, sa); trainAt(B, tau, sb);
      const on = (tr, st) => { const lo = st[1] > 0 ? st[0] - tr.len : st[0], hi = st[1] > 0 ? st[0] : st[0] + tr.len; return tr.route.segs.filter(g => common.has(g.e) && hi >= g.s0 && lo <= g.s1).map(g => g.e); };
      if (sa[4] & 2 || sb[4] & 2) continue;
      const ea = on(A, sa), eb = on(B, sb);
      if (ea.some(e => eb.includes(e))) clash++;
    }
  }
  ok(pairs > 0 && clash === 0, `${label}: trains on shared track are timed apart (${pairs} pairs, ${clash} clashing seconds)`);
}

// ---------------------------------------------------------------- no rails, no trains
{
  const map = makeTestMap({ size: 800 });
  const net = analyseRails(map);
  ok(net.lines.length === 0 && net.routes.length === 0, 'no rails: no network');
  ok(planTrains(map).trains.length === 0, 'no rails: no trains');
  const layer = new TrainLayer(map);
  ok(layer.trains.length === 0, 'no rails: an empty train layer');
}

// ---------------------------------------------------------------- clock
{
  const cfg = { sim: { dt: 0.05, baseSpeed: 2 } };
  const w = { phase: 'planning', t: 0, cfg };
  const c = new TrainClock();
  c.update(w, { rt: 10, t: 0, turn: null, hold: false });
  ok(c.tau === 0, 'clock starts at 0');
  c.update(w, { rt: 10.1, t: 0, turn: null, hold: false });
  ok(near(c.tau, 0.2, 1e-9), 'planning: runs at the 1x clock speed in real time');
  c.update(w, { rt: 10.6, t: 0, turn: null, hold: true });
  ok(near(c.tau, 0.2, 1e-9), 'planning: stops while a menu is open');
  w.phase = 'battle';
  c.update(w, { rt: 11, t: 0 });
  c.update(w, { rt: 11.5, t: 3 });
  ok(near(c.tau, 3.2, 1e-9), 'battle: follows world.t');
  c.update(w, { rt: 12.5, t: 3 });
  ok(near(c.tau, 3.2, 1e-9), 'battle: paused game, paused trains');
  c.update(w, { rt: 13, t: 11 });
  ok(near(c.tau, 11.2, 1e-9), 'battle: a faster game speed moves them faster');
  w.phase = 'planning';
  c.update(w, { rt: 14, t: 0, turn: null });
  w.phase = 'battle';
  c.update(w, { rt: 15, t: 0 });
  c.update(w, { rt: 15.1, t: 0.5 });
  ok(c.tau > 11.2 && c.tau < 14, 'a new stage carries on instead of jumping back');
  // co-op: two peers with different real-time stamps but the same turns and battle clock agree
  const p1 = new TrainClock(), p2 = new TrainClock(), w1 = { phase: 'planning', t: 0, cfg }, w2 = { phase: 'planning', t: 0, cfg };
  for (let k = 0; k <= 200; k++) {
    if (k === 120) { w1.phase = w2.phase = 'battle'; }
    const t = k >= 120 ? (k - 120) * 0.1 : 0;
    p1.update(w1, { rt: k * 0.016, t, turn: k * 2 });
    p2.update(w2, { rt: 100 + k * 0.021, t, turn: k * 2 });
  }
  ok(near(p1.tau, p2.tau, 1e-9) && p1.tau > 0, `co-op peers see the same train clock (${p1.tau.toFixed(2)} / ${p2.tau.toFixed(2)})`);
}

// ---------------------------------------------------------------- decorative only, cheap, and horns near the camera
{
  const map = generateCity({ seed: 7, sizeKm: 4, water: 'river' });
  map.roads.push({ p: curve([[0, 520], [1300, 380], [2700, 640], [4000, 600]], 40), w: 6, k: 'rail' });
  map.roads.push({ p: curve([[0, 3620], [1400, 3500], [2800, 3720], [4000, 3650]], 40), w: 6, k: 'rail' });
  const layer = new TrainLayer(map);
  ok(layer.trains.length >= 8, `busy 4 km city: ${layer.trains.length} trains`);
  const all = [0, 0, map.w, map.h];
  let placed = 0;
  const N = 3000, t0 = performance.now();
  for (let f = 0; f < N; f++) placed += layer.place(f / 30, all, null);
  const us = (performance.now() - t0) / N * 1000;
  ok(placed > 0, 'trains are placed');
  ok(us < 200, `update cost ${us.toFixed(1)} us per frame for ${layer.trains.length} trains`);
  console.log(`  update: ${us.toFixed(1)} us per frame, ${(placed / N).toFixed(1)} trains on the sheet on average`);
  const none = layer.place(5000, [-900, -900, -800, -800], null);
  ok(none === 0, 'trains off screen are culled');
  let horns = 0;
  const L2 = new TrainLayer(map);
  for (let f = 0; f < 20000; f++) L2.place(f * 0.25, all, () => { horns++; });
  ok(horns > 0, `a horn when a train pulls out of a station (${horns} in ${(20000 * 0.25 / 60).toFixed(0)} min)`);
  let far = 0;
  const L3 = new TrainLayer(map);
  for (let f = 0; f < 20000; f++) L3.place(f * 0.25, [-900, -900, -800, -800], () => { far++; });
  ok(far === 0, 'no horn for trains out of view');

  // drawing every zoom through a stub canvas leaves the simulation untouched
  const w = new World(makeTestMap({ size: 800, seed: 5 }), { seed: 5, stage: 0 });
  const tm = w.map;
  tm.roads.push({ p: [0, 400, 800, 400], w: 6, k: 'rail' });
  const h0 = w.hash();
  const stub = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const pal = (await import('../js/render/palette.js')).getPalette('night');
  const cam = { zoom: 1, x: 0, y: 0, w: 800, h: 600, visibleBBox(m, out = [0, 0, 0, 0]) { out[0] = this.x - m / this.zoom; out[1] = this.y - m / this.zoom; out[2] = this.x + (this.w + m) / this.zoom; out[3] = this.y + (this.h + m) / this.zoom; return out; } };
  const L4 = new TrainLayer(tm);
  let drew = 0;
  for (const z of [0.3, 1.5, 6]) { cam.zoom = z; for (let f = 0; f < 400; f++) drew += L4.draw(stub, w, cam, { t: 0, rt: f * 0.5, turn: null, hold: false, trains: true }, pal); }
  ok(drew > 0, 'the stub canvas saw trains at every zoom');
  ok(w.hash() === h0, 'world.hash is unchanged by the trains');
  ok(L4.draw(stub, w, cam, { t: 0, rt: 9999, trains: false }, pal) === 0, 'the Trains setting hides them');
  ok(railNetFor(tm) === railNetFor(tm), 'the network is analysed once per map');
}

// ---------------------------------------------------------------- setting
{
  const store = new Map();
  globalThis.localStorage = globalThis.localStorage || { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const S = await import('../js/meta/settings.js');
  ok(S.DEFAULT_SETTINGS.trains === true, 'Trains default on');
  S.updateSettings({ trains: false });
  ok(S.getSetting('trains') === false, 'Trains can be turned off');
  S.updateSettings({ trains: true });
}

console.log(`${fails ? 'FAILED' : 'ok'}: ${passes} passed, ${fails} failed`);
process.exitCode = fails ? 1 : 0;
