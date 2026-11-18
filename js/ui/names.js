// Display names, short descriptions and stamped plan symbols for units and abilities.
// COMBAT's UNIT_INFO / ABILITY_INFO (when that module loads) take precedence over these.
import { DEFAULTS, stat } from '../data/config.js';
import { UNLOCK_LABELS, unlockSource } from '../map/campaign.js';

export const UNIT_TEXT = {
  garrison: ['Garrison', 'Riflemen posted in a building. Taller roofs see further and cost more.'],
  sniper: ['Marksman', 'Long rifle on a rooftop. Takes mutants first.'],
  turret: ['Sentry Gun', 'Automatic gun at street level. Never reloads without a supply depot nearby.'],
  mortar: ['Mortar', 'Rooftop indirect fire. Cannot reach inside 160 m. Each one costs a little more.'],
  gasMortar: ['Gas Mortar', 'Rooftop shells that stun the infected for a few seconds.'],
  fireMortar: ['Incendiary Mortar', 'Rooftop shells that set the street alight.'],
  mlrs: ['Rocket Battery', 'A salvo of twelve rockets over a wide area.'],
  howitzer: ['Howitzer', 'Very long reach and heavy shells that also damage buildings.'],
  battleship: ['Gunboat', 'Naval guns from a large body of water. Never runs out of shells.'],
  railgun: ['Railgun', 'Pierces everything along its line of fire.'],
  mine: ['Mines', 'Painted cell by cell. Explodes under the first foot.'],
  chemical: ['Chemical Trap', 'Painted cell by cell. Stuns whatever triggers it.'],
  napalm: ['Napalm Drum', 'A buried drum that lights a wide fire when tripped.'],
  c4: ['Demolition Charge', 'Fix to a building or bridge and detonate by hand.'],
  spikes: ['Spike Strip', 'A drawn line that slows the infected. Priced per metre.'],
  oil: ['Oil Slick', 'A drawn line that ignites when crossed. Priced per metre.'],
  patrolBoat: ['Patrol Boat', 'Fast launch with a machine gun that patrols its water.'],
  gunboat: ['Gunboat', 'Slow, tough boat with a deck cannon and a machine gun.'],
  rocketBarge: ['Rocket Barge', 'Rocket salvoes at crowds from the water, then a long reload.'],
  ferry: ['Evac Ferry', 'Carries residents from the shore to a zone on the water or out by river.'],
  waterMine: ['Water Mine', 'Painted on water. Explodes under the infected that swim.'],
};

export const ABILITY_TEXT = {
  paratroopers: ['Airborne Squad', 'PARA', 'Twenty soldiers dropped on a point. Hunt or guard.'],
  callToArms: ['Call to Arms', 'ARMS', 'Arms the civilians inside a drawn circle.'],
  seekDestroy: ['Seek & Destroy', 'S&D', 'Empties a garrison into a police patrol.'],
  apc: ['Armoured Carrier', 'APC', 'Armoured car with a machine gun that patrols near its drop point.'],
  bus: ['Evacuation Bus', 'BUS', 'Picks up 400 civilians and drives them out of the city.'],
  medevac: ['Medevac', 'MEDV', 'Helicopter lift for 200 civilians.'],
  bulldozer: ['Bulldozer', 'DOZR', 'Crushes along a line and clears rubble.'],
  rally: ['Rally Point', 'RLY', 'Calls nearby civilians to a point.'],
  demolition: ['Controlled Demolition', 'DEMO', 'Topples a building, with domino damage.'],
  fireBomb: ['Fire Bomb', 'FIRE', 'Sets an area alight.'],
  cruise: ['Cruise Missile', 'CRM', 'Heavy warhead on a point. Levels buildings and bridges.'],
  helicopter: ['Helicopter', 'HELO', 'Hunts until out of ammunition, rearms and returns.'],
  gasBomb: ['Gas Bomb', 'GAS', 'Stuns everything in the cloud.'],
  tank: ['Tank', 'TANK', 'Main gun, machine gun and tracks that crush.'],
  airstrike: ['Airstrike', 'AIR', 'Six bombs along a drawn line.'],
  clusterBomb: ['Cluster Bomb', 'CLST', 'Seventy-two bomblets over a circle.'],
  gunship: ['Gunship', 'GSHP', 'Orbits a point for sixty seconds, firing.'],
  cure: ['Cure', 'CURE', 'Turns the infected in a circle back into civilians.'],
  nuke: ['Nuclear Strike', 'NUKE', 'Arrives 45 s after the call. Destroys everything near the centre.'],
};

