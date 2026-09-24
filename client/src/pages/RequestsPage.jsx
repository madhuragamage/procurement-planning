import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction } from '../components/ui.jsx';
import { fmt, inclVat, YEAR_LABELS, PRIORITY } from '../lib/format.js';

const blank = fy => ({
  title: '', description: '', category_id: '', tce_excl_vat_mn: '', vat_pct: 18, funding_source: 'GOSL', funding_agency: '',
  priority: 'N', plan_fy: fy, year_offset: 0, required_date: '', department_id: ''
});

function RequestForm({ initial, onDone, onCancel }) {
  const { user } = useAuth();
  const { lookups } = useApp();
  const [f, setF] = useState(initial);
  const { busy, error, run } = useAction();
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const editing = !!initial.id;
  const wide = ['procurement', 'admin'].includes(user.role);

  async function save(e) {
    e.preventDefault();
    const body = { ...f, department_id: f.department_id || undefined };
    const out = await run(() => editing ? api.put('/requests/' + initial.id, body) : api.post('/requests', body));
    if (out) onDone(out);
  }

  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 18 }}>
      <h2>{editing ? `Edit ${initial.ref_no}` : 'New procurement request'}</h2>
      <p className="hint">Describe what your department needs. After your department head authorises it, the procurement unit assigns the method and schedule.</p>
      <Msg error={error} />
      <div className="grid g3">
        <label className="field" style={{ gridColumn: 'span 2' }}><span>Title</span>
          <input type="text" value={f.title} onChange={e => set('title', e.target.value)} required maxLength={200} />
        </label>
        <label className="field"><span>Category</span>
          <select value={f.category_id} onChange={e => set('category_id', e.target.value)} required>
            <option value="">Select…</option>
            {lookups.categories.filter(c => c.active || c.id === f.category_id).map(c => <option key={c.id} value={c.id}>{c.name} ({c.manual_type})</option>)}
          </select>
        </label>
      </div>
      {wide && !editing && (
        <label className="field"><span>Department</span>
          <select value={f.department_id} onChange={e => set('department_id', e.target.value)}>
            <option value="">{user.department || 'My department'}</option>
            {lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      <label className="field"><span>Scope / quantity / justification</span>
        <textarea rows={3} value={f.description || ''} onChange={e => set('description', e.target.value)} />
      </label>
      <div className="grid g4">
        <label className="field"><span>Estimated cost excl. VAT (LKR Mn)</span>
          <input type="number" step="any" min="0" value={f.tce_excl_vat_mn} onChange={e => set('tce_excl_vat_mn', e.target.value)} required />
        </label>
        <label className="field"><span>VAT %</span>
          <input type="number" step="any" min="0" max="100" value={f.vat_pct} onChange={e => set('vat_pct', e.target.value)} />
        </label>
        <label className="field"><span>Estimate incl. VAT (LKR Mn)</span>
          <input type="text" value={fmt(inclVat(f.tce_excl_vat_mn, f.vat_pct))} readOnly />
        </label>
        <label className="field"><span>Tentative required date</span>
          <input type="date" value={f.required_date || ''} onChange={e => set('required_date', e.target.value)} required />
        </label>
      </div>
      <div className="grid g4">
        <label className="field"><span>Funding</span>
          <select value={f.funding_source} onChange={e => set('funding_source', e.target.value)}>
            <option value="GOSL">GOSL / own funds</option><option value="Foreign">Foreign funded</option>
          </select>
        </label>
        <label className="field"><span>Funding agency</span>
          <input type="text" value={f.funding_agency || ''} onChange={e => set('funding_agency', e.target.value)} placeholder="e.g. ADB, JICA" />
        </label>
        <label className="field"><span>Priority</span>
          <select value={f.priority} onChange={e => set('priority', e.target.value)}>
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div className="row">
          <label className="field"><span>Plan cycle</span>
            <input type="number" value={f.plan_fy} onChange={e => set('plan_fy', e.target.value)} required />
          </label>
          <label className="field"><span>Year in cycle</span>
            <select value={f.year_offset} onChange={e => set('year_offset', Number(e.target.value))}>
              {YEAR_LABELS(Number(f.plan_fy) || 0).map((l, i) => <option key={i} value={i}>{l}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" type="submit" disabled={busy}>{editing ? 'Save changes' : 'Save as draft'}</button>
        <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function RequestsPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const { busy, error, ok, run } = useAction();

  const load = useCallback(() => api.get('/requests').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    api.get('/requests/' + openId).then(setDetail).catch(() => setDetail(null));
  }, [openId, rows]);

  const shown = rows.filter(r => !statusFilter || r.status === statusFilter);
  const canWrite = ['requester', 'dept_head', 'procurement', 'admin'].includes(user.role);

  return (
    <div>
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Procurement requests</h2>
          <span className="hint" style={{ margin: 0 }}>{['procurement', 'admin', 'management'].includes(user.role) ? 'All departments' : user.department}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All statuses</option>
            {['draft', 'submitted', 'authorised', 'returned', 'rejected'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {canWrite && <button className="primary" onClick={() => setForm(blank(fy))}>New request</button>}
        </div>
      </div>
      <Msg error={error} ok={ok} />
      {form && <RequestForm initial={form} onCancel={() => setForm(null)} onDone={() => { setForm(null); load(); }} />}

      <div className="card">
        {shown.length === 0 ? <div className="empty">No requests yet.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Ref</th><th>Title</th><th>Department</th><th>Category</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Cycle</th><th>Required</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {shown.map(r => (
                <Fragment key={r.id}>
                  <tr>
                    <td><button className="link" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{r.ref_no}</button></td>
                    <td className="wrap">{r.title}</td><td>{r.department}</td><td>{r.category}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))}</td>
                    <td>{r.plan_fy}+{r.year_offset}</td><td>{r.required_date}</td>
                    <td><Status value={r.status} />{r.plan_item_id ? <span className="pill ok" style={{ marginLeft: 4 }}>in plan</span> : null}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {['draft', 'returned'].includes(r.status) && canWrite && <button className="mini plain" onClick={() => setForm(r)}>edit</button>}
                      {['draft', 'returned'].includes(r.status) && canWrite && <button className="mini plain" disabled={busy} onClick={async () => { await run(() => api.post(`/requests/${r.id}/submit`), `${r.ref_no} submitted to your department head.`); load(); }}>submit</button>}
                      {r.status === 'draft' && canWrite && <button className="mini" disabled={busy} onClick={async () => { if (confirm(`Delete draft ${r.ref_no}?`)) { await run(() => api.del('/requests/' + r.id)); load(); } }}>delete</button>}
                    </td>
                  </tr>
                  {openId === r.id && detail && (
                    <tr><td colSpan={9} style={{ background: 'var(--panel-2)' }}>
                      {detail.description && <p style={{ margin: '4px 0', fontFamily: 'var(--body)' }}>{detail.description}</p>}
                      {r.review_comment && <p className="hint" style={{ margin: '4px 0' }}>Reviewer comment: {r.review_comment}</p>}
                      <div className="hint" style={{ margin: '4px 0' }}>Requested by {detail.requested_by_name}{detail.authorised_by_name ? ` · authorised by ${detail.authorised_by_name}` : ''} · {detail.funding_source}{detail.funding_agency ? ` (${detail.funding_agency})` : ''} · priority {PRIORITY[detail.priority]}</div>
                      <div className="hint" style={{ margin: '4px 0' }}>{detail.history.map(h => `${h.at.slice(0, 16).replace('T', ' ')} ${h.action} by ${h.user || '-'}${h.comment ? ' — ' + h.comment : ''}`).join('  |  ')}</div>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
