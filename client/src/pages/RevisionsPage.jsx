import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { label } from '../lib/format.js';

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
              {requests.map(r => <option key={r.id} value={r.id}>{r.ref_no} — {r.title}</option>)}
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

export default function RevisionsPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [plan, setPlan] = useState(null);
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [rev, setRev] = useState(null);
  const [items, setItems] = useState([]);
  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState({ kind: 'bi_annual', title: '', justification: '' });
  const { busy, error, ok, run } = useAction();
  const isProc = ['procurement', 'admin'].includes(user.role);

  const load = useCallback(async () => {
    setPlan((await api.get('/plans/' + fy)).plan);
    setList(await api.get('/revisions?plan_fy=' + fy));
    setItems(await api.get('/plan-items?plan_fy=' + fy));
    setRequests((await api.get('/requests?status=authorised&unplanned=1')).filter(r => r.plan_fy === fy));
    if (openId) setRev(await api.get('/revisions/' + openId));
  }, [fy, openId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setOpenId(null); setRev(null); }, [fy]);

  const revisable = plan && ['approved', 'frozen'].includes(plan.status);
  const create = async e => {
    e.preventDefault();
    const out = await run(() => api.post('/revisions', { ...form, plan_fy: fy }), 'Revision created — add its changes below.');
    if (out) { setForm({ kind: 'bi_annual', title: '', justification: '' }); setOpenId(out.id); }
  };
  const step = (path, msg) => async comment => { await run(() => api.post(`/revisions/${rev.id}/${path}`, { comment }), msg); load(); };

  return (
    <div>
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
                <tr key={c.id}><td><span className={'pill ' + (c.action === 'cancel' ? 'bad' : c.action === 'add' ? 'ok' : 'warn')}>{c.action}</span></td>
                  <td className="wrap">{c.action === 'add' ? `request #${c.payload.request_id}` : `${c.item_ref} ${c.item_title}`}</td>
                  <td className="wrap">{Object.entries(c.payload || {}).filter(([k]) => k !== 'request_id').map(([k, v]) => `${label(k)}: ${v}`).join('; ')}</td>
                  <td className="wrap">{c.reason}</td>
                  <td>{rev.status === 'draft' && isProc && <button className="mini" onClick={async () => { await run(() => api.del(`/revisions/${rev.id}/changes/${c.id}`)); load(); }}>remove</button>}</td></tr>
              ))}
            </tbody>
          </table></div>

          {rev.status === 'draft' && isProc && (
            <>
              <ChangeForm revision={rev} fy={fy} items={items} requests={requests} onAdded={load} />
              <div style={{ marginTop: 12 }}><button className="primary" disabled={busy || rev.changes.length === 0} onClick={step('submit', 'Revision submitted to management.')}>Submit to management</button></div>
            </>
          )}
          {rev.status === 'submitted' && (user.role === 'management'
            ? <div style={{ marginTop: 12 }}><CommentAction busy={busy} actions={[
              { label: 'Approve revision', primary: true, onClick: step('approve', 'Revision approved and applied — plan version increased.') },
              { label: 'Reject', onClick: step('reject', 'Revision rejected.') }]} /></div>
            : <div className="hint" style={{ marginTop: 10 }}>Awaiting management decision.</div>)}
        </div>
      )}
    </div>
  );
}
