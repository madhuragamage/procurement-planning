import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { label } from '../lib/format.js';
import ReportTable from '../components/ReportTable.jsx';

const MOD_FIELDS = [
  ['method', 'Method', 'method'], ['committee_level', 'Committee', 'committee'], ['tce_excl_vat_mn', 'TCE excl. VAT (Mn)', 'number'],
  ['year_offset', 'Year in cycle (0-2)', 'number'], ['procurement_start', 'Procurement start', 'date'], ['expected_delivery', 'Expected delivery', 'date'], ['remarks', 'Remarks', 'text']
];

function ChangeForm({ revision, fy, items, requests, onAdded }) {
  const { lookups } = useApp();
  const [action, setAction] = useState('modify');
  const [itemId, setItemId] = useState('');
  const [requestId, setRequestId] = useState('');
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState({});
  const { busy, error, run } = useAction();
  const setF = (k, v) => setFields(p => ({ ...p, [k]: v }));
  const item = items.find(i => String(i.id) === String(itemId));

  async function add(e) {
    e.preventDefault();
    const payload = {};
    for (const [k, v] of Object.entries(fields)) if (v !== '' && v !== undefined) payload[k] = v;
    const body = { action, reason, payload, item_id: action === 'add' ? undefined : Number(itemId), request_id: action === 'add' ? Number(requestId) : undefined };
    const out = await run(() => api.post(`/revisions/${revision.id}/changes`, body));
    if (out) { setFields({}); setReason(''); setItemId(''); setRequestId(''); onAdded(); }
  }

  const fieldInput = ([k, name, type]) => {
    const cur = item ? item[k] : '';
    if (type === 'method') return <select value={fields[k] || ''} onChange={e => setF(k, e.target.value)}><option value="">{action === 'modify' && cur ? `keep (${cur})` : 'not set'}</option>{lookups.methods.map(m => <option key={m}>{m}</option>)}</select>;
    if (type === 'committee') return <select value={fields[k] || ''} onChange={e => setF(k, e.target.value)}><option value="">{action === 'modify' && cur ? `keep (${cur})` : 'auto'}</option>{lookups.committeeLevels.map(m => <option key={m}>{m}</option>)}</select>;
    return <input type={type} step={type === 'number' ? 'any' : undefined} value={fields[k] ?? ''} placeholder={action === 'modify' && cur !== '' && cur != null ? `keep (${cur})` : ''} onChange={e => setF(k, e.target.value)} />;
  };
  const shown = action === 'add' ? MOD_FIELDS.filter(f => ['method', 'committee_level', 'procurement_start', 'expected_delivery'].includes(f[0])) : MOD_FIELDS;

  return (
    <form onSubmit={add} className="hintbox" style={{ marginTop: 12 }}>
      <b>Add a change</b>
      <Msg error={error} />
      <div className="grid g3" style={{ marginTop: 8 }}>
        <label className="field"><span>Action</span>
          <select value={action} onChange={e => { setAction(e.target.value); setFields({}); }}>
            <option value="modify">Modify an item</option><option value="add">Add a new item</option><option value="cancel">Cancel an item</option>
          </select></label>
        {action === 'add' ? (
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Authorised request (cycle {fy})</span>
            <select value={requestId} onChange={e => setRequestId(e.target.value)} required>
              <option value="">Select…</option>
              {requests.map(r => <option key={r.id} value={r.id}>{r.ref_no} — {r.title}{r.mgmt_rejected_at ? ' (rejected by management — resubmit)' : ''}</option>)}
            </select></label>
        ) : (
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Plan item</span>
            <select value={itemId} onChange={e => setItemId(e.target.value)} required>
              <option value="">Select…</option>
              {items.filter(i => i.status !== 'cancelled').map(i => <option key={i.id} value={i.id}>{i.ref_no} — {i.title}</option>)}
            </select></label>
        )}
      </div>
      {action !== 'cancel' && <div className="grid g4">{shown.map(f => <label className="field" key={f[0]}><span>{f[1]}</span>{fieldInput(f)}</label>)}</div>}
      <label className="field"><span>Reason (required)</span><input type="text" value={reason} onChange={e => setReason(e.target.value)} required /></label>
      <button className="primary" type="submit" disabled={busy}>Add change</button>
    </form>
  );
}

const changeText = payload => Object.entries(payload || {}).filter(([k]) => k !== 'request_id').map(([k, v]) => `${label(k)}: ${v}`).join('; ');

