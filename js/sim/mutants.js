// Mosh pits and mutant zombies (explosive, shielded, swimmer, giant).
import { ZOMBIE, M_ZOMBIE, ZSUB, SUB_KEYS, removeAgent } from './agents.js';
import { damageArea } from './structures.js';

const LABEL = { explosive: 'EXPLOSIVE', shielded: 'ARMOURED', swimmer: 'SWIMMER', giant: 'GIANT' };

export function resetMutants(world) {
  world.pits = [];
  world._nextPitAt = world.cfg.mutation.firstSec;
  world._pitId = 1;
}

// tier: where the explosive mutant stood (a deck or tunnel blast stays on its own tier, see damageArea)
export function explodeAt(world, x, y, src = 'explosive', tier = 0) {
  const k = world.cfg.mutation.kinds.explosive;
  world.effects.push({ kind: 'boom', x, y, r: k.blastRadius, t0: world.t, dur: 0.7 });
  world.events.emit('sound', { name: 'explosion', x, y, vol: 0.8 });
  damageArea(world, x, y, k.blastRadius, k.blastDmg, { src, friendly: true, wallDmg: k.wallDmg, tier });
}

function densest(world) {
  const sh = world.sh, blk = sh.blkZ, bw = sh.bzw, bh = sh.bzh;
  let best = -1, bestN = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx, y = by + dy;
      if (x >= 0 && y >= 0 && x < bw && y < bh) s += blk[y * bw + x];
    }
    if (s > bestN) { bestN = s; best = by * bw + bx; }
  }
  if (best < 0) return null;
  const cx = (best % bw + 0.5) * sh.bz, cy = (((best / bw) | 0) + 0.5) * sh.bz;
  let sx = 0, sy = 0, n = 0;
  const A = world.A;
  world.query(cx, cy, sh.bz * 1.5, M_ZOMBIE, (i) => { if (!A.sub[i]) { sx += A.x[i]; sy += A.y[i]; n++; } }, 0);
  return n ? { x: sx / n, y: sy / n, n } : null;
}

function resolvePit(world, pit) {
  const mc = world.cfg.mutation, A = world.A;
  const near = [];
  world.query(pit.x, pit.y, pit.r, M_ZOMBIE, (i, d2) => { if (!A.sub[i]) near.push([d2, i]); }, 0);
  if (near.length < mc.pitMin) {
    world.events.emit('log', { msg: 'MOSH PIT DISPERSED', kind: 'info', x: pit.x, y: pit.y });
    return;
  }
  near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const kinds = Object.keys(mc.kinds).filter((k) => SUB_KEYS.includes(k) && (mc.kinds[k].weight || 0) > 0);
  if (!kinds.length) return;
  const kind = world.rng.weighted(kinds, (k) => mc.kinds[k].weight);
  if (kind === 'giant' && near.length < (mc.kinds.giant.merge || 1)) return;
  const sub = SUB_KEYS.indexOf(kind);
  const i = near[0][1];
  if (kind === 'giant') {
    const m = Math.min(near.length, mc.kinds.giant.merge || 1);
    for (let k = 1; k < m; k++) removeAgent(world, near[k][1]);
  }
  A.sub[i] = sub;
  A.hp[i] = 1;
  A.shield[i] = sub === ZSUB.SHIELDED ? mc.kinds.shielded.shield : 0;
  world.stats.mutants++;
  world.events.emit('mutation', { x: A.x[i], y: A.y[i], kind });
  world.events.emit('log', { msg: `MUTANT: ${LABEL[kind] || kind.toUpperCase()}`, kind: 'alert', x: A.x[i], y: A.y[i] });
  world.events.emit('sound', { name: 'mutant', x: A.x[i], y: A.y[i], vol: 0.9 });
}

export function mutantSystem(world) {
  if (world.tick % 10 !== 0) return;
  const mc = world.cfg.mutation;
  if (world.t >= world._nextPitAt) {
    const iv = mc.intervalSec;
    world._nextPitAt = world.t + (Array.isArray(iv) ? world.rng.range(iv[0], iv[1]) : +iv || 60);
    const d = world.counts[ZOMBIE] >= mc.pitMin ? densest(world) : null;
    if (d && d.n >= mc.pitMin) {
      const pit = { id: world._pitId++, x: d.x, y: d.y, r: mc.pitRadius, t0: world.t, endsAt: world.t + mc.pitSec };
      world.pits.push(pit);
      world.events.emit('pit', { x: pit.x, y: pit.y, endsAt: pit.endsAt });
      world.events.emit('log', { msg: 'ZOMBIES ARE MUTATING', kind: 'alert', x: pit.x, y: pit.y });
    }
  }
  if (!world.pits.length) return;
  const keep = [];
  for (const p of world.pits) { if (world.t >= p.endsAt) resolvePit(world, p); else keep.push(p); }
  world.pits = keep;
}
