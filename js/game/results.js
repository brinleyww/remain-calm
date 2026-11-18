// Stage result card: rubber-stamped verdict, badge seal, ledger of the stage, per-item table, next / retry / map select.
import { h, esc, fmtInt, fmtMoney, fmtPct, fmtTime } from './el.js';
import { openModal, button } from './overlays.js';

const BADGE_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', sapphire: 'Sapphire', emerald: 'Emerald', ruby: 'Ruby', diamond: 'Diamond' };
const ITEM_LABEL = { zone: 'Safe zones', wallUpgrade: 'Wall upgrades', gate: 'Gates', wall: 'Walls', corridor: 'Corridors', hold: 'Hold points',
  police: 'Police', militia: 'Militia', soldier: 'Soldiers', fire: 'Fire', explosive: 'Explosive mutants', hazard: 'Hazard blasts', collapse: 'Collapses',
  drown: 'Drowned', explosion: 'Explosions', other: 'Other', unknown: 'Other' };

// shell = what onStageResult returned ({ improved, newUnlocks, flawless, ... }) or null.
export function showResult(s, r, best, shell = null) {
  const won = !!r.won;
  const pct = r.pct || 0;
  const badge = r.badge;
  const label = (k) => {
    if (k.startsWith('ability:')) return s.combat.abilityName(k.slice(8));
    if (s.world.cfg.units[k]) return s.combat.unitName(k);
    if (s.world.cfg.abilities[k]) return s.combat.abilityName(k);
    return ITEM_LABEL[k] || k;
  };

  const verdict = won
    ? h('span.stamp.stamp-lg.stamp-green.tilt-1.rc-verdict', null, r.last ? 'City secured' : 'Area secured', h('small', null, r.softlock ? 'remaining infected cut off' : `stage ${r.stage + 1} of ${r.stageCount}`))
    : h('span.stamp.stamp-lg.tilt-2.rc-verdict', null, 'City lost', h('small', null, `fewer than ${s.world.cfg.loseBelowPct}% of residents survive`));
  const seal = won && badge
    ? h('span.seal.rc-seal', { style: `--tier:var(--${badge});--rot:${(r.stage % 2 ? 5 : -4)}deg;--size:7.4rem` }, BADGE_LABEL[badge] || badge, h('small', null, `${fmtPct(pct)} saved`))
    : h('span.seal.rc-seal.is-none', { style: '--tier:var(--ink-3);--rot:-3deg;--size:6.4rem' }, won ? 'No award' : 'Void', h('small', null, `${fmtPct(pct)} saved`));

  const rows = [
    ['Residents at start', fmtInt(r.civStart)],
    ['Saved (alive + evacuated)', fmtInt(r.saved)],
    ['Evacuated', fmtInt(r.evacuated || 0)],
    ['Lost', fmtInt(r.civLost)],
    ['Raised as militia', fmtInt(r.converted || 0)],
    ['Infected destroyed', fmtInt(r.zombiesKilled)],
    ['Time on the clock', fmtTime(r.time)],
    ['Money spent', r.sandbox ? `${fmtMoney(r.spent)} (sandbox)` : `${fmtMoney(r.spent)} of ${fmtMoney(r.budget)}`],
  ];
  if (best && Number.isFinite(best.pct)) rows.push(['Best on record', `${fmtPct(best.pct)}${best.badge ? ' · ' + (BADGE_LABEL[best.badge] || best.badge) : ''}`]);
  const ledger = `<table class="table ledger compact rc-res-ledger"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>`;

  const per = (r.perType || []).filter((p) => p.count || p.kills || p.spent).sort((a, b) => b.kills - a.kills || b.spent - a.spent);
  const perHtml = per.length ? `<table class="table compact rc-res-per"><caption>By item</caption><thead><tr><th>Item</th><th class="num">Placed</th><th class="num">Kills</th><th class="num">Spent</th><th class="num">$ / kill</th></tr></thead><tbody>${
    per.map((p) => `<tr><td>${esc(label(p.key))}</td><td class="num">${p.count ? fmtInt(p.count) : '<span class="dim">-</span>'}</td><td class="num">${fmtInt(p.kills)}</td><td class="num">${p.spent ? fmtMoney(p.spent) : '<span class="dim">-</span>'}</td><td class="num">${p.perKill !== null && p.perKill !== undefined && p.spent ? fmtMoney(p.perKill) : '<span class="dim">-</span>'}</td></tr>`).join('')
  }</tbody></table>` : '<p class="faint small">Nothing was placed this stage.</p>';

  const top = h('div.rc-res-top', null,
    h('div.rc-res-stamps', null, verdict, seal),
    h('div.rc-res-big', null, h('span.display', null, fmtPct(pct)), h('span.label', null, 'of residents saved')));
  const notes = [];
  if (shell && shell.improved && won) notes.push('<span class="stamp stamp-sm stamp-blue tilt-3">New best</span>');
  if (shell && shell.flawless) notes.push('<span class="stamp stamp-sm stamp-green tilt-2">Flawless city</span>');
  if (shell && Array.isArray(shell.newUnlocks) && shell.newUnlocks.length) {
    const names = shell.newUnlocks.map((id) => (s.world.cfg.units[id] ? s.combat.unitName(id) : s.world.cfg.abilities[id] ? s.combat.abilityName(id) : /^upgrade(\d)$/.test(id) ? `Upgrade tier ${id.slice(7)}` : id));
    notes.push(`<span class="small">Issued: <b>${names.map(esc).join(', ')}</b></span>`);
  }
  const body = h('div.rc-res', null, top, notes.length ? h('div.rc-res-notes', { html: notes.join(' ') }) : null, h('div.rc-res-cols', { html: ledger + perHtml }));

  let m = null;
  const foot = [];
  const mapSel = () => { m.close(); s.quit('mapSelect'); };
  const retry = () => { m.close(); s.retry(); };
  const next = () => { m.close(); s.nextStage(); };
  const finish = () => { m.close(); s.quit('complete'); };
  foot.push(h('span.grow.form-no', null, `${esc(r.map || '')} · ${r.difficulty || 'normal'}${r.sandbox ? ' · sandbox' : ''}`));
  foot.push(button(s.opts.mode === 'test' ? 'Editor' : 'Map select', mapSel, { cls: 'btn-ghost' }));
  foot.push(button('Retry', retry, { cls: won ? '' : 'btn-primary', primary: !won, key: won ? null : 'Enter' }));
  if (won && !r.last) foot.push(button('Next stage', next, { cls: 'btn-primary', primary: true, key: 'Enter' }));
  else if (won) foot.push(button('Finish', finish, { cls: 'btn-primary', primary: true, key: 'Enter' }));
  m = openModal(s, {
    title: `Stage ${r.stage + 1} report`, no: `FORM OCP-12 / ${String(r.stage + 1).padStart(2, '0')}`, wide: true, cls: 'rc-result', body, foot, dismiss: false,
    onKey: (e) => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (won) (r.last ? finish : next)(); else retry(); return true; }
      return false;
    },
  });
  if (won) s.sfx('clack');
  return m;
}
