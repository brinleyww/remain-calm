// Player settings (localStorage): key bindings, sound, display and simulation preferences.
// Key ids are KeyboardEvent.code with optional modifier prefixes in the fixed order Ctrl+Alt+Shift+ (e.g. 'Shift+Digit1').

const KEY = 'remain-calm.settings.v1';

export const ACTIONS = [
  { id: 'ready', label: 'Ready / pause', group: 'Battle' },
  { id: 'slower', label: 'Slower', group: 'Battle' },
  { id: 'faster', label: 'Faster', group: 'Battle' },
  { id: 'confirm', label: 'Close zone / next stage', group: 'Battle' },
  { id: 'cancel', label: 'Cancel / pause menu', group: 'Battle', fixed: true },
  { id: 'loadout', label: 'Loadout', group: 'Battle' },
  { id: 'undo', label: 'Undo', group: 'Battle' },
  { id: 'zone', label: 'Safe zone', group: 'Build' },
  { id: 'wall', label: 'Wall', group: 'Build' },
  { id: 'gate', label: 'Gate', group: 'Build' },
  { id: 'corridor', label: 'Evac corridor', group: 'Build' },
  { id: 'hold', label: 'Hold point', group: 'Build' },
  { id: 'upgrade', label: 'Upgrade', group: 'Build' },
  { id: 'refund', label: 'Refund', group: 'Build' },
  { id: 'paint', label: 'Paint mode', group: 'Build' },
  { id: 'detonate', label: 'Detonate charge', group: 'Build', shares: ['panRight'] },
  ...[1, 2, 3, 4, 5, 6, 7].map(n => ({ id: 'unit' + n, label: 'Unit slot ' + n, group: 'Units' })),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ id: 'ability' + n, label: 'Ability ' + n, group: 'Abilities' })),
  { id: 'viewHeights', label: 'Heights view', group: 'View' },
  { id: 'viewSpecials', label: 'Specials view', group: 'View' },
  { id: 'viewRanges', label: 'Range rings', group: 'View' },
  { id: 'fitStage', label: 'Fit stage', group: 'View' },
  { id: 'panUp', label: 'Pan up', group: 'View', anyMods: true },
  { id: 'panDown', label: 'Pan down', group: 'View', anyMods: true },
  { id: 'panLeft', label: 'Pan left', group: 'View', anyMods: true },
  { id: 'panRight', label: 'Pan right', group: 'View', anyMods: true, shares: ['detonate'] },
];
const ACTION_BY_ID = new Map(ACTIONS.map(a => [a.id, a]));

export const DEFAULT_KEYS = {
  ready: ['Space'], slower: ['Comma'], faster: ['Period'], confirm: ['Enter', 'NumpadEnter'], cancel: ['Escape'],
  loadout: ['Tab'], undo: ['Ctrl+KeyZ'],
  zone: ['KeyB'], wall: ['KeyN'], gate: ['KeyG'], corridor: ['KeyQ'], hold: ['KeyE'],
  upgrade: ['KeyU'], refund: ['KeyX'], paint: ['KeyP'], detonate: ['KeyD'],
  unit1: ['Digit1'], unit2: ['Digit2'], unit3: ['Digit3'], unit4: ['Digit4'], unit5: ['Digit5'], unit6: ['Digit6'], unit7: ['Digit7'],
  ability1: ['F1', 'Shift+Digit1'], ability2: ['F2', 'Shift+Digit2'], ability3: ['F3', 'Shift+Digit3'], ability4: ['F4', 'Shift+Digit4'],
  ability5: ['F5', 'Shift+Digit5'], ability6: ['F6', 'Shift+Digit6'], ability7: ['F7', 'Shift+Digit7'], ability8: ['F8', 'Shift+Digit8'],
  viewHeights: ['KeyV'], viewSpecials: ['KeyC'], viewRanges: ['KeyR'], fitStage: ['Home'],
  panUp: ['KeyW', 'ArrowUp'], panDown: ['KeyS', 'ArrowDown'], panLeft: ['KeyA', 'ArrowLeft'], panRight: ['KeyD', 'ArrowRight'],
};

