// MapData -> Grid. Terrain priority (later wins): open < park < water < road/rail < bridge < building.
import { T } from '../map/format.js';
import { DEFAULTS } from '../data/config.js';
import { rasterPoly, rasterSeg, polyArea, polyCentroid, clamp } from '../util/geom.js';
import { makeDeckCollector, collectZRoad, buildDecks } from './decks.js';

export function buildGrid(map, cell = 4, cfg = DEFAULTS) {
  const gw = Math.max(1, Math.ceil(map.w / cell));
  const gh = Math.max(1, Math.ceil(map.h / cell));
  const N = gw * gh;
  const terrain = new Uint8Array(N);
  const bldg = new Int32Array(N);
  const bridgeId = new Int16Array(N);

  for (const pk of map.parks || []) if (pk.p && pk.p.length >= 6) rasterPoly(pk.p, cell, gw, gh, (c) => { terrain[c] = T.PARK; });
  for (const wt of map.water || []) if (wt.p && wt.p.length >= 6) rasterPoly(wt.p, cell, gw, gh, (c) => { terrain[c] = T.WATER; });

  const roads = map.roads || [];
  const zcol = roads.some((r) => r && r.z) ? makeDeckCollector(roads.length) : null;
  for (let ri = 0; ri < roads.length; ri++) {
    const rd = roads[ri];
    const p = rd.p;
    if (!p || p.length < 4) continue;
    const code = rd.k === 'rail' ? T.RAIL : T.ROAD;
    const isBridge = rd.k === 'bridge';
    const w = Math.max(rd.w || 6, cell);
    // Only 'bridge' roads make destructible BRIDGE cells; other roads over water (quays, untagged crossings) are plain land.
    const put = (c) => {
      const t = terrain[c];
      if (t === T.BRIDGE) return;
      if (isBridge && t === T.WATER) terrain[c] = T.BRIDGE;
      else if (code === T.ROAD || t !== T.ROAD) terrain[c] = code;
    };
    if (zcol && rd.z) { collectZRoad(zcol, ri, rd, w, cell, gw, gh, put, code === T.RAIL); continue; }
    for (let i = 0; i + 3 < p.length; i += 2) rasterSeg(p[i], p[i + 1], p[i + 2], p[i + 3], w, cell, gw, gh, put);
  }

  const B = map.buildings || [];
  for (let b = 0; b < B.length; b++) {
    const p = B[b].p;
    if (!p || p.length < 6) continue;
    let hit = 0;
    rasterPoly(p, cell, gw, gh, (c) => { terrain[c] = T.BLDG; bldg[c] = b + 1; hit++; });
    if (!hit) { // tiny footprint: claim the centroid cell
      const [x, y] = polyCentroid(p);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) {
        const c = cy * gw + cx;
        if (!bldg[c]) { terrain[c] = T.BLDG; bldg[c] = b + 1; }
      }
    }
  }

  // per-building cell lists (two-pass counting so overlapping footprints resolve to the last writer)
  const counts = new Int32Array(B.length + 1);
  for (let c = 0; c < N; c++) if (bldg[c]) counts[bldg[c]]++;
  const lists = new Array(B.length);
  for (let b = 0; b < B.length; b++) lists[b] = new Int32Array(counts[b + 1]);
  const fillPos = new Int32Array(B.length + 1);
  for (let c = 0; c < N; c++) { const k = bldg[c]; if (k) lists[k - 1][fillPos[k]++] = c; }
  const bigArea = (cfg.zone && cfg.zone.bigBldgArea) || 2000;
  const bInfo = B.map((bd, b) => {
    const p = bd.p || [0, 0, 0, 0, 0, 0];
    const [cx, cy] = polyCentroid(p);
    const cells = lists[b];
    let x0 = gw, y0 = gh, x1 = -1, y1 = -1;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], X = c % gw, Y = (c / gw) | 0;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    const area = Math.max(polyArea(p), cells.length ? cell * cell * 0.25 : 0);
    return { cx, cy, area, h: +bd.h || 6, k: bd.k || 'res', cells, big: area >= bigArea, bb: [x0, y0, x1, y1] };
  });

  // bridges: 8-connected components of BRIDGE cells
  const bridges = [];
  const stack = [];
  const bcfg = cfg.bridge || DEFAULTS.bridge;
  for (let s = 0; s < N; s++) {
    if (terrain[s] !== T.BRIDGE || bridgeId[s]) continue;
    const id = bridges.length + 1;
    const cells = [];
    bridgeId[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const X = c % gw, Y = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = X + dx, ny = Y + dy;
        if ((dx | dy) === 0 || nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (terrain[n] === T.BRIDGE && !bridgeId[n]) { bridgeId[n] = id; stack.push(n); }
      }
    }
    cells.sort((a, b) => a - b);
    bridges.push(measureBridge(cells, gw, cell, bcfg));
  }

  // water bodies: 4-connected WATER+BRIDGE cells (ships pass under bridges)
  const wid = new Int32Array(N);
  const warea = [0];
  const isWet = (c) => terrain[c] === T.WATER || terrain[c] === T.BRIDGE;
  for (let s = 0; s < N; s++) {
    if (!isWet(s) || wid[s]) continue;
    const id = warea.length;
    let n = 0;
    wid[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); n++;
      const X = c % gw, Y = (c / gw) | 0;
      if (X > 0 && !wid[c - 1] && isWet(c - 1)) { wid[c - 1] = id; stack.push(c - 1); }
      if (X < gw - 1 && !wid[c + 1] && isWet(c + 1)) { wid[c + 1] = id; stack.push(c + 1); }
      if (Y > 0 && !wid[c - gw] && isWet(c - gw)) { wid[c - gw] = id; stack.push(c - gw); }
      if (Y < gh - 1 && !wid[c + gw] && isWet(c + gw)) { wid[c + gw] = id; stack.push(c + gw); }
    }
    warea.push(n * cell * cell);
  }

  const masks = new Map();
  const levels = map.levels || [];
  function levelMask(idx) {
    idx = levels.length ? clamp(idx | 0, 0, levels.length - 1) : 0;
    if (masks.has(idx)) return masks.get(idx);
    const m = new Uint8Array(N);
    if (!levels.length || !levels[idx].p || levels[idx].p.length < 6) m.fill(1);
    else {
      rasterPoly(levels[idx].p, cell, gw, gh, (c) => { m[c] = 1; });
      if (idx > 0) { const prev = levelMask(idx - 1); for (let c = 0; c < N; c++) m[c] |= prev[c]; }
    }
    masks.set(idx, m);
    return m;
  }

  // multi-level roads: decks and tunnels (null on flat maps); deck structures follow the water bridges in `bridges`
  const deck = zcol ? buildDecks(map, { gw, gh, cell, terrain, bridges }, zcol, cfg) : null;
  return { cell, gw, gh, terrain, bldg, bridgeId, bInfo, bridges, waterBodies: { id: wid, area: warea }, levelMask, deck };
}

function measureBridge(cells, gw, cell, bcfg) {
  let mx = 0, my = 0;
  const n = cells.length;
  for (const c of cells) { mx += c % gw; my += (c / gw) | 0; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const c of cells) { const dx = c % gw - mx, dy = ((c / gw) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (const c of cells) { const pr = (c % gw - mx) * ux + (((c / gw) | 0) - my) * uy; if (pr < lo) lo = pr; if (pr > hi) hi = pr; }
  const len = (hi - lo + 1) * cell;
  const width = Math.max(cell, n * cell * cell / len);
  const hpMax = Math.round(clamp(bcfg.hpPerM * len + bcfg.hpPerWidthM * width, bcfg.hpMin, bcfg.hpMax));
  return { cells: Int32Array.from(cells), len, width, cx: (mx + 0.5) * cell, cy: (my + 0.5) * cell, hpMax };
}
