// Session: one map being played. Owns the World (+ combat), the fixed-step loop, rendering, input, tools, HUD,
// info card, result card and menus, and reports results to the shell through callbacks.
import { World } from '../sim/world.js';
import { makeConfig } from '../data/config.js';
import { Camera } from '../render/camera.js';
import { getPalette, applyPalette, rgba } from '../render/palette.js';
import { drawStatic, drawScaleBar, invalidate, invalidateBuilding, invalidateBridge, pickBuilding, pickBridge } from '../render/maprender.js';
import { WorldRenderer } from '../render/worldrender.js';
import { Expand } from '../render/expand.js';
import { Markers, tag } from '../render/fx.js';
import { polyCentroid } from '../util/geom.js';
import { KIND_LABEL, KIND_TAG } from '../map/format.js';
import { HEIGHT_LABELS, heightClass } from '../render/palette.js';
import { loadCombat } from './combatapi.js';
import { loadPrefs } from './prefs.js';
import { Input } from './input.js';
import { makeTool } from './tools.js';
import { Hud } from './hud.js';
import { InfoCard } from './infocard.js';
import { Army } from './selection.js';
import { pickList, selOf, anchorOf, TIP_SEC } from './pick.js';
import { selectables } from '../sim/orders.js';
import { showResult } from './results.js';
import { openRefundPanel } from './refundpanel.js';
import { showPause, showWelcome, showLoadoutPicker, showQuickSettings, openModal, button } from './overlays.js';
import { Sfx } from './sfx.js';
import { h, esc, fmtInt, fmtMoney } from './el.js';
import { Pacer, SPEEDS, baseSpeed, simBudgetMs } from './pacer.js';

