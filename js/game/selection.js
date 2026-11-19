// Selected troops: box, click, shift and double-click picking of own squads and commandable vehicles, the orders
// panel, and on the map the selection rings, destination markers and march lines. Selection is client state only;
// orders go to the sim as { t: 'order', refs, kind, x, y } through session.issue (co-op lockstep included).
import { h, setHTML, esc, fmtInt } from './el.js';
import { selectables, marchPath } from '../sim/orders.js';
import { rgba } from '../render/palette.js';
import { tag } from '../render/fx.js';
import { cycleIndex, selOf, AGAIN } from './pick.js';

const TAU = Math.PI * 2;
const POLICE = 4;
const ORDER_ACTIONS = { orderMove: 'move', orderHunt: 'hunt', orderHold: 'hold', orderReturn: 'return' };
const ORDER_BTNS = [['orderMove', 'Move'], ['orderHunt', 'Hunt'], ['orderHold', 'Hold'], ['orderReturn', 'Back to zone']];
const MODE_LABEL = { moving: 'moving', hunting: 'hunting', holding: 'holding', move: 'moving', hunt: 'hunting', hold: 'holding', return: 'going back' };
const MEMBER_RING_ZOOM = 1.6; // CSS px per metre from which each member gets its own ring
const REFRESH = 0.25;

