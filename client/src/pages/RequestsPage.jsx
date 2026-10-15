import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction } from '../components/ui.jsx';
import { fmt, inclVat, YEAR_LABELS, PRIORITY, FUNDING_LABEL, REASON_LABEL, EXPENSE_LABEL, MAIN_CATEGORY_LABEL, recurLabel, recurYears, phasingLabel } from '../lib/format.js';

const blank = fy => ({
  title: '', description: '', category_id: '', tce_excl_vat_mn: '', vat_pct: 18, funding_source: 'LECO', funding_agency: '', reason: 'New', reason_note: '',
  expense_type: '', recurrence: 'one_time', annual_increase_pct: '', budget_phasing: null,
  priority: 'N', plan_fy: fy, year_offset: 0, required_date: '', department_id: '', sub_unit_id: ''
});

// Whole value in the start year, or spread over up to three budget years (percentages from the start year).
function BudgetPhasing({ f, set }) {
  const phased = Array.isArray(f.budget_phasing);
  const p = phased ? f.budget_phasing : [];
  const start = Number(f.plan_fy) + Number(f.year_offset);
  const incl = inclVat(f.tce_excl_vat_mn, f.vat_pct);
  const sum = p.reduce((s, v) => s + (Number(v) || 0), 0);
  const setYear = (k, v) => { const next = [...p]; next[k] = v; set('budget_phasing', next); };
  return (
    <div className="hintbox" style={{ marginBottom: 12 }}>
      <div className="grid g4" style={{ alignItems: 'end' }}>
        <label className="field" style={{ marginBottom: 0 }}><span>Budget requirement</span>
          <select value={phased ? 'phased' : 'single'} onChange={e => set('budget_phasing', e.target.value === 'phased' ? [50, 50, ''] : null)}>
            <option value="single">Whole amount in {start || 'the start year'}</option>
            <option value="phased">Spread over more than one year</option>
          </select></label>
        {phased && [0, 1, 2].map(k => (
          <label className="field" key={k} style={{ marginBottom: 0 }}><span>{start + k}{k === 0 ? ' (start)' : ''} — % of value</span>
            <input type="number" step="any" min="0" max="100" value={p[k] ?? ''} onChange={e => setYear(k, e.target.value)} />
            <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'none' }}>LKR {fmt(incl * (Number(p[k]) || 0) / 100)} Mn incl. VAT</span>
          </label>
        ))}
      </div>
      {phased && <div style={{ marginTop: 8, fontSize: 12, color: Math.abs(sum - 100) > 0.01 ? 'var(--bad)' : 'var(--muted)' }}>
        Total {Math.round(sum * 100) / 100}% {Math.abs(sum - 100) > 0.01 ? '— the shares must add up to 100%.' : '— each year\'s share is counted against that year\'s budget.'}
      </div>}
      {!phased && <div className="hint" style={{ margin: '8px 0 0' }}>Choose "spread" when the procurement starts in {start || 'this year'} but part of the payment falls in later years' budgets (e.g. multi-year works or phased deliveries).</div>}
    </div>
  );
}

