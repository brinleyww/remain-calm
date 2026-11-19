// REMAIN CALM — single source of truth for balance and content numbers.
// Units: meters, seconds, dollars ($), SP = command points. Zombie HP scale: 1..30.
// Everything here can be overridden by mutators ("mods"): text lines "path.to.key=value"; later lines win.

export const DEFAULTS = {
  // baseSpeed: sim seconds per real second at the 1x speed step (the steps 0.5x..8x multiply it).
  sim: { dt: 0.05, cell: 4, coarse: 8, hashCell: 8, maxAgents: 250000, civFieldEvery: 1.0, scentEvery: 1.0, baseSpeed: 2 },

  // Nominal population (drives economy) = building footprint m2 * perM2 * kindMul.
  // Spawned civilians = nominal * scale (performance setting), capped by sim.maxAgents.
  // At scale 1 homes, shops and offices hold the reference 0.02 people per m2 of footprint.
  // Sheets larger than autoCapKm2 whose whole-map nominal exceeds autoCap spawn every stage at scale * autoCap / nominal.
  population: { perM2: 0.02, scale: 1.0, kindMul: { res: 1, com: 1, ind: 0.5, civic: 0.8, trade: 0.9, armory: 0.5, rescue: 0.8, hazard: 0.2, landmark: 0.8 }, packSize: [2, 10], packSpread: 6,
                autoCap: 120000, autoCapKm2: 25 },

  civ: { walk: 1.3, run: 2.0, panicRadius: 30, panicSpreadRadius: 14, panicSpreadChance: 0.3, panicSpreadMin: 0.8, panicThreshold: 0.5, calmDecayPerSec: 0.02,
         gateLureRadius: 350, broadcastRadius: 600, wander: 1.0, seekMaxPath: 8000, separation: 0.9,
         // movement: gateLureRadius is a path distance; dangerCost per zombie (8 m cell, capped) and gate queues bend the civilian field
         lureWalk: 1.35, awareRadius: 50, dangerCost: 8, dangerMax: 30, gateQueuePer: 8, gateQueueMax: 12, gateQueueRadius: 16, fieldEvery: 6 },

  zombie: { speed: 3.4, sight: 45, touchRadius: 3, hpStart: 1, hpGraceSec: 60, hpPerMin: 3, hpMax: 30,
            wallDps: 18, retargetSec: 0.5, swimSpeedMul: 0.5, turnSec: [2, 5], separation: 0.7, softlockSec: 60,
            attackSec: 1, armedDmg: 1 },

  scent: { wallCost: 6, gateCost: 4, rubbleCost: 2, parkCost: 1, waterCostSwimmer: 2 },

  outbreak: { perKm2: 2.15, minSites: 1, maxSites: 9, radius: 105, zombies: 70, zombiesPerLevel: 14, zombieScaleWithPop: true,
              minDistFromZone: 120, secondaryChancePerLevel: 0.12, secondaryAfterSec: [90, 200],
              edgeWaves: 0, edgeWaveEvery: 60, edgeWaveZombies: 21, edgeWaveCount: 5 },

  mutation: { firstSec: 70, intervalSec: [45, 80], pitRadius: 30, pitSec: 20, pitMin: 10, pitAttract: 120,
    kinds: {
      explosive: { weight: 1, hpMul: 2, blastRadius: 30, blastDmg: 25, wallDmg: 600, color: 'explosive' },
      shielded:  { weight: 1, hpMul: 1, shield: 60 },
      swimmer:   { weight: 1, hpMul: 1.5 },
      giant:     { weight: 1, merge: 10, hpMul: 9, wallDpsMul: 6, size: 3 },
    } },

  zone: { baseCost: 100, freeZones: 4, maxZones: 8, maxLandFrac: 0.30, minCorners: 3, bldgInsideFrac: 0.5, bigBldgArea: 2000, bigBldgInsideFrac: 1.0,
          outsideCostMul: 1.5, outsideStartDelay: 12 },
  wall: { baseCost: 25, perM: 0.75, hp: 1200, standaloneMaxM: 300, standalonePerLevelM: 100, levelHpMul: [1, 2, 3], levelCost: [0, 150, 400], thick: 1.0 },
  gate: { cost: 50, width: 12, hp: 900 },
  corridor: { baseCost: 30, perM2: 0.0045, minWidth: 8, maxWidth: 120, defaultWidth: 30 },
  hold: { baseCost: 20, perM2: 0.002, innerFrac: 0.35, minR: 15, maxR: 250 },

  economy: { // budget cap for a level from its nominal population C
    moneyBase: 1500, moneyMax: 26000, moneyHalf: 60000, // cap = base + max*C/(C+half)
    spBase: 2, spPerLevel: 2, spPerSqrt10k: 2,          // sp = base + perLevel*levelIdx + perSqrt10k*floor(sqrt(C/10000))
    planningRefund: 1.0, battleRefund: 0.0, sandboxMoney: 1e9, sandboxSP: 999 },

  // Badges by % of the level's civilians saved. idx = 0-based stage index.
  badges: [
    { id: 'bronze', min: () => 4 },
    { id: 'silver', min: idx => Math.min(15, 8 + 1.2 * idx) },
    { id: 'gold', min: idx => 17 + 2.7 * idx },
    { id: 'sapphire', min: () => 30, minPop: 10000 },
    { id: 'emerald', min: () => 35, minPop: 10000 },
    { id: 'ruby', min: () => 40, minPop: 10000 },
    { id: 'diamond', min: () => 45, minPop: 25000 },
  ],
  loseBelowPct: 4,

  difficulty: {
    normal:   { zombieHpMul: 1,   outbreakMul: 1,   moneyMul: 1,    spMul: 1 },
    hardcore: { zombieHpMul: 1.5, outbreakMul: 1.3, moneyMul: 0.85, spMul: 0.85 },
    ultra:    { zombieHpMul: 2,   outbreakMul: 1.6, moneyMul: 0.7,  spMul: 0.7 },
  },

  fire: { spreadChance: 0.08, burnSec: 25, dps: 6, buildingDps: 30, wallDps: 20, grassMul: 1.6 },
  building: { hpBase: 200, hpPerM2: 1.5, hpPerM: 8, collapseFireChance: 0.5, toppleRange: 1.0, dominoChance: 0.4 },
  hazard: { radius: 40, dmg: 150, bldgDmg: 900, bridgeDmg: 600, wallDmg: 600, fire: 1 }, // hazard buildings explode when destroyed
  bridge: { hpPerM: 2, hpPerWidthM: 15, hpMin: 100, hpMax: 2500, explosiveMul: 2 },
  // Multi-level roads: deck pieces (at most 300 m) get bridge hit points x hpMul; a blast smaller than bigBlastR
  // hits only the tier it goes off on, a bigger one the ground and every deck (tunnels only from inside, or a nuke).
  decks: { hpMul: 1.5, bigBlastR: 24 },
  friendlyFire: { auto: false, autoStructureMul: 0.25 }, // automatic weapons never hurt humans; aimed abilities do

  // ---------------- player items bought with money ----------------
  // mount: 'building' (one per building) | 'ground' (open/road cell) | 'water' (water body) | 'brush' (painted per cell) | 'line' (drawn line)
  // range/dmg/etc are level-1 values. ups: the 4 upgrades (levels 2..5), each raises one stat. Upgrade cost = cost * 1.5^(level-1) (level being bought).
  units: {
    garrison:   { mount: 'building', cost: b => Math.min(225, 15 + 2.25 * b.h), dmg: 5, rof: 0.25, mag: 180, reloads: 10, reloadSec: 6,
                  range: b => Math.min(262.5, 30 + 2.625 * b.h), accuracy: 0.8, paint: true,
                  ups: [['range', 1.2], ['dmg', 1.5], ['reloads', 1.5], ['rof', 1.3]] },
    sniper:     { mount: 'building', cost: 50, dmg: 80, rof: 2.5, mag: 5, reloads: 20, reloadSec: 4, range: b => Math.min(1400, 400 + 4.7 * b.h),
                  accuracy: 0.95, priority: 'mutant', paint: true, ups: [['range', 1.2], ['dmg', 1.5], ['rof', 1.3], ['reloads', 1.5]] },
    turret:     { mount: 'ground', cost: 90, dmg: 4, rof: 0.08, mag: 1000, reloads: 0, reloadSec: 0, range: 75, hp: 600, accuracy: 0.7, noZoneReload: true,
                  ups: [['mag', 3], ['range', 1.25], ['dmg', 1.5], ['hp', 2]] },
    mortar:     { mount: 'building', cost: (w, n) => 75 + n, dmg: 40, splash: 12, minRange: 160, range: 600, rof: 3, mag: 6, reloads: 8, reloadSec: 10,
                  shellSpeed: 120, paint: true, ups: [['splash', 1.3], ['dmg', 1.5], ['rof', 1.3], ['range', 1.25]] },
    gasMortar:  { mount: 'building', cost: 90, dmg: 2, splash: 18, stunSec: 6, minRange: 160, range: 600, rof: 4, mag: 6, reloads: 8, reloadSec: 10,
                  shellSpeed: 120, paint: true, ups: [['splash', 1.3], ['stunSec', 1.4], ['rof', 1.3], ['range', 1.25]] },
    fireMortar: { mount: 'building', cost: 120, dmg: 6, splash: 14, fire: 1, minRange: 160, range: 600, rof: 5, mag: 4, reloads: 8, reloadSec: 12,
                  shellSpeed: 120, paint: true, ups: [['splash', 1.3], ['dmg', 1.5], ['rof', 1.3], ['range', 1.25]] },
    mlrs:       { mount: 'ground', cost: 200, dmg: 30, splash: 14, rockets: 12, spread: 50, range: 900, minRange: 120, rof: 60, mag: 1, reloads: 6, reloadSec: 0, minCluster: 3,
                  shellSpeed: 220, hp: 800, ups: [['rockets', 1.5], ['dmg', 1.5], ['rof', 0.75], ['range', 1.3]] },
    howitzer:   { mount: 'ground', cost: (w, n) => 400 + 200 * n, dmg: 60, splash: 20, range: 6500, minRange: 200, rof: 6, mag: 4, reloads: 10, reloadSec: 15, minCluster: 3,
                  shellSpeed: 400, bldgDmg: 40, hp: 1000, ups: [['dmg', 1.5], ['splash', 1.3], ['rof', 1.3], ['reloads', 1.5]] },
    battleship: { mount: 'water', minWaterM2: 20000, cost: (w, n) => 750 + 550 * n, dmg: 10, splash: 18, shells: 6, range: 1400, rof: 4, mag: Infinity, reloads: Infinity, minCluster: 3,
                  shellSpeed: 300, bldgDmg: 30, unlimited: true, ups: [['shells', 1.5], ['dmg', 1.5], ['range', 1.25], ['rof', 1.3]] },
    railgun:    { mount: 'ground', cost: 600, dmg: 60, width: 3, range: 900, rof: 8, mag: 1, reloads: 12, reloadSec: 0, hp: 800,
                  ups: [['dmg', 1.5], ['range', 1.25], ['rof', 1.3], ['reloads', 1.5]] },
    mine:       { mount: 'brush', cost: 15, dmg: 40, splash: 6, trigger: 3, ups: [] },
    chemical:   { mount: 'brush', cost: 10, stunSec: 8, splash: 10, trigger: 3, ups: [] },
    napalm:     { mount: 'ground', cost: 100, trigger: 8, fireRadius: 25, dmg: 10, ups: [] },
    c4:         { mount: 'building|bridge', cost: 500, dmg: 200, splash: 30, bldgDmg: 99999, bridgeDmg: 5000, manual: true, friendly: true, ups: [] },
    spikes:     { mount: 'line', cost: 2, perM: true, slow: 0.4, durability: 400, ups: [] },   // $2 per meter
    oil:        { mount: 'line', cost: 2, perM: true, burnSec: 30, autoIgnite: 5, ups: [] },    // $2 per meter
    // Boats (boat: true) sail the stage's connected body of water they are placed on, under bridges; minWaterM2 is that
    // body's area inside the stage. hull = boat HP (swimmers tear at it), size = [length, beam] m, patrolR = patrol
    // radius around the mooring. Water is never inside a zone, so boats pay the outside price.
    patrolBoat: { mount: 'water', boat: true, minWaterM2: 3000, cost: (w, n) => 100 + 20 * n, hull: 700, speed: 9, size: [14, 4], patrolR: 140,
                  dmg: 5, rof: 0.12, range: 90, accuracy: 0.75, ups: [['range', 1.2], ['dmg', 1.5], ['hull', 1.5], ['rof', 1.3]] },
    gunboat:    { mount: 'water', boat: true, minWaterM2: 8000, cost: (w, n) => 300 + 100 * n, hull: 2000, speed: 5, size: [22, 6], patrolR: 110,
                  dmg: 45, splash: 10, rof: 3, range: 240, minRange: 25, shellSpeed: 260, mgDmg: 5, mgRof: 0.15, mgRange: 70, accuracy: 0.75,
                  ups: [['dmg', 1.5], ['range', 1.25], ['hull', 1.5], ['rof', 1.3]] },
    rocketBarge:{ mount: 'water', boat: true, minWaterM2: 15000, cost: (w, n) => 280 + 120 * n, hull: 1500, speed: 3, size: [26, 9], patrolR: 50,
                  dmg: 28, splash: 12, rockets: 10, spread: 45, range: 850, minRange: 120, rof: 45, shellSpeed: 220, minCluster: 3,
                  ups: [['rockets', 1.5], ['dmg', 1.5], ['rof', 0.75], ['range', 1.3]] },
    ferry:      { mount: 'water', boat: true, minWaterM2: 6000, cost: (w, n) => 200 + 100 * n, hull: 1200, speed: 7, size: [28, 9],
                  capacity: 60, loadPerSec: 6, loadRadius: 22, searchR: 600, unloadSec: 4,
                  ups: [['capacity', 1.5], ['speed', 1.25], ['hull', 1.5], ['capacity', 1.5]] },
    waterMine:  { mount: 'brush', water: true, cost: 12, dmg: 60, splash: 8, trigger: 4, ups: [] },   // painted on water cells
  },

  // ---------------- abilities bought with SP (charges) ----------------
  // sp: cost per charge; unlock: seconds after READY before usable; delay: seconds from call to effect.
  // target: 'point' | 'circle' (drag radius) | 'line' (drag direction) | 'building' | 'garrison' | 'bridge|building'
  abilities: {
    paratroopers: { sp: 1, unlock: 0,  delay: 10, target: 'point', squad: 20, soldier: { hp: 3, dmg: 6, range: 35, rof: 0.6, ammo: 150 } },
    callToArms:   { sp: 1, unlock: 0,  delay: 0,  target: 'circle', maxR: 160, max: 150 },
    seekDestroy:  { sp: 2, unlock: 10, delay: 0,  target: 'garrison', perAmmo: 30, min: 5, max: 25 },
    apc:          { sp: 3, unlock: 15, delay: 8,  target: 'point', hp: 2500, dmg: 6, rof: 0.12, range: 60, speed: 9, leash: 250 },
    bus:          { sp: 3, unlock: 15, delay: 0,  target: 'point', hp: 1500, capacity: 400, loadPerSec: 12, loadRadius: 25, speed: 10 },
    medevac:      { sp: 3, unlock: 20, delay: 0,  target: 'point', capacity: 200, loadPerSec: 15, loadRadius: 30, speed: 40 },
    bulldozer:    { sp: 3, unlock: 20, delay: 5,  target: 'line', hp: 4000, crushDps: 30, speed: 4, width: 8 },
    rally:        { sp: 1, unlock: 20, delay: 0,  target: 'point', radius: 300, sec: 30 },
    demolition:   { sp: 2, unlock: 20, delay: 3,  target: 'building' },
    fireBomb:     { sp: 1, unlock: 30, delay: 4,  target: 'point', radius: 40, dmg: 20 },
    cruise:       { sp: 2, unlock: 30, delay: 6,  target: 'point', dmg: 300, splash: 35, bldgDmg: 1500, bridgeDmg: 1500 },
    helicopter:   { sp: 2, unlock: 30, delay: 6,  target: 'point', dmg: 8, rof: 0.1, range: 80, ammo: 600, speed: 35, huntRadius: 400, rearmSec: 30 },
    gasBomb:      { sp: 1, unlock: 30, delay: 4,  target: 'point', radius: 60, stunSec: 10 },
    tank:         { sp: 4, unlock: 30, delay: 8,  target: 'point', hp: 6000, dmg: 50, splash: 10, rof: 3, range: 150, mgDmg: 6, mgRof: 0.15, mgRange: 60, speed: 7, crushDps: 40 },
    airstrike:    { sp: 2, unlock: 45, delay: 5,  target: 'line', bombs: 6, dmg: 200, splash: 25, length: 240, bldgDmg: 600, bridgeDmg: 600 },
    clusterBomb:  { sp: 2, unlock: 45, delay: 5,  target: 'point', bomblets: 72, dmg: 40, splash: 6, radius: 60 },
    gunship:      { sp: 3, unlock: 45, delay: 6,  target: 'point', orbitR: 250, sec: 60, bigDmg: 120, bigSplash: 14, bigRof: 2, smallDmg: 30, smallSplash: 6, smallRof: 0.5 },
    cure:         { sp: 5, unlock: 45, delay: 3,  target: 'circle', maxR: 120 },
    nuke:         { sp: 15, unlock: 90, delay: 45, target: 'point', radius: 1980, coreFrac: 0.35 },
  },

  // ---------------- special buildings ----------------
  // A function can only be assigned while the building counts as inside a safe zone.
  specials: {
    civic:  { label: 'Civic',   functions: ['police', 'militia', 'broadcast', 'radio'] },
    trade:  { label: 'Commerce', functions: ['budget', 'reducedCost', 'repair'] },
    armory: { label: 'Arsenal', functions: ['supply', 'commandPost'] },
    rescue: { label: 'Relief',  functions: ['medic', 'airlift'] },
  },
  functions: {
    police:      { every: 2, max: 100, officer: { hp: 3, dmg: 5, range: 30, rof: 0.7 } }, // stance: 'pursue' | 'hold'; not replaced
    militia:     { convertFrac: 0.35, radius: 200, fighter: { hp: 2, dmg: 4, range: 22, rof: 0.9, ammo: 60 } },
    broadcast:   { radius: 600 },
    radio:       { radius: 250, rangeMul: 1.5 },
    budget:      { costMul: 0.8 },            // units placed inside this zone cost 20% less
    reducedCost: { radius: 47, costMul: 0.4 },// units placed within 47 m cost 60% less
    repair:      { wallHpPerSec: 40 },
    supply:      { radius: 250, reloadMul: 0.5, turretRestock: true },
    commandPost: { radius: 250, rofMul: 1.3 },
    medic:       { radius: 80, cureTurning: true, healPerSec: 0.2 },
    airlift:     { every: 20, count: 5 },
  },

  armed: { pursueLeash: 300, sight: 90, speed: 3.0, accuracy: 0.8 },

  // How guns share out targets. A shooter's expected damage on a zombie counts as a claim for claimSec, so others pick
  // someone else. Threat = 1 + threatMul * threatDist / (threatDist + metres of zombie path to the nearest person).
  // Candidates: nearest zombies weighed per direct-fire scan (armed people: armedCand), blocks refined per artillery shot.
  // Unit key minCluster: heavy guns skip groups smaller than this while a bigger one is in range.
  targeting: { claimSec: 0.5, threatMul: 3, threatDist: 40, directCand: 24, armedCand: 10, artyCand: 5 },

  // Campaign unlock schedule: item ids unlocked when the given campaign stage is cleared (bronze+).
  // Free Play / Sandbox use everything that is unlocked (Sandbox: everything).
  startUnlocked: ['garrison', 'turret', 'mortar', 'sniper', 'paratroopers', 'callToArms', 'airstrike', 'fireBomb', 'patrolBoat', 'waterMine'],
  loadoutSlots: 7,
};

