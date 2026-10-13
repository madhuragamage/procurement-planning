import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, inclVat, PRIORITY, FUNDING_LABEL, recurLabel, label, phasingLabel } from '../lib/format.js';

export default function AuthorisationsPage() {
  const [pending, setPending] = useState([]);
  const [done, setDone] = useState([]);
  const [changes, setChanges] = useState([]);
  const { busy, error, ok, run } = useAction();

  const load = useCallback(async () => {
    setPending(await api.get('/requests?status=submitted'));
    setDone(await api.get('/requests?status=authorised'));
    setChanges(await api.get('/change-requests?status=submitted'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = (r, path, msg) => async comment => { await run(() => api.post(`/requests/${r.id}/${path}`, { comment }), msg); load(); };
  const actChange = (c, path, msg) => async comment => { await run(() => api.post(`/change-requests/${c.id}/${path}`, { comment }), msg); load(); };

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Department authorisation</h2>
      <p className="hint">Review your department's submitted requests. Authorised requests go to the procurement unit; returned ones go back to the requester with your comment.</p>
      <Msg error={error} ok={ok} />
      {pending.length === 0 ? <div className="card"><div className="empty">Nothing waiting for authorisation.</div></div> : pending.map(r => (
        <div className="card" key={r.id} style={{ marginBottom: 14 }}>
          <div className="between">
            <div><b>{r.ref_no}</b> — {r.title} <Status value={r.status} /></div>
            <div style={{ fontFamily: 'var(--mono)' }}>LKR {fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))} Mn incl. VAT</div>
          </div>
          <p className="hint" style={{ margin: '6px 0' }}>
            {r.department}{r.sub_unit ? ' / ' + r.sub_unit : ''} · {r.category} · {r.expense_type} · {recurLabel(r)}{phasingLabel(r) ? ` · budget phasing ${phasingLabel(r)}` : ''} · reason: {r.reason}{r.reason_note ? ` (${r.reason_note})` : ''} · {FUNDING_LABEL[r.funding_source]}{r.funding_agency ? ` (${r.funding_agency})` : ''} · priority {PRIORITY[r.priority]} · plan {r.plan_fy}+{r.year_offset} · required {r.required_date} · by {r.requested_by_name}
          </p>
          {r.description && <p style={{ margin: '0 0 10px', fontSize: 13 }}>{r.description}</p>}
          <CommentAction busy={busy} actions={[
            { label: 'Authorise', primary: true, onClick: act(r, 'authorise', `${r.ref_no} authorised.`) },
            { label: 'Return for changes', onClick: act(r, 'return', `${r.ref_no} returned.`) },
            { label: 'Reject', onClick: act(r, 'reject', `${r.ref_no} rejected.`) }
          ]} />
        </div>
      ))}
      <div className="section-title">Plan change requests ({changes.length})</div>
      <p className="hint">Requests from your department to modify or cancel items in the approved plan. Authorised ones go to the procurement unit, which takes them into a plan revision for management approval.</p>
      {changes.length === 0 ? <div className="card"><div className="empty">No change requests waiting for authorisation.</div></div> : changes.map(c => (
        <div className="card" key={c.id} style={{ marginBottom: 14 }}>
          <div className="between">
            <div><span className={'pill ' + (c.action === 'cancel' ? 'bad' : 'warn')}>{c.action === 'cancel' ? 'cancellation' : 'modification'}</span> <b>{c.ref_no}</b> — {c.title}</div>
            <div style={{ fontFamily: 'var(--mono)' }}>LKR {fmt(inclVat(c.tce_excl_vat_mn, c.vat_pct))} Mn incl. VAT · plan {c.plan_fy}+{c.year_offset}</div>
          </div>
          <p className="hint" style={{ margin: '6px 0' }}>{c.department}{c.sub_unit ? ' / ' + c.sub_unit : ''} · {c.expense_type} · by {c.requested_by_name} on {c.created_at.slice(0, 10)}</p>
          {c.action === 'modify' && <p style={{ margin: '0 0 6px', fontSize: 13 }}>Proposed: {Object.entries(c.payload || {}).map(([k, v]) => `${label(k)}: ${v}`).join('; ')}</p>}
          <p style={{ margin: '0 0 10px', fontSize: 13 }}>Reason: {c.reason}</p>
          <CommentAction busy={busy} actions={[
            { label: 'Authorise', primary: true, onClick: actChange(c, 'authorise', `${c.ref_no}: change request authorised and sent to the procurement unit.`) },
            { label: 'Return to requester', onClick: actChange(c, 'return-to-requester', `${c.ref_no}: change request returned.`) }
          ]} />
        </div>
      ))}

      <div className="section-title">Recently authorised</div>
      <div className="card">
        {done.length === 0 ? <div className="empty">None yet.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Ref</th><th>Title</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Authorised by</th><th>Planned?</th></tr></thead>
            <tbody>{done.map(r => <tr key={r.id}><td>{r.ref_no}</td><td className="wrap">{r.title}</td><td style={{ textAlign: 'right' }}>{fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))}</td><td>{r.authorised_by_name}</td><td>{r.plan_item_id ? 'in plan' : 'awaiting procurement'}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
