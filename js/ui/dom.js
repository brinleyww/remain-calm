// Small DOM toolkit for the shell: element builder, modals, toasts, typewriter text and paper sounds.
import { getSettings } from '../meta/settings.js';

// h('div.card.raised', { onclick, dataset, style, attrs }, ...children)
export function h(sel, props, ...kids) {
  if (props instanceof Node || typeof props === 'string' || typeof props === 'number' || Array.isArray(props)) { kids.unshift(props); props = null; }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') { for (const s in v) s.startsWith('--') ? el.style.setProperty(s, v[s]) : (el.style[s] = v[s]); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const fmtInt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-GB') : '--');
export const fmtPct = n => (Number.isFinite(n) ? n.toFixed(1) + '%' : '--');
export const fmtMoney = n => (Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-GB') : '--');
export const fmtKm = m => (m >= 1000 ? (m / 1000).toFixed(m % 1000 ? 1 : 0) + ' km' : Math.round(m) + ' m');
export function fmtDate(ts, withTime = false) {
  if (!ts) return '--';
  const d = new Date(ts);
  const s = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  return withTime ? s + ' ' + d.toTimeString().slice(0, 5) : s;
}

export function kv(label, value) { return h('div.kv', h('span', label), h('i'), h('b', value)); }

export function keycap(label, cls = '') { return h('kbd' + (cls ? '.' + cls : ''), label); }

// ------------------------------------------------------------ sounds (tiny WebAudio clicks)

let actx = null, noiseBuf = null, gestured = false;
const activated = () => (navigator.userActivation ? navigator.userActivation.hasBeenActive : gestured);
function audio() {
  if (actx) return actx;
  if (!activated()) return null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.25 | 0, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
  } catch (e) { actx = null; }
  return actx;
}

function burst({ dur = 0.03, freq = 2400, q = 1.2, gain = 0.18, type = 'bandpass', tone = 0, toneDur = 0.05 }) {
  const s = getSettings();
  if (!s.uiSounds || s.volume <= 0) return;
  const ctx = audio();
  if (!ctx || ctx.state === 'suspended') { if (ctx) ctx.resume().catch(() => {}); return; }
  const t = ctx.currentTime;
  const vol = gain * s.volume;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq * (0.92 + Math.random() * 0.16); f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t, Math.random() * 0.1, dur + 0.02);
  if (tone) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(tone, t); o.frequency.exponentialRampToValueAtTime(tone * 0.5, t + toneDur);
    og.gain.setValueAtTime(vol * 1.6, t); og.gain.exponentialRampToValueAtTime(0.0001, t + toneDur);
    o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + toneDur + 0.02);
  }
}

export const sfx = {
  clack: () => burst({ dur: 0.028, freq: 3200, q: 1.6, gain: 0.12 }),
  key: () => burst({ dur: 0.018, freq: 4200, q: 2, gain: 0.05 }),
  thump: () => burst({ dur: 0.12, freq: 380, q: 0.8, gain: 0.35, type: 'lowpass', tone: 120, toneDur: 0.09 }),
  page: () => burst({ dur: 0.16, freq: 1600, q: 0.5, gain: 0.07, type: 'highpass' }),
  bell: () => {
    const s = getSettings(); const ctx = audio();
    if (!ctx || !s.uiSounds || ctx.state === 'suspended') return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 1760;
    g.gain.setValueAtTime(0.08 * s.volume, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.55);
  },
};

