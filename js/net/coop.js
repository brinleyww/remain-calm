// Two-player co-op: a WebRTC DataChannel opened with copy-paste codes (no server), and a deterministic
// lockstep driver that feeds both players' commands to identical worlds on both machines.
//
// Link:   createHost() -> link (link.offerCode) ; joinWithCode(offer) -> link (link.answerCode) ; host: link.acceptAnswer(answer)
//         link.send(obj) · link.onMessage = fn(obj) · link.sendLarge(tag, text, onProgress) · link.onLarge = fn(tag, text)
//         link.onState = fn(state) · link.onClose = fn(reason) · link.rtt (ms) · link.close()
// Driver: new LockstepDriver(world, link, localOwner) · submit(cmd) · advance(realDt, budgetMs) -> world ticks run
import { encodeShareCode, decodeShareCode, gzipBytes, gunzipBytes } from '../util/compress.js';
import { hashStr } from '../util/rng.js';
import { baseSpeed, tickCap, tickCost } from '../game/pacer.js';

export const PROTOCOL = 2;
export const INPUT_DELAY = 4;
export const HASH_EVERY = 60;
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CHUNK = 32 * 1024;
const HIGH_WATER = 1 << 20;
const LOW_WATER = 256 * 1024;
const SILENCE_MS = 15000;
const PING_MS = 2000;
const enc = new TextEncoder(), dec = new TextDecoder();
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------- link base

class CoopLink {
  constructor(role) {
    this.role = role;
    this.state = 'new';
    this.offerCode = '';
    this.answerCode = '';
    this.rtt = 0;
    this.lastHeard = 0;
    this.closeReason = '';
    this.onState = null;
    this.onClose = null;
    this.onLarge = null;
    this.onLargeProgress = null;
    this._onMessage = null;
    this._held = [];
    this._heldLarge = [];
    this._inbox = [];
    this._pumping = false;
    this._rx = null;
    this._lgSeq = 0;
    this._lgChain = Promise.resolve();
    this._timer = 0;
    this.ready = new Promise((res, rej) => { this._readyRes = res; this._readyRej = rej; });
    this.ready.catch(() => {});
  }

  get open() { return this.state === 'open'; }

  // Messages that arrive while no handler is set are held and delivered (in order) once one is set.
  get onMessage() { return this._onMessage; }
  set onMessage(fn) {
    this._onMessage = fn || null;
    if (fn && this._held.length) {
      const held = this._held.splice(0);
      queueMicrotask(() => { for (const m of held) { if (this._onMessage) this._onMessage(m); else this._held.push(m); } });
    }
  }
  setLargeHandler(fn) {
    this.onLarge = fn;
    if (fn && this._heldLarge.length) { const h = this._heldLarge.splice(0); queueMicrotask(() => { for (const [t, x] of h) fn(t, x); }); }
  }