// Modification / cancellation requests sent by departments, waiting for the procurement unit.
function DepartmentRequests({ rows, drafts, isProc, onDone }) {
  const [target, setTarget] = useState({});
  const { busy, error, ok, run } = useAction();
  const include = async c => {
    const revisionId = target[c.id] || (drafts[0] && drafts[0].id);
    if (await run(() => api.post(`/change-requests/${c.id}/include`, { revision_id: Number(revisionId) }), `${c.ref_no}: added to revision #${revisionId}.`)) onDone();
  };
  const ret = c => async comment => { if (await run(() => api.post(`/change-requests/${c.id}/return`, { comment }), `${c.ref_no}: returned to the department.`)) onDone(); };

  return (
    <>
      <div className="section-title">Change requests from departments ({rows.length})</div>
      <Msg error={error} ok={ok} />
      {rows.length === 0 ? <div className="card" style={{ marginBottom: 16 }}><div className="empty">No modification or cancellation requests waiting.</div></div> : rows.map(c => (
        <div className="card" key={c.id} style={{ marginBottom: 12 }}>
          <div className="between">
            <div><span className={'pill ' + (c.action === 'cancel' ? 'bad' : 'warn')}>{c.action === 'cancel' ? 'cancellation' : 'modification'}</span> <b>{c.ref_no}</b> — {c.title}</div>
            <div className="hint" style={{ margin: 0 }}>{c.department}{c.sub_unit ? ' / ' + c.sub_unit : ''} · {c.requested_by_name} · {c.created_at.slice(0, 10)}{c.authorised_by_name ? ` · authorised by ${c.authorised_by_name}` : ''}</div>
          </div>
          {c.action === 'modify' && <p style={{ margin: '6px 0', fontSize: 13 }}>Proposed: {changeText(c.payload)}</p>}
          <p className="hint" style={{ margin: '4px 0 10px' }}>Reason: {c.reason}</p>
          {isProc && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              {drafts.length === 0 ? <span className="hint" style={{ margin: 0 }}>Create a draft revision above to take this forward.</span> : <>
                <select value={target[c.id] || drafts[0].id} onChange={e => setTarget({ ...target, [c.id]: e.target.value })} style={{ width: 'auto' }}>
                  {drafts.map(d => <option key={d.id} value={d.id}>Revision #{d.id} — {d.title}</option>)}
                </select>
                <button className="primary" disabled={busy} onClick={() => include(c)}>Add to revision</button>
              </>}
            </div>
          )}
          {isProc && <CommentAction busy={busy} actions={[{ label: 'Return to department', onClick: ret(c) }]} />}
        </div>
      ))}
    </>
  );
}

export default function RevisionsPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [plan, setPlan] = useState(null);
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [rev, setRev] = useState(null);
  const [report, setReport] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [items, setItems] = useState([]);
  const [requests, setRequests] = useState([]);
  const [deptRequests, setDeptRequests] = useState([]);
  const [form, setForm] = useState({ kind: 'bi_annual', title: '', justification: '' });
  const { busy, error, ok, run } = useAction();
  const isProc = ['procurement', 'admin'].includes(user.role);

  const load = useCallback(async () => {
    setPlan((await api.get('/plans/' + fy)).plan);
    setList(await api.get('/revisions?plan_fy=' + fy));
    const claims = await api.get('/revisions/open-claims?plan_fy=' + fy);
    // Anything already taken up by an open revision is not offered again.
    const takenRequests = new Set(claims.requests.map(c => c.request_id));
    const cancelledItems = new Set(claims.cancelled_items.map(c => c.item_id));
    setItems((await api.get('/plan-items?plan_fy=' + fy)).filter(i => !cancelledItems.has(i.id)));
    // Authorised requests not yet planned, plus requests management rejected from this plan (resubmission).
    const authorised = await api.get('/requests?status=authorised&unplanned=1');
    const rejected = (await api.get('/requests?status=rejected')).filter(r => r.mgmt_rejected_at);
    setRequests([...authorised, ...rejected].filter(r => r.plan_fy === fy && !takenRequests.has(r.id)));
    setDeptRequests(await api.get(`/change-requests?status=pending&plan_fy=${fy}`));
    if (openId) {
      setRev(await api.get('/revisions/' + openId));
      setReport(await api.get(`/revisions/${openId}/report`));
    }
  }, [fy, openId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOpenId(null); setRev(null); setReport(null); }, [fy]);
  // Management sees the summary report straight away when a revision awaits its decision.
  useEffect(() => { setShowReport(!!rev && rev.status === 'submitted' && user.role === 'management'); }, [rev?.id, rev?.status, user.role]);

  const revisable = plan && ['approved', 'frozen'].includes(plan.status);
  const create = async e => {
    e.preventDefault();
    const out = await run(() => api.post('/revisions', { ...form, plan_fy: fy }), 'Revision created — add its changes below.');
    if (out) { setForm({ kind: 'bi_annual', title: '', justification: '' }); setOpenId(out.id); }
  };
  // `comment` must be a string: a click handler would otherwise pass the DOM event, which cannot be sent as JSON.
  const step = (path, msg) => async comment => { await run(() => api.post(`/revisions/${rev.id}/${path}`, { comment: typeof comment === 'string' ? comment : undefined }), msg); load(); };
  const drafts = list.filter(v => v.status === 'draft');
  const printing = showReport && report ? 'no-print' : '';

  return (
    <div>
      <div className={printing}>
      <div className="between"><h2 style={{ margin: 0 }}>Plan revisions — {fy}</h2>{plan && <span>Plan: <Status value={plan.status} /> v{plan.version}</span>}</div>
      <p className="hint">Once a plan is approved it cannot be edited. Bi-annual or urgent revisions add, modify or cancel items; when management approves a revision the plan version increases and a new snapshot is stored.</p>
      <Msg error={error} ok={ok} />
      {!revisable && <div className="note">Revisions are available after the {fy} plan is approved (currently {plan ? label(plan.status) : 'not started'}).</div>}

      {revisable && isProc && (
        <form className="card" onSubmit={create} style={{ marginBottom: 16 }}>
          <h2>Raise a revision</h2>
          <div className="grid g3">
            <label className="field"><span>Type</span>
              <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="bi_annual">Bi-annual revision</option><option value="urgent">Urgent revision</option></select></label>
            <label className="field" style={{ gridColumn: 'span 2' }}><span>Title</span><input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
          </div>
          <label className="field"><span>Justification</span><textarea rows={2} value={form.justification} onChange={e => setForm({ ...form, justification: e.target.value })} /></label>
          <button className="primary" disabled={busy}>Create draft revision</button>
        </form>
      )}

      {revisable && (isProc || deptRequests.length > 0) && <DepartmentRequests rows={deptRequests} drafts={drafts} isProc={isProc} onDone={load} />}

      <div className="section-title">Revisions</div>
      <div className="card">
        {list.length === 0 ? <div className="empty">No revisions for this plan yet.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>#</th><th>Type</th><th>Title</th><th>Changes</th><th>By</th><th>Status</th><th>Applied</th></tr></thead>
            <tbody>{list.map(v => (
              <tr key={v.id}><td><button className="link" onClick={() => setOpenId(openId === v.id ? null : v.id)}>{v.id}</button></td><td>{label(v.kind)}</td><td className="wrap">{v.title}</td><td>{v.change_count}</td><td>{v.created_by_name}</td><td><Status value={v.status} /></td><td>{v.applied_version ? 'v' + v.applied_version : ''}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {rev && openId === rev.id && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--accent-2)' }}>
          <div className="between"><h2 style={{ margin: 0 }}>Revision #{rev.id}: {rev.title}</h2><Status value={rev.status} /></div>
          {rev.justification && <p className="hint" style={{ marginTop: 6 }}>{rev.justification}</p>}
          {rev.decision_comment && <p className="hint">Decision comment: {rev.decision_comment}</p>}
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Action</th><th>Item</th><th>Change</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              {rev.changes.length === 0 && <tr><td colSpan={5} className="empty">No changes yet.</td></tr>}
              {rev.changes.map(c => (
                <tr key={c.id}><td><span className={'pill ' + (c.action === 'cancel' ? 'bad' : c.action === 'add' ? 'ok' : 'warn')}>{c.action}</span>{c.change_request_id && <span className="pill warn" style={{ marginLeft: 4 }}>dept request</span>}</td>
                  <td className="wrap">{c.item_ref} {c.item_title}</td>
                  <td className="wrap">{changeText(c.payload)}</td>
                  <td className="wrap">{c.reason}</td>
                  <td>{rev.status === 'draft' && isProc && <button className="mini" onClick={async () => { await run(() => api.del(`/revisions/${rev.id}/changes/${c.id}`)); load(); }}>remove</button>}</td></tr>
              ))}
            </tbody>
          </table></div>

          {rev.status === 'draft' && isProc && (
            <>
              <ChangeForm revision={rev} fy={fy} items={items} requests={requests} onAdded={load} />
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="primary" disabled={busy || rev.changes.length === 0} onClick={() => step('submit', 'Revision submitted to management.')()}>Submit to management</button>
                <span className="hint" style={{ margin: 0 }}>Check the summary report below first; management sees the same report.</span>
              </div>
            </>
          )}
          {rev.status === 'submitted' && (user.role === 'management'
            ? <div style={{ marginTop: 12 }}><CommentAction busy={busy} actions={[
              { label: 'Approve revision', primary: true, onClick: step('approve', 'Revision approved and applied — plan version increased.') },
              { label: 'Reject', onClick: step('reject', 'Revision rejected.') }]} /></div>
            : <div className="hint" style={{ marginTop: 10 }}>Awaiting management decision.</div>)}
          {rev.changes.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button className="ghost" onClick={() => setShowReport(s => !s)}>{showReport ? 'Hide summary report' : 'Summary report for management'}</button>
            </div>
          )}
        </div>
      )}
      </div>

      {rev && openId === rev.id && showReport && report && rev.changes.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <ReportTable report={report} filename={`revision-${rev.id}`} />
        </div>
      )}
    </div>
  );
}
