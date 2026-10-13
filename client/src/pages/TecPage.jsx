import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, inclVat } from '../lib/format.js';

const ROLE = { chair: 'Chairperson', member: 'Member', secretary: 'Secretary' };
const today = () => new Date().toISOString().slice(0, 10);
const when = s => (s ? String(s).slice(0, 10) : '');
const EMAIL_STATUS = { sent: ['sent', 'ok'], failed: ['failed', 'bad'], not_configured: ['not sent — e-mail not set up', 'warn'] };

function DueState({ c }) {
  if (c.status === 'completed') return <span className="pill ok">report completed {c.completed_on}</span>;
  if (c.status === 'cancelled') return <span className="pill bad">cancelled</span>;
  if (c.overdue) return <span className="pill bad">overdue {-c.days_left} d</span>;
  return <span className={'pill ' + (c.days_left <= 7 ? 'warn' : 'ok')}>{c.days_left === 0 ? 'due today' : `${c.days_left} d left`}</span>;
}

// Appoint a committee for a procurement whose execution has been accepted.
function AppointForm({ items, members, onDone }) {
  const [f, setF] = useState({ plan_item_id: '', appointed_on: today(), due_date: '', notes: '' });
  const [roster, setRoster] = useState([{ member_id: '', role: 'chair' }, { member_id: '', role: 'member' }]);
  const { busy, error, run } = useAction();
  const active = members.filter(m => m.active);
  const setRow = (i, k, v) => setRoster(r => r.map((x, n) => (n === i ? { ...x, [k]: v } : x)));

  async function save(e) {
    e.preventDefault();
    const out = await run(() => api.post('/tec/committees', { ...f, members: roster.filter(r => r.member_id) }));
    if (out) {
      setF({ plan_item_id: '', appointed_on: today(), due_date: '', notes: '' });
      setRoster([{ member_id: '', role: 'chair' }, { member_id: '', role: 'member' }]);
      const sent = out.emails.filter(s => s === 'sent').length;
      onDone(`TEC appointed. Appointment e-mails: ${sent} of ${out.emails.length} sent${sent < out.emails.length ? ' (see the e-mail log on the committee)' : ''}.`);
    }
  }

  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 16 }}>
      <h2>Appoint a Technical Evaluation Committee</h2>
      <p className="hint">Each member receives an appointment e-mail. Members who have not submitted get a reminder before the due date and another once it lapses.</p>
      <Msg error={error} />
      <div className="grid g4">
        <label className="field" style={{ gridColumn: 'span 2' }}><span>Procurement (execution accepted)</span>
          <select value={f.plan_item_id} onChange={e => setF({ ...f, plan_item_id: e.target.value })} required>
            <option value="">Select…</option>
            {items.map(i => <option key={i.id} value={i.id}>{i.bid_no ? `${i.bid_no} · ` : ''}{i.ref_no} — {i.title} ({i.department})</option>)}
          </select></label>
        <label className="field"><span>Date of appointment</span><input type="date" value={f.appointed_on} onChange={e => setF({ ...f, appointed_on: e.target.value })} required /></label>
        <label className="field"><span>Evaluation due by</span><input type="date" value={f.due_date} min={f.appointed_on} onChange={e => setF({ ...f, due_date: e.target.value })} required /></label>
      </div>
      {items.length === 0 && <p className="hint">No procurement is ready: execution must be accepted, and items that already have an active TEC are not listed.</p>}
      <div className="section-title" style={{ marginTop: 0 }}>Members</div>
      {active.length === 0 ? <p className="hint">Add members to the directory first (Members and performance tab).</p> : roster.map((r, i) => (
        <div className="row" key={i} style={{ marginBottom: 8, alignItems: 'center' }}>
          <select value={r.member_id} onChange={e => setRow(i, 'member_id', e.target.value)} style={{ flex: 3 }}>
            <option value="">Select member…</option>
            {active.map(m => <option key={m.id} value={m.id} disabled={roster.some((x, n) => n !== i && String(x.member_id) === String(m.id))}>{m.name}{m.designation ? ` — ${m.designation}` : ''}</option>)}
          </select>
          <select value={r.role} onChange={e => setRow(i, 'role', e.target.value)} style={{ flex: 1 }}>
            {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button type="button" className="mini" style={{ flex: '0 0 auto' }} onClick={() => setRoster(x => x.filter((_, n) => n !== i))}>remove</button>
        </div>
      ))}
      <button type="button" className="mini plain" onClick={() => setRoster(x => [...x, { member_id: '', role: 'member' }])}>+ add member</button>
      <label className="field" style={{ marginTop: 12 }}><span>Notes (e.g. appointment letter reference)</span><input type="text" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
      <button className="primary" disabled={busy}>Appoint and send e-mails</button>
    </form>
  );
}

