// Mouse and keyboard for the map: routes pointer events to the active tool, pans/zooms the camera,
// and turns key presses into session actions through the player's key bindings.
import { findCorner, CornerDrag } from './tools.js';

const PAN_SPEED = 900; // CSS px per second
const PAN_ACTIONS = { panUp: [0, 1], panDown: [0, -1], panLeft: [1, 0], panRight: [-1, 0] };

function typingInto(t) {
  if (!t || !t.tagName) return false;
  const n = t.tagName;
  return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable;
}

export class Input {
  constructor(session, el) {
    this.s = session;
    this.el = el;
    this.held = new Map();
    this.pan = null;
    this.rpan = null;
    this.gesture = null;
    this.mouse = null;
    this._h = {};
  }

  ev(e) {
    const r = this.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top, cam = this.s.cam;
    return {
      sx, sy, wx: cam.x + sx / cam.zoom, wy: cam.y + sy / cam.zoom,
      button: e.button, buttons: e.buttons, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, deltaY: e.deltaY || 0,
    };
  }

  attach() {
    const el = this.el, h = this._h;
    h.down = (e) => this.onDown(e);
    h.move = (e) => this.onMove(e);
    h.up = (e) => this.onUp(e);
    h.cancel = (e) => this.onCancel(e);
    h.leave = () => { this.mouse = null; this.s.onHover(null); };
    h.wheel = (e) => this.onWheel(e);
    h.dbl = (e) => { const ev = this.ev(e); this.s.tool.dbl(ev); };
    h.ctx = (e) => e.preventDefault();
    h.key = (e) => this.onKey(e);
    h.keyup = (e) => this.onKeyUp(e);
    h.blur = () => this.held.clear();
    el.addEventListener('pointerdown', h.down);
    el.addEventListener('pointermove', h.move);
    el.addEventListener('pointerup', h.up);
    el.addEventListener('pointercancel', h.cancel);
    el.addEventListener('pointerleave', h.leave);
    el.addEventListener('wheel', h.wheel, { passive: false });
    el.addEventListener('dblclick', h.dbl);
    el.addEventListener('contextmenu', h.ctx);
    window.addEventListener('keydown', h.key);
    window.addEventListener('keyup', h.keyup);
    window.addEventListener('blur', h.blur);
  }

  detach() {
    const el = this.el, h = this._h;
    el.removeEventListener('pointerdown', h.down);
    el.removeEventListener('pointermove', h.move);
    el.removeEventListener('pointerup', h.up);
    el.removeEventListener('pointercancel', h.cancel);
    el.removeEventListener('pointerleave', h.leave);
    el.removeEventListener('wheel', h.wheel);
    el.removeEventListener('dblclick', h.dbl);
    el.removeEventListener('contextmenu', h.ctx);
    window.removeEventListener('keydown', h.key);
    window.removeEventListener('keyup', h.keyup);
    window.removeEventListener('blur', h.blur);
  }

  onDown(e) {
    this.s.userGesture();
    if (this.s.blocked()) return;
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    const ev = this.ev(e);
    this.mouse = ev;
    if (e.button === 1) { this.pan = { x: ev.sx, y: ev.sy }; e.preventDefault(); return; }
    if (e.button === 2) {
      const corner = this.s.world.phase === 'planning' && !this.s.net ? findCorner(this.s, ev.sx, ev.sy) : null;
      if (corner) { this.gesture = new CornerDrag(this.s, corner); return; }
      this.rpan = { x: ev.sx, y: ev.sy, moved: false };
      return;
    }
    if (e.button === 0 && this.s.tool.name === 'zone' && this.s.world.phase === 'planning' && !this.s.tool.pts.length) {
      const corner = findCorner(this.s, ev.sx, ev.sy);
      if (corner) { this.gesture = new CornerDrag(this.s, corner); return; }
    }
    this.s.tool.down(ev);
  }