function RequestForm({ initial, onDone, onCancel }) {
  const { user } = useAuth();
  const { lookups } = useApp();
  const [f, setF] = useState(() => ({
    ...initial, budget_code_id: initial.budget_code_id || '',
    main_category: initial.manual_type || lookups.categories.find(c => c.id === Number(initial.category_id))?.manual_type || ''
  }));
  const { busy, error, run } = useAction();
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const editing = !!initial.id;
  const amending = editing && !['draft', 'returned'].includes(initial.status);
  const subCategories = lookups.categories.filter(c => c.manual_type === f.main_category && (c.active || c.id === Number(f.category_id)));
  const codes = lookups.budgetCodes.filter(b => b.expense_type === f.expense_type && (b.active || b.id === Number(f.budget_code_id)));
  const wide = ['procurement', 'admin'].includes(user.role);
  const ownSubUnit = user.role === 'requester' && user.sub_unit_id;
  const deptId = Number((wide && f.department_id) || f.department_id || user.department_id);
  const subUnits = lookups.subUnits.filter(u => u.department_id === deptId && u.active);

  async function save(e) {
    e.preventDefault();
    const body = { ...f, department_id: f.department_id || undefined, sub_unit_id: ownSubUnit ? undefined : f.sub_unit_id };
    const out = await run(() => editing ? api.put('/requests/' + initial.id, body) : api.post('/requests', body));
    if (out) onDone(out);
  }

  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 18 }}>
      <h2>{amending ? `Amend ${initial.ref_no} — ${initial.department}` : editing ? `Edit ${initial.ref_no}` : 'New procurement request'}</h2>
      <p className="hint">{amending
        ? 'You are amending a request the procurement unit has received. Changes are recorded in the request history and, if it is already in the plan, the plan item is updated too. Amendments are possible until the plan is submitted for approval.'
        : 'Describe what your department needs. After your department head authorises it, the procurement unit assigns the method and schedule.'}</p>
      <Msg error={error} />
      <label className="field"><span>Title</span>
        <input type="text" value={f.title} onChange={e => set('title', e.target.value)} required maxLength={200} />
      </label>
      <div className="grid g4">
        <label className="field"><span>Main procurement category</span>
          <select value={f.main_category} onChange={e => setF(p => ({ ...p, main_category: e.target.value, category_id: '' }))} required>
            <option value="">Select…</option>
            {lookups.mainCategories.map(m => <option key={m} value={m}>{MAIN_CATEGORY_LABEL[m]}</option>)}
          </select>
        </label>
        <label className="field"><span>Sub category</span>
          <select value={f.category_id} onChange={e => set('category_id', e.target.value)} required disabled={!f.main_category}>
            <option value="">{f.main_category ? 'Select…' : 'choose the main category first'}</option>
            {subCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Budget category</span>
          <select value={f.expense_type} onChange={e => setF(p => ({ ...p, expense_type: e.target.value, budget_code_id: '' }))} required>
            <option value="">Select…</option>
            {lookups.expenseTypes.map(x => <option key={x} value={x}>{EXPENSE_LABEL[x]}</option>)}
          </select>
        </label>
        <label className="field"><span>Budget code</span>
          <select value={f.budget_code_id} onChange={e => set('budget_code_id', e.target.value)} disabled={!f.expense_type} required={codes.some(b => b.active)}>
            <option value="">{!f.expense_type ? 'choose the budget category first' : codes.length ? 'Select…' : 'no codes set up for this category'}</option>
            {codes.map(b => <option key={b.id} value={b.id}>{b.code} — {b.description}</option>)}
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
      <div className="grid g3">
        <label className="field"><span>Requesting unit</span>
          {ownSubUnit ? <input type="text" value={`${user.department} / ${user.sub_unit}`} readOnly /> : (
            <select value={f.sub_unit_id || ''} onChange={e => set('sub_unit_id', e.target.value)}>
              <option value="">Department level</option>
              {subUnits.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>)}
        </label>
        <label className="field"><span>Reason for procurement</span>
          <select value={f.reason} onChange={e => set('reason', e.target.value)}>
            {lookups.reasons.map(r => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
        </label>
        <label className="field"><span>Specify the reason{f.reason === 'Other' ? '' : ' (optional)'}</span>
          <input type="text" value={f.reason_note || ''} onChange={e => set('reason_note', e.target.value)} maxLength={200} required={f.reason === 'Other'}
            placeholder={f.reason === 'Projects-ADB' || f.reason === 'Projects-LECO' ? 'e.g. project name / package' : f.reason === 'ROL' ? 'e.g. item code, stock level' : ''} />
        </label>
      </div>
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
            {lookups.fundingSources.map(x => <option key={x} value={x}>{FUNDING_LABEL[x]}</option>)}
          </select>
        </label>
        <label className="field"><span>Funding agency</span>
          <input type="text" value={f.funding_agency || ''} onChange={e => set('funding_agency', e.target.value)} placeholder="e.g. ADB, JICA, donor" />
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
      <BudgetPhasing f={f} set={set} />
      <div className="grid g4">
        <label className="field"><span>Occurrence</span>
          <select value={f.recurrence} onChange={e => set('recurrence', e.target.value)}>
            <option value="one_time">One time</option>
            <option value="recurrent">Recurrent annually</option>
          </select>
        </label>
        {f.recurrence === 'recurrent' && (
          <label className="field"><span>Annual increase %</span>
            <input type="number" step="any" min="0" max="100" value={f.annual_increase_pct} onChange={e => set('annual_increase_pct', e.target.value)} required />
          </label>
        )}
        {f.recurrence === 'recurrent' && (
          <div className="field" style={{ gridColumn: 'span 2' }}><span className="hint" style={{ display: 'block', fontSize: 11, marginBottom: 5 }}>TENTATIVE PLAN (INCL. VAT, LKR MN)</span>
            {Number(f.year_offset) >= 2
              ? <span className="hint">This is the last year of the cycle, so there are no later years to repeat in.</span>
              : <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{recurYears(f.tce_excl_vat_mn, f.vat_pct, f.annual_increase_pct, Number(f.year_offset)).map(y => `${Number(f.plan_fy) + y.offset}: ${fmt(y.incl)}`).join('  ·  ')}</span>}
          </div>
        )}
      </div>
      {f.recurrence === 'recurrent' && <p className="hint">When the procurement unit adds this to the plan, it is repeated in each later year of the cycle as a tentative item, increased by this percentage per year.</p>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" type="submit" disabled={busy}>{editing ? 'Save changes' : 'Save as draft'}</button>
        <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function RequestsPage() {
  const { user } = useAuth();
  const { fy, lookups } = useApp();
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
  const procHead = !!lookups.me?.procurement_head;
  const toAmend = rows.filter(r => r.can_amend).length;

  return (
    <div>
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Procurement requests</h2>
          <span className="hint" style={{ margin: 0 }}>{['procurement', 'admin', 'management', 'executive'].includes(user.role) ? 'All departments'
            : procHead ? `${user.department}, plus every request received by the procurement unit` : user.department + (user.sub_unit ? ' / ' + user.sub_unit : '')}</span>
          {toAmend > 0 && <div className="hint" style={{ margin: '2px 0 0' }}>{toAmend} received request{toAmend > 1 ? 's' : ''} can still be amended by the procurement unit (until the plan is submitted for approval).</div>}
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
            <thead><tr><th>Ref</th><th>Title</th><th>Unit</th><th>Category</th><th>Budget</th><th>Reason</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Funding</th><th>Cycle</th><th>Required</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {shown.map(r => (
                <Fragment key={r.id}>
                  <tr>
                    <td><button className="link" onClick={() => setOpenId(openId === r.id ? null : r.id)}>{r.ref_no}</button></td>
                    <td className="wrap">{r.title}</td><td>{r.department}{r.sub_unit ? ' / ' + r.sub_unit : ''}</td><td>{r.category}</td>
                    <td>{r.expense_type}{r.budget_code && <div className="hint" style={{ margin: 0 }} title={r.budget_code_desc}>{r.budget_code}</div>}{r.recurrence === 'recurrent' && <span className="pill warn" style={{ marginLeft: 4 }} title={recurLabel(r)}>+{Number(r.annual_increase_pct)}%/yr</span>}{phasingLabel(r) && <span className="pill warn" style={{ marginLeft: 4 }} title={'Budget phasing: ' + phasingLabel(r)}>phased</span>}</td>
                    <td>{r.reason}{r.reason_note ? ': ' + r.reason_note : ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))}</td><td>{FUNDING_LABEL[r.funding_source]}</td>
                    <td>{r.plan_fy}+{r.year_offset}</td><td>{r.required_date}</td>
                    <td><Status value={r.status} />{r.plan_item_id ? <span className="pill ok" style={{ marginLeft: 4 }}>in plan</span> : null}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {['draft', 'returned'].includes(r.status) && canWrite && <button className="mini plain" onClick={() => setForm(r)}>edit</button>}
                      {r.can_amend && <button className="mini plain" title="Amend before the plan is submitted for approval" onClick={() => { setForm(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>amend</button>}
                      {['draft', 'returned'].includes(r.status) && canWrite && <button className="mini plain" disabled={busy} onClick={async () => { await run(() => api.post(`/requests/${r.id}/submit`), `${r.ref_no} submitted to your department head.`); load(); }}>submit</button>}
                      {r.status === 'draft' && canWrite && <button className="mini" disabled={busy} onClick={async () => { if (confirm(`Delete draft ${r.ref_no}?`)) { await run(() => api.del('/requests/' + r.id)); load(); } }}>delete</button>}
                    </td>
                  </tr>
                  {openId === r.id && detail && (
                    <tr><td colSpan={12} style={{ background: 'var(--panel-2)' }}>
                      {detail.description && <p style={{ margin: '4px 0', fontFamily: 'var(--body)' }}>{detail.description}</p>}
                      {r.review_comment && <p className="hint" style={{ margin: '4px 0' }}>Reviewer comment: {r.review_comment}</p>}
                      <div className="hint" style={{ margin: '4px 0' }}>Requested by {detail.requested_by_name}{detail.authorised_by_name ? ` · authorised by ${detail.authorised_by_name}` : ''} · {FUNDING_LABEL[detail.funding_source]}{detail.funding_agency ? ` (${detail.funding_agency})` : ''} · priority {PRIORITY[detail.priority]} · {EXPENSE_LABEL[detail.expense_type]}{detail.budget_code ? ` — budget code ${detail.budget_code} ${detail.budget_code_desc}` : ""} · {recurLabel(detail)}{phasingLabel(detail) ? ` · budget phasing ${phasingLabel(detail)}` : ''}</div>
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