function Committee({ c, members, isProc, onChange }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [due, setDue] = useState(c.due_date);
  const [completedOn, setCompletedOn] = useState(today());
  const [add, setAdd] = useState({ member_id: '', role: 'member' });
  const [subDates, setSubDates] = useState({});
  const { busy, error, ok, run } = useAction();
  const active = c.status === 'active';
  const reload = async () => { onChange(); if (open) setDetail(await api.get('/tec/committees/' + c.id)); };
  const act = async (fn, msg) => { if (await run(fn, msg)) reload(); };
  useEffect(() => { if (open) api.get('/tec/committees/' + c.id).then(setDetail); }, [open, c.id]);
  const pending = c.members.filter(m => !m.submitted_on).length;

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `4px solid ${c.overdue ? 'var(--bad)' : active && c.days_left <= 7 ? 'var(--warn)' : 'var(--line)'}` }}>
      <div className="between">
        <div><b>TEC #{c.id}</b> · {c.bid_no ? <><b>{c.bid_no}</b> ({c.ref_no})</> : c.ref_no} — {c.title} <DueState c={c} /></div>
        <div className="hint" style={{ margin: 0 }}>{c.department} · {c.method || 'method —'} · LKR {fmt(inclVat(c.tce_excl_vat_mn, c.vat_pct))} Mn · appointed {c.appointed_on} · due <b>{c.due_date}</b></div>
      </div>
      {c.notes && <p className="hint" style={{ margin: '6px 0 0' }}>{c.notes}</p>}
      <Msg error={error} ok={ok} />
      <div className="tbl-wrap" style={{ maxHeight: 'none', marginTop: 8 }}><table>
        <thead><tr><th>Member</th><th>Role</th><th>Appointment e-mail</th><th>Reminders</th><th>Evaluation submitted</th><th></th></tr></thead>
        <tbody>{c.members.map(m => (
          <tr key={m.id}>
            <td>{m.name}<div className="hint" style={{ margin: 0 }}>{m.designation || ''} {m.email}</div></td>
            <td>{ROLE[m.role]}</td>
            <td>{when(m.appointment_sent_at)}{isProc && active && <button className="mini plain" style={{ marginLeft: 6 }} disabled={busy} onClick={() => act(() => api.post(`/tec/assignments/${m.id}/resend-appointment`), `Appointment e-mail re-sent to ${m.name}.`)}>resend</button>}</td>
            <td className="wrap">{[m.reminder_before_at && `before due: ${when(m.reminder_before_at)}`, m.reminder_overdue_at && `overdue: ${when(m.reminder_overdue_at)}`].filter(Boolean).join(' · ') || '—'}</td>
            <td>
              {m.submitted_on
                ? <><span className={'pill ' + (m.submitted_on > c.due_date ? 'warn' : 'ok')}>{m.submitted_on}{m.submitted_on > c.due_date ? ' (late)' : ''}</span>
                  {isProc && c.status !== 'cancelled' && <button className="mini plain" style={{ marginLeft: 6 }} disabled={busy} onClick={() => act(() => api.post(`/tec/assignments/${m.id}/submission`, { submitted_on: null }))}>undo</button>}</>
                : isProc && c.status !== 'cancelled'
                  ? <span style={{ display: 'inline-flex', gap: 6 }}>
                    <input type="date" value={subDates[m.id] || today()} onChange={e => setSubDates({ ...subDates, [m.id]: e.target.value })} style={{ width: 150 }} />
                    <button className="mini plain" disabled={busy} onClick={() => act(() => api.post(`/tec/assignments/${m.id}/submission`, { submitted_on: subDates[m.id] || today() }), `${m.name}: submission recorded.`)}>mark submitted</button>
                  </span>
                  : <span className="pill warn">not yet</span>}
            </td>
            <td>{isProc && active && !m.submitted_on && <button className="mini" disabled={busy} onClick={() => { if (confirm(`Remove ${m.name} from this committee?`)) act(() => api.del(`/tec/committees/${c.id}/members/${m.id}`)); }}>remove</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>

      {isProc && active && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          <div className="hintbox">
            <b>Reminders</b>
            <p className="hint" style={{ margin: '4px 0 8px' }}>Sent automatically to the {pending} member(s) who have not submitted. Send one now if needed.</p>
            <button className="ghost" disabled={busy || !pending} onClick={() => act(() => api.post(`/tec/committees/${c.id}/remind`), 'Reminder e-mailed to members who have not submitted.')}>Send reminder now</button>
          </div>
          <div className="hintbox">
            <b>Extend the time given</b>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input type="date" value={due} min={c.appointed_on} onChange={e => setDue(e.target.value)} />
              <button className="ghost" disabled={busy || due === c.due_date} onClick={() => act(() => api.put('/tec/committees/' + c.id, { due_date: due }), `Due date changed to ${due}; reminders re-armed.`)}>Save</button>
            </div>
          </div>
          <div className="hintbox">
            <b>Evaluation report completed</b>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input type="date" value={completedOn} onChange={e => setCompletedOn(e.target.value)} />
              <button className="primary" disabled={busy} onClick={() => { if (!pending || confirm(`${pending} member(s) are not recorded as submitted. Close the committee anyway?`)) act(() => api.post(`/tec/committees/${c.id}/complete`, { completed_on: completedOn }), 'Committee closed; bid evaluation milestone recorded.'); }}>Close</button>
            </div>
          </div>
        </div>
      )}
      {isProc && active && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <select value={add.member_id} onChange={e => setAdd({ ...add, member_id: e.target.value })} style={{ width: 'auto' }}>
            <option value="">Add a member…</option>
            {members.filter(m => m.active && !c.members.some(x => x.member_id === m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={add.role} onChange={e => setAdd({ ...add, role: e.target.value })} style={{ width: 'auto' }}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button className="mini plain" disabled={busy || !add.member_id} onClick={async () => { if (await run(() => api.post(`/tec/committees/${c.id}/members`, add), 'Member added and appointment e-mail sent.')) { setAdd({ member_id: '', role: 'member' }); reload(); } }}>add and e-mail</button>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button className="link" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'} e-mail log{isProc && active ? ' and cancel option' : ''}</button>
      </div>
      {open && detail && (
        <div style={{ marginTop: 8 }}>
          {detail.emails.length === 0 ? <div className="hint">No e-mails yet.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
              <tbody>{detail.emails.map(e => <tr key={e.id}><td>{String(e.created_at).slice(0, 16).replace('T', ' ')}</td><td>{e.to_email}</td><td className="wrap">{e.subject}</td>
                <td><span className={'pill ' + EMAIL_STATUS[e.status][1]} title={e.error || ''}>{EMAIL_STATUS[e.status][0]}</span></td></tr>)}</tbody>
            </table></div>
          )}
          {isProc && active && <div style={{ marginTop: 10 }}><CommentAction busy={busy} actions={[{ label: 'Cancel this committee', onClick: comment => act(() => api.post(`/tec/committees/${c.id}/cancel`, { comment }), 'Committee cancelled.') }]} /></div>}
        </div>
      )}
    </div>
  );
}

function MemberForm({ initial, onDone, onCancel }) {
  const { lookups } = useApp();
  const [f, setF] = useState(initial);
  const { busy, error, run } = useAction();
  async function save(e) {
    e.preventDefault();
    if (await run(() => (f.id ? api.put('/tec/members/' + f.id, f) : api.post('/tec/members', f)))) onDone(f.id ? 'Member updated.' : 'Member added to the directory.');
  }
  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 14 }}>
      <h2>{f.id ? `Edit ${initial.name}` : 'Add a member to the directory'}</h2>
      <Msg error={error} />
      <div className="grid g4">
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span>E-mail</span><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></label>
        <label className="field"><span>Designation</span><input type="text" value={f.designation || ''} onChange={e => setF({ ...f, designation: e.target.value })} placeholder="e.g. Chief Engineer (Distribution)" /></label>
        <label className="field"><span>Department</span>
          <select value={f.department_id || ''} onChange={e => setF({ ...f, department_id: e.target.value })}>
            <option value="">— / external</option>{lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
      </div>
      <div className="grid g4">
        <label className="field"><span>Phone</span><input type="text" value={f.phone || ''} onChange={e => setF({ ...f, phone: e.target.value })} /></label>
        {f.id && <label className="chk" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Active (can be appointed)</label>}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" disabled={busy}>{f.id ? 'Save' : 'Add member'}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Members({ members, isProc, onChange }) {
  const [form, setForm] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [history, setHistory] = useState(null);
  const [ok, setOk] = useState('');
  useEffect(() => { if (openId) api.get('/tec/members/' + openId).then(setHistory); else setHistory(null); }, [openId]);
  const num = { textAlign: 'right' };

  return (
    <>
      <Msg ok={ok} />
      {isProc && !form && <button className="primary" style={{ marginBottom: 14 }} onClick={() => setForm({ name: '', email: '', designation: '', department_id: '', phone: '' })}>Add member</button>}
      {form && <MemberForm initial={form} onCancel={() => setForm(null)} onDone={msg => { setForm(null); setOk(msg); onChange(); }} />}
      <div className="card">
        <h2>Members and performance</h2>
        <p className="hint">On time = evaluation submitted by the committee's due date. Overdue = due date passed, not submitted. Not submitted = committee closed without that member's submission. Days taken = appointment to submission. Click a name for the member's committees.</p>
        {members.length === 0 ? <div className="empty">No members yet.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Member</th><th>Department</th><th style={num}>Committees</th><th style={num}>On time</th><th style={num}>Late</th><th style={num}>Overdue now</th><th style={num}>Pending</th><th style={num}>Not submitted</th><th style={num}>Avg days taken</th><th style={num}>Avg days late</th><th style={num}>On-time rate</th><th></th></tr></thead>
            <tbody>{members.map(m => {
              const p = m.performance;
              return (
                <Fragment key={m.id}>
                  <tr style={m.active ? undefined : { opacity: 0.55 }}>
                    <td><button className="link" onClick={() => setOpenId(openId === m.id ? null : m.id)}>{m.name}</button><div className="hint" style={{ margin: 0 }}>{m.designation || ''} {m.email}{m.active ? '' : ' · inactive'}</div></td>
                    <td>{m.department || '—'}</td><td style={num}>{p.assignments}</td><td style={num}>{p.on_time}</td>
                    <td style={num}>{p.late || ''}</td><td style={num}>{p.overdue ? <span className="pill bad">{p.overdue}</span> : ''}</td><td style={num}>{p.pending || ''}</td><td style={num}>{p.not_submitted || ''}</td>
                    <td style={num}>{p.avg_days_taken ?? '—'}</td><td style={num}>{p.avg_days_late ?? '—'}</td>
                    <td style={num}>{p.on_time_pct == null ? '—' : <span className={'pill ' + (p.on_time_pct >= 80 ? 'ok' : p.on_time_pct >= 50 ? 'warn' : 'bad')}>{p.on_time_pct}%</span>}</td>
                    <td>{isProc && <button className="mini plain" onClick={() => { setForm({ ...m, department_id: m.department_id || '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>edit</button>}</td>
                  </tr>
                  {openId === m.id && history && (
                    <tr><td colSpan={12} style={{ background: 'var(--panel-2)' }}>
                      {history.history.length === 0 ? <span className="hint">Not appointed to any committee yet.</span> : (
                        <table><thead><tr><th>TEC</th><th>Procurement</th><th>Role</th><th>Appointed</th><th>Due</th><th>Submitted</th><th>Committee</th></tr></thead>
                          <tbody>{history.history.map(h => (
                            <tr key={h.committee_id}><td>#{h.committee_id}</td><td className="wrap">{h.ref_no} — {h.title}</td><td>{ROLE[h.role]}</td><td>{h.appointed_on}</td><td>{h.due_date}</td>
                              <td>{h.submitted_on ? <span className={'pill ' + (h.submitted_on > h.due_date ? 'warn' : 'ok')}>{h.submitted_on}</span> : h.committee_status === 'active' && h.due_date < today() ? <span className="pill bad">overdue</span> : '—'}</td>
                              <td>{h.committee_status}</td></tr>
                          ))}</tbody></table>
                      )}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export default function TecPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [tab, setTab] = useState('committees');
  const [status, setStatus] = useState(null);
  const [committees, setCommittees] = useState([]);
  const [members, setMembers] = useState([]);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('active');
  const [ok, setOk] = useState('');
  const isProc = ['procurement', 'admin'].includes(user.role);

  const load = useCallback(async () => {
    setStatus(await api.get('/tec/status'));
    const list = await api.get(`/tec/committees?plan_fy=${fy}`);
    setCommittees(list);
    setMembers(await api.get('/tec/members'));
    const withActive = new Set(list.filter(c => c.status === 'active').map(c => c.plan_item_id));
    setItems((await api.get('/plan-items?plan_fy=' + fy)).filter(i => i.exec_status === 'accepted' && i.status !== 'cancelled' && !withActive.has(i.id)));
  }, [fy]);
  useEffect(() => { load(); }, [load]);

  const shown = committees.filter(c => !filter || c.status === filter);
  const overdue = committees.filter(c => c.overdue).length;
  const dueSoon = committees.filter(c => c.status === 'active' && !c.overdue && c.days_left <= (status ? status.reminder_days : 7)).length;

  return (
    <div>
      <div className="between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Technical Evaluation Committees — {fy}</h2>
        <div className="hint" style={{ margin: 0 }}>Reminders go {status ? status.reminder_days : 7} days before the due date and once it lapses.</div>
      </div>
      {status && !status.email_configured && <div className="error-banner">E-mail is not set up on the server yet, so appointment and reminder e-mails are recorded in each committee's e-mail log but not delivered. Add the SMTP settings to .env to start sending.</div>}
      <Msg ok={ok} />
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="v">{committees.filter(c => c.status === 'active').length}</div><div className="l">Active committees</div></div>
        <div className={'stat ' + (dueSoon ? 'warn' : '')}><div className="v">{dueSoon}</div><div className="l">Due within {status ? status.reminder_days : 7} days</div></div>
        <div className={'stat ' + (overdue ? 'bad' : 'ok')}><div className="v">{overdue}</div><div className="l">Time lapsed, not completed</div></div>
        <div className="stat"><div className="v">{committees.filter(c => c.status === 'completed').length}</div><div className="l">Completed</div></div>
      </div>
      <div className="tabbar">
        <button className={tab === 'committees' ? 'on' : ''} onClick={() => setTab('committees')}>Committees</button>
        <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>Members and performance</button>
      </div>

      {tab === 'committees' ? (
        <>
          {isProc && <AppointForm items={items} members={members} onDone={msg => { setOk(msg); load(); }} />}
          <div className="between" style={{ marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0, flex: 1 }}>Committees</div>
            <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto', marginLeft: 10 }}>
              <option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="">All</option>
            </select>
          </div>
          {shown.length === 0 ? <div className="card"><div className="empty">No committees.</div></div>
            : shown.map(c => <Committee key={c.id + c.due_date + c.status} c={c} members={members} isProc={isProc} onChange={load} />)}
        </>
      ) : <Members members={members} isProc={isProc} onChange={load} />}
    </div>
  );
}