export const FUNCTION_TEXT = {
  police: 'Police', militia: 'Militia', broadcast: 'Broadcast', radio: 'Radio', budget: 'Budget', reducedCost: 'Reduced cost',
  repair: 'Repair', supply: 'Supply', commandPost: 'Command post', medic: 'Medic', airlift: 'Airlift',
};

export const MOUNT_TEXT = { building: 'Rooftop', ground: 'Street', water: 'Water', brush: 'Painted', line: 'Drawn line', 'building|bridge': 'Building / bridge' };

let combatInfo = { units: null, abilities: null };
// Loads COMBAT's own display text if that module exists; silently keeps ours otherwise.
export async function loadCombatInfo() {
  try {
    const m = await import('../sim/units.js');
    if (m.UNIT_INFO) combatInfo.units = m.UNIT_INFO;
    if (m.ABILITY_INFO) combatInfo.abilities = m.ABILITY_INFO;
  } catch (e) { /* COMBAT not available yet */ }
  if (!combatInfo.abilities) {
    try { const a = await import('../sim/abilities.js'); if (a.ABILITY_INFO) combatInfo.abilities = a.ABILITY_INFO; } catch (e) { /* optional */ }
  }
}

const pickText = (info, id, i) => {
  const v = info && info[id];
  if (!v) return null;
  if (typeof v === 'string') return i === 0 ? v : null;
  return i === 0 ? v.name || v.label || null : v.desc || v.description || v.text || null;
};

export function unitName(id) { return pickText(combatInfo.units, id, 0) || (UNIT_TEXT[id] || [id])[0]; }
export function unitDesc(id) { return pickText(combatInfo.units, id, 1) || (UNIT_TEXT[id] || [])[1] || ''; }
export function abilityName(id) { return pickText(combatInfo.abilities, id, 0) || (ABILITY_TEXT[id] || [id])[0]; }
export function abilityDesc(id) { return pickText(combatInfo.abilities, id, 1) || (ABILITY_TEXT[id] || [])[2] || ''; }
export function abilityCode(id) { return (ABILITY_TEXT[id] || [id, id.slice(0, 4).toUpperCase()])[1]; }

export function itemName(id) {
  if (UNLOCK_LABELS[id]) return UNLOCK_LABELS[id];
  if (DEFAULTS.units[id]) return unitName(id);
  if (DEFAULTS.abilities[id]) return abilityName(id);
  return id;
}

// "Clear Port Ashby, stage 3" or null for items available from the start.
export function unlockHint(id) {
  const src = unlockSource(id);
  return src ? `Clear ${src.cityName}, stage ${src.stageIdx + 1}` : null;
}

// Human price line for a unit from config (cost may depend on building height or on how many exist).
export function unitPriceText(id, cfg = DEFAULTS) {
  const u = cfg.units[id];
  if (!u) return '';
  const c = u.cost;
  if (typeof c === 'function') {
    if (c.length <= 1 && /^building/.test(u.mount)) {
      const lo = Math.round(stat(c, { h: 0, area: 100 })), hi = Math.round(stat(c, { h: 400, area: 100 }));
      return lo === hi ? `$${lo}` : `$${lo}–${hi}`;
    }
    const a = Math.round(stat(c, null, 0)), b = Math.round(stat(c, null, 1));
    return b > a ? `$${a} +${b - a} each` : `$${a}`;
  }
  return u.perM ? `$${c} / m` : u.mount === 'brush' ? `$${c} / cell` : `$${c}`;
}

// ------------------------------------------------------------ plan symbols (inline SVG, currentColor)

