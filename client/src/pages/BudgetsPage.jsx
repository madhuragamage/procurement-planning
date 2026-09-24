import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from '../components/ui.jsx';
import { fmt } from '../lib/format.js';

export default function BudgetsPage() {
  const { user } = useAuth();
  const { fy, lookups } = useApp();
  const [year, setYear] = useState(fy);
  const [avail, setAvail] = useState([]);
  const [lines, setLines] = useState([]);
  const [open, setOpen] = useState(null);
  const [f, setF] = useState({ id: null, department_id: '', category_id: '', amount_mn: '', source: '' });
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
    if (out) { setF({ id: null, department_id: '', category_id: '', amount_mn: '', source: '' }); load(); }
  }

  return (
    <div>
      <div className="between">
        <h2 style={{ margin: 0 }}>Budget availability</h2>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Budget year <input type="number" value={year} onChange={e => setYear(Number(e.target.value))} style={{ width: 90, display: 'inline-block' }} /></label>
      </div>
      <p className="hint">Committed = plan items (incl. VAT) that fall in this budget year (cycle year + year offset), excluding cancelled items. Pipeline = authorised requests that have not been given a method yet. Enter either a department total or per-category lines, not both, to avoid double counting.</p>
      <Msg error={error} ok={ok} />

      <div className="card">
        {avail.length === 0 ? <div className="empty">No budget lines or plan items for {year}.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Department</th><th style={{ textAlign: 'right' }}>Allocated</th><th style={{ textAlign: 'right' }}>Committed</th><th style={{ textAlign: 'right' }}>Pipeline</th><th style={{ textAlign: 'right' }}>Remaining</th><th>Use</th></tr></thead>
            <tbody>{avail.map(a => {
              const pct = a.allocated ? Math.min(100, (a.committed / a.allocated) * 100) : 0;
              return (
                <Fragment key={a.department_id}>
                  <tr><td><button className="link" onClick={() => setOpen(open === a.department_id ? null : a.department_id)}>{a.department}</button></td>
                    <td style={{ textAlign: 'right' }}>{fmt(a.allocated)}</td><td style={{ textAlign: 'right' }}>{fmt(a.committed)}</td><td style={{ textAlign: 'right' }}>{fmt(a.pipeline)}</td>
                    <td style={{ textAlign: 'right' }} className={a.over_budget ? 'phaseA' : ''}>{fmt(a.remaining)}</td>
                    <td>{a.allocated ? <div className={'bar' + (a.over_budget ? ' over' : '')}><div style={{ width: pct + '%' }}></div></div> : <span className="hint">no allocation</span>}{a.over_budget && <span className="pill bad" style={{ marginLeft: 6 }}>over</span>}</td></tr>
                  {open === a.department_id && a.categories.map(c => (
                    <tr key={c.category_id} style={{ background: 'var(--panel-2)' }}><td style={{ paddingLeft: 26 }}>{c.category}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(c.allocated)}</td><td style={{ textAlign: 'right' }}>{fmt(c.committed)}</td><td style={{ textAlign: 'right' }}>{fmt(c.pipeline)}</td>
                      <td style={{ textAlign: 'right' }}>{c.remaining == null ? '—' : fmt(c.remaining)}</td><td>{c.over_budget && <span className="pill bad">over</span>}</td></tr>
                  ))}
                </Fragment>
              );
            })}</tbody>
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
            <label className="field"><span>Category (optional)</span>
              <select value={f.category_id || ''} onChange={e => setF({ ...f, category_id: e.target.value })}>
                <option value="">Whole department</option>{lookups.categories.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="field"><span>Amount (LKR Mn)</span><input type="number" step="any" min="0" value={f.amount_mn} onChange={e => setF({ ...f, amount_mn: e.target.value })} required /></label>
            <label className="field"><span>Source</span><input type="text" value={f.source || ''} onChange={e => setF({ ...f, source: e.target.value })} placeholder="e.g. Approved budget" /></label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy}>{f.id ? 'Update line' : 'Add allocation'}</button>
            {f.id && <button type="button" className="ghost" onClick={() => setF({ id: null, department_id: '', category_id: '', amount_mn: '', source: '' })}>Cancel edit</button>}
          </div>
        </form>
      )}
      <div className="card">
        {lines.length === 0 ? <div className="empty">No allocations entered.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Department</th><th>Category</th><th style={{ textAlign: 'right' }}>Amount (Mn)</th><th>Source</th><th></th></tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.id}><td>{l.department}</td><td>{l.category || 'Whole department'}</td><td style={{ textAlign: 'right' }}>{fmt(l.amount_mn)}</td><td>{l.source}</td>
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
