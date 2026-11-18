// Player settings as the game client sees them: js/meta/settings.js when it loads, built-in defaults otherwise.
// Key ids are KeyboardEvent.code with optional 'Ctrl+' 'Alt+' 'Shift+' prefixes in that order.

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
const PAN = new Set(['panUp', 'panDown', 'panLeft', 'panRight']);
const MOD_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn']);

export function eventKeyId(e) {
  if (!e || !e.code || MOD_CODES.has(e.code)) return '';
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
}

const CODE_LABEL = {
  Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Bksp', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', Home: 'Home', End: 'End', Delete: 'Del',
};
export function keyIdLabel(id) {
  if (!id) return '';
  return id.split('+').map((p) => {
    if (p === 'Ctrl' || p === 'Alt' || p === 'Shift') return p;
    if (CODE_LABEL[p]) return CODE_LABEL[p];
    if (/^Key[A-Z]$/.test(p)) return p.slice(3);
    if (/^Digit\d$/.test(p)) return p.slice(5);
    return p.replace(/^Numpad/, 'Num ');
  }).join('+');
}

function normalise(s) {
  s = s || {};
  const num = (v, def) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : def);
  const vol = Math.max(0, Math.min(1, num(s.volume, 0.7))) * Math.max(0, Math.min(1, num(s.sfxVolume, 1)));
  return {
    volume: vol,
    popScale: Math.max(0.02, Math.min(2, num(s.popScale, 1))),
    autoPause: (s.autoPauseOnOutbreak ?? s.autoPause ?? true) !== false,
    showTips: (s.showTips ?? true) !== false,
    uiScale: Math.max(0.7, Math.min(1.6, num(s.uiScale, 1))),
    edgePan: !!s.edgePan,
    reduceMotion: !!s.reduceMotion,
    palette: typeof s.palette === 'string' ? s.palette : 'auto',
    keys: s.keys && typeof s.keys === 'object' ? s.keys : DEFAULT_KEYS,
  };
}

// Returns { get(), onChange(fn) -> off, set(patch), actionsFor(event) -> [action], keyLabel(action), palette(map) }.
export async function loadPrefs() {
  let mod = null;
  try { mod = await import('../meta/settings.js'); } catch (e) { mod = null; }
  const has = (f) => !!mod && typeof mod[f] === 'function';
  let raw = null;
  const read = () => { if (has('getSettings')) { try { return normalise(mod.getSettings()); } catch (e) { /* defaults */ } } return normalise(raw); };
  let current = read();
  const listeners = new Set();
  const notify = () => { current = read(); for (const fn of listeners) { try { fn(current); } catch (e) { console.error(e); } } };
  if (has('onSettingsChange')) { try { mod.onSettingsChange(notify); } catch (e) { /* static settings */ } }

  const keysOf = (action) => {
    if (has('keysFor')) { try { return mod.keysFor(action) || []; } catch (e) { /* fall through */ } }
    const k = current.keys[action] ?? DEFAULT_KEYS[action];
    return Array.isArray(k) ? k : k ? [k] : [];
  };
  const resolve = (e) => {
    const id = eventKeyId(e);
    if (!id) return [];
    const code = id.slice(id.lastIndexOf('+') + 1);
    const exact = [], loose = [];
    for (const a of Object.keys(DEFAULT_KEYS)) {
      const ks = keysOf(a);
      if (ks.includes(id)) exact.push(a);
      else if (PAN.has(a) && ks.includes(code)) loose.push(a);
    }
    return exact.length ? exact : loose;
  };

  return {
    get: () => current,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(patch) {
      const p = { ...patch };
      if ('autoPause' in p) { p.autoPauseOnOutbreak = p.autoPause; delete p.autoPause; }
      if (has('updateSettings')) { try { mod.updateSettings(p); return; } catch (e) { /* local */ } }
      raw = { ...(raw || {}), ...p };
      notify();
    },
    actionsFor(e) {
      if (has('actionsForEvent')) { try { return mod.actionsForEvent(e) || []; } catch (e2) { /* local */ } }
      return resolve(e);
    },
    keyLabel(action) {
      if (has('primaryKeyLabel')) { try { const l = mod.primaryKeyLabel(action); if (l) return l.replace(/ \+ /g, '+').replace(/[←-↓]/g, (c) => ({ '←': 'Left', '↑': 'Up', '→': 'Right', '↓': 'Down' })[c]); } catch (e) { /* local */ } }
      return keyIdLabel(keysOf(action)[0] || '');
    },
    palette(map) {
      if (has('gamePalette')) { try { return mod.gamePalette(map); } catch (e) { /* local */ } }
      return current.palette && current.palette !== 'auto' ? current.palette : (map && map.palette) || 'paper';
    },
    module: mod,
  };
}
