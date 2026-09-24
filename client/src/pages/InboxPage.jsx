import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import ItemForm from '../components/ItemForm.jsx';
import { Msg } from '../components/ui.jsx';
import { fmt, inclVat, PRIORITY } from '../lib/format.js';

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
      <thead><tr><th>Ref</th><th>Title</th><th>Department</th><th>Category</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Funding</th><th>Priority</th><th>Year</th><th>Required</th><th></th></tr></thead>
      <tbody>{list.map(r => (
        <tr key={r.id}><td>{r.ref_no}</td><td className="wrap">{r.title}</td><td>{r.department}</td><td>{r.category}</td>
          <td style={{ textAlign: 'right' }}>{fmt(inclVat(r.tce_excl_vat_mn, r.vat_pct))}</td><td>{r.funding_source}</td><td>{PRIORITY[r.priority]}</td>
          <td>{r.plan_fy}+{r.year_offset}</td><td>{r.required_date}</td>
          <td><button className="mini plain" onClick={() => { setMsg(''); setActive(r); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>assign</button></td></tr>
      ))}</tbody>
    </table></div>
  );

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Procurement inbox</h2>
      <p className="hint">Authorised requests waiting for a procurement method, committee and schedule. Assigning a request adds it to the plan for its cycle.</p>
      <Msg ok={msg} />
      {locked && <div className="error-banner">The {fy} plan is {plan.status.replace('_', ' ')} — new items now go in through a <Link to="/app/revisions">plan revision</Link>.</div>}

      {active && (
        <ItemForm mode="create" source={active} categoryId={active.category_id}
          onCancel={() => setActive(null)}
          onSaved={item => { setActive(null); setMsg(`${item.ref_no} added to the ${item.plan_fy} plan.`); load(); }} />
      )}

      <div className="section-title">Cycle {fy}</div>
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
