// Editor document: the map being drafted, undo/redo of item-level operations, hit testing and snapping.
// DOM-free so it runs in node tests.
import { normalizeMap, clipPolyRect, clipLineRect, LIMITS, Z_MIN, Z_MAX } from '../map/format.js';
import { polyBBox, polyCentroid, pointInPoly, distToPolyline, clamp } from '../util/geom.js';

export const COLLS = ['roads', 'water', 'parks', 'buildings', 'levels', 'spawns'];
export const DRAWN_COLLS = new Set(['roads', 'water', 'parks', 'buildings']);
export const COLL_LABEL = { roads: 'Road', water: 'Water', parks: 'Park', buildings: 'Building', levels: 'Stage', spawns: 'Outbreak point' };

const r1 = v => Math.round(v * 10) / 10;
export const cloneItem = it => (Array.isArray(it) ? it.slice() : it && typeof it === 'object'
  ? (it.z ? { ...it, p: it.p ? it.p.slice() : it.p, z: it.z.slice() } : { ...it, p: it.p ? it.p.slice() : it.p }) : it);
const cloneList = l => l.map(cloneItem);

export function cloneMap(m) {
  const o = { ...m };
  for (const c of COLLS) o[c] = cloneList(m[c] || []);
  if (m.geo) o.geo = { ...m.geo };
  return o;
}

export function itemBBox(coll, it) {
  if (coll === 'spawns') return [it[0], it[1], it[0], it[1]];
  const b = polyBBox(it.p);
  if (coll === 'roads') { const m = (it.w || 6) / 2; b[0] -= m; b[1] -= m; b[2] += m; b[3] += m; }
  return b;
}

export function itemCentre(coll, it) {
  if (coll === 'spawns') return [it[0], it[1]];
  if (coll === 'roads') {
    const p = it.p;
    let len = 0;
    for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    let half = len / 2;
    for (let i = 2; i < p.length; i += 2) {
      const l = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      if (half <= l && l > 0) { const t = half / l; return [p[i - 2] + (p[i] - p[i - 2]) * t, p[i - 1] + (p[i + 1] - p[i - 1]) * t]; }
      half -= l;
    }
    return [p[0], p[1]];
  }
  return polyCentroid(it.p);
}

export function polylineLength(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

export function translated(coll, it, dx, dy) {
  if (coll === 'spawns') return [r1(it[0] + dx), r1(it[1] + dy)];
  const o = cloneItem(it);
  for (let i = 0; i < o.p.length; i += 2) { o.p[i] = r1(o.p[i] + dx); o.p[i + 1] = r1(o.p[i + 1] + dy); }
  return o;
}

export function rotated(coll, it, ang, cx, cy) {
  if (coll === 'spawns') return it.slice();
  const o = cloneItem(it), c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < o.p.length; i += 2) {
    const x = o.p[i] - cx, y = o.p[i + 1] - cy;
    o.p[i] = r1(cx + x * c - y * s); o.p[i + 1] = r1(cy + x * s + y * c);
  }
  return o;
}

// ---------------------------------------------------------------- road heights
// Every edit of a road's nodes keeps its heights (z, one per node) in step.
const zr = (v) => clamp(Math.round(v * 10) / 10, Z_MIN, Z_MAX);
const tidyZ = (o) => { if (o.z && !o.z.some((v) => v !== 0)) delete o.z; return o; };

// A copy of road `it` with a node at (x, y) after the node at offset k; its height is interpolated.
export function insertVertex(it, k, x, y) {
  const o = cloneItem(it), p = o.p;
  p.splice(k + 2, 0, r1(x), r1(y));
  if (o.z) {
    const i = k >> 1, ax = p[k], ay = p[k + 1], bx = p[k + 4], by = p[k + 5];
    const L = Math.hypot(bx - ax, by - ay), t = L > 0 ? Math.hypot(x - ax, y - ay) / L : 0.5;
    o.z.splice(i + 1, 0, zr(o.z[i] + ((o.z[i + 1] ?? o.z[i]) - o.z[i]) * clamp(t, 0, 1)));
  }
  return o;
}

// A copy of road `it` without the node at offset k (and its height).
export function removeVertex(it, k) {
  const o = cloneItem(it);
  o.p.splice(k, 2);
  if (o.z) o.z.splice(k >> 1, 1);
  return tidyZ(o);
}

