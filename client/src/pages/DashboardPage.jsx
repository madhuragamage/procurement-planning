import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Status, Msg, useAction, ProgressBar, ProgressLegend } from '../components/ui.jsx';
import { fmt, label, pct } from '../lib/format.js';

function Stat({ v, l, cls, to }) {
  const body = <div className={'stat ' + (cls || '')}><div className="v">{v}</div><div className="l">{l}</div></div>;
  return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body;
}

function Reminders({ data, canRequest, onSent }) {
  const { busy, error, ok, run } = useAction();
  if (!data.items.length) return null;
  const request = async it => {
    const note = window.prompt(`Execution request for ${it.ref_no}. Note for the procurement unit (optional):`, '');
    if (note === null) return;
    await run(() => api.post('/execution-requests', { plan_item_id: it.id, note }), `${it.ref_no}: execution request sent to the procurement unit.`);
    onSent();
  };
  const overdue = data.items.some(i => i.days_to_start < 0);
  return (
    <div className={'card reminder' + (overdue ? ' overdue' : '')} style={{ marginBottom: 20 }}>
      <h2>Reminder — procurements due to start</h2>
      <p className="hint">These items are in the approved plan and start within {data.lead_days} days (or are already past their planned start), but no execution request has been accepted. {canRequest ? 'Send an execution request so the procurement unit can begin.' : 'The requesting departments have been reminded.'}</p>
      <Msg error={error} ok={ok} />
      <div className="tbl-wrap" style={{ maxHeight: 260 }}><table>
        <thead><tr><th>Ref</th><th>Description</th><th>Unit</th><th>Method</th><th>Planned start</th><th>When</th><th>Request</th>{canRequest && <th></th>}</tr></thead>
        <tbody>{data.items.map(i => (
          <tr key={i.id}><td>{i.ref_no}</td><td className="wrap">{i.title}</td><td>{i.department}{i.sub_unit ? ' / ' + i.sub_unit : ''}</td><td>{i.method}</td><td>{i.procurement_start}</td>
            <td><span className={'pill ' + (i.days_to_start < 0 ? 'bad' : 'warn')}>{i.days_to_start < 0 ? `${-i.days_to_start} d overdue` : i.days_to_start === 0 ? 'today' : `in ${i.days_to_start} d`}</span></td>
            <td><Status value={i.exec_status} /></td>
            {canRequest && <td><button className="primary" style={{ padding: '5px 10px', fontSize: 12 }} disabled={busy} onClick={() => request(i)}>Request execution</button></td>}</tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

const REQUEST_STAGE = {
  draft: ['Draft — submit it to your department head', 'warn'],
  submitted: ['Awaiting department head authorisation', 'warn'],
  returned: ['Returned — revise and resubmit', 'bad'],
  authorised: ['Authorised — awaiting the procurement unit', 'ok']
};

// Department users: their own requests and execution requests that are still waiting on someone.
function MyPending({ p }) {
  const rows = [
    ...p.requests.map(r => ({ key: 'r' + r.id, kind: 'Request', ref: r.ref_no, title: r.title, stage: REQUEST_STAGE[r.status], comment: r.review_comment, date: r.updated_at, to: '/app/requests' })),
    ...p.execution_requests.map(e => ({ key: 'e' + e.id, kind: 'Execution', ref: e.ref_no, title: e.title,
      stage: e.status === 'pending' ? ['Awaiting procurement unit acceptance', 'warn'] : ['Returned by procurement — send a new request', 'bad'],
      comment: e.decision_comment, date: e.decided_at || e.created_at, to: '/app/execution' })),
    ...p.change_requests.map(c => ({ key: 'c' + c.id, kind: c.action === 'cancel' ? 'Cancellation' : 'Modification', ref: c.ref_no, title: c.title,
      stage: c.status === 'submitted' ? ['Awaiting department head authorisation', 'warn']
        : c.status === 'pending' ? ['Authorised — awaiting the procurement unit', 'warn']
        : c.status === 'returned' ? ['Returned', 'bad']
        : c.revision_status === 'approved' ? [`Approved (revision #${c.revision_id})`, 'ok']
        : c.revision_status === 'rejected' ? [`Rejected by management (revision #${c.revision_id})`, 'bad']
        : c.revision_status === 'submitted' ? [`Awaiting management (revision #${c.revision_id})`, 'warn']
        : [`In draft revision #${c.revision_id}`, 'warn'],
      comment: c.decision_comment || c.revision_comment, date: c.revision_decided_at || c.decided_at || c.created_at, to: '/app/plan' }))
  ];
  return (
    <div className="card" style={{ marginTop: 22 }}>
      <h2>Your pending items</h2>
      <p className="hint">Requests, execution requests and plan change requests from your unit that are not finished yet (and outcomes from the last 30 days), and who they are waiting on.</p>
      {rows.length === 0 ? <div className="empty">Nothing pending.</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Type</th><th>Ref</th><th>Description</th><th>Waiting on</th><th>Comment</th><th>Since</th></tr></thead>
          <tbody>{rows.map(x => (
            <tr key={x.key}><td>{x.kind}</td><td><Link to={x.to}>{x.ref}</Link></td><td className="wrap">{x.title}</td>
              <td><span className={'pill ' + x.stage[1]}>{x.stage[0]}</span></td><td className="wrap">{x.comment || ''}</td><td>{String(x.date || '').slice(0, 10)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function PlanProgress({ d }) {
  const p = d.progress;
  const scope = d.role === 'requester' || d.role === 'dept_head' ? 'your unit' : 'all departments';
  if (!p) {
    return (
      <div className="card">
        <h2>Plan progress {d.plan_fy}</h2>
        <div className="empty">Progress is tracked once management approves the {d.plan_fy} plan (currently {label(d.plan_status)}).</div>
      </div>
    );
  }
  const o = p.overall;
  return (
    <div className="card">
      <div className="between"><h2 style={{ margin: 0 }}>Plan progress {d.plan_fy} — annual plan, {scope}</h2><Link to="/app/execution" className="hint" style={{ margin: 0 }}>Open execution</Link></div>
      {o.count === 0 ? <div className="empty">No items in the annual plan.</div> : (
        <>
          <div className="grid g4" style={{ marginTop: 14, alignItems: 'center' }}>
            <div><div className="bigpct">{pct(o.actual_pct)}</div><div className="hint" style={{ margin: '4px 0 0' }}>actual progress, value-weighted</div></div>
            <div><div className="bigpct" style={{ color: 'var(--warn)' }}>{pct(o.expected_pct)}</div><div className="hint" style={{ margin: '4px 0 0' }}>expected by schedule today</div></div>
            <div><div className="bigpct" style={{ fontSize: 28 }}>{o.stages.completed + o.stages.awarded} / {o.count}</div><div className="hint" style={{ margin: '4px 0 0' }}>procurements awarded or completed</div></div>
            <div><div className="bigpct" style={{ fontSize: 28, color: o.overdue ? 'var(--bad)' : 'var(--good)' }}>{o.overdue}</div><div className="hint" style={{ margin: '4px 0 0' }}>with an overdue milestone</div></div>
          </div>
          <div style={{ marginTop: 14 }}><ProgressBar actual={o.actual_pct} expected={o.expected_pct} /><ProgressLegend /></div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12 }}>
            <span><Status value="planned" /> {o.stages.not_started} not started</span><span><Status value="in_progress" /> {o.stages.in_progress} in progress</span>
            <span><Status value="awarded" /> {o.stages.awarded} awarded</span><span><Status value="completed" /> {o.stages.completed} completed</span>
          </div>
          {p.by_department.length > 1 && (
            <div className="tbl-wrap" style={{ marginTop: 14, maxHeight: 300 }}><table>
              <thead><tr><th>Department</th><th style={{ textAlign: 'right' }}>Items</th><th style={{ textAlign: 'right' }}>Value (Mn)</th><th style={{ textAlign: 'right' }}>Actual</th><th style={{ textAlign: 'right' }}>Expected</th><th style={{ width: 180 }}>Progress</th><th style={{ textAlign: 'right' }}>Overdue</th></tr></thead>
              <tbody>{p.by_department.map(x => (
                <tr key={x.name}><td>{x.name}</td><td style={{ textAlign: 'right' }}>{x.count}</td><td style={{ textAlign: 'right' }}>{fmt(x.value)}</td>
                  <td style={{ textAlign: 'right' }}>{pct(x.actual_pct)}</td><td style={{ textAlign: 'right' }}>{pct(x.expected_pct)}</td>
                  <td><ProgressBar actual={x.actual_pct} expected={x.expected_pct} /></td><td style={{ textAlign: 'right' }}>{x.overdue || ''}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { fy } = useApp();
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get('/dashboard?plan_fy=' + fy).then(setD).catch(e => setError(e.message));
    api.get('/budgets/availability?year=' + fy).then(setAvailability).catch(() => setAvailability([]));
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!d) return <div className="loading"><span className="spinner"></span> Loading…</div>;

  const t = d.todo;
  const role = d.role;
  const reqTotal = Object.values(d.requests).reduce((a, b) => a + b, 0);
  const deptRole = role === 'requester' || role === 'dept_head';

  return (
    <div>
      <Reminders data={d.reminders} canRequest={deptRole} onSent={load} />

      <div className="section-title" style={{ marginTop: 0 }}>Needs your attention</div>
      <div className="grid g4">
        {(role === 'dept_head' || role === 'admin') && <Stat v={t.to_authorise} l="Requests to authorise" cls={t.to_authorise ? 'warn' : 'ok'} to="/app/authorisations" />}
        {role === 'dept_head' && <Stat v={t.change_requests_to_authorise} l="Plan change requests to authorise" cls={t.change_requests_to_authorise ? 'warn' : 'ok'} to="/app/authorisations" />}
        {(role === 'procurement' || role === 'admin') && <Stat v={t.to_plan} l="Authorised, awaiting a method" cls={t.to_plan ? 'warn' : 'ok'} to="/app/inbox" />}
        {(role === 'procurement' || role === 'admin') && <Stat v={t.execution_requests_pending} l="Execution requests from departments" cls={t.execution_requests_pending ? 'warn' : 'ok'} to="/app/inbox" />}
        {(role === 'procurement' || role === 'admin') && <Stat v={t.change_requests_pending} l="Change requests from departments" cls={t.change_requests_pending ? 'warn' : 'ok'} to="/app/revisions" />}
        {(role === 'management' || role === 'admin') && <Stat v={t.plans_awaiting_approval} l="Plans awaiting approval" cls={t.plans_awaiting_approval ? 'warn' : 'ok'} to="/app/plan" />}
        {(role === 'management' || role === 'admin') && <Stat v={t.revisions_awaiting_approval} l="Revisions awaiting approval" cls={t.revisions_awaiting_approval ? 'warn' : 'ok'} to="/app/revisions" />}
        {deptRole && <Stat v={d.reminders.items.length} l="Items due to start — request execution" cls={d.reminders.items.length ? 'warn' : 'ok'} to="/app/plan" />}
        {deptRole && <Stat v={d.pending.requests.length} l="Your requests in progress" cls={d.pending.requests.some(r => r.status === 'returned') ? 'bad' : d.pending.requests.length ? 'warn' : 'ok'} to="/app/requests" />}
        {deptRole && <Stat v={t.execution_requests_pending} l="Your execution requests awaiting procurement" cls={t.execution_requests_pending ? 'warn' : 'ok'} to="/app/execution" />}
        {role !== 'supplies' && <Stat v={d.delayed_count} l="Items with overdue milestones" cls={d.delayed_count ? 'bad' : 'ok'} to="/app/execution" />}
        {d.supplies && (role === 'supplies' || role === 'admin') && <Stat v={d.supplies.awaiting_acceptance} l="Supplies files to accept" cls={d.supplies.awaiting_acceptance ? 'warn' : 'ok'} to="/app/supplies" />}
        {d.supplies && <Stat v={d.supplies.with_overdue_steps} l="Supplies files with overdue steps" cls={d.supplies.with_overdue_steps ? 'bad' : 'ok'} to="/app/supplies" />}
        {d.supplies && <Stat v={d.supplies.deliveries_overdue} l="Deliveries overdue" cls={d.supplies.deliveries_overdue ? 'bad' : 'ok'} to="/app/supplies" />}
        {d.supplies && <Stat v={d.supplies.bonds_expiring + d.supplies.bonds_expired} l={`Bonds expiring soon${d.supplies.bonds_expired ? ` / ${d.supplies.bonds_expired} expired` : ''}`} cls={d.supplies.bonds_expired ? 'bad' : d.supplies.bonds_expiring ? 'warn' : 'ok'} to="/app/supplies" />}
      </div>

      {deptRole && <MyPending p={d.pending} />}

      <div style={{ marginTop: 22 }}><PlanProgress d={d} /></div>

      <div className="grid g2" style={{ marginTop: 22 }}>
        <div className="card">
          <h2>Deadlines</h2>
          <p className="hint">Statutory and periodic reporting dates under the Procurement Manual (Chapter 4 and Section 2.2).</p>
          <div className="tbl-wrap"><table>
            <tbody>
              {d.deadlines.map(x => (
                <tr key={x.label}><td className="wrap">{x.label}</td><td>{x.date}</td>
                  <td><span className={'pill ' + (x.days < 0 ? 'bad' : x.days <= 30 ? 'warn' : 'ok')}>{x.days < 0 ? `${-x.days} d ago` : `in ${x.days} d`}</span></td></tr>
              ))}
            </tbody>
          </table></div>
        </div>

        <div className="card">
          <h2>Plan cycles</h2>
          <p className="hint">Status of each annual plan (with its two tentative years).</p>
          {d.plans.length === 0 ? <div className="empty">No plan started yet.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Cycle</th><th>Status</th><th>Version</th></tr></thead>
              <tbody>{d.plans.filter(p => !deptRole || ['approved', 'frozen'].includes(p.status)).map(p => <tr key={p.fy}><td>{p.fy}-{p.fy + 2}</td><td><Status value={p.status} /></td><td>v{p.version}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 22 }}>
        <div className="card">
          <h2>Requests {deptRole ? `(${user.sub_unit ? user.sub_unit : user.department})` : ''}</h2>
          <p className="hint">{reqTotal} in total.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(d.requests).map(([s, n]) => <span key={s}><Status value={s} /> {n}</span>)}
            {reqTotal === 0 && <span className="hint">No requests yet.</span>}
          </div>
        </div>

        <div className="card">
          <h2>Budget use {fy}</h2>
          <p className="hint">Committed plan items against allocation, CAPEX and OPEX separately.</p>
          {availability.length === 0 ? <div className="empty">No budget or plan data for {fy}.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Department</th><th>Type</th><th style={{ textAlign: 'right' }}>Allocated</th><th style={{ textAlign: 'right' }}>Committed</th><th>Use</th></tr></thead>
              <tbody>{availability.flatMap(a => [['CAPEX', a.capex], ['OPEX', a.opex]].filter(([, t]) => t.allocated || t.committed).map(([type, t]) => {
                const p = t.allocated ? Math.min(100, (t.committed / t.allocated) * 100) : 0;
                return (
                  <tr key={a.department_id + type}><td>{a.department}</td><td>{type}</td><td style={{ textAlign: 'right' }}>{fmt(t.allocated)}</td><td style={{ textAlign: 'right' }}>{fmt(t.committed)}</td>
                    <td>{t.allocated ? <div className={'bar' + (t.over_budget ? ' over' : '')}><div style={{ width: p + '%' }}></div></div> : <span className="hint">no allocation</span>}</td></tr>
                );
              }))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      {d.delayed.length > 0 && (
        <div className="card" style={{ marginTop: 22 }}>
          <h2>Most overdue procurements</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Ref</th><th>Description</th><th>Department</th><th>Overdue milestone</th><th style={{ textAlign: 'right' }}>Days</th></tr></thead>
            <tbody>{d.delayed.map(x => (
              <tr key={x.id}><td>{x.ref_no}</td><td className="wrap">{x.title}</td><td>{x.department}</td>
                <td className="wrap">{x.overdue[0].label}</td><td style={{ textAlign: 'right' }}>{x.max_overdue_days}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
