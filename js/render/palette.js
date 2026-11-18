// Canvas colours for the three print presets. Mirrors the tokens in css/base.css.

import { KIND_TAG, BUILDING_KINDS } from '../map/format.js';

export const FONT_MONO = '"IBM Plex Mono", ui-monospace, Consolas, "Courier New", monospace';
export const FONT_LABEL = '"Archivo Narrow", "Arial Narrow", "Roboto Condensed", Arial, sans-serif';

export const PALETTE_NAMES = ['paper', 'blueprint', 'night'];
export const PALETTE_LABELS = { paper: 'Paper', blueprint: 'Blueprint', night: 'Night Print' };

export const SPECIAL_CODES = KIND_TAG;
export const BUILDING_KIND_ORDER = BUILDING_KINDS;
export const HEIGHT_BREAKS = [6, 12, 20, 35, 60, Infinity];
export const HEIGHT_LABELS = ['< 6 m', '6-12 m', '12-20 m', '20-35 m', '35-60 m', '60 m +'];

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = i => Math.round(A[i] + (B[i] - A[i]) * t).toString(16).padStart(2, '0');
  return `#${c(0)}${c(1)}${c(2)}`;
}

function build(base) {
  const p = base;
  p.bldgKind = {
    res: p.building,
    com: mix(p.building, p.ink2, 0.07),
    ind: mix(p.building, p.ink3, 0.28),
    landmark: mix(p.building, p.ink2, 0.16),
    civic: mix(p.building, p.special.civic, 0.13),
    trade: mix(p.building, p.special.trade, 0.15),
    armory: mix(p.building, p.special.armory, 0.15),
    rescue: mix(p.building, p.special.rescue, 0.13),
    hazard: mix(p.building, p.special.hazard, 0.15),
  };
  p.specialFill = {};
  for (const k in p.special) p.specialFill[k] = mix(p.paper, p.special[k], p.specialTint);
  p.bldgFaded = mix(p.paper, p.building, 0.45);
  p.bldgFadedLine = mix(p.paper, p.buildingLine, 0.4);
  // fast lookups by SIM agent TYPE (FREE 0, CIV 1, ZOMBIE 2, TURNING 3, POLICE 4, MILITIA 5, SOLDIER 6) and zombie sub
  const a = p.agent;
  p.agentByType = [p.ink3, a.civ, a.zombie, a.turning, a.police, a.militia, a.soldier];
  p.zombieBySub = [a.zombie, a.explosive, a.shielded, a.swimmer, a.giant];
  p.heights = HEIGHT_BREAKS.map((max, i) => ({ max, color: p.heightRamp[i], label: HEIGHT_LABELS[i] }));
  return Object.freeze(p);
}