// The AudioContext may only start after a gesture.
export function primeAudio() {
  gestured = true;
  const ctx = audio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

// ------------------------------------------------------------ typewriter

const motionOff = () => getSettings().reduceMotion || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// Types text into el; resolves when done. Returns a promise with .skip().
export function typeText(el, text, { cps = 90, sound = true, delay = 0 } = {}) {
  let skip = false, timer = 0, resolveFn;
  const p = new Promise(res => { resolveFn = res; });
  const finish = () => { clearTimeout(timer); el.textContent = text; el.classList.remove('is-typing'); resolveFn(); };
  if (motionOff() || cps <= 0) { finish(); p.skip = () => {}; return p; }
  el.textContent = '';
  el.classList.add('is-typing');
  let i = 0;
  const step = () => {
    if (skip) return finish();
    const n = Math.max(1, Math.round(cps / 60));
    i = Math.min(text.length, i + n);
    el.textContent = text.slice(0, i);
    if (sound && i % 3 === 0 && text[i - 1] !== ' ') sfx.key();
    if (i >= text.length) return finish();
    timer = setTimeout(step, 1000 / 60);
  };
  timer = setTimeout(step, delay);
  p.skip = () => { skip = true; finish(); };
  return p;
}

// ------------------------------------------------------------ modal

const modalStack = [];
export const modalOpen = () => modalStack.length > 0;

// openModal({ title, body, actions: [{ label, kind: 'primary'|'go'|'ghost'|'', key, onClick(close) -> false keeps open }], wide, form, onClose })
export function openModal({ title, body, actions = [], wide = false, onClose, no = '', initialFocus } = {}) {
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (value) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    const k = modalStack.indexOf(api);
    if (k >= 0) modalStack.splice(k, 1);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    if (onClose) onClose(value);
  };
  const btns = actions.map(a => {
    const b = h('button.btn' + (a.kind ? '.btn-' + a.kind : '') + (a.grow ? '.grow' : ''), { type: 'button', disabled: !!a.disabled },
      a.label, a.key ? keycap(a.key) : null);
    b.addEventListener('click', () => {
      sfx.clack();
      const r = a.onClick ? a.onClick(close, b) : undefined;
      if (r !== false && !(r && r.then)) close(a.value);
      else if (r && r.then) r.then(v => { if (v !== false) close(a.value); });
    });
    return b;
  });
  const modal = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2.modal-title', title), no ? h('span.form-no', no) : null,
      h('button.modal-close', { type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, '×')),
    h('div.modal-body', body),
    btns.length ? h('div.modal-foot', btns) : null);
  const back = h('div.modal-backdrop', { onmousedown: e => { if (e.target === back) close(undefined); } }, modal);
  const onKey = (e) => {
    if (modalStack[modalStack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); return; }
    if (e.key === 'Enter' && !e.shiftKey && !(e.target && e.target.tagName === 'TEXTAREA') && !(e.target && e.target.tagName === 'BUTTON')) {
      const primary = actions.findIndex(a => a.kind === 'primary' || a.kind === 'go');
      if (primary >= 0 && !btns[primary].disabled) { e.preventDefault(); btns[primary].click(); }
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  const api = { close, el: modal, buttons: btns };
  modalStack.push(api);
  requestAnimationFrame(() => {
    const f = initialFocus ? modal.querySelector(initialFocus) : modal.querySelector('input, textarea, select') || btns[btns.length - 1] || modal.querySelector('.modal-close');
    if (f) f.focus();
  });
  return api;
}

export function confirmModal({ title = 'Confirm', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, no = '' } = {}) {
  return new Promise(res => {
    let answered = false;
    openModal({
      title, no,
      body: typeof message === 'string' ? h('p', message) : message,
      actions: [
        { label: cancelLabel, kind: 'ghost', onClick: () => { answered = true; res(false); } },
        { label: confirmLabel, kind: danger ? 'primary' : 'go', onClick: () => { answered = true; res(true); } },
      ],
      onClose: () => { if (!answered) res(false); },
    });
  });
}

export function alertModal({ title = 'Notice', message = '', no = '' } = {}) {
  return new Promise(res => {
    openModal({ title, no, body: typeof message === 'string' ? h('p', message) : message, actions: [{ label: 'Understood', kind: 'go' }], onClose: () => res() });
  });
}

// ------------------------------------------------------------ toasts

let toastBox = null;
// toast({ title, body, kind: 'award'|'unlock'|'info'|'error', stamp, ms })
export function toast({ title, body = '', kind = 'info', stamp = '', ms = 5200 } = {}) {
  if (!toastBox || !document.body.contains(toastBox)) {
    toastBox = h('div.toasts', { 'aria-live': 'polite' });
    document.body.appendChild(toastBox);
  }
  const el = h('div.toast.toast-' + kind,
    stamp ? h('span.stamp.stamp-sm.toast-stamp' + (kind === 'award' ? '.stamp-green' : kind === 'unlock' ? '.stamp-blue' : kind === 'error' ? '' : '.stamp-ink'), stamp) : null,
    h('div.toast-text', h('b.toast-title', title), body ? h('span.toast-body', body) : null));
  el.addEventListener('click', () => dismiss());
  toastBox.appendChild(el);
  const live = [...toastBox.querySelectorAll('.toast:not(.is-out)')];
  if (live.length > 4) live[0].click();
  if (kind === 'award') sfx.bell(); else sfx.clack();
  let t = setTimeout(() => dismiss(), ms);
  function dismiss() { clearTimeout(t); el.classList.add('is-out'); setTimeout(() => el.remove(), 260); }
  return dismiss;
}

// ------------------------------------------------------------ canvas helper

// Sizes a canvas to its CSS box at the device pixel ratio; returns { ctx, w, h, dpr } in CSS pixels.
export function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh, dpr };
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const isTyping = e => {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