// Every node of the road at height z (0: on the ground).
export function setRoadLevel(it, z) {
  const o = cloneItem(it);
  if (!z) delete o.z; else o.z = new Array(o.p.length >> 1).fill(zr(z));
  return o;
}

// The road slopes from its height down (or up) to zEnd over its first (end 0) or last (end 1) len metres:
// a node is inserted where the slope starts and the end node takes zEnd.
export function addRamp(it, end, len, zEnd = 0) {
  let o = cloneItem(it);
  if (!o.z) o.z = new Array(o.p.length >> 1).fill(0);
  if (end) { o = reversedRoad(o); }
  const p = o.p, n = p.length >> 1;
  let acc = 0, k = 1;
  for (; k < n; k++) { const l = Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]); if (acc + l >= len) break; acc += l; }
  if (k < n) {
    const l = Math.hypot(p[2 * k] - p[2 * k - 2], p[2 * k + 1] - p[2 * k - 1]), f = l > 0 ? (len - acc) / l : 0;
    if (f > 0.02 && f < 0.98) o = insertVertex(o, 2 * (k - 1), p[2 * k - 2] + (p[2 * k] - p[2 * k - 2]) * f, p[2 * k - 1] + (p[2 * k + 1] - p[2 * k - 1]) * f);
  }
  const q = o.p, m = q.length >> 1, top = o.z[Math.min(m - 1, k)];
  let s = 0;
  o.z[0] = zr(zEnd);
  for (let j = 1; j < m; j++) {
    s += Math.hypot(q[2 * j] - q[2 * j - 2], q[2 * j + 1] - q[2 * j - 1]);
    if (s >= len - 0.05) break;
    o.z[j] = zr(zEnd + (top - zEnd) * s / len);
  }
  if (end) o = reversedRoad(o);
  return tidyZ(o);
}

function reversedRoad(o) {
  const p = o.p, n = p.length >> 1, q = new Array(p.length);
  for (let i = 0; i < n; i++) { q[2 * i] = p[2 * (n - 1 - i)]; q[2 * i + 1] = p[2 * (n - 1 - i) + 1]; }
  const r = { ...o, p: q };
  if (o.z) r.z = o.z.slice().reverse();
  return r;
}

const boxUnion = (a, b) => (!a ? b.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

// ---------------------------------------------------------------- spatial index (bbox buckets)

class BoxIndex {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.boxes = []; }
  static build(items, boxFn, cell = 64) {
    const ix = new BoxIndex(cell);
    for (let i = 0; i < items.length; i++) ix.add(i, boxFn(items[i]));
    return ix;
  }
  add(i, b) {
    this.boxes[i] = b;
    const c = this.cell;
    const x0 = Math.floor(b[0] / c), y0 = Math.floor(b[1] / c), x1 = Math.floor(b[2] / c), y1 = Math.floor(b[3] / c);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { this._big = this._big || []; this._big.push(i); return; }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * 65536 + x;
      let l = this.map.get(k);
      if (!l) this.map.set(k, l = []);
      l.push(i);
    }
  }
  query(x0, y0, x1, y1, fn) {
    const c = this.cell, seen = new Set();
    const a = Math.floor(x0 / c), b = Math.floor(y0 / c), e = Math.floor(x1 / c), f = Math.floor(y1 / c);
    const visit = i => {
      if (seen.has(i)) return;
      seen.add(i);
      const bb = this.boxes[i];
      if (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) return;
      fn(i);
    };
    if ((e - a + 1) * (f - b + 1) > 20000) { for (let i = 0; i < this.boxes.length; i++) visit(i); return; }
    for (let y = b; y <= f; y++) for (let x = a; x <= e; x++) { const l = this.map.get(y * 65536 + x); if (l) for (const i of l) visit(i); }
    if (this._big) for (const i of this._big) visit(i);
  }
}

// ---------------------------------------------------------------- document

export class EditorDoc {
  constructor(map) {
    this.map = cloneMap(normalizeMap(map));
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
    this.savedVersion = 0;
    this.libId = null;
    this._group = null;
    this._listeners = [];
    this._ix = null;
    this._ixVersion = -1;
  }

