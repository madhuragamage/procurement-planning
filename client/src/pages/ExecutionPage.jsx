import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, BID_TYPE, suggestBidType } from '../lib/format.js';

const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
// Same rule as the server: each milestone falls the given weeks after the previous one.
const datesFromWeeks = (start, weeks, milestones) => {
  let days = 0;
  return Object.fromEntries(milestones.map(m => { days += Math.round((Number(weeks[m.key]) || 0) * 7); return [m.key, addDays(start, days)]; }));
};

// Once execution is authorised the procurement unit sets the working time schedule: the standard lead times
// for this method and value (auto), or its own number of weeks per milestone (custom).
function TimeSchedule({ item, onSaved }) {
  const [data, setData] = useState(null);
  const [mode, setMode] = useState(item.schedule_mode || 'auto');
  const [start, setStart] = useState('');
  const [weeks, setWeeks] = useState({});
  const [open, setOpen] = useState(!item.schedule_mode);
  const { busy, error, ok, run } = useAction();

  useEffect(() => {
    api.get(`/plan-items/${item.id}/schedule${start ? `?start=${start}` : ''}`).then(d => {
      setData(d);
      if (!start) setStart(d.start);
      setWeeks(w => (Object.keys(w).length ? w : d.custom_weeks || d.auto_weeks));
    }).catch(() => setData(null));
  }, [item.id, start]);

  if (!data) return null;
  const used = mode === 'auto' ? data.auto_weeks : weeks;
  const dates = start ? datesFromWeeks(start, used, data.milestones) : {};
  const total = Object.values(used).reduce((s, w) => s + (Number(w) || 0), 0);

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="between">
        <div><h2 style={{ margin: 0 }}>Time schedule</h2>
          <span className="hint" style={{ margin: 0 }}>{item.schedule_mode ? `${item.schedule_mode === 'auto' ? 'Auto' : 'Custom'} schedule set from ${item.schedule_start}; it gives each milestone's target (revised) date. The approved plan dates stay as the baseline.` : 'Not set yet — choose auto or custom scheduling now that execution is authorised.'}</span></div>
        <button className="mini plain" onClick={() => setOpen(o => !o)}>{open ? 'hide' : item.schedule_mode ? 'change' : 'set schedule'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <Msg error={error} ok={ok} />
          <div style={{ display: 'flex', gap: 16, alignItems: 'end', flexWrap: 'wrap', marginBottom: 10 }}>
            <label className="chk"><input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} /> Auto — standard lead times for {item.method || 'this method'} at this value</label>
            <label className="chk"><input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} /> Custom — set the weeks for each milestone</label>
            <label className="field" style={{ marginBottom: 0 }}><span>Procurement starts on</span><input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Milestone</th><th style={{ textAlign: 'right' }}>Weeks after previous</th><th>Target date</th><th>Approved plan date</th></tr></thead>
            <tbody>{data.milestones.map(m => (
              <tr key={m.key}>
                <td className="wrap">{m.label}</td>
                <td style={{ textAlign: 'right' }}>{mode === 'custom'
                  ? <input type="number" min="0" step="0.5" value={weeks[m.key] ?? ''} onChange={e => setWeeks({ ...weeks, [m.key]: e.target.value })} style={{ width: 90, textAlign: 'right' }} />
                  : data.auto_weeks[m.key]}</td>
                <td>{dates[m.key]}</td>
                <td className="hint" style={{ margin: 0 }}>{item.milestones?.[m.key]?.scheduled || ''}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="total-row"><td>Total</td><td style={{ textAlign: 'right' }}>{Math.round(total * 10) / 10} weeks</td><td>{dates.completion}</td><td>{item.milestones?.completion?.scheduled || ''}</td></tr></tfoot>
          </table></div>
          {mode === 'custom' && <div style={{ marginTop: 6 }}><button className="mini plain" onClick={() => setWeeks(data.auto_weeks)}>start from the auto weeks</button></div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button className="primary" disabled={busy || !start} onClick={async () => { if (await run(() => api.put(`/plan-items/${item.id}/schedule`, { mode, start, weeks }), `${mode === 'auto' ? 'Auto' : 'Custom'} schedule applied — completion ${dates.completion}.`)) onSaved(); }}>Apply {mode} schedule</button>
            <span className="hint" style={{ margin: 0 }}>Applying overwrites the target dates of all milestones; actual dates already recorded are kept.</span>
          </div>
        </div>
      )}
    </div>
  );
}

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

