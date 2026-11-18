// Editor tools. Each tool gets pointer events in world metres (ev.x, ev.y) and screen px (ev.sx, ev.sy)
// and draws its own preview in screen space. `ed` is the editor context built in editor.js.
import { cloneItem, translated, rotated, rectFrom, findSnap, constrainAngle, polylineLength, itemBBox, COLL_LABEL } from './editor_model.js';
import { tracePath, handle, label, fmtM, fmtM2, outlineItem, vertexHandles, drawSpawn } from './editor_render.js';
import { polyArea } from '../util/geom.js';
import { DEFAULT_USE } from '../map/format.js';

const r1 = v => Math.round(v * 10) / 10;
const MIN_PTS = { roads: 4, water: 6, parks: 6, buildings: 6, levels: 6 };
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Snapped, angle-constrained, sheet-clamped world point for a drawing click.
function point(ed, ev, from = null, opts = {}) {
  let x = ev.x, y = ev.y, snap = null;
  if (from && ev.shift) [x, y] = constrainAngle(from[0], from[1], x, y);
  else if (ed.opts.snap && !ev.alt) {
    snap = findSnap(ed.doc, x, y, ed.px(10), opts);
    if (snap) { x = snap.x; y = snap.y; }
  }
  const m = ed.doc.map;
  if (opts.sheetEdges) {
    const t = ed.px(10);
    if (x < t) x = 0; else if (x > m.w - t) x = m.w;
    if (y < t) y = 0; else if (y > m.h - t) y = m.h;
  }
  x = Math.max(0, Math.min(m.w, x));
  y = Math.max(0, Math.min(m.h, y));
  return { x: r1(x), y: r1(y), snap };
}

// ---------------------------------------------------------------- polygon / polyline draft

