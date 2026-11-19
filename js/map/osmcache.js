// Raw OpenStreetMap downloads kept in IndexedDB (gzip when the browser can), so re-importing a square is instant.
// Works in pages and workers; falls back to memory where IndexedDB is missing or blocked.
const DB_NAME = 'remain-calm-osm', DB_VERSION = 1, META = 'meta', DATA = 'data';
export const CACHE_LIMITS = { entries: 12, bytes: 400e6 };
export const CACHE_VERSION = 'q2';

export const cacheKey = (lat, lon, sizeKm) => `${CACHE_VERSION}:${(+lat).toFixed(4)},${(+lon).toFixed(4)}@${+sizeKm}`;

class Mem {
  constructor() { this.meta = new Map(); this.data = new Map(); }
  async all() { return [...this.meta.values()].map(m => ({ ...m })); }
  async get(key) { return this.data.get(key) || null; }
  async put(meta, blob) { this.meta.set(meta.key, { ...meta }); this.data.set(meta.key, blob); }
  async del(key) { this.meta.delete(key); this.data.delete(key); }
}

const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
class Idb {
  constructor(db) { this.db = db; }
  async all() { return rq(this.db.transaction([META], 'readonly').objectStore(META).getAll()); }
  async get(key) { const r = await rq(this.db.transaction([DATA], 'readonly').objectStore(DATA).get(key)); return r ? r.v : null; }
  put(meta, v) {
    return new Promise((res, rej) => {
      const t = this.db.transaction([META, DATA], 'readwrite');
      t.objectStore(META).put(meta);
      t.objectStore(DATA).put({ key: meta.key, v });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('cache write aborted'));
    });
  }
  del(key) {
    return new Promise((res, rej) => {
      const t = this.db.transaction([META, DATA], 'readwrite');
      t.objectStore(META).delete(key); t.objectStore(DATA).delete(key);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }
}

let store = null;
function open() {
  if (store) return store;
  store = (async () => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('no IndexedDB');
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
          if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA, { keyPath: 'key' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      });
      return new Idb(db);
    } catch (e) { return new Mem(); }
  })();
  return store;
}
export function useMemoryCache() { store = Promise.resolve(new Mem()); }

const canZip = () => typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined';
async function pack(text) {
  if (!canZip()) return { z: false, v: text, bytes: text.length };
  const buf = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { z: true, v: buf, bytes: buf.byteLength };
}
async function unpack(rec) {
  if (!rec) return null;
  if (!rec.z) return rec.v;
  return new Response(new Blob([rec.v]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// Elements are packed in chunks: a whole city in one JSON string could pass the browser's longest string.
const CHUNK = 40000;

// raw: { elements } as fetched. meta: { name, lat, lon, sizeKm, bytes }
export async function cachePut(key, raw, meta = {}) {
  const st = await open();
  const parts = [];
  let bytes = 0, z = true;
  for (let i = 0; i < raw.elements.length || !parts.length; i += CHUNK) {
    const p = await pack(JSON.stringify(raw.elements.slice(i, i + CHUNK)));
    parts.push(p.v); bytes += p.bytes; z = p.z;
  }
  const m = { key, t: Date.now(), name: String(meta.name || '').slice(0, 80), lat: +meta.lat, lon: +meta.lon, sizeKm: +meta.sizeKm,
    bytes, rawBytes: +meta.bytes || 0, n: raw.elements.length, stamp: (raw.osm3s && raw.osm3s.timestamp_osm_base) || '' };
  await st.put(m, { z, parts, osm3s: raw.osm3s || null });
  await prune(st);
  return m;
}

export async function cacheGet(key) {
  const st = await open();
  const rec = await st.get(key);
  if (!rec) return null;
  try {
    let raw;
    if (Array.isArray(rec.parts)) {
      const elements = [];
      for (const v of rec.parts) { const arr = JSON.parse(await unpack({ z: rec.z, v })); for (const e of arr) elements.push(e); }
      raw = { elements, osm3s: rec.osm3s || null };
    } else raw = JSON.parse(await unpack(rec));
    if (!raw || !Array.isArray(raw.elements)) throw new Error('bad entry');
    return raw;
  } catch (e) { await st.del(key).catch(() => {}); return null; }
}

export async function cacheList() {
  const st = await open();
  return (await st.all()).filter(m => m.key.startsWith(CACHE_VERSION + ':')).sort((a, b) => b.t - a.t);
}

export async function cacheDelete(key) { const st = await open(); await st.del(key); }

async function prune(st) {
  const all = (await st.all()).sort((a, b) => b.t - a.t);
  let bytes = 0;
  for (let i = 0; i < all.length; i++) {
    bytes += all[i].bytes || 0;
    if (i >= CACHE_LIMITS.entries || bytes > CACHE_LIMITS.bytes || !all[i].key.startsWith(CACHE_VERSION + ':')) await st.del(all[i].key);
  }
}
