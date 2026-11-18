// Commendations: the fourteen achievements as citation cards.
import { getAchievements, achievementCount } from '../meta/achievements.js';
import { h, fmtDate, fmtInt } from './dom.js';
import { screenFrame } from './screen.js';

export function mount(root, app) {
  const n = achievementCount();
  const frame = screenFrame({ form: 'OCP-9', title: 'Commendations', sub: `${n.awarded} of ${n.total} awarded by the municipal authority`, onBack: () => app.go('title') });
  root.appendChild(frame.el);
  const meter = h('div.meter.ach-meter', { style: { '--v': String(n.awarded / n.total) } }, h('i.meter-fill'));
  const grid = h('div.ach-grid');
  getAchievements().forEach((a, i) => {
    const got = !!a.awarded;
    const prog = a.progress && !got ? h('div.ach-prog',
      h('div.meter.thin', { style: { '--v': String(Math.min(1, a.progress[0] / a.progress[1])) } }, h('i.meter-fill')),
      h('span.tiny.faint', `${fmtInt(a.progress[0])} / ${fmtInt(a.progress[1])}`)) : null;
    grid.appendChild(h('article.ach-card' + (got ? '.is-got' : ''),
      h('div.ach-head', h('span.ach-no', a.no), h('span.form-no', got ? 'Citation' : 'Pending')),
      h('h3.ach-name', a.name),
      h('p.ach-desc', a.desc),
      prog,
      got ? h('span.stamp.stamp-green.ach-stamp' + (i % 2 ? '.tilt-3' : '.tilt-1'), 'Awarded', h('small', fmtDate(a.awarded))) : h('span.ach-blank', 'Not yet awarded')));
  });
  frame.body.append(h('div.ach-top', h('span.label', 'Progress'), meter, h('span.meter-val', `${n.awarded}`, h('small', ` / ${n.total}`))), grid);
  return {};
}
