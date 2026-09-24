import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Status } from '../components/ui.jsx';
import { fmt, label } from '../lib/format.js';

function Stat({ v, l, cls, to }) {
  const body = <div className={'stat ' + (cls || '')}><div className="v">{v}</div><div className="l">{l}</div></div>;
  return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body;
}

export default function DashboardPage() {
  const { fy } = useApp();
  const [d, setD] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard').then(setD).catch(e => setError(e.message));
    api.get('/budgets/availability?year=' + fy).then(setAvailability).catch(() => setAvailability([]));
  }, [fy]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!d) return <div className="loading"><span className="spinner"></span> Loading…</div>;

  const t = d.todo;
  const role = d.role;
  const reqTotal = Object.values(d.requests).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Needs your attention</div>
      <div className="grid g4">
        {(role === 'dept_head' || role === 'admin') && <Stat v={t.to_authorise} l="Requests to authorise" cls={t.to_authorise ? 'warn' : 'ok'} to="/app/authorisations" />}
        {(role === 'procurement' || role === 'admin') && <Stat v={t.to_plan} l="Authorised, awaiting a method" cls={t.to_plan ? 'warn' : 'ok'} to="/app/inbox" />}
        {(role === 'management' || role === 'admin') && <Stat v={t.plans_awaiting_approval} l="Plans awaiting approval" cls={t.plans_awaiting_approval ? 'warn' : 'ok'} to="/app/plan" />}
        {(role === 'management' || role === 'admin') && <Stat v={t.revisions_awaiting_approval} l="Revisions awaiting approval" cls={t.revisions_awaiting_approval ? 'warn' : 'ok'} to="/app/revisions" />}
        <Stat v={d.delayed_count} l="Items with overdue milestones" cls={d.delayed_count ? 'bad' : 'ok'} to="/app/execution" />
      </div>

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
          {d.plans.length === 0 ? <div className="empty">No plan started yet. Authorised requests are turned into plan items from the Procurement inbox.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Cycle</th><th>Status</th><th>Version</th></tr></thead>
              <tbody>{d.plans.map(p => <tr key={p.fy}><td>{p.fy}-{p.fy + 2}</td><td><Status value={p.status} /></td><td>v{p.version}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 22 }}>
        <div className="card">
          <h2>Requests {role === 'requester' || role === 'dept_head' ? '(your department)' : ''}</h2>
          <p className="hint">{reqTotal} in total.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(d.requests).map(([s, n]) => <span key={s}><Status value={s} /> {n}</span>)}
            {reqTotal === 0 && <span className="hint">No requests yet.</span>}
          </div>
          <div className="section-title">Plan items by status</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(d.items).map(([s, n]) => <span key={s}><Status value={s} /> {n}</span>)}
            {Object.keys(d.items).length === 0 && <span className="hint">No plan items yet.</span>}
          </div>
        </div>

        <div className="card">
          <h2>Budget use {fy}</h2>
          <p className="hint">Committed plan items against allocation, by department.</p>
          {availability.length === 0 ? <div className="empty">No budget or plan data for {fy}.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Department</th><th style={{ textAlign: 'right' }}>Allocated</th><th style={{ textAlign: 'right' }}>Committed</th><th>Use</th></tr></thead>
              <tbody>{availability.map(a => {
                const pct = a.allocated ? Math.min(100, (a.committed / a.allocated) * 100) : 0;
                return (
                  <tr key={a.department_id}><td>{a.department}</td><td style={{ textAlign: 'right' }}>{fmt(a.allocated)}</td><td style={{ textAlign: 'right' }}>{fmt(a.committed)}</td>
                    <td>{a.allocated ? <div className={'bar' + (a.over_budget ? ' over' : '')}><div style={{ width: pct + '%' }}></div></div> : <span className="hint">no allocation</span>}</td></tr>
                );
              })}</tbody>
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
                <td className="wrap">{label(x.overdue[0].label)}</td><td style={{ textAlign: 'right' }}>{x.max_overdue_days}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
