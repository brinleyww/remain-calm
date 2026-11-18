// Feedback for REMAIN CALM. Anyone can send a note; only the owner, holding OWNER_KEY (a Worker secret), can read, mark or delete them.
// KV keys: fb:<id> note (metadata {at, kind, read, shot}), shot:<id> JPEG bytes.
// The 10-minute marks and the daily counter live in one Durable Object (Gate), so parallel requests cannot all pass the check.
const KINDS = ['bug', 'idea', 'balance', 'praise', 'other'];
const WINDOW_S = 600;
// An accepted note costs up to 2 KV writes (note, screenshot); the free tier allows 1,000 a day, which leaves room for marking notes read.
const DAILY_CAP = 300;
const MIN_TEXT = 3, MAX_TEXT = 2000;
const MAX_SHOT = 350 * 1024;
const MAX_BODY = 640 * 1024;
const MAX_CTX = 4000;
const ORIGIN_OK = /^(https:\/\/brinleyww\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;
const ID_RE = /^\d{13}-[0-9a-f]{8}$/;

function corsHeaders(req) {
  const o = req.headers.get('Origin');
  if (!o || !ORIGIN_OK.test(o)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (req, o, status = 200, extra = {}) => new Response(JSON.stringify(o), {
  status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});
const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);

async function sha(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); }
const hex = (buf, n) => [...new Uint8Array(buf)].slice(0, n).map(x => x.toString(16).padStart(2, '0')).join('');

async function isOwner(req, env) {
  const m = /^Bearer\s+(\S+)\s*$/.exec(req.headers.get('Authorization') || '');
  if (!m || !env.OWNER_KEY) return false;
  // equal-length digests, so the comparison leaks neither content nor length
  const [a, b] = await Promise.all([sha(m[1]), sha(String(env.OWNER_KEY).trim())]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function cleanCtx(c) {
  const out = {};
  if (!c || typeof c !== 'object' || Array.isArray(c)) return out;
  for (const k of Object.keys(c).slice(0, 40)) {
    const key = str(k, 40), v = c[k];
    if (!key) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = str(v, 300);
    else if (Array.isArray(v)) out[key] = v.slice(0, 24).map(x => str(String(x), 160)).filter(Boolean);
  }
  while (JSON.stringify(out).length > MAX_CTX) delete out[Object.keys(out).pop()];
  return out;
}

function decodeShot(s) {
  const p = 'data:image/jpeg;base64,';
  if (typeof s !== 'string' || !s.startsWith(p)) return { err: 'The screenshot must be a JPEG.' };
  const b64 = s.slice(p.length);
  if (b64.length > Math.ceil(MAX_SHOT / 3) * 4 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return { err: 'The screenshot is too large.' };
  let bin;
  try { bin = atob(b64); } catch { return { err: 'The screenshot could not be read.' }; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > MAX_SHOT || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return { err: 'The screenshot is not a JPEG.' };
  return { bytes };
}

const today = (t) => new Date(t).toISOString().slice(0, 10);

// An IPv6 user can pick any address in their /64, so only that prefix counts.
function ipKey(ip) {
  if (!ip.includes(':') || ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

// One instance for the whole Worker: requests reach it one at a time, so the check and the mark are a single step.
export class Gate {
  constructor(state) { this.storage = state.storage; this.marks = null; this.day = null; }
  async fetch(req) {
    const { addr, bid, now, cap, window } = await req.json();
    if (!this.marks) {
      this.marks = (await this.storage.get('marks')) || {};
      this.day = (await this.storage.get('day')) || { date: '', n: 0 };
    }
    const ms = window * 1000;
    for (const k of Object.keys(this.marks)) if (now - this.marks[k] >= ms) delete this.marks[k];
    const a = this.marks['a:' + addr], b = bid ? this.marks['b:' + bid] : 0;
    const wait = Math.max(...[a, b].map((v) => (v ? Math.ceil((v + ms - now) / 1000) : 0)));
    if (wait > 0) return Response.json({ wait, network: !!a && !b });
    const date = today(now);
    if (this.day.date !== date) this.day = { date, n: 0 };
    if (this.day.n >= cap) return Response.json({ full: true });
    this.day.n++;
    this.marks['a:' + addr] = now;
    if (bid) this.marks['b:' + bid] = now;
    await this.storage.put({ marks: this.marks, day: this.day });
    return Response.json({ ok: true });
  }
}
const untilMidnight = (t) => Math.ceil((86400000 - (t % 86400000)) / 1000);

async function send(req, env) {
  if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return json(req, { error: 'That note is too large.' }, 413);
  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(req, { error: 'That note is too large.' }, 413);
    body = JSON.parse(raw);
  } catch { return json(req, { error: 'The note could not be read.' }, 400); }
  if (!body || typeof body !== 'object') return json(req, { error: 'The note could not be read.' }, 400);
  const text = str(body.text, MAX_TEXT + 1);
  if (text.length < MIN_TEXT) return json(req, { error: 'Write a little more first.' }, 400);
  if (text.length > MAX_TEXT) return json(req, { error: `Keep it under ${MAX_TEXT} characters.` }, 400);
  let shot = null;
  if (body.shot) { shot = decodeShot(body.shot); if (shot.err) return json(req, { error: shot.err }, 400); }
  // a field people never see: only bots fill it, and they are told it worked
  if (str(body.website, 10)) return json(req, { ok: true, retryAfter: WINDOW_S });

  const now = Date.now();
  const owner = await isOwner(req, env);
  const bid = typeof body.bid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.bid) ? body.bid : '';
  const addr = hex(await sha((env.IP_SALT || env.OWNER_KEY || '') + '|' + ipKey(req.headers.get('CF-Connecting-IP') || '')), 16);
  if (!owner) {
    const gate = env.GATE.get(env.GATE.idFromName('gate'));
    const g = await (await gate.fetch('https://gate/claim', { method: 'POST', body: JSON.stringify({ addr, bid, now, cap: DAILY_CAP, window: WINDOW_S }) })).json();
    if (g.wait > 0) {
      const why = g.network ? 'Someone on your network sent a note in the last 10 minutes.' : 'One note every 10 minutes, please.';
      return json(req, { error: why, retryAfter: g.wait }, 429, { 'Retry-After': String(g.wait) });
    }
    if (g.full) {
      const wait2 = untilMidnight(now);
      return json(req, { error: 'The feedback box is full for today. Please try again tomorrow.', retryAfter: wait2 }, 429, { 'Retry-After': String(wait2) });
    }
  }
  // newest first in key order
  const id = String(1e13 - now).padStart(13, '0') + '-' + hex(crypto.getRandomValues(new Uint8Array(4)), 4);
  const item = {
    id, at: now, kind: KINDS.includes(body.kind) ? body.kind : 'other', text,
    name: str(body.name, 60), contact: str(body.contact, 120), ctx: cleanCtx(body.ctx),
    shot: shot ? shot.bytes.length : 0, read: false,
  };
  if (shot) await env.FEEDBACK.put('shot:' + id, shot.bytes);
  await env.FEEDBACK.put('fb:' + id, JSON.stringify(item), { metadata: { at: now, kind: item.kind, read: false, shot: !!shot } });
  return json(req, { ok: true, id, retryAfter: owner ? 0 : WINDOW_S });
}

const matches = (meta, kind, unread) => !!meta && (!kind || meta.kind === kind) && (!unread || !meta.read);

async function list(req, env, url) {
  const kind = KINDS.includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : '';
  const unread = url.searchParams.get('unread') === '1';
  const want = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 25));
  let cursor = url.searchParams.get('cursor') || undefined, done = false;
  const keys = [];
  // a filtered page may hold few matches, so keep reading pages until there are enough
  for (let pages = 0; pages < 6 && keys.length < want && !done; pages++) {
    const page = await env.FEEDBACK.list({ prefix: 'fb:', limit: want, cursor });
    for (const k of page.keys) if (matches(k.metadata, kind, unread)) keys.push(k.name);
    done = page.list_complete;
    cursor = done ? undefined : page.cursor;
  }
  const items = (await Promise.all(keys.map(k => env.FEEDBACK.get(k, 'json')))).filter(Boolean);
  return json(req, { items, cursor: done ? null : cursor });
}

async function allKeys(env) {
  const keys = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const page = await env.FEEDBACK.list({ prefix: 'fb:', limit: 1000, cursor });
    keys.push(...page.keys);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return keys;
}

async function counts(req, env) {
  const keys = await allKeys(env);
  return json(req, { total: keys.length, unread: keys.filter(k => k.metadata && !k.metadata.read).length });
}

async function exportAll(req, env) {
  const keys = await allKeys(env);
  const items = [];
  for (let i = 0; i < keys.length; i += 50) items.push(...(await Promise.all(keys.slice(i, i + 50).map(k => env.FEEDBACK.get(k.name, 'json')))).filter(Boolean));
  return json(req, { exported: new Date().toISOString(), count: items.length, items }, 200,
    { 'Content-Disposition': `attachment; filename="remain-calm-feedback-${today(Date.now())}.json"` });
}

async function getShot(req, env, id) {
  const bytes = await env.FEEDBACK.get('shot:' + id, 'arrayBuffer');
  if (!bytes) return json(req, { error: 'No screenshot for that note.' }, 404);
  return new Response(bytes, { headers: { ...corsHeaders(req), 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
}

async function mark(req, env, id) {
  let body;
  try { body = await req.json(); } catch { return json(req, { error: 'Not JSON' }, 400); }
  const item = await env.FEEDBACK.get('fb:' + id, 'json');
  if (!item) return json(req, { error: 'That note is gone.' }, 404);
  item.read = !!(body && body.read);
  await env.FEEDBACK.put('fb:' + id, JSON.stringify(item), { metadata: { at: item.at, kind: item.kind, read: item.read, shot: !!item.shot } });
  return json(req, { ok: true, read: item.read });
}

async function remove(req, env, id) {
  await Promise.all([env.FEEDBACK.delete('fb:' + id), env.FEEDBACK.delete('shot:' + id)]);
  return json(req, { ok: true });
}

async function route(req, env) {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: origin && ORIGIN_OK.test(origin) ? 204 : 403, headers: corsHeaders(req) });
  if (origin && !ORIGIN_OK.test(origin)) return json(req, { error: 'Not from the game.' }, 403);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/feedback' && req.method === 'POST') return send(req, env);
  if (!path.startsWith('/feedback')) return json(req, { error: 'Not found' }, 404);
  if (!(await isOwner(req, env))) return json(req, { error: 'Only the owner can do that.' }, 401);
  if (path === '/feedback' && req.method === 'GET') return list(req, env, url);
  if (path === '/feedback/count' && req.method === 'GET') return counts(req, env);
  if (path === '/feedback/export' && req.method === 'GET') return exportAll(req, env);
  const m = /^\/feedback\/([^/]+)(\/shot)?$/.exec(path);
  if (!m || !ID_RE.test(m[1])) return json(req, { error: 'Not found' }, 404);
  if (m[2] && req.method === 'GET') return getShot(req, env, m[1]);
  if (!m[2] && req.method === 'PATCH') return mark(req, env, m[1]);
  if (!m[2] && req.method === 'DELETE') return remove(req, env, m[1]);
  return json(req, { error: 'Not found' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await route(req, env); } catch (e) { return json(req, { error: 'The feedback server had a problem.' }, 500); }
  },
};
