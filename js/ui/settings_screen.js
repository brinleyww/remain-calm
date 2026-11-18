// Settings: key bindings with conflict check, sound, display, simulation scale, and progress reset.
import {
  ACTIONS, getSettings, updateSettings, resetSettings, keysFor, bindKey, eventToKey, keyLabel, actionLabel, findConflicts,
  isModifierCode, PALETTE_CHOICES, POP_SCALE_RANGE, UI_SCALE_RANGE, applyDisplaySettings,
} from '../meta/settings.js';
import { resetProgress, unlockAll, getProgress } from '../meta/progress.js';
import { DEFAULTS } from '../data/config.js';
import { PALETTE_LABELS } from '../render/palette.js';
import { h, clear, sfx, toast, confirmModal, fmtInt, keycap } from './dom.js';
import { screenFrame, folderTabs, segControl, slider, field } from './screen.js';

let lastTab = 'controls';

function perfNote(scale) {
  const per10k = Math.round(10000 * scale);
  const tier = scale <= 0.4 ? ['Light', 'Runs well on most machines.'] : scale <= 0.65 ? ['Moderate', 'Comfortable on a recent desktop.'] : scale <= 0.85 ? ['Heavy', 'Big imports may slow down on laptops.'] : ['Very heavy', `Large maps can pass 40,000 people; the hard cap is ${fmtInt(DEFAULTS.sim.maxAgents)}.`];
  return { per10k, tier };
}

