// Local library ("workshop") of maps, mutators and scenarios. IndexedDB, with an in-memory fallback
// (Node, private windows, blocked storage). Metadata and payloads live in separate stores so listing stays fast.
// Item: { id, type: 'map'|'mutator'|'scenario', name, author, desc, created, updated, favourite, size, data }
//   map: MapData · mutator: { lines: string[] } · scenario: { map: MapData, mutators: string[], difficulty }
import { serializeMap, parseMap, normalizeMap, validateMap, FORMAT, FILE_EXT } from './format.js';
import { parseOverrides } from '../data/config.js';
import { encodeShareCode, decodeShareCode } from '../util/compress.js';

export const ITEM_TYPES = ['map', 'mutator', 'scenario'];
export const DIFFICULTIES = ['normal', 'hardcore', 'ultra'];
export const SORTS = ['newest', 'name', 'size', 'favourite'];
const DB_NAME = 'remain-calm-library', DB_VERSION = 1, META = 'meta', DATA = 'data';
const LIMITS = { name: 80, author: 60, desc: 2000, lines: 400, lineLen: 400 };

// ---------------------------------------------------------------- backend

class MemoryStore {
  constructor() { this.meta = new Map(); this.data = new Map(); }
  async allMeta() { return [...this.meta.values()].map(m => ({ ...m })); }
  async getMeta(id) { const m = this.meta.get(id); return m ? { ...m } : null; }
  async getData(id) { return this.data.has(id) ? JSON.parse(this.data.get(id)) : null; }
  async put(meta, data) { this.meta.set(meta.id, { ...meta }); if (data !== undefined) this.data.set(meta.id, JSON.stringify(data)); }
  async putMeta(meta) { this.meta.set(meta.id, { ...meta }); }
  async remove(id) { this.meta.delete(id); this.data.delete(id); }
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

class IdbStore {
  constructor(db) { this.db = db; }
  tx(stores, mode) { return this.db.transaction(stores, mode); }
  async allMeta() { return req(this.tx([META], 'readonly').objectStore(META).getAll()); }
  async getMeta(id) { return (await req(this.tx([META], 'readonly').objectStore(META).get(id))) || null; }
  async getData(id) { const r = await req(this.tx([DATA], 'readonly').objectStore(DATA).get(id)); return r ? r.data : null; }
  put(meta, data) {
    return new Promise((res, rej) => {
      const t = this.tx([META, DATA], 'readwrite');
      t.objectStore(META).put(meta);
      if (data !== undefined) t.objectStore(DATA).put({ id: meta.id, data });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Library write aborted'));
    });
  }
  putMeta(meta) { return this.put(meta, undefined); }
  remove(id) {
    return new Promise((res, rej) => {
      const t = this.tx([META, DATA], 'readwrite');
      t.objectStore(META).delete(id); t.objectStore(DATA).delete(id);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }
}

let storePromise = null;
export let storageKind = 'unknown';

function openStore() {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('no IndexedDB');
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
          if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('Library database is blocked by another tab'));
      });
      storageKind = 'indexeddb';
      return new IdbStore(db);
    } catch (e) {
      storageKind = 'memory';
      return new MemoryStore();
    }
  })();
  return storePromise;
}

// Tests (and a "clear" in settings) can swap in a fresh in-memory store.
export function useMemoryStore() { storageKind = 'memory'; storePromise = Promise.resolve(new MemoryStore()); }

// ---------------------------------------------------------------- validation of payloads

const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function cleanLines(lines) {
  const arr = Array.isArray(lines) ? lines : typeof lines === 'string' ? lines.split(/\r?\n/) : [];
  return arr.filter(l => typeof l === 'string').map(l => l.slice(0, LIMITS.lineLen)).slice(0, LIMITS.lines);
}

export function cleanData(type, data) {
  if (type === 'map') {
    if (!data || data.format !== FORMAT) throw new Error('Not a REMAIN CALM map');
    const m = normalizeMap(data);
    const v = validateMap(m);
    if (!v.ok) throw new Error('Invalid map: ' + v.errors[0]);
    return m;
  }
  if (type === 'mutator') {
    const lines = cleanLines(data && data.lines !== undefined ? data.lines : data);
    if (!parseOverrides(lines.join('\n')).length) throw new Error('Mutator has no "path=value" lines');
    return { lines };
  }
  if (type === 'scenario') {
    if (!data || typeof data !== 'object') throw new Error('Scenario is empty');
    return {
      map: cleanData('map', data.map),
      mutators: cleanLines(data.mutators),
      difficulty: DIFFICULTIES.includes(data.difficulty) ? data.difficulty : 'normal',
    };
  }
  throw new Error('Unknown item type: ' + type);
}

export function dataSize(type, data) {
  if (type === 'map') return serializeMap(data).length;
  if (type === 'scenario') return serializeMap(data.map).length + JSON.stringify(data.mutators || []).length + 40;
  return JSON.stringify(data).length;
}

const newId = () => 'it_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------- CRUD

