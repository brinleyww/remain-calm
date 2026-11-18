// Offline import: OSM XML (openstreetmap.org Export, JOSM, osmium) or Overpass JSON a player saved themselves.
// No DOM needed, so it runs in the map worker and in Node.
export const FILE_LIMIT_BYTES = 150 * 1024 * 1024;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = s => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
  return ENT[e] ?? m;
}));
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function attrs(s) {
  const o = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(s))) o[m[1]] = unesc(m[2] !== undefined ? m[2] : m[3]);
  return o;
}

export function parseOsmXml(text) {
  const elements = [];
  let bounds = null, cur = null;
  const TAG = /<(\/?)(node|way|relation|tag|nd|member|bounds|osm|remark)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = TAG.exec(text))) {
    const [, close, name, body, selfClose] = m;
    if (close) { if (cur && name === cur.type) cur = null; continue; }
    if (name === 'node' || name === 'way' || name === 'relation') {
      const a = attrs(body);
      const skip = a.visible === 'false' || a.action === 'delete';
      const e = { type: name, id: +a.id };
      if (name === 'node') { e.lat = +a.lat; e.lon = +a.lon; }
      if (name === 'way') e.nodes = [];
      if (name === 'relation') e.members = [];
      if (!skip && Number.isFinite(e.id)) elements.push(e);
      cur = selfClose ? null : (skip ? { type: name, dead: true } : e);
    } else if (!cur || cur.dead) {
      if (name === 'bounds') {
        const a = attrs(body);
        const b = { s: +a.minlat, w: +a.minlon, n: +a.maxlat, e: +a.maxlon };
        if ([b.s, b.w, b.n, b.e].every(Number.isFinite)) bounds = b;
      }
    } else if (name === 'tag') {
      const a = attrs(body);
      if (a.k != null) (cur.tags ||= {})[a.k] = a.v ?? '';
    } else if (name === 'nd' && cur.nodes) {
      const r = +attrs(body).ref;
      if (Number.isFinite(r)) cur.nodes.push(r);
    } else if (name === 'member' && cur.members) {
      const a = attrs(body);
      if (a.type && Number.isFinite(+a.ref)) cur.members.push({ type: a.type, ref: +a.ref, role: a.role || '' });
    }
  }
  return { elements, bounds };
}

// Box from the data itself when the file carries none (1st..99th percentile, so stray far nodes don't count).
function dataBounds(elements) {
  const la = [], lo = [];
  for (const e of elements) {
    if (e.type === 'node' && Number.isFinite(e.lat)) { la.push(e.lat); lo.push(e.lon); }
    else if (Array.isArray(e.geometry)) for (const g of e.geometry) if (g) { la.push(g.lat); lo.push(g.lon); }
  }
  if (!la.length) return null;
  la.sort((a, b) => a - b); lo.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  return { s: q(la, 0.01), n: q(la, 0.99), w: q(lo, 0.01), e: q(lo, 0.99) };
}

// -> { elements, bounds, format }
export function parseOsmText(text) {
  const t = String(text || '');
  const head = t.slice(0, 2000).trimStart();
  if (!head) throw new Error('The file is empty');
  if (head[0] === '<') {
    if (!/<osm[\s>]/.test(head) && !/<node\b/.test(t.slice(0, 20000))) throw new Error('This XML file is not OpenStreetMap data');
    const r = parseOsmXml(t);
    if (!r.elements.length) throw new Error('No map features in this file');
    return { ...r, bounds: r.bounds || dataBounds(r.elements), format: 'osm-xml' };
  }
  if (head[0] === '{' || head[0] === '[') {
    let j;
    try { j = JSON.parse(t); } catch (e) { throw new Error('The file is not valid JSON'); }
    if (j && j.format === 'rcmap') throw new Error('This is a Remain Calm map file. Open it from the Library instead.');
    if (j && j.type === 'FeatureCollection') throw new Error('GeoJSON is not supported. Export OSM XML or Overpass JSON instead.');
    const elements = Array.isArray(j) ? j : j && Array.isArray(j.elements) ? j.elements : null;
    if (!elements) throw new Error('This JSON file has no OpenStreetMap elements');
    if (!elements.length) throw new Error('No map features in this file');
    let bounds = null;
    if (j.bounds && Number.isFinite(+j.bounds.minlat)) bounds = { s: +j.bounds.minlat, w: +j.bounds.minlon, n: +j.bounds.maxlat, e: +j.bounds.maxlon };
    return { elements, bounds: bounds || dataBounds(elements), format: 'overpass-json', osm3s: j.osm3s || null };
  }
  throw new Error('Unknown file type. Use an .osm file from openstreetmap.org Export or Overpass JSON.');
}

export async function readOsmFile(file) {
  if (!file) throw new Error('No file chosen');
  if (typeof file === 'string') return parseOsmText(file);
  if (file.size > FILE_LIMIT_BYTES) throw new Error(`The file is too large (limit ${Math.round(FILE_LIMIT_BYTES / 1048576)} MB)`);
  if (/\.(gz|bz2|pbf|zip)$/i.test(file.name || '')) throw new Error('Compressed or .pbf files are not supported. Unpack it to .osm first.');
  return parseOsmText(await file.text());
}
