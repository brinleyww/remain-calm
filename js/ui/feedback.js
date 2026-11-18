// Feedback desk: the FEEDBACK tab on every screen, the note form, and the owner's reading view.
// Player text only ever reaches the page as text nodes (h() children or textContent), never as HTML.
import { h, clear, openModal, confirmModal, fmtDate } from './dom.js';
import { getSettings } from '../meta/settings.js';
import { VERSION } from '../version.js';

const ENDPOINT = 'https://remain-calm-feedback.bringleyw.workers.dev';
const WINDOW_MS = 10 * 60 * 1000;
const MIN_TEXT = 3, MAX_TEXT = 2000;
const SHOT_MAX = 340 * 1024;
const KINDS = [['bug', 'Bug'], ['idea', 'Idea'], ['balance', 'Balance'], ['praise', 'Praise'], ['other', 'Other']];
const LS = { endpoint: 'rc.fbEndpoint', id: 'rc.fbId', next: 'rc.fbNext', draft: 'rc.fbDraft', key: 'rc.fbOwnerKey' };
const UNREACHABLE = 'The feedback server could not be reached, so nothing was sent.';
const SLOW = 'The feedback server did not answer in time. The note may still have arrived, so wait before sending it again.';

const ls = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
};
const base = () => (ls.get(LS.endpoint) || ENDPOINT).replace(/\/+$/, '');
// The owner key stays in this tab only, unless the owner ticks "Remember on this device"
// (every page on the same github.io origin can read localStorage).
const ss = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
};
const ownerKey = () => ss.get(LS.key) || ls.get(LS.key);
function setOwnerKey(k, remember = false) {
  ss.set(LS.key, k);
  ls.set(LS.key, k && remember ? k : '');
}
const nextAt = () => +ls.get(LS.next) || 0;
const kindName = (k) => (KINDS.find((x) => x[0] === k) || KINDS[4])[1];
const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const kb = (bytes) => Math.max(1, Math.round(bytes / 1024)) + ' KB';

function browserId() {
  let id = ls.get(LS.id);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    ls.set(LS.id, id);
  }
  return id;
}

