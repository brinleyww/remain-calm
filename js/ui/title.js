// Title bulletin + directory (main menu).
import { h, keycap, sfx, typeText, fmtDate, isTyping } from './dom.js';
import { campaignSummary, getLastPlayed, getProgress, stageAvailable } from '../meta/progress.js';
import { achievementCount } from '../meta/achievements.js';
import { getCampaignCity } from '../map/campaign.js';
import { DIFF_LABEL } from './screen.js';
import { VERSION } from '../version.js';

let introPlayed = false;

const DIRECTIVES = [
  'Stay indoors until a warden calls at your door.',
  'Walk, do not run, to the nearest marked gate.',
  'Report anyone who has been bitten.',
  'Keep this notice for future reference.',
];

export function mount(root, app) {
  const sum = campaignSummary();
  const ach = achievementCount();
  const last = getLastPlayed();
  const today = new Date();

  const entries = [
    { id: 'campaign', name: 'Campaign', note: `${sum.cleared} / ${sum.stages} stages`, go: () => app.go('campaign') },
    { id: 'freeplay', name: 'Free Play', note: 'Any city, your rules', go: () => app.go('freeplay') },
    { id: 'realplace', name: 'Real Place', note: 'Your own town, from the map', go: () => app.go('freeplay', { tab: 'osm' }) },
    { id: 'daily', name: 'Daily Challenge', note: fmtDate(today.getTime()), go: () => app.go('daily') },
    { id: 'sandbox', name: 'Sandbox', note: 'Unlimited funds', go: () => app.go('freeplay', { sandbox: 1 }) },
    { id: 'coop', name: 'Co-operative', note: 'Two offices, one city', go: () => app.go('coop') },
    { id: 'editor', name: 'Map Editor', note: 'Draw your own district', go: () => app.go('editor') },
    { id: 'library', name: 'Library', note: 'Maps, mutators, scenarios', go: () => app.go('library') },
    { id: 'settings', name: 'Settings', note: 'Keys, sound, display', go: () => app.go('settings') },
    { id: 'achievements', name: 'Commendations', note: `${ach.awarded} / ${ach.total}`, go: () => app.go('achievements') },
    { id: 'credits', name: 'Credits', note: 'Sources and type', go: () => app.go('credits') },
  ];

  const items = entries.map((e, i) => {
    const key = i < 10 ? String((i + 1) % 10) : '';
    const name = h('span.dir-name', e.name);
    const btn = h('button.dir-item', { type: 'button', dataset: { id: e.id } },
      h('span.dir-box'), key ? keycap(key, 'dir-key') : h('span.dir-key'), name, h('span.dir-leader'), h('span.dir-note', e.note));
    btn.addEventListener('click', () => { sfx.thump(); e.go(); });
    btn.addEventListener('mouseenter', () => btn.focus({ preventScroll: true }));
    btn.addEventListener('focus', () => sfx.key());
    return { ...e, key, btn, nameEl: name };
  });

  let resume = null;
  if (last && last.mode === 'campaign' && last.cityId && getCampaignCity(last.cityId)) {
    const c = getCampaignCity(last.cityId);
    const stage = Math.min(c.stages - 1, last.stage | 0);
    if (stageAvailable(c.id, stage)) {
      resume = h('button.resume', { type: 'button', onclick: () => { sfx.thump(); app.go('campaign', { city: c.id, stage }); } },
        h('span.label', 'Resume file'),
        h('b', `${c.name} · Stage ${stage + 1}`),
        h('span.small.muted', DIFF_LABEL[last.difficulty] || 'Normal'));
    }
  }

  const notice = h('ol.notice');
  const noticeLines = DIRECTIVES.map(t => { const li = h('li', h('span')); notice.appendChild(li); return [li.firstChild, t]; });

  const word = h('h1.wordmark', { 'aria-label': 'Remain Calm' }, h('span.wm-line', 'Remain'), h('span.wm-line', 'Calm'));
  const sub = h('div.stamp.stamp-lg.title-stamp', 'Municipal', h('br'), 'Outbreak', h('br'), 'Response');
  const seal = h('div.seal.title-seal', { style: { '--size': '7.2rem', '--rot': '8deg' } }, h('small', 'Directive'), '7', h('small', 'O.C.P.'));

  const p = getProgress();
  const el = h('section.screen.title-screen',
    h('div.bulletin',
      h('div.bull-top',
        h('span', 'Office of Civil Preparedness'),
        h('span', 'Public notice No. 0007'),
        h('span', fmtDate(today.getTime()))),
      h('div.bull-grid',
        h('div.bull-main',
          seal,
          word,
          sub,
          h('div.bull-rule'),
          h('p.bull-lede', 'By order of the municipal authority, residents are advised of the following measures:'),
          notice),
        h('nav.directory', { 'aria-label': 'Main menu' },
          h('div.dir-head', h('span.h3', 'Directory of services'), h('span.form-no', 'Form OCP-1')),
          resume,
          h('ol.dir-list', items.map(it => h('li', it.btn))),
          h('p.dir-hint.tiny.faint', 'Number keys or arrows and Enter. Esc returns here from any screen.'),
          h('p.dir-hint.title-ver.tiny.faint.mono', 'Version ' + VERSION))),
      h('div.bull-foot',
        h('span', `Stages cleared ${sum.cleared}/${sum.stages}`),
        h('span', `Cities secured ${sum.cities}/${sum.total}`),
        h('span', `Commendations ${ach.awarded}/${ach.total}`),
        h('span', `Infected destroyed ${(p.totals.kills || 0).toLocaleString('en-GB')}`))));

  root.appendChild(el);

  let skipFns = [];
  if (!introPlayed) {
    introPlayed = true;
    el.classList.add('intro');
    setTimeout(() => sfx.thump(), 260);
    const lines = [...noticeLines];
    let delay = 650;
    for (const [span, text] of lines) {
      const p2 = typeText(span, text, { cps: 140, delay, sound: true });
      skipFns.push(p2.skip);
      delay += 260;
    }
    items.forEach((it, i) => {
      const p3 = typeText(it.nameEl, it.name, { cps: 120, delay: 350 + i * 55, sound: false });
      skipFns.push(p3.skip);
    });
  } else {
    for (const [span, text] of noticeLines) span.textContent = text;
  }
  const skip = () => { for (const f of skipFns) f(); skipFns = []; el.classList.remove('intro'); };

  requestAnimationFrame(() => (resume || items[0].btn).focus({ preventScroll: true }));

  return {
    onKey(e) {
      if (isTyping(e)) return false;
      if (skipFns.length) skip();
      const focusables = [resume, ...items.map(i => i.btn)].filter(Boolean);
      const k = focusables.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = focusables.length;
        const next = k < 0 ? 0 : (k + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        focusables[next].focus();
        return true;
      }
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const it = items.find(x => x.key === e.key);
        if (it) { it.btn.focus(); it.btn.click(); return true; }
      }
      return false;
    },
    destroy() { skip(); },
  };
}
