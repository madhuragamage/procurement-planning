import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import ItemForm from '../components/ItemForm.jsx';
import { Msg, Status, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, inclVat, PRIORITY, FUNDING_LABEL } from '../lib/format.js';

function ExecutionRequests() {
  const [rows, setRows] = useState([]);
  const { busy, error, ok, run } = useAction();
  const load = useCallback(() => api.get('/execution-requests?status=pending').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  const act = (e, path, msg) => async comment => { await run(() => api.post(`/execution-requests/${e.id}/${path}`, { comment }), msg); load(); };

  return (
    <>
      <div className="section-title">Execution requests from departments ({rows.length})</div>
      <Msg error={error} ok={ok} />
      {rows.length === 0 ? <div className="card"><div className="empty">No execution requests waiting.</div></div> : rows.map(e => (
        <div className="card" key={e.id} style={{ marginBottom: 12 }}>
          <div className="between">
            <div><b>{e.ref_no}</b> — {e.title} <Status value={e.status} /></div>
            <div style={{ fontFamily: 'var(--mono)' }}>LKR {fmt(inclVat(e.tce_excl_vat_mn, e.vat_pct))} Mn · planned start {e.procurement_start || '—'}</div>
          </div>
          <p className="hint" style={{ margin: '6px 0' }}>
            {e.department}{e.sub_unit ? ' / ' + e.sub_unit : ''} · {e.method || 'method not assigned'} · requested by {e.requested_by_name} on {e.created_at.slice(0, 10)}{e.note ? ` — “${e.note}”` : ''}
          </p>
          <CommentAction busy={busy} actions={[
            { label: 'Accept and start execution', primary: true, onClick: act(e, 'accept', `${e.ref_no}: execution accepted.`) },
            { label: 'Return to department', onClick: act(e, 'return', `${e.ref_no}: returned to the department.`) }
          ]} />
        </div>
      ))}
    </>
  );
}

export default function InboxPage() {
  const { fy } = useApp();
  const [rows, setRows] = useState([]);
  const [plan, setPlan] = useState(null);
  const [active, setActive] = useState(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setRows(await api.get('/requests?status=authorised&unplanned=1'));
    setPlan((await api.get('/plans/' + fy)).plan);
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  const thisCycle = rows.filter(r => r.plan_fy === fy);
  const otherCycles = rows.filter(r => r.plan_fy !== fy);
  const locked = plan && !['planning', 'changes_requested'].includes(plan.status);

  const Table = ({ list }) => (
    <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
      <thead><tr><th>Ref</th><th>Title</th><th>Unit</th><th>Category</th><th>Reason</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Funding</th><th>Priority</th><th>Year</th><th>Required</th><th></th></tr></thead>
      <tbody>{list.map(r => (
        <tr key={r.id}><td>{r.ref_no}</td><td className="wrap">{r.title}</td><td>{r.department}{r.sub_unit ? ' / ' + r.sub_unit : ''}</td><td>{r.category}</td><td>{r.reason}</td>
          <td style={{ textAlign: 'right' }}>{fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))}</td><td>{FUNDING_LABEL[r.funding_source]}</td><td>{PRIORITY[r.priority]}</td>
          <td>{r.plan_fy}+{r.year_offset}</td><td>{r.required_date}</td>
          <td><button className="mini plain" onClick={() => { setMsg(''); setActive(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>assign</button></td></tr>
      ))}</tbody>
    </table></div>
  );

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Procurement inbox</h2>
      <p className="hint">Authorised requests waiting for a procurement method, committee and schedule, and departments' requests to start executing items already in the approved plan. Only the procurement unit executes procurements.</p>
      <Msg ok={msg} />
      {locked && <div className="error-banner">The {fy} plan is {plan.status.replace('_', ' ')} — new items now go in through a <Link to="/app/revisions">plan revision</Link>.</div>}

      {active && (
        <ItemForm mode="create" source={active} categoryId={active.category_id}
          onCancel={() => setActive(null)}
          onSaved={item => { setActive(null); setMsg(`${item.ref_no} added to the ${item.plan_fy} plan.`); load(); }} />
      )}

      <ExecutionRequests />

      <div className="section-title">Requests to plan — cycle {fy}</div>
      <div className="card">{thisCycle.length === 0 ? <div className="empty">No authorised requests are waiting for the {fy} cycle.</div> : <Table list={thisCycle} />}</div>

      {otherCycles.length > 0 && (
        <>
          <div className="section-title">Other cycles</div>
          <div className="card"><Table list={otherCycles} /></div>
        </>
      )}
    </div>
  );
}
