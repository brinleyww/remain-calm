// Module worker: city generation and real-place import off the main thread.
import { generateCity } from '../map/citygen.js';
import { getCampaignMap } from '../map/campaign.js';
import { importPlace } from '../map/osm.js';

const aborts = new Map();

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  if (op === 'abort') { const c = aborts.get(args && args.target); if (c) c.abort(); return; }
  try {
    let out;
    if (op === 'city') out = { map: generateCity(args) };
    else if (op === 'campaign') out = { map: getCampaignMap(args.id) };
    else if (op === 'import') {
      const ctl = new AbortController();
      aborts.set(id, ctl);
      try {
        out = await importPlace({ ...args, signal: ctl.signal, onProgress: p => self.postMessage({ id, progress: p }) });
      } finally { aborts.delete(id); }
    } else throw new Error('Unknown job ' + op);
    self.postMessage({ id, ok: true, ...out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