// Shown for an item whose execution has not been accepted yet, so it can be moved on from this page:
// the procurement unit accepts / returns a pending request or starts execution itself; a department
// user sends the request.
// Tender or quotation, chosen when the P&P unit starts execution; it decides the bid number series.
export function BidTypeSelect({ value, onChange }) {
  return (
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>Procure by
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: 'auto' }} required>
        <option value="">select…</option>{Object.entries(BID_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
  );
}

function StartExecution({ item, pending, onDone }) {
  const { user } = useAuth();
  const { busy, error, ok, run, setError } = useAction();
  const [bidType, setBidType] = useState(suggestBidType(item.method));
  const isProc = ['procurement', 'admin'].includes(user.role);
  const canAsk = (isProc || ['requester', 'dept_head'].includes(user.role)) && item.status === 'planned' && ['not_requested', 'returned'].includes(item.exec_status);
  const needType = () => { if (!bidType) { setError('Choose tender or quotation — the bid number is created from it.'); return true; } return false; };
  const act = (path, msg) => async comment => {
    if (path === 'accept' && needType()) return;
    const out = await run(() => api.post(`/execution-requests/${pending.id}/${path}`, { comment, bid_type: bidType }), msg);
    if (out) { if (out.bid_no) window.alert(`${item.ref_no}: bid number ${out.bid_no}`); onDone(); }
  };
  const send = async () => {
    if (isProc && needType()) return;
    const note = isProc ? 'Started by the procurement unit' : window.prompt('Note for the procurement unit (optional):', '');
    if (note === null) return;
    const out = await run(() => api.post('/execution-requests', { plan_item_id: item.id, note, bid_type: isProc ? bidType : undefined }), isProc ? `${item.ref_no}: execution started.` : `${item.ref_no}: execution request sent to the procurement unit.`);
    if (out) { if (out.bid_no) window.alert(`${item.ref_no}: bid number ${out.bid_no}`); onDone(); }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>{item.ref_no} — {item.title}</h2>
      <Msg error={error} ok={ok} />
      {item.exec_status === 'requested' && pending ? (
        <>
          <p className="hint">Execution requested by {pending.requested_by_name} on {pending.created_at.slice(0, 10)}{pending.note ? ` — “${pending.note}”` : ''}. Progress can be recorded once the procurement unit accepts it.</p>
          {isProc && <div style={{ marginBottom: 8 }}><BidTypeSelect value={bidType} onChange={setBidType} /> <span className="hint" style={{ margin: 0 }}>Accepting creates the bid number; it is used from then on.</span></div>}
          {isProc && <CommentAction busy={busy} actions={[
            { label: 'Accept and start execution', primary: true, onClick: act('accept', `${item.ref_no}: execution accepted.`) },
            { label: 'Return to department', onClick: act('return', `${item.ref_no}: returned to the department.`) }
          ]} />}
        </>
      ) : (
        <>
          <p className="hint">Execution has not started{item.exec_status === 'returned' ? ' (the last request was returned by the procurement unit)' : ''}. {isProc ? 'Start it here on the department\'s behalf, or wait for the department\'s request.' : 'Send an execution request so the procurement unit can begin.'}</p>
          {canAsk && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {isProc && <BidTypeSelect value={bidType} onChange={setBidType} />}
            <button className="primary" disabled={busy} onClick={send}>{isProc ? 'Start execution now' : 'Request execution'}</button>
          </div>}
        </>
      )}
    </div>
  );
}

