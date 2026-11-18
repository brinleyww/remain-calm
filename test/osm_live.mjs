// node test/osm_live.mjs [--only=N] [--save=dir] — LIVE smoke test against Nominatim and the public Overpass
// mirrors (not part of test/all.mjs). Imports three real places of different kinds, prints timings and stats.
// Keep it rare: each run sends 3 searches and about 6 Overpass requests.
import fs from 'node:fs';
import path from 'node:path';
import { searchPlaces, importPlace, mirrorHealth } from '../js/map/osm.js';
import { validateMap } from '../js/map/format.js';

const UA = 'remain-calm-dev-check/0.2';
const fetchUA = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'User-Agent': UA } });
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const PLACES = [
  { q: 'Annapolis, Maryland', kind: 'coastal town', size: 1.5 },
  { q: 'The Loop, Chicago', kind: 'dense downtown', size: 2 },
  { q: 'Széchenyi Chain Bridge, Budapest', kind: 'river city', size: 3 },
];

const list = args.only ? [PLACES[+args.only]] : PLACES;
let bad = 0;
for (const p of list) {
  const t0 = performance.now();
  let hits;
  try { hits = await searchPlaces(p.q, { fetchImpl: fetchUA }); } catch (e) { console.log(`${p.q}: search failed: ${e.message}`); bad++; continue; }
  const tSearch = performance.now() - t0;
  if (!hits.length) { console.log(`${p.q}: no search result`); bad++; continue; }
  const r = hits[0];
  const events = [];
  const t1 = performance.now();
  try {
    const res = await importPlace({
      lat: r.lat, lon: r.lon, sizeKm: p.size, name: r.name, stages: 5, fetchImpl: fetchUA,
      onProgress: (e) => { if (['retry', 'slow', 'wait', 'backoff', 'tile'].includes(e.phase)) events.push(`${((performance.now() - t1) / 1000).toFixed(1)}s ${e.phase}${e.endpoint ? ' ' + new URL(e.endpoint).host : ''}${e.error ? ' (' + e.error + ')' : ''}`); },
    });
    const s = res.stats, i = res.info;
    console.log(`\n${p.kind}: ${p.q} -> ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · ${p.size} km`);
    console.log(`  search ${(tSearch / 1000).toFixed(1)} s · fetch ${(i.fetchMs / 1000).toFixed(1)} s (${i.tiles} part${i.tiles > 1 ? 's' : ''}, ${(i.bytes / 1e6).toFixed(1)} MB, ${i.elements} elements, via ${(i.mirrors || []).join(', ')}) · convert ${(i.convertMs / 1000).toFixed(2)} s`);
    console.log(`  buildings ${s.buildings} · roads ${s.roads} · bridges ${s.bridges} · water ${s.waterKm2.toFixed(2)} km2 · parks ${s.parkKm2.toFixed(2)} km2 · residents ${s.nominalPop} · specials ${JSON.stringify(s.specials)} · valid ${validateMap(res.map).ok}`);
    if (res.warnings.length) console.log('  warnings: ' + res.warnings.join(' | '));
    if (events.length) console.log('  events: ' + events.join('; '));
    if (args.save) {
      fs.mkdirSync(args.save, { recursive: true });
      fs.writeFileSync(path.join(args.save, p.kind.replace(/\W+/g, '_') + '.rcmap.json'), JSON.stringify(res.map));
    }
  } catch (e) {
    bad++;
    console.log(`\n${p.kind}: ${p.q}: FAILED after ${((performance.now() - t1) / 1000).toFixed(1)} s: ${e.message}`);
    if (events.length) console.log('  events: ' + events.join('; '));
  }
}
console.log('\nmirror health:');
for (const m of mirrorHealth()) console.log(`  ${new URL(m.url).host}: ok ${m.ok || 0}, failed ${m.fail || 0}${m.why ? ' (last: ' + m.why + ')' : ''}`);
process.exit(bad ? 1 : 0);