// Builds the settings body. Returns { el, destroy }.
export function buildSettings({ inGame = false } = {}) {
  let capture = null; // { action, slot, el }
  const notice = h('p.bind-notice.small', { 'aria-live': 'polite' });
  const folder = folderTabs([
    { id: 'controls', label: 'Controls', no: '01' },
    { id: 'display', label: 'Sound & display', no: '02' },
    { id: 'sim', label: 'Simulation', no: '03' },
    ...(inGame ? [] : [{ id: 'records', label: 'Records', no: '04' }]),
  ], lastTab, (id) => { lastTab = id; stopCapture(); render(); });

  function stopCapture() {
    if (!capture) return;
    window.removeEventListener('keydown', onCaptureKey, true);
    capture = null;
  }
  function onCaptureKey(e) {
    if (!capture) return;
    e.preventDefault();
    e.stopPropagation();
    if (isModifierCode(e.code)) return;
    const { action, slot } = capture;
    if (e.key === 'Escape') { stopCapture(); notice.textContent = 'Binding cancelled.'; render(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      bindKey(action, slot, '');
      stopCapture(); sfx.clack(); notice.textContent = `${actionLabel(action)}: slot cleared.`; render(); return;
    }
    const id = eventToKey(e);
    const res = bindKey(action, slot, id);
    stopCapture();
    if (!res.ok) { notice.className = 'bind-notice small err-text'; notice.textContent = res.reason; render(); return; }
    sfx.clack();
    notice.className = 'bind-notice small' + (res.moved.length ? ' warn-text' : ' ok-text');
    notice.textContent = res.moved.length
      ? `${keyLabel(id)} now ${actionLabel(action)}. Removed from ${res.moved.map(actionLabel).join(', ')}, which may need a new key.`
      : `${keyLabel(id)} bound to ${actionLabel(action)}.`;
    render();
  }

  function controlsTab() {
    const groups = {};
    for (const a of ACTIONS) (groups[a.group] = groups[a.group] || []).push(a);
    const wrap = h('div.binds');
    for (const [g, list] of Object.entries(groups)) {
      const tbl = h('table.table.ledger.compact.bind-table', h('caption', g),
        h('thead', h('tr', h('th', 'Action'), h('th', 'Key'), h('th', 'Alternate'))));
      const tb = h('tbody');
      for (const a of list) {
        const ks = keysFor(a.id);
        const cells = [0, 1].map(slot => {
          const k = ks[slot] || '';
          const conflicts = k ? findConflicts(k, a.id) : [];
          const capturing = capture && capture.action === a.id && capture.slot === slot;
          const b = h('button.bind' + (capturing ? '.is-capturing' : '') + (k ? '' : '.is-empty') + (conflicts.length ? '.is-conflict' : ''),
            { type: 'button', disabled: !!a.fixed, title: a.fixed ? 'Reserved' : conflicts.length ? `Also used by ${conflicts.map(actionLabel).join(', ')}` : 'Click, then press a key. Backspace clears.' },
            capturing ? 'Press a key…' : k ? keycap(keyLabel(k)) : '—');
          b.addEventListener('click', () => {
            if (a.fixed) return;
            stopCapture();
            capture = { action: a.id, slot };
            notice.className = 'bind-notice small';
            notice.textContent = `Press the new key for ${a.label}. Esc cancels, Backspace clears.`;
            window.addEventListener('keydown', onCaptureKey, true);
            sfx.key();
            render();
          });
          return h('td', b);
        });
        tb.appendChild(h('tr', h('td', a.label, a.fixed ? h('span.tiny.faint', ' (fixed)') : null), cells));
      }
      tbl.appendChild(tb);
      wrap.appendChild(tbl);
    }
    return h('div.vstack.gap-3',
      h('div.spread', notice, h('button.btn.btn-sm', { type: 'button', onclick: async () => {
        if (await confirmModal({ title: 'Restore default keys', message: 'Every binding returns to the standard layout.', confirmLabel: 'Restore' })) { resetSettings('keys'); notice.textContent = 'Default keys restored.'; render(); }
      } }, 'Restore defaults')),
      h('p.tiny.faint', 'Mouse: drag with the middle or right button to pan, wheel to zoom. Detonate and Pan right may share D: detonate only fires with a charge selected.'),
      wrap);
  }

  function displayTab() {
    const s = getSettings();
    const vol = slider({ min: 0, max: 1, step: 0.05, value: s.volume, format: v => Math.round(v * 100) + '%', oninput: v => updateSettings({ volume: v }) });
    const sfxV = slider({ min: 0, max: 1, step: 0.05, value: s.sfxVolume, format: v => Math.round(v * 100) + '%', oninput: v => updateSettings({ sfxVolume: v }) });
    const ui = slider({ min: UI_SCALE_RANGE[0], max: UI_SCALE_RANGE[1], step: 0.05, value: s.uiScale, format: v => Math.round(v * 100) + '%', oninput: v => { updateSettings({ uiScale: v }); applyDisplaySettings(document, { palette: !inGame }); } });
    const pal = segControl(PALETTE_CHOICES.map(p => ({ value: p, label: p === 'auto' ? 'Map default' : PALETTE_LABELS[p] })), s.palette, v => { updateSettings({ palette: v }); applyDisplaySettings(document, { palette: !inGame }); }, { label: 'Print preset' });
    const tog = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: !!getSettings()[key] });
      input.addEventListener('change', () => { updateSettings({ [key]: input.checked }); sfx.clack(); });
      return h('div.set-toggle', h('label.toggle', input, h('span.toggle-track'), label), hint ? h('span.hint', hint) : null);
    };
    return h('div.set-grid',
      h('div.vstack.gap-4',
        field('Master volume', vol.el),
        field('Battle effects', sfxV.el, 'Gunfire, sirens and explosions, relative to the master volume.'),
        tog('uiSounds', 'Typewriter sounds in menus')),
      h('div.vstack.gap-4',
        field('Interface scale', ui.el, 'Resizes every menu and the battle HUD.'),
        field('Print preset', pal.el, '"Map default" uses each map’s own colours in battle and paper in the menus.'),
        tog('reduceMotion', 'Reduce motion', 'Skips typewriter and stamp animations.')));
  }

  function simTab() {
    const s = getSettings();
    const note = h('div.perf-note');
    const showNote = (v) => {
      const p = perfNote(v);
      clear(note);
      note.append(h('span.stamp.stamp-sm.stamp-ink', p.tier[0]), h('span.small', `${fmtInt(p.per10k)} people on the map per 10,000 residents. ${p.tier[1]}`));
    };
    const pop = slider({ min: POP_SCALE_RANGE[0], max: POP_SCALE_RANGE[1], step: 0.05, value: s.popScale, format: v => Math.round(v * 100) + '%', oninput: v => { updateSettings({ popScale: v }); showNote(v); } });
    showNote(s.popScale);
    const tog = (key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: !!getSettings()[key] });
      input.addEventListener('change', () => { updateSettings({ [key]: input.checked }); sfx.clack(); });
      return h('div.set-toggle', h('label.toggle', input, h('span.toggle-track'), label), hint ? h('span.hint', hint) : null);
    };
    return h('div.set-grid',
      h('div.vstack.gap-3',
        field('Population scale', pop.el, 'How many residents appear as people. Money and score use the full population either way.'),
        note,
        inGame ? h('p.tiny.faint', 'A new population scale applies from the next exercise.') : null),
      h('div.vstack.gap-4',
        tog('autoPauseOnOutbreak', 'Pause when the outbreak starts', 'Gives you a moment to read the map after READY.'),
        tog('showTips', 'Show planning tips'),
        tog('edgePan', 'Pan when the mouse touches the screen edge')));
  }

  function recordsTab() {
    const p = getProgress();
    const t = p.totals;
    const allIn = h('input', { type: 'checkbox', checked: !!p.unlockAll });
    allIn.addEventListener('change', () => { unlockAll(allIn.checked); sfx.clack(); toast({ kind: 'info', title: allIn.checked ? 'Everything issued' : 'Campaign locks restored', body: allIn.checked ? 'All cities, items and difficulties are open.' : 'Items now follow campaign progress again.' }); });
    return h('div.set-grid',
      h('div.vstack.gap-2',
        h('span.label', 'Service record'),
        h('div.kv', h('span', 'Stages played'), h('i'), h('b', fmtInt(t.stagesPlayed))),
        h('div.kv', h('span', 'Won / lost'), h('i'), h('b', `${fmtInt(t.wins)} / ${fmtInt(t.losses)}`)),
        h('div.kv', h('span', 'Infected destroyed'), h('i'), h('b', fmtInt(t.kills))),
        h('div.kv', h('span', 'Civilians saved'), h('i'), h('b', fmtInt(t.saved))),
        h('div.kv', h('span', 'Evacuated by air and road'), h('i'), h('b', fmtInt(t.evacuated)))),
      h('div.vstack.gap-4',
        h('div.set-toggle', h('label.toggle', allIn, h('span.toggle-track'), 'Open every city and item'), h('span.hint', 'For practice. Badges you earn are still recorded.')),
        h('div.danger-box',
          h('span.label', 'Reset progress'),
          h('p.small', 'Erases every record, badge, unlock, Flawless mark and commendation in this browser. Settings and your library are kept.'),
          h('button.btn.btn-primary', { type: 'button', onclick: async () => {
            const ok = await confirmModal({ title: 'Reset all progress', no: 'Form OCP-99', danger: true, confirmLabel: 'Erase records',
              message: h('div', h('p', 'All campaign progress, records and commendations will be erased.'), h('p.small.muted', 'This cannot be undone.')) });
            if (ok) { resetProgress(); sfx.thump(); toast({ kind: 'info', stamp: 'Shredded', title: 'Progress reset', body: 'The office starts afresh.' }); render(); }
          } }, 'Reset progress…'))));
  }

  function render() {
    clear(folder.body);
    const id = folder.current;
    folder.body.appendChild(id === 'controls' ? controlsTab() : id === 'display' ? displayTab() : id === 'sim' ? simTab() : recordsTab());
  }

  folder.select(lastTab === 'records' && inGame ? 'controls' : lastTab);
  return { el: folder.el, destroy() { stopCapture(); }, get capturing() { return !!capture; } };
}

export function mount(root, app) {
  const frame = screenFrame({ form: 'OCP-3', title: 'Settings', sub: 'Saved in this browser as you change them', onBack: () => app.go('title') });
  root.appendChild(frame.el);
  const s = buildSettings();
  frame.body.appendChild(h('div.settings-wrap', s.el));
  return { destroy() { s.destroy(); } };
}

// In-game overlay; onClose when dismissed.
export function openSettingsOverlay(container, { onClose } = {}) {
  const s = buildSettings({ inGame: true });
  const closeBtn = h('button.btn', { type: 'button' }, 'Done', keycap('Esc'));
  const sheet = h('div.lo-sheet.settings-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    h('header.lo-head', h('div', h('span.form-no', 'Form OCP-3'), h('h2.lo-title', 'Settings')), closeBtn),
    s.el);
  const layer = h('div.lo-layer', sheet);
  const onKey = (e) => {
    if (s.capturing) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  function close() {
    window.removeEventListener('keydown', onKey, true);
    s.destroy();
    layer.remove();
    if (onClose) onClose();
  }
  closeBtn.addEventListener('click', close);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
  window.addEventListener('keydown', onKey, true);
  container.appendChild(layer);
  requestAnimationFrame(() => closeBtn.focus());
  return { close };
}
