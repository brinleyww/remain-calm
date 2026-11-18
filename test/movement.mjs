// Movement: watertight diagonal walls, crowds along the true wall line, residents reaching safe zones, zombies not stalling.
// Run: node test/movement.mjs   (add -v for per-case numbers)
import { World, TYPE, CS } from '../js/sim/world.js';
import { generateCity } from '../js/map/citygen.js';
import { rectPoly, pointInPoly, distToSeg } from '../js/util/geom.js';
import { assert } from './sim_testmap.mjs';

const verbose = process.argv.includes('-v');
const log = (...a) => { if (verbose) console.log('  ', ...a); };
const OPEN = { format: 'rcmap', v: 1, name: 'open field', source: 'editor', seed: 3, w: 640, h: 640, roads: [], water: [], parks: [],
  buildings: [{ p: rectPoly(8, 8, 20, 20), h: 6, k: 'res' }], levels: [], spawns: [] };
const STRONG = ['population.scale=0', 'loseBelowPct=0', 'wall.hp=1e9', 'gate.hp=1e9', 'outbreak.maxSites=1', 'outbreak.zombies=1',
  'outbreak.zombieScaleWithPop=false', 'outbreak.zombiesPerLevel=0', 'outbreak.minDistFromZone=0', 'mutation.firstSec=1e9', 'civ.panicRadius=0'];
const open = (extra = []) => new World(OPEN, { seed: 1, sandbox: true, mutators: [...STRONG, ...extra] });
const rot = (cx, cy, R, deg) => {
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), p = [];
  for (const [u, v] of [[-R, -R], [R, -R], [R, R], [-R, R]]) p.push(cx + u * ca - v * sa, cy + u * sa + v * ca);
  return p;
};
// removes everyone, then parks one stunned zombie in a corner so the stage does not end
const clearAll = (w) => { for (let i = 0; i < w.A.n; i++) if (w.A.type[i]) w.remove(i); w.A.stun[w.spawn(TYPE.ZOMBIE, 620, 620)] = 1e9; };
// distance band of the agents pressed against one edge: per 4 m stretch the closest agent, then the worst stretch
function front(w, ids, ax, ay, bx, by, skip = 8) {
  const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, bins = new Map();
  for (const i of ids) {
    if (!w.A.type[i]) continue;
    const px = w.A.x[i] - ax, py = w.A.y[i] - ay, t = px * ux + py * uy;
    if (t < skip || t > L - skip) continue;
    const d = Math.abs(px * uy - py * ux);
    if (d > 6) continue;
    const k = Math.floor(t / 4);
    bins.set(k, Math.min(bins.get(k) ?? 99, d));
  }
  const v = [...bins.values()];
  return { n: v.length, max: v.length ? Math.max(...v) : 99, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 99 };
}

// ---------------------------------------------------------------- 1. wall cells along the true line, 4-connected barrier
for (const deg of [15, 30, 45, 60]) {
  const w = open();
  assert(w.exec({ t: 'zone.add', p: rot(320, 320, 90, deg) }).ok, `${deg} deg zone placed`);
  const a = deg * Math.PI / 180, w2 = open();
  assert(w2.exec({ t: 'wall.add', p: [200, 200, 200 + 240 * Math.cos(a), 200 + 240 * Math.sin(a)] }).ok, `${deg} deg standalone wall placed`);
  const p = w.zones.polys[0].p, wl = w2.walls[0].p;
  let off = 0, pts = 0;
  for (let k = 0; k < 4; k++) {
    const ax = p[2 * k], ay = p[2 * k + 1], bx = p[(2 * k + 2) % 8], by = p[(2 * k + 3) % 8];
    for (let t = 0; t <= 1; t += 1 / 2000) { pts++; const c = w.cellAt(ax + (bx - ax) * t, ay + (by - ay) * t); if (!(w.block[c] === 1 && w.zoneComp[c] === 1 && w.wallSeg[c] !== -1)) off++; }
  }
  for (let t = 0; t <= 1; t += 1 / 2000) { pts++; const c = w2.cellAt(wl[0] + (wl[2] - wl[0]) * t, wl[1] + (wl[3] - wl[1]) * t); if (!(w2.block[c] === 2 && w2.wallSeg[c] !== -1)) off++; }
  const g = w.grid, N = g.gw * g.gh, seen = new Uint8Array(N), st = [g.gw + 1];
  let leak = 0;
  seen[g.gw + 1] = 1;
  while (st.length) {
    const c = st.pop();
    if (w.zoneId[c]) leak++;
    for (const n of [c - 1, c + 1, c - g.gw, c + g.gw]) if (n >= 0 && n < N && !seen[n] && !w.block[n]) { seen[n] = 1; st.push(n); }
  }
  assert(off === 0 && leak === 0, `${deg} deg: every point of the drawn line is on a wall cell of it (${off}/${pts} off) and a 4-way flood from outside reaches no interior cell (${leak})`);
}

