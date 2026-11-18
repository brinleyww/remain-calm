// Box-select refund panel: lists what the box caught, grouped by type, with checkboxes; refunds the ticked groups.
import { h, fmtInt, fmtMoney } from './el.js';
import { openModal, button } from './overlays.js';

// items: [{ kind: 'unit'|'zone'|'gate'|'wall'|'corridor'|'hold', id, group, label, paid }]
export function openRefundPanel(s, items) {
  const w = s.world;
  const groups = new Map();
  for (const it of items) {
    const key = `${it.kind}:${it.group || it.kind}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, kind: it.kind, label: it.label, ids: [], paid: 0, on: true });
    g.ids.push(it.id);
    g.paid += it.paid || 0;
  }
  const list = [...groups.values()].sort((a, b) => b.paid - a.paid);
  const total = h('b.meter-val');
  const rows = h('tbody');
  const refresh = () => {
    let t = 0;
    for (const g of list) if (g.on) t += w.refundValue(g.paid);
    total.textContent = fmtMoney(t);
  };
  for (const g of list) {
    const chk = h('input', { type: 'checkbox' });
    chk.checked = true;
    chk.addEventListener('change', () => { g.on = chk.checked; refresh(); });
    rows.append(h('tr', null,
      h('td', null, h('label.check', null, chk, h('span', null, g.label))),
      h('td.num', null, fmtInt(g.ids.length)),
      h('td.num', null, fmtMoney(g.paid)),
      h('td.num', null, fmtMoney(w.refundValue(g.paid)))));
  }
  refresh();
  const table = h('table.table.compact', null,
    h('thead', null, h('tr', null, h('th', null, 'Placement'), h('th.num', null, 'Count'), h('th.num', null, 'Paid'), h('th.num', null, 'Back'))),
    rows);
  const note = w.phase === 'planning' ? 'Planning: everything is refunded in full.' : 'During the battle refunds return nothing; removal is immediate.';
  const body = h('div.vstack.gap-3', null, table, h('div.meter-row', null, h('span.label', null, 'Refund total'), total), h('p.small.faint', null, note));
  let m = null;
  const go = () => {
    const out = {};
    for (const g of list) if (g.on) (out[g.kind] = out[g.kind] || []).push(...g.ids);
    m.close();
    if (!Object.keys(out).length) return;
    const r = s.issue({ t: 'refund.many', items: out, owner: s.owner });
    if (r.ok) s.flash(`Refunded ${r.count} placement${r.count === 1 ? '' : 's'}${r.refund ? ' for ' + fmtMoney(r.refund) : ''}`, 'good');
  };
  m = openModal(s, { title: 'Refund', no: 'RETURNS / OCP-9', body, foot: [button('Cancel', () => m.close(), { cls: 'btn-ghost' }), button('Refund selected', go, { cls: 'btn-primary', primary: true, key: 'Enter' })],
    onKey: (e) => { if (e.code === 'Enter') { go(); return true; } return false; } });
  return m;
}

