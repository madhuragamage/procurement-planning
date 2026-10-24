import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Status, ProgressBar, ProgressLegend } from '../components/ui.jsx';
import { fmt, label, pct } from '../lib/format.js';
import { ScheduleTiles, SCHEDULE_STATES } from './DashboardPage.jsx';

function Kpi({ v, l, sub, cls }) {
  return <div className={'stat ' + (cls || '')}><div className="v">{v}</div><div className="l">{l}</div>{sub && <div className="hint" style={{ margin: '6px 0 0' }}>{sub}</div>}</div>;
}

function ProgressTable({ rows, nameLabel }) {
  return (
    <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
      <thead><tr><th>{nameLabel}</th><th style={{ textAlign: 'right' }}>Items</th><th style={{ textAlign: 'right' }}>Value (LKR Mn)</th><th style={{ textAlign: 'right' }}>Actual</th><th style={{ textAlign: 'right' }}>Expected</th><th style={{ width: 200 }}>Progress</th><th style={{ textAlign: 'right' }}>Overdue</th></tr></thead>
      <tbody>{rows.map(x => (
        <tr key={x.name}><td>{x.name}</td><td style={{ textAlign: 'right' }}>{x.count}</td><td style={{ textAlign: 'right' }}>{fmt(x.value)}</td>
          <td style={{ textAlign: 'right' }}>{pct(x.actual_pct)}</td><td style={{ textAlign: 'right' }}>{pct(x.expected_pct)}</td>
          <td><ProgressBar actual={x.actual_pct} expected={x.expected_pct} /></td><td style={{ textAlign: 'right' }}>{x.overdue || ''}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function ItemTable({ rows, showDelay }) {
  if (!rows.length) return <div className="empty">None.</div>;
  return (
    <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
      <thead><tr><th>Ref</th><th>Description</th><th>Department</th><th>Method</th><th>Committee</th><th style={{ textAlign: 'right' }}>Value (Mn)</th><th>Status</th><th style={{ width: 150 }}>Progress</th>{showDelay && <th>Overdue milestone</th>}</tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.id}><td>{r.ref_no}</td><td className="wrap">{r.title}</td><td>{r.department}</td><td>{r.method}</td><td>{r.committee}</td><td style={{ textAlign: 'right' }}>{fmt(r.value)}</td>
          <td><Status value={r.status} /></td><td><ProgressBar actual={r.actual_pct} expected={r.expected_pct} /></td>
          {showDelay && <td className="wrap">{r.overdue_milestone} <span className="pill bad">{r.overdue_days} d</span></td>}</tr>
      ))}</tbody>
    </table></div>
  );
}

export default function BoardPage() {
  const { fy } = useApp();
  const [b, setB] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { setB(null); api.get('/dashboard/board?plan_fy=' + fy).then(setB).catch(e => setError(e.message)); }, [fy]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!b) return <div className="loading"><span className="spinner"></span> Loading…</div>;
  const h = b.headline;
  const reqTotal = Object.values(b.pipeline.requests).reduce((a, c) => a + c, 0);

  return (
    <div className="report">
      <div className="between no-print" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Board / CEO view — procurement plan {fy}-{fy + 2}</h2>
          <span className="hint" style={{ margin: 0 }}>Read-only summary as at {b.today} · plan <Status value={b.plan.status} /> version {b.plan.version}</span>
        </div>
        <button className="primary" onClick={() => window.print()}>Print / save as PDF</button>
      </div>

      <div className="grid g4">
        <Kpi v={pct(b.tracking ? h.actual_pct : null) || 'n/a'} l="Annual plan progress (actual)" sub={b.tracking ? `expected by schedule: ${pct(h.expected_pct)}` : 'starts once the plan is approved'} cls={b.tracking && h.actual_pct + 2 < h.expected_pct ? 'bad' : 'ok'} />
        <Kpi v={fmt(h.annual_value)} l={`Annual plan ${fy} · LKR Mn`} sub={`${h.count} procurements`} />
        <Kpi v={fmt(h.three_year_value)} l={`Three-year plan · LKR Mn`} sub={b.by_year.map(y => `${y.year}: ${fmt(y.value)}`).join(' · ')} />
        <Kpi v={h.overdue} l="Procurements with overdue milestones" cls={h.overdue ? 'bad' : 'ok'} sub={`${h.stages.completed + h.stages.awarded} of ${h.count} awarded or completed`} />
      </div>
      {h.awarded_value > 0 && (
        <div className="grid g4" style={{ marginTop: 14 }}>
          <Kpi v={fmt(h.awarded_value)} l="Contracts awarded · LKR Mn" sub={`against an estimate of ${fmt(h.awarded_estimate)}`} />
          <Kpi v={fmt(h.savings)} l="Below / (above) estimate · LKR Mn" cls={h.savings >= 0 ? 'ok' : 'bad'} />
        </div>
      )}

      {b.schedule && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>Done and not done within the Procurement Time Schedule</h2>
          <p className="hint">Annual plan {fy}. A procurement is done when the {b.schedule.done_milestone.toLowerCase()} is recorded; compared with its date in the Procurement Time Schedule. Within schedule (of those due): <b>{b.schedule.within_schedule_pct == null ? '—' : b.schedule.within_schedule_pct + '%'}</b>.</p>
          <ScheduleTiles s={b.schedule} />
          {b.schedule.by_division.length > 0 && (
            <div className="tbl-wrap" style={{ marginTop: 14, maxHeight: 'none' }}><table>
              <thead><tr><th>Division</th><th style={{ textAlign: 'right' }}>Procurements</th>{SCHEDULE_STATES.map(([k, l]) => <th key={k} style={{ textAlign: 'right' }}>{l}</th>)}<th style={{ textAlign: 'right' }}>Within schedule</th></tr></thead>
              <tbody>{b.schedule.by_division.map(g => (
                <tr key={g.name}><td>{g.name}</td><td style={{ textAlign: 'right' }}>{g.total}</td>
                  {SCHEDULE_STATES.map(([k]) => { const n = g.by_state[k].count + (k === 'in_schedule' ? g.by_state.no_schedule.count : 0); return <td key={k} style={{ textAlign: 'right' }}>{n || ''}</td>; })}
                  <td style={{ textAlign: 'right' }}>{g.within_schedule_pct == null ? '—' : g.within_schedule_pct + '%'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {b.schedule.exceptions.length > 0 && <>
            <div className="section-title">Late or overdue</div>
            <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
              <thead><tr><th>Bid No / Ref</th><th>Procurement</th><th>Department</th><th style={{ textAlign: 'right' }}>Value (Mn)</th><th>Schedule date</th><th>Done on</th><th>Result</th></tr></thead>
              <tbody>{b.schedule.exceptions.map(x => (
                <tr key={x.id}><td>{x.bid_no || x.ref_no}{x.bid_no && <div className="hint" style={{ margin: 0 }}>{x.ref_no}</div>}</td><td className="wrap">{x.title}</td><td>{x.department}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(x.value)}</td><td>{x.target}</td><td>{x.done || '—'}</td>
                  <td><span className={'pill ' + (x.state === 'overdue' ? 'bad' : 'warn')}>{x.state === 'overdue' ? `not done · ${x.days} d overdue` : `done ${x.days} d late`}</span></td></tr>
              ))}</tbody>
            </table></div>
          </>}
        </div>
      )}

      {b.milestones && b.milestones.procurements > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>Progress by Time Schedule milestone</h2>
          <p className="hint">Counted by procurement: of the procurements due to reach each milestone by today, how many have. Due milestones achieved overall: <b>{b.milestones.overall.achieved_pct == null ? '—' : b.milestones.overall.achieved_pct + '%'}</b> · on time {b.milestones.overall.on_time_pct == null ? '—' : b.milestones.overall.on_time_pct + '%'} · overdue {b.milestones.overall.overdue}.</p>
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Milestone</th><th style={{ textAlign: 'right' }}>Due</th><th style={{ textAlign: 'right' }}>Achieved</th><th style={{ width: 140 }}></th><th style={{ textAlign: 'right' }}>Overdue</th></tr></thead>
            <tbody>{b.milestones.milestones.map(r => (
              <tr key={r.key}><td className="wrap">{r.label}</td><td style={{ textAlign: 'right' }}>{r.due}</td><td style={{ textAlign: 'right' }}>{r.achieved_due}</td>
                <td>{r.due ? <div className={'bar' + (r.overdue ? ' over' : '')}><div style={{ width: (r.achieved_pct || 0) + '%' }}></div></div> : <span className="hint" style={{ margin: 0 }}>not due yet</span>}</td>
                <td style={{ textAlign: 'right' }}>{r.overdue || ''}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h2>Progress by division</h2>
        <p className="hint">Share of the {fy} annual plan's 13 procurement milestones completed, weighted by value, against what the schedule expects by today.</p>
        {b.by_division.length === 0 ? <div className="empty">No items in the annual plan.</div> : <><ProgressTable rows={b.by_division} nameLabel="Division" /><ProgressLegend /></>}
      </div>

      <div className="grid g2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2>Stages</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
            {[['planned', 'not started', h.stages.not_started], ['in_progress', 'in progress', h.stages.in_progress], ['awarded', 'awarded', h.stages.awarded], ['completed', 'completed', h.stages.completed]].map(([s, l, n]) => (
              <div key={s} className="stat" style={{ minWidth: 110 }}><div className="v">{n}</div><div className="l">{l}</div></div>
            ))}
          </div>
          <div className="section-title">Requests for {fy}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(b.pipeline.requests).map(([s, n]) => <span key={s}><Status value={s} /> {n}</span>)}
            {reqTotal === 0 && <span className="hint">None.</span>}
          </div>
          <div className="section-title">Open actions</div>
          <ul className="hint" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>{b.pipeline.execution_requests_pending} execution request(s) waiting for the procurement unit</li>
            <li>{b.pipeline.starting_soon_without_request} procurement(s) due to start with no execution request</li>
            <li>{b.pipeline.revisions_pending} plan revision(s) awaiting management</li>
          </ul>
        </div>
        <div className="card">
          <h2>Budget by division {fy}</h2>
          <p className="hint">Committed plan value (incl. VAT) against allocation, LKR million.</p>
          {b.budget.length === 0 ? <div className="empty">No budget or plan data.</div> : (
            <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
              <thead><tr><th>Division</th><th style={{ textAlign: 'right' }}>Allocated</th><th style={{ textAlign: 'right' }}>Committed</th><th>Use</th></tr></thead>
              <tbody>{b.budget.map(x => {
                const p = x.allocated ? Math.min(100, (x.committed / x.allocated) * 100) : 0;
                return <tr key={x.name}><td>{x.name}</td><td style={{ textAlign: 'right' }}>{fmt(x.allocated)}</td><td style={{ textAlign: 'right' }}>{fmt(x.committed)}</td>
                  <td>{x.allocated ? <div className={'bar' + (x.committed > x.allocated ? ' over' : '')}><div style={{ width: p + '%' }}></div></div> : <span className="hint">no allocation</span>}</td></tr>;
              })}</tbody>
            </table></div>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2>By method ({fy} annual plan)</h2>
          <div className="tbl-wrap"><table><thead><tr><th>Method</th><th style={{ textAlign: 'right' }}>Items</th><th style={{ textAlign: 'right' }}>Value (Mn)</th></tr></thead>
            <tbody>{b.by_method.map(m => <tr key={m.name}><td>{m.name}</td><td style={{ textAlign: 'right' }}>{m.count}</td><td style={{ textAlign: 'right' }}>{fmt(m.value)}</td></tr>)}</tbody></table></div>
        </div>
        <div className="card">
          <h2>By approving committee</h2>
          <div className="tbl-wrap"><table><thead><tr><th>Committee</th><th style={{ textAlign: 'right' }}>Items</th><th style={{ textAlign: 'right' }}>Value (Mn)</th></tr></thead>
            <tbody>{b.by_committee.map(m => <tr key={m.name}><td>{m.name}</td><td style={{ textAlign: 'right' }}>{m.count}</td><td style={{ textAlign: 'right' }}>{fmt(m.value)}</td></tr>)}</tbody></table></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>Ten largest procurements</h2>
        <ItemTable rows={b.top_value} />
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>Most overdue procurements</h2>
        {b.tracking ? <ItemTable rows={b.delayed} showDelay /> : <div className="empty">Tracked once the plan is approved.</div>}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2>Reporting calendar</h2>
        <div className="tbl-wrap"><table><tbody>
          {b.deadlines.map(x => <tr key={x.label}><td className="wrap">{x.label}</td><td>{x.date}</td><td><span className={'pill ' + (x.days < 0 ? 'bad' : x.days <= 30 ? 'warn' : 'ok')}>{x.days < 0 ? `${-x.days} d ago` : `in ${x.days} d`}</span></td></tr>)}
        </tbody></table></div>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>Plan status: {label(b.plan.status)}. Progress counts a procurement's milestones with actual dates recorded by the procurement unit.</p>
    </div>
  );
}