// ---------------------------------------------------------------- 2. zombies besiege a diagonal zone wall: nobody gets in, they press on the drawn line
for (const deg of [15, 30, 45, 60]) {
  const w = open();
  const p = rot(320, 320, 80, deg);
  w.exec({ t: 'zone.add', p });
  w.exec({ t: 'ready' });
  clearAll(w);
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let k = 0; k < 40; k++) { const u = -60 + (k % 20) * 6, v = -40 + (k / 20 | 0) * 20; w.spawn(TYPE.CIV, 320 + u * ca - v * sa, 320 + u * sa + v * ca); }
  const zs = [];
  for (let k = 0; k < 120; k++) { const u = -70 + (k % 30) * 140 / 29, v = 84 + (k / 30 | 0) * 3; zs.push(w.spawn(TYPE.ZOMBIE, 320 + u * ca - v * sa, 320 + u * sa + v * ca)); }
  for (let k = 0; k < 120; k++) { const u = -84 - (k / 30 | 0) * 3, v = -70 + (k % 30) * 140 / 29; zs.push(w.spawn(TYPE.ZOMBIE, 320 + u * ca - v * sa, 320 + u * sa + v * ca)); }
  w.computeFields();
  let inside = 0;
  for (let k = 0; k < 900 && w.phase === 'battle'; k++) {
    w.step();
    for (const i of zs) if (w.A.type[i] === TYPE.ZOMBIE && pointInPoly(p, w.A.x[i], w.A.y[i])) inside++;
  }
  const q = w.zones.polys[0].p, edges = [0, 1, 2, 3].map((e) => front(w, zs, q[2 * e], q[2 * e + 1], q[(2 * e + 2) % 8], q[(2 * e + 3) % 8]));
  const n = edges.reduce((s, f) => s + f.n, 0), worst = Math.max(...edges.filter((f) => f.n).map((f) => f.max));
  const mean = edges.reduce((s, f) => s + f.n * (f.n ? f.mean : 0), 0) / Math.max(1, n);
  log(`zombies ${deg} deg: front over ${n} stretches, worst ${worst.toFixed(2)} m, mean ${mean.toFixed(2)} m; civilians left ${w.counts[TYPE.CIV]}`);
  assert(inside === 0 && w.counts[TYPE.CIV] === 40, `${deg} deg zone wall holds 240 zombies for 45 s (zombie-ticks inside ${inside}, civilians ${w.counts[TYPE.CIV]}/40)`);
  assert(n >= 8 && worst < 1.6, `${deg} deg: the besieging front lies along the drawn line (${n} stretches, worst ${worst.toFixed(2)} m, mean ${mean.toFixed(2)} m from it)`);
}