  send(msg) {
    if (!this.open) return false;
    try { this._sendRaw(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }

  // Sends a big text (a map) gzipped in chunks with back-pressure. One transfer at a time.
  sendLarge(tag, text, onProgress) {
    const job = this._lgChain.then(() => this._sendLarge(tag, String(text), onProgress));
    this._lgChain = job.catch(() => {});
    return job;
  }

  async _sendLarge(tag, text, onProgress) {
    if (!this.open) throw new Error('The link is closed');
    const raw = enc.encode(text);
    const gz = await gzipBytes(raw);
    const id = ++this._lgSeq, n = Math.max(1, Math.ceil(gz.length / CHUNK));
    this._sendRaw(JSON.stringify({ $: 'lg0', id, tag, bytes: gz.length, raw: raw.length, n, h: hashStr(text) }));
    for (let i = 0; i < n; i++) {
      if (this._buffered() > HIGH_WATER) await this._drain();
      if (!this.open) throw new Error('The link closed during the transfer');
      this._sendRaw(gz.slice(i * CHUNK, Math.min(gz.length, (i + 1) * CHUNK)));
      if (onProgress) onProgress((i + 1) / n);
    }
    this._sendRaw(JSON.stringify({ $: 'lg1', id }));
  }

  close(reason = 'closed') {
    if (this.state === 'closed' || this.state === 'failed') return;
    if (this.open) { try { this._sendRaw(JSON.stringify({ $: 'bye', reason })); } catch (e) { /* already gone */ } }
    this._finish(reason === 'failed' ? 'failed' : 'closed', reason);
  }

  _finish(state, reason) {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.closeReason = reason;
    clearInterval(this._timer);
    this._setState(state);
    this._readyRej(new Error(reasonText(reason)));
    this._teardown();
    if (this.onClose) this.onClose(reason);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (this.onState) this.onState(s);
  }

  _opened() {
    if (this.open) return;
    this.lastHeard = clock();
    this._setState('open');
    this._readyRes(this);
    clearInterval(this._timer);
    let lastPing = 0;
    this._timer = setInterval(() => {
      if (!this.open) return;
      const t = clock();
      if (t - this.lastHeard > SILENCE_MS) { this._finish('closed', 'timeout'); return; }
      if (t - lastPing >= PING_MS) { lastPing = t; try { this._sendRaw(JSON.stringify({ $: 'ping', t })); } catch (e) { /* closing */ } }
    }, 500);
  }

  _receive(data) {
    this.lastHeard = clock();
    this._inbox.push(data);
    if (!this._pumping) this._pump();
  }

  async _pump() {
    this._pumping = true;
    while (this._inbox.length) {
      const data = this._inbox.shift();
      try {
        if (typeof data !== 'string') { this._chunk(data); continue; }
        let m;
        try { m = JSON.parse(data); } catch (e) { continue; }
        if (!m || typeof m !== 'object') continue;
        if (m.$) await this._control(m);
        else if (this._onMessage) this._onMessage(m);
        else this._held.push(m);
      } catch (e) { console.error('[coop] message handler failed', e); }
    }
    this._pumping = false;
  }

  async _control(m) {
    if (m.$ === 'ping') { this._sendRaw(JSON.stringify({ $: 'pong', t: m.t })); return; }
    if (m.$ === 'pong') { if (Number.isFinite(m.t)) this.rtt = Math.max(0, clock() - m.t); return; }
    if (m.$ === 'bye') { this._finish('closed', m.reason === 'failed' ? 'failed' : 'left'); return; }
    if (m.$ === 'lg0') { this._rx = { id: m.id, tag: String(m.tag), bytes: m.bytes | 0, h: m.h >>> 0, parts: [], got: 0 }; return; }
    if (m.$ === 'lg1') {
      const rx = this._rx;
      this._rx = null;
      if (!rx || rx.id !== m.id) return;
      const all = new Uint8Array(rx.got);
      let o = 0;
      for (const p of rx.parts) { all.set(p, o); o += p.length; }
      let text = null;
      try { text = dec.decode(await gunzipBytes(all)); } catch (e) { text = null; }
      if (text === null || hashStr(text) !== rx.h) { this.send({ $: 'lgbad', id: rx.id, tag: rx.tag }); if (this.onLarge) this.onLarge(rx.tag, null); return; }
      if (this.onLarge) this.onLarge(rx.tag, text); else this._heldLarge.push([rx.tag, text]);
      return;
    }
    if (m.$ === 'lgbad' && this.onLarge) this.onLarge('!' + m.tag, null);
  }

  _chunk(data) {
    const rx = this._rx;
    if (!rx) return;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    rx.parts.push(u8);
    rx.got += u8.length;
    if (this.onLargeProgress) this.onLargeProgress(rx.tag, rx.bytes ? Math.min(1, rx.got / rx.bytes) : 0);
  }

  _sendRaw() { throw new Error('not connected'); }
  _buffered() { return 0; }
  _drain() { return Promise.resolve(); }
  _teardown() {}
}

function reasonText(r) {
  return {
    timeout: 'Your partner stopped responding', left: 'Your partner left', failed: 'Could not connect to your partner',
    closed: 'The link was closed', expired: 'The codes expired before the link opened',
  }[r] || String(r || 'The link was closed');
}
export { reasonText };

// ---------------------------------------------------------------- WebRTC link

class RtcLink extends CoopLink {
  constructor(role, opts = {}) {
    super(role);
    if (typeof RTCPeerConnection === 'undefined') throw new Error('This browser cannot open peer-to-peer links (no WebRTC)');
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers || ICE_SERVERS });
    this.dc = null;
    this._discTimer = 0;
    this._openTimer = 0;
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this._finish('failed', 'failed');
      else if (s === 'disconnected') { clearTimeout(this._discTimer); this._discTimer = setTimeout(() => { if (this.pc.connectionState === 'disconnected') this._finish('closed', 'timeout'); }, 8000); }
      else if (s === 'connected') clearTimeout(this._discTimer);
      if (s === 'connecting' && this.state !== 'open') this._setState('connecting');
    });
  }

  _attach(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => { clearTimeout(this._openTimer); this._opened(); };
    dc.onclose = () => this._finish('closed', this.state === 'open' ? 'left' : 'failed');
    dc.onerror = () => { if (this.state !== 'open') this._finish('failed', 'failed'); };
    dc.onmessage = e => this._receive(e.data);
    if (dc.readyState === 'open') this._opened();
  }

  _sendRaw(data) { if (!this.dc || this.dc.readyState !== 'open') throw new Error('channel not open'); this.dc.send(data); }
  _buffered() { return this.dc ? this.dc.bufferedAmount : 0; }
  _drain() {
    return new Promise(res => {
      const dc = this.dc;
      if (!dc || dc.bufferedAmount <= LOW_WATER) return res();
      const done = () => { dc.removeEventListener('bufferedamountlow', done); clearInterval(poll); res(); };
      const poll = setInterval(() => { if (dc.readyState !== 'open' || dc.bufferedAmount <= LOW_WATER) done(); }, 100);
      dc.addEventListener('bufferedamountlow', done);
    });
  }
  _teardown() {
    clearTimeout(this._discTimer);
    clearTimeout(this._openTimer);
    try { if (this.dc) this.dc.close(); } catch (e) { /* closed */ }
    try { this.pc.close(); } catch (e) { /* closed */ }
  }

  _armOpenTimeout(ms) {
    clearTimeout(this._openTimer);
    this._openTimer = setTimeout(() => { if (this.state !== 'open') this._finish('failed', 'failed'); }, ms);
  }

  // Host only: paste the guest's reply code. Resolves when the channel is open.
  async acceptAnswer(code) {
    if (this.role !== 'host') throw new Error('Only the host accepts a reply code');
    if (this.state === 'closed' || this.state === 'failed') throw new Error('These codes are spent; start again for fresh ones');
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('A reply code was already accepted');
    const o = await decodeSignal(code, 'rc-answer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: o.sdp });
    this._setState('connecting');
    this._armOpenTimeout(30000);
    return this.ready;
  }
}

