// Campaign: six fictional cities (generated from fixed seeds) and the unlock schedule.
// unlocks[k] lists the item ids granted when stage k of that city is cleared (bronze or better).
// Item ids are config unit / ability keys, plus 'upgrade3' | 'upgrade4' | 'upgrade5' for upgrade tiers.
import { generateCity } from './citygen.js';
import { DEFAULTS } from '../data/config.js';

export const UPGRADE_TIERS = { 3: 'upgrade3', 4: 'upgrade4', 5: 'upgrade5' };
export const UNLOCK_LABELS = { upgrade3: 'Upgrade tier III', upgrade4: 'Upgrade tier IV', upgrade5: 'Upgrade tier V' };
export const upgradeTierId = level => UPGRADE_TIERS[level] || null;

export const CAMPAIGN = [
  {
    id: 'millbrook', name: 'Millbrook',
    blurb: 'A market town on the River Lenne. The first calls came from the livestock auction.',
    welcome: 'Millbrook, 06:40. Reports of violent patients at the cattle market. Wall off the old square, open a gate, and keep the townsfolk calm.',
    gen: { seed: 410731, sizeKm: 1.2, water: 'river', density: 0.45, bridges: 2, stages: 4 },
    unlocks: [['spikes'], ['mine'], ['rally'], ['upgrade3']],
  },
  {
    id: 'port-ashby', name: 'Port Ashby',
    blurb: 'A fishing harbour turned ferry port. Half the town is on the quayside tonight.',
    welcome: 'Port Ashby. The evening ferry docked with sick passengers aboard. The sea guards one flank; the estuary bridges are the weak points.',
    gen: { seed: 92817, sizeKm: 1.8, water: 'coast', density: 0.55, bridges: 2, stages: 5 },
    unlocks: [['gasMortar'], ['bus'], ['c4'], ['seekDestroy'], ['battleship']],
  },
  {
    id: 'carrowmere', name: 'Carrowmere',
    blurb: 'A lakeside resort, full to the rafters for the regatta weekend.',
    welcome: 'Carrowmere. Regatta crowds line the shore. Use the lake as a wall and get the visitors behind gates before the panic spreads.',
    gen: { seed: 557102, sizeKm: 2.2, water: 'lake', density: 0.55, bridges: 2, stages: 5 },
    unlocks: [['chemical'], ['apc'], ['demolition'], ['fireMortar'], ['gasBomb']],
  },
  {
    id: 'halden-cross', name: 'Halden Cross',
    blurb: 'A railway junction split by the Varrow. Its bridges are its lifelines.',
    welcome: 'Halden Cross. The outbreak follows the rail line. Every bridge is a door: hold the ones you need and drop the ones you do not.',
    gen: { seed: 731554, sizeKm: 2.8, water: 'river', density: 0.7, bridges: 5, stages: 6 },
    unlocks: [['oil'], ['medevac'], ['napalm'], ['helicopter'], ['mlrs'], ['upgrade4']],
  },
  {
    id: 'varra-isles', name: 'Varra Isles',
    blurb: 'An island capital tied together by causeways. The ferries have stopped running.',
    welcome: 'Varra Isles. Five islands, a handful of causeways and nowhere to run. Watch for swimmers once the hordes start to change.',
    gen: { seed: 264019, sizeKm: 3.4, water: 'islands', density: 0.65, bridges: 5, stages: 6 },
    unlocks: [['bulldozer'], ['cruise'], ['clusterBomb'], ['howitzer'], ['tank'], ['gunship']],
  },
  {
    id: 'new-corrigan', name: 'New Corrigan',
    blurb: 'A coastal metropolis whose towers can be seen for forty miles.',
    welcome: 'New Corrigan. The largest evacuation this office has ever planned. Every district you hold buys time for the next.',
    gen: { seed: 880433, sizeKm: 4.0, water: 'coast', density: 0.9, bridges: 4, stages: 7 },
    unlocks: [['railgun'], ['cure'], [], ['upgrade5'], [], ['nuke'], []],
  },
];
CAMPAIGN.forEach((c, i) => { c.index = i; c.stages = c.gen.stages; c.sizeKm = c.gen.sizeKm; c.water = c.gen.water; });

export const campaignMapKey = id => 'campaign:' + id;
export const getCampaignCity = id => CAMPAIGN.find(c => c.id === id) || null;
export const nextCity = id => { const c = getCampaignCity(id); return c ? CAMPAIGN[c.index + 1] || null : null; };

const cache = new Map();
export function getCampaignMap(id) {
  if (cache.has(id)) return cache.get(id);
  const c = getCampaignCity(id);
  if (!c) throw new Error('Unknown campaign city: ' + id);
  const map = generateCity({ ...c.gen, name: c.name });
  map.author = 'Office of Civil Preparedness';
  map.welcome = c.welcome;
  map.desc = c.blurb;
  cache.set(id, map);
  return map;
}

export function unlocksFor(cityId, stageIdx) {
  const c = getCampaignCity(cityId);
  return c && c.unlocks[stageIdx] ? c.unlocks[stageIdx].slice() : [];
}

// Where an item is unlocked: { cityId, cityName, stageIdx } | null (null = unlocked from the start or unknown).
export function unlockSource(itemId) {
  for (const c of CAMPAIGN) {
    const k = c.unlocks.findIndex(list => list.includes(itemId));
    if (k >= 0) return { cityId: c.id, cityName: c.name, stageIdx: k };
  }
  return null;
}

// Everything the campaign hands out, in order, plus the starting set.
export const START_UNLOCKED = DEFAULTS.startUnlocked.slice();
export const ALL_UNLOCKABLES = CAMPAIGN.flatMap(c => c.unlocks.flat());
export const ALL_ITEMS = [...START_UNLOCKED, ...ALL_UNLOCKABLES];

// Items unlocked by a set of cleared stages: cleared(cityId, stageIdx) -> bool.
export function unlockedItems(cleared) {
  const out = new Set(START_UNLOCKED);
  for (const c of CAMPAIGN) c.unlocks.forEach((list, k) => { if (cleared(c.id, k)) list.forEach(id => out.add(id)); });
  return out;
}