const SYM = {
  garrison: '<rect x="6" y="6" width="12" height="12"/><rect x="10.5" y="4.5" width="3" height="4" fill="var(--card)" stroke="none"/>',
  sniper: '<path d="M12 4 L20 19 H4 Z"/>',
  turret: '<circle cx="10" cy="14" r="5.5" fill="none" stroke-width="1.8"/><path d="M13.5 10.5 L20 4" stroke-width="2.2"/>',
  mortar: '<circle cx="12" cy="12" r="8" fill="none" stroke-width="1.6"/><path d="M8.2 16V8.2L12 13l3.8-4.8V16" fill="none" stroke-width="1.6"/>',
  gasMortar: '<circle cx="12" cy="12" r="8" fill="none" stroke-width="1.6"/><path d="M15.5 9.2a4.2 4.2 0 1 0 .3 5.2H12.5" fill="none" stroke-width="1.6"/>',
  fireMortar: '<circle cx="12" cy="12" r="8" fill="none" stroke-width="1.6"/><path d="M15.5 8H9.5V16M9.5 12H14" fill="none" stroke-width="1.6"/>',
  mlrs: '<rect x="4" y="9" width="16" height="9" fill="none" stroke-width="1.6"/><path d="M7 9V5M12 9V4M17 9V5" stroke-width="1.8"/>',
  howitzer: '<circle cx="8" cy="16" r="4.5"/><path d="M10.5 13.5L21 3" stroke-width="2.2"/>',
  battleship: '<path d="M2.5 12 L7 8 H18 L21.5 12 L18 16 H7 Z" fill="none" stroke-width="1.6"/><rect x="10" y="10.3" width="4" height="3.4"/>',
  railgun: '<rect x="2.5" y="9.5" width="19" height="5" fill="none" stroke-width="1.6"/><path d="M5 12H19" stroke-width="1.2" stroke-dasharray="2 1.5"/>',
  mine: '<path d="M7 7L17 17M17 7L7 17" stroke-width="2.4"/>',
  chemical: '<path d="M7 7L17 17M17 7L7 17" stroke-width="1.6"/><circle cx="12" cy="12" r="8" fill="none" stroke-width="1.3" stroke-dasharray="2.2 2"/>',
  napalm: '<rect x="7" y="4" width="10" height="16" fill="none" stroke-width="1.6"/><path d="M7 9H17M7 15H17" stroke-width="1.6"/>',
  c4: '<rect x="4" y="8" width="11" height="8"/><path d="M15 12 C18 12 17 6 21 6" fill="none" stroke-width="1.5"/>',
  spikes: '<path d="M2 15 L5 8 L8 15 L11 8 L14 15 L17 8 L20 15" fill="none" stroke-width="1.7"/>',
  oil: '<path d="M2 13c3-4 5 4 8 0s5 4 8 0 3 2 4 1" fill="none" stroke-width="2"/>',
  patrolBoat: '<path d="M21 12 C16 8.5 9 9 3 10 V14 C9 15 16 15.5 21 12 Z" fill="none" stroke-width="1.6"/><circle cx="15.5" cy="12" r="1.6"/>',
  gunboat: '<path d="M22 12 C16 7.5 8 8 2.5 9.5 V14.5 C8 16 16 16.5 22 12 Z" fill="none" stroke-width="1.6"/><circle cx="15" cy="12" r="2.2"/><path d="M15 12 H20.5" stroke-width="1.6"/>',
  rocketBarge: '<path d="M22 10 L19.5 7.5 H2.5 V16.5 H19.5 L22 14 Z" fill="none" stroke-width="1.6"/><path d="M8 10.5h1.5M11 10.5h1.5M14 10.5h1.5M8 13.5h1.5M11 13.5h1.5M14 13.5h1.5" stroke-width="1.6"/>',
  ferry: '<path d="M22 12 C19 7.5 14 7.5 3.5 7.5 Q2.5 7.5 2.5 9 V15 Q2.5 16.5 3.5 16.5 C14 16.5 19 16.5 22 12 Z" fill="none" stroke-width="1.6"/><rect x="6" y="9.6" width="9" height="4.8"/>',
  waterMine: '<circle cx="12" cy="10" r="3.6"/><path d="M12 4.2V6M12 14V15.8M6.2 10H8M16 10H17.8" stroke-width="1.6"/><path d="M3 19c3-2 6 2 9 0s6 2 9 0" fill="none" stroke-width="1.4"/>',
};

export function unitSymbol(id, size = 24) {
  const body = SYM[id] || '<rect x="6" y="6" width="12" height="12" fill="none" stroke-width="1.6"/>';
  return `<svg class="sym" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="currentColor" stroke-width="0" stroke-linecap="square" aria-hidden="true">${body}</svg>`;
}