export class Army {
  constructor(s) {
    this.s = s;
    this.refs = new Set();
    this.list = [];
    this.byRef = new Map();
    this.groups = new Set();
    this.members = new Int32Array(256);
    this.nm = 0;
    this.start = null;
    this.box = null;
    this.aim = false;
    this.pings = [];
    this.last = null;   // the last plain click: { sx, sy, t, key } of what it picked
    this.undo = null;
    this._t = 0;
    this._acc = new Map();
    this.el = h('section.rc-army', { hidden: true });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const a = b.getAttribute('data-act');
      if (a === 'close') this.clear(); else this.action(a);
    });
    const side = s.hud.el.side;
    side.insertBefore(this.el, s.hud.el.tally || null);
    s._offs.push(s.world.events.on('changed', (e) => { if (e && (e.what === 'stage' || e.what === 'restore')) { this.last = null; this.undo = null; this.clear(); } }));
  }

  get world() { return this.s.world; }
  get owner() { return this.s.owner; }
  get size() { return this.refs.size; }
  handles(name) { return name in ORDER_ACTIONS; }

  // ---------------------------------------------------------------- state
  refresh() {
    const w = this.world;
    this.list = selectables(w, this.owner);
    this.byRef = new Map(this.list.map((e) => [e.ref, e]));
    for (const r of [...this.refs]) if (!this.byRef.has(r)) this.refs.delete(r);
    this.groups.clear();
    for (const r of this.refs) if (r[0] === 's') this.groups.add(+r.slice(1));
    const A = w.A;
    let n = 0;
    if (this.groups.size) for (let i = 0, N = A.n; i < N; i++) {
      if (A.type[i] < POLICE || !this.groups.has(A.group[i])) continue;
      if (n === this.members.length) { const m = new Int32Array(n * 2); m.set(this.members); this.members = m; }
      this.members[n++] = i;
    }
    this.nm = n;
  }

  changed() {
    this.refresh();
    this.aim = this.aim && this.refs.size > 0;
    this.render();
    this.s.canvas.style.cursor = this.s.tool.cursor();
  }

  set(refs, add = false) {
    if (!add) this.refs.clear();
    for (const r of refs) this.refs.add(r);
    if (this.refs.size) this.s.select(null);
    this.changed();
    if (this.refs.size) this.s.sfx('clack');
  }

  clear() {
    if (!this.refs.size && !this.aim) return;
    this.refs.clear();
    this.aim = false;
    this.changed();
  }

  // ---------------------------------------------------------------- picking
  // The own squad or commandable vehicle (boats too) under the cursor: its ref, or null. Builds are ignored.
  pick(e) {
    this.refresh();
    const c = this.s.pickList(e.wx, e.wy, { builds: false, rest: false, boats: true }).find((q) => q.kind === 'troop' && this.byRef.has(q.ref));
    return c ? c.ref : null;
  }

  // Index in list a click at e would pick: clicking again on the spot steps on, Alt one further (game/pick.js).
  peek(e, list, alt = !!e.alt) { return cycleIndex(list, this.last, e.sx, e.sy, performance.now() / 1000, alt); }

  // Refs of own squads with a member inside the world rectangle, and vehicles inside it; kind limits to one kind.
  inRect(x0, y0, x1, y1, kind = null) {
    const w = this.world, A = w.A, out = new Set(), seen = new Set();
    for (let i = 0, N = A.n; i < N; i++) {
      if (A.type[i] < POLICE) continue;
      const g = A.group[i];
      if (g < 0 || seen.has(g)) continue;
      const x = A.x[i], y = A.y[i];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      seen.add(g);
      const e = this.byRef.get('s' + g);
      if (e && (!kind || e.kind === kind)) out.add(e.ref);
    }
    for (const v of this.list) if (v.vehicle && v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1 && (!kind || v.kind === kind)) out.add(v.ref);
    return [...out];
  }

  // ---------------------------------------------------------------- pointer (from the select tool)
  down(e) { this.start = e; this.box = null; }

  move(e) {
    const a = this.start;
    if (!a || !(e.buttons & 1)) return;
    if (!this.box && Math.hypot(e.sx - a.sx, e.sy - a.sy) > 5) this.box = { a, b: e };
    if (this.box) this.box.b = e;
  }

  up(e) {
    const a = this.start, box = this.box;
    this.start = null; this.box = null;
    if (!a) return;
    if (box) {
      this.refresh();
      const refs = this.inRect(Math.min(a.wx, e.wx), Math.min(a.wy, e.wy), Math.max(a.wx, e.wx), Math.max(a.wy, e.wy));
      if (refs.length || !e.shift) this.set(refs, e.shift);
      return;
    }
    this.click(e);
  }

  // A plain click takes the build under the cursor before any troops; clicking again on the spot steps through
  // everything there (builds, squads, the building, the zone...). Shift-click adds or drops troops only.
  click(e) {
    const s = this.s;
    if (this.aim) { this.aim = false; this.order('move', e.wx, e.wy); s.canvas.style.cursor = s.tool.cursor(); return; }
    if (e.shift) {
      const ref = this.pick(e);
      if (!ref) return;
      if (this.refs.has(ref)) { this.refs.delete(ref); this.changed(); s.sfx('clack'); return; }
      // boats take orders only once the outbreak starts
      const ent = this.byRef.get(ref), v = ent && ent.vehicle ? this.world.vehicles.find((q) => q && q.id === ent.id) : null;
      if (!(v && v.boat) || this.world.phase === 'battle') this.set([ref], true);
      return;
    }
    const list = s.pickList(e.wx, e.wy), t = performance.now() / 1000;
    const i = this.peek(e, list), c = list[i] || null, prev = this.last;
    this.undo = prev && c && prev.key !== c.key && Math.hypot(e.sx - prev.sx, e.sy - prev.sy) <= AGAIN.px && t - prev.t <= AGAIN.sec
      ? { key: prev.key, sel: s.sel, refs: [...this.refs], t } : null;
    this.last = c ? { sx: e.sx, sy: e.sy, t, key: c.key } : null;
    this.choose(c);
    s.updateHover(true);
  }

  choose(c) {
    const s = this.s, w = this.world;
    if (c && c.kind === 'troop') {
      this.refresh();
      if (this.byRef.has(c.ref)) { this.set([c.ref]); return; }
    }
    if (c && c.kind === 'unit') {
      // a boat is also a unit: its card (hull, upgrade, refund) opens, and in battle it is selected for orders too
      const u = w.units.find((q) => q && q.id === c.id), v = u && u.veh;
      if (v && w.phase === 'battle') {
        this.refresh();
        if (this.byRef.has('v' + v.id)) { this.set(['v' + v.id]); s.select({ kind: 'unit', id: u.id }); return; }
      }
    }
    this.clear();
    s.select(selOf(c));
  }

  dbl(e) {
    const ref = this.pick(e);
    if (!ref) {
      // the second click of a double-click stepped on; with no troops here, go back to what the first one picked
      const u = this.undo;
      if (u && performance.now() / 1000 - u.t < 0.8) {
        this.undo = null;
        this.refs = new Set(u.refs);
        this.changed();
        this.s.select(u.sel);
        if (this.last) this.last.key = u.key;
        this.s.updateHover(true);
      }
      return;
    }
    const ent = this.byRef.get(ref), bb = this.s.cam.visibleBBox(0);
    this.set(this.inRect(bb[0], bb[1], bb[2], bb[3], ent.kind), e.shift);
  }

  rightClick(e) {
    if (!this.refs.size) return false;
    this.aim = false;
    this.order('move', e.wx, e.wy);
    return true;
  }

  cancel() {
    if (this.aim) { this.aim = false; this.render(); this.s.canvas.style.cursor = this.s.tool.cursor(); return true; }
    if (this.refs.size) { this.clear(); return true; }
    return false;
  }

  cursor() { return this.aim ? 'crosshair' : 'default'; }

  label() {
    if (this.aim) return { title: 'MOVE', ok: null, note: 'click the destination · Esc cancels' };
    if (this.box) return { title: 'SELECT', ok: null, note: 'own squads and vehicles in the box' };
    return null;
  }

  // ---------------------------------------------------------------- orders
  action(name) {
    const kind = ORDER_ACTIONS[name];
    if (!kind || !this.refs.size) return false;
    if (kind === 'move') {
      if (this.s.toolName !== 'select') this.s.setTool('select');
      this.aim = !this.aim;
      this.render();
      this.s.canvas.style.cursor = this.s.tool.cursor();
      if (this.aim) this.s.flash('Click the destination on the map', 'info');
      return true;
    }
    this.aim = false;
    this.order(kind);
    return true;
  }

  order(kind, x, y) {
    const s = this.s;
    this.refresh();
    const refs = [...this.refs];
    if (!refs.length) return null;
    const cmd = { t: 'order', refs, kind };
    if (kind === 'move') { cmd.x = Math.round(x * 10) / 10; cmd.y = Math.round(y * 10) / 10; }
    const r = s.issue(cmd);
    if (r && r.ok && kind === 'move') this.pings.push({ x: cmd.x, y: cmd.y, rt0: s.rt });
    this.render();
    return r;
  }

  // ---------------------------------------------------------------- panel
  // Called every frame from draw(): the member list and panel follow the battle a few times a second.
  frame() {
    const rt = this.s.rt;
    if (rt - this._t < REFRESH) return;
    this._t = rt;
    if (!this.refs.size) { if (!this.el.hidden) this.render(); return; }
    this.refresh();
    if (!this.refs.size) this.aim = false;
    this.render();
  }

  render() {
    const s = this.s, w = this.world;
    if (!this.refs.size) { setHTML(this.el, ''); this.el.hidden = true; return; }
    this.el.hidden = false;
    const kinds = new Map();
    let squads = 0, men = 0, vehicles = 0;
    for (const r of this.refs) {
      const e = this.byRef.get(r);
      if (!e) continue;
      let k = kinds.get(e.label);
      if (!k) kinds.set(e.label, k = { n: 0, men: 0, modes: new Map(), vehicle: !!e.vehicle });
      k.n++; k.men += e.n;
      k.modes.set(e.mode || 'holding', (k.modes.get(e.mode || 'holding') || 0) + 1);
      if (e.vehicle) vehicles++; else { squads++; men += e.n; }
    }
    const parts = [];
    if (squads) parts.push(`${squads} squad${squads === 1 ? '' : 's'}`);
    if (vehicles) parts.push(`${vehicles} vehicle${vehicles === 1 ? '' : 's'}`);
    const mix = [...kinds].map(([label, k]) => `${label} ${k.n}`).join(', ');
    let sub = `${parts.join(', ')} · ${mix}`;
    if (squads) sub += ` · ${fmtInt(men)} ${men === 1 ? 'man' : 'men'}`;
    const rows = [...kinds].map(([label, k]) => {
      const modes = [...k.modes].sort((a, b) => b[1] - a[1]);
      const doing = modes.length > 1 ? modes.map(([m, n]) => `${MODE_LABEL[m] || m} ${n}`).join(', ') : (MODE_LABEL[modes[0][0]] || modes[0][0] || '--');
      return `<tr><td>${esc(label)}</td><td class="num">${k.n}</td><td class="num">${k.vehicle ? '--' : fmtInt(k.men)}</td><td>${esc(doing)}</td></tr>`;
    }).join('');
    const battle = w.phase === 'battle';
    const btns = ORDER_BTNS.map(([act, label]) => {
      const on = act === 'orderMove' && this.aim;
      return `<button type="button" class="btn btn-sm${on ? ' is-on' : ''}" data-act="${act}"${battle ? '' : ' disabled title="Orders are given once the outbreak starts"'}>${esc(label)} <span class="keycap">${esc(s.prefs.keyLabel(act))}</span></button>`;
    }).join('');
    setHTML(this.el, `<div class="card rc-card">`
      + `<div class="card-head"><h3 class="card-title">Selected</h3><span class="card-no">SEL ${String(this.refs.size).padStart(2, '0')}</span><button type="button" class="rc-x" data-act="close" title="Clear selection (Esc)">x</button></div>`
      + `<div class="rc-card-sub">${esc(sub)}</div>`
      + `<table class="table compact rc-army-t"><thead><tr><th>Unit</th><th class="num">No.</th><th class="num">Men</th><th>Now</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<div class="rc-acts rc-orders">${btns}</div>`
      + `<p class="small faint">${this.aim ? 'Click the destination on the map. Esc cancels.' : 'Right-click the map to send them there. Shift-click adds or drops a squad; double-click takes every squad of that kind on screen.'}</p>`
      + `</div>`);
  }

  // ---------------------------------------------------------------- map drawing
  drawBox(ctx, cam, pal) {
    const b = this.box;
    if (!b) return;
    const x = Math.min(b.a.sx, b.b.sx), y = Math.min(b.a.sy, b.b.sy), bw = Math.abs(b.b.sx - b.a.sx), bh = Math.abs(b.b.sy - b.a.sy);
    ctx.save();
    ctx.fillStyle = rgba(pal.select, 0.07);
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(bw), Math.round(bh));
    ctx.setLineDash([]);
    // registration corners, as on a plotting sheet
    const k = Math.min(10, bw / 3, bh / 3);
    ctx.strokeStyle = pal.select; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]) {
      ctx.moveTo(cx + sx * k, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * k);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- hover outline
  // What a click would pick, in ink with a paper halo like the map's building hover (buildings and bridges are outlined
  // there). Selected gates and walls, which the world layer does not mark, get the selection colour.
  outline(ctx, cam, pal, c, selected = false) {
    const w = this.world, z = cam.zoom, ox = cam.x, oy = cam.y;
    const X = (x) => (x - ox) * z, Y = (y) => (y - oy) * z;
    const find = (list, id) => (list || []).find((q) => q && q.id === id);
    const P = new Path2D();
    let band = null, dash = false;
    const ring = (x, y, r) => { P.moveTo(X(x) + r, Y(y)); P.arc(X(x), Y(y), r, 0, TAU); };
    // rectangle around segment a-b: hw px either side, pad px past each end
    const quad = (ax, ay, bx, by, hw, pad) => {
      const sax = X(ax), say = Y(ay), sbx = X(bx), sby = Y(by), L = Math.hypot(sbx - sax, sby - say) || 1;
      const ux = (sbx - sax) / L, uy = (sby - say) / L, nx = -uy * hw, ny = ux * hw;
      const px = sax - ux * pad, py = say - uy * pad, qx = sbx + ux * pad, qy = sby + uy * pad;
      P.moveTo(px + nx, py + ny); P.lineTo(qx + nx, qy + ny); P.lineTo(qx - nx, qy - ny); P.lineTo(px - nx, py - ny); P.closePath();
    };
    switch (c.kind) {
      case 'unit': {
        const u = find(w.units, c.id);
        if (!u || u.alive === false) return;
        if (u.veh) { ring(u.veh.x, u.veh.y, (u.veh.selR || 8) * z + 3); break; }
        if (u.p) { band = u.p; break; }
        const r = Math.max(4.5, Math.min(9, 4 + z * 2.2)) + 4;
        P.rect(X(u.x) - r, Y(u.y) - r, 2 * r, 2 * r);
        break;
      }
      case 'gate': {
        const g = find(w.zones.gates, c.id);
        if (!g) return;
        const post = Math.max(Math.max(1.5, w.grid.cell * z * 1.05) * 0.5 + 1.5, 6 * z);
        if (Number.isFinite(g.x0)) quad(g.x0, g.y0, g.x1, g.y1, post + 3, 4); else ring(g.x, g.y, 10);
        break;
      }
      case 'wall': { const wl = find(w.walls, c.id); if (!wl) return; band = wl.p; break; }
      case 'corridor': { const co = find(w.corridors, c.id); if (!co) return; quad(co.x0, co.y0, co.x1, co.y1, Math.max(4, co.w * z / 2), 0); break; }
      case 'hold': { const h = find(w.holds, c.id); if (!h) return; ring(h.x, h.y, Math.max(8, h.R * z)); break; }
      case 'zone': {
        const wr = this.s.wr, e = wr.comps && wr.comps.find((q) => q.c.id === c.comp);
        if (!e) return;
        P.addPath(wr._compPath(e.polys, e.loops, cam)); dash = true;
        break;
      }
      case 'zonepoly': {
        const pl = find(w.zones.polys, c.id);
        if (!pl) return;
        const p = pl.p;
        P.moveTo(X(p[0]), Y(p[1])); for (let k = 2; k < p.length; k += 2) P.lineTo(X(p[k]), Y(p[k + 1])); P.closePath(); dash = true;
        break;
      }
      case 'troop': case 'squad': {
        if (c.vid !== undefined) { const v = w.vehicles.find((q) => q && q.id === c.vid); if (v) ring(v.x, v.y, (v.selR || 8) * z + 3); break; }
        this.groupRings(P, cam, c.group);
        break;
      }
      default: return;
    }
    const col = selected ? pal.select : pal.hover;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (band) {
      const B = new Path2D();
      B.moveTo(X(band[0]), Y(band[1])); for (let k = 2; k < band.length; k += 2) B.lineTo(X(band[k]), Y(band[k + 1]));
      ctx.globalAlpha = 0.3; ctx.strokeStyle = col; ctx.lineWidth = Math.max(8, w.grid.cell * z * 1.05 + 7); ctx.stroke(B);
      ctx.globalAlpha = 1;
    }
    if (dash) ctx.setLineDash([6, 4]);
    if (!selected) { ctx.strokeStyle = pal.hoverHalo; ctx.lineWidth = 4; ctx.stroke(P); }
    ctx.strokeStyle = col; ctx.lineWidth = selected ? 2 : 1.8; ctx.stroke(P);
    ctx.restore();
  }

  // Rings round each member of group g on screen, or one ring round the whole group when zoomed out.
  groupRings(P, cam, g) {
    const A = this.world.A, z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h;
    let n = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const r = Math.max(3.4, 0.8 * z + 2.2) + 1, each = z >= MEMBER_RING_ZOOM;
    for (let i = 0, N = A.n; i < N; i++) {
      if (A.type[i] < POLICE || A.group[i] !== g) continue;
      const x = A.x[i], y = A.y[i];
      if (each) {
        const px = (x - ox) * z, py = (y - oy) * z;
        if (px < -r || py < -r || px > W + r || py > H + r) continue;
        P.moveTo(px + r, py); P.arc(px, py, r, 0, TAU);
        continue;
      }
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!n) return;
    const cx = sx / n, cy = sy / n, R = Math.max(7, (Math.max(x1 - cx, cx - x0, y1 - cy, cy - y0) + 3) * z + 1);
    P.moveTo((cx - ox) * z + R, (cy - oy) * z); P.arc((cx - ox) * z, (cy - oy) * z, R, 0, TAU);
  }

  draw(ctx, cam, pal) {
    this.frame();
    const s = this.s, w = this.world, rt = s.rt;
    if (s.hover) this.outline(ctx, cam, pal, s.hover);
    if (s.sel && (s.sel.kind === 'gate' || s.sel.kind === 'wall')) this.outline(ctx, cam, pal, s.sel, true);
    this.pings = this.pings.filter((p) => rt - p.rt0 < 1.4);
    if (!this.refs.size && !this.pings.length) return;
    const z = cam.zoom, ox = cam.x, oy = cam.y, W = cam.w, H = cam.h, col = pal.select, A = w.A;
    ctx.save();
    const O = w.orders;
    if (O && O.byGroup.size) for (const g of this.groups) { const rec = O.byGroup.get(g); if (rec) this.drawMarch(ctx, cam, pal, rec); }
    const mem = this.members, nm = this.nm, groups = this.groups;
    if (nm) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.25;
      ctx.beginPath();
      if (z >= MEMBER_RING_ZOOM) {
        const r = Math.max(3.4, 0.8 * z + 2.2);
        for (let k = 0; k < nm; k++) {
          const i = mem[k];
          if (A.type[i] < POLICE || !groups.has(A.group[i])) continue;
          const sx = (A.x[i] - ox) * z, sy = (A.y[i] - oy) * z;
          if (sx < -r || sy < -r || sx > W + r || sy > H + r) continue;
          ctx.moveTo(sx + r, sy); ctx.arc(sx, sy, r, 0, TAU);
        }
      } else {
        const acc = this._acc;
        for (const e of acc.values()) e.n = 0;
        for (let k = 0; k < nm; k++) {
          const i = mem[k], g = A.group[i];
          if (A.type[i] < POLICE || !groups.has(g)) continue;
          let e = acc.get(g);
          if (!e) acc.set(g, e = { n: 0 });
          const x = A.x[i], y = A.y[i];
          if (!e.n) { e.sx = 0; e.sy = 0; e.x0 = e.x1 = x; e.y0 = e.y1 = y; }
          e.n++; e.sx += x; e.sy += y;
          if (x < e.x0) e.x0 = x; if (x > e.x1) e.x1 = x; if (y < e.y0) e.y0 = y; if (y > e.y1) e.y1 = y;
        }
        for (const [g, e] of acc) {
          if (!e.n) { acc.delete(g); continue; }
          const cx = e.sx / e.n, cy = e.sy / e.n;
          const R = Math.max(6, (Math.max(e.x1 - cx, cx - e.x0, e.y1 - cy, cy - e.y0) + 3) * z);
          const sx = (cx - ox) * z, sy = (cy - oy) * z;
          if (sx < -R || sy < -R || sx > W + R || sy > H + R) continue;
          ctx.moveTo(sx + R, sy); ctx.arc(sx, sy, R, 0, TAU);
        }
      }
      ctx.stroke();
    }
    for (const r of this.refs) {
      if (r[0] !== 'v') continue;
      const id = +r.slice(1), v = w.vehicles.find((q) => q && q.id === id);
      if (!v || v.alive === false) continue;
      const R = (v.selR || 8) * z + 2, sx = (v.x - ox) * z, sy = (v.y - oy) * z;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, TAU); ctx.stroke();
      const o = v.order;
      if (o && !o.done && o.kind !== 'hold' && o.kind !== 'hunt' && Number.isFinite(o.x)) {
        const tx = (o.x - ox) * z, ty = (o.y - oy) * z;
        ctx.strokeStyle = rgba(col, 0.8); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
        this.target(ctx, tx, ty, pal, o.kind === 'return' ? 'HOME' : null);
      }
    }
    for (const p of this.pings) {
      const f = (rt - p.rt0) / 1.4, sx = (p.x - ox) * z, sy = (p.y - oy) * z;
      ctx.strokeStyle = rgba(col, 1 - f); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 6 + 14 * f, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  drawMarch(ctx, cam, pal, rec) {
    const w = this.world, A = w.A, z = cam.zoom, ox = cam.x, oy = cam.y;
    let i = rec.lead;
    if (!(i >= 0 && A.type[i] >= POLICE && A.group[i] === rec.group && A.pc[i] === rec.id)) {
      i = -1;
      for (const m of rec.members) if (A.type[m] >= POLICE && A.group[m] === rec.group && A.pc[m] === rec.id) { i = m; break; }
    }
    const tx = (rec.dx - ox) * z, ty = (rec.dy - oy) * z;
    if (i >= 0) {
      const p = marchPath(w, rec, A.x[i], A.y[i]);
      ctx.beginPath();
      for (let k = 0; k < p.length; k += 2) { const sx = (p[k] - ox) * z, sy = (p[k + 1] - oy) * z; k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }
      ctx.lineJoin = 'round';
      ctx.strokeStyle = rgba(pal.card, 0.7); ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = pal.select; ctx.lineWidth = 1.25; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    this.target(ctx, tx, ty, pal, rec.kind === 'return' ? 'ZONE' : null);
  }

  // Destination mark: a ringed cross with registration ticks.
  target(ctx, x, y, pal, label) {
    const col = pal.select;
    ctx.strokeStyle = pal.card; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.stroke();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU);
    ctx.moveTo(x - 12, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 12);
    ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(x - 1, y - 1, 2, 2);
    if (label) tag(ctx, label, x + 10, y - 22, pal, col);
  }
}
