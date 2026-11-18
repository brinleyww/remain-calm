// Campaign: regional plotting sheet with the six cities, and the dossier of the selected city.
import { CAMPAIGN, getCampaignCity, unlocksFor, campaignMapKey } from '../map/campaign.js';
import { DEFAULTS } from '../data/config.js';
import {
  cityUnlocked, cityCleared, stageAvailable, bestRecord, flawlessFor, difficultyUnlocked, campaignComplete,
  isUnlocked, getLastPlayed,
} from '../meta/progress.js';
import { getSettings } from '../meta/settings.js';
import { h, append, clear, fitCanvas, sfx, fmtInt, fmtPct, typeText, isTyping, keycap } from './dom.js';
import { screenFrame, difficultySeg, stageSeal, DIFF_LABEL } from './screen.js';
import { drawRegion, cityPixel } from './regionmap.js';
import { campaignMap } from './gen.js';
import { mapPreview, stagePopulations, civEstimate, WATER_LABEL } from './mapinfo.js';
import { itemName } from './names.js';

let lastDifficulty = 'normal';
const LABEL_SIDE = { 'millbrook': 'right', 'port-ashby': 'left', 'carrowmere': 'right', 'halden-cross': 'right', 'varra-isles': 'right', 'new-corrigan': 'top' };

function cityState(c) {
  if (!cityUnlocked(c.id)) return 'locked';
  return cityCleared(c.id) ? 'cleared' : 'open';
}

function clearedCount(c) {
  let n = 0;
  for (let k = 0; k < c.stages; k++) if (bestRecord(campaignMapKey(c.id), k)) n += bestRecord(campaignMapKey(c.id), k).badge ? 1 : 0;
  return n;
}

function nextStage(c) {
  for (let k = 0; k < c.stages; k++) if (!(bestRecord(campaignMapKey(c.id), k) || {}).badge) return stageAvailable(c.id, k) ? k : 0;
  return c.stages - 1;
}