async function gatherIce(pc, maxMs = 6000) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise(res => {
    let early = 0;
    const finish = () => { clearTimeout(t); clearTimeout(early); pc.removeEventListener('icegatheringstatechange', onState); pc.removeEventListener('icecandidate', onCand); res(); };
    const onState = () => { if (pc.iceGatheringState === 'complete') finish(); };
    // Once a public (server-reflexive) candidate is in, waiting longer rarely adds anything useful.
    const onCand = e => { if (e.candidate && / typ srflx/.test(e.candidate.candidate) && !early) early = setTimeout(finish, 1200); };
    const t = setTimeout(finish, maxMs);
    pc.addEventListener('icegatheringstatechange', onState);
    pc.addEventListener('icecandidate', onCand);
  });
}

async function encodeSignal(kind, sdp) {
  return encodeShareCode(JSON.stringify({ k: kind, p: PROTOCOL, sdp }));
}

export async function decodeSignal(code, want) {
  const s = String(code || '').trim();
  if (!s) throw new Error('Paste a code first');
  let o;
  try { o = JSON.parse(await decodeShareCode(s)); } catch (e) { throw new Error('That is not a REMAIN CALM link code (it may be cut off)'); }
  if (!o || (o.k !== 'rc-offer' && o.k !== 'rc-answer') || typeof o.sdp !== 'string') throw new Error('That is not a REMAIN CALM link code');
  if (o.p !== PROTOCOL) throw new Error('Your partner is running a different version of the game');
  if (o.k !== want) throw new Error(want === 'rc-offer' ? 'That is a reply code. Paste the host\'s invitation code here.' : 'That is an invitation code. Paste the reply code your partner sent back.');
  return o;
}