export async function listItems({ type, sort = 'newest', search = '', favouritesOnly = false } = {}) {
  const st = await openStore();
  let items = await st.allMeta();
  if (type) items = items.filter(m => m.type === type);
  if (favouritesOnly) items = items.filter(m => m.favourite);
  const q = String(search || '').trim().toLowerCase();
  if (q) items = items.filter(m => (m.name + ' ' + (m.author || '') + ' ' + (m.desc || '')).toLowerCase().includes(q));
  const byNew = (a, b) => b.updated - a.updated || (a.id < b.id ? 1 : -1);
  if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byNew(a, b));
  else if (sort === 'size') items.sort((a, b) => b.size - a.size || byNew(a, b));
  else if (sort === 'favourite') items.sort((a, b) => (b.favourite ? 1 : 0) - (a.favourite ? 1 : 0) || byNew(a, b));
  else items.sort(byNew);
  return items;
}

export async function getItem(id) {
  const st = await openStore();
  const meta = await st.getMeta(id);
  if (!meta) return null;
  return { ...meta, data: await st.getData(id) };
}

// Saves a new item or overwrites an existing one (when item.id exists). Returns the stored item (with data).
export async function saveItem(item) {
  if (!item || !ITEM_TYPES.includes(item.type)) throw new Error('Unknown item type');
  const st = await openStore();
  const data = cleanData(item.type, item.data);
  const now = Date.now();
  const prev = item.id ? await st.getMeta(item.id) : null;
  const fallbackName = item.type === 'map' ? data.name : item.type === 'scenario' ? data.map.name + ' scenario' : 'Untitled mutator';
  const meta = {
    id: prev ? prev.id : (item.id && typeof item.id === 'string' ? item.id.slice(0, 64) : newId()),
    type: item.type,
    name: s(item.name, LIMITS.name) || fallbackName || 'Untitled',
    author: s(item.author, LIMITS.author) || (item.type === 'map' ? data.author : '') || '',
    desc: s(item.desc, LIMITS.desc) || (item.type === 'map' ? data.desc : '') || '',
    created: prev ? prev.created : (Number.isFinite(item.created) ? item.created : now),
    updated: now,
    favourite: item.favourite !== undefined ? !!item.favourite : prev ? prev.favourite : false,
    size: dataSize(item.type, data),
  };
  if (item.type === 'map') { meta.w = data.w; meta.h = data.h; meta.buildings = data.buildings.length; meta.stages = data.levels.length; meta.source = data.source; }
  await st.put(meta, data);
  return { ...meta, data };
}

export async function deleteItem(id) { const st = await openStore(); await st.remove(id); }

export async function setFavourite(id, fav) {
  const st = await openStore();
  const m = await st.getMeta(id);
  if (!m) return null;
  m.favourite = !!fav;
  await st.putMeta(m);
  return m;
}
export async function toggleFavourite(id) {
  const st = await openStore();
  const m = await st.getMeta(id);
  return m ? setFavourite(id, !m.favourite) : null;
}
export async function renameItem(id, name) {
  const st = await openStore();
  const m = await st.getMeta(id);
  if (!m) return null;
  m.name = s(name, LIMITS.name) || m.name;
  m.updated = Date.now();
  await st.putMeta(m);
  return m;
}

// ---------------------------------------------------------------- export / import

// A map exports as a plain .rcmap.json (MapData). Mutators and scenarios use the library wrapper.
export function exportText(item) {
  if (item.type === 'map') return serializeMap(item.data);
  return JSON.stringify({
    kind: 'rc-library', v: 1,
    item: { type: item.type, name: item.name, author: item.author || '', desc: item.desc || '', created: item.created || Date.now(), data: item.data },
  });
}

export function exportFileName(item) {
  const base = String(item.name || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';
  return item.type === 'map' ? base + FILE_EXT : `${base}.rc${item.type}.json`;
}

// Parses exported text (map file, library wrapper, or bare mutator lines) into an unsaved item.
export function importText(text) {
  const str = String(text || '').trim();
  if (!str) throw new Error('Nothing to import');
  if (str[0] === '{') {
    let o;
    try { o = JSON.parse(str); } catch (e) { throw new Error('File is not valid JSON'); }
    if (o && o.format === FORMAT) {
      const map = parseMap(o);
      return { type: 'map', name: map.name, author: map.author, desc: map.desc, data: map };
    }
    if (o && o.kind === 'rc-library' && o.item && ITEM_TYPES.includes(o.item.type)) {
      const it = o.item;
      const data = cleanData(it.type, it.data);
      return { type: it.type, name: s(it.name, LIMITS.name) || (it.type === 'map' ? data.name : 'Imported ' + it.type), author: s(it.author, LIMITS.author), desc: s(it.desc, LIMITS.desc), data };
    }
    throw new Error('Not a REMAIN CALM file');
  }
  const lines = cleanLines(str);
  if (parseOverrides(lines.join('\n')).length) return { type: 'mutator', name: 'Imported mutator', author: '', desc: '', data: { lines } };
  throw new Error('Not a REMAIN CALM file');
}

export async function shareCode(item) {
  return encodeShareCode(JSON.stringify({ kind: 'rc-library', v: 1, item: { type: item.type, name: item.name, author: item.author || '', desc: item.desc || '', data: item.data } }));
}

export async function fromShareCode(code) {
  return importText(await decodeShareCode(code));
}

// Browser helpers -----------------------------------------------------------------

export function downloadItem(item) {
  if (typeof document === 'undefined') throw new Error('Downloads need a browser');
  const blob = new Blob([exportText(item)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = exportFileName(item);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importFile(file) {
  if (!file) throw new Error('No file chosen');
  if (file.size > 80 * 1024 * 1024) throw new Error('File is too large');
  return importText(await file.text());
}