export function mount(root, app, params) {
  const frame = screenFrame({ form: 'OCP-11', title: 'Campaign', sub: 'District of Varrow · six cities, held in order', onBack: () => app.go('title') });
  root.appendChild(frame.el);

  const defaultCity = (() => {
    if (params.city && getCampaignCity(params.city)) return params.city;
    const last = getLastPlayed();
    if (last && last.mode === 'campaign' && getCampaignCity(last.cityId)) return last.cityId;
    const open = CAMPAIGN.find(c => cityState(c) === 'open');
    return (open || CAMPAIGN[0]).id;
  })();
  let selected = defaultCity;
  let stage = params.city === selected && params.stage !== undefined ? Math.max(0, +params.stage | 0) : nextStage(getCampaignCity(selected));
  let difficulty = difficultyUnlocked(lastDifficulty) ? lastDifficulty : 'normal';
  let mapReq = 0;
  let currentMap = null;

  // ---------------- regional sheet
  const canvas = h('canvas.region-canvas');
  const pins = h('div.region-pins');
  const sheet = h('div.region-sheet', canvas, pins);
  const legend = h('div.region-legend',
    h('span', h('i.lg-route'), 'Campaign route'),
    h('span', h('i.lg-rail'), 'Railway'),
    h('span', h('i.lg-road'), 'Trunk road'),
    h('span', h('i.lg-locked'), 'Restricted'));
  const cartouche = h('div.cartouche',
    h('b', 'District of Varrow'),
    h('span', 'Evacuation planning sheet · 1 : 250 000'),
    h('span.form-no', 'OCP / RG-6'));
  const mapCol = h('div.region-col', h('div.region-frame', sheet, cartouche), legend);

  // ---------------- dossier
  const dossierBody = h('div.folder-body.dossier');
  const tab = h('button.tab', { type: 'button', 'aria-selected': 'true', tabIndex: -1 }, h('span.tab-no', '--'), 'City file');
  const dossier = h('div.folder.dossier-folder', h('div.tabs', tab), dossierBody);

  frame.body.appendChild(h('div.camp-grid', mapCol, dossier));

  const pinEls = new Map();
  for (const c of CAMPAIGN) {
    const btn = h('button.city-pin', { type: 'button', dataset: { city: c.id, side: LABEL_SIDE[c.id] || 'right' }, 'aria-label': c.name });
    btn.addEventListener('click', () => { sfx.clack(); select(c.id); });
    pins.appendChild(btn);
    pinEls.set(c.id, btn);
  }

  function renderPins() {
    for (const c of CAMPAIGN) {
      const btn = pinEls.get(c.id);
      const st = cityState(c);
      btn.className = 'city-pin is-' + st + (c.id === selected ? ' is-sel' : '');
      clear(btn);
      const n = clearedCount(c);
      append(btn, [
        h('span.pin-mark', h('b', String(c.index + 1).padStart(2, '0'))),
        h('span.pin-label',
          h('b', c.name),
          h('small', st === 'locked' ? 'Restricted' : `${n} / ${c.stages} stages`)),
        isFlawlessAny(c.id) ? h('span.pin-flaw', { title: 'Flawless' }, 'F') : null]);
    }
  }
  const isFlawlessAny = id => Object.keys(flawlessFor(id)).length > 0;

  let tf = null;
  function drawSheet() {
    const { ctx, w, h: hh } = fitCanvas(canvas);
    tf = drawRegion(ctx, w, hh, {
      palette: getSettings().palette === 'auto' ? 'paper' : getSettings().palette,
      cities: CAMPAIGN.map(c => ({ id: c.id, name: c.name, state: cityState(c), sizeKm: c.sizeKm })),
      selected,
    });
    for (const c of CAMPAIGN) {
      const [x, y] = cityPixel(c.id, tf);
      const b = pinEls.get(c.id);
      b.style.left = x + 'px';
      b.style.top = y + 'px';
    }
  }
  const ro = new ResizeObserver(() => drawSheet());
  ro.observe(sheet);

  // ---------------- dossier rendering
  const preview = mapPreview({ cls: 'dossier-map', label: 'Plotting city' });
  let stageRows = [];
  let startBtn = null;

  function renderDossier(animate) {
    const c = getCampaignCity(selected);
    const st = cityState(c);
    const key = campaignMapKey(c.id);
    tab.firstChild.textContent = 'File ' + String(c.index + 1).padStart(2, '0');
    clear(dossierBody);
    stageRows = [];
    startBtn = null;

    const statusStamp = st === 'cleared' ? h('span.stamp.stamp-green.tilt-3.dossier-stamp', 'Secured')
      : st === 'locked' ? h('span.stamp.tilt-1.dossier-stamp', 'Restricted') : h('span.stamp.stamp-blue.tilt-2.dossier-stamp', 'Active');
    const flaw = flawlessFor(c.id);
    const flawSeal = Object.keys(flaw).length
      ? h('span.seal.flaw-seal', { style: { '--tier': 'var(--approve)', '--size': '5.4rem', '--rot': '-9deg' }, title: 'Flawless on ' + Object.keys(flaw).map(d => DIFF_LABEL[d]).join(', ') },
        'Flawless', h('small', Object.keys(flaw).map(d => DIFF_LABEL[d]).join(' · ')))
      : null;
    const blurb = h('p.dossier-blurb');
    const facts = h('div.dossier-facts',
      h('span', `${c.sizeKm.toFixed(1)} km sheet`), h('span', WATER_LABEL[c.water] || c.water), h('span', `${c.stages} stages`));
    const popLine = h('div.fact-pop.tiny.muted', st === 'locked' ? 'Population figures withheld' : 'Counting residents…');

    const plate = h('div.dossier-plate', preview.el, statusStamp, flawSeal, h('span.map-caption.tiny.cap-stage', st === 'locked' ? 'Restricted' : `Stage ${stage + 1} boundary`));
    append(dossierBody, [
      h('div.dossier-top',
        h('div.dossier-info', h('span.label', `City ${c.index + 1} of ${CAMPAIGN.length}`), h('h2.dossier-name', c.name), facts, popLine),
        plate),
      blurb]);
    if (animate) typeText(blurb, c.blurb, { cps: 260, sound: false }); else blurb.textContent = c.blurb;

    if (st === 'locked') {
      const prev = CAMPAIGN[c.index - 1];
      dossierBody.append(
        h('div.restricted',
          h('div.restricted-hatch'),
          h('p', h('b', 'Access restricted. '), `Clear every stage of ${prev.name} with a bronze badge or better to open this file.`),
          h('div.restricted-list', CAMPAIGN.slice(0, c.index).filter(p => !cityCleared(p.id)).map(p =>
            h('button.btn.btn-sm', { type: 'button', onclick: () => select(p.id) }, `Open ${p.name}`)))));
      preview.setEmpty('Plan withheld');
      preview.redraw();
      return;
    }

    // map + stage list
    const diffRow = h('div.diff-row',
      h('span.label', 'Difficulty'),
      difficultySeg(difficulty, (d) => { difficulty = d; lastDifficulty = d; renderStages(); }, (d) => (difficultyUnlocked(d, true) ? null : 'Finish the campaign to unlock')).el,
      !campaignComplete() ? h('span.tiny.faint', 'Hardcore and Ultra open once all six cities are secured.') : null);
    const table = h('div.stage-list', { role: 'listbox', 'aria-label': 'Stages' });
    dossierBody.append(diffRow, table);

    function renderStages() {
      clear(table);
      stageRows = [];
      for (let k = 0; k < c.stages; k++) {
        const avail = stageAvailable(c.id, k);
        const recD = bestRecord(key, k, difficulty);
        const recAny = bestRecord(key, k);
        const rewards = unlocksFor(c.id, k);
        const row = h('button.stage-row' + (k === stage ? '.is-sel' : '') + (avail ? '' : '.is-locked'), { type: 'button', role: 'option', 'aria-selected': String(k === stage), disabled: !avail, dataset: { k } },
          stageSeal(recD ? recD.badge : null, String(k + 1)),
          h('span.stage-main',
            h('b', `Stage ${k + 1}`),
            h('small', avail ? (recD ? `Best ${fmtPct(recD.pct)} saved · ${recD.wins} won, ${recD.losses} lost` : recAny ? `Cleared on ${DIFF_LABEL[recAny.difficulty]}` : 'Not yet attempted') : 'Clear the previous stage')),
          h('span.stage-reward', rewards.length
            ? rewards.map(id => h('span.chip' + (isUnlocked(id) ? '.is-on' : ''), { title: isUnlocked(id) ? 'Issued' : 'Issued on clearing this stage' }, itemName(id)))
            : h('span.tiny.faint', '—')));
        row.addEventListener('click', () => { if (!avail) return; sfx.clack(); setStage(k); });
        row.addEventListener('dblclick', () => { if (avail) start(); });
        table.appendChild(row);
        stageRows.push(row);
      }
    }
    renderStages();

    const loadBtn = h('button.btn', { type: 'button', onclick: () => requisition() }, 'Requisition', keycap('L'));
    startBtn = h('button.btn.btn-primary.btn-begin', { type: 'button', onclick: () => start() }, `Begin stage ${stage + 1}`, keycap('Enter'));
    dossierBody.append(h('div.dossier-actions', loadBtn, startBtn));

    // async map for preview + population
    const req = ++mapReq;
    currentMap = null;
    preview.setLoading('Plotting ' + c.name + '…');
    startBtn.disabled = true;
    campaignMap(c.id).then(map => {
      if (req !== mapReq || !root.isConnected) return;
      currentMap = map;
      preview.set(map, stage);
      const pops = stagePopulations(map);
      const civ = civEstimate(pops[pops.length - 1], getSettings().popScale);
      const pop = dossierBody.querySelector('.fact-pop');
      if (pop) pop.textContent = `${fmtInt(pops[pops.length - 1])} residents · ~${fmtInt(civ.n)} on the map`;
      if (startBtn) startBtn.disabled = false;
    }).catch(err => {
      if (req !== mapReq) return;
      preview.setEmpty('Plotting failed: ' + err.message);
    });
  }

  function setStage(k) {
    stage = k;
    stageRows.forEach((r, i) => { r.classList.toggle('is-sel', i === k); r.setAttribute('aria-selected', String(i === k)); });
    if (startBtn) startBtn.firstChild.textContent = `Begin stage ${k + 1}`;
    const cap = dossierBody.querySelector('.cap-stage');
    if (cap) cap.textContent = `Stage ${k + 1} boundary`;
    if (currentMap) preview.setStage(k);
  }

  function select(id, animate = true) {
    if (id !== selected) {
      selected = id;
      stage = nextStage(getCampaignCity(id));
    }
    renderPins();
    drawSheet();
    renderDossier(animate);
  }

  async function requisition() {
    const c = getCampaignCity(selected);
    if (cityState(c) === 'locked') return;
    sfx.page();
    await app.editLoadout({ map: currentMap, stage, cfg: DEFAULTS, difficulty });
  }

  function start() {
    const c = getCampaignCity(selected);
    if (!currentMap || !stageAvailable(c.id, stage) || !difficultyUnlocked(difficulty, true)) return;
    sfx.thump();
    app.launch({ map: currentMap, mode: 'campaign', difficulty, cityId: c.id, startStage: stage, returnTo: ['campaign', { city: c.id }] });
  }

  renderPins();
  renderDossier(false);
  requestAnimationFrame(() => { const b = pinEls.get(selected); if (b) b.focus({ preventScroll: true }); });

  return {
    onKey(e) {
      if (isTyping(e)) return false;
      const idx = CAMPAIGN.findIndex(c => c.id === selected);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const n = CAMPAIGN.length;
        const next = CAMPAIGN[(idx + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
        sfx.clack(); select(next.id); pinEls.get(next.id).focus({ preventScroll: true });
        return true;
      }
      if (/^[1-6]$/.test(e.key)) { const c = CAMPAIGN[+e.key - 1]; if (c) { sfx.clack(); select(c.id); } return true; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const c = getCampaignCity(selected);
        let k = stage;
        for (let step = 0; step < c.stages; step++) {
          k = (k + (e.key === 'ArrowDown' ? 1 : c.stages - 1)) % c.stages;
          if (stageAvailable(c.id, k)) break;
        }
        if (stageAvailable(c.id, k)) { sfx.key(); setStage(k); }
        return true;
      }
      if (e.key === 'Enter') { if (document.activeElement && document.activeElement.classList.contains('btn') && document.activeElement !== startBtn) return false; start(); return true; }
      if (e.key === 'l' || e.key === 'L') { requisition(); return true; }
      return false;
    },
    destroy() { ro.disconnect(); preview.destroy(); mapReq++; },
  };
}
