import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction } from '../components/ui.jsx';
import { fmt } from '../lib/format.js';

function Detail({ item, canEdit, onSaved }) {
  const { lookups } = useApp();
  const [ms, setMs] = useState(() => Object.fromEntries(lookups.milestones.map(m => [m.key, { revised: item.milestones?.[m.key]?.revised || '', actual: item.milestones?.[m.key]?.actual || '' }])));
  const [c, setC] = useState({ contractor: item.contractor || '', award_value_mn: item.award_value_mn ?? '', contract_date: item.contract_date || '', status: item.status, remarks: item.remarks || '' });
  const { busy, error, ok, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);

  async function save(e) {
    e.preventDefault();
    const out = await run(() => api.put(`/plan-items/${item.id}/execution`, { milestones: ms, ...c }), 'Progress saved.');
    if (out) onSaved();
  }
  const setM = (k, f, v) => setMs(p => ({ ...p, [k]: { ...p[k], [f]: v } }));

  return (
    <form className="card" onSubmit={save} style={{ marginTop: 14, borderColor: 'var(--accent-2)' }}>
      <h2>{item.ref_no} — {item.title}</h2>
      <p className="hint">{item.department} · {item.method || 'method not assigned'} · committee {item.committee_level || '—'} · LKR {fmt(item.tce_incl_vat_mn)} Mn incl. VAT</p>
      <Msg error={error} ok={ok} />
      <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
        <thead><tr><th>Milestone</th><th>Scheduled</th><th>Revised</th><th>Actual</th><th></th></tr></thead>
        <tbody>{lookups.milestones.map(m => {
          const sched = item.milestones?.[m.key]?.scheduled || '';
          const e = ms[m.key];
          const target = e.revised || sched;
          const late = e.actual ? (sched && e.actual > sched ? 'late' : '') : (target && target < today ? 'overdue' : '');
          return (
            <tr key={m.key}><td className="wrap">{m.label}</td><td>{sched}</td>
              <td><input type="date" value={e.revised} disabled={!canEdit} onChange={ev => setM(m.key, 'revised', ev.target.value)} /></td>
              <td><input type="date" value={e.actual} disabled={!canEdit} onChange={ev => setM(m.key, 'actual', ev.target.value)} /></td>
              <td>{late && <span className={'pill ' + (late === 'overdue' ? 'bad' : 'warn')}>{late}</span>}</td></tr>
          );
        })}</tbody>
      </table></div>
      <div className="section-title">Contract</div>
      <div className="grid g4">
        <label className="field"><span>Supplier / contractor</span><input type="text" value={c.contractor} disabled={!canEdit} onChange={e => setC({ ...c, contractor: e.target.value })} /></label>
        <label className="field"><span>Award value (LKR Mn)</span><input type="number" step="any" min="0" value={c.award_value_mn} disabled={!canEdit} onChange={e => setC({ ...c, award_value_mn: e.target.value })} /></label>
        <label className="field"><span>Contract date</span><input type="date" value={c.contract_date} disabled={!canEdit} onChange={e => setC({ ...c, contract_date: e.target.value })} /></label>
        <label className="field"><span>Status</span>
          <select value={c.status} disabled={!canEdit} onChange={e => setC({ ...c, status: e.target.value })}>
            {['planned', 'in_progress', 'awarded', 'completed'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select></label>
      </div>
      <label className="field"><span>Remarks</span><input type="text" value={c.remarks} disabled={!canEdit} onChange={e => setC({ ...c, remarks: e.target.value })} /></label>
      {canEdit && <button className="primary" disabled={busy}>Save progress</button>}
      <p className="hint" style={{ marginTop: 10 }}>Scheduled dates are part of the approved plan and only change through a plan revision. Record slippage as a revised date and completion as an actual date; the quarterly report picks both up.</p>
    </form>
  );
}

export default function ExecutionPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [plan, setPlan] = useState(null);
  const [items, setItems] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [dept, setDept] = useState('');
  const load = useCallback(async () => {
    setPlan((await api.get('/plans/' + fy)).plan);
    setItems(await api.get('/plan-items?plan_fy=' + fy));
  }, [fy]);
  useEffect(() => { load(); setOpenId(null); }, [load]);

  const tracking = plan && ['approved', 'frozen'].includes(plan.status);
  const canEdit = ['procurement', 'admin'].includes(user.role) && tracking;
  const shown = items.filter(i => i.status !== 'cancelled' && (!dept || String(i.department_id) === dept));
  const departments = [...new Map(items.map(i => [i.department_id, i.department])).entries()];
  const open = items.find(i => i.id === openId);

  return (
    <div>
      <div className="between">
        <h2 style={{ margin: 0 }}>Execution and progress — {fy}</h2>
        <select value={dept} onChange={e => setDept(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All departments</option>
          {departments.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
      </div>
      <p className="hint">Track each procurement against its schedule once the plan is approved. Overdue milestones feed the dashboard and the quarterly performance report.</p>
      {plan && !tracking && <div className="note">Progress tracking starts after management approves the {fy} plan (currently {plan.status.replace('_', ' ')}).</div>}

      <div className="card">
        {shown.length === 0 ? <div className="empty">No items.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Ref</th><th>Description</th><th>Department</th><th>Method</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Status</th><th>Execution</th><th>Overdue</th><th></th></tr></thead>
            <tbody>{shown.map(i => (
              <tr key={i.id}><td>{i.ref_no}</td><td className="wrap">{i.title}</td><td>{i.department}</td><td>{i.method}</td>
                <td style={{ textAlign: 'right' }}>{fmt(i.tce_incl_vat_mn)}</td><td><Status value={i.status} /></td><td><Status value={i.exec_status} /></td>
                <td>{tracking && i.delay.overdue.length > 0 ? <span className="pill bad" title={i.delay.overdue.map(o => `${o.label} (${o.days} d)`).join('\n')}>{i.delay.max_overdue_days} d</span> : ''}</td>
                <td><button className="mini plain" onClick={() => setOpenId(i.id === openId ? null : i.id)}>{i.id === openId ? 'close' : 'open'}</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {open && tracking && open.exec_status !== 'accepted' && (
        <div className="note">Execution of {open.ref_no} has not started: the requesting department must send an execution request and the procurement unit accept it (Procurement inbox). Current state: {open.exec_status.replace('_', ' ')}.</div>
      )}
      {open && tracking && open.exec_status === 'accepted' && <Detail key={open.id + open.updated_at} item={open} canEdit={canEdit} onSaved={load} />}
    </div>
  );
}