class Draft {
  constructor(closed) { this.closed = closed; this.pts = []; this.cursor = null; }
  get n() { return this.pts.length / 2; }
  last() { const p = this.pts; return p.length ? [p[p.length - 2], p[p.length - 1]] : null; }
  first() { return this.pts.length ? [this.pts[0], this.pts[1]] : null; }
  clear() { this.pts = []; this.cursor = null; }
  pop() { this.pts.length = Math.max(0, this.pts.length - 2); }
  // Returns 'finish' when the click should close / end the draft, 'add' when a node was added.
  click(ed, ev, opts) {
    const f = this.first(), l = this.last();
    const pt = point(ed, ev, l, { ...opts, extra: this.closed && f ? [f] : null });
    if (this.closed && this.n >= 3 && dist(pt.x, pt.y, f[0], f[1]) <= ed.px(9)) return 'finish';
    if (l && dist(pt.x, pt.y, l[0], l[1]) < Math.max(0.5, ed.px(3))) return this.n >= (this.closed ? 3 : 2) ? 'finish' : 'none';
    this.pts.push(pt.x, pt.y);
    return 'add';
  }
  hover(ed, ev, opts) {
    const f = this.first();
    const pt = point(ed, ev, this.last(), { ...opts, extra: this.closed && f ? [f] : null });
    this.cursor = pt;
    ed.snap = pt.snap;
  }
  draw(ctx, ed, style) {
    const cam = ed.cam, pal = ed.pal, p = this.pts.slice();
    if (this.cursor) p.push(this.cursor.x, this.cursor.y);
    if (p.length < 2) return;
    ctx.save();
    if (style.width) {
      ctx.beginPath();
      tracePath(ctx, cam, p, false);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, style.width * cam.zoom);
      ctx.strokeStyle = pal.ink;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    tracePath(ctx, cam, p, false);
    if (this.closed && p.length >= 6) {
      ctx.closePath();
      ctx.fillStyle = style.fill || 'rgba(0,0,0,.08)';
      ctx.fill();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = style.stroke || pal.ink;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let k = 0; k < this.pts.length; k += 2) {
      const sx = (this.pts[k] - cam.x) * cam.zoom, sy = (this.pts[k + 1] - cam.y) * cam.zoom;
      const closeHot = this.closed && k === 0 && this.n >= 3 && this.cursor && dist(this.cursor.x, this.cursor.y, this.pts[0], this.pts[1]) <= ed.px(9);
      handle(ctx, sx, sy, pal, { size: closeHot ? 11 : 7, fill: closeHot ? pal.select : pal.card });
    }
    if (this.cursor) {
      const sx = (this.cursor.x - cam.x) * cam.zoom, sy = (this.cursor.y - cam.y) * cam.zoom;
      const txt = this.closed && p.length >= 6 ? fmtM2(polyArea(p)) : fmtM(polylineLength(p));
      const seg = this.last() ? fmtM(dist(this.cursor.x, this.cursor.y, ...this.last())) : '';
      label(ctx, seg && this.n ? `${seg}  ·  ${txt}` : txt, sx, sy, pal);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- select

const SELECT = {
  id: 'select', name: 'Select', hotkey: 'S', cursor: 'default',
  drag: null, lastClick: null,
  hint(ed) {
    if (this.drag && this.drag.type === 'box') return 'Release to select everything inside the box. Shift adds to the selection.';
    if (ed.sel.length === 1 && ed.sel[0].coll !== 'spawns') return 'Drag to move · drag a handle to reshape · double-click an edge to add a point · right-click a point to remove it · Del deletes';
    if (ed.sel.length) return 'Drag to move · arrows nudge (Shift ×10) · [ ] rotate · Ctrl+D duplicate · Del deletes · Esc clears';
    return 'Click an item to select it · click again to cycle through stacked items · drag empty ground to box-select · Shift adds';
  },
  down(ed, ev) {
    const doc = ed.doc, sel = ed.sel;
    if (sel.length === 1 && sel[0].coll !== 'spawns') {
      const v = doc.vertexAt(sel[0].coll, sel[0].idx, ev.x, ev.y, ed.px(7));
      if (v) {
        const it = doc.map[sel[0].coll][sel[0].idx];
        this.drag = { type: 'vertex', ref: sel[0], k: v.k, before: cloneItem(it), sx: ev.sx, sy: ev.sy, moved: false };
        return;
      }
    }
    const hits = doc.pickAll(ev.x, ev.y, ed.px(6));
    const same = this.lastClick && Math.abs(this.lastClick.sx - ev.sx) < 4 && Math.abs(this.lastClick.sy - ev.sy) < 4;
    const hit = hits[0] || null;
    if (!hit) {
      this.drag = { type: 'box', x0: ev.x, y0: ev.y, x1: ev.x, y1: ev.y, add: ev.shift, sx: ev.sx, sy: ev.sy, moved: false };
      return;
    }
    let cycleTo = null;
    if (ev.shift) {
      ed.toggleSel(hit);
      if (!ed.isSelected(hit)) { this.drag = null; return; }
    } else {
      const ci = hits.findIndex(h => ed.isSelected(h));
      if (ci < 0) ed.setSel([hit]);
      else if (same && hits.length > 1 && ed.sel.length === 1) cycleTo = hits[(ci + 1) % hits.length];
    }
    const m = doc.map;
    let bb = null;
    const edits = ed.sel.map(r => {
      const b = itemBBox(r.coll, m[r.coll][r.idx]);
      bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b;
      return { coll: r.coll, idx: r.idx, before: cloneItem(m[r.coll][r.idx]) };
    });
    this.drag = { type: 'move', x0: ev.x, y0: ev.y, sx: ev.sx, sy: ev.sy, edits, bb, moved: false, cycleTo };
  },
  move(ed, ev) {
    const d = this.drag, doc = ed.doc;
    if (!d) {
      const hits = doc.pickAll(ev.x, ev.y, ed.px(6));
      ed.setHover(hits[0] || null);
      let cur = hits[0] && ed.isSelected(hits[0]) ? 'move' : hits[0] ? 'pointer' : 'default';
      if (ed.sel.length === 1 && ed.sel[0].coll !== 'spawns' && doc.vertexAt(ed.sel[0].coll, ed.sel[0].idx, ev.x, ev.y, ed.px(7))) cur = 'crosshair';
      ed.setCursor(cur);
      return;
    }
    if (!d.moved && Math.abs(ev.sx - d.sx) + Math.abs(ev.sy - d.sy) < 4) return;
    d.moved = true;
    if (d.type === 'box') { d.x1 = ev.x; d.y1 = ev.y; ed.redraw(); return; }
    if (d.type === 'vertex') {
      const it = cloneItem(d.before), p = it.p, n = p.length;
      const closed = d.ref.coll !== 'roads';
      const prevK = d.k > 0 ? d.k - 2 : closed ? n - 2 : -1;
      const from = prevK >= 0 ? [p[prevK], p[prevK + 1]] : null;
      const pt = point(ed, ev, from, { exclude: d.ref });
      ed.snap = pt.snap;
      p[d.k] = pt.x; p[d.k + 1] = pt.y;
      doc.liveSet(d.ref.coll, d.ref.idx, it);
      ed.liveChanged(itemBBox(d.ref.coll, it), itemBBox(d.ref.coll, d.before));
      return;
    }
    let dx = ev.x - d.x0, dy = ev.y - d.y0;
    if (ev.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const m = doc.map;
    dx = Math.max(-d.bb[0], Math.min(m.w - d.bb[2], dx));
    dy = Math.max(-d.bb[1], Math.min(m.h - d.bb[3], dy));
    for (const e of d.edits) doc.liveSet(e.coll, e.idx, translated(e.coll, e.before, dx, dy));
    ed.liveChanged([d.bb[0] + dx, d.bb[1] + dy, d.bb[2] + dx, d.bb[3] + dy], d.bb);
  },
  up(ed, ev) {
    const d = this.drag;
    this.drag = null;
    ed.snap = null;
    if (!d) return;
    if (d.type === 'box') {
      if (!d.moved) { if (!d.add) ed.setSel([]); }
      else {
        const refs = ed.doc.pickBox(d.x0, d.y0, d.x1, d.y1);
        ed.setSel(d.add ? ed.sel.concat(refs.filter(r => !ed.isSelected(r))) : refs);
      }
      ed.redraw();
      return;
    }
    if (d.type === 'vertex') {
      if (d.moved) ed.doc.commitLive([{ coll: d.ref.coll, idx: d.ref.idx, before: d.before }], 'Reshape');
      ed.liveEnd();
      return;
    }
    if (d.moved) {
      ed.doc.commitLive(d.edits, 'Move');
      ed.liveEnd();
    } else {
      if (d.cycleTo) ed.setSel([d.cycleTo]);
      this.lastClick = { sx: ev.sx, sy: ev.sy };
    }
  },
  dbl(ed, ev) {
    const s = ed.sel;
    if (s.length !== 1 || s[0].coll === 'spawns') return;
    const e = ed.doc.edgeAt(s[0].coll, s[0].idx, ev.x, ev.y, ed.px(8));
    if (!e) return;
    const it = cloneItem(ed.doc.map[s[0].coll][s[0].idx]);
    it.p.splice(e.k + 2, 0, r1(e.x), r1(e.y));
    ed.doc.set(s[0].coll, s[0].idx, it);
  },
  right(ed, ev) {
    const s = ed.sel;
    if (s.length === 1 && s[0].coll !== 'spawns') {
      const v = ed.doc.vertexAt(s[0].coll, s[0].idx, ev.x, ev.y, ed.px(7));
      if (v) {
        const it = cloneItem(ed.doc.map[s[0].coll][s[0].idx]);
        if (it.p.length - 2 < MIN_PTS[s[0].coll]) { ed.toast(`A ${COLL_LABEL[s[0].coll].toLowerCase()} needs at least ${MIN_PTS[s[0].coll] / 2} points`, 'warn'); return; }
        it.p.splice(v.k, 2);
        ed.doc.set(s[0].coll, s[0].idx, it);
        return;
      }
    }
    ed.setSel([]);
  },
  key(ed, e) {
    const k = e.key;
    if ((k === 'Delete' || k === 'Backspace') && ed.sel.length) { ed.deleteSelection(); return true; }
    if (k === 'Escape' && ed.sel.length) { ed.setSel([]); return true; }
    if ((e.ctrlKey || e.metaKey) && (k === 'd' || k === 'D') && ed.sel.length) { ed.duplicateSelection(); return true; }
    if (ed.sel.length && k.startsWith('Arrow')) {
      const s = e.shiftKey ? 10 : 1;
      const dx = k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, dy = k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0;
      ed.transformSelection((coll, it) => translated(coll, it, dx, dy), 'Nudge');
      return true;
    }
    if (ed.sel.length && (k === '[' || k === ']' || k === '{' || k === '}')) {
      const deg = (e.shiftKey || k === '{' || k === '}' ? 15 : 5) * (k === '[' || k === '{' ? -1 : 1);
      const [cx, cy] = ed.selectionCentre();
      ed.transformSelection((coll, it) => rotated(coll, it, deg * Math.PI / 180, cx, cy), 'Rotate');
      return true;
    }
    return false;
  },
  cancel(ed) {
    if (this.drag && (this.drag.type === 'move' || this.drag.type === 'vertex') && this.drag.moved) {
      ed.doc.revertLive(this.drag.type === 'move' ? this.drag.edits : [{ coll: this.drag.ref.coll, idx: this.drag.ref.idx, before: this.drag.before }]);
      ed.liveEnd();
    }
    const had = !!this.drag;
    this.drag = null;
    return had;
  },
  draw(ctx, ed) {
    const d = this.drag;
    if (d && d.type === 'box' && d.moved) {
      const cam = ed.cam, pal = ed.pal;
      const x0 = (Math.min(d.x0, d.x1) - cam.x) * cam.zoom, y0 = (Math.min(d.y0, d.y1) - cam.y) * cam.zoom;
      const w = Math.abs(d.x1 - d.x0) * cam.zoom, h = Math.abs(d.y1 - d.y0) * cam.zoom;
      ctx.fillStyle = 'rgba(39,64,139,.07)';
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = pal.select;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
      ctx.setLineDash([]);
    }
  },
};

// ---------------------------------------------------------------- road

const ROAD = {
  id: 'road', name: 'Road', hotkey: 'R', cursor: 'crosshair',
  draft: new Draft(false),
  hint(ed) {
    return this.draft.n ? 'Click to add nodes · Enter, double-click or right-click to finish · Backspace removes the last node · Shift locks 15° · Alt skips snapping'
      : 'Click to start a road. Nodes snap to existing roads (hold Alt to place freely).';
  },
  down(ed, ev) {
    const r = this.draft.click(ed, ev, { polys: false });
    if (r === 'finish') this.finish(ed);
    ed.redraw();
  },
  move(ed, ev) { this.draft.hover(ed, ev, { polys: false }); ed.redraw(); },
  dbl(ed) { if (this.draft.n >= 2) this.finish(ed); },
  right(ed) { if (this.draft.n >= 2) this.finish(ed); else this.cancel(ed); },
  finish(ed) {
    const p = this.draft.pts.slice();
    this.draft.clear();
    if (p.length < 4 || polylineLength(p) < 1) return;
    const o = ed.opts.road;
    const item = { p, w: o.w, k: o.k };
    if (o.name) item.name = o.name;
    const idx = ed.doc.insert('roads', item);
    ed.toast(`${o.k === 'rail' ? 'Rail line' : o.k === 'bridge' ? 'Bridge' : 'Road'} ${idx + 1} drawn · ${fmtM(polylineLength(p))}`);
  },
  key(ed, e) {
    if (e.key === 'Enter') { if (this.draft.n >= 2) this.finish(ed); else this.cancel(ed); return true; }
    if (e.key === 'Backspace' && this.draft.n) { this.draft.pop(); ed.redraw(); return true; }
    return false;
  },
  cancel(ed) { const had = this.draft.n > 0; this.draft.clear(); ed.redraw(); return had; },
  draw(ctx, ed) { this.draft.draw(ctx, ed, { width: ed.opts.road.w }); },
};

// ---------------------------------------------------------------- shapes: building, water, park

function shapeTool(id, coll, name, hotkey) {
  return {
    id, coll, name, hotkey, cursor: 'crosshair',
    draft: new Draft(true), rect: null,
    mode(ed) { return ed.opts.shape[coll]; },
    hint(ed) {
      if (this.mode(ed) === 'rect') return `Drag a box to draw a ${name.toLowerCase()} · Shift makes it square · corners snap to nearby corners · switch to Polygon in the panel for other shapes`;
      return this.draft.n ? 'Click to add corners · click the first corner, Enter or double-click to close · Backspace removes the last corner · Shift locks 15°'
        : `Click the first corner of the ${name.toLowerCase()}`;
    },
    down(ed, ev) {
      if (this.mode(ed) === 'rect') {
        const p = point(ed, ev, null, { roads: false });
        this.rect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }
      const r = this.draft.click(ed, ev, { roads: coll !== 'buildings' });
      if (r === 'finish') this.finish(ed, this.draft.pts.slice());
      ed.redraw();
    },
    move(ed, ev) {
      if (this.mode(ed) === 'rect') {
        if (!this.rect) { const p = point(ed, ev, null, { roads: false }); ed.snap = p.snap; this.cursor = p; ed.redraw(); return; }
        let p = point(ed, ev, null, { roads: false });
        let x = p.x, y = p.y;
        if (ev.shift) {
          const s = Math.max(Math.abs(x - this.rect.x0), Math.abs(y - this.rect.y0));
          x = this.rect.x0 + Math.sign(x - this.rect.x0 || 1) * s;
          y = this.rect.y0 + Math.sign(y - this.rect.y0 || 1) * s;
        }
        ed.snap = p.snap;
        this.rect.x1 = x; this.rect.y1 = y;
        ed.redraw();
        return;
      }
      this.draft.hover(ed, ev, { roads: coll !== 'buildings' });
      ed.redraw();
    },
    up(ed) {
      if (!this.rect) return;
      const r = this.rect;
      this.rect = null;
      if (Math.abs(r.x1 - r.x0) < 1.5 || Math.abs(r.y1 - r.y0) < 1.5) { ed.redraw(); return; }
      this.finish(ed, rectFrom(r.x0, r.y0, r.x1, r.y1));
    },
    dbl(ed) { if (this.mode(ed) === 'poly' && this.draft.n >= 3) this.finish(ed, this.draft.pts.slice()); },
    right(ed) { if (this.mode(ed) === 'poly' && this.draft.n >= 3) this.finish(ed, this.draft.pts.slice()); else this.cancel(ed); },
    finish(ed, p) {
      this.draft.clear();
      if (p.length < 6 || polyArea(p) < 2) { ed.toast('Too small to keep (under 2 m²)', 'warn'); return; }
      let item = { p };
      if (coll === 'buildings') {
        const o = ed.opts.bldg;
        item = { p, h: o.h, k: o.k, use: o.use || DEFAULT_USE[o.k] };
        if (o.name) item.name = o.name;
      }
      const idx = ed.doc.insert(coll, item);
      ed.toast(`${name} ${idx + 1} drawn · ${fmtM2(polyArea(p))}`);
    },
    key(ed, e) {
      if (this.mode(ed) !== 'poly') return false;
      if (e.key === 'Enter') { if (this.draft.n >= 3) this.finish(ed, this.draft.pts.slice()); return true; }
      if (e.key === 'Backspace' && this.draft.n) { this.draft.pop(); ed.redraw(); return true; }
      return false;
    },
    cancel(ed) { const had = this.draft.n > 0 || !!this.rect; this.draft.clear(); this.rect = null; ed.redraw(); return had; },
    draw(ctx, ed) {
      const pal = ed.pal, cam = ed.cam;
      const fill = coll === 'water' ? 'rgba(80,120,140,.25)' : coll === 'parks' ? 'rgba(110,130,60,.25)' : 'rgba(30,28,24,.12)';
      if (this.rect) {
        const r = this.rect;
        const p = rectFrom(r.x0, r.y0, r.x1, r.y1);
        ctx.beginPath();
        tracePath(ctx, cam, p, true);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = pal.ink;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const sx = (Math.max(r.x0, r.x1) - cam.x) * cam.zoom, sy = (Math.max(r.y0, r.y1) - cam.y) * cam.zoom;
        label(ctx, `${Math.abs(r.x1 - r.x0).toFixed(1)} × ${Math.abs(r.y1 - r.y0).toFixed(1)} m`, sx, sy, pal, { dy: 6 });
        return;
      }
      this.draft.draw(ctx, ed, { fill });
    },
  };
}

const BUILDING = shapeTool('building', 'buildings', 'Building', 'B');
const WATER = shapeTool('water', 'water', 'Water', 'W');
const PARK = shapeTool('park', 'parks', 'Park', 'G');

// ---------------------------------------------------------------- erase

const ERASE = {
  id: 'erase', name: 'Erase', hotkey: 'X', cursor: 'crosshair',
  marked: [], active: false, lastPt: null,
  hint() { return 'Click an item to erase it, or drag across several · the panel chooses which kinds the eraser takes'; },
  filter(ed) { return new Set(Object.keys(ed.opts.erase).filter(k => ed.opts.erase[k])); },
  isMarked(h) { return this.marked.some(m => m.coll === h.coll && m.idx === h.idx); },
  markAt(ed, x, y) {
    const hit = ed.doc.pick(x, y, ed.px(5), this.filter(ed));
    if (hit && !this.isMarked(hit)) this.marked.push({ coll: hit.coll, idx: hit.idx });
  },
  down(ed, ev) { this.active = true; this.marked = []; this.lastPt = [ev.x, ev.y]; this.markAt(ed, ev.x, ev.y); ed.redraw(); },
  move(ed, ev) {
    if (this.active) {
      const [ax, ay] = this.lastPt, L = dist(ax, ay, ev.x, ev.y), step = ed.px(5);
      const n = Math.min(60, Math.ceil(L / step));
      for (let s = 1; s <= n; s++) this.markAt(ed, ax + (ev.x - ax) * s / n, ay + (ev.y - ay) * s / n);
      this.lastPt = [ev.x, ev.y];
    }
    ed.setHover(ed.doc.pick(ev.x, ev.y, ed.px(5), this.filter(ed)));
    ed.redraw();
  },
  up(ed) {
    this.active = false;
    if (!this.marked.length) return;
    const n = this.marked.length;
    ed.doc.removeMany(this.marked, 'Erase');
    this.marked = [];
    ed.setSel([]);
    ed.setHover(null);
    ed.toast(`Erased ${n} item${n > 1 ? 's' : ''}`);
  },
  cancel(ed) { const had = this.marked.length > 0; this.marked = []; this.active = false; ed.redraw(); return had; },
  draw(ctx, ed) {
    for (const m of this.marked) {
      const it = ed.doc.map[m.coll][m.idx];
      if (it) outlineItem(ctx, ed.cam, m.coll, it, ed.pal.stamp, 2.5);
    }
  },
};

// ---------------------------------------------------------------- outbreak hint points

const SPAWN = {
  id: 'spawn', name: 'Outbreak', hotkey: 'O', cursor: 'crosshair',
  drag: null,
  hint() { return 'Click to mark a likely outbreak site · drag a mark to move it · right-click a mark to remove it. Hints are optional.'; },
  down(ed, ev) {
    const hit = ed.doc.pick(ev.x, ev.y, ed.px(8), new Set(['spawns']));
    if (hit) { this.drag = { idx: hit.idx, before: ed.doc.map.spawns[hit.idx].slice(), moved: false }; return; }
    const p = point(ed, ev, null, { roads: false, polys: false });
    const i = ed.doc.insert('spawns', [p.x, p.y]);
    ed.toast(`Outbreak point ${i + 1} marked`);
  },
  move(ed, ev) {
    if (!this.drag) { ed.setHover(ed.doc.pick(ev.x, ev.y, ed.px(8), new Set(['spawns']))); return; }
    this.drag.moved = true;
    const m = ed.doc.map;
    ed.doc.liveSet('spawns', this.drag.idx, [r1(Math.max(0, Math.min(m.w, ev.x))), r1(Math.max(0, Math.min(m.h, ev.y)))]);
    ed.redraw();
  },
  up(ed) {
    const d = this.drag;
    this.drag = null;
    if (d && d.moved) ed.doc.commitLive([{ coll: 'spawns', idx: d.idx, before: d.before }], 'Move outbreak point');
  },
  right(ed, ev) {
    const hit = ed.doc.pick(ev.x, ev.y, ed.px(8), new Set(['spawns']));
    if (hit) { ed.doc.remove('spawns', hit.idx); ed.setHover(null); ed.toast(`Outbreak point ${hit.idx + 1} removed`); }
  },
  cancel(ed) { if (this.drag && this.drag.moved) ed.doc.revertLive([{ coll: 'spawns', idx: this.drag.idx, before: this.drag.before }]); const had = !!this.drag; this.drag = null; return had; },
  draw() {},
};

// ---------------------------------------------------------------- stage boundaries

const STAGE = {
  id: 'stage', name: 'Stages', hotkey: 'T', cursor: 'default',
  draft: new Draft(true), drawing: false, drag: null,
  hint(ed) {
    if (this.drawing) return `Drawing stage ${ed.activeStage + 1}: click corners · click the first corner or press Enter to close · Esc keeps the old boundary · corners snap to the sheet edge`;
    return 'Click a boundary to pick its stage · drag a corner or an edge to reshape it · right-click a corner to remove it · Redraw in the panel traces a new one';
  },
  startDrawing(ed) { this.drawing = true; this.draft.clear(); ed.redraw(); },
  down(ed, ev) {
    const doc = ed.doc, L = doc.map.levels;
    if (this.drawing) {
      const r = this.draft.click(ed, ev, { sheetEdges: true, roads: false, polys: false });
      if (r === 'finish') this.finishDrawing(ed);
      ed.redraw();
      return;
    }
    const k = ed.activeStage;
    if (L[k]) {
      const v = doc.vertexAt('levels', k, ev.x, ev.y, ed.px(8));
      if (v) { this.drag = { k, vk: v.k, before: cloneItem(L[k]), moved: false, sx: ev.sx, sy: ev.sy }; return; }
      const e = doc.edgeAt('levels', k, ev.x, ev.y, ed.px(6));
      if (e) {
        const before = cloneItem(L[k]), it = cloneItem(L[k]);
        it.p.splice(e.k + 2, 0, r1(e.x), r1(e.y));
        doc.liveSet('levels', k, it);
        this.drag = { k, vk: e.k + 2, before, moved: false, inserted: true, sx: ev.sx, sy: ev.sy };
        ed.redraw();
        return;
      }
    }
    for (let j = 0; j < L.length; j++) {
      if (j === k) continue;
      if (doc.edgeAt('levels', j, ev.x, ev.y, ed.px(6))) { ed.setActiveStage(j); return; }
    }
  },
  move(ed, ev) {
    if (this.drawing) { this.draft.hover(ed, ev, { sheetEdges: true, roads: false, polys: false }); ed.redraw(); return; }
    const d = this.drag;
    if (!d) {
      const L = ed.doc.map.levels, k = ed.activeStage;
      let cur = 'default';
      if (L[k] && ed.doc.vertexAt('levels', k, ev.x, ev.y, ed.px(8))) cur = 'move';
      else if (L[k] && ed.doc.edgeAt('levels', k, ev.x, ev.y, ed.px(6))) cur = 'copy';
      else if (L.some((l, j) => j !== k && ed.doc.edgeAt('levels', j, ev.x, ev.y, ed.px(6)))) cur = 'pointer';
      ed.setCursor(cur);
      return;
    }
    if (!d.moved && Math.abs(ev.sx - d.sx) + Math.abs(ev.sy - d.sy) < 3) return;
    d.moved = true;
    const it = cloneItem(ed.doc.map.levels[d.k]);
    const pt = point(ed, ev, null, { sheetEdges: true, roads: false, polys: false });
    it.p[d.vk] = pt.x; it.p[d.vk + 1] = pt.y;
    ed.doc.liveSet('levels', d.k, it);
    ed.redraw();
  },
  up(ed) {
    const d = this.drag;
    this.drag = null;
    if (d && d.moved) ed.doc.commitLive([{ coll: 'levels', idx: d.k, before: d.before }], 'Reshape stage');
    else if (d && d.inserted) ed.doc.revertLive([{ coll: 'levels', idx: d.k, before: d.before }]);
    ed.liveEnd();
  },
  right(ed, ev) {
    if (this.drawing) { if (this.draft.n >= 3) this.finishDrawing(ed); else this.cancel(ed); return; }
    const k = ed.activeStage, lv = ed.doc.map.levels[k];
    if (!lv) return;
    const v = ed.doc.vertexAt('levels', k, ev.x, ev.y, ed.px(8));
    if (!v) return;
    if (lv.p.length <= 6) { ed.toast('A stage boundary needs at least 3 corners', 'warn'); return; }
    const it = cloneItem(lv);
    it.p.splice(v.k, 2);
    ed.doc.set('levels', k, it);
  },
  finishDrawing(ed) {
    const p = this.draft.pts.slice();
    this.draft.clear();
    this.drawing = false;
    const k = ed.activeStage, lv = ed.doc.map.levels[k];
    if (p.length < 6 || polyArea(p) < 100) { ed.toast('Boundary too small; the old one is kept', 'warn'); return; }
    if (lv) ed.doc.set('levels', k, { ...lv, p });
    else ed.doc.insert('levels', { p });
    ed.toast(`Stage ${k + 1} boundary redrawn · ${fmtM2(polyArea(p))}`);
    ed.panels();
  },
  key(ed, e) {
    if (!this.drawing) return false;
    if (e.key === 'Enter') { if (this.draft.n >= 3) this.finishDrawing(ed); return true; }
    if (e.key === 'Backspace' && this.draft.n) { this.draft.pop(); ed.redraw(); return true; }
    return false;
  },
  cancel(ed) {
    if (this.drag && (this.drag.moved || this.drag.inserted)) { ed.doc.revertLive([{ coll: 'levels', idx: this.drag.k, before: this.drag.before }]); ed.liveEnd(); }
    const had = this.drawing || !!this.drag;
    this.drag = null;
    if (this.drawing) { this.drawing = false; this.draft.clear(); ed.panels(); }
    ed.redraw();
    return had;
  },
  draw(ctx, ed) {
    if (this.drawing) { this.draft.draw(ctx, ed, { fill: 'rgba(179,38,30,.08)', stroke: ed.pal.stamp }); return; }
    const lv = ed.doc.map.levels[ed.activeStage];
    if (lv) vertexHandles(ctx, ed.cam, 'levels', lv, ed.pal, this.drag ? this.drag.vk : -1);
  },
};

export const TOOLS = [SELECT, ROAD, BUILDING, WATER, PARK, ERASE, STAGE, SPAWN];
export const TOOL_BY_ID = Object.fromEntries(TOOLS.map(t => [t.id, t]));

// Common overlay: selection, hover, outbreak points.
export function drawCommon(ctx, ed) {
  const cam = ed.cam, pal = ed.pal, m = ed.doc.map;
  const spawnTool = ed.tool.id === 'spawn';
  m.spawns.forEach((s, i) => drawSpawn(ctx, cam, s, i, pal, { radius: spawnTool ? ed.outbreakRadius : 0 }));
  const h = ed.hover;
  if (h && !(h.coll === 'buildings' && ed.cacheFresh)) {
    const it = m[h.coll] && m[h.coll][h.idx];
    if (it && !ed.isSelected(h)) outlineItem(ctx, cam, h.coll, it, ed.tool.id === 'erase' ? pal.stamp : pal.hover, 1.5);
  }
  if (h && ed.tool.id === 'erase' && h.coll === 'buildings') {
    const it = m.buildings[h.idx];
    if (it) outlineItem(ctx, cam, 'buildings', it, pal.stamp, 2);
  }
  if (ed.tool.id !== 'select') return;
  const many = ed.sel.length > 400;
  for (const r of ed.sel) {
    const it = m[r.coll] && m[r.coll][r.idx];
    if (!it) continue;
    outlineItem(ctx, cam, r.coll, it, pal.select, many ? 1.25 : 2);
  }
  if (ed.sel.length === 1) {
    const r = ed.sel[0], it = m[r.coll][r.idx];
    if (it && r.coll !== 'spawns') vertexHandles(ctx, cam, r.coll, it, pal, SELECT.drag && SELECT.drag.type === 'vertex' ? SELECT.drag.k : -1);
  }
}