  onMove(e) {
    const ev = this.ev(e);
    this.mouse = ev;
    if (this.pan) { this.s.cam.pan(ev.sx - this.pan.x, ev.sy - this.pan.y); this.pan = { x: ev.sx, y: ev.sy }; return; }
    if (this.rpan) {
      if (!this.rpan.moved && Math.hypot(ev.sx - this.rpan.x, ev.sy - this.rpan.y) > 4) this.rpan.moved = true;
      if (this.rpan.moved) { this.s.cam.pan(ev.sx - this.rpan.x, ev.sy - this.rpan.y); this.rpan.x = ev.sx; this.rpan.y = ev.sy; }
      return;
    }
    if (this.gesture) { this.gesture.move(ev); return; }
    this.s.tool.move(ev);
    this.s.onHover(ev);
  }

  onUp(e) {
    const ev = this.ev(e);
    try { this.el.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    if (this.pan && e.button === 1) { this.pan = null; return; }
    if (this.rpan && e.button === 2) {
      const click = !this.rpan.moved;
      this.rpan = null;
      if (click && !this.s.tool.rightClick(ev)) this.s.action('cancel', null, { fromMouse: true });
      return;
    }
    if (this.gesture) { const g = this.gesture; this.gesture = null; g.up(ev); return; }
    this.s.tool.up(ev);
  }

  onCancel() { this.pan = null; this.rpan = null; this.gesture = null; }

  onWheel(e) {
    e.preventDefault();
    if (this.s.blocked()) return;
    const ev = this.ev(e);
    if (this.s.tool.wheel(ev)) return;
    this.s.cam.wheel(e.deltaY, ev.sx, ev.sy, e.deltaMode);
  }

  onKey(e) {
    if (typingInto(e.target) || this.s.externalOverlay()) return;
    this.s.userGesture();
    if (this.s.modalKey(e)) { e.preventDefault(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { if (this.s.tool.key('backspace')) e.preventDefault(); return; }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') { if (this.s.tool.key(e.code === 'BracketLeft' ? 'widthDown' : 'widthUp')) e.preventDefault(); return; }
    if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      const cam = this.s.cam;
      cam.zoomAtSmooth(cam.w / 2, cam.h / 2, e.code === 'Equal' || e.code === 'NumpadAdd' ? 1.4 : 1 / 1.4);
      e.preventDefault();
      return;
    }
    const actions = this.s.prefs.actionsFor(e);
    if (!actions.length) return;
    let handled = false;
    for (const a of actions) {
      if (PAN_ACTIONS[a]) continue;
      if (e.repeat && a !== 'slower' && a !== 'faster') { handled = !actions.some((b) => PAN_ACTIONS[b]); break; }
      if (this.s.action(a, e)) { handled = true; break; }
    }
    if (!handled) {
      const pan = actions.find((a) => PAN_ACTIONS[a]);
      if (pan) { this.held.set(e.code, pan); handled = true; }
    }
    if (handled) e.preventDefault();
  }

  onKeyUp(e) { this.held.delete(e.code); }

  update(dt) {
    let dx = 0, dy = 0;
    for (const a of this.held.values()) { const v = PAN_ACTIONS[a]; if (v) { dx += v[0]; dy += v[1]; } }
    const m = this.mouse, cam = this.s.cam;
    if (this.s.prefs.get().edgePan && m && !this.pan && !this.rpan) {
      const E = 8;
      if (m.sx < E) dx += 1; else if (m.sx > cam.w - E) dx -= 1;
      if (m.sy < E) dy += 1; else if (m.sy > cam.h - E) dy -= 1;
    }
    if (dx || dy) {
      const l = Math.hypot(dx, dy);
      cam.pan(dx / l * PAN_SPEED * dt, dy / l * PAN_SPEED * dt);
      if (m) { m.wx = cam.x + m.sx / cam.zoom; m.wy = cam.y + m.sy / cam.zoom; }
    }
  }
}
