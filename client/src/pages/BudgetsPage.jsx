import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from '../components/ui.jsx';
import { fmt, EXPENSE_LABEL, MAIN_CATEGORY_LABEL } from '../lib/format.js';

const blankLine = { id: null, department_id: '', expense_type: '', category_id: '', amount_mn: '', source: '' };
// Budget Categories, each with its own allocation: [key in availability.by_type, label].
const TYPES = [['CAPEX', 'CAPEX'], ['OPEX', 'OPEX'], ['Inventory', 'Inventory']];

function UseBar({ t }) {
  if (!t.allocated) return t.committed ? <span className="pill bad">no allocation</span> : <span className="hint">—</span>;
  const pct = Math.min(100, (t.committed / t.allocated) * 100);
  return <div className={'bar' + (t.over_budget ? ' over' : '')} title={`${pct.toFixed(0)}% used`}><div style={{ width: pct + '%' }}></div></div>;
}

export default function BudgetsPage() {
  const { user } = useAuth();
  const { fy, lookups } = useApp();
  const [year, setYear] = useState(fy);
  const [avail, setAvail] = useState([]);
  const [lines, setLines] = useState([]);
  const [open, setOpen] = useState(null);
  const [f, setF] = useState(blankLine);
  const { busy, error, ok, run } = useAction();
  const canEdit = ['procurement', 'management', 'admin'].includes(user.role);

  useEffect(() => setYear(fy), [fy]);
  const load = useCallback(async () => {
    setAvail(await api.get('/budgets/availability?year=' + year));
    setLines(await api.get('/budgets?year=' + year));
  }, [year]);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    const body = { ...f, year };
    const out = await run(() => f.id ? api.put('/budgets/' + f.id, body) : api.post('/budgets', body), 'Budget line saved.');
    if (out) { setF(blankLine); load(); }
  }

  const total = key => TYPES.reduce((o, [k]) => ({ ...o, [k]: avail.reduce((s, a) => s + a.by_type[k][key], 0) }), {});
  const alloc = total('allocated'), comm = total('committed');
  const num = { textAlign: 'right' };
  const cells = t => <>
    <td style={num}>{fmt(t.allocated)}</td><td style={num}>{fmt(t.committed)}</td><td style={num}>{fmt(t.pipeline)}</td>
    <td style={num} className={t.over_budget ? 'phaseA' : ''}>{fmt(t.remaining)}</td><td><UseBar t={t} /></td>
  </>;

  return (
    <div>
      <div className="between">
        <h2 style={{ margin: 0 }}>Budget availability</h2>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Budget year <input type="number" value={year} onChange={e => setYear(Number(e.target.value))} style={{ width: 90, display: 'inline-block' }} /></label>
      </div>
      <p className="hint">Each Budget Category (CAPEX, OPEX, Inventory) is a separate allocation, compared only with plan items of the same category. Committed = plan items (incl. VAT) that fall in this budget year (cycle year + year offset), excluding cancelled items. Pipeline = authorised requests not yet planned (a recurrent request also counts in each later year, with its yearly increase). Enter either a department total or per-category lines for each type, not both, to avoid double counting.</p>
      <Msg error={error} ok={ok} />

      <div className="grid g3" style={{ marginBottom: 14 }}>
        {TYPES.map(([k, l]) => (
          <Fragment key={k}>
            <div className="stat"><div className="v">{fmt(alloc[k])}</div><div className="l">{l} allocated {year} · LKR Mn</div></div>
            <div className={'stat' + (comm[k] > alloc[k] + 1e-9 ? ' bad' : '')}><div className="v">{fmt(alloc[k] - comm[k])}</div><div className="l">{l} remaining · committed {fmt(comm[k])}</div></div>
          </Fragment>
        ))}
      </div>

      <div className="card">
        {avail.length === 0 ? <div className="empty">No budget lines or plan items for {year}.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead>
              <tr><th rowSpan={2}>Department</th>{TYPES.map(([k, l]) => <th key={k} colSpan={5} style={{ textAlign: 'center', borderLeft: '1px solid var(--line)' }}>{l}</th>)}</tr>
              <tr>{TYPES.map(([k]) => <Fragment key={k}><th style={{ ...num, borderLeft: '1px solid var(--line)' }}>Allocated</th><th style={num}>Committed</th><th style={num}>Pipeline</th><th style={num}>Remaining</th><th>Use</th></Fragment>)}</tr>
            </thead>
            <tbody>{avail.map(a => (
              <Fragment key={a.department_id}>
                <tr><td><button className="link" onClick={() => setOpen(open === a.department_id ? null : a.department_id)}>{a.department}</button>{a.over_budget && <span className="pill bad" style={{ marginLeft: 6 }}>over</span>}</td>
                  {TYPES.map(([k]) => <Fragment key={k}>{cells(a.by_type[k])}</Fragment>)}</tr>
                {open === a.department_id && (a.categories.length === 0
                  ? <tr style={{ background: 'var(--panel-2)' }}><td colSpan={1 + TYPES.length * 5} className="hint" style={{ paddingLeft: 26 }}>No category-level figures.</td></tr>
                  : a.categories.map(c => (
                    <tr key={c.expense_type + c.category_id} style={{ background: 'var(--panel-2)' }}><td style={{ paddingLeft: 26 }}>{c.category}</td>
                      {TYPES.map(([k, l]) => <Fragment key={k}>{c.expense_type === l ? <>
                        <td style={num}>{fmt(c.allocated)}</td><td style={num}>{fmt(c.committed)}</td><td style={num}>{fmt(c.pipeline)}</td><td style={num}>{c.remaining == null ? '—' : fmt(c.remaining)}</td><td>{c.over_budget && <span className="pill bad">over</span>}</td>
                      </> : <><td></td><td></td><td></td><td></td><td></td></>}</Fragment>)}
                    </tr>
                  )))}
              </Fragment>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="section-title">Allocations for {year}</div>
      {canEdit && (
        <form className="card" onSubmit={save} style={{ marginBottom: 14 }}>
          <div className="grid g4">
            <label className="field"><span>Department</span>
              <select value={f.department_id} onChange={e => setF({ ...f, department_id: e.target.value })} required>
                <option value="">Select…</option>{lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select></label>
            <label className="field"><span>Budget category</span>
              <select value={f.expense_type} onChange={e => setF({ ...f, expense_type: e.target.value })} required>
                <option value="">Select…</option>{lookups.expenseTypes.map(x => <option key={x} value={x}>{EXPENSE_LABEL[x]}</option>)}
              </select></label>
            <label className="field"><span>Category (optional)</span>
              <select value={f.category_id || ''} onChange={e => setF({ ...f, category_id: e.target.value })}>
                <option value="">Whole department</option>{lookups.categories.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{MAIN_CATEGORY_LABEL[c.manual_type]} / {c.name}</option>)}
              </select></label>
            <label className="field"><span>Amount (LKR Mn)</span><input type="number" step="any" min="0" value={f.amount_mn} onChange={e => setF({ ...f, amount_mn: e.target.value })} required /></label>
          </div>
          <label className="field"><span>Source</span><input type="text" value={f.source || ''} onChange={e => setF({ ...f, source: e.target.value })} placeholder="e.g. Approved budget" /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy}>{f.id ? 'Update line' : 'Add allocation'}</button>
            {f.id && <button type="button" className="ghost" onClick={() => setF(blankLine)}>Cancel edit</button>}
          </div>
        </form>
      )}
      <div className="card">
        {lines.length === 0 ? <div className="empty">No allocations entered.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Department</th><th>Type</th><th>Category</th><th style={{ textAlign: 'right' }}>Amount (Mn)</th><th>Source</th><th></th></tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.id}><td>{l.department}</td><td>{l.expense_type}</td><td>{l.category || 'Whole department'}</td><td style={{ textAlign: 'right' }}>{fmt(l.amount_mn)}</td><td>{l.source}</td>
                <td style={{ display: 'flex', gap: 6 }}>{canEdit && <>
                  <button className="mini plain" onClick={() => setF({ ...l, category_id: l.category_id || '' })}>edit</button>
                  <button className="mini" onClick={async () => { if (confirm('Delete this allocation?')) { await run(() => api.del('/budgets/' + l.id)); load(); } }}>delete</button></>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