// ---------------------------------------------------------------- 3. a crowd of residents presses on a diagonal standalone wall
// Baseline (commit b113338, cell-staircase walls): worst stretch 3.6-5.4 m and mean 1.8-3.3 m from the drawn line.
for (const deg of [15, 30, 45, 60]) {
  const w = open();
  const a = deg * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  const cx = 320, cy = 320, wl = [cx - ux * 120, cy - uy * 120, cx + ux * 120, cy + uy * 120];
  w.exec({ t: 'wall.add', p: wl });
  w.exec({ t: 'hold.add', x: cx + nx * 30, y: cy + ny * 30, R: 90 });
  w.exec({ t: 'ready' });
  clearAll(w);
  const cs = [];
  for (let k = 0; k < 160; k++) { const t = -70 + (k % 40) * 3.5, d = 6 + (k / 40 | 0) * 3; cs.push(w.spawn(TYPE.CIV, cx + ux * t - nx * d, cy + uy * t - ny * d)); }
  let crossed = 0;
  const side = (i) => (w.A.x[i] - cx) * nx + (w.A.y[i] - cy) * ny;
  for (let k = 0; k < 500; k++) {
    w.step();
    for (const i of cs) if (side(i) > 0 && Math.abs((w.A.x[i] - cx) * ux + (w.A.y[i] - cy) * uy) < 118) crossed++;
  }
  const f = front(w, cs, wl[0], wl[1], wl[2], wl[3], 30);
  log(`residents ${deg} deg: front ${f.n} stretches, worst ${f.max.toFixed(2)} m, mean ${f.mean.toFixed(2)} m`);
  assert(crossed === 0, `${deg} deg standalone wall: 160 residents pushing at it never cross (${crossed})`);
  assert(f.n >= 10 && f.max < 1.6, `${deg} deg: residents line up along the drawn wall (worst stretch ${f.max.toFixed(2)} m, mean ${f.mean.toFixed(2)} m from the line)`);
}

// ---------------------------------------------------------------- 4. diagonal gates: residents only through the gate, zombies not at all
for (const deg of [15, 30, 45, 60]) {
  const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), at = (u, v) => [320 + u * ca - v * sa, 320 + u * sa + v * ca];
  const setup = () => {
    const w = open();
    w.exec({ t: 'zone.add', p: rot(320, 320, 70, deg) });
    const p = w.zones.polys[0].p;
    const g = w.exec({ t: 'gate.add', x: (p[4] + p[6]) / 2, y: (p[5] + p[7]) / 2 });
    w.exec({ t: 'ready' });
    clearAll(w);
    return { w, p, g, gt: w.zones.gates[0] };
  };
  // residents fanned out in front of the gate side walk in; any entry away from the gate span is a leak
  const A = setup(), w = A.w, p = A.p, gt = A.gt;
  assert(A.g.ok && A.g.opens && distToSeg(gt.x, gt.y, p[4], p[5], p[6], p[7]) < 1e-6, `${deg} deg gate sits on the drawn edge and opens onto open ground`);
  const cs = [];
  for (let k = 0; k < 150; k++) cs.push(w.spawn(TYPE.CIV, ...at(-105 + (k % 15) * 15, 82 + (k / 15 | 0) * 3)));
  w.computeFields();
  const was = new Uint8Array(w.A.cap);
  let leak = 0, entered = 0;
  for (let k = 0; k < 1800; k++) {
    w.step();
    for (const i of cs) {
      const now = pointInPoly(p, w.A.x[i], w.A.y[i]) ? 1 : 0;
      if (now && !was[i]) { entered++; if (distToSeg(w.A.x[i], w.A.y[i], gt.x0, gt.y0, gt.x1, gt.y1) > 3) leak++; }
      was[i] = now;
    }
  }
  // zombies pushed against the same gate by residents inside: the gate holds (infinite hp here)
  const B = setup(), wz = B.w, zs = [];
  for (let k = 0; k < 20; k++) wz.spawn(TYPE.CIV, ...at(-40 + (k % 10) * 8, -20 + (k / 10 | 0) * 20));
  for (let k = 0; k < 80; k++) zs.push(wz.spawn(TYPE.ZOMBIE, ...at(-20 + (k % 20) * 2, 76 + (k / 20 | 0) * 3)));
  wz.computeFields();
  let zin = 0;
  for (let k = 0; k < 900; k++) { wz.step(); for (const i of zs) if (wz.A.type[i] === TYPE.ZOMBIE && pointInPoly(B.p, wz.A.x[i], wz.A.y[i])) zin++; }
  const f = front(wz, zs, B.gt.x0, B.gt.y0, B.gt.x1, B.gt.y1, 1);
  log(`gate ${deg} deg: ${entered} entered, leaks ${leak}; zombies at the gate: ticks inside ${zin}, front ${f.n} stretches worst ${f.max.toFixed(2)} m, civilians ${wz.counts[TYPE.CIV]}, infected ${wz.stats.infected}`);
  assert(entered >= 120 && leak === 0, `${deg} deg gate: ${entered}/150 residents walked in, every one through the gate span`);
  assert(zin === 0 && wz.counts[TYPE.CIV] === 20 && f.n >= 1 && f.max < 1.6, `${deg} deg gate: 80 zombies held at the gate line (worst ${f.max.toFixed(2)} m from it)`);
}

