// Map jobs for the shell: generation / campaign cities / real-place import in a worker, main thread as fallback.
import { generateCity } from '../map/citygen.js';
import { getCampaignMap, CAMPAIGN } from '../map/campaign.js';
import { importPlace } from '../map/osm.js';
import { hashStr } from '../util/rng.js';

let worker = null, workerBroken = false, seq = 1;
const jobs = new Map();

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('./gen_worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data, job = jobs.get(m.id);
      if (!job) return;
      if (m.progress) { if (job.onProgress) job.onProgress(m.progress); return; }
      jobs.delete(m.id);
      if (m.ok) job.resolve(m); else job.reject(new Error(m.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      workerBroken = true;
      worker.terminate();
      worker = null;
      for (const [, job] of jobs) job.fallback();
      jobs.clear();
    };
  } catch (e) { workerBroken = true; worker = null; }
  return worker;
}

const yieldFrame = () => new Promise(r => setTimeout(r, 16));

async function onMain(op, args, onProgress, signal) {
  await yieldFrame();
  if (op === 'city') return { map: generateCity(args) };
  if (op === 'campaign') return { map: getCampaignMap(args.id) };
  if (op === 'import') return importPlace({ ...args, onProgress, signal });
  throw new Error('Unknown job ' + op);
}

function run(op, args, { onProgress, signal } = {}) {
  const w = getWorker();
  if (!w) return onMain(op, args, onProgress, signal);
  return new Promise((resolve, reject) => {
    const id = seq++;
    const job = { resolve, reject, onProgress, fallback: () => onMain(op, args, onProgress, signal).then(resolve, reject) };
    jobs.set(id, job);
    if (signal) signal.addEventListener('abort', () => {
      if (!jobs.has(id)) return;
      w.postMessage({ op: 'abort', args: { target: id } });
      if (op !== 'import') { jobs.delete(id); reject(new Error('Cancelled')); }
    }, { once: true });
    w.postMessage({ id, op, args });
  });
}

// Latest-wins generator: while a job runs, only the newest pending request is kept.
let genBusy = false, genNext = null;
export function generate(opts) {
  return new Promise((resolve, reject) => {
    if (genNext) genNext.reject(Object.assign(new Error('superseded'), { superseded: true }));
    genNext = { opts, resolve, reject };
    pump();
  });
}
async function pump() {
  if (genBusy || !genNext) return;
  const job = genNext;
  genNext = null;
  genBusy = true;
  try { job.resolve((await run('city', job.opts)).map); } catch (e) { job.reject(e); }
  genBusy = false;
  pump();
}

const campaignMaps = new Map();
// Campaign maps generated in the worker, cached for the session (same seed -> same city as getCampaignMap).
export function campaignMap(id) {
  if (campaignMaps.has(id)) return campaignMaps.get(id);
  const p = run('campaign', { id }).then(r => r.map);
  campaignMaps.set(id, p);
  p.catch(() => campaignMaps.delete(id));
  return p;
}
export function campaignMapReady(id) { return campaignMaps.get(id) || null; }
export function prefetchCampaign() { for (const c of CAMPAIGN) campaignMap(c.id); }

export function importArea(args, { onProgress, signal } = {}) { return run('import', args, { onProgress, signal }); }

// ------------------------------------------------------------ daily challenge

export function todayKey(d = new Date()) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
export function dateFromKey(k) { return new Date(Math.floor(k / 10000), Math.floor(k / 100) % 100 - 1, k % 100); }

const WATER = ['river', 'coast', 'lake', 'islands', 'none', 'river', 'coast'];
// Deterministic city options + two mutators for a date key (YYYYMMDD).
export function dailySpec(key, presets) {
  let s = hashStr('daily:' + key);
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (s >>> 8) / 16777216; };
  const water = WATER[Math.floor(rnd() * WATER.length)];
  const opts = {
    seed: hashStr('daily-city:' + key),
    sizeKm: Math.round((1.4 + rnd() * 1.6) * 10) / 10,
    water,
    density: Math.round((0.45 + rnd() * 0.4) * 100) / 100,
    bridges: water === 'none' ? 0 : 1 + Math.floor(rnd() * 4),
    stages: 4 + Math.floor(rnd() * 2),
  };
  const ids = Object.keys(presets);
  const a = ids[Math.floor(rnd() * ids.length)];
  let b = a;
  while (b === a) b = ids[Math.floor(rnd() * ids.length)];
  return { key, opts, mutators: [a, b] };
}