// Resolves { r, j } or { r, blob }; rejects only when the server cannot be reached.
async function call(path, { method = 'GET', body, key = '', timeout = 20000, blob = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;
  try {
    const r = await fetch(base() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, cache: 'no-store' });
    if (blob && r.ok) return { r, blob: await r.blob() };
    return { r, j: await r.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

let app = null, session = null, shellTab = null, gameTab = null, openNow = null, unread = 0;

function makeTab(cls) {
  const b = h('button.fb-tab' + cls, { type: 'button', title: 'Send a note to the office' },
    h('span.fb-tab-label', 'Feedback'), h('span.fb-badge', { hidden: true }));
  return b;
}

function paintBadge() {
  const n = ownerKey() ? unread : 0;
  for (const t of [shellTab, gameTab]) {
    if (!t) continue;
    const b = t.querySelector('.fb-badge');
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n <= 0;
    t.setAttribute('aria-label', n > 0 ? `Feedback, ${n} unread` : 'Feedback');
  }
}

async function refreshBadge() {
  if (!ownerKey()) { unread = 0; paintBadge(); return; }
  try {
    const { r, j } = await call('/feedback/count', { key: ownerKey(), timeout: 10000 });
    if (r.ok) unread = j.unread | 0;
  } catch (e) { /* offline: keep the last count */ }
  paintBadge();
}

// firstScreen: the first screen's mount promise, so the owner view opens on top of it and keeps focus.
export function initFeedback(appRef, firstScreen) {
  app = appRef;
  shellTab = makeTab('.fb-tab-edge');
  shellTab.addEventListener('click', () => openFeedback());
  document.body.appendChild(shellTab);
  if (new URLSearchParams(location.search).has('owner')) Promise.resolve(firstScreen).catch(() => {}).then(() => requestAnimationFrame(() => openOwner()));
  refreshBadge();
  setInterval(refreshBadge, 30 * 60 * 1000);
}

// In game the tab hangs from the top edge inside the header strip, so it never sits on a HUD control.
export function attachFeedbackGame(s) {
  detachFeedbackGame();
  session = s;
  const top = s && s.root && s.root.querySelector('.rc-top');
  if (!top) return;
  gameTab = makeTab('.fb-tab-hang');
  // keep keyboard focus on the map, so Space after closing the panel reaches READY instead of this button
  gameTab.addEventListener('mousedown', (e) => e.preventDefault());
  gameTab.addEventListener('click', () => { if (typeof s.openFeedback === 'function') s.openFeedback(); else openFeedback(); });
  top.insertBefore(gameTab, top.querySelector('.rc-stats'));
  paintBadge();
}

export function detachFeedbackGame() {
  session = null;
  if (gameTab) gameTab.remove();
  gameTab = null;
}

function context() {
  const s = session, w = s && s.world;
  const c = { version: VERSION, screen: s ? 'game' : (app && app.screen) || 'title' };
  if (w) {
    Object.assign(c, {
      mode: s.opts.mode || '', map: (s.map && s.map.name) || '', source: (s.map && s.map.source) || '',
      stage: `${w.stage + 1}/${w.stageCount}`, phase: w.phase || '', difficulty: s.opts.difficulty || w.difficulty || '',
      mutators: (s.opts.mutators || []).filter(Boolean).slice(0, 24),
    });
    if (s.net) c.coop = true;
  }
  c.population = getSettings().popScale;
  c.viewport = `${innerWidth}x${innerHeight}`;
  c.dpr = Math.round((devicePixelRatio || 1) * 100) / 100;
  c.ua = navigator.userAgent;
  if (s && s.perf && s.perf.fps) c.fps = Math.round(s.perf.fps * 10) / 10;
  return c;
}

function captureMap(s) {
  const src = s && s.canvas;
  if (!src || !src.width || !src.height) return null;
  let scale = Math.min(1, 1280 / src.width), q = 0.72;
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    let url;
    try { url = c.toDataURL('image/jpeg', q); } catch (e) { return null; }
    const bytes = Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
    if (url.startsWith('data:image/jpeg') && bytes <= SHOT_MAX) return { url, bytes };
    if (q > 0.5) q -= 0.11; else scale *= 0.8;
  }
  return null;
}

function loadDraft() {
  try { const d = JSON.parse(ls.get(LS.draft) || '{}'); return d && typeof d === 'object' ? d : {}; } catch (e) { return {}; }
}

// ------------------------------------------------------------ player form

export function openFeedback({ onClose } = {}) {
  if (openNow) { if (onClose) onClose(); return null; }
  const draft = loadDraft();
  let kind = KINDS.some((k) => k[0] === draft.kind) ? draft.kind : 'bug';
  let shot = null, busy = false, handedOff = false, received = false;

  const kindBtns = KINDS.map(([id, label]) => h('button.fb-kind', { type: 'button', dataset: { kind: id }, onclick: () => { kind = id; paintKinds(); save(); } }, label));
  const paintKinds = () => { for (const b of kindBtns) b.setAttribute('aria-pressed', String(b.dataset.kind === kind)); };
  paintKinds();
  const ta = h('textarea.input.fb-text', { id: 'fb-text', rows: 6, maxlength: MAX_TEXT, placeholder: 'What happened, what you expected, or what you would change.' });
  ta.value = String(draft.text || '').slice(0, MAX_TEXT);
  const count = h('span.fb-count');
  const name = h('input.input', { id: 'fb-name', type: 'text', maxlength: 60, autocomplete: 'nickname', placeholder: 'Optional' });
  const contact = h('input.input', { id: 'fb-contact', type: 'text', maxlength: 120, autocomplete: 'off', placeholder: 'Optional: email or Discord' });
  name.value = String(draft.name || '').slice(0, 60);
  contact.value = String(draft.contact || '').slice(0, 120);
  const hp = h('input.fb-hp', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });

  let shotRow = null, shotCheck = null;
  const shotInfo = h('span.fb-shot-info.faint');
  const thumb = h('img.fb-thumb', { alt: 'The map screenshot that will be attached', hidden: true });
  if (session && session.canvas) {
    shotCheck = h('input', { type: 'checkbox' });
    shotCheck.addEventListener('change', () => {
      shot = shotCheck.checked ? captureMap(session) : null;
      if (shotCheck.checked && !shot) { shotCheck.checked = false; shotInfo.textContent = 'The map could not be captured.'; }
      else shotInfo.textContent = shot ? `JPEG, ${kb(shot.bytes)}` : '';
      thumb.hidden = !shot;
      if (shot) thumb.src = shot.url; else thumb.removeAttribute('src');
      paintSent();
    });
    shotRow = h('div.fb-shot', h('label.check', shotCheck, 'Attach a screenshot of the map'), shotInfo, thumb);
  }

  const sent = h('pre.fb-sent');
  const what = h('details.fb-what', h('summary', 'What gets sent'),
    h('p.small.muted', 'Your note and the details below. No account and no cookies. Your network address is kept only as a scrambled code for 10 minutes, to hold the one-note limit.'),
    sent);
  const paintSent = () => {
    if (!what.open) return;
    const c = { kind, message: `${ta.value.trim().length} characters`, name: name.value.trim() || '(none)', contact: contact.value.trim() || '(none)', screenshot: shot ? `JPEG, ${kb(shot.bytes)}` : 'none', ...context() };
    sent.textContent = Object.entries(c).map(([k, v]) => `${k.padEnd(11)} ${Array.isArray(v) ? v.join(' | ') || '(none)' : v}`).join('\n');
  };
  what.addEventListener('toggle', paintSent);

  const status = h('p.fb-status', { role: 'status', 'aria-live': 'polite' });
  const wait = h('p.fb-wait', { hidden: true });
  const sendBtn = h('button.btn.btn-primary.fb-send', { type: 'button', onclick: () => send() }, 'Send note');
  const ownerBtn = h('button.btn.btn-ghost.btn-sm.fb-owner-link', { type: 'button', onclick: () => { handedOff = true; m.close(); openOwner({ onClose }); } }, 'Owner');
  const say = (msg, err = false) => { status.textContent = msg; status.classList.toggle('is-err', err); };

  const form = h('div.fb-form',
    h('p.fb-lede.small', 'Tell the office what broke, what you would change, or what worked. The owner reads every note.'),
    h('div.field', h('span.field-label', 'Kind of note'), h('div.fb-kinds', { role: 'group', 'aria-label': 'Kind of note' }, kindBtns)),
    h('div.field', h('label', { for: 'fb-text' }, 'Message'), ta, count),
    h('div.fb-two',
      h('div.field', h('label', { for: 'fb-name' }, 'Name'), name),
      h('div.field', h('label', { for: 'fb-contact' }, 'Reply to'), contact)),
    hp, shotRow, what, wait, status,
    h('div.fb-actions', ownerBtn, sendBtn));
  const body = h('div.fb-panel', form);

  function save() { ls.set(LS.draft, JSON.stringify({ kind, text: ta.value, name: name.value, contact: contact.value })); }

  function update() {
    if (received) return paintReceived();
    const len = ta.value.trim().length;
    count.textContent = `${ta.value.length} / ${MAX_TEXT}`;
    count.classList.toggle('is-max', ta.value.length >= MAX_TEXT);
    const left = ownerKey() ? 0 : nextAt() - Date.now();
    wait.hidden = left <= 0;
    if (left > 0) wait.textContent = `Next note allowed in ${clock(left)}. Your draft is kept until then.`;
    sendBtn.disabled = busy || len < MIN_TEXT || left > 0;
  }
  for (const el of [ta, name, contact]) el.addEventListener('input', () => { save(); update(); paintSent(); });

  async function send() {
    const text = ta.value.trim();
    if (busy || text.length < MIN_TEXT) { if (text.length < MIN_TEXT) say('Write a little more first.', true); return; }
    busy = true; update(); say('Sending...');
    const payload = { kind, text, name: name.value.trim(), contact: contact.value.trim(), website: hp.value, bid: browserId(), ctx: context() };
    if (shot) payload.shot = shot.url;
    let res, slow = false;
    const timeout = 20000 + Math.ceil((payload.shot ? payload.shot.length : 0) / 25);
    try { res = await call('/feedback', { method: 'POST', body: payload, key: ownerKey(), timeout }); } catch (e) { res = null; slow = e && e.name === 'AbortError'; }
    busy = false;
    if (slow) {
      if (!ownerKey()) ls.set(LS.next, String(Date.now() + WINDOW_MS));
      say(SLOW + ' Your draft is kept.', true); update(); return;
    }
    if (!res) { say(UNREACHABLE + ' Your note is still here; try again in a minute.', true); update(); return; }
    const { r, j } = res;
    if (r.status === 429) {
      ls.set(LS.next, String(Date.now() + (+j.retryAfter || 600) * 1000));
      say((j.error || 'Too many notes.') + ' Your draft is kept.', true);
      update();
      return;
    }
    if (!r.ok) { say((j.error || `The server turned the note away (${r.status}).`) + ' Your draft is kept.', true); update(); return; }
    ls.set(LS.next, String(Date.now() + (j.retryAfter === undefined ? WINDOW_MS / 1000 : +j.retryAfter) * 1000));
    ta.value = '';
    save();
    received = true;
    clear(body);
    body.append(receivedCard);
    paintReceived();
    refreshBadge();
  }

  const waitLine = h('p.fb-wait');
  const closeBtn = h('button.btn', { type: 'button', onclick: () => m.close() }, 'Close');
  const receivedCard = h('div.fb-received',
    h('div.stamp.stamp-lg.fb-stamp', 'Received'),
    h('p', 'Your note is on the owner\'s desk. Thank you for writing in.'),
    waitLine, closeBtn);
  function paintReceived() {
    const left = ownerKey() ? 0 : nextAt() - Date.now();
    waitLine.textContent = left > 0 ? `Next note allowed in ${clock(left)}` : 'You can send another note now.';
  }

  update();
  const timer = setInterval(update, 1000);
  const m = openModal({
    title: 'Feedback', no: 'Form OCP-9', body,
    initialFocus: '#fb-text',
    onClose: () => { clearInterval(timer); openNow = null; if (!handedOff && onClose) onClose(); },
  });
  m.el.classList.add('fb-modal');
  openNow = m;
  return m;
}

// ------------------------------------------------------------ owner view

export function openOwner({ onClose } = {}) {
  if (openNow) { if (onClose) onClose(); return null; }
  const urls = [];
  const body = h('div.fb-owner');
  let kindF = '', unreadOnly = false, cursor = null, loading = false;

  function keyForm(msg = '') {
    clear(body);
    const inp = h('input.input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Owner key', 'aria-label': 'Owner key' });
    const go = h('button.btn.btn-go', { type: 'submit' }, 'Open the file');
    const keep = h('input', { type: 'checkbox' });
    const note = h('p.fb-status' + (msg ? '.is-err' : ''), msg);
    const f = h('form.fb-keyform', {
      onsubmit: async (e) => {
        e.preventDefault();
        const k = inp.value.trim();
        if (!k) return;
        go.disabled = true; note.classList.remove('is-err'); note.textContent = 'Checking the key...';
        let res = null;
        try { res = await call('/feedback/count', { key: k }); } catch (err) { res = null; }
        go.disabled = false;
        if (!res) { note.classList.add('is-err'); note.textContent = 'The feedback server could not be reached.'; return; }
        if (res.r.status === 401) { note.classList.add('is-err'); note.textContent = 'That is not the owner key.'; return; }
        if (!res.r.ok) { note.classList.add('is-err'); note.textContent = res.j.error || `The server said ${res.r.status}.`; return; }
        setOwnerKey(k, keep.checked);
        unread = res.j.unread | 0;
        paintBadge();
        fileView();
      },
    }, h('p.small.muted', 'Only the owner can read the notes. The key is kept in this tab until you close it or forget it.'), h('div.fb-keyrow', inp, go),
      h('label.check.small', keep, 'Remember on this device'), note);
    body.append(f);
    requestAnimationFrame(() => inp.focus());
  }

  const status = h('p.fb-status', { role: 'status' });
  const list = h('div.fb-list');
  const more = h('button.btn.btn-sm.fb-more', { type: 'button', hidden: true, onclick: () => load(true) }, 'Load more');
  const totals = () => {
    const n = list.children.length;
    status.classList.remove('is-err');
    status.textContent = n ? `${n} shown${cursor ? ', more below' : ''}. ${unread} unread in the file.` : (kindF || unreadOnly ? 'No notes match.' : 'Nobody has sent anything yet.');
  };
  const fail = (msg) => { status.classList.add('is-err'); status.textContent = msg; };

  function fileView() {
    clear(body);
    const kindSel = h('select.select.fb-filter', { 'aria-label': 'Kind' }, h('option', { value: '' }, 'All kinds'), KINDS.map(([v, n]) => h('option', { value: v }, n)));
    kindSel.value = kindF;
    kindSel.addEventListener('change', () => { kindF = kindSel.value; load(false); });
    const un = h('input', { type: 'checkbox' });
    un.checked = unreadOnly;
    un.addEventListener('change', () => { unreadOnly = un.checked; load(false); });
    body.append(
      h('div.fb-tools', kindSel, h('label.check', un, 'Unread only'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => load(false) }, 'Refresh'),
        h('button.btn.btn-sm', { type: 'button', onclick: exportAll }, 'Export JSON'),
        h('button.btn.btn-sm.btn-ghost.fb-forget', { type: 'button', onclick: () => { setOwnerKey(''); unread = 0; paintBadge(); keyForm('Key forgotten on this device.'); } }, 'Forget key')),
      status, list, more);
    load(false);
  }

  async function load(append) {
    if (loading) return;
    loading = true;
    if (!append) { cursor = null; clear(list); }
    status.classList.remove('is-err'); status.textContent = 'Loading...';
    const q = new URLSearchParams({ limit: '25' });
    if (kindF) q.set('kind', kindF);
    if (unreadOnly) q.set('unread', '1');
    if (append && cursor) q.set('cursor', cursor);
    try {
      const [{ r, j }, c] = await Promise.all([call('/feedback?' + q, { key: ownerKey() }), append ? null : call('/feedback/count', { key: ownerKey() }).catch(() => null)]);
      if (r.status === 401) { setOwnerKey(''); unread = 0; paintBadge(); keyForm('The saved key was refused. Enter it again.'); return; }
      if (!r.ok) { fail(j.error || `The server said ${r.status}.`); return; }
      if (c && c.r.ok) { unread = c.j.unread | 0; paintBadge(); }
      cursor = j.cursor || null;
      for (const it of j.items || []) list.append(noteCard(it));
      more.hidden = !cursor;
      totals();
    } catch (e) { fail('The feedback server could not be reached.'); } finally { loading = false; }
  }

  function noteCard(it) {
    let read = !!it.read;
    const card = h('article.fb-note');
    const mark = h('span.fb-unread-mark', 'Unread');
    const readBtn = h('button.btn.btn-sm', { type: 'button' });
    const paint = () => { card.classList.toggle('is-unread', !read); mark.hidden = read; readBtn.textContent = read ? 'Mark unread' : 'Mark read'; };
    readBtn.addEventListener('click', async () => {
      readBtn.disabled = true;
      try {
        const { r, j } = await call('/feedback/' + encodeURIComponent(it.id), { method: 'PATCH', body: { read: !read }, key: ownerKey() });
        if (r.ok) { read = !!j.read; unread = Math.max(0, unread + (read ? -1 : 1)); paint(); paintBadge(); totals(); } else fail(j.error || 'That note could not be changed.');
      } catch (e) { fail('The feedback server could not be reached.'); }
      readBtn.disabled = false;
    });
    const delBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Delete note', message: 'Delete this note for good? It cannot be brought back.', confirmLabel: 'Delete', danger: true }))) return;
      try {
        const { r, j } = await call('/feedback/' + encodeURIComponent(it.id), { method: 'DELETE', key: ownerKey() });
        if (r.ok) { if (!read) unread = Math.max(0, unread - 1); card.remove(); paintBadge(); totals(); } else fail(j.error || 'That note could not be deleted.');
      } catch (e) { fail('The feedback server could not be reached.'); }
    });
    const who = [it.name && `From ${it.name}`, it.contact && `Reply to ${it.contact}`].filter(Boolean);
    const ctx = it.ctx && typeof it.ctx === 'object' ? Object.entries(it.ctx) : [];
    const grid = h('dl.fb-ctx-grid', ctx.map(([k, v]) => [h('dt', k), h('dd', Array.isArray(v) ? v.join(' | ') || '(none)' : String(v))]));
    let shotBox = null;
    if (it.shot) {
      shotBox = h('div.fb-note-shot');
      const showBtn = h('button.btn.btn-sm', { type: 'button' }, `Show map screenshot (${kb(it.shot)})`);
      showBtn.addEventListener('click', async () => {
        showBtn.disabled = true; showBtn.textContent = 'Loading screenshot...';
        try {
          const res = await call('/feedback/' + encodeURIComponent(it.id) + '/shot', { key: ownerKey(), blob: true });
          if (!res.blob) throw new Error((res.j && res.j.error) || 'missing');
          const url = URL.createObjectURL(res.blob);
          urls.push(url);
          const img = h('img.fb-note-thumb', { src: url, alt: 'Map screenshot sent with this note', title: 'Click to enlarge' });
          img.addEventListener('click', () => {
            const z = openModal({ title: 'Map screenshot', no: fmtDate(it.at, true), wide: true, body: h('img.fb-zoom-img', { src: url, alt: 'Map screenshot, full size' }) });
            z.el.classList.add('fb-zoom');
          });
          showBtn.replaceWith(img);
        } catch (e) { showBtn.disabled = false; showBtn.textContent = 'Screenshot unavailable, try again'; }
      });
      shotBox.append(showBtn);
    }
    // Element.append would print a null as the text "null"
    card.append(...[
      h('header.fb-note-head', h('span.fb-note-kind', kindName(it.kind)), h('span.fb-note-time', fmtDate(it.at, true)), mark,
        h('span.fb-note-acts', readBtn, delBtn)),
      h('p.fb-note-text', String(it.text || '')),
      who.length ? h('p.fb-note-who', who.join(' · ')) : null,
      shotBox,
      ctx.length ? h('details.fb-ctx', h('summary', 'Context'), grid) : null].filter(Boolean));
    paint();
    return card;
  }

  async function exportAll() {
    status.classList.remove('is-err'); status.textContent = 'Exporting...';
    try {
      const res = await call('/feedback/export', { key: ownerKey(), blob: true, timeout: 60000 });
      if (!res.blob) { fail((res.j && res.j.error) || 'The export failed.'); return; }
      const url = URL.createObjectURL(res.blob);
      const a = h('a', { href: url, download: `remain-calm-feedback-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      totals();
    } catch (e) { fail('The feedback server could not be reached.'); }
  }

  if (ownerKey()) fileView(); else keyForm();
  const m = openModal({
    title: 'Feedback file', no: 'Owner / OCP-9', wide: true, body,
    initialFocus: '.fb-filter, .fb-keyform input',
    onClose: () => { openNow = null; for (const u of urls) URL.revokeObjectURL(u); refreshBadge(); if (onClose) onClose(); },
  });
  m.el.classList.add('fb-modal', 'fb-owner-modal');
  openNow = m;
  return m;
}