// Slow motion (nuke flash): a quarter of the chosen speed, never faster than SLOWMO sim seconds per real second.
const SLOWMO = 0.5;
const NO_UNDO = new Set(['ready', 'speed', 'stance.set', 'squad.mode', 'ability.use', 'unit.detonate', 'loadout.set', 'order']);
const LAYOUT = { left: 196, right: 276, top: 52, bottom: 92 };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Session {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = { mode: 'free', difficulty: 'normal', startStage: 0, ...opts };
    this.map = opts.map;
    this.owner = 0;
    this.net = opts.net || null;
    this.driver = null;
    this.destroyed = false;
    this.modals = [];
    this.undoStack = [];
    this.results = [];
    this.best = {};
    this.retries = 0;
    this.paused = false;
    this.paint = false;
    this.view = 'normal';
    this.rings = false;
    this.sel = null;
    this.hover = null;
    this.currentLabel = null;
    this.toolName = 'select';
    this.pacer = new Pacer(0.05);
    this.realSpeed = 0;
    this.liveRt = 0;
    this.speedLag = false;
    this.rt = performance.now() / 1000;
    this.slowUntil = 0;
    this.cityDirty = false;
    this.partner = null;
    this.perf = { fps: 0, frameMs: 0, simMs: 0, renderMs: 0, uiMs: 0, budgetMs: 0, ticks: 0 };
    this._rs = { t: 0, n: 0, want: 0, lag: 0 };
    this._fps = { t: 0, n: 0 };
    this._offs = [];
    this._nukes = new Set();
    this.markers = new Markers();
    this.sfxEngine = new Sfx();
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    if (this._started) return this;
    this._started = true;
    if (!this.map) throw new Error('Session needs a map');
    this.root = h('div.rc-game', { tabindex: '-1' });
    this.canvas = h('canvas.rc-canvas');
    this.overlay = h('div.rc-overlay');
    this.loading = h('div.rc-loading.card.raised', null, h('span.stamp.stamp-ink.tilt-2', null, 'Stand by'), h('p.mono.small', null, `Preparing ${this.map.name || 'the city'}...`));
    this.root.append(this.canvas, this.loading, this.overlay);
    this.container.append(this.root);
    const [prefs, combat, progress] = await Promise.all([loadPrefs(), loadCombat(), this.opts.unlocked || this.opts.mode === 'sandbox' ? null : import('../meta/progress.js').catch(() => null)]);
    if (this.destroyed) return this;
    this.prefs = prefs;
    this.combat = combat;
    this._progress = progress;
    if (!combat.ok) console.warn('[session] combat module unavailable; units and abilities are disabled', combat.error);
    this.pal = getPalette(this.opts.palette || prefs.palette(this.map));
    applyPalette(this.pal.name, this.root);
    this.root.style.setProperty('--ui-scale', String(prefs.get().uiScale));
    await nextFrame();
    if (this.destroyed) return this;
    if (this.net) {
      const mod = await import('../net/coop.js');
      this._coop = mod;
      this.owner = this.opts.owner ?? (this.net.role === 'guest' ? 1 : 0);
    }
    this.createWorld();
    this.buildUi();
    this.bindWorld();
    this.sfxEngine.setVolume(prefs.get().volume);
    this._offPrefs = prefs.onChange((p) => this.onPrefs(p));
    this.loading.remove();
    this.resize();
    this.fitStage(false);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.root);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    if (typeof window !== 'undefined') window.__rc = this;
    if (this.world.largeMap) this.largeMapBanner();
    if (this.world.stage === 0 && !this.opts.skipWelcome) showWelcome(this);
    else this.stageIntro();
    try { this.root.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    return this;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.expand) { this.expand.cancel(); this.expand = null; }
    if (this.input) this.input.detach();
    if (this._ro) this._ro.disconnect();
    for (const off of this._offs) off();
    this._offs = [];
    if (this._offPrefs) this._offPrefs();
    if (this.info) this.info.destroy();
    if (this.driver) this.driver.destroy();
    this.sfxEngine.destroy();
    for (const m of this.modals.slice()) m.close();
    if (this.root) this.root.remove();
    if (typeof window !== 'undefined' && window.__rc === this) window.__rc = undefined;
  }

  unlockFn() {
    const o = this.opts;
    if (o.mode === 'sandbox' || o.mode === 'test' || o.sandbox) return () => true;
    if (typeof o.isUnlocked === 'function') return o.isUnlocked;
    if (o.unlocked) { const set = o.unlocked instanceof Set ? o.unlocked : new Set(o.unlocked); return (id) => set.has(id); }
    if (this._progress && typeof this._progress.isUnlocked === 'function') return (id) => this._progress.isUnlocked(id);
    return () => true;
  }

  createWorld() {
    const o = this.opts, p = this.prefs.get();
    const sandbox = o.mode === 'sandbox' || !!o.sandbox;
    const lines = [...(o.mutators || [])].filter(Boolean);
    const hasPop = lines.some((l) => typeof l === 'string' ? /^\s*population\.scale\s*=/.test(l) : Array.isArray(l) && l[0] === 'population.scale');
    if (!hasPop && !this.net) lines.unshift(`population.scale=${+p.popScale.toFixed(3)}`);
    const cfg = makeConfig(lines, { difficulty: o.difficulty, sandbox });
    const w = new World(this.map, { cfg, difficulty: o.difficulty, sandbox, owners: this.net ? 2 : 1, stage: o.startStage | 0, seed: o.seed });
    const unlocked = this.unlockFn();
    const maxUp = o.maxUpgradeLevel;
    w.isUnlocked = (id) => {
      const m = /^upgrade(\d)$/.exec(id);
      if (m && Number.isFinite(maxUp)) return +m[1] <= maxUp;
      return unlocked(id);
    };
    this.combat.install(w);
    this.world = w;
    this.applyLoadout(o.loadout || this.defaultLoadout(), true);
    this.stageSnap = w.snapshot();
    if (this.net) this.startCoop();
  }

  defaultLoadout() {
    const w = this.world, cfg = w.cfg, ok = w.isUnlocked;
    if (this._progress && typeof this._progress.getLoadout === 'function') { try { return this._progress.getLoadout(); } catch (e) { /* fall back */ } }
    const order = ['garrison', 'sniper', 'turret', 'mortar', 'spikes', 'mine', 'gasMortar', 'c4', 'battleship', 'fireMortar', 'chemical', 'oil', 'napalm', 'mlrs', 'howitzer', 'railgun'];
    const units = order.filter((u) => cfg.units[u] && ok(u)).slice(0, cfg.loadoutSlots || 7);
    const abilities = {};
    let sp = w.sandbox ? 40 : w.sp.cap;
    for (const id of ['paratroopers', 'airstrike', 'fireBomb', 'callToArms']) {
      const a = cfg.abilities[id];
      if (a && ok(id) && a.sp <= sp) { abilities[id] = 1; sp -= a.sp; }
    }
    return { units, abilities };
  }

  // Sets the loadout, trimming ability charges until they fit the stage's command points.
  applyLoadout(lo, initial = false) {
    const w = this.world;
    if (!lo) return;
    const units = (lo.units || []).slice(0, w.cfg.loadoutSlots || 7).map((u) => (u && w.cfg.units[u] ? u : null));
    while (units.length && !units[units.length - 1]) units.pop();
    const ab = {};
    for (const [id, n] of Object.entries(lo.abilities || {})) if (w.cfg.abilities[id] && (n | 0) > 0) ab[id] = n | 0;
    const cap = w.sandbox ? Infinity : w.owners > 1 ? Math.floor(w.sp.cap / w.owners) : w.sp.cap;
    const cost = () => Object.entries(ab).reduce((a, [id, n]) => a + w.cfg.abilities[id].sp * n, 0);
    while (cost() > cap) {
      const ids = Object.keys(ab).sort((a, b) => w.cfg.abilities[b].sp - w.cfg.abilities[a].sp);
      if (!ids.length) break;
      if (--ab[ids[0]] <= 0) delete ab[ids[0]];
    }
    const cmd = { t: 'loadout.set', units, abilities: ab, owner: this.owner };
    if (initial || !this.driver) {
      const r = w.exec(cmd);
      if (!r.ok && !initial) this.flash(r.reason, 'warn');
    } else this.issue(cmd);
    if (this.hud) this.hud.rebuildSlots();
  }

  buildUi() {
    const w = this.world;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.cam = new Camera({ w: 800, h: 600, maxZoom: 12, minZoomFit: 0.55 });
    this.cam.setMap(this.map);
    this.wr = new WorldRenderer({ palette: this.pal, combat: this.combat });
    this.hud = new Hud(this, this.root);
    this.info = new InfoCard(this, this.hud.el.info);
    this.info.show(null);
    this.army = new Army(this);
    this.root.append(this.overlay);
    this.tool = makeTool(this, 'select');
    this.toolName = 'select';
    this.input = new Input(this, this.canvas);
    this.input.attach();
    this.hud.log(`${(w.region && w.region.label) || 'Stage ' + (w.stage + 1)}: planning. ${fmtInt(w.stats.civStart)} residents in the district.`, 'info', 0);
    if (w.popLimited) this.hud.log(`Large sheet: residents thinned to ${Math.max(1, Math.round(w.popFactor * 100))}% of the full count so it runs smoothly.`, 'info', 0);
  }

  bindWorld() {
    const ev = this.world.events;
    const on = (n, f) => this._offs.push(ev.on(n, f));
    on('log', (e) => this.onLog(e));
    on('sound', (e) => this.onSound(e));
    on('outbreak', (e) => this.onOutbreak(e));
    on('breach', () => { this.flash('A safe zone has been breached', 'alert'); });
    on('mutation', (e) => { this.markers.add({ kind: 'alert', x: e.x, y: e.y - 24, label: 'MUTANT', rt0: this.rt, lt0: this.liveRt, dur: 5 }); });
    on('collapse', (e) => { invalidateBuilding(this.map, e.b); this.cityDirty = true; if (this.sel && this.sel.kind === 'building' && this.sel.b === e.b) this.info.render(true); });
    on('bridgeDown', (e) => { invalidateBridge(this.map, e.id); this.cityDirty = true; });
    on('stageEnd', (e) => this.onStageEnd(e.result));
    on('changed', (e) => this.onChanged(e));
  }

  onPrefs(p) {
    this.sfxEngine.setVolume(p.volume);
    this.root.style.setProperty('--ui-scale', String(p.uiScale));
    this.hud.refreshKeys();
    this.resize();
  }

  // ---------------------------------------------------------------- world events
  onChanged(e) {
    this.wr.invalidate();
    const what = e && e.what;
    if (what === 'stage' || what === 'restore') {
      if (this.cityDirty) { invalidate(this.map); this.cityDirty = false; }
      this.wr.resetStage();
      this._nukes.clear();
      if (this.hud) this.hud.rebuildSlots();
    } else if (what === 'loadout.set' && this.hud) this.hud.rebuildSlots();
    else if (what === 'ready' && this.world.phase === 'battle') this.readySnap = this.world.snapshot();
    if (this.sel && this.info) this.info.render(true);
  }

  onLog(e) {
    if (!this.hud) return;
    const kind = e.kind === 'alert' ? 'alert' : e.kind === 'warn' ? 'warn' : /SECURED|RAISED|EVACUAT/.test(e.msg) ? 'good' : 'info';
    this.hud.log(e.msg, kind, this.world.t);
  }

  onSound(e) {
    let vol = e.vol ?? 0.7, pan = 0;
    if (Number.isFinite(e.x) && Number.isFinite(e.y) && (e.x || e.y)) {
      const cam = this.cam, cx = cam.cx, cy = cam.cy;
      const half = Math.hypot(cam.w, cam.h) / (2 * cam.zoom);
      const d = Math.hypot(e.x - cx, e.y - cy) / Math.max(1, half);
      vol *= Math.max(0.12, Math.min(1, 1.35 - d * 0.75));
      pan = Math.max(-0.7, Math.min(0.7, (e.x - cx) / Math.max(1, cam.w / (2 * cam.zoom)) * 0.6));
      if (e.name === 'nuke') this.onNuke(e);
    }
    this.sfx(e.name, vol, pan);
  }

  onNuke(e) {
    const key = `${Math.round(e.x)}|${Math.round(e.y)}|${Math.round(this.world.t)}`;
    if (this._nukes.has(key)) return;
    this._nukes.add(key);
    this.slowUntil = this.rt + 2.6;
    this.cam.flyTo(e.x, e.y, Math.max(this.cam.minZoom, Math.min(this.cam.zoom, 0.35)), 0.8);
  }

  onOutbreak(e) {
    const r = this.world.cfg.outbreak.radius;
    const label = e.edge ? 'HORDE' : e.secondary ? 'SECOND OUTBREAK' : 'OUTBREAK';
    for (const [x, y] of e.sites || []) this.markers.add({ kind: 'outbreak', x, y, r: e.edge ? 40 : r, rt0: this.rt, lt0: this.liveRt, dur: e.secondary || e.edge ? 10 : 16, label });
    if (!e.secondary && !e.edge) {
      if (this.prefs.get().autoPause && !this.net) {
        this.paused = true;
        this.flash(`Outbreak confirmed at ${(e.sites || []).length} site${(e.sites || []).length === 1 ? '' : 's'}. Paused: press Space to start the clock.`, 'alert');
      } else this.flash(`Outbreak confirmed at ${(e.sites || []).length} sites`, 'alert');
    } else this.flash(e.edge ? 'A horde is walking in from the city limits' : 'A second outbreak has been reported', 'alert');
  }

  onStageEnd(r) {
    if (!r) return;
    this.results.push(r);
    this.setTool('select');
    this.paused = false;
    let shell = null;
    if (typeof this.opts.onStageResult === 'function') { try { shell = this.opts.onStageResult(r) || null; } catch (err) { console.error(err); } }
    const prev = this.bestFor(r.stage);
    if (r.won && (!this.best[r.stage] || r.pct > this.best[r.stage].pct)) this.best[r.stage] = { pct: r.pct, badge: r.badge };
    const best = (shell && shell.best) || prev;
    clearTimeout(this._resT);
    this._resT = setTimeout(() => { if (!this.destroyed) this.resultModal = showResult(this, r, best, shell); }, 1400);
  }

  bestFor(stage) {
    const o = this.opts;
    if (typeof o.getBest === 'function') { try { const b = o.getBest(stage, this.world.difficulty); if (b) return b; } catch (e) { /* ignore */ } }
    if (o.mapKey && this._progress && this._progress.bestRecord) { try { const b = this._progress.bestRecord(o.mapKey, stage, this.world.difficulty); if (b) return b; } catch (e) { /* ignore */ } }
    return this.best[stage] || null;
  }

  // ---------------------------------------------------------------- commands
  issue(cmd, o = {}) {
    const w = this.world;
    cmd = { ...cmd, owner: this.owner };
    if (this.driver) {
      const q = w.quote(cmd);
      if (!q.ok && !cmd.t.startsWith('session.') && q.reason !== 'Unknown command') { if (!o.silent) { this.flash(q.reason, 'warn'); this.sfx('error'); } return q; }
      this.driver.submit(cmd, (r) => { if (r && r.ok) this.feedback(cmd, r); else if (r && !o.silent) this.flash(r.reason, 'warn'); });
      return { ok: true, pending: true, cost: q.cost };
    }
    const undoable = w.phase === 'planning' && !NO_UNDO.has(cmd.t) && !o.noUndo;
    const snap = undoable ? w.snapshot() : null;
    let r;
    try { r = w.exec(cmd); } catch (e) { console.error('[session] command failed', cmd, e); r = { ok: false, reason: 'That did not work' }; }
    if (r.ok) { if (snap) this.pushUndo(snap); this.feedback(cmd, r); }
    else if (!o.silent) { this.flash(r.reason || 'Not possible', 'warn'); this.sfx('error'); }
    return r;
  }

  quote(cmd) {
    try { return this.world.quote({ ...cmd, owner: this.owner }); } catch (e) { console.error('[session] quote failed', cmd, e); return { ok: false, reason: 'Not possible', cost: 0 }; }
  }

  feedback(cmd, r) {
    const t = cmd.t;
    if (t.endsWith('.remove') || t === 'unit.refund' || t === 'refund.many') this.sfx('refund');
    else if (t === 'unit.upgrade' || t === 'zone.upgrade') this.sfx('upgrade');
    else if (t === 'ready') this.sfx('ready');
    else if (t === 'ability.use') this.sfx('clack');
    else if (t !== 'speed') this.sfx('place');
    const m = this.input && this.input.mouse;
    if (m && t !== 'speed' && t !== 'ready') this.markers.add({ kind: 'pulse', x: m.wx, y: m.wy, rt0: this.rt, dur: 0.45, ok: true });
  }

  pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 60) this.undoStack.shift();
  }

  undo() {
    const w = this.world;
    if (this.net) { this.flash('Undo is not available in co-op', 'warn'); return; }
    if (w.phase !== 'planning') { this.flash('Undo works during planning only', 'warn'); return; }
    const snap = this.undoStack.pop();
    if (!snap) { this.flash('Nothing to undo', 'warn'); return; }
    this.tool.key('cancel');
    w.restore(snap);
    if (this.sel && !this.selValid(this.sel)) this.select(null);
    this.flash('Undone', 'info');
    this.sfx('refund');
  }

  // ---------------------------------------------------------------- stage flow
  ready() {
    const w = this.world;
    if (this.modalOpen()) return;
    if (w.phase === 'planning') {
      const mine = !!(w.readyFlags && w.readyFlags[this.owner]);
      const r = this.issue({ t: 'ready', ready: !mine });
      if (r.ok && (r.started || this.driver)) { this.undoStack = []; if (r.started) this.setTool('select'); }
    } else if (w.phase === 'battle') this.togglePause();
  }

  togglePause() {
    const w = this.world;
    if (w.phase !== 'battle') return;
    if (this.driver) { this.issue({ t: 'speed', s: w.speed > 0 ? 0 : this._lastSpeed || 1 }); if (w.speed > 0) this._lastSpeed = w.speed; return; }
    this.paused = !this.paused;
    this.sfx('tick');
  }

  setSpeed(v) {
    const w = this.world;
    if (this.driver) { this.issue({ t: 'speed', s: v }); return; }
    if (w.speed !== v) w.exec({ t: 'speed', s: v, owner: this.owner });
    this.paused = false;
    this.sfx('tick');
  }

  stepSpeed(d) {
    const w = this.world, s = w.speed > 0 ? w.speed : this._lastSpeed || 1;
    let k = 0;
    for (let i = 1; i < SPEEDS.length; i++) if (Math.abs(SPEEDS[i] - s) < Math.abs(SPEEDS[k] - s)) k = i;
    k = Math.max(0, Math.min(SPEEDS.length - 1, k + d));
    this.setSpeed(SPEEDS[k]);
  }

  // Sim seconds per real second the clock asks for right now (0 when stopped).
  simRate() {
    const w = this.world;
    if (w.phase !== 'battle' || this.paused || this.modalOpen()) return 0;
    const r = Math.max(0, w.speed) * baseSpeed(w.cfg);
    return this.rt < this.slowUntil ? Math.min(r * 0.25, SLOWMO) : r;
  }

  // The speed actually achieved, on the same scale as the speed buttons.
  runningSpeed() { return this.realSpeed / baseSpeed(this.world.cfg); }

  retry() {
    if (this.driver && !this._fromNet) { this.issue({ t: 'session.retry' }); return; }
    this.closeTransient();
    this.retries++;
    const w = this.world;
    // After a battle, retry keeps the layout the player pressed READY with; during planning it resets to the stage start.
    const fromReady = w.phase !== 'planning' && this.readySnap && (this.readySnap.stage | 0) === w.stage;
    w.restore(fromReady ? this.readySnap : this.stageSnap);
    this.afterStageReset();
    this.hud.log(fromReady ? 'Stage reset: your layout from READY is restored.' : 'Stage reset to the start of planning.', 'warn', 0);
    this.stageIntro();
  }

  nextStage() {
    const w = this.world, r = w.result;
    if (!r || !r.won || r.last) return;
    if (this.driver && !this._fromNet) { this.issue({ t: 'session.next' }); return; }
    this.closeTransient();
    const from = w.region.poly;
    w.beginStage(w.stage + 1);
    this.stageSnap = w.snapshot();
    this.readySnap = null;
    this.afterStageReset();
    try {
      const ex = new Expand(this, from, () => { if (this.expand === ex) this.expand = null; this.stageIntro(); });
      this.expand = ex;
      this.fitStage(true, ex.camSec);
    } catch (e) {
      console.warn('[session] stage growth animation failed', e);
      this.expand = null;
      this.fitStage(true);
      this.stageIntro();
    }
  }

  afterStageReset() {
    if (this.expand) { this.expand.cancel(); this.expand = null; }
    this.undoStack = [];
    this.paused = false;
    this.slowUntil = 0;
    this.pacer.reset();
    this.markers.clear();
    this.select(null);
    this.setTool('select');
    this.hud.clearLog();
    this.hud.rebuildSlots();
    const w = this.world;
    this.hud.log(`${w.region.label || 'Stage ' + (w.stage + 1)}: planning. ${fmtInt(w.stats.civStart)} residents, budget ${w.sandbox ? 'unlimited' : fmtMoney(w.budget.cap)}.`, 'info', 0);
    if (w.popLimited) this.hud.log(`Large sheet: residents thinned to ${Math.max(1, Math.round(w.popFactor * 100))}% of the full count so it runs smoothly.`, 'info', 0);
    if (w.largeMap) this.largeMapBanner();
  }

  stageIntro() {
    const w = this.world;
    this.flash(`Stage ${w.stage + 1} of ${w.stageCount}: ${w.sandbox ? 'unlimited funds' : fmtMoney(w.budget.cap - w.budget.spent) + ' available'}, ${w.sandbox ? 'unlimited' : w.sp.cap} SP`, 'info');
  }

  closeTransient() {
    clearTimeout(this._resT);
    for (const m of this.modals.slice()) m.close();
  }

  quit(reason = 'quit') {
    if (this.expand) { this.expand.cancel(); this.expand = null; }
    const summary = {
      reason, mode: this.opts.mode, map: this.map.name || '', stage: this.world.stage, stageCount: this.world.stageCount,
      results: this.results.slice(), retries: this.retries, difficulty: this.world.difficulty,
      campaign: this.opts.campaign || null, flawless: this.retries === 0 && this.results.length > 0 && this.results.every((r) => r.won),
      completed: reason === 'complete',
    };
    if (this.driver && !this._fromNet) { try { this.driver.sendPeer({ k: 'bye' }); } catch (e) { /* link down */ } }
    if (typeof this.opts.onExit === 'function') { this.opts.onExit(summary); return; }
    this.paused = true;
    let m = null;
    m = openModal(this, { title: 'Session ended', no: 'OCP-99', dismiss: false, body: `<p>${esc(reason === 'complete' ? 'Every stage of this city is secured.' : 'You left the exercise.')}</p>`,
      foot: [button('Play again', () => { m.close(); this.world.beginStage(0); this.stageSnap = this.world.snapshot(); this.afterStageReset(); this.fitStage(true); }, { cls: 'btn-primary', primary: true })] });
  }

  // ---------------------------------------------------------------- co-op
  startCoop() {
    const mod = this._coop;
    if (!mod || typeof mod.LockstepDriver !== 'function') return;
    const d = this.driver = new mod.LockstepDriver(this.world, this.net, this.owner);
    d.onSession = (cmd) => {
      this._fromNet = true;
      try {
        if (cmd.t === 'session.next') this.nextStage();
        else if (cmd.t === 'session.retry') this.retry();
      } finally { this._fromNet = false; }
      return { ok: true };
    };
    d.onApply = (cmd, res, local) => { if (!local && res && res.ok && cmd.t === 'ready') this.flash(res.started ? 'Both commanders ready' : 'Your partner is ready', 'info'); };
    d.onPeer = (m) => {
      if (m.k === 'cur') this.partner = { x: m.x, y: m.y, tool: m.tool || '', rt: this.rt };
      else if (m.k === 'bye') this.hud.banner('<b>Your partner left the exercise.</b> <button class="btn btn-sm" data-close>Dismiss</button>', 'warn');
    };
    d.onDesync = (e) => this.hud.banner(`<b>DESYNC.</b> The two boards no longer match (tick ${e.tick}). Results from here on may differ. <button class="btn btn-sm" data-close>Dismiss</button>`, 'alert');
    d.onDisconnect = (reason, text) => this.hud.banner(`<b>Link lost.</b> ${esc(text || reason || '')} <button class="btn btn-sm" data-close>Dismiss</button>`, 'alert');
  }

  // ---------------------------------------------------------------- tools and selection
  setTool(name) {
    const w = this.world;
    if (name !== 'select' && (w.phase === 'won' || w.phase === 'lost')) return;
    if ((name.startsWith('unit:') || name.startsWith('ability:')) && !this.combat.ok) { this.flash('Combat module unavailable', 'warn'); return; }
    if (this.tool) this.tool.exit();
    this.tool = makeTool(this, name);
    this.toolName = name;
    this.tool.enter();
    if (this.input && this.input.mouse) this.tool.move(this.input.mouse);
    this.canvas.style.cursor = this.tool.cursor();
    if (name !== 'select') this.sfx('clack');
  }

  togglePaint() { this.paint = !this.paint; this.flash(this.paint ? 'Paint mode: drag across roofs to man every building swept' : 'Paint mode off', 'info'); }
  toggleView(v) { this.view = this.view === v ? 'normal' : v; }
  toggleRings() { this.rings = !this.rings; }

  select(sel) {
    this.sel = sel;
    if (this.info) this.info.show(sel);
    if (sel) this.sfx('clack');
  }

  selValid(sel) {
    const w = this.world;
    switch (sel.kind) {
      case 'unit': return w.units.some((u) => u && u.id === sel.id && u.alive !== false);
      case 'zone': return !!w.zones.comps[sel.comp];
      case 'gate': return w.zones.gates.some((g) => g.id === sel.id);
      case 'corridor': return w.corridors.some((c) => c.id === sel.id);
      case 'hold': return w.holds.some((c) => c.id === sel.id);
      case 'wall': return w.walls.some((c) => c.id === sel.id);
      default: return true;
    }
  }

  abilityOrder() {
    const w = this.world, ids = [];
    for (const id of Object.keys(w.cfg.abilities)) if ((w.loadout.abilities && w.loadout.abilities[id] > 0) || (w.charges && w.charges[id] > 0)) ids.push(id);
    return ids.slice(0, 8);
  }

  pickAbility(id) {
    const w = this.world;
    if (!id) return;
    const st = this.combat.abilityState(w, id);
    if (w.phase === 'planning') { this.flash('Abilities are called in once the outbreak starts', 'warn'); return; }
    if (w.phase !== 'battle') return;
    if (st.charges <= 0) { this.flash('No charges left', 'warn'); return; }
    if (st.unlockIn > 0) { this.flash(`${this.combat.abilityName(id)} is available in ${Math.ceil(st.unlockIn)} s`, 'warn'); return; }
    this.setTool(this.toolName === 'ability:' + id ? 'select' : 'ability:' + id);
  }

  openLoadout() {
    const w = this.world;
    if (w.phase !== 'planning') { this.flash('The loadout can only change during planning', 'warn'); return; }
    if (this.modalOpen()) return;
    const done = (lo) => { if (lo && !this.destroyed) this.applyLoadout(lo); };
    if (typeof this.opts.openLoadout === 'function') {
      this._loadoutOpen = true;
      try { this.opts.openLoadout(w, (lo) => { this._loadoutOpen = false; done(lo); }); } catch (e) { this._loadoutOpen = false; console.error(e); showLoadoutPicker(this, done); }
    } else showLoadoutPicker(this, done);
  }

  openSettings() {
    if (typeof this.opts.openSettings === 'function') {
      this._settingsOpen = true;
      const wasPaused = this.paused;
      if (this.world.phase === 'battle' && !this.net) this.paused = true;
      try { this.opts.openSettings(() => { this._settingsOpen = false; this.paused = wasPaused; }); } catch (e) { this._settingsOpen = false; console.error(e); showQuickSettings(this); }
    } else showQuickSettings(this);
  }

  openFeedback() {
    if (typeof this.opts.openFeedback !== 'function' || this.modalOpen()) return;
    this._feedbackOpen = true;
    const wasPaused = this.paused;
    if (this.world.phase === 'battle' && !this.net) this.paused = true;
    try { this.opts.openFeedback(() => { this._feedbackOpen = false; this.paused = wasPaused; }); } catch (e) { this._feedbackOpen = false; this.paused = wasPaused; console.error(e); }
  }

  openPause() {
    if (this.modalOpen()) return;
    const m = showPause(this);
    const list = typeof this.opts.openFeedback === 'function' && m && m.body.querySelector('.vstack');
    if (list) list.insertBefore(button('Send feedback', () => { m.close(); this.openFeedback(); }, { cls: 'btn-block' }), list.querySelector('.btn-ghost'));
  }
  openRefundPanel(items) { openRefundPanel(this, items); }
  modalOpen() { return this.modals.length > 0 || !!this._loadoutOpen || !!this._settingsOpen || !!this._feedbackOpen; }
  blocked() { return this.modalOpen(); }
  externalOverlay() { return !!(this._loadoutOpen || this._settingsOpen || this._feedbackOpen); }
  modalKey(e) {
    const m = this.modals[this.modals.length - 1];
    return m ? m.key(e) : false;
  }

  flash(msg, kind = 'warn') { if (this.hud && msg) this.hud.flash(msg, kind); }
  sfx(name, vol = 0.6, pan = 0) { this.sfxEngine.play(name, vol, pan); }
  userGesture() { this.sfxEngine.resume(); }

  largeMapBanner() {
    const w = this.world;
    this.hud.banner(`<b>Large map.</b> This stage would hold more than ${fmtInt(w.cfg.sim.maxAgents)} residents, so the crowd is capped. Lower the population size in Settings if the game runs slowly. <button type="button" class="btn btn-sm" data-close>Understood</button>`, 'warn');
  }

  // ---------------------------------------------------------------- keyboard actions
  action(name, e = null, o = {}) {
    const w = this.world;
    const toggleTool = (t) => { this.setTool(this.toolName === t ? 'select' : t); return true; };
    if (/^unit[1-7]$/.test(name)) {
      const type = (w.loadout.units || [])[+name.slice(4) - 1];
      if (!type) { this.flash('That loadout slot is empty', 'warn'); return true; }
      return toggleTool('unit:' + type);
    }
    if (/^ability[1-8]$/.test(name)) { this.pickAbility(this.abilityOrder()[+name.slice(7) - 1]); return true; }
    if (this.army && this.army.handles(name)) return this.army.action(name);
    switch (name) {
      case 'ready': this.ready(); return true;
      case 'slower': this.stepSpeed(-1); return true;
      case 'faster': this.stepSpeed(1); return true;
      case 'confirm':
        if (this.tool.key('confirm')) return true;
        if (w.phase === 'planning' && this.toolName === 'select') return false;
        return false;
      case 'cancel':
        if (this.tool.key('cancel')) return true;
        if (this.toolName !== 'select') { this.setTool('select'); return true; }
        if (this.sel) { this.select(null); return true; }
        if (o.fromMouse) return true;
        this.openPause();
        return true;
      case 'zone': case 'wall': case 'gate': case 'corridor': case 'hold': case 'upgrade': case 'refund':
        if (w.phase === 'won' || w.phase === 'lost') return true;
        return toggleTool(name);
      case 'loadout': this.openLoadout(); return true;
      case 'paint': this.togglePaint(); return true;
      case 'detonate': {
        if (!this.sel || this.sel.kind !== 'unit') return false;
        const u = w.units.find((q) => q && q.id === this.sel.id);
        if (!u || !(w.cfg.units[u.type] || {}).manual) return false;
        this.issue({ t: 'unit.detonate', id: u.id });
        return true;
      }
      case 'viewHeights': this.toggleView('height'); return true;
      case 'viewSpecials': this.toggleView('specials'); return true;
      case 'viewRanges': this.toggleRings(); return true;
      case 'undo': this.undo(); return true;
      case 'fitStage': this.fitStage(true); return true;
      default: return false;
    }
  }

  // ---------------------------------------------------------------- picking (order and hit sizes: js/game/pick.js)
  pickList(wx, wy, o = {}) {
    const map = this.map;
    return pickList(this.world, wx, wy, {
      zoom: this.cam.zoom, owner: this.owner,
      pickBuilding: (x, y, dead) => pickBuilding(map, x, y, dead), pickBridge: (x, y) => pickBridge(map, x, y, 3), ...o,
    });
  }

  // Own unit under the cursor (upgrade tool, garrison abilities); alt takes the next one.
  pickUnit(sx, sy, wx, wy, filter = null, alt = false) {
    const list = this.pickList(wx, wy, { units: true, mine: true, filter });
    const c = list[alt && list.length > 1 ? 1 : 0];
    return c ? this.world.units.find((u) => u && u.id === c.id) || null : null;
  }

  pickAt(sx, sy, wx, wy) { return selOf(this.pickList(wx, wy)[0]); }

  // Own placement under the cursor for the refund tool: { cmd, key, label, x, y, paid, hover }; alt takes the next one.
  pickPlacement(sx, sy, wx, wy, alt = false) {
    const w = this.world;
    const list = this.pickList(wx, wy, { mine: true, troops: false, zonePolys: true });
    const c = list[alt && list.length > 1 ? 1 : 0];
    if (!c) return null;
    const [x, y] = anchorOf(w, c, wx, wy);
    const it = (c.kind === 'unit' ? w.units : c.kind === 'gate' ? w.zones.gates : c.kind === 'wall' ? w.walls : c.kind === 'corridor' ? w.corridors : c.kind === 'hold' ? w.holds : w.zones.polys)
      .find((q) => q && q.id === c.id);
    if (!it) return null;
    const out = (t, label, paid = it.paid) => ({ cmd: { t, id: it.id }, key: c.key, label, x, y, paid, hover: c });
    switch (c.kind) {
      case 'unit': return out('unit.refund', this.combat.unitName(it.type));
      case 'gate': return out('gate.remove', 'gate');
      case 'wall': return out('wall.remove', 'wall');
      case 'corridor': return out('corridor.remove', 'corridor');
      case 'hold': return out('hold.remove', 'hold point');
      default: return out('zone.remove', 'safe zone', (it.paid || 0) + (it.upPaid || 0));
    }
  }

  placementsInBox(x0, y0, x1, y1) {
    const w = this.world, out = [];
    const mine = (it) => w.owners < 2 || it.owner === this.owner;
    const inBox = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    for (const u of this.combat.unitsInRect(w, x0, y0, x1, y1)) if (mine(u)) out.push({ kind: 'unit', id: u.id, group: u.type, label: this.combat.unitName(u.type), paid: u.paid });
    for (const g of w.zones.gates) if (mine(g) && inBox(g.x, g.y)) out.push({ kind: 'gate', id: g.id, label: 'Gates', paid: g.paid });
    for (const wl of w.walls) if (mine(wl) && wl.p.some((v, k) => k % 2 === 0 && inBox(v, wl.p[k + 1]))) out.push({ kind: 'wall', id: wl.id, label: 'Walls', paid: wl.paid });
    for (const co of w.corridors) if (mine(co) && inBox((co.x0 + co.x1) / 2, (co.y0 + co.y1) / 2)) out.push({ kind: 'corridor', id: co.id, label: 'Corridors', paid: co.paid });
    for (const ho of w.holds) if (mine(ho) && inBox(ho.x, ho.y)) out.push({ kind: 'hold', id: ho.id, label: 'Hold points', paid: ho.paid });
    for (const pl of w.zones.polys) {
      if (!mine(pl)) continue;
      const [cx, cy] = polyCentroid(pl.p);
      if (inBox(cx, cy)) out.push({ kind: 'zone', id: pl.id, label: 'Safe zones', paid: (pl.paid || 0) + (pl.upPaid || 0) });
    }
    return out;
  }

  onHover(e) {
    this._hoverE = e;
    if (!e) { this.hover = null; this._tip = null; if (this.hud) this.hud.tooltip(null); return; }
    const a = this._hoverA;
    if (!a || Math.hypot(e.sx - a.sx, e.sy - a.sy) > 3) { this._hoverA = { sx: e.sx, sy: e.sy }; this._hoverRt = this.rt; }
    // at once, so the outline and the tooltip keep up with the pointer (a pick costs a few microseconds)
    if (this.input && this.hud) this.updateHover();
  }

  // What a click would pick (outlined by Army.outline) and its tooltip. now: after a click, skip the debounce.
  updateHover(now = false) {
    const e = this._hoverE;
    if (!e || !this.input || this.input.pan || this.input.rpan || this.input.gesture || this.modalOpen()) { this.hover = null; this._tip = null; if (this.hud) this.hud.tooltip(null); return; }
    const cam = this.cam;
    e.wx = cam.x + e.sx / cam.zoom; e.wy = cam.y + e.sy / cam.zoom;
    if (cam.version !== this._hoverCamV) { this._hoverCamV = cam.version; this._hoverRt = this.rt; }
    const tn = this.toolName;
    const w = this.world, alt = !!this.input.alt;
    let list = null, idx = -1;
    if (tn === 'select') {
      if (this.tool.drag || this.army.aim) this.hover = null;
      else { list = this.pickList(e.wx, e.wy); idx = this.army.peek(e, list, alt); this.hover = list[idx] || null; }
    } else if (tn === 'refund') {
      const it = this.tool.box ? null : this.pickPlacement(e.sx, e.sy, e.wx, e.wy, alt);
      this.hover = it ? it.hover : null;
    } else if (tn === 'upgrade') {
      const u = this.pickUnit(e.sx, e.sy, e.wx, e.wy, null, alt);
      this.hover = u ? { kind: 'unit', id: u.id, b: u.b, key: 'u' + u.id } : null;
    } else if (tn.startsWith('unit:')) {
      const c = w.cfg.units[tn.slice(5)] || {};
      const b = /building/.test(c.mount || '') ? pickBuilding(this.map, e.wx, e.wy) : -1;
      this.hover = b >= 0 ? { kind: 'building', b } : null;
    } else if (tn.startsWith('ability:')) {
      const b = /building/.test((w.cfg.abilities[tn.slice(8)] || {}).target || '') ? pickBuilding(this.map, e.wx, e.wy) : -1;
      this.hover = b >= 0 ? { kind: 'building', b } : null;
    } else this.hover = null;
    this.updateTip(e, list, idx, now);
  }

  // The tooltip shows once the pointer rests TIP_SEC, then follows it while the target stays the same. A change the
  // pointer did not cause (troops walking in and out of reach) must hold for two hover ticks, so it never flickers.
  updateTip(e, list, idx, now) {
    const tip = this._tip || (this._tip = { key: '', pend: '', html: '', t: 0, on: false });
    const key = list && list[idx] ? `${list.map((c) => c.key).join(' ')}#${idx}` : '';
    const still = this.rt - this._hoverRt >= TIP_SEC;
    if (key !== tip.key) {
      if (!now && still && tip.on && key !== tip.pend) { tip.pend = key; this.hud.tooltip(tip.html, e.sx, e.sy); return; }
      tip.key = key; tip.pend = ''; tip.on = false; tip.html = key ? this.tipHtml(list, idx) : ''; tip.t = this.rt;
    } else tip.pend = '';
    if (!key || (!tip.on && !still)) { this.hud.tooltip(null); return; }
    if (this.rt - tip.t > 0.5) { tip.html = this.tipHtml(list, idx); tip.t = this.rt; }
    tip.on = true;
    this.hud.tooltip(tip.html, e.sx, e.sy);
  }

  tipHtml(list, i) {
    const sels = list.some((c) => c.kind === 'troop') ? selectables(this.world, this.owner) : [];
    let o = this.tooltipHtml(list[i], sels);
    if (list.length > 1) o += `<p class="rc-tip-more">Click again for <b>${esc(this.pickName(list[(i + 1) % list.length], sels))}</b>${list.length > 2 ? ` · ${i + 1} of ${list.length}` : ''}</p>`;
    return o;
  }

  pickName(c, sels = []) {
    const w = this.world, find = (l) => (l || []).find((q) => q && q.id === c.id);
    switch (c.kind) {
      case 'unit': { const u = find(w.units); return u ? this.combat.unitName(u.type) : 'Unit'; }
      case 'troop': { const e = sels.find((q) => q.ref === c.ref); return e ? e.label : 'Squad'; }
      case 'squad': return 'Armed group';
      case 'building': { const b = w.buildings[c.b], m = this.map.buildings[c.b] || {}; return (m.name || (b && (b.use || KIND_LABEL[b.k])) || 'Building') + (b && !b.alive ? ' (collapsed)' : ''); }
      case 'zone': return `Safe zone ${c.comp + 1}`;
      case 'bridge': return (this.map.roads[c.road] || {}).name || 'Bridge';
      default: return { gate: 'Gate', wall: 'Wall', corridor: 'Evac corridor', hold: 'Hold point', zonepoly: 'Safe zone' }[c.kind] || '';
    }
  }

  tooltipHtml(t, sels = []) {
    const w = this.world;
    const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><i></i><b>${v}</b></div>`;
    if (t.kind === 'building') {
      const b = w.buildings[t.b], m = this.map.buildings[t.b] || {};
      if (!b) return '';
      const tagc = KIND_TAG[b.k];
      let o = `<p class="tooltip-title">${esc(m.name || b.use || KIND_LABEL[b.k] || 'Building')}${tagc ? ` <span class="tooltip-sub">${tagc}</span>` : ''}</p>`;
      o += kv('Height', `${Math.round(b.h)} m`) + kv('Class', HEIGHT_LABELS[heightClass(b.h)]);
      if (!b.alive) o += kv('State', 'collapsed');
      else if (b.hp < b.hpMax) o += kv('Structure', `${Math.round(b.hp / b.hpMax * 100)}%`);
      if (b.func) o += kv('Function', esc(b.func));
      const unit = w.units.find((u) => u && u.alive !== false && u.b === t.b);
      if (unit) o += kv('Manned by', esc(this.combat.unitShort(unit.type)));
      if (w.buildingInZone(t.b) >= 0) o += kv('Zone', 'inside');
      return o;
    }
    if (t.kind === 'unit') {
      const u = w.units.find((q) => q && q.id === t.id);
      if (!u) return '';
      return `<p class="tooltip-title">${esc(this.combat.unitName(u.type))} <span class="tooltip-sub">L${u.level || 1}</span></p>${kv('Kills', fmtInt(u.kills || 0))}${kv('Range', `${Math.round(this.combat.unitRange(w, u))} m`)}`;
    }
    if (t.kind === 'zone') {
      const c = w.zones.comps[t.comp];
      return c ? `<p class="tooltip-title">Safe zone ${c.id + 1}</p>${kv('Walls', `level ${c.wallLevel}`)}${kv('Gates', w.zones.gates.filter((g) => g.comp === c.id).length)}${c.breached ? kv('State', '<span class="red">breached</span>') : ''}` : '';
    }
    if (t.kind === 'bridge') {
      const br = w.bridges[t.id];
      return br ? `<p class="tooltip-title">${esc((this.map.roads[t.road] || {}).name || 'Bridge')}</p>${kv('Structural integrity', `${Math.round(br.hp / br.hpMax * 100)}%`)}${kv('Span', `${Math.round(br.len)} m`)}` : '';
    }
    if (t.kind === 'squad') return `<p class="tooltip-title">Armed group</p>${kv('Click', 'select')}${kv('Right-click', 'move there')}`;
    if (t.kind === 'troop') {
      const e = sels.find((q) => q.ref === t.ref);
      return e ? `<p class="tooltip-title">${esc(e.label)}</p>${e.vehicle ? '' : kv('Men', fmtInt(e.n))}${kv('Click', 'select')}${kv('Right-click', 'move there')}` : '';
    }
    if (t.kind === 'gate') { const g = w.zones.gates.find((q) => q.id === t.id); return g ? `<p class="tooltip-title">Gate</p>${kv('Integrity', `${Math.round(g.hp / g.hpMax * 100)}%`)}` : ''; }
    if (t.kind === 'corridor') return '<p class="tooltip-title">Evac corridor</p>';
    if (t.kind === 'hold') return '<p class="tooltip-title">Hold point</p>';
    if (t.kind === 'wall') return '<p class="tooltip-title">Wall</p>';
    if (t.kind === 'zonepoly') return '<p class="tooltip-title">Safe zone</p>';
    return '';
  }

  // ---------------------------------------------------------------- camera
  viewRect() {
    const cam = this.cam, compact = cam.w < 1100;
    const L = compact ? 12 : LAYOUT.left, R = compact ? 12 : LAYOUT.right;
    return { x: L, y: LAYOUT.top, w: Math.max(200, cam.w - L - R), h: Math.max(160, cam.h - LAYOUT.top - LAYOUT.bottom) };
  }

  fitStage(smooth = true, sec = 0.6) {
    const cam = this.cam, bb = this.world.region.bbox, v = this.viewRect();
    const z = Math.max(cam.minZoom, Math.min(cam.maxZoom, cam.fitZoom(bb, 16, v.w, v.h)));
    const offX = (v.x + v.w / 2 - cam.w / 2) / z, offY = (v.y + v.h / 2 - cam.h / 2) / z;
    const cx = (bb[0] + bb[2]) / 2 - offX, cy = (bb[1] + bb[3]) / 2 - offY;
    if (smooth) cam.flyTo(cx, cy, z, sec); else cam.centerOn(cx, cy, z);
  }

  resize() {
    if (!this.cam) return;
    const r = this.root.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hh * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hh * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = hh + 'px';
    }
    this.cam.resize(w, hh);
    if (this.hud) this.hud.paintGlyphs();
  }

  // ---------------------------------------------------------------- loop
  frame = (now) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const real = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.rt = now / 1000;
    try {
      const f0 = performance.now();
      const simMs = this.tick(real);
      const t0 = performance.now();
      this.render();
      const t1 = performance.now();
      this.perf.renderMs = this.perf.renderMs * 0.9 + (t1 - t0) * 0.1;
      this.hud.frame(real);
      this.info.frame(real);
      this.perf.uiMs = this.perf.uiMs * 0.9 + Math.max(0, performance.now() - f0 - (t1 - t0) - simMs) * 0.1;
    } catch (e) {
      console.error('[session] frame failed', e);
      this._errors = (this._errors || 0) + 1;
      if (this._errors > 30) { cancelAnimationFrame(this.raf); this.hud && this.hud.banner(`<b>The game stopped:</b> ${esc(e.message || e)}`, 'alert'); }
    }
    this._fps.t += real; this._fps.n++;
    if (this._fps.t >= 0.5) { this.perf.fps = this._fps.n / this._fps.t; this.perf.frameMs = this._fps.t / this._fps.n * 1000; this._fps.t = 0; this._fps.n = 0; }
  };

  tick(real) {
    const w = this.world;
    this.cam.update(real);
    if (this.expand) this.expand.update(real);
    this.input.update(real);
    let steps = 0, want = 0;
    const t0 = performance.now(), dt = w.cfg.sim.dt;
    const budget = this.perf.budgetMs = simBudgetMs(this.perf.renderMs, this.perf.uiMs, w.speed >= SPEEDS[SPEEDS.length - 1]);
    if (this.driver) {
      steps = this.driver.advance(real, budget);
      this.paused = w.speed <= 0;
      if (w.phase === 'battle' && w.speed > 0) want = real * w.speed * baseSpeed(w.cfg);
    } else {
      const rate = this.simRate();
      this.pacer.dt = dt;
      if (rate > 0) steps = this.pacer.run(real, rate, budget, () => { w.step(); return w.phase === 'battle'; });
      else this.pacer.reset();
      want = real * rate;
    }
    const simMs = performance.now() - t0;
    this.fxT = w.phase === 'won' || w.phase === 'lost' ? (this.fxT || 0) + real : 0;
    if (steps) this.perf.simMs = this.perf.simMs * 0.8 + simMs / steps * 0.2;
    this.perf.ticks += steps;
    // Achieved vs asked-for clock over 0.75 s windows; speedLag only after two short windows in a row.
    const rs = this._rs;
    if (w.phase === 'battle' && !this.paused && !this.modalOpen()) {
      rs.t += real; rs.n += steps; rs.want += want;
      if (rs.t >= 0.75) {
        this.realSpeed = rs.n * dt / rs.t;
        const ratio = rs.want > 0 ? rs.n * dt / rs.want : 1;
        if (ratio < 0.9) rs.lag += rs.t; else if (ratio > 0.95) rs.lag = 0;
        this.speedLag = rs.lag >= 1.4;
        rs.t = 0; rs.n = 0; rs.want = 0;
      }
    } else { rs.t = 0; rs.n = 0; rs.want = 0; rs.lag = 0; this.realSpeed = 0; this.speedLag = false; }
    // map markers age only while the battle clock runs, so a paused battle keeps them on screen
    if (w.phase !== 'battle' || (!this.paused && !this.modalOpen())) this.liveRt += real;
    this.markers.prune(this.rt, this.liveRt);
    this._hv = (this._hv || 0) + real;
    if (this._hv > 0.06) { this._hv = 0; this.updateHover(); }
    const g = this.input.gesture;
    this.currentLabel = this.modalOpen() ? null : g ? g.label() : this.tool.label();
    if (this.driver) {
      this._curT = (this._curT || 0) + real;
      const m = this.input.mouse;
      if (this._curT > 0.1 && m) { this._curT = 0; try { this.driver.sendPeer({ k: 'cur', x: Math.round(m.wx), y: Math.round(m.wy), tool: this.toolName }); } catch (e) { /* link down */ } }
    }
    return simMs;
  }

  render() {
    const w = this.world, ctx = this.ctx, dpr = this.dpr || 1, cam = this.cam, pal = this.pal;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const hv = this.hover;
    const hb = !hv ? null : hv.kind === 'building' || (hv.kind === 'unit' && hv.b >= 0) ? hv.b : hv.kind === 'bridge' ? { road: hv.road } : null;
    const ex = this.expand && this.expand.active ? this.expand : null;
    drawStatic(ctx, this.map, w.grid, cam, { palette: pal, view: this.view, stageMask: ex ? ex.mask() : w.region.poly, stageLine: !ex || ex.lineDone, budgetMs: ex ? 3 : undefined, world: w, hover: hb });
    const live = w.phase === 'battle' && !this.paused && !this.modalOpen();
    const ext = live ? (this.driver ? 0 : this.pacer.acc) : 0;
    const t = w.t + ext + (this.fxT || 0);
    const horn = this._horn || (this._horn = (x, y) => this.onSound({ name: 'horn', x, y, vol: 0.2 }));
    const flash = this.wr.draw(ex ? ex.beginWorld(ctx) : ctx, w, cam, { dpr, ext, t, rt: this.rt, rings: this.rings, sel: this.sel, hover: null, abilityName: (id) => this.combat.abilityName(id),
      trains: this.prefs.get().trains !== false, turn: this.driver ? this.driver.turn : null, hold: this.modalOpen(), horn });
    if (ex) ex.endWorld(ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.army.draw(ctx, cam, pal);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.markers.draw(ctx, cam, t, this.rt, pal, this.liveRt);
    (this.input.gesture || this.tool).draw(ctx, cam, pal);
    if (this.partner && this.rt - this.partner.rt < 3) {
      const sx = (this.partner.x - cam.x) * cam.zoom, sy = (this.partner.y - cam.y) * cam.zoom;
      ctx.strokeStyle = pal.carbon; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx - 7, sy); ctx.lineTo(sx + 7, sy); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx, sy + 7); ctx.stroke();
      tag(ctx, 'PARTNER', sx + 8, sy + 6, pal, pal.carbon);
    }
    const v = this.viewRect();
    drawScaleBar(ctx, cam, { palette: pal, x: v.x + 10, y: cam.h - LAYOUT.bottom + 4 });
    if (flash > 0) {
      ctx.fillStyle = rgba(pal.fx.flash, Math.min(0.92, flash * 0.92));
      ctx.fillRect(0, 0, cam.w, cam.h);
    }
  }
}