// ---------------------------------------------------------------- 5. gate query on a generated city: buildings and closed yards are reported
{
  const map = generateCity({ seed: 11, sizeKm: 2, water: 'river', density: 0.8, stages: 4 });
  const w = new World(map, { seed: 5, stage: 1, sandbox: true });
  const g = w.grid;
  let bc = -1;
  for (let c = g.gw * 200; c < g.gw * g.gh && bc < 0; c++) if (g.terrain[c] === 2 && g.bInfo[g.bldg[c] - 1].area > 1500) bc = c;
  const b = g.bInfo[g.bldg[bc] - 1];
  const x0 = (b.bb[0] + 2) * g.cell, y0 = (b.bb[1] + 2) * g.cell, x1 = (b.bb[2] - 1) * g.cell, y1 = (b.bb[3] - 1) * g.cell;
  w.exec({ t: 'zone.add', p: rectPoly(x0 - 30, y0 - 30, x1 + 30, y1 + 30) });
  const spots = [];
  const comp = w.zones.comps[0];
  for (let s = 0; s < comp.segs.length; s += 4) for (let t = 0.1; t < 1; t += 0.2) spots.push(w.gateCheck(comp.segs[s] + (comp.segs[s + 2] - comp.segs[s]) * t, comp.segs[s + 1] + (comp.segs[s + 3] - comp.segs[s + 1]) * t));
  const good = spots.filter((s) => s.ok && s.opens).length;
  log(`gate check: ${good}/${spots.length} spots open; sample warn "${(spots.find((s) => !s.opens) || {}).warn || ''}"`);
  assert(spots.every((s) => s.ok && (s.opens || s.warn)), `gateCheck answers every spot on the wall with opens or a warning (${good}/${spots.length} open)`);
  const big = { ...OPEN, buildings: [...OPEN.buildings, { p: rectPoly(100, 100, 300, 300), h: 20, k: 'com' }] };
  const w2 = new World(big, { seed: 1, sandbox: true });
  w2.exec({ t: 'zone.add', p: rectPoly(130, 130, 270, 270) });
  const shut = w2.gateCheck(200, 130);
  assert(shut.ok && !shut.opens && /building/.test(shut.warn), `a gate on a zone drawn inside a building warns "${shut.warn}"`);
  const w3 = new World(big, { seed: 1, sandbox: true });
  w3.exec({ t: 'zone.add', p: rectPoly(280, 150, 400, 250) });
  const slid = w3.exec({ t: 'gate.add', x: 292, y: 150 });
  const g3 = w3.zones.gates[0];
  assert(slid.ok && slid.opens && g3.x1 >= 306 && g3.x > 295 && Math.abs(g3.y - 150) < 1e-6, `a gate clicked on the building part of a wall slides along it to open ground (${g3.x.toFixed(1)}, ${g3.y.toFixed(1)})`);
}

