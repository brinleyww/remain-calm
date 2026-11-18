// Small DOM helpers shared by the editor and the co-op lobby. User text always goes in as text, never markup.

export function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  let value;
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'svg') e.innerHTML = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly' || k === 'multiple') e[k] = !!v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  if (value !== undefined) e.value = value;
  return e;
}

export async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back to a selection copy */ }
  try {
    if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); return document.execCommand('copy'); }
  } catch (e) { /* nothing else to try */ }
  return false;
}

let loaded = false;
// Adds css/editor.css once (the editor and the lobby share it).
export function ensureEditorCss() {
  if (loaded || typeof document === 'undefined') return;
  loaded = true;
  const href = new URL('../../css/editor.css', import.meta.url).href;
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some(l => l.href === href)) return;
  document.head.append(el('link', { rel: 'stylesheet', href }));
}