// For an item already in execution: give it a bid number (if it predates bid numbers), and once the award
// is made forward the file to the Supplies Department.
function AfterAcceptance({ item, contract, onDone }) {
  const { user } = useAuth();
  const [bidType, setBidType] = useState(suggestBidType(item.method));
  const [note, setNote] = useState('');
  const { busy, error, ok, run, setError } = useAction();
  const isProc = ['procurement', 'admin'].includes(user.role);
  const awarded = ['awarded', 'completed'].includes(item.status) || !!item.milestones?.contract_award?.actual;
  if (!isProc && !contract) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <Msg error={error} ok={ok} />
      {!item.bid_no ? (
        <>
          <h2>Bid number</h2>
          <p className="hint">This procurement started before bid numbers were introduced. Class it as a tender or quotation to create its bid number.</p>
          {isProc && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <BidTypeSelect value={bidType} onChange={setBidType} />
            <button className="primary" disabled={busy} onClick={async () => {
              if (!bidType) return setError('Choose tender or quotation.');
              if (await run(() => api.post(`/execution-requests/bid-number/${item.id}`, { bid_type: bidType }), 'Bid number created.')) onDone();
            }}>Create bid number</button>
          </div>}
        </>
      ) : contract ? (
        <>
          <h2>Supplies Department</h2>
          <p className="hint" style={{ margin: 0 }}>Forwarded on {contract.forwarded_on} by {contract.forwarded_by_name}. {contract.status === 'forwarded' ? 'Waiting for the Supplies Department to accept the file.'
            : contract.status === 'closed' ? `File closed on ${contract.closed_on}.` : `Accepted on ${contract.accepted_on}; ${contract.progress.done} of ${contract.progress.total} steps done${contract.progress.next ? ` — next: ${contract.progress.next.label}` : ''}.`}</p>
        </>
      ) : (
        <>
          <h2>Forward to the Supplies Department</h2>
          <p className="hint">{awarded ? 'The award has been made. Forward the procurement file so the Supplies Department can take over (performance bond, P/Order, delivery).' : 'Available once the award is made: record the contract award date above, or set the status to awarded.'}</p>
          {awarded && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input type="text" placeholder="Note to the Supplies Department (optional)" value={note} onChange={e => setNote(e.target.value)} style={{ flex: '1 1 260px', width: 'auto' }} />
            <button className="primary" disabled={busy} onClick={async () => { if (await run(() => api.post('/supplies/forward', { plan_item_id: item.id, note }), `${item.bid_no}: file forwarded to the Supplies Department.`)) onDone(); }}>Forward file</button>
          </div>}
        </>
      )}
    </div>
  );
}

export default function ExecutionPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [plan, setPlan] = useState(null);
  const [items, setItems] = useState([]);
  const [pending, setPending] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [dept, setDept] = useState('');
  const seesSupplies = ['procurement', 'admin', 'management', 'executive', 'supplies'].includes(user.role);
  const load = useCallback(async () => {
    setPlan((await api.get('/plans/' + fy)).plan);
    setItems(await api.get('/plan-items?plan_fy=' + fy));
    setPending(await api.get('/execution-requests?status=pending'));
    if (seesSupplies) setContracts(await api.get('/supplies/contracts'));
  }, [fy, seesSupplies]);
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
            <thead><tr><th>Bid No / Ref</th><th>Description</th><th>Department</th><th>Method</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Status</th><th>Execution</th><th>Overdue</th><th></th></tr></thead>
            <tbody>{shown.map(i => (
              <tr key={i.id}><td>{i.bid_no ? <><b>{i.bid_no}</b><div className="hint" style={{ margin: 0 }}>{i.ref_no}</div></> : i.ref_no}</td><td className="wrap">{i.title}{contracts.some(c => c.plan_item_id === i.id) && <span className="pill ok" style={{ marginLeft: 6 }}>with Supplies</span>}</td><td>{i.department}</td><td>{i.method}</td>
                <td style={{ textAlign: 'right' }}>{fmt(i.tce_incl_vat_mn)}</td><td><Status value={i.status} /></td><td><Status value={i.exec_status} /></td>
                <td>{tracking && i.delay.overdue.length > 0 ? <span className="pill bad" title={i.delay.overdue.map(o => `${o.label} (${o.days} d)`).join('\n')}>{i.delay.max_overdue_days} d</span> : ''}</td>
                <td><button className="mini plain" onClick={() => setOpenId(i.id === openId ? null : i.id)}>{i.id === openId ? 'close' : 'open'}</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {open && tracking && open.exec_status !== 'accepted' && (
        <StartExecution key={open.id + open.exec_status} item={open} pending={pending.find(p => p.plan_item_id === open.id)} onDone={load} />
      )}
      {open && tracking && open.exec_status === 'accepted' && canEdit && <TimeSchedule key={'s' + open.id + open.updated_at} item={open} onSaved={load} />}
      {open && tracking && open.exec_status === 'accepted' && <Detail key={open.id + open.updated_at} item={open} canEdit={canEdit} onSaved={load} />}
      {open && tracking && open.exec_status === 'accepted' && <AfterAcceptance key={'a' + open.id + open.updated_at} item={open} contract={contracts.find(c => c.plan_item_id === open.id)} onDone={load} />}
    </div>
  );
}
