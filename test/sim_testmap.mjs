// Hand-made grid city for SIM tests: square blocks of four buildings, optional river with bridges, nested stages.
import { rectPoly } from '../js/util/geom.js';

export function makeTestMap({ size = 800, spacing = 100, river = false, stages = 3, seed = 1234, name = 'Test Grid' } = {}) {
  const w = size, h = size;
  const roads = [], buildings = [], water = [], parks = [];
  const riverY0 = Math.round(h * 0.5) - 14, riverY1 = riverY0 + 28;
  if (river) water.push({ p: rectPoly(0, riverY0, w, riverY1) });
  for (let x = spacing / 2; x < w; x += spacing) {
    if (!river) { roads.push({ p: [x, 6, x, h - 6], w: 10, k: 'minor' }); continue; }
    roads.push({ p: [x, 6, x, riverY0 - 4], w: 10, k: 'minor' }, { p: [x, riverY0 - 6, x, riverY1 + 6], w: 10, k: 'bridge' }, { p: [x, riverY1 + 4, x, h - 6], w: 10, k: 'minor' });
  }
  for (let y = spacing / 2; y < h; y += spacing) {
    if (river && y > riverY0 - 10 && y < riverY1 + 10) continue;
    roads.push({ p: [6, y, w - 6, y], w: 10, k: 'minor' });
  }
  let n = 0;
  const kinds = ['civic', 'trade', 'armory', 'rescue', 'hazard'];
  for (let bx = spacing / 2; bx + spacing <= w; bx += spacing) {
    for (let by = spacing / 2; by + spacing <= h; by += spacing) {
      const x0 = bx + 8, y0 = by + 8, s = (spacing - 16 - 8) / 2;
      for (let k = 0; k < 4; k++) {
        const ox = x0 + (k & 1) * (s + 8), oy = y0 + (k >> 1) * (s + 8);
        if (river && oy + s > riverY0 - 2 && oy < riverY1 + 2) continue;
        const hgt = 8 + ((n * 37) % 23);
        let kind = n % 5 === 0 ? 'com' : 'res';
        if (n % 29 === 7) kind = kinds[(n / 29 | 0) % kinds.length];
        buildings.push({ p: rectPoly(ox, oy, ox + s, oy + s), h: hgt, k: kind, use: kind });
        n++;
      }
    }
  }
  parks.push({ p: rectPoly(w - 90, 10, w - 10, 40) });
  const levels = [];
  for (let k = 0; k < stages; k++) {
    if (k === stages - 1) { levels.push({ p: rectPoly(0, 0, w, h), label: `Stage ${k + 1}` }); break; }
    const r = (w / 2) * (0.35 + 0.6 * k / Math.max(1, stages - 1));
    levels.push({ p: rectPoly(w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r), label: `Stage ${k + 1}` });
  }
  return { format: 'rcmap', v: 1, name, author: 'tests', desc: '', welcome: '', source: 'editor', seed, geo: null, palette: 'paper', w, h, roads, water, parks, buildings, levels, spawns: [] };
}

// Block-aligned rectangle helper: returns a zone polygon covering whole blocks [bx0..bx1] x [by0..by1] (block indices).
export function blockRect(bx0, by0, bx1, by1, spacing = 100, pad = 3) {
  const x0 = spacing / 2 + bx0 * spacing + pad, y0 = spacing / 2 + by0 * spacing + pad;
  const x1 = spacing / 2 + (bx1 + 1) * spacing - pad, y1 = spacing / 2 + (by1 + 1) * spacing - pad;
  return rectPoly(x0, y0, x1, y1);
}

export function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('ok -', msg);
}
