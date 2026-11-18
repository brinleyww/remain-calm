// Tiny synchronous event emitter. Listeners run in registration order.

export class Emitter {
  constructor() { this._l = new Map(); }

  on(name, fn) {
    let list = this._l.get(name);
    if (!list) this._l.set(name, list = []);
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (d) => { off(); fn(d); });
    return off;
  }

  off(name, fn) {
    const list = this._l.get(name);
    if (!list) return;
    if (!fn) { this._l.delete(name); return; }
    const k = list.indexOf(fn);
    if (k >= 0) list.splice(k, 1);
  }

  emit(name, data) {
    const list = this._l.get(name);
    if (!list || !list.length) return;
    for (const fn of list.slice()) {
      try { fn(data); } catch (e) { console.error(`[events] '${name}' listener failed`, e); }
    }
  }

  has(name) { const l = this._l.get(name); return !!(l && l.length); }
  clear() { this._l.clear(); }
}
