// Overpass transport: mirror ranking from session health, hedged requests (at most 2 in flight per import),
// first-byte and stall timeouts, rounds with backoff, honest error summaries.

// Probed 2026-11-18: these answered (overpass-api.de also stands for its lz4/z servers). private.coffee and
// kumi.systems never answered in 45 minutes of probing; overpass.osm.jp no longer resolves.
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const NET = {
  hedgeMs: 4000,       // start a second mirror if nothing streams by then
  firstByteMs: 10000,  // a mirror with no byte by then gives way to the next untried one
  firstByteMaxMs: 60000, // even the last hope is dropped after this long without a byte
  stallMs: 45000,      // no bytes for this long while streaming
  hardMs: 95000,       // whole attempt
  inFlight: 2,
  rounds: 3,
  backoffMs: [3000, 8000],
  roundCapMs: 30000,   // a round that took longer than this is not repeated
  cooldownMs: 180000,  // a failed mirror ranks last for this long
};

const health = new Map();
export const hostOf = url => { try { return new URL(url).host; } catch (e) { return String(url); } };
export function mirrorHealth() { return OVERPASS_MIRRORS.map(url => ({ url, ...(health.get(url) || {}) })); }
export function resetMirrorHealth() { health.clear(); }
function note(url, ok, ms, why) {
  const h = health.get(url) || { ok: 0, fail: 0, lastOk: 0, lastFail: 0, ms: 0, why: '' };
  if (ok) { h.ok++; h.lastOk = Date.now(); h.ms = ms; h.why = ''; } else { h.fail++; h.lastFail = Date.now(); h.why = why || ''; }
  health.set(url, h);
}

export function rankMirrors(now = Date.now(), list = OVERPASS_MIRRORS) {
  const good = [], unknown = [], bad = [];
  list.forEach((url, i) => {
    const h = health.get(url);
    if (!h || (!h.lastOk && !h.lastFail)) unknown.push([url, i]);
    else if (h.lastOk >= h.lastFail) good.push([url, -h.lastOk]);
    else if (now - h.lastFail > NET.cooldownMs) unknown.push([url, i - 0.5]);
    else bad.push([url, h.lastFail]);
  });
  const by = (a, b) => a[1] - b[1];
  return [...good.sort(by), ...unknown.sort(by), ...bad.sort(by)].map(x => x[0]);
}

export function makeSlots(n) {
  let free = n;
  const q = [];
  return {
    take() { if (free > 0) { free--; return Promise.resolve(); } return new Promise(r => q.push(r)); },
    tryTake() { if (free > 0) { free--; return true; } return false; },
    give() { const r = q.shift(); if (r) r(); else free++; },
    get free() { return free; },
  };
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal && signal.aborted) return rej(cancelled());
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(cancelled()); }, { once: true });
});
export const cancelled = () => Object.assign(new Error('Import cancelled'), { cancelled: true });

function httpWhy(status, text) {
  if (status === 429) return 'rate limit (429)';
  if (/at capacity|too busy|queue is full/i.test(text || '')) return `at capacity (${status})`;
  if (status === 504) return 'server timeout (504)';
  if (status === 502 || status === 503) return `server busy (${status})`;
  if (status === 400) return 'query rejected (400)';
  if (status === 403 || status === 406) return `refused (${status})`;
  return `HTTP ${status}`;
}

// One POST to one mirror. Returns { url, promise, abort(why), started, streaming }.
function attempt(url, query, { fetchImpl, onEvent, onFirst, onSlow }) {
  const ctl = new AbortController();
  const a = { url, t0: Date.now(), streaming: false, why: '', slowFired: false };
  a.abort = (why) => { if (!a.why) a.why = why; try { ctl.abort(new Error(why)); } catch (e) { /* already done */ } };
  const timers = [];
  const arm = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  let stallT = 0;
  const kick = () => { clearTimeout(stallT); stallT = setTimeout(() => a.abort('stalled'), NET.stallMs); };
  a.promise = (async () => {
    await null;
    arm(NET.firstByteMs, () => { if (!a.streaming) { a.slowFired = true; onSlow(a); } });
    arm(NET.firstByteMaxMs, () => { if (!a.streaming) a.abort('no answer in ' + Math.round(NET.firstByteMaxMs / 1000) + ' s'); });
    arm(NET.hardMs, () => a.abort('took longer than ' + Math.round(NET.hardMs / 1000) + ' s'));
    try {
      onEvent({ phase: 'request', endpoint: url });
      const res = await fetchImpl(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        let txt = '';
        try { txt = (await res.text()).slice(0, 600); } catch (e) { /* ignore */ }
        throw Object.assign(new Error(httpWhy(res.status, txt)), { status: res.status, busy: res.status === 429 || res.status >= 500 });
      }
      let text, bytes = 0;
      const first = () => { if (!a.streaming) { a.streaming = true; onFirst(a); } };
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader(), dec = new TextDecoder(), parts = [];
        kick();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          kick();
          first();
          bytes += value.length;
          parts.push(dec.decode(value, { stream: true }));
          onEvent({ phase: 'download', bytes, endpoint: url });
        }
        parts.push(dec.decode());
        text = parts.join('');
      } else { text = await res.text(); first(); bytes = text.length; onEvent({ phase: 'download', bytes, endpoint: url }); }
      onEvent({ phase: 'parse', bytes, endpoint: url });
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error(/<html|<!doctype/i.test(text.slice(0, 200)) ? 'answered with an error page' : 'sent incomplete data'); }
      if (!data || !Array.isArray(data.elements)) throw new Error('unexpected answer');
      if (data.remark && /runtime error|timed out|out of memory|exceed/i.test(data.remark)) throw new Error('ran out of time or memory on the server');
      a.bytes = bytes;
      return data;
    } catch (e) {
      if (a.why) throw Object.assign(new Error(a.why), { aborted: true, slow: a.why === 'slow', lost: a.why === 'lost' || a.why === 'cancelled' });
      if (e && (e.name === 'TypeError' || /fetch failed|network/i.test(e.message))) throw Object.assign(new Error('unreachable'), { busy: true });
      throw e;
    } finally { for (const t of timers) clearTimeout(t); clearTimeout(stallT); }
  })();
  return a;
}