export const PALETTE_CHOICES = ['auto', 'paper', 'blueprint', 'night'];
export const POP_SCALE_RANGE = [0.05, 2];
export const UI_SCALE_RANGE = [0.8, 1.4];

export const DEFAULT_SETTINGS = Object.freeze({
  keys: DEFAULT_KEYS,
  volume: 0.7,        // master, 0..1
  sfxVolume: 1,       // game effects relative to master
  uiSounds: true,     // typewriter clacks in menus
  popScale: 1,        // feeds config population.scale
  popV: 2,            // settings saved before v2 kept the old 0.35 default; see migrate()
  autoPauseOnOutbreak: true,
  showTips: true,
  uiScale: 1,
  palette: 'auto',    // 'auto' = paper in menus, the map's own preset in game
  edgePan: false,
  reduceMotion: false,
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const listeners = new Set();
let state = load();

function cloneKeys(k) { const o = {}; for (const id in k) o[id] = k[id].slice(); return o; }

function sanitize(raw) {
  const s = { ...DEFAULT_SETTINGS, keys: cloneKeys(DEFAULT_KEYS) };
  if (!raw || typeof raw !== 'object') return s;
  const num = (v, d, a, b) => (Number.isFinite(+v) && v !== null && v !== '' ? clamp(+v, a, b) : d);
  s.volume = num(raw.volume, s.volume, 0, 1);
  s.sfxVolume = num(raw.sfxVolume, s.sfxVolume, 0, 1);
  s.popScale = num(raw.popScale, s.popScale, POP_SCALE_RANGE[0], POP_SCALE_RANGE[1]);
  s.uiScale = num(raw.uiScale, s.uiScale, UI_SCALE_RANGE[0], UI_SCALE_RANGE[1]);
  for (const b of ['uiSounds', 'autoPauseOnOutbreak', 'showTips', 'edgePan', 'reduceMotion']) if (typeof raw[b] === 'boolean') s[b] = raw[b];
  if (PALETTE_CHOICES.includes(raw.palette)) s.palette = raw.palette;
  if (raw.keys && typeof raw.keys === 'object') {
    for (const a of ACTIONS) {
      const v = raw.keys[a.id];
      if (a.fixed || !Array.isArray(v)) continue;
      s.keys[a.id] = v.filter(k => typeof k === 'string' && k.length < 40).slice(0, 2);
    }
  }
  return s;
}

function load() {
  try { return sanitize(migrate(JSON.parse(localStorage.getItem(KEY) || 'null'))); } catch (e) { return sanitize(null); }
}

// The default population scale went from 0.35 to 1: a saved value still at the old default follows it.
function migrate(raw) {
  if (raw && typeof raw === 'object' && !(raw.popV >= 2) && Math.abs(+raw.popScale - 0.35) < 1e-6) delete raw.popScale;
  return raw;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked: keep in memory */ }
}

function emit(changed) {
  for (const fn of [...listeners]) { try { fn(state, changed); } catch (e) { console.error('[settings] listener failed', e); } }
}

// Live settings object. Treat as read-only; change it through setSetting / updateSettings.
export function getSettings() { return state; }
export function getSetting(key) { return state[key]; }

export function updateSettings(patch) {
  const next = sanitize({ ...state, ...patch, keys: patch && patch.keys ? patch.keys : state.keys });
  const changed = Object.keys(patch || {}).filter(k => JSON.stringify(next[k]) !== JSON.stringify(state[k]));
  state = next;
  save();
  if (changed.length) emit(changed);
  return state;
}
export function setSetting(key, value) { return updateSettings({ [key]: value }); }

export function resetSettings(part = 'all') {
  if (part === 'keys') return updateSettings({ keys: cloneKeys(DEFAULT_KEYS) });
  state = sanitize(null);
  save();
  emit(Object.keys(DEFAULT_SETTINGS));
  return state;
}

export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ------------------------------------------------------------ key bindings

export function keysFor(action) {
  if (action === 'cancel') return DEFAULT_KEYS.cancel.slice();
  return (state.keys[action] || DEFAULT_KEYS[action] || []).slice();
}

const MOD_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);
export const isModifierCode = code => MOD_CODES.has(code);