// ---------------- mutators ("mods") ----------------
// Each preset is a list of override lines. Users can write their own in the Mutator editor.
export const MUTATOR_PRESETS = {
  sprinters:   { name: 'Sprinters', desc: 'Zombies run 40% faster.', lines: ['zombie.speed=4.76'] },
  ironHide:    { name: 'Iron Hide', desc: 'Zombie HP doubles.', lines: ['zombie.hpMax=60', 'zombie.hpPerMin=6', 'zombie.hpStart=2'] },
  tide:        { name: 'Tide', desc: 'Mutations favour swimmers and come early.', lines: ['mutation.kinds.swimmer.weight=6', 'mutation.firstSec=30'] },
  austerity:   { name: 'Austerity', desc: 'Budget cut by 40%.', lines: ['economy.moneyMax=15600', 'economy.moneyBase=900'] },
  doubleTrouble:{ name: 'Double Trouble', desc: 'Twice the outbreak sites.', lines: ['outbreak.perKm2=4.3', 'outbreak.maxSites=18'] },
  rapidMutation:{ name: 'Rapid Mutation', desc: 'Mosh pits every 15-25 s.', lines: ['mutation.firstSec=20', 'mutation.intervalSec=[15,25]'] },
  glassCity:   { name: 'Glass City', desc: 'Buildings and bridges are fragile.', lines: ['building.hpPerM2=0.5', 'bridge.hpMax=800'] },
  brassRain:   { name: 'Brass Rain', desc: 'Double command points.', lines: ['economy.spPerLevel=4', 'economy.spPerSqrt10k=4'] },
  crowded:     { name: 'Crowded', desc: 'Half again as many civilians.', lines: ['population.perM2=0.03'] },
  edgeWaves:   { name: 'Edge Waves', desc: 'Extra hordes walk in from the map edge.', lines: ['outbreak.edgeWaves=1'] },
  thinWalls:   { name: 'Thin Walls', desc: 'Walls have a third of their HP.', lines: ['wall.hp=400'] },
  noAirSupport:{ name: 'Grounded', desc: 'No helicopters, gunships or airstrikes.', lines: ['abilities.helicopter.sp=999', 'abilities.gunship.sp=999', 'abilities.airstrike.sp=999'] },
};