export async function createHost(opts = {}) {
  const link = new RtcLink('host', opts);
  link._attach(link.pc.createDataChannel('remain-calm', { ordered: true }));
  await link.pc.setLocalDescription(await link.pc.createOffer());
  await gatherIce(link.pc, opts.iceTimeoutMs);
  link.offerCode = await encodeSignal('rc-offer', link.pc.localDescription.sdp);
  link._setState('offered');
  return link;
}

export async function joinWithCode(code, opts = {}) {
  const o = await decodeSignal(code, 'rc-offer');
  const link = new RtcLink('guest', opts);
  link.pc.addEventListener('datachannel', e => link._attach(e.channel));
  await link.pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
  await link.pc.setLocalDescription(await link.pc.createAnswer());
  await gatherIce(link.pc, opts.iceTimeoutMs);
  link.answerCode = await encodeSignal('rc-answer', link.pc.localDescription.sdp);
  link._setState('answered');
  link._armOpenTimeout(opts.openTimeoutMs || 10 * 60 * 1000);
  return link;
}

// ---------------------------------------------------------------- in-memory link pair (tests, single-machine play)

class LoopLink extends CoopLink {
  constructor(role, opts) { super(role); this.peer = null; this.latency = opts.latency || 0; this.jitter = opts.jitter || 0; this._last = 0; this._q = 0; this._rand = opts.rand || Math.random; this._out = []; }
  // One FIFO and one timer: separate timers per message can fire out of order on a busy machine,
  // because each delay is measured from a different moment.
  _sendRaw(data) {
    const peer = this.peer;
    if (!peer || !peer.open) throw new Error('peer closed');
    const copy = typeof data === 'string' ? data : (data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice());
    const at = Math.max(this._last, clock() + this.latency + this.jitter * this._rand());
    this._last = at;
    const size = typeof data === 'string' ? data.length : copy.length;
    this._q += size;
    this._out.push([at, copy, size]);
    if (this._out.length === 1) this._arm();
  }
  _arm() { if (this._out.length) setTimeout(() => this._deliver(), Math.max(0, this._out[0][0] - clock())); }
  _deliver() {
    const q = this._out, peer = this.peer;
    while (q.length && q[0][0] <= clock() + 1) {
      const [, d, size] = q.shift();
      this._q -= size;
      if (peer && peer.open) peer._receive(d);
    }
    this._arm();
  }
  _buffered() { return this._q; }
  _drain() { return new Promise(res => { const t = setInterval(() => { if (this._q <= LOW_WATER || !this.open) { clearInterval(t); res(); } }, 5); }); }
  _teardown() { const p = this.peer; if (p && p.open) setTimeout(() => p._finish('closed', 'left'), this.latency); }
}

export function makeLoopbackPair(opts = {}) {
  const a = new LoopLink('host', opts), b = new LoopLink('guest', opts);
  a.peer = b; b.peer = a;
  setTimeout(() => { a._opened(); b._opened(); }, 0);
  return [a, b];
}

// ---------------------------------------------------------------- lockstep

// Both peers run identical worlds. Time is cut into turns of cfg.sim.dt; a command submitted now is applied
// on both machines at turn + INPUT_DELAY, after both players' batches for that turn are known (owner 0 first).
// Each turn runs world.speed * cfg.sim.baseSpeed world ticks on average (0 while paused), so speed and pause are
// ordinary commands. A turn's ticks are spread over its real time and over as many frames as the sim budget needs.
// The peer that gets ahead slows its clock (see lead), so the slower machine sets the pace for both.
// Commands whose t starts with 'session.' go to onSession instead of world.exec.
export class LockstepDriver {
  constructor(world, link, localOwner, opts = {}) {
    this.world = world;
    this.link = link;
    this.owner = localOwner | 0;
    this.remoteOwner = this.owner === 0 ? 1 : 0;
    this.delay = opts.inputDelay ?? INPUT_DELAY;
    this.hashEvery = opts.hashEvery ?? HASH_EVERY;
    this.turnSec = opts.turnSec ?? (world.cfg && world.cfg.sim && world.cfg.sim.dt) ?? 0.05;
    this.maxTurns = opts.maxTurns ?? 8;
    this.maxSteps = opts.maxSteps ?? 64;
    this.clock = opts.clock || clock;
    this.pace = 1;
    this.turn = 0;
    this.waiting = false;
    this.stallMs = 0;
    this.desynced = false;
    this.connected = link.open !== false;
    this.onApply = null;     // (cmd, result, isLocal)
    this.onSession = null;   // (cmd, isLocal) -> result
    this.onPeer = null;      // (msg) partner's non-lockstep messages (cursor, chat)
    this.onDesync = null;    // ({ turn, tick, local, remote })
    this.onDisconnect = null;// (reason)
    this.hashLog = new Map();
    this._acc = 0;
    this._stepAcc = 0;
    this._owed = 0;
    this._cost = 0;
    this._tickMs = 0;
    this._cap = 0;
    this._lead = null;
    this._pending = [];
    this._pendingCb = [];
    this._local = new Map();
    this._localCb = new Map();
    this._remote = new Map();
    this._remoteHash = new Map();
    this._remoteMax = this.delay - 1;
    for (let t = 0; t < this.delay; t++) { this._local.set(t, []); this._remote.set(t, []); }
    link.onMessage = m => this._onMessage(m);
    link.onClose = reason => {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect(reason, reasonText(reason));
    };
  }