export function eventToKey(e) {
  if (!e || !e.code || MOD_CODES.has(e.code)) return '';
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
}

const bareCode = id => id.slice(id.lastIndexOf('+') + 1);

// All actions bound to this key event. Exact matches first; pan keys also match with modifiers held.
export function actionsForEvent(e) {
  const id = typeof e === 'string' ? e : eventToKey(e);
  if (!id) return [];
  const exact = [], loose = [];
  const code = bareCode(id);
  for (const a of ACTIONS) {
    const ks = keysFor(a.id);
    if (ks.includes(id)) exact.push(a.id);
    else if (a.anyMods && ks.some(k => k === code)) loose.push(a.id);
  }
  return exact.length ? exact : loose;
}
export function actionForEvent(e) { return actionsForEvent(e)[0] || null; }
export function matches(e, action) { return actionsForEvent(e).includes(action); }

// Other actions already using keyId (pairs declared in `shares` are allowed to overlap).
export function findConflicts(keyId, action) {
  const self = ACTION_BY_ID.get(action);
  const out = [];
  for (const a of ACTIONS) {
    if (a.id === action) continue;
    if (self && self.shares && self.shares.includes(a.id)) continue;
    if (keysFor(a.id).includes(keyId)) out.push(a.id);
  }
  return out;
}

// Binds keyId into slot (0 primary, 1 alternate). Conflicting bindings are removed from the other actions.
export function bindKey(action, slot, keyId) {
  const a = ACTION_BY_ID.get(action);
  if (!a || a.fixed) return { ok: false, reason: 'This key cannot be changed', moved: [] };
  if (keyId && DEFAULT_KEYS.cancel.includes(keyId)) return { ok: false, reason: 'Escape is reserved for cancel', moved: [] };
  const keys = cloneKeys(state.keys);
  const moved = [];
  if (keyId) {
    for (const other of findConflicts(keyId, action)) {
      keys[other] = keys[other].filter(k => k !== keyId);
      moved.push(other);
    }
  }
  const cur = (keys[action] || []).slice();
  if (keyId) {
    const dup = cur.indexOf(keyId);
    if (dup >= 0) cur.splice(dup, 1);
    cur[Math.min(slot, cur.length)] = keyId;
  } else if (slot < cur.length) cur.splice(slot, 1);
  keys[action] = cur.filter(Boolean).slice(0, 2);
  updateSettings({ keys });
  return { ok: true, moved };
}

const CODE_LABEL = {
  Space: 'Space', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Enter: 'Enter', NumpadEnter: 'Num Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Bksp',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Insert: 'Ins', Delete: 'Del',
};
export function keyLabel(id) {
  if (!id) return '';
  return id.split('+').map(part => {
    if (part === 'Ctrl' || part === 'Alt' || part === 'Shift') return part;
    if (CODE_LABEL[part]) return CODE_LABEL[part];
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit\d$/.test(part)) return part.slice(5);
    if (/^Numpad\d$/.test(part)) return 'Num ' + part.slice(6);
    return part.replace(/^Numpad/, 'Num ');
  }).join(' + ');
}
export function actionLabel(id) { const a = ACTION_BY_ID.get(id); return a ? a.label : id; }
export function primaryKeyLabel(action) { return keyLabel(keysFor(action)[0] || ''); }

// ------------------------------------------------------------ derived values

export function popScaleMutator(scale = state.popScale) { return `population.scale=${+(+scale).toFixed(3)}`; }

// Shell display: UI scale and the menu print preset. 'auto' prints menus on paper.
// In game pass { palette: false } so the map's own preset stays on the page.
export function applyDisplaySettings(doc = typeof document !== 'undefined' ? document : null, { palette = true } = {}) {
  if (!doc) return;
  const root = doc.documentElement;
  root.style.setProperty('--ui-scale', String(state.uiScale));
  if (palette) root.setAttribute('data-palette', state.palette === 'auto' ? 'paper' : state.palette);
  root.classList.toggle('reduce-motion', !!state.reduceMotion);
}

// Palette to use in game for a map: the setting wins unless it is 'auto'.
export function gamePalette(map) { return state.palette === 'auto' ? (map && map.palette) || 'paper' : state.palette; }