function deepClone(o) {
  if (typeof o === 'function' || o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const r = {};
  for (const k in o) r[k] = deepClone(o[k]);
  return r;
}

function parseValue(v) {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'Infinity') return Infinity;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v)) return parseFloat(v);
  if (v.startsWith('[') || v.startsWith('{')) { try { return JSON.parse(v); } catch (e) { /* fallthrough */ } }
  return v.replace(/^"(.*)"$/, '$1');
}

// Parse "a.b.c=value" lines (blank lines and lines starting with # or // ignored).
export function parseOverrides(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out.push([line.slice(0, eq).trim(), parseValue(line.slice(eq + 1))]);
  }
  return out;
}

// Build a config: DEFAULTS + difficulty + override lines (strings or [path,value] pairs). Later lines win.
export function makeConfig(lines = [], opts = {}) {
  const c = deepClone(DEFAULTS);
  const pairs = [];
  for (const l of lines) {
    if (Array.isArray(l)) pairs.push(l);
    else pairs.push(...parseOverrides(l));
  }
  for (const [path, value] of pairs) {
    const keys = path.split('.');
    let o = c;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] === undefined || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  c.diff = c.difficulty[opts.difficulty || 'normal'] || c.difficulty.normal;
  c.sandbox = !!opts.sandbox;
  return c;
}

// Resolve a stat that may be a number or a function (of building / world,count).
export function stat(v, ...args) { return typeof v === 'function' ? v(...args) : v; }
