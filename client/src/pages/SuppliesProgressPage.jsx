import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { ProgressBar, ProgressLegend } from '../components/ui.jsx';

const STATE = {
  on_track: ['on track', 'ok'], behind: ['behind schedule', 'warn'], overdue: ['delivery overdue', 'bad'], to_accept: ['to accept', 'warn'],
  no_target: ['no delivery date', 'warn'], delivered: ['delivered on time', 'ok'], delivered_late: ['delivered late', 'bad']
};
const MONTH = m => new Date(m + '-01T00:00:00Z').toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Stat({ v, l, cls }) {
  return <div className={'stat ' + (cls || '')}><div className="v">{v}</div><div className="l">{l}</div></div>;
}
const fileLink = f => <Link to={`/app/supplies?open=${f.id}`}>{f.bid_no || f.ref_no}</Link>;

// Supplies progress: each forwarded file measured against its delivery target.
export default function SuppliesProgressPage() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/supplies/progress').then(setD).catch(e => setError(e.message)); }, []);
  if (error) return <div className="error-banner">{error}</div>;
  if (!d) return <div className="loading"><span className="spinner"></span> Loading…</div>;

  const s = d.stats;
  const open = d.files.filter(f => f.status !== 'closed' && !f.delivered);
  const done = d.files.filter(f => f.delivered || f.status === 'closed').sort((a, b) => String(b.delivered || b.closed_on).localeCompare(String(a.delivered || a.closed_on)));
  const order = { overdue: 0, behind: 1, to_accept: 2, no_target: 3, on_track: 4 };
  open.sort((a, b) => order[a.state] - order[b.state] || String(a.target || '9').localeCompare(String(b.target || '9')));

  return (
    <div>
      <div className="between" style={{ marginBottom: 6 }}>
        <div><h2 style={{ margin: 0 }}>Supplies progress</h2>
          <span className="hint" style={{ margin: 0 }}>{d.scope === 'mine' ? 'Files forwarded to you, and unassigned files waiting in the Supplies Unit in-tray.' : 'All files forwarded to the Supplies Unit.'} Progress is measured against each file's delivery target.</span></div>
        <Link to="/app/supplies" className="hint" style={{ margin: 0 }}>Open the files</Link>
      </div>

      <div className="grid g4" style={{ margin: '12px 0' }}>
        <Stat v={s.open} l="Open files" />
        <Stat v={s.to_accept} l="Waiting to be accepted" cls={s.to_accept ? 'warn' : 'ok'} />
        <Stat v={s.due_30} l="Deliveries due in the next 30 days" cls={s.due_30 ? 'warn' : ''} />
        <Stat v={s.overdue} l="Deliveries overdue" cls={s.overdue ? 'bad' : 'ok'} />
        <Stat v={s.behind} l="Behind schedule (steps vs time)" cls={s.behind ? 'warn' : 'ok'} />
        <Stat v={s.on_time_pct == null ? '—' : s.on_time_pct + '%'} l={`On-time delivery (${s.delivered_on_time} of ${s.delivered} delivered)`} cls={s.on_time_pct == null ? '' : s.on_time_pct >= 80 ? 'ok' : s.on_time_pct >= 50 ? 'warn' : 'bad'} />
        <Stat v={s.completed} l="Completed files" />
        <Stat v={s.bonds_expiring + s.bonds_expired} l={`Bonds expiring soon${s.bonds_expired ? ` / ${s.bonds_expired} expired` : ''}`} cls={s.bonds_expired ? 'bad' : s.bonds_expiring ? 'warn' : 'ok'} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Progress against delivery targets</h2>
        <p className="hint">For each file in progress: the bar shows the share of its Supplies steps done; the tick shows how much of the time from acceptance to the delivery date has passed. A file is behind when its steps trail the time by more than 10 points.</p>
        {s.avg_actual == null ? <div className="empty">No files in progress with a delivery date yet.</div> : (
          <div className="grid g3" style={{ alignItems: 'center' }}>
            <div><div className="bigpct">{s.avg_actual}%</div><div className="hint" style={{ margin: '4px 0 0' }}>steps done, average of files in progress</div></div>
            <div><div className="bigpct" style={{ color: 'var(--warn)' }}>{s.avg_expected}%</div><div className="hint" style={{ margin: '4px 0 0' }}>time to delivery already passed</div></div>
            <div><ProgressBar actual={s.avg_actual} expected={s.avg_expected} /><ProgressLegend /></div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Delivery targets — files in progress ({open.length})</h2>
        {open.length === 0 ? <div className="empty">No open files.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Bid No</th><th>Description</th><th>Supplier</th>{d.scope !== 'mine' && <th>Officer</th>}<th>Delivery target</th><th>Days</th><th style={{ width: 170 }}>Progress</th><th>Status</th><th>Next step</th></tr></thead>
            <tbody>{open.map(f => (
              <tr key={f.id}>
                <td>{fileLink(f)}<div className="hint" style={{ margin: 0 }}>{f.ref_no}</div></td>
                <td className="wrap">{f.title}<div className="hint" style={{ margin: 0 }}>{f.department}</div></td>
                <td>{f.supplier || '—'}</td>
                {d.scope !== 'mine' && <td>{f.officer || <span className="hint" style={{ margin: 0 }}>in-tray</span>}</td>}
                <td>{f.target || '—'}{f.extensions ? <div className="hint" style={{ margin: 0 }}>extended ×{f.extensions}</div> : null}</td>
                <td>{f.days_left == null ? '' : f.days_left < 0 ? <span className="pill bad">{-f.days_left} d late</span> : <span className={'pill ' + (f.days_left <= 14 ? 'warn' : 'ok')}>{f.days_left} d left</span>}</td>
                <td>{f.state === 'to_accept' ? '' : <ProgressBar actual={f.actual_pct} expected={f.expected_pct ?? 0} />}<span className="hint" style={{ margin: 0 }}>{f.state === 'to_accept' ? '' : `${f.actual_pct}% done${f.expected_pct != null ? ` · ${f.expected_pct}% of time` : ''}`}</span></td>
                <td><span className={'pill ' + STATE[f.state][1]}>{STATE[f.state][0]}</span>{f.overdue_steps ? <div className="hint" style={{ margin: 0 }}>{f.overdue_steps} step(s) overdue</div> : null}</td>
                <td className="wrap">{f.state === 'to_accept' ? 'Accept the file' : f.next || 'All steps done'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <h2>Deliveries expected</h2>
          {d.upcoming.map(m => (
            <div key={m.month} style={{ marginBottom: 10 }}>
              <div className="section-title" style={{ margin: '6px 0' }}>{MONTH(m.month)} ({m.files.length})</div>
              {m.files.length === 0 ? <div className="hint">None.</div> : m.files.map(f => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '3px 0' }}>
                  <span>{fileLink(f)} — {f.title}{f.supplier ? ` (${f.supplier})` : ''}</span><span style={{ fontFamily: 'var(--mono)' }}>{f.target}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Delivered and completed ({done.length})</h2>
          {done.length === 0 ? <div className="empty">Nothing delivered yet.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Bid No</th><th>Description</th><th>Target</th><th>Delivered</th><th>Result</th><th>File</th></tr></thead>
              <tbody>{done.map(f => (
                <tr key={f.id}><td>{fileLink(f)}</td><td className="wrap">{f.title}</td><td>{f.target || '—'}</td><td>{f.delivered || '—'}</td>
                  <td>{f.delivered ? <span className={'pill ' + (f.state === 'delivered' ? 'ok' : 'bad')}>{f.state === 'delivered' ? 'on time' : `${f.late_days} d late`}</span> : ''}</td>
                  <td>{f.status === 'closed' ? `closed ${f.closed_on}` : 'open'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>

      {d.by_officer.length > 0 && user.role !== 'supplies' && (
        <div className="card">
          <h2>By officer</h2>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Officer</th><th style={{ textAlign: 'right' }}>Open</th><th style={{ textAlign: 'right' }}>On track</th><th style={{ textAlign: 'right' }}>Behind</th><th style={{ textAlign: 'right' }}>Overdue</th><th style={{ textAlign: 'right' }}>Delivered</th><th style={{ textAlign: 'right' }}>On time</th></tr></thead>
            <tbody>{d.by_officer.map(o => (
              <tr key={o.name}><td>{o.name}</td><td style={{ textAlign: 'right' }}>{o.open}</td><td style={{ textAlign: 'right' }}>{o.on_track || ''}</td>
                <td style={{ textAlign: 'right' }}>{o.behind ? <span className="pill warn">{o.behind}</span> : ''}</td><td style={{ textAlign: 'right' }}>{o.overdue ? <span className="pill bad">{o.overdue}</span> : ''}</td>
                <td style={{ textAlign: 'right' }}>{o.delivered || ''}</td><td style={{ textAlign: 'right' }}>{o.on_time_pct == null ? '—' : o.on_time_pct + '%'}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