// ---------------------------------------------------------------- 6. scenario (a): a gated zone in a dense block of a generated city
// Two runs per case: "quiet" clears the outbreak near the zone (only one stunned zombie far away keeps the battle going), so
// the share inside measures walking in; "full" keeps the outbreak (undefended zones get breached) and measures stalled zombies.
// Baseline (commit b113338, same cases): quiet 0.9% / 1.5% / 4.4% inside after 30 / 60 / 120 s; full 0.9% / 1.5% / 1.3%, zombies stuck > 5 s 1.14%.
function scenarioA(quiet) {
  const agg = { a30: 0, a60: 0, a120: 0, n: 0, idle: 0, near: 0, stuck: 0, zs: 0 };
  for (const seed of [3, 11, 21, 37]) for (const rr of [0, 0.6]) {
    const map = generateCity({ seed, sizeKm: 2, water: 'river', density: 0.8, stages: 4 });
    const w = new World(map, { seed: 5, stage: 1 });
    const g = w.grid, mask = w.region.mask, bb = w.region.bbox;
    let best = null, bv = -1;
    for (let y = bb[1] + 150; y < bb[3] - 150; y += 40) for (let x = bb[0] + 150; x < bb[2] - 150; x += 40) {
      const c0 = w.cellAt(x, y);
      if (c0 < 0 || !mask[c0]) continue;
      // the zone (up to 78 m from its centre once rotated) must fit inside the stage
      if ([[-80, -80], [80, -80], [80, 80], [-80, 80], [0, -80], [80, 0], [0, 80], [-80, 0]].some(([dx, dy]) => !mask[w.cellAt(x + dx, y + dy)])) continue;
      let n = 0;
      for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) if (g.terrain[c0 + dy * g.gw + dx] === 2) n++;
      if (n > bv) { bv = n; best = [x, y]; }
    }
    const R = 55, ca = Math.cos(rr), sa = Math.sin(rr), p = [];
    for (const [u, v] of [[-R, -R], [R, -R], [R, R], [-R, R]]) p.push(best[0] + u * ca - v * sa, best[1] + u * sa + v * ca);
    w.exec({ t: 'zone.add', p });
    // in a packed block the middle of the far edge may open onto a building: take the first spot that opens to the street
    let gp = [(p[4] + p[6]) / 2, (p[5] + p[7]) / 2];
    search: for (let e = 0; e < 4; e++) for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const ax = p[(2 * e + 4) % 8], ay = p[(2 * e + 5) % 8], bx = p[(2 * e + 6) % 8], by = p[(2 * e + 7) % 8];
      const q = w.gateCheck(ax + (bx - ax) * t, ay + (by - ay) * t, 0);
      if (q && q.ok && q.opens) { gp = [ax + (bx - ax) * t, ay + (by - ay) * t]; break search; }
    }
    w.exec({ t: 'gate.add', x: gp[0], y: gp[1] });
    const gt = w.zones.gates[0];
    w.exec({ t: 'ready' });
    if (quiet) {
      let far = -1, fd = 0;
      for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE) { const d = Math.hypot(w.A.x[i] - gt.x, w.A.y[i] - gt.y); if (d > fd) { fd = d; far = i; } }
      for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.ZOMBIE && i !== far) w.remove(i);
      w.A.stun[far] = 1e9;
    }
    const inside = (i) => w.zoneId[w.cellAt(w.A.x[i], w.A.y[i])] > 0;
    const near = [];
    for (let i = 0; i < w.A.n; i++) if (w.A.type[i] === TYPE.CIV && !inside(i) && Math.hypot(w.A.x[i] - gt.x, w.A.y[i] - gt.y) <= 300) near.push(i);
    const share = () => { let k = 0; for (const i of near) if (w.A.type[i] === TYPE.CIV && inside(i)) k++; return k / Math.max(1, near.length); };
    const px = new Float32Array(w.A.cap), py = new Float32Array(w.A.cap), pz = new Uint8Array(w.A.cap);
    const nearWall = (x, y) => { const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const c = (cy + dy) * g.gw + cx + dx; if (w.block[c] && w.wallHp[c] > 0) return true; } return false; };
    const out = {};
    let idle = 0;
    for (let k = 1; k <= 2400 && w.phase === 'battle'; k++) {
      w.step();
      if (!quiet && k % 100 === 0) {
        for (let i = 0; i < w.A.n; i++) {
          const z = w.A.type[i] === TYPE.ZOMBIE;
          if (z && pz[i] && w.t > 10) {
            agg.zs++;
            if (Math.hypot(w.A.x[i] - px[i], w.A.y[i] - py[i]) < 1.5 && !nearWall(w.A.x[i], w.A.y[i]) && w.nearest(w.A.x[i], w.A.y[i], 5, (1 << TYPE.CIV) | (7 << TYPE.POLICE)) < 0 && !w.pits.length) agg.stuck++;
          }
          pz[i] = z ? 1 : 0; px[i] = w.A.x[i]; py[i] = w.A.y[i];
        }
      }
      if (k === 600) out.a30 = share();
      if (k === 1200) out.a60 = share();
      if (k === 600) for (const i of near) if (w.A.type[i] === TYPE.CIV && !inside(i) && w.A.state[i] === CS.CALM && !w.A.vx[i] && !w.A.vy[i] && w.nav.civ.dist[w.cellAt(w.A.x[i], w.A.y[i])] <= w.cfg.civ.gateLureRadius / g.cell * 10) idle++;
    }
    out.a120 = share();
    log(`${quiet ? 'quiet' : 'full'} seed ${seed} rot ${rr}: ${near.length} near, inside ${(out.a30 * 100).toFixed(0)}% / ${(out.a60 * 100).toFixed(0)}% / ${(out.a120 * 100).toFixed(0)}%, idle within lure at 30 s ${idle}, phase ${w.phase}`);
    agg.a30 += out.a30 || 0; agg.a60 += out.a60 || 0; agg.a120 += out.a120; agg.n++; agg.idle += idle; agg.near += near.length;
  }
  agg.pc = (v) => (v / agg.n * 100).toFixed(1) + '%';
  agg.stuckPct = agg.stuck / Math.max(1, agg.zs) * 100;
  return agg;
}
{
  const q = scenarioA(true), f = scenarioA(false);
  console.log(`   scenario (a) quiet: inside after 30/60/120 s ${q.pc(q.a30)} / ${q.pc(q.a60)} / ${q.pc(q.a120)} (baseline 0.9% / 1.5% / 4.4%)`);
  console.log(`   scenario (a) full outbreak: ${f.pc(f.a30)} / ${f.pc(f.a60)} / ${f.pc(f.a120)} (baseline 0.9% / 1.5% / 1.3%); zombies stuck > 5 s ${f.stuckPct.toFixed(2)}% (baseline 1.14%)`);
  assert(q.a120 / q.n > 0.2 && q.a60 / q.n > 0.03, `residents near a gated zone in a dense block walk in (${q.pc(q.a120)} inside after 120 s)`);
  assert(q.idle + f.idle <= (q.near + f.near) * 0.02, `almost no calm resident within the lure distance stands still (${q.idle + f.idle} of ${q.near + f.near})`);
  assert(f.a120 / f.n > 0.05, `with the outbreak on, residents still reach the zone (${f.pc(f.a120)} inside after 120 s)`);
  assert(f.stuckPct < 0.6, `zombies do not stall on corners or dead ends (${f.stuckPct.toFixed(2)}% stuck > 5 s)`);
}

console.log(process.exitCode ? 'movement: FAILED' : 'movement: all passed');
