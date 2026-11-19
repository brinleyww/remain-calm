// Tiny synthesised sound effects (WebAudio, no files): dry gunfire ticks, thumps, blasts, sirens, typewriter clacks.

const MIN_GAP = { shot: 55, thump: 70, explosion: 70, clack: 28, wall: 120, collapse: 160, mutant: 400, heli: 900, siren: 1500,
  breach: 900, zap: 90, whoosh: 150, hiss: 200, snipe: 90, jet: 700, error: 120, place: 40, refund: 60, upgrade: 80, tick: 60, ready: 300, win: 2000, lose: 2000, nuke: 3000, alarm: 600, expand: 1500, stamp: 250, bell: 400, horn: 6000 };

// Maps any sound name the simulation or combat code emits onto one of the synthesised voices.
function voiceFor(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'fire' || /flame|napalm|burn|incend/.test(n)) return 'whoosh';
  if (/hiss|gas|chem/.test(n)) return 'hiss';
  if (MIN_GAP[n] !== undefined) return n;
  if (/nuke|atomic/.test(n)) return 'nuke';
  if (/snipe|marksman/.test(n)) return 'snipe';
  if (/shot|gun|mg|rifle|tracer|bullet/.test(n)) return 'shot';
  if (/rail|laser|zap/.test(n)) return 'zap';
  if (/plane|jet|air/.test(n)) return 'jet';
  if (/heli|rotor|chopper/.test(n)) return 'heli';
  if (/boom|bomb|explo|blast|missile|impact|shell|c4|mine|cluster/.test(n)) return 'explosion';
  if (/mortar|cannon|howitzer|launch|thump|rocket|artillery|battleship/.test(n)) return 'thump';
  if (/collapse|crash|topple|bridge/.test(n)) return 'collapse';
  if (/wall|gate/.test(n)) return 'wall';
  if (/mutant|growl/.test(n)) return 'mutant';
  if (/siren|outbreak|horde/.test(n)) return 'siren';
  if (/breach|alarm/.test(n)) return 'breach';
  return 'tick';
}

export class Sfx {
  constructor() {
    this.ac = null;
    this.master = null;
    this.volume = 0.6;
    this.muted = false;
    this._last = new Map();
    this._noise = null;
  }

