// Co-op lobby: pick host or guest, swap the two link codes, the host picks the city (sent to the guest in
// chunks), then both start together.
// openCoopLobby(container, { onStart({ link, map, role, owner, difficulty, mutators, makeDriver }), onExit() }) -> { destroy }
import { createHost, joinWithCode, LockstepDriver, PROTOCOL, reasonText } from '../net/coop.js';
import { generateCity, WATER_TYPES } from '../map/citygen.js';
import { CAMPAIGN, getCampaignMap } from '../map/campaign.js';
import { listItems, getItem } from '../map/library.js';
import { serializeMap, parseMap, normalizeMap, mapStats } from '../map/format.js';
import { drawMinimap } from '../render/maprender.js';
import { MUTATOR_PRESETS } from '../data/config.js';
import { hashStr } from '../util/rng.js';
import { crowdMutators } from '../meta/settings.js';
import { el, copyText, ensureEditorCss } from './editor_dom.js';

const DIFFS = [['normal', 'Normal'], ['hardcore', 'Hardcore'], ['ultra', 'Ultra']];

export function openCoopLobby(container, opts = {}) {
  ensureEditorCss();
  const root = el('div', { class: 'coop-root paper-bg' });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  if (container.clientHeight < 200) root.classList.add('coop-fixed');

  const S = {
    role: null, link: null, linkState: 'none', partner: false, handed: false, destroyed: false,
    map: null, mapText: '', mapId: 0, src: 'gen', difficulty: 'normal', muts: new Set(),
    sent: 0, partnerHas: 0, progress: 0, brief: null, guestMap: null, guestMapId: 0, busy: false,
    gen: { seed: String((Math.random() * 1e6) | 0), size: '2', water: 'river', stages: '5' },
  };

  // ---------------------------------------------------------------- skeleton
  const lamps = {};
  const lampRow = (id, label) => {
    const dot = el('i', { class: 'coop-lamp', 'data-s': 'off' });
    const note = el('small');
    lamps[id] = { dot, note };
    return el('li', null, dot, el('span', { text: label }), note);
  };
  const lampList = el('ul', { class: 'coop-lamps' }, lampRow('office', 'Office'), lampRow('code', 'Codes'), lampRow('link', 'Link'), lampRow('partner', 'Partner'), lampRow('city', 'City'));
  const pingEl = el('span', { class: 'small muted', text: 'Ping --' });
  const resetBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => resetAll() }, 'Start over');
  const backBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => exit() }, 'Back');

  const step1 = card('01', 'Choose your office');
  const step2 = card('02', 'Exchange codes');
  const step3 = card('03', 'The city');
  const step4 = card('04', 'Begin');

  root.append(el('div', { class: 'coop-sheet' },
    el('div', { class: 'coop-top' },
      el('div', null, el('div', { class: 'form-no', text: 'FORM RC-22 · JOINT OPERATIONS' }), el('h1', { text: 'Two offices, one city' }),
        el('p', { text: 'Link up straight with a partner by swapping two codes: no server, no account. Money and command points are split evenly; each office runs its own zones, walls and units.' })),
      backBtn),
    el('div', { class: 'coop-grid' },
      el('div', { class: 'coop-steps' }, step1.el, step2.el, step3.el, step4.el),
      el('aside', { class: 'coop-side' },
        el('div', { class: 'card raised' }, el('div', { class: 'card-head' }, el('h3', { class: 'card-title', text: 'Line status' }), pingEl), lampList,
          el('div', { class: 'hstack', style: 'margin-top:10px' }, resetBtn)),
        el('div', { class: 'card flat small' }, el('p', { class: 'small', style: 'margin:0', text: 'Codes only work once and only while both windows stay open. If the link will not open, start over for fresh codes; some strict office or school networks block direct links.' }))))));
  container.append(root);

  function card(no, title) {
    const body = el('div', { class: 'vstack gap-3' });
    const titleEl = el('h3', { class: 'card-title', text: title, 'data-no': no });
    const e = el('section', { class: 'card coop-step' }, el('div', { class: 'card-head' }, titleEl), body);
    return { el: e, body, titleEl, lock(v) { e.classList.toggle('is-locked', !!v); } };
  }

  function lamp(id, s, note = '') { lamps[id].dot.dataset.s = s; lamps[id].note.textContent = note; }

  // ---------------------------------------------------------------- step 1: role
  function renderRole() {
    const b = (role, title, sub) => el('button', { class: 'coop-role', type: 'button', 'aria-pressed': String(S.role === role), dataset: { role }, disabled: !!S.role && S.role !== role,
      onclick: () => { if (!S.role) pickRole(role); } }, el('b', { text: title }), el('span', { text: sub }));
    step1.body.replaceChildren(el('div', { class: 'coop-roles' },
      b('host', 'Host the operation', 'You choose the city and send your partner an invitation code.'),
      b('guest', 'Join a partner', 'Paste the invitation code your partner sent you.')));
  }

  function pickRole(role) {
    S.role = role;
    lamp('office', 'ok', role === 'host' ? 'host' : 'guest');
    renderRole();
    renderCodes();
    renderCity();
    renderStart();
    if (role === 'host') startHost();
  }

  // ---------------------------------------------------------------- step 2: codes
  const errLine = (text = '') => el('p', { class: 'coop-err', role: 'alert', text });
  let codeErr = errLine();
  const setCodeErr = msg => { S.codeErr = msg || ''; codeErr.textContent = S.codeErr; };

  function codeBox(value, key, ro = true) {
    return el('textarea', { class: 'input coop-code', rows: 4, readOnly: ro, value, dataset: { key }, spellcheck: 'false', placeholder: ro ? '' : 'RC1.…' });
  }

  function copyRow(ta) {
    const note = el('span', { class: 'small muted' });
    return el('div', { class: 'coop-row' },
      el('button', { class: 'btn btn-sm', type: 'button', dataset: { act: 'copy-' + ta.dataset.key }, onclick: async () => { note.textContent = (await copyText(ta.value, ta)) ? 'Copied.' : 'Select the code and copy it.'; } }, 'Copy code'), note);
  }

  function renderCodes() {
    step2.lock(!S.role);
    codeErr = errLine(S.codeErr);
    const B = step2.body;
    B.replaceChildren();
    if (!S.role) { B.append(el('p', { class: 'small muted', text: 'Pick an office first.' })); return; }
    if (S.linkState === 'open') {
      B.append(el('div', { class: 'coop-row' }, el('span', { class: 'stamp stamp-sm stamp-green tilt-2', text: 'Linked' }),
        el('span', { class: 'small', text: 'Direct line open. The codes are spent; nothing more to paste.' })));
      return;
    }
    if (S.linkState === 'closed' || S.linkState === 'failed') {
      B.append(codeErr, el('div', { class: 'coop-row' }, el('button', { class: 'btn btn-go', type: 'button', dataset: { act: 'restart' }, onclick: () => resetAll() }, 'Start over with fresh codes')));
      return;
    }
    if (S.role === 'host') {
      if (!S.link) { B.append(el('p', { class: 'small', text: 'Preparing your invitation code…' })); return; }
      const offer = codeBox(S.link.offerCode, 'offer');
      const answer = codeBox('', 'answer', false);
      const connect = el('button', { class: 'btn btn-go', type: 'button', dataset: { act: 'connect' }, disabled: S.linkState === 'open' || S.linkState === 'connecting',
        onclick: async () => {
          setCodeErr('');
          connect.disabled = true;
          try {
            lamp('link', 'wait', 'connecting');
            await S.link.acceptAnswer(answer.value);
          } catch (e) { setCodeErr(e.message || String(e)); if (S.link && S.link.state !== 'closed' && S.link.state !== 'failed') connect.disabled = false; lamp('link', S.link && S.link.state === 'failed' ? 'bad' : 'off', ''); }
        } }, S.linkState === 'open' ? 'Linked' : 'Connect');
      B.append(
        el('div', { class: 'field' }, el('label', { text: '1 · Send this invitation code to your partner' }), offer, copyRow(offer)),
        el('div', { class: 'field' }, el('label', { text: '2 · Paste the reply code they send back' }), answer),
        el('div', { class: 'coop-row' }, connect), codeErr);
      return;
    }
    const offer = codeBox('', 'invite', false);
    const make = el('button', { class: 'btn btn-go', type: 'button', dataset: { act: 'reply' }, disabled: !!S.link,
      onclick: async () => {
        setCodeErr('');
        make.disabled = true;
        make.textContent = 'Preparing…';
        try {
          lamp('code', 'wait', 'preparing');
          const link = await joinWithCode(offer.value);
          if (S.destroyed) { link.close(); return; }
          attach(link);
          lamp('code', 'ok', 'reply ready');
          lamp('link', 'wait', 'waiting for host');
          renderCodes();
        } catch (e) { setCodeErr(e.message || String(e)); make.disabled = false; make.textContent = 'Make reply code'; lamp('code', 'bad', ''); }
      } }, 'Make reply code');
    B.append(el('div', { class: 'field' }, el('label', { text: '1 · Paste the host\'s invitation code' }), offer), el('div', { class: 'coop-row' }, make));
    if (S.link) {
      offer.value = '(invitation accepted)';
      offer.readOnly = true;
      const reply = codeBox(S.link.answerCode, 'reply');
      B.append(el('div', { class: 'field' }, el('label', { text: '2 · Send this reply code back to the host' }), reply, copyRow(reply),
        el('div', { class: 'hint', text: S.linkState === 'open' ? 'Linked.' : 'The link opens as soon as the host pastes it.' })));
    }
    B.append(codeErr);
  }

  async function startHost() {
    lamp('code', 'wait', 'preparing');
    try {
      const link = await createHost();
      if (S.destroyed || S.role !== 'host') { link.close(); return; }
      attach(link);
      lamp('code', 'ok', 'invitation ready');
      renderCodes();
    } catch (e) {
      lamp('code', 'bad', '');
      step2.body.replaceChildren(el('p', { class: 'coop-err', text: e.message || String(e) }));
    }
  }

  // ---------------------------------------------------------------- link wiring
  let pingTimer = 0;
  function attach(link) {
    S.link = link;
    S.linkState = link.state;
    link.onState = st => {
      S.linkState = st;
      if (st === 'connecting') lamp('link', 'wait', 'connecting');
      if (st === 'open') {
        lamp('link', 'ok', 'open');
        link.send({ k: 'hello', v: PROTOCOL, role: S.role });
        renderCodes();
        renderCity();
        renderStart();
      }
    };
    link.onClose = reason => {
      if (S.handed) return;
      S.linkState = 'closed';
      S.partner = false;
      lamp('link', 'bad', reasonText(reason).toLowerCase());
      lamp('partner', 'bad', 'gone');
      setCodeErr(reasonText(reason) + '.');
      renderCodes();
      renderCity();
      renderStart();
    };
    link.onMessage = onMessage;
    link.setLargeHandler(onLarge);
    link.onLargeProgress = (tag, f) => { S.progress = f; updateProgress(); };
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (S.link && S.link.open) pingEl.textContent = `Ping ${Math.round(S.link.rtt)} ms`; }, 1000);
  }

  function onMessage(m) {
    if (!m || typeof m.k !== 'string') return;
    if (m.k === 'hello') {
      if (m.v !== PROTOCOL) { setCodeErr('Your partner is running a different version of the game.'); lamp('partner', 'bad', 'version'); return; }
      S.partner = true;
      lamp('partner', 'ok', m.role === 'host' ? 'host' : 'guest');
      renderCity();
      renderStart();
      return;
    }
    if (S.role === 'host') {
      if (m.k === 'mapOk' && m.id === S.mapId) { S.partnerHas = m.id; lamp('city', 'ok', 'partner has it'); renderStart(); }
      if (m.k === 'mapErr' && m.id === S.mapId) { lamp('city', 'bad', 'rejected'); S.partnerHas = 0; cityErr.textContent = 'Your partner could not open the map: ' + (m.reason || 'unknown problem'); renderStart(); }
      return;
    }
    if (m.k === 'brief') {
      S.brief = m;
      if (S.guestMapId !== m.id) { S.guestMap = null; S.progress = 0; lamp('city', 'wait', 'receiving'); }
      else S.link.send({ k: 'mapOk', id: m.id });
      renderCity();
      renderStart();
      return;
    }
    if (m.k === 'start') {
      if (!S.guestMap || m.id !== S.guestMapId) return;
      handOver({ difficulty: m.difficulty, mutators: m.mutators });
    }
  }

  function onLarge(tag, text) {
    if (S.role !== 'guest' || !tag.startsWith('map:')) return;
    const id = +tag.slice(4);
    if (text === null) { lamp('city', 'bad', 'damaged'); S.link.send({ k: 'mapErr', id, reason: 'the transfer arrived damaged' }); return; }
    try {
      const map = parseMap(text);
      S.guestMap = map;
      S.guestMapId = id;
      lamp('city', 'ok', 'received');
      S.link.send({ k: 'mapOk', id });
    } catch (e) {
      lamp('city', 'bad', 'invalid');
      S.link.send({ k: 'mapErr', id, reason: e.message });
    }
    renderCity();
    renderStart();
  }

  // ---------------------------------------------------------------- step 3: city
  let cityErr = errLine();
  let progressBar = null;
  function updateProgress() { if (progressBar) progressBar.style.setProperty('--v', String(S.progress)); }

  function preview(map) {
    const box = el('div', { class: 'coop-preview' });
    const cv = el('canvas');
    box.append(cv);
    requestAnimationFrame(() => {
      if (!map || !cv.isConnected) return;
      const dpr = window.devicePixelRatio || 1, r = box.getBoundingClientRect();
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawMinimap(g, map, r.width, r.height, { palette: map.palette, stage: 0 });
    });
    return box;
  }

  function mapFacts(map, extra = []) {
    const s = mapStats(map);
    const kv = (k, v) => el('div', { class: 'kv' }, el('span', { text: k }), el('i'), el('b', { text: v }));
    return el('div', null, kv('City', map.name), kv('Sheet', `${(map.w / 1000).toFixed(1)} × ${(map.h / 1000).toFixed(1)} km`), kv('Stages', String(map.levels.length)),
      kv('Buildings', s.buildings.toLocaleString('en-GB')), kv('Nominal population', s.nominalPop.toLocaleString('en-GB')), extra);
  }

  function renderCity() {
    const open = S.linkState === 'open';
    step3.lock(!S.role || !open || !S.partner);
    cityErr = errLine();
    const B = step3.body;
    B.replaceChildren();
    if (!S.role || !open) { B.append(el('p', { class: 'small muted', text: 'Available once the link is open.' })); return; }
    if (S.role === 'guest') {
      step3.titleEl.textContent = 'Briefing';
      if (!S.brief) { B.append(el('p', { class: 'small muted', text: 'Waiting for the host to choose a city…' })); return; }
      const b = S.brief;
      progressBar = el('div', { class: 'coop-meter' }, el('i'));
      const muts = (b.mutNames || []).join(', ') || 'none';
      B.append(el('div', { class: 'coop-mapbox' },
        el('div', { class: 'vstack gap-2' },
          S.guestMap ? mapFacts(S.guestMap) : el('div', null, el('div', { class: 'kv' }, el('span', { text: 'City' }), el('i'), el('b', { text: String(b.name || '') })),
            el('p', { class: 'small', text: 'Receiving the map…' }), progressBar),
          el('div', { class: 'kv' }, el('span', { text: 'Difficulty' }), el('i'), el('b', { text: (DIFFS.find(d => d[0] === b.difficulty) || DIFFS[0])[1] })),
          el('div', { class: 'kv' }, el('span', { text: 'Mutators' }), el('i'), el('b', { text: muts }))),
        S.guestMap ? preview(S.guestMap) : el('div', { class: 'coop-preview' })), cityErr);
      updateProgress();
      return;
    }
    step3.titleEl.textContent = 'The city';
    const srcSeg = el('div', { class: 'seg coop-srcs', role: 'radiogroup' },
      [['gen', 'Generated'], ['lib', 'Library'], ['camp', 'Campaign city']].map(([v, t]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(S.src === v), dataset: { src: v }, onclick: () => { S.src = v; renderCity(); } }, t)));
    const form = el('div', { class: 'vstack gap-3' });
    if (S.src === 'gen') {
      const f = (lab, input) => el('div', { class: 'field' }, el('label', { text: lab }), input);
      const G = S.gen;
      const keep = (k) => e => { G[k] = e.target.value; };
      const seed = el('input', { class: 'input', type: 'text', maxlength: 40, value: G.seed, dataset: { key: 'gen-seed' }, oninput: keep('seed') });
      const size = el('select', { class: 'select', value: G.size, dataset: { key: 'gen-size' }, onchange: keep('size') }, [1, 1.5, 2, 3, 4].map(v => el('option', { value: String(v) }, `${v} × ${v} km`)));
      const water = el('select', { class: 'select', value: G.water, dataset: { key: 'gen-water' }, onchange: keep('water') }, WATER_TYPES.map(w => el('option', { value: w }, w[0].toUpperCase() + w.slice(1))));
      const stages = el('select', { class: 'select', value: G.stages, dataset: { key: 'gen-stages' }, onchange: keep('stages') }, [3, 4, 5, 6, 7].map(c => el('option', { value: String(c) }, String(c))));
      const go = el('button', { class: 'btn', type: 'button', dataset: { act: 'gen' }, onclick: async () => {
        go.disabled = true; go.textContent = 'Drafting…';
        await new Promise(r => setTimeout(r, 30));
        try { setMap(generateCity({ seed: G.seed.trim() || 1, sizeKm: +G.size, water: G.water, stages: +G.stages, density: 0.6, bridges: 3 })); }
        catch (e) { cityErr.textContent = e.message; }
        go.disabled = false; go.textContent = 'Draft city';
      } }, 'Draft city');
      form.append(el('div', { class: 'ed-grid2' }, f('Seed', seed), f('Size', size), f('Water', water), f('Stages', stages)), el('div', { class: 'coop-row' }, go));
    } else if (S.src === 'lib') {
      const sel = el('select', { class: 'select coop-libsel', dataset: { key: 'lib' } }, el('option', { value: '' }, 'Reading the library…'));
      listItems({ type: 'map', sort: 'newest' }).then(items => {
        sel.replaceChildren(el('option', { value: '' }, items.length ? 'Choose a saved map' : 'The library has no maps'), ...items.map(i => el('option', { value: i.id }, i.name)));
      }, e => { cityErr.textContent = e.message; });
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        try { const it = await getItem(sel.value); if (it) setMap(it.data); } catch (e) { cityErr.textContent = e.message; }
      });
      form.append(el('div', { class: 'field' }, el('label', { text: 'Saved map' }), sel));
    } else {
      const sel = el('select', { class: 'select coop-libsel', dataset: { key: 'camp' } }, el('option', { value: '' }, 'Choose a city'), CAMPAIGN.map(c => el('option', { value: c.id }, c.name)));
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        await new Promise(r => setTimeout(r, 20));
        try { const m = getCampaignMap(sel.value); setMap({ ...m, welcome: m.welcome || (CAMPAIGN.find(c => c.id === sel.value) || {}).welcome || '' }); } catch (e) { cityErr.textContent = e.message; }
      });
      form.append(el('div', { class: 'field' }, el('label', { text: 'Campaign city' }), sel));
    }
    const diffSeg = el('div', { class: 'seg', role: 'radiogroup' }, DIFFS.map(([v, t]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(S.difficulty === v), dataset: { diff: v }, onclick: () => { S.difficulty = v; resendBrief(); renderCity(); } }, t)));
    const muts = el('div', { class: 'coop-muts' }, Object.entries(MUTATOR_PRESETS).map(([id, m]) =>
      el('label', { class: 'check', title: m.desc }, el('input', { type: 'checkbox', checked: S.muts.has(id), onchange: e => { if (e.target.checked) S.muts.add(id); else S.muts.delete(id); resendBrief(); renderStart(); } }), m.name)));
    const send = el('button', { class: 'btn btn-go', type: 'button', dataset: { act: 'send' }, disabled: !S.map || S.busy || (S.sent === S.mapId && S.mapId !== 0), onclick: () => sendMap() },
      S.busy ? 'Sending…' : S.sent && S.sent === S.mapId ? 'Sent' : 'Send to partner');
    progressBar = el('div', { class: 'coop-meter' }, el('i'));
    B.append(srcSeg, el('div', { class: 'coop-mapbox' }, el('div', { class: 'vstack gap-3' }, form, S.map ? mapFacts(S.map) : el('p', { class: 'small muted', text: 'No city chosen yet.' })), preview(S.map)),
      el('div', { class: 'field' }, el('label', { text: 'Difficulty' }), diffSeg),
      el('div', { class: 'field' }, el('label', { text: 'Mutators' }), muts),
      el('div', { class: 'coop-row' }, send, S.busy ? el('div', { class: 'grow' }, progressBar) : null), cityErr);
    updateProgress();
  }

  function setMap(map) {
    const text = serializeMap(normalizeMap(map));
    S.map = parseMap(text);
    S.mapText = text;
    S.mapId = (hashStr(text) || 1) >>> 0;
    S.partnerHas = 0;
    lamp('city', 'wait', 'chosen');
    renderCity();
    renderStart();
  }

  function briefMsg() {
    const muts = [...S.muts].filter(id => MUTATOR_PRESETS[id]);
    return {
      k: 'brief', id: S.mapId, name: S.map.name, w: S.map.w, h: S.map.h, stages: S.map.levels.length, bytes: S.mapText.length,
      difficulty: S.difficulty, mutators: muts.flatMap(id => MUTATOR_PRESETS[id].lines), mutNames: muts.map(id => MUTATOR_PRESETS[id].name),
    };
  }

  function resendBrief() {
    if (S.role === 'host' && S.sent && S.sent === S.mapId && S.link && S.link.open) { S.partnerHas = 0; S.link.send(briefMsg()); renderStart(); }
  }

  async function sendMap() {
    if (!S.map || !S.link || !S.link.open) return;
    S.busy = true;
    S.progress = 0;
    lamp('city', 'wait', 'sending');
    renderCity();
    const id = S.mapId;
    try {
      S.link.send(briefMsg());
      await S.link.sendLarge('map:' + id, S.mapText, f => { S.progress = f; updateProgress(); });
      S.sent = id;
      lamp('city', 'wait', 'awaiting partner');
    } catch (e) {
      cityErr.textContent = e.message || String(e);
      lamp('city', 'bad', 'failed');
    }
    S.busy = false;
    renderCity();
    renderStart();
  }

  // ---------------------------------------------------------------- step 4: start
  function renderStart() {
    const B = step4.body;
    B.replaceChildren();
    const ready = S.role === 'host' && S.linkState === 'open' && S.partner && S.map && S.partnerHas === S.mapId && S.mapId;
    step4.lock(!S.role || S.linkState !== 'open');
    if (S.role === 'guest') {
      B.append(el('p', { class: 'small', text: S.guestMap ? 'Ready. The host starts the operation.' : 'Waiting for the map.' }));
      if (S.guestMap) B.append(el('span', { class: 'stamp stamp-sm stamp-green tilt-2', text: 'Standing by' }));
      return;
    }
    B.append(el('p', { class: 'small', text: ready ? 'Both offices have the city. Start when ready; you will plan together and READY needs both of you.' : 'Send the city to your partner first.' }),
      el('button', { class: 'btn btn-primary btn-lg coop-start', type: 'button', dataset: { act: 'start' }, disabled: !ready, onclick: () => {
        const b = briefMsg(), mutators = [...crowdMutators(), ...b.mutators];
        S.link.send({ k: 'start', id: S.mapId, difficulty: b.difficulty, mutators });
        handOver({ difficulty: b.difficulty, mutators });
      } }, 'Begin operation'));
  }

  function handOver(settings) {
    if (S.handed) return;
    S.handed = true;
    const link = S.link, owner = S.role === 'host' ? 0 : 1;
    link.onMessage = null;
    link.onState = null;
    link.onClose = null;
    link.setLargeHandler(null);
    link.onLargeProgress = null;
    const map = S.role === 'host' ? S.map : S.guestMap;
    const payload = {
      link, map, role: S.role, owner,
      difficulty: DIFFS.some(d => d[0] === settings.difficulty) ? settings.difficulty : 'normal',
      mutators: Array.isArray(settings.mutators) ? settings.mutators.filter(l => typeof l === 'string').slice(0, 200) : [],
      makeDriver: (world, o) => new LockstepDriver(world, link, owner, o),
    };
    destroy();
    if (opts.onStart) opts.onStart(payload);
  }

  // ---------------------------------------------------------------- lifecycle
  function resetAll() {
    if (S.link && !S.handed) S.link.close();
    clearInterval(pingTimer);
    Object.assign(S, { codeErr: '', role: null, link: null, linkState: 'none', partner: false, map: null, mapText: '', mapId: 0, sent: 0, partnerHas: 0, progress: 0, brief: null, guestMap: null, guestMapId: 0, busy: false });
    for (const id of Object.keys(lamps)) lamp(id, 'off');
    pingEl.textContent = 'Ping --';
    step3.titleEl.textContent = 'The city';
    renderRole(); renderCodes(); renderCity(); renderStart();
  }

  function exit() {
    destroy();
    if (opts.onExit) opts.onExit();
  }

  function destroy() {
    if (S.destroyed) return;
    S.destroyed = true;
    clearInterval(pingTimer);
    if (S.link && !S.handed) S.link.close('left');
    root.remove();
  }

  renderRole(); renderCodes(); renderCity(); renderStart();
  return { destroy, get state() { return { role: S.role, link: S.linkState, partner: S.partner, mapId: S.mapId, partnerHas: S.partnerHas, guestMapId: S.guestMapId }; } };
}