  // Queues a command for this player; cb(result) runs when it is applied on both machines.
  submit(cmd, cb) {
    if (!cmd || typeof cmd.t !== 'string') return -1;
    const c = { ...cmd, owner: this.owner };
    this._pending.push(c);
    this._pendingCb.push(cb || null);
    return this.turn + this.delay;
  }

  // Partner-only messages that do not touch the simulation (cursor position, pings, chat).
  sendPeer(msg) {
    const m = { ...msg };
    delete m.$;
    delete m.$ls;
    return this.link.send(m);
  }

  get partnerTurn() { return this._remoteMax - this.delay; }

  // Turns this peer is ahead of its partner. Each side sends how far ahead it looks (latency makes both look ahead);
  // half the difference cancels the latency out.
  get lead() {
    if (this._lead === null) return 0;
    return ((this.turn - 1 - this.partnerTurn) - this._lead) / 2;
  }

  // Advances real time within budgetMs of sim work; returns the number of world ticks run (0 while waiting for the partner).
  advance(realDt, budgetMs = Infinity) {
    if (!this.connected) return 0;
    const real = Math.min(Math.max(+realDt || 0, 0), 0.25);
    const w = this.world, t0 = this.clock();
    const lead = this.lead;
    this.pace = lead > 0.5 ? Math.max(0.15, 1 - 0.6 * (lead - 0.5)) : 1;
    this._acc += real * this.pace;
    const catchUp = this._lead === null ? this.partnerTurn - this.turn > 1 : lead < -1.5;
    const cap = this._cap = Number.isFinite(budgetMs) ? tickCap(this._cap, budgetMs, this._tickMs) : this.maxSteps;
    let turns = 0, steps = 0, limited = false, spent = 0;
    this.waiting = false;
    for (;;) {
      if (this._owed > 0) {
        if (!catchUp && this._acc < this._cost * (1 - 1e-9)) break;
        if (steps >= Math.min(cap, this.maxSteps) || (steps > 0 && this.clock() - t0 > budgetMs * 1.25)) { limited = true; break; }
        const s0 = this.clock();
        w.step();
        spent += this.clock() - s0;
        steps++;
        this._acc -= this._cost;
        if (--this._owed <= 0 || w.phase !== 'battle') { this._owed = 0; this._endTurn(); }
        continue;
      }
      if (turns >= this.maxTurns) { limited = true; break; }
      if (!catchUp && this._acc < this._turnNeed()) break;
      if (!this._remote.has(this.turn)) { this.waiting = true; break; }
      this._beginTurn();
      turns++;
    }
    this._tickMs = tickCost(this._tickMs, spent, steps);
    if (this.waiting) { this.stallMs += real * 1000; this._acc = Math.min(this._acc, this.turnSec); }
    else if (turns || steps) this.stallMs = 0;
    // what did not fit is dropped rather than run in a burst later
    if (limited) this._acc = Math.min(this._acc, this._owed > 0 ? this._cost : this.turnSec);
    if (this._acc < -this.turnSec) this._acc = -this.turnSec;
    return steps;
  }

  _ticksPerTurn() { return Math.max(0, this.world.speed) * baseSpeed(this.world.cfg); }