export const PALETTES = {
  paper: build({
    name: 'paper', label: 'Paper', dark: false,
    desk: '#C8BEA6', deskShadow: 'rgba(30,28,24,.28)', deskLine: '#A79C82',
    paper: '#ECE5D3', paper2: '#E2D9C2', card: '#F6F1E4',
    ink: '#1E1C18', ink2: '#4A463D', ink3: '#8A8371',
    grainDark: [30, 28, 24], grainLight: [255, 252, 240], grainAmt: 1,
    grid: 'rgba(74,70,61,.13)', gridMajor: 'rgba(74,70,61,.26)', gridLabel: 'rgba(74,70,61,.55)',
    road: '#F8F4EA', roadCasing: '#B9B09A', majorCasing: '#857C66', majorRoad: '#FBF8F0',
    path: '#8A8371', rail: '#6F6756', railGap: '#ECE5D3',
    bridge: '#F8F4EA', bridgeCasing: '#4A463D', bridgeEdge: '#1E1C18',
    building: '#CFC6B0', buildingLine: '#6F6756', buildingShadow: 'rgba(30,28,24,.18)',
    water: '#A7B8BC', waterHatch: '#8EA2A7', waterLine: '#6F878D',
    park: '#B7BD93', parkMark: '#87905F', parkLine: '#8A9364',
    rubble: '#8A8371', rubbleGround: '#D5CCB6',
    outsideDim: 'rgba(226,217,194,.66)', outsideHatch: 'rgba(74,70,61,.30)', stageLine: '#1E1C18', stageBand: 'rgba(179,38,30,.13)',
    hover: '#1E1C18', hoverHalo: '#F6F1E4', select: '#27408B',
    specialTint: 0.42,
    special: { civic: '#27408B', trade: '#8A5D0E', armory: '#4F5A26', rescue: '#2E6B3A', hazard: '#B3261E' },
    heightRamp: ['#E6DDC6', '#D8C49B', '#C9A26B', '#B0723F', '#8A4022', '#5A1F12'],
    agent: {
      civ: '#2B4A7A', civPanic: '#3F6FB0', zombie: '#B0341F', turning: '#8E4A3C',
      explosive: '#E8B800', shielded: '#7C8A93', swimmer: '#0B7F7A', giant: '#5A1208',
      police: '#1F3B5C', policeDot: '#FFFFFF', militia: '#7A5A1F', soldier: '#2F5D3A', outline: '#F6F1E4',
      edge: 'rgba(30,28,24,.5)', markDark: '#1E1C18', markLight: '#F6F1E4',
    },
    zone: { wall: '#D9662B', fill: 'rgba(217,102,43,.10)', hatch: 'rgba(217,102,43,.35)', gate: '#1E1C18', breached: '#B3261E',
            corridor: '#C9962A', corridorFill: 'rgba(201,150,42,.12)', hold: '#1E1C18', holdFill: 'rgba(30,28,24,.06)', standalone: '#D9662B' },
    stamp: '#B3261E', approve: '#2E6B3A', carbon: '#27408B', safety: '#D9662B', amber: '#C9962A',
    badge: { bronze: '#9A5B2E', silver: '#8C8C8C', gold: '#B38B1D', sapphire: '#2B4C9B', emerald: '#2C7A4B', ruby: '#9B1B30', diamond: '#5B8FA8' },
    fx: { tracer: '#1E1C18', shell: '#1E1C18', boom: '#B3261E', fire: '#D9662B', ember: '#E0A21F', smoke: 'rgba(30,28,24,.22)',
          gas: 'rgba(120,128,60,.32)', flash: '#FFF8E6', splash: '#6F878D', range: 'rgba(30,28,24,.35)', pit: '#B3261E' },
  }),

  blueprint: build({
    name: 'blueprint', label: 'Blueprint', dark: true,
    desk: '#153656', deskShadow: 'rgba(5,15,28,.5)', deskLine: '#2B5A86',
    paper: '#1F4C78', paper2: '#1A4269', card: '#245683',
    ink: '#EEF3F2', ink2: '#BCD0DC', ink3: '#7FA2BC',
    grainDark: [8, 24, 44], grainLight: [210, 232, 245], grainAmt: 0.8,
    grid: 'rgba(188,208,220,.12)', gridMajor: 'rgba(188,208,220,.24)', gridLabel: 'rgba(188,208,220,.55)',
    road: '#2B6496', roadCasing: '#D3E2EB', majorCasing: '#EEF3F2', majorRoad: '#2F6A9E',
    path: '#9DBAD0', rail: '#D8E6EE', railGap: '#1F4C78',
    bridge: '#2B6496', bridgeCasing: '#EEF3F2', bridgeEdge: '#EEF3F2',
    building: '#285E90', buildingLine: '#E1ECF2', buildingShadow: 'rgba(6,20,38,.34)',
    water: '#173E63', waterHatch: '#3B6E9C', waterLine: '#8FB3CF',
    park: '#22567F', parkMark: '#6F9DBE', parkLine: '#6F9DBE',
    rubble: '#9DBAD0', rubbleGround: '#2A5A84',
    outsideDim: 'rgba(21,54,86,.62)', outsideHatch: 'rgba(127,162,188,.30)', stageLine: '#EEF3F2', stageBand: 'rgba(242,122,98,.18)',
    hover: '#FFFFFF', hoverHalo: '#153656', select: '#F2C46B',
    specialTint: 0.5,
    special: { civic: '#CFE0FF', trade: '#E8C15A', armory: '#B9D28A', rescue: '#8FD19E', hazard: '#F27A62' },
    heightRamp: ['#2A6193', '#3E78A8', '#5D93BE', '#86B0D2', '#B5D0E4', '#E8F1F6'],
    agent: {
      civ: '#F1F5F6', civPanic: '#A8D4F2', zombie: '#FF7A5C', turning: '#E9A88F',
      explosive: '#FFE01A', shielded: '#B7C4CC', swimmer: '#5CF2DA', giant: '#FF5A3C',
      police: '#0E2A47', policeDot: '#FFFFFF', militia: '#E8C66E', soldier: '#9BD88A', outline: '#153656',
      edge: 'rgba(11,34,56,.6)', markDark: '#0B2238', markLight: '#FFFFFF',
    },
    zone: { wall: '#F39A5B', fill: 'rgba(243,154,91,.12)', hatch: 'rgba(243,154,91,.4)', gate: '#EEF3F2', breached: '#F27A62',
            corridor: '#E8C15A', corridorFill: 'rgba(232,193,90,.14)', hold: '#EEF3F2', holdFill: 'rgba(238,243,242,.07)', standalone: '#F39A5B' },
    stamp: '#F27A62', approve: '#8FD19E', carbon: '#CFE0FF', safety: '#F39A5B', amber: '#E8C15A',
    badge: { bronze: '#D89A6A', silver: '#CACFD3', gold: '#E6C25A', sapphire: '#9DB8F2', emerald: '#7FD3A2', ruby: '#F28C9C', diamond: '#A9D8EA' },
    fx: { tracer: '#EEF3F2', shell: '#EEF3F2', boom: '#F27A62', fire: '#F39A5B', ember: '#FFD27A', smoke: 'rgba(200,220,235,.22)',
          gas: 'rgba(185,210,138,.32)', flash: '#FFFFFF', splash: '#8FB3CF', range: 'rgba(238,243,242,.4)', pit: '#F27A62' },
  }),

  night: build({
    name: 'night', label: 'Night Print', dark: true,
    desk: '#0E0F0D', deskShadow: 'rgba(0,0,0,.55)', deskLine: '#2A2B26',
    paper: '#1C1D1A', paper2: '#151613', card: '#25261F',
    ink: '#E4DCC6', ink2: '#B0A891', ink3: '#6F6A5B',
    grainDark: [0, 0, 0], grainLight: [228, 220, 198], grainAmt: 0.7,
    grid: 'rgba(176,168,145,.08)', gridMajor: 'rgba(176,168,145,.17)', gridLabel: 'rgba(176,168,145,.45)',
    road: '#3A3B33', roadCasing: '#64625A', majorCasing: '#8A836E', majorRoad: '#403F37',
    path: '#6F6A5B', rail: '#8A836E', railGap: '#1C1D1A',
    bridge: '#3B3C34', bridgeCasing: '#9C957F', bridgeEdge: '#B0A891',
    building: '#2E2F2A', buildingLine: '#857E69', buildingShadow: 'rgba(0,0,0,.4)',
    water: '#14232B', waterHatch: '#27465A', waterLine: '#3E6276',
    park: '#1F2A1C', parkMark: '#3E5236', parkLine: '#3E5236',
    rubble: '#8A8371', rubbleGround: '#2A2924',
    outsideDim: 'rgba(14,15,13,.62)', outsideHatch: 'rgba(111,106,91,.30)', stageLine: '#E4DCC6', stageBand: 'rgba(224,87,74,.16)',
    hover: '#F2EBD6', hoverHalo: '#0E0F0D', select: '#D9AE4A',
    specialTint: 0.38,
    special: { civic: '#8FA6E0', trade: '#D9AE4A', armory: '#A3B06A', rescue: '#6DAF7A', hazard: '#E0574A' },
    heightRamp: ['#2E2F29', '#4A4536', '#6C5D3E', '#977743', '#C29548', '#E8C46A'],
    agent: {
      civ: '#7FA3D8', civPanic: '#A9C6EF', zombie: '#E5553B', turning: '#C78B78',
      explosive: '#F5D33B', shielded: '#A9B4BC', swimmer: '#38C9C0', giant: '#E64A2C',
      police: '#D8E2EE', policeDot: '#1E2A3A', militia: '#C9A24E', soldier: '#7FB57F', outline: '#0E0F0D',
      edge: 'rgba(0,0,0,.55)', markDark: '#0E0F0D', markLight: '#F2EBD6',
    },
    zone: { wall: '#E8823F', fill: 'rgba(232,130,63,.10)', hatch: 'rgba(232,130,63,.35)', gate: '#E4DCC6', breached: '#E0574A',
            corridor: '#D9AE4A', corridorFill: 'rgba(217,174,74,.12)', hold: '#E4DCC6', holdFill: 'rgba(228,220,198,.06)', standalone: '#E8823F' },
    stamp: '#E0574A', approve: '#6DAF7A', carbon: '#8FA6E0', safety: '#E8823F', amber: '#D9AE4A',
    badge: { bronze: '#C3804D', silver: '#A9A9A9', gold: '#D4AA3A', sapphire: '#7C97DA', emerald: '#5FB283', ruby: '#D45A6C', diamond: '#84B7CC' },
    fx: { tracer: '#E4DCC6', shell: '#E4DCC6', boom: '#E0574A', fire: '#E8823F', ember: '#F2C060', smoke: 'rgba(160,150,130,.2)',
          gas: 'rgba(163,176,106,.3)', flash: '#FFF4DA', splash: '#3E6276', range: 'rgba(228,220,198,.35)', pit: '#E0574A' },
  }),
};

export function getPalette(name) {
  if (name && typeof name === 'object' && name.agentByType) return name;
  return PALETTES[name] || PALETTES.paper;
}

// Sets the CSS preset on an element (default <html>) so DOM tokens match the canvas palette.
export function applyPalette(name, el = typeof document !== 'undefined' ? document.documentElement : null) {
  const pal = getPalette(name);
  if (el) el.setAttribute('data-palette', pal.name);
  return pal;
}

export function heightClass(h) {
  for (let i = 0; i < HEIGHT_BREAKS.length; i++) if (h < HEIGHT_BREAKS[i]) return i;
  return HEIGHT_BREAKS.length - 1;
}

export function heightColor(pal, h) { return getPalette(pal).heightRamp[heightClass(h)]; }

export function agentColor(pal, type, sub = 0, panicked = false) {
  const p = getPalette(pal);
  if (type === 2) return p.zombieBySub[sub] || p.agent.zombie;
  if (type === 1 && panicked) return p.agent.civPanic;
  return p.agentByType[type] || p.ink3;
}