// Race mirrors for one query. Resolves with the parsed data; rejects with { attempts: [{url, why}] }.
export function raceMirrors(query, { signal, slots, onEvent = () => {}, fetchImpl = fetch, order = rankMirrors() } = {}) {
  return new Promise((resolve, reject) => {
    const live = new Set(), errors = [];
    let idx = 0, done = false, hedgeT = 0, winner = null, pending = 0;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeT);
      for (const a of live) a.abort(err && err.cancelled ? 'cancelled' : 'lost');
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(val);
    };
    const onAbort = () => finish(cancelled());
    if (signal) { if (signal.aborted) { reject(cancelled()); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    const exhausted = () => {
      if (done || live.size || pending || idx < order.length) return;
      const err = new Error(errors.length ? errors.map(e => `${hostOf(e.url)}: ${e.why}`).join('; ') : 'no server answered');
      err.attempts = errors.slice();
      err.busy = errors.every(e => e.busy);
      finish(err);
    };
    const armHedge = () => {
      clearTimeout(hedgeT);
      hedgeT = setTimeout(() => { if (!done && !winner && idx < order.length) launch(true); }, NET.hedgeMs);
    };
    const start = (url) => {
      const a = attempt(url, query, {
        fetchImpl,
        onEvent: (e) => { if (!done && (!winner || winner === a)) onEvent(e); },
        onFirst: (x) => {
          if (winner) return;
          winner = x;
          note(x.url, true, Date.now() - x.t0);
          clearTimeout(hedgeT);
          for (const b of live) if (b !== x) b.abort('lost');
        },
        // The best-ranked attempt keeps waiting; the second slot moves on through the untried mirrors.
        onSlow: (x) => {
          if (done || winner) return;
          if (idx >= order.length) { onEvent({ phase: 'wait', endpoint: x.url }); return; }
          onEvent({ phase: 'slow', endpoint: x.url });
          if (live.size < NET.inFlight && slots.free > 0) { launch(true); return; }
          const all = [...live];
          if (all.length < 2 || !all.every(b => b.slowFired)) return;
          all.sort((p, q) => order.indexOf(q.url) - order.indexOf(p.url))[0].abort('slow');
        },
      });
      live.add(a);
      a.promise.then((data) => {
        live.delete(a); slots.give();
        finish(null, { data, url, ms: Date.now() - a.t0, bytes: a.bytes || 0 });
      }, (err) => {
        live.delete(a); slots.give();
        if (done) return;
        if (err.lost) { exhausted(); return; }
        const why = err.slow ? `no answer within ${Math.round(NET.firstByteMs / 1000)} s` : (err.message || 'failed');
        note(url, false, 0, why);
        errors.push({ url, why, busy: !!err.busy || !!err.slow || !!err.aborted });
        if (winner === a) winner = null;
        onEvent({ phase: 'retry', endpoint: url, error: why });
        if (!winner && idx < order.length && live.size < NET.inFlight) launch(false);
        exhausted();
      });
      armHedge();
    };
    const launch = async (hedge) => {
      if (done || idx >= order.length) return;
      if (hedge) { if (!slots.tryTake()) return; } else { pending++; await slots.take(); pending--; }
      // a slot that frees up after another mirror started streaming is not spent on a third request
      if (done || winner || idx >= order.length) { slots.give(); exhausted(); return; }
      start(order[idx++]);
    };
    launch(false);
  });
}

// Rounds with backoff around raceMirrors (servers that are at capacity ask for exactly this).
export async function fetchQuery(query, { signal, slots = makeSlots(NET.inFlight), onEvent = () => {}, fetchImpl = fetch } = {}) {
  let last = null;
  for (let round = 0; round < NET.rounds; round++) {
    if (round) {
      const ms = NET.backoffMs[Math.min(round - 1, NET.backoffMs.length - 1)];
      onEvent({ phase: 'backoff', wait: ms, round });
      await sleep(ms, signal);
    }
    const t0 = Date.now();
    try {
      return await raceMirrors(query, { signal, slots, onEvent, fetchImpl, order: rankMirrors() });
    } catch (e) {
      if (e.cancelled) throw e;
      last = e;
      if (!e.busy || Date.now() - t0 > NET.roundCapMs) break;
    }
  }
  const err = new Error('No map server could deliver the data. ' + (last ? last.message : ''));
  err.attempts = last && last.attempts;
  throw err;
}
