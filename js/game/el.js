// Minimal DOM helpers for the in-game UI.

export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export function setText(el, s) {
  s = String(s);
  if (el._t !== s) { el._t = s; el.textContent = s; }
}

export function setHTML(el, s) {
  if (el._h !== s) { el._h = s; el.innerHTML = s; }
}

export function toggle(el, cls, on) {
  on = !!on;
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function show(el, on) {
  on = !!on;
  if (el.hidden === on) el.hidden = !on;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '--');
export const fmtMoney = (n) => (!Number.isFinite(n) || n >= 1e8 ? '$ unlimited' : '$' + Math.round(n).toLocaleString('en-US'));
export const fmtPct = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '--');
export function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