  // Must be called from a user gesture at least once (browsers keep audio suspended until then).
  resume() {
    if (!this.ac) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      try { this.ac = new AC(); } catch (e) { return null; }
      this.master = this.ac.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ac.destination);
      const len = this.ac.sampleRate;
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      let s = 12345;
      for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
      this._noise = buf;
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
    return this.ac;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, +v || 0));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(m) { this.muted = !!m; this.setVolume(this.volume); }

  destroy() {
    if (this.ac) { try { this.ac.close(); } catch (e) { /* already closed */ } }
    this.ac = null;
  }

  // vol 0..1, pan -1..1
  play(name, vol = 1, pan = 0) {
    if (this.muted || this.volume <= 0 || vol <= 0.02) return;
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const v = voiceFor(name);
    const now = ac.currentTime * 1000;
    const last = this._last.get(v) || -1e9;
    if (now - last < (MIN_GAP[v] || 60)) return;
    this._last.set(v, now);
    const out = ac.createGain();
    out.gain.value = Math.min(1, vol);
    let node = out;
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(p);
      node = p;
    }
    node.connect(this.master);
    const t = ac.currentTime + 0.005;
    try { this[`_${v}`](out, t); } catch (e) { /* a voice failing must never break the game */ }
  }

  // ---------------------------------------------------------------- building blocks
  _env(dest, t, a, peak, d, sustain = 0) {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d);
    g.connect(dest);
    return g;
  }

  _noiseSrc(t, dur, rate = 1) {
    const s = this.ac.createBufferSource();
    s.buffer = this._noise;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * 0.5, dur + 0.05);
    return s;
  }

  _filter(type, f, q = 0.8) {
    const b = this.ac.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    return b;
  }

  _osc(type, f, t, dur) {
    const o = this.ac.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  // ---------------------------------------------------------------- voices
  _shot(out, t) {
    const g = this._env(out, t, 0.001, 0.35, 0.035);
    this._noiseSrc(t, 0.05, 1.4).connect(this._filter('bandpass', 2400 + Math.random() * 800, 1.2)).connect(g);
  }

  _snipe(out, t) {
    const g = this._env(out, t, 0.001, 0.5, 0.09);
    this._noiseSrc(t, 0.12, 1.1).connect(this._filter('bandpass', 1500, 0.9)).connect(g);
    const g2 = this._env(out, t + 0.02, 0.01, 0.12, 0.35);
    this._noiseSrc(t + 0.02, 0.4, 0.5).connect(this._filter('lowpass', 500)).connect(g2);
  }

  _whoosh(out, t) {
    const g = this._env(out, t, 0.06, 0.5, 0.7);
    const f = this._filter('bandpass', 300, 0.6);
    f.frequency.exponentialRampToValueAtTime(1200, t + 0.25);
    f.frequency.exponentialRampToValueAtTime(260, t + 0.75);
    this._noiseSrc(t, 0.8, 0.7).connect(f).connect(g);
  }

  _hiss(out, t) {
    const g = this._env(out, t, 0.04, 0.22, 0.9);
    this._noiseSrc(t, 1, 1.3).connect(this._filter('highpass', 3500, 0.5)).connect(g);
  }

  _thump(out, t) {
    const g = this._env(out, t, 0.002, 0.8, 0.22);
    const o = this._osc('sine', 120, t, 0.25);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.2);
    o.connect(g);
    const g2 = this._env(out, t, 0.001, 0.25, 0.06);
    this._noiseSrc(t, 0.08).connect(this._filter('lowpass', 900)).connect(g2);
  }

  _explosion(out, t) {
    const g = this._env(out, t, 0.004, 0.9, 0.7);
    const f = this._filter('lowpass', 1100, 0.6);
    f.frequency.exponentialRampToValueAtTime(160, t + 0.6);
    this._noiseSrc(t, 0.8, 0.8).connect(f).connect(g);
    const g2 = this._env(out, t, 0.003, 0.7, 0.4);
    const o = this._osc('sine', 75, t, 0.45);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.4);
    o.connect(g2);
  }

  _nuke(out, t) {
    const g = this._env(out, t, 0.02, 1, 3.2);
    const f = this._filter('lowpass', 700, 0.5);
    f.frequency.exponentialRampToValueAtTime(70, t + 3);
    this._noiseSrc(t, 1, 0.45).connect(f).connect(g);
    const s2 = this._noiseSrc(t + 0.9, 1, 0.4); s2.connect(f);
    const s3 = this._noiseSrc(t + 1.8, 1, 0.35); s3.connect(f);
    const g2 = this._env(out, t, 0.01, 0.9, 2.2);
    const o = this._osc('sine', 48, t, 2.4);
    o.frequency.exponentialRampToValueAtTime(22, t + 2.2);
    o.connect(g2);
  }

  _zap(out, t) {
    const g = this._env(out, t, 0.002, 0.3, 0.25);
    const o = this._osc('sawtooth', 1800, t, 0.3);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.25);
    o.connect(this._filter('lowpass', 3000)).connect(g);
  }

  _jet(out, t) {
    const g = this._env(out, t, 0.5, 0.35, 1.4);
    const f = this._filter('bandpass', 400, 0.7);
    f.frequency.linearRampToValueAtTime(1400, t + 0.9);
    f.frequency.linearRampToValueAtTime(500, t + 1.9);
    this._noiseSrc(t, 2).connect(f).connect(g);
  }

  _heli(out, t) {
    const g = this._env(out, t, 0.1, 0.4, 1.1);
    const am = this.ac.createGain();
    am.gain.value = 0.5;
    const lfo = this._osc('square', 13, t, 1.3);
    const lg = this.ac.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain);
    this._noiseSrc(t, 1.3, 0.6).connect(this._filter('lowpass', 500)).connect(am).connect(g);
  }

  _collapse(out, t) {
    const g = this._env(out, t, 0.05, 0.8, 1.3);
    const f = this._filter('lowpass', 420, 0.5);
    f.frequency.exponentialRampToValueAtTime(90, t + 1.2);
    this._noiseSrc(t, 1.4, 0.55).connect(f).connect(g);
  }

  _wall(out, t) {
    const g = this._env(out, t, 0.002, 0.45, 0.12);
    this._noiseSrc(t, 0.15, 0.9).connect(this._filter('lowpass', 900)).connect(g);
  }

  _mutant(out, t) {
    const g = this._env(out, t, 0.05, 0.4, 0.6);
    const o = this._osc('sawtooth', 115, t, 0.7);
    o.frequency.exponentialRampToValueAtTime(62, t + 0.6);
    const vib = this._osc('sine', 9, t, 0.7);
    const vg = this.ac.createGain(); vg.gain.value = 12;
    vib.connect(vg).connect(o.frequency);
    o.connect(this._filter('lowpass', 700)).connect(g);
  }

  _siren(out, t) {
    const g = this._env(out, t, 0.15, 0.22, 2.6, 0.001);
    const o = this._osc('triangle', 480, t, 2.8);
    o.frequency.linearRampToValueAtTime(880, t + 0.7);
    o.frequency.linearRampToValueAtTime(480, t + 1.4);
    o.frequency.linearRampToValueAtTime(880, t + 2.1);
    o.frequency.linearRampToValueAtTime(520, t + 2.8);
    o.connect(g);
  }

  _breach(out, t) {
    for (let k = 0; k < 3; k++) {
      const s = t + k * 0.28;
      const g = this._env(out, s, 0.005, 0.18, 0.22);
      this._osc('square', k % 2 ? 440 : 660, s, 0.24).connect(this._filter('lowpass', 2000)).connect(g);
    }
  }

  _alarm(out, t) { this._breach(out, t); }

  _clack(out, t) {
    const g = this._env(out, t, 0.0005, 0.22, 0.018);
    this._noiseSrc(t, 0.03, 1.6).connect(this._filter('highpass', 2600)).connect(g);
    const g2 = this._env(out, t, 0.0005, 0.08, 0.012);
    this._osc('square', 1700, t, 0.02).connect(g2);
  }

  _tick(out, t) {
    const g = this._env(out, t, 0.001, 0.12, 0.03);
    this._osc('square', 900, t, 0.04).connect(this._filter('lowpass', 2500)).connect(g);
  }

  _place(out, t) {
    const g = this._env(out, t, 0.001, 0.35, 0.09);
    const o = this._osc('sine', 320, t, 0.1);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    o.connect(g);
    this._clack(out, t);
  }

  _refund(out, t) {
    const g = this._env(out, t, 0.001, 0.2, 0.12);
    const o = this._osc('triangle', 520, t, 0.14);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.12);
    o.connect(g);
  }

  _upgrade(out, t) {
    for (let k = 0; k < 2; k++) {
      const s = t + k * 0.07;
      const g = this._env(out, s, 0.002, 0.2, 0.07);
      this._osc('triangle', k ? 880 : 660, s, 0.08).connect(g);
    }
  }

  _error(out, t) {
    const g = this._env(out, t, 0.002, 0.2, 0.12);
    this._osc('square', 140, t, 0.14).connect(this._filter('lowpass', 900)).connect(g);
  }

  // Stage growth: a sheet sliding across the desk, then a pen scratching along the new boundary.
  _expand(out, t) {
    const g = this._env(out, t, 0.25, 0.24, 1.1);
    const f = this._filter('bandpass', 500, 0.7);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.45);
    f.frequency.exponentialRampToValueAtTime(700, t + 1.3);
    const n1 = this._noiseSrc(t, 1.4, 0.6);
    n1.loop = true;
    n1.connect(f).connect(g);
    const s0 = t + 0.2, g2 = this._env(out, s0, 0.08, 0.09, 1.3);
    const am = this.ac.createGain();
    am.gain.value = 0.5;
    const depth = this.ac.createGain();
    depth.gain.value = 0.45;
    this._osc('triangle', 13, s0, 1.4).connect(depth).connect(am.gain);
    const n2 = this._noiseSrc(s0, 1.4, 1.2);
    n2.loop = true;
    n2.connect(this._filter('highpass', 3200, 0.7)).connect(am).connect(g2);
  }

  _stamp(out, t) {
    const g = this._env(out, t, 0.002, 0.7, 0.16);
    const o = this._osc('sine', 150, t, 0.2);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    o.connect(g);
    const g2 = this._env(out, t, 0.001, 0.4, 0.05);
    this._noiseSrc(t, 0.07, 0.8).connect(this._filter('bandpass', 1100, 0.9)).connect(g2);
  }

  _bell(out, t) {
    const g = this._env(out, t, 0.002, 0.22, 0.9);
    this._osc('sine', 2637, t, 1).connect(g);
    const g2 = this._env(out, t, 0.002, 0.08, 0.5);
    this._osc('sine', 3951, t, 0.6).connect(g2);
  }

  // A distant two-tone train horn as it pulls away from a station.
  _horn(out, t) {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.06);
    g.gain.setValueAtTime(0.16, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    g.connect(out);
    const f = this._filter('lowpass', 1300, 0.7);
    f.connect(g);
    for (const hz of [311, 392]) this._osc('sawtooth', hz, t, 1).connect(f);
  }

  _ready(out, t) {
    this._clack(out, t);
    const g = this._env(out, t + 0.05, 0.004, 0.25, 0.8);
    this._osc('sine', 1046, t + 0.05, 0.9).connect(g);
    const g2 = this._env(out, t + 0.05, 0.004, 0.12, 0.6);
    this._osc('sine', 1568, t + 0.05, 0.7).connect(g2);
  }

  _win(out, t) {
    [523, 659, 784, 1046].forEach((f, k) => {
      const s = t + k * 0.13;
      const g = this._env(out, s, 0.004, 0.22, 0.35);
      this._osc('triangle', f, s, 0.4).connect(g);
    });
  }

  _lose(out, t) {
    [392, 330, 262, 196].forEach((f, k) => {
      const s = t + k * 0.2;
      const g = this._env(out, s, 0.004, 0.18, 0.4);
      this._osc('square', f, s, 0.45).connect(this._filter('lowpass', 1200)).connect(g);
    });
  }
}