  // Real time the next turn needs before it may start: its first tick, or the whole turn when it has none.
  _turnNeed() {
    const w = this.world;
    const k = w.phase === 'battle' ? Math.floor(this._stepAcc + this._ticksPerTurn() + 1e-9) : 0;
    return k > 0 ? this.turnSec / k : this.turnSec;
  }

  // Applies the turn's commands (both players') and works out how many ticks it runs.
  _beginTurn() {
    const t = this.turn, w = this.world;
    const seal = t + this.delay;
    const batch = this._pending.splice(0);
    const cbs = this._pendingCb.splice(0);
    const wire = JSON.stringify(batch);
    this._local.set(seal, JSON.parse(wire));
    this._localCb.set(seal, cbs);
    this.link.send({ $ls: 'in', t: seal, c: batch, l: t - this.partnerTurn });

    const mine = this._local.get(t) || [], theirs = this._remote.get(t) || [];
    const myCbs = this._localCb.get(t) || [];
    this._local.delete(t); this._remote.delete(t); this._localCb.delete(t);
    const first = this.owner === 0 ? mine : theirs, second = this.owner === 0 ? theirs : mine;
    for (const [list, isLocal] of [[first, this.owner === 0], [second, this.owner !== 0]]) {
      for (let i = 0; i < list.length; i++) {
        const cmd = list[i];
        let res;
        try {
          if (cmd.t.startsWith('session.')) res = this.onSession ? this.onSession(cmd, isLocal) || { ok: true } : { ok: false, reason: 'No session handler' };
          else res = w.exec(cmd);
        } catch (e) {
          res = { ok: false, reason: 'Command failed' };
          console.error('[coop] command failed', cmd, e);
        }
        if (isLocal && myCbs[i]) { try { myCbs[i](res); } catch (e) { console.error(e); } }
        if (this.onApply) this.onApply(cmd, res, isLocal);
      }
    }

    let n = 0;
    if (w.phase === 'battle') {
      this._stepAcc += this._ticksPerTurn();
      n = Math.floor(this._stepAcc + 1e-9);
      this._stepAcc -= n;
    } else this._stepAcc = 0;

    this.turn = t + 1;
    this._owed = n;
    if (n > 0) this._cost = this.turnSec / n;
    else { this._acc -= this.turnSec; this._endTurn(); }
  }

  // After the turn's last tick: the desync check every hashEvery turns.
  _endTurn() {
    const w = this.world;
    if (this.turn % this.hashEvery === 0) {
      const h = w.hash() >>> 0;
      this.hashLog.set(this.turn, { h, tick: w.tick });
      if (this.hashLog.size > 64) this.hashLog.delete(this.hashLog.keys().next().value);
      this.link.send({ $ls: 'h', t: this.turn, h, tick: w.tick });
      this._compare(this.turn);
    }
  }

  _onMessage(m) {
    if (m.$ls === 'in') {
      const t = m.t | 0;
      if (t < this.turn || this._remote.has(t) || !Array.isArray(m.c)) return;
      const list = [];
      for (const c of m.c) if (c && typeof c === 'object' && typeof c.t === 'string') list.push({ ...c, owner: this.remoteOwner });
      this._remote.set(t, list);
      if (t > this._remoteMax) this._remoteMax = t;
      if (t === this._remoteMax && Number.isFinite(m.l)) this._lead = m.l;
      return;
    }
    if (m.$ls === 'h') {
      this._remoteHash.set(m.t | 0, m.h >>> 0);
      if (this._remoteHash.size > 64) this._remoteHash.delete(this._remoteHash.keys().next().value);
      this._compare(m.t | 0);
      return;
    }
    if (this.onPeer) this.onPeer(m);
  }

  _compare(turn) {
    const mine = this.hashLog.get(turn), theirs = this._remoteHash.get(turn);
    if (!mine || theirs === undefined) return;
    if (mine.h !== theirs && !this.desynced) {
      this.desynced = true;
      if (this.onDesync) this.onDesync({ turn, tick: mine.tick, local: mine.h, remote: theirs });
    }
  }

  // Detaches from the link (the link stays open, e.g. to return to the lobby).
  destroy() {
    this.link.onMessage = null;
    this.link.onClose = null;
    this.connected = false;
  }
}