  get dirty() { return this.version !== this.savedVersion; }
  markSaved() { this.savedVersion = this.version; }
  onChange(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter(f => f !== fn); }; }

  _emit(info) { for (const fn of this._listeners) fn(info); }

  // ---- low-level op application
  _apply(op, forward) {
    const m = this.map;
    this._seq = (this._seq || 0) + 1;
    const info = { coll: op.coll, rect: null, full: false };
    switch (op.type) {
      case 'ins': {
        const arr = m[op.coll];
        if (forward) arr.splice(op.idx, 0, cloneItem(op.b)); else arr.splice(op.idx, 1);
        info.rect = itemBBox(op.coll, op.b);
        info.structural = true;
        break;
      }
      case 'del': {
        const arr = m[op.coll];
        if (forward) arr.splice(op.idx, 1); else arr.splice(op.idx, 0, cloneItem(op.a));
        info.rect = itemBBox(op.coll, op.a);
        info.structural = true;
        break;
      }
      case 'set': {
        m[op.coll][op.idx] = cloneItem(forward ? op.b : op.a);
        info.rect = boxUnion(itemBBox(op.coll, op.a), itemBBox(op.coll, op.b));
        break;
      }
      case 'coll': {
        m[op.coll] = cloneList(forward ? op.b : op.a);
        info.full = DRAWN_COLLS.has(op.coll);
        info.structural = true;
        break;
      }
      case 'meta': {
        m[op.key] = forward ? op.b : op.a;
        info.meta = op.key;
        if (op.key === 'w' || op.key === 'h') info.full = true;
        break;
      }
      case 'all': {
        const src = forward ? op.b : op.a;
        for (const k of Object.keys(m)) delete m[k];
        Object.assign(m, cloneMap(src));
        info.full = true;
        info.structural = true;
        info.meta = '*';
        break;
      }
    }
    return info;
  }

  _record(op) {
    const info = this._apply(op, true);
    if (this._group) { this._group.ops.push(op); this._group.infos.push(info); }
    else this._push({ label: '', ops: [op] }, [info]);
    return info;
  }

  _push(group, infos, mergeKey) {
    const top = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    const sameShape = () => top.ops.length === group.ops.length && top.ops.every((op, i) => {
      const o = group.ops[i];
      return op.type === o.type && (op.type === 'set' || op.type === 'meta') && op.coll === o.coll && op.idx === o.idx && op.key === o.key;
    });
    if (mergeKey && top && top.mergeKey === mergeKey && now - top.at < 1500 && sameShape() && this.redoStack.length === 0) {
      top.ops.forEach((op, i) => { op.b = group.ops[i].b; });
      top.at = now;
    } else {
      group.at = now;
      group.mergeKey = mergeKey || null;
      this.undoStack.push(group);
      if (this.undoStack.length > 400) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.version++;
    this._emit({ infos, label: group.label });
  }

  // Groups every op until end() into one undo step.
  begin(label = '', mergeKey = null) {
    if (this._group) { this._group.depth++; return; }
    this._group = { label, ops: [], infos: [], depth: 1, mergeKey };
  }
  end() {
    const g = this._group;
    if (!g) return;
    if (--g.depth > 0) return;
    this._group = null;
    if (g.ops.length) this._push({ label: g.label, ops: g.ops }, g.infos, g.mergeKey);
  }
  transact(label, fn, mergeKey) { this.begin(label, mergeKey); try { return fn(); } finally { this.end(); } }

  insert(coll, item, idx = this.map[coll].length) {
    this._record({ type: 'ins', coll, idx, b: cloneItem(item) });
    return idx;
  }
  remove(coll, idx) {
    const a = this.map[coll][idx];
    if (a === undefined) return;
    this._record({ type: 'del', coll, idx, a: cloneItem(a) });
  }
  // Removes many items of mixed collections; refs = [{coll, idx}]. Highest indices first so the others stay valid.
  removeMany(refs, label = 'Delete') {
    const sorted = refs.slice().sort((a, b) => (a.coll === b.coll ? b.idx - a.idx : a.coll < b.coll ? -1 : 1));
    this.transact(label, () => { for (const r of sorted) this.remove(r.coll, r.idx); });
  }
  set(coll, idx, item, mergeKey) {
    const a = this.map[coll][idx];
    if (a === undefined) return;
    const op = { type: 'set', coll, idx, a: cloneItem(a), b: cloneItem(item) };
    if (mergeKey && !this._group) { const info = this._apply(op, true); this._push({ label: 'Edit', ops: [op] }, [info], mergeKey); return; }
    this._record(op);
  }
  // Patch fields of an item (not its points).
  patch(coll, idx, fields, mergeKey) {
    const a = this.map[coll][idx];
    if (!a) return;
    const b = { ...cloneItem(a), ...fields };
    for (const k of Object.keys(fields)) if (fields[k] === undefined || fields[k] === '') delete b[k];
    this.set(coll, idx, b, mergeKey);
  }
  setColl(coll, list, label = 'Edit') {
    this.transact(label, () => this._record({ type: 'coll', coll, a: cloneList(this.map[coll]), b: cloneList(list) }));
  }
  setMeta(key, value, mergeKey) {
    if (this.map[key] === value) return;
    const op = { type: 'meta', key, a: this.map[key], b: value };
    if (mergeKey && !this._group) { const info = this._apply(op, true); this._push({ label: 'Sheet', ops: [op] }, [info], mergeKey); return; }
    this._record(op);
  }
  replaceAll(newMap, label = 'Replace') {
    this.transact(label, () => this._record({ type: 'all', a: cloneMap(this.map), b: cloneMap(newMap) }));
  }

  // Live edits (drags) mutate in place without undo; commitLive records one undo step from the saved "before".
  liveSet(coll, idx, item) {
    const before = this.map[coll][idx];
    this.map[coll][idx] = item;
    this._liveVersion = (this._liveVersion || 0) + 1;
    return before;
  }
  commitLive(edits, label = 'Move') {
    // edits: [{coll, idx, before}] - current map value is the "after"
    const ops = [], infos = [];
    for (const e of edits) {
      const after = this.map[e.coll][e.idx];
      if (JSON.stringify(after) === JSON.stringify(e.before)) continue;
      const op = { type: 'set', coll: e.coll, idx: e.idx, a: cloneItem(e.before), b: cloneItem(after) };
      ops.push(op);
      infos.push({ coll: e.coll, rect: boxUnion(itemBBox(e.coll, e.before), itemBBox(e.coll, after)) });
    }
    if (ops.length) this._push({ label, ops }, infos);
    return ops.length > 0;
  }
  revertLive(edits) {
    for (const e of edits) this.map[e.coll][e.idx] = cloneItem(e.before);
    this._liveVersion = (this._liveVersion || 0) + 1;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return null;
    const infos = [];
    for (let i = g.ops.length - 1; i >= 0; i--) infos.push(this._apply(g.ops[i], false));
    this.redoStack.push(g);
    this.version++;
    this._emit({ infos, label: g.label, undo: true });
    return g;
  }
  redo() {
    const g = this.redoStack.pop();
    if (!g) return null;
    const infos = g.ops.map(op => this._apply(op, true));
    this.undoStack.push(g);
    this.version++;
    this._emit({ infos, label: g.label, redo: true });
    return g;
  }

  // ---- spatial queries
  index() {
    const v = (this._seq || 0) * 1e6 + (this._liveVersion || 0);
    if (this._ix && this._ixVersion === v) return this._ix;
    const m = this.map;
    this._ix = {
      buildings: BoxIndex.build(m.buildings, it => itemBBox('buildings', it)),
      roads: BoxIndex.build(m.roads, it => itemBBox('roads', it)),
      water: BoxIndex.build(m.water, it => itemBBox('water', it), 128),
      parks: BoxIndex.build(m.parks, it => itemBBox('parks', it), 128),
    };
    this._ixVersion = v;
    return this._ix;
  }

  // Items under (x, y), topmost first. tol = pick tolerance in metres.
  pickAll(x, y, tol, filter = null) {
    const m = this.map, out = [];
    const want = c => !filter || filter.has(c);
    if (want('spawns')) m.spawns.forEach((s, i) => { const d = Math.hypot(s[0] - x, s[1] - y); if (d <= tol * 1.6) out.push({ coll: 'spawns', idx: i, d, pri: 0 }); });
    const ix = this.index();
    if (want('buildings')) {
      const hits = [];
      ix.buildings.query(x - tol, y - tol, x + tol, y + tol, i => {
        const p = m.buildings[i].p;
        if (pointInPoly(p, x, y)) hits.push({ coll: 'buildings', idx: i, d: 0, pri: 1 });
        else { const d = distToPolyline(p, x, y, true); if (d <= tol * 0.6) hits.push({ coll: 'buildings', idx: i, d, pri: 1 }); }
      });
      hits.sort((a, b) => a.d - b.d || b.idx - a.idx);
      out.push(...hits);
    }
    if (want('roads')) {
      const hits = [];
      ix.roads.query(x - tol, y - tol, x + tol, y + tol, i => {
        const r = m.roads[i], d = distToPolyline(r.p, x, y);
        if (d <= r.w / 2 + tol) hits.push({ coll: 'roads', idx: i, d: Math.max(0, d - r.w / 2), pri: 2 });
      });
      hits.sort((a, b) => a.d - b.d || b.idx - a.idx);
      out.push(...hits);
    }
    for (const [coll, pri] of [['parks', 3], ['water', 4]]) {
      if (!want(coll)) continue;
      const hits = [];
      ix[coll].query(x - tol, y - tol, x + tol, y + tol, i => {
        const p = m[coll][i].p;
        if (pointInPoly(p, x, y) || distToPolyline(p, x, y, true) <= tol * 0.6) hits.push({ coll, idx: i, d: 0, pri });
      });
      hits.sort((a, b) => b.idx - a.idx);
      out.push(...hits);
    }
    out.sort((a, b) => a.pri - b.pri || a.d - b.d);
    return out;
  }

  pick(x, y, tol, filter) { return this.pickAll(x, y, tol, filter)[0] || null; }

  // Items whose bbox lies fully inside the box (or whose point is inside, for outbreak points).
  pickBox(x0, y0, x1, y1, filter = null) {
    const m = this.map, out = [];
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    const ix = this.index();
    const inside = b => b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1;
    for (const coll of ['buildings', 'roads', 'parks', 'water']) {
      if (filter && !filter.has(coll)) continue;
      ix[coll].query(x0, y0, x1, y1, i => { if (inside(ix[coll].boxes[i])) out.push({ coll, idx: i }); });
    }
    if (!filter || filter.has('spawns')) m.spawns.forEach((s, i) => { if (s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1) out.push({ coll: 'spawns', idx: i }); });
    return out;
  }

  // Nearest vertex of a polygonal item to (x, y) within tol: { k (point offset), d }.
  vertexAt(coll, idx, x, y, tol) {
    const it = this.map[coll][idx];
    if (!it || coll === 'spawns') return null;
    const p = it.p;
    let best = null;
    for (let k = 0; k < p.length; k += 2) {
      const d = Math.hypot(p[k] - x, p[k + 1] - y);
      if (d <= tol && (!best || d < best.d)) best = { k, d };
    }
    return best;
  }

  // Nearest edge: { k (offset of the segment start), t, x, y, d }.
  edgeAt(coll, idx, x, y, tol) {
    const it = this.map[coll][idx];
    if (!it || coll === 'spawns') return null;
    const p = it.p, n = p.length, closed = coll !== 'roads';
    const last = closed ? n : n - 2;
    let best = null;
    for (let k = 0; k < last; k += 2) {
      const j = (k + 2) % n;
      const ax = p[k], ay = p[k + 1], bx = p[j], by = p[j + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
      const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(x - qx, y - qy);
      if (d <= tol && (!best || d < best.d)) best = { k, t, x: qx, y: qy, d };
    }
    return best;
  }
}

// ---------------------------------------------------------------- snapping

// Snap (x, y) to road nodes, then road edges, then corners of polygons, within tol metres.
// opts: { roads = true, polys = true, edges = true, exclude: {coll, idx} }
export function findSnap(doc, x, y, tol, opts = {}) {
  const m = doc.map, ix = doc.index();
  let best = null;
  const consider = (kind, sx, sy, pri) => {
    const d = Math.hypot(sx - x, sy - y);
    if (d > tol) return;
    const score = d + pri * tol * 0.35;
    if (!best || score < best.score) best = { kind, x: sx, y: sy, d, score };
  };
  const ex = opts.exclude;
  if (opts.roads !== false) {
    ix.roads.query(x - tol, y - tol, x + tol, y + tol, i => {
      if (ex && ex.coll === 'roads' && ex.idx === i) return;
      const p = m.roads[i].p;
      for (let k = 0; k < p.length; k += 2) consider('node', p[k], p[k + 1], 0);
      if (opts.edges !== false) {
        for (let k = 2; k < p.length; k += 2) {
          const ax = p[k - 2], ay = p[k - 1], bx = p[k], by = p[k + 1];
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          if (!l2) continue;
          const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
          consider('edge', ax + dx * t, ay + dy * t, 1);
        }
      }
    });
  }
  if (opts.polys !== false) {
    for (const coll of ['buildings', 'water', 'parks']) {
      ix[coll].query(x - tol, y - tol, x + tol, y + tol, i => {
        if (ex && ex.coll === coll && ex.idx === i) return;
        const p = m[coll][i].p;
        for (let k = 0; k < p.length; k += 2) consider('corner', p[k], p[k + 1], 0.5);
        if (opts.edges !== false && coll !== 'buildings') {
          for (let k = 0; k < p.length; k += 2) {
            const j = (k + 2) % p.length;
            const ax = p[k], ay = p[k + 1], dx = p[j] - ax, dy = p[j + 1] - ay, l2 = dx * dx + dy * dy;
            if (!l2) continue;
            const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
            consider('edge', ax + dx * t, ay + dy * t, 1.5);
          }
        }
      });
    }
  }
  if (opts.extra) for (const [sx, sy] of opts.extra) consider('node', sx, sy, -0.5);
  return best;
}

// Constrain (x, y) relative to (ax, ay) to multiples of 15 degrees.
export function constrainAngle(ax, ay, x, y, stepDeg = 15) {
  const dx = x - ax, dy = y - ay, L = Math.hypot(dx, dy);
  if (!L) return [x, y];
  const st = stepDeg * Math.PI / 180;
  const a = Math.round(Math.atan2(dy, dx) / st) * st;
  return [ax + Math.cos(a) * L, ay + Math.sin(a) * L];
}

// ---------------------------------------------------------------- resize

// Crops / extends the sheet to w x h metres (anchored top-left); geometry outside is clipped away.
export function resizedMap(map, w, h) {
  w = clamp(Math.round(w), LIMITS.minSize, LIMITS.maxSize);
  h = clamp(Math.round(h), LIMITS.minSize, LIMITS.maxSize);
  const o = cloneMap(map);
  o.w = w; o.h = h;
  const polys = list => list.map(it => ({ ...it, p: clipPolyRect(it.p, 0, 0, w, h) })).filter(it => it.p.length >= 6);
  o.water = polys(o.water);
  o.parks = polys(o.parks);
  o.buildings = polys(o.buildings);
  o.roads = o.roads.flatMap(r => (r.z ? clipLineRect(r.p, 0, 0, w, h, r.z).map(c => tidyZ({ ...r, p: c.p, z: c.z.map(zr) }))
    : clipLineRect(r.p, 0, 0, w, h).map(p => ({ ...r, p }))));
  o.levels = o.levels.map((l, i) => {
    const wasFull = isFullSheet(l.p, map.w, map.h) || i === map.levels.length - 1;
    const p = wasFull ? [0, 0, w, 0, w, h, 0, h] : clipPolyRect(l.p, 0, 0, w, h);
    return { ...l, p: p.length >= 6 ? p : [0, 0, w, 0, w, h, 0, h] };
  });
  o.spawns = o.spawns.filter(s => s[0] <= w && s[1] <= h);
  return o;
}

export function isFullSheet(p, w, h) {
  if (!p || p.length < 6) return false;
  const b = polyBBox(p);
  return b[0] <= 1 && b[1] <= 1 && b[2] >= w - 1 && b[3] >= h - 1 && p.length <= 10;
}

// Rectangle polygon from two corners; returns clockwise-on-screen order like the generators.
export function rectFrom(x0, y0, x1, y1) {
  const a = Math.min(x0, x1), b = Math.min(y0, y1), c = Math.max(x0, x1), d = Math.max(y0, y1);
  return [r1(a), r1(b), r1(c), r1(b), r1(c), r1(d), r1(a), r1(d)];
}

