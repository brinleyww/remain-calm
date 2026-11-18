// Daily challenge: a city and two mutators fixed by the date; the best result per day is kept.
import { MUTATOR_PRESETS } from '../data/config.js';
import { bestRecord, getProgress } from '../meta/progress.js';
import { h, clear, sfx, fmtInt, fmtPct, isTyping, keycap } from './dom.js';
import { screenFrame, stageSeal } from './screen.js';
import { generate, todayKey, dateFromKey, dailySpec } from './gen.js';
import { mapPreview, WATER_LABEL, stagePopulations } from './mapinfo.js';

export const dailyMapKey = key => 'daily:' + key;

function dayScore(key, stages) {
  let sum = 0, cleared = 0, any = false;
  for (let k = 0; k < stages; k++) {
    const r = bestRecord(dailyMapKey(key), k, 'normal');
    if (r) { any = true; sum += r.badge ? r.pct : 0; if (r.badge) cleared++; }
  }
  return { any, cleared, avg: stages ? sum / stages : 0 };
}

const fmtDay = (d, long = false) => d.toLocaleDateString('en-GB', long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'short', day: '2-digit', month: 'short' });

export function mount(root, app, params) {
  const today = todayKey();
  let key = params.day && /^\d{8}$/.test(params.day) ? +params.day : today;
  if (key > today) key = today;

  const frame = screenFrame({ form: 'OCP-27', title: 'Daily Challenge', sub: 'One city, two conditions, the same for every office today', onBack: () => app.go('title') });
  root.appendChild(frame.el);

  const preview = mapPreview({ cls: 'daily-preview', label: 'Setting type' });
  const paper = h('article.daily-paper');
  const history = h('div.daily-history');
  frame.body.appendChild(h('div.daily-grid', paper, h('aside.daily-side', h('div.section-head', h('span.h3', 'Previous editions'), h('span.tiny.faint', 'Best result per day')), history)));

  let map = null, seq = 0, startBtn = null;

  function render() {
    const spec = dailySpec(key, MUTATOR_PRESETS);
    const date = dateFromKey(key);
    clear(paper);
    const head = h('header.daily-mast',
      h('span.daily-ed', `Edition ${key}`),
      h('h2.daily-name', 'The Daily Drill'),
      h('span.daily-date', fmtDay(date, true)));
    const headline = h('h3.daily-headline', 'Outbreak exercise ordered');
    const sub = h('p.daily-dek', 'Plotting the city…');
    const muts = h('div.daily-muts', spec.mutators.map((id, i) => {
      const p = MUTATOR_PRESETS[id];
      return h('div.daily-mut', h('span.stamp.stamp-sm' + (i ? '.tilt-3' : '.tilt-1'), p.name), h('p.small', p.desc));
    }));
    const stagesBox = h('div.daily-stages');
    const scoreBox = h('div.daily-score');
    startBtn = h('button.btn.btn-primary.btn-lg', { type: 'button', disabled: true, onclick: () => start(spec) }, key === today ? 'Begin today’s drill' : 'Replay this drill', keycap('Enter'));
    paper.append(head,
      h('div.daily-cols',
        h('div.daily-mapcol', preview.el, h('p.tiny.faint.daily-caption', 'Plate 1. The exercise area, stage 1 marked.')),
        h('div.daily-text', headline, sub,
          h('div.section-head', h('span.h4', 'Conditions in force'), h('span.tiny.faint', 'Normal difficulty')), muts,
          h('div.section-head', h('span.h4', 'Your best'), h('span.tiny.faint', key === today ? 'Today' : fmtDay(date))), stagesBox, scoreBox,
          h('div.btn-row', startBtn))));

    const my = ++seq;
    map = null;
    preview.setLoading('Plotting');
    generate({ ...spec.opts }).then(m => {
      if (my !== seq || !root.isConnected) return;
      map = m;
      preview.set(m, 0);
      headline.textContent = `Outbreak drill ordered for ${m.name}`;
      const pops = stagePopulations(m);
      sub.textContent = `${spec.opts.sizeKm.toFixed(1)} km sheet · ${WATER_LABEL[spec.opts.water]} · ${m.levels.length} stages · ${fmtInt(pops[pops.length - 1])} residents. Every office in the region plans against the same streets today.`;
      clear(stagesBox);
      for (let k = 0; k < m.levels.length; k++) {
        const r = bestRecord(dailyMapKey(key), k, 'normal');
        stagesBox.appendChild(stageSeal(r ? r.badge : null, String(k + 1), { size: '2.4rem', title: r ? `Best ${fmtPct(r.pct)}` : 'Not cleared' }));
      }
      const sc = dayScore(key, m.levels.length);
      scoreBox.textContent = sc.any ? `${sc.cleared} of ${m.levels.length} stages cleared · average ${fmtPct(sc.avg)} saved` : 'No attempt filed yet.';
      startBtn.disabled = false;
    }).catch(e => { if (my === seq) preview.setEmpty('Plotting failed: ' + e.message); });
    renderHistory();
  }

  function renderHistory() {
    clear(history);
    const p = getProgress();
    for (let i = 0; i < 10; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = todayKey(d);
      const rec = p.records[dailyMapKey(k)];
      const stages = rec && rec.normal ? Object.keys(rec.normal).length : 0;
      let best = null, cleared = 0;
      if (rec && rec.normal) for (const s in rec.normal) { const r = rec.normal[s]; if (r.badge) cleared++; if (!best || r.pct > best.pct) best = r; }
      const row = h('button.daily-row' + (k === key ? '.is-sel' : ''), { type: 'button', onclick: () => { key = k; sfx.page(); render(); } },
        h('span.daily-row-date', i === 0 ? 'Today' : fmtDay(d)),
        h('span.daily-row-res', stages ? `${cleared} cleared · best ${fmtPct(best ? best.pct : 0)}` : h('span.faint', 'No entry')),
        best && best.badge ? h('span.badge.badge-' + best.badge, best.badge) : h('span'));
      history.appendChild(row);
    }
  }

  function start(spec) {
    if (!map) return;
    sfx.thump();
    app.launch({
      map, mode: 'daily', difficulty: 'normal', mutators: spec.mutators.flatMap(id => MUTATOR_PRESETS[id].lines),
      mapKey: dailyMapKey(key), startStage: 0, returnTo: ['daily', key === today ? {} : { day: String(key) }],
    });
  }

  render();
  return {
    onKey(e) {
      if (isTyping(e)) return false;
      if (e.key === 'Enter' && startBtn && !startBtn.disabled && !(document.activeElement && document.activeElement.classList.contains('daily-row'))) { startBtn.click(); return true; }
      return false;
    },
    destroy() { seq++; preview.destroy(); },
  };
}
