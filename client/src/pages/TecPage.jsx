import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction, CommentAction, ProgressBar } from '../components/ui.jsx';
import { fmt, inclVat } from '../lib/format.js';

const ROLE = { chair: 'Chairperson', member: 'Member', secretary: 'Secretary' };
const today = () => new Date().toISOString().slice(0, 10);
const when = s => (s ? String(s).slice(0, 10) : '');
const EMAIL_STATUS = { sent: ['sent', 'ok'], failed: ['failed', 'bad'], not_configured: ['not sent — e-mail not set up', 'warn'] };

const TASK = { 1: 'Bidding documents / specifications', 2: 'Bid evaluation' };

// Where the committee stands: which task is in progress, waiting for the bid evaluation to start, or closed.
function DueState({ c }) {
  if (c.status === 'completed') return <span className="pill ok">both tasks completed {c.completed_on}</span>;
  if (c.status === 'cancelled') return <span className="pill bad">cancelled</span>;
  if (c.awaiting_stage2) return <span className="pill warn">task 1 done — bid evaluation not started</span>;
  if (!c.current_stage) return null;
  const lbl = `task ${c.current_stage}: ${TASK[c.current_stage].toLowerCase()}`;
  if (c.overdue) return <span className="pill bad">{lbl} · overdue {-c.days_left} d</span>;
  return <span className={'pill ' + (c.days_left <= 7 ? 'warn' : 'ok')}>{lbl} · {c.days_left === 0 ? 'due today' : `${c.days_left} d left`}</span>;
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// The Procurement Time Schedule date for a field, with "use" and a warning if the chosen date is later.
function ScheduleDate({ date, value, onUse, late = true }) {
  if (!date) return <div className="hint" style={{ margin: '4px 0 0' }}>No date in the Time Schedule.</div>;
  const diff = value ? daysBetween(date, value) : 0;
  return (
    <div style={{ marginTop: 4, fontSize: 12 }}>
      <span className="hint" style={{ margin: 0 }}>Time Schedule: <b>{date}</b></span>
      {value !== date && <button type="button" className="mini plain" style={{ marginLeft: 6 }} onClick={() => onUse(date)}>use</button>}
      {late && value && diff > 0 && <div style={{ color: 'var(--warn)', marginTop: 2 }}>{diff} d later than the Time Schedule — later milestones may slip.</div>}
    </div>
  );
}

// Appoint the BEC for a procurement whose execution has been accepted. Task 1 starts now.
function AppointForm({ items, members, onDone }) {
  const [f, setF] = useState({ plan_item_id: '', appointed_on: today(), due_date: '', letter_ref: '', notes: '' });
  const [roster, setRoster] = useState([{ member_id: '', role: 'chair' }, { member_id: '', role: 'member' }]);
  const [sched, setSched] = useState(null);
  const { busy, error, run } = useAction();
  const active = members.filter(m => m.active);
  useEffect(() => { setSched(null); if (f.plan_item_id) api.get('/tec/schedule/' + f.plan_item_id).then(setSched).catch(() => {}); }, [f.plan_item_id]);
  const setRow = (i, k, v) => setRoster(r => r.map((x, n) => (n === i ? { ...x, [k]: v } : x)));

  async function save(e) {
    e.preventDefault();
    const out = await run(() => api.post('/tec/committees', { ...f, members: roster.filter(r => r.member_id) }));
    if (out) {
      setF({ plan_item_id: '', appointed_on: today(), due_date: '', letter_ref: '', notes: '' });
      setRoster([{ member_id: '', role: 'chair' }, { member_id: '', role: 'member' }]);
      const sent = out.emails.filter(s => s === 'sent').length;
      onDone(`BEC appointed; task 1 (bidding documents / specifications) has started. Appointment e-mails: ${sent} of ${out.emails.length} sent${sent < out.emails.length ? ' (see the e-mail log on the committee)' : ''}.`);
    }
  }

  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 16 }}>
      <h2>Appoint a Bid Evaluation Committee (BEC / TEC)</h2>
      <p className="hint">The BEC has two tasks, each started separately with its own due date: <b>1. preparation of bidding documents / specifications</b> starts on appointment; <b>2. bid evaluation</b> is started later, once the bids are opened — so the wait for bids is not counted against the committee. Members get an appointment e-mail now and a separate e-mail when the bid evaluation starts, with reminders before each due date.</p>
      <Msg error={error} />
      <div className="grid g4">
        <label className="field" style={{ gridColumn: 'span 2' }}><span>Procurement (execution accepted)</span>
          <select value={f.plan_item_id} onChange={e => setF({ ...f, plan_item_id: e.target.value })} required>
            <option value="">Select…</option>
            {items.map(i => <option key={i.id} value={i.id}>{i.bid_no ? `${i.bid_no} · ` : ''}{i.ref_no} — {i.title} ({i.department})</option>)}
          </select></label>
        <label className="field"><span>Date of appointment</span><input type="date" value={f.appointed_on} onChange={e => setF({ ...f, appointed_on: e.target.value })} required />
          {sched && <ScheduleDate date={sched.appoint_bec} value={f.appointed_on} onUse={d => setF(x => ({ ...x, appointed_on: d }))} />}</label>
        <label className="field"><span>Task 1 — bidding documents due by</span><input type="date" value={f.due_date} min={f.appointed_on} onChange={e => setF({ ...f, due_date: e.target.value })} required />
          {sched && <ScheduleDate date={sched.prep_docs} value={f.due_date} onUse={d => setF(x => ({ ...x, due_date: d }))} />}</label>
      </div>
      {sched && (sched.appoint_bec || sched.prep_docs) && (
        <div className="hintbox" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Procurement Time Schedule ({sched.source}): appointment of BEC <b>{sched.appoint_bec || '—'}</b> · bidding documents / specifications <b>{sched.prep_docs || '—'}</b>
            {sched.opening ? <> · bid opening {sched.opening} · bid evaluation {sched.evaluation}</> : null}</span>
          {(sched.appoint_bec !== f.appointed_on || sched.prep_docs !== f.due_date) && <button type="button" className="mini plain" onClick={() => setF(x => ({ ...x, appointed_on: sched.appoint_bec || x.appointed_on, due_date: sched.prep_docs || x.due_date }))}>use the Time Schedule dates</button>}
        </div>
      )}
      {items.length === 0 && <p className="hint">No procurement is ready: execution must be accepted, and items that already have an active BEC are not listed.</p>}
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
      <div className="grid g3" style={{ marginTop: 12 }}>
        <label className="field"><span>Appointment letter reference no</span><input type="text" value={f.letter_ref} maxLength={80} onChange={e => setF({ ...f, letter_ref: e.target.value })} placeholder="e.g. PROC/TEC/2026/014" /></label>
        <label className="field" style={{ gridColumn: 'span 2' }}><span>Notes</span><input type="text" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
      </div>
      <p className="hint">The reference number is quoted in the appointment e-mail and in every reminder for this committee.</p>
      <button className="primary" disabled={busy}>Appoint and start task 1</button>
    </form>
  );
}

// One task of a committee: state, due date, and (for procurement) extend / remind / complete, or start task 2.
function TaskPanel({ c, s, isProc, busy, act }) {
  const [due, setDue] = useState(s.due_date || '');
  const [completedOn, setCompletedOn] = useState(today());
  const [start, setStart] = useState(today());
  const [evalDue, setEvalDue] = useState(c.schedule?.evaluation && c.schedule.evaluation >= today() ? c.schedule.evaluation : '');
  const sch = c.schedule || {};
  const schedDue = s.stage === 1 ? sch.prep_docs : sch.evaluation;
  const live = c.status === 'active';
  const pending = c.members.filter(m => m.tasks[s.stage] && !m.tasks[s.stage].submitted_on).length;
  const tone = s.state === 'completed' ? 'var(--good)' : s.state === 'overdue' ? 'var(--bad)' : s.state === 'active' ? 'var(--accent-2)' : 'var(--line)';
  return (
    <div className="hintbox" style={{ borderLeft: `4px solid ${tone}` }}>
      <div className="between"><b>Task {s.stage}: {s.label}</b>
        <span className={'pill ' + (s.state === 'completed' ? 'ok' : s.state === 'overdue' ? 'bad' : s.state === 'active' ? (s.days_left <= 7 ? 'warn' : 'ok') : 'warn')}>
          {s.state === 'completed' ? `completed ${s.completed_on}` : s.state === 'overdue' ? `overdue ${-s.days_left} d` : s.state === 'active' ? `${s.days_left} d left` : 'not started'}</span></div>
      {s.state !== 'not_activated'
        ? <div style={{ marginTop: 4 }}>Started {s.activated_on} · due <b>{s.due_date}</b>{s.state !== 'completed' ? ` · ${pending} member(s) yet to submit` : ''}
            {schedDue && <div className="hint" style={{ margin: '2px 0 0' }}>Time Schedule: {schedDue}{s.due_date > schedDue ? <span style={{ color: 'var(--warn)' }}> — due date is {daysBetween(schedDue, s.due_date)} d later</span> : null}{s.completed_on && s.completed_on > schedDue ? <span style={{ color: 'var(--warn)' }}> — completed {daysBetween(schedDue, s.completed_on)} d after it</span> : null}</div>}</div>
        : <div className="hint" style={{ margin: '4px 0 0' }}>{c.stages[0].completed_on ? 'Start it once the bids have been opened; its time is counted from then.' : 'Starts after task 1 (bidding documents) is completed and the bids are opened.'}</div>}
      {isProc && live && ['active', 'overdue'].includes(s.state) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
          <input type="date" value={due} min={s.activated_on} onChange={e => setDue(e.target.value)} title="Extend the time given" style={{ width: 150 }} />
          <button className="mini plain" disabled={busy || due === s.due_date} onClick={() => act(() => api.put(`/tec/committees/${c.id}/stages/${s.stage}`, { due_date: due }), `Task ${s.stage} due date changed to ${due}; reminders re-armed.`)}>extend</button>
          <button className="mini plain" disabled={busy || !pending} onClick={() => act(() => api.post(`/tec/committees/${c.id}/remind`), `Reminder e-mailed for task ${s.stage}.`)}>remind now</button>
          <span style={{ flex: 1 }} />
          <input type="date" value={completedOn} onChange={e => setCompletedOn(e.target.value)} style={{ width: 150 }} />
          <button className="primary" style={{ padding: '6px 12px' }} disabled={busy} onClick={() => {
            if (!pending || confirm(`${pending} member(s) are not recorded as submitted for task ${s.stage}. Mark it completed anyway?`)) {
              act(() => api.post(`/tec/committees/${c.id}/stages/${s.stage}/complete`, { completed_on: completedOn }), s.stage === 1 ? 'Task 1 completed — "Preparation of bidding documents / specifications" milestone recorded. Start the bid evaluation once the bids are opened.' : 'Bid evaluation completed — milestone recorded and the committee closed.');
            }
          }}>Task {s.stage} completed</button>
        </div>
      )}
      {isProc && live && s.stage === 2 && s.state === 'not_activated' && c.stages[0].completed_on && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'end' }}>
          <label className="field" style={{ marginBottom: 0 }}><span>Bid evaluation starts</span><input type="date" value={start} min={c.stages[0].completed_on} onChange={e => setStart(e.target.value)} />
            {sch.opening && <ScheduleDate date={sch.opening} value={start} late={false} onUse={d => setStart(d < c.stages[0].completed_on ? c.stages[0].completed_on : d)} />}</label>
          <label className="field" style={{ marginBottom: 0 }}><span>Evaluation due by</span><input type="date" value={evalDue} min={start} onChange={e => setEvalDue(e.target.value)} />
            <ScheduleDate date={sch.evaluation} value={evalDue} onUse={setEvalDue} /></label>
          <button className="primary" disabled={busy || !evalDue} onClick={() => act(() => api.post(`/tec/committees/${c.id}/stages/2/activate`, { activated_on: start, due_date: evalDue }), 'Bid evaluation started — members e-mailed with the due date.')}>Start bid evaluation</button>
        </div>
      )}
    </div>
  );
}

function Committee({ c, members, isProc, onChange }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [letterRef, setLetterRef] = useState(c.letter_ref || '');
  const [add, setAdd] = useState({ member_id: '', role: 'member' });
  const [subDates, setSubDates] = useState({});
  const { busy, error, ok, run } = useAction();
  const active = c.status === 'active';
  const reload = async () => { onChange(); if (open) setDetail(await api.get('/tec/committees/' + c.id)); };
  const act = async (fn, msg) => { if (await run(fn, msg)) reload(); };
  useEffect(() => { if (open) api.get('/tec/committees/' + c.id).then(setDetail); }, [open, c.id]);

  // One member's cell for a task: submitted date (on time / late), a "mark submitted" control, or not started.
  const taskCell = (m, s) => {
    const p = m.tasks[s.stage];
    if (s.state === 'not_activated' || !p) return <span className="hint" style={{ margin: 0 }}>{s.state === 'not_activated' ? 'not started' : '—'}</span>;
    if (p.submitted_on) {
      return <><span className={'pill ' + (p.submitted_on > s.due_date ? 'warn' : 'ok')}>{p.submitted_on}{p.submitted_on > s.due_date ? ' (late)' : ''}</span>
        {isProc && c.status !== 'cancelled' && <button className="mini plain" style={{ marginLeft: 6 }} disabled={busy} onClick={() => act(() => api.post(`/tec/tasks/${p.id}/submission`, { submitted_on: null }))}>undo</button>}</>;
    }
    if (!isProc || c.status === 'cancelled' || s.completed_on) return <span className={'pill ' + (s.completed_on ? 'bad' : 'warn')}>{s.completed_on ? 'not submitted' : 'not yet'}</span>;
    return (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <input type="date" value={subDates[p.id] || today()} onChange={e => setSubDates({ ...subDates, [p.id]: e.target.value })} style={{ width: 140 }} />
        <button className="mini plain" disabled={busy} onClick={() => act(() => api.post(`/tec/tasks/${p.id}/submission`, { submitted_on: subDates[p.id] || today() }), `${m.name}: task ${s.stage} submission recorded.`)}>submitted</button>
      </span>
    );
  };
  const reminders = m => [1, 2].flatMap(n => { const p = m.tasks[n]; return p ? [p.reminder_before_at && `T${n} before due ${when(p.reminder_before_at)}`, p.reminder_overdue_at && `T${n} overdue ${when(p.reminder_overdue_at)}`] : []; }).filter(Boolean).join(' · ');

  return (
    <div className="card" style={{ marginBottom: 12, borderLeft: `4px solid ${c.overdue ? 'var(--bad)' : c.awaiting_stage2 ? 'var(--warn)' : active && c.days_left <= 7 ? 'var(--warn)' : 'var(--line)'}` }}>
      <div className="between">
        <div><b>BEC #{c.id}</b> · {c.bid_no ? <><b>{c.bid_no}</b> ({c.ref_no})</> : c.ref_no} — {c.title} <DueState c={c} /></div>
        <div className="hint" style={{ margin: 0 }}>{c.department} · {c.method || 'method —'} · LKR {fmt(inclVat(c.tce_excl_vat_mn, c.vat_pct))} Mn · {c.letter_ref ? `ref ${c.letter_ref} · ` : ''}appointed {c.appointed_on}</div>
      </div>
      {c.notes && <p className="hint" style={{ margin: '6px 0 0' }}>{c.notes}</p>}
      <Msg error={error} ok={ok} />
      <div className="grid g2" style={{ marginTop: 10 }}>
        {c.stages.map(s => <TaskPanel key={s.stage + (s.due_date || '') + (s.completed_on || '')} c={c} s={s} isProc={isProc} busy={busy} act={act} />)}
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 'none', marginTop: 10 }}><table>
        <thead><tr><th>Member</th><th>Role</th><th>Appointment e-mail</th><th>Task 1 — bidding documents</th><th>Task 2 — bid evaluation</th><th>Reminders</th><th></th></tr></thead>
        <tbody>{c.members.map(m => (
          <tr key={m.id}>
            <td>{m.name}<div className="hint" style={{ margin: 0 }}>{m.designation || ''} {m.email}</div></td>
            <td>{ROLE[m.role]}</td>
            <td>{when(m.appointment_sent_at)}{isProc && active && <button className="mini plain" style={{ marginLeft: 6 }} disabled={busy} onClick={() => act(() => api.post(`/tec/assignments/${m.id}/resend-appointment`), `Appointment e-mail re-sent to ${m.name}.`)}>resend</button>}</td>
            <td>{taskCell(m, c.stages[0])}</td>
            <td>{taskCell(m, c.stages[1])}</td>
            <td className="wrap">{reminders(m) || '—'}</td>
            <td>{isProc && active && ![1, 2].some(n => m.tasks[n] && m.tasks[n].submitted_on) && <button className="mini" disabled={busy} onClick={() => { if (confirm(`Remove ${m.name} from this committee?`)) act(() => api.del(`/tec/committees/${c.id}/members/${m.id}`)); }}>remove</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>

      {isProc && active && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <select value={add.member_id} onChange={e => setAdd({ ...add, member_id: e.target.value })} style={{ width: 'auto' }}>
            <option value="">Add a member…</option>
            {members.filter(m => m.active && !c.members.some(x => x.member_id === m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={add.role} onChange={e => setAdd({ ...add, role: e.target.value })} style={{ width: 'auto' }}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button className="mini plain" disabled={busy || !add.member_id} onClick={async () => { if (await run(() => api.post(`/tec/committees/${c.id}/members`, add), 'Member added and appointment e-mail sent.')) { setAdd({ member_id: '', role: 'member' }); reload(); } }}>add and e-mail</button>
          <span style={{ flex: 1 }} />
          <input type="text" value={letterRef} onChange={e => setLetterRef(e.target.value)} placeholder="letter ref no" maxLength={80} style={{ width: 170 }} />
          <button className="mini plain" disabled={busy || letterRef === (c.letter_ref || '')} onClick={() => act(() => api.put('/tec/committees/' + c.id, { letter_ref: letterRef }), 'Reference saved.')}>save ref</button>
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

const TASK_STATE = {
  in_progress: r => [`in progress · ${r.days} d left`, r.days <= 7 ? 'warn' : 'ok'], overdue: r => [`overdue ${r.days} d`, 'bad'],
  completed_on_time: () => ['completed within time', 'ok'], completed_late: r => [`completed ${r.days} d late`, 'warn']
};

// Progress of one task across all committees: totals, member submissions, and each committee's task with
// the share of its time used (tick) against the share of members who have submitted (bar).
function TaskColumn({ g }) {
  const s = g.summary;
  const open = g.committees.filter(r => !r.completed_on).sort((a, b) => (a.state === 'overdue' ? 0 : 1) - (b.state === 'overdue' ? 0 : 1) || String(a.due_date).localeCompare(String(b.due_date)));
  const done = g.committees.filter(r => r.completed_on).sort((a, b) => String(b.completed_on).localeCompare(String(a.completed_on)));
  const row = r => {
    const [txt, cls] = TASK_STATE[r.state](r);
    return (
      <tr key={r.committee_id}>
        <td>#{r.committee_id}<div className="hint" style={{ margin: 0 }}>{r.bid_no || r.ref_no}</div></td>
        <td className="wrap">{r.title}<div className="hint" style={{ margin: 0 }}>{r.department}</div></td>
        <td>{r.activated_on}<div className="hint" style={{ margin: 0 }}>due {r.due_date}</div></td>
        <td style={{ width: 130 }}>{r.completed_on ? <span className="hint" style={{ margin: 0 }}>{r.used} of {r.allowed} d used</span> : <ProgressBar actual={r.submitted_pct} expected={r.time_pct} />}
          <div className="hint" style={{ margin: 0 }}>{r.submitted}/{r.members} submitted{r.completed_on ? '' : ` · ${r.time_pct}% of time`}</div></td>
        <td><span className={'pill ' + cls}>{txt}</span></td>
      </tr>
    );
  };
  return (
    <div className="card">
      <h2>Task {g.stage}: {g.label}</h2>
      <p className="hint">{g.stage === 1 ? 'Timed from the appointment of the BEC.' : 'Timed from its start after bid opening — the wait for bids is not counted.'} Completing it records the "{g.label}" milestone.</p>
      <div className="grid g3" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="v">{s.in_progress}</div><div className="l">In progress</div></div>
        <div className={'stat ' + (s.overdue ? 'bad' : 'ok')}><div className="v">{s.overdue}</div><div className="l">Overdue</div></div>
        <div className={'stat ' + (s.on_time_pct == null ? '' : s.on_time_pct >= 80 ? 'ok' : s.on_time_pct >= 50 ? 'warn' : 'bad')}><div className="v">{s.on_time_pct == null ? '—' : s.on_time_pct + '%'}</div><div className="l">On time ({s.completed_on_time} of {s.completed_on_time + s.completed_late + s.overdue})</div></div>
      </div>
      <div className="hint" style={{ margin: '0 0 10px' }}>
        Completed {s.completed} ({s.completed_on_time} within time, {s.completed_late} late{s.avg_late ? `, avg ${s.avg_late} d late` : ''}) · avg days allowed {s.avg_allowed ?? '—'} · avg days taken {s.avg_taken ?? '—'}<br />
        Member submissions: {s.members.on_time} within time · {s.members.late} late · {s.members.overdue} overdue · {s.members.pending} pending{s.members.not_submitted ? ` · ${s.members.not_submitted} not submitted` : ''}
      </div>
      {g.committees.length === 0 ? <div className="empty">No committee has started this task.</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
          <thead><tr><th>BEC</th><th>Procurement</th><th>Started / due</th><th>Members vs time</th><th>Status</th></tr></thead>
          <tbody>{open.map(row)}{done.length > 0 && open.length > 0 && <tr><td colSpan={5} className="hint" style={{ paddingTop: 10 }}>Completed</td></tr>}{done.map(row)}</tbody>
        </table></div>
      )}
    </div>
  );
}

function ProgressView({ fy }) {
  const [p, setP] = useState(null);
  useEffect(() => { setP(null); api.get('/tec/progress?plan_fy=' + fy).then(setP); }, [fy]);
  if (!p) return <div className="loading"><span className="spinner"></span> Loading…</div>;
  return (
    <>
      <p className="hint">The BEC's two tasks are monitored separately, each against its own start and due date. In the tables, the bar shows the share of members who have submitted; the tick shows how much of the task's time has passed. The printable version is Reports → BEC / TEC progress by task.</p>
      <div className="grid g2">{[1, 2].map(n => <TaskColumn key={n} g={p[n]} />)}</div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Task 1 done — bid evaluation not started ({p.awaiting.length})</h2>
        <p className="hint">Waiting for the bids to be opened. This time is not counted against the committee; start the bid evaluation on the committee card once the bids are opened.</p>
        {p.awaiting.length === 0 ? <div className="empty">None.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>BEC</th><th>Procurement</th><th>Department</th><th>Task 1 completed</th><th style={{ textAlign: 'right' }}>Waiting</th></tr></thead>
            <tbody>{p.awaiting.map(a => <tr key={a.committee_id}><td>#{a.committee_id} {a.bid_no || a.ref_no}</td><td className="wrap">{a.title}</td><td>{a.department}</td><td>{a.task1_completed}</td><td style={{ textAlign: 'right' }}>{a.waiting_days} d</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

const SIG_FIELDS = [
  ['signatory_name', 'Name of signatory', 'e.g. K. L. Fernando'], ['signatory_designation', 'Designation', 'e.g. Procurement Manager'],
  ['unit', 'Unit / division', 'e.g. Procurement Unit, P&P Division'], ['organisation', 'Organisation', ''],
  ['phone', 'Phone', 'e.g. +94 11 2xxxxxx Ext. 123'], ['email', 'E-mail', 'e.g. procurement@leco.lk']
];

// Signature block and reminder lead time for TEC e-mails, with a live preview of all three e-mails.
function EmailSettings({ status, canEdit, onSaved }) {
  const [sig, setSig] = useState(status.signature);
  const [days, setDays] = useState(status.reminder_days);
  const [sampleRef, setSampleRef] = useState('');
  const [which, setWhich] = useState('appointment');
  const [preview, setPreview] = useState(null);
  const { busy, error, ok, run } = useAction();

  useEffect(() => {
    const t = setTimeout(() => api.post('/tec/preview', { signature: sig, letter_ref: sampleRef }).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [sig, sampleRef]);

  return (
    <div className="grid g2">
      <div className="card">
        <h2>Signature and reminders</h2>
        <p className="hint">Used at the end of every BEC e-mail (appointment, bid evaluation started, reminders). Blank lines are left out. Each e-mail also starts with its date and the committee's appointment letter reference number.</p>
        <Msg error={error} ok={ok} />
        {SIG_FIELDS.map(([k, l, ph]) => (
          <label className="field" key={k}><span>{l}</span>
            <input type={k === 'email' ? 'email' : 'text'} value={sig[k] || ''} disabled={!canEdit} maxLength={160}
              placeholder={k === 'organisation' ? (status.organisation_default || '') + ' (default)' : ph} onChange={e => setSig({ ...sig, [k]: e.target.value })} /></label>
        ))}
        <label className="field"><span>Send the reminder this many days before the due date</span>
          <input type="number" min="1" max="60" value={days} disabled={!canEdit} onChange={e => setDays(e.target.value)} /></label>
        {canEdit && <button className="primary" disabled={busy} onClick={async () => { if (await run(() => api.put('/tec/settings', { reminder_days: Number(days), signature: sig }), 'E-mail settings saved — new e-mails use them.')) onSaved(); }}>Save</button>}
      </div>
      <div className="card">
        <div className="between"><h2 style={{ margin: 0 }}>Preview</h2>
          <div className="tabbar" style={{ margin: 0 }}>{[['appointment', 'Appointment'], ['reminder', 'Reminder (task 1)'], ['stage2', 'Bid evaluation started'], ['overdue', 'Overdue (task 2)']].map(([k, l]) => <button key={k} className={which === k ? 'on' : ''} onClick={() => setWhich(k)}>{l}</button>)}</div></div>
        <label className="field" style={{ marginTop: 10 }}><span>Sample letter reference (preview only)</span><input type="text" value={sampleRef} onChange={e => setSampleRef(e.target.value)} placeholder="PROC/TEC/2026/001" /></label>
        {preview && (
          <div className="hintbox" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            <div style={{ marginBottom: 8 }}><b>Subject:</b> {preview[which].subject}</div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{preview[which].text}</div>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>Sample procurement and member; real e-mails use the committee's details.</p>
      </div>
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
        <p className="hint">Counted per task — each BEC has two: <b>1. bidding documents / specifications</b> (timed from appointment) and <b>2. bid evaluation</b> (timed from its start after bid opening). On time = submitted by that task's due date. Overdue = due date passed, not submitted. Not submitted = task closed without that member's submission. Click a name for the member's tasks.</p>
        {members.length === 0 ? <div className="empty">No members yet.</div> : (
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
            <thead><tr><th>Member</th><th>Department</th><th style={num}>Tasks</th><th style={num}>On time</th><th style={num}>Late</th><th style={num}>Overdue now</th><th style={num}>Pending</th><th style={num}>Not submitted</th><th style={num}>Avg days taken</th><th style={num}>Avg days late</th><th style={num}>On time: documents</th><th style={num}>On time: evaluation</th><th style={num}>On-time rate</th><th></th></tr></thead>
            <tbody>{members.map(m => {
              const p = m.performance;
              return (
                <Fragment key={m.id}>
                  <tr style={m.active ? undefined : { opacity: 0.55 }}>
                    <td><button className="link" onClick={() => setOpenId(openId === m.id ? null : m.id)}>{m.name}</button><div className="hint" style={{ margin: 0 }}>{m.designation || ''} {m.email}{m.active ? '' : ' · inactive'}</div></td>
                    <td>{m.department || '—'}</td><td style={num}>{p.assignments}</td><td style={num}>{p.on_time}</td>
                    <td style={num}>{p.late || ''}</td><td style={num}>{p.overdue ? <span className="pill bad">{p.overdue}</span> : ''}</td><td style={num}>{p.pending || ''}</td><td style={num}>{p.not_submitted || ''}</td>
                    <td style={num}>{p.avg_days_taken ?? '—'}</td><td style={num}>{p.avg_days_late ?? '—'}</td>
                    {[1, 2].map(n => { const q = p.by_stage[n]; return <td key={n} style={num}>{q.on_time_pct == null ? (q.assignments ? 'in progress' : '—') : `${q.on_time_pct}%`}</td>; })}
                    <td style={num}>{p.on_time_pct == null ? '—' : <span className={'pill ' + (p.on_time_pct >= 80 ? 'ok' : p.on_time_pct >= 50 ? 'warn' : 'bad')}>{p.on_time_pct}%</span>}</td>
                    <td>{isProc && <button className="mini plain" onClick={() => { setForm({ ...m, department_id: m.department_id || '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>edit</button>}</td>
                  </tr>
                  {openId === m.id && history && (
                    <tr><td colSpan={14} style={{ background: 'var(--panel-2)' }}>
                      {history.history.length === 0 ? <span className="hint">Not appointed to any committee yet.</span> : (
                        <table><thead><tr><th>BEC</th><th>Procurement</th><th>Role</th><th>Task</th><th>Started</th><th>Due</th><th>Submitted</th><th>Result</th></tr></thead>
                          <tbody>{history.history.map(h => (
                            <tr key={h.committee_id + '-' + h.stage}><td>#{h.committee_id}</td><td className="wrap">{h.ref_no} — {h.title}</td><td>{ROLE[h.role]}</td><td>{h.stage}. {h.task}</td><td>{h.activated_on}</td><td>{h.due_date}</td>
                              <td>{h.submitted_on || '—'}</td>
                              <td><span className={'pill ' + ({ on_time: 'ok', late: 'warn', overdue: 'bad', not_submitted: 'bad', pending: '' }[h.outcome.key])}>{h.outcome.label}</span></td></tr>
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
  const [tab, setTab] = useState('progress');
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
  const dueSoon = committees.filter(c => c.current_stage && !c.overdue && c.days_left <= (status ? status.reminder_days : 7)).length;
  const awaiting = committees.filter(c => c.awaiting_stage2).length;

  return (
    <div>
      <div className="between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Bid Evaluation Committees (BEC / TEC) — {fy}</h2>
        <div className="hint" style={{ margin: 0 }}>Two tasks per BEC, each with its own due date. Reminders go {status ? status.reminder_days : 7} days before each due date and once it lapses.</div>
      </div>
      {status && !status.email_configured && <div className="error-banner">E-mail is not set up on the server yet, so appointment and reminder e-mails are recorded in each committee's e-mail log but not delivered. Add the SMTP settings to .env to start sending.</div>}
      <Msg ok={ok} />
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="v">{committees.filter(c => c.current_stage === 1).length}</div><div className="l">Task 1 in progress — bidding documents</div></div>
        <div className={'stat ' + (awaiting ? 'warn' : '')}><div className="v">{awaiting}</div><div className="l">Task 1 done — bid evaluation not started</div></div>
        <div className="stat"><div className="v">{committees.filter(c => c.current_stage === 2).length}</div><div className="l">Task 2 in progress — bid evaluation</div></div>
        <div className={'stat ' + (overdue ? 'bad' : 'ok')}><div className="v">{overdue}</div><div className="l">Tasks overdue{dueSoon ? ` · ${dueSoon} due within ${status ? status.reminder_days : 7} days` : ''}</div></div>
      </div>
      <div className="tabbar">
        <button className={tab === 'progress' ? 'on' : ''} onClick={() => setTab('progress')}>Progress by task</button>
        <button className={tab === 'committees' ? 'on' : ''} onClick={() => setTab('committees')}>Committees</button>
        <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>Members and performance</button>
        <button className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}>E-mail settings</button>
      </div>
      {tab === 'email' && status && <EmailSettings key={JSON.stringify(status.signature)} status={status} canEdit={isProc} onSaved={load} />}

      {tab === 'progress' && <ProgressView key={committees.length + '-' + committees.map(c => c.current_stage).join('')} fy={fy} />}
      {tab === 'email' || tab === 'progress' ? null : tab === 'committees' ? (
        <>
          {isProc && <AppointForm items={items} members={members} onDone={msg => { setOk(msg); load(); }} />}
          <div className="between" style={{ marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0, flex: 1 }}>Committees</div>
            <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto', marginLeft: 10 }}>
              <option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="">All</option>
            </select>
          </div>
          {shown.length === 0 ? <div className="card"><div className="empty">No committees.</div></div>
            : shown.map(c => <Committee key={[c.id, c.status, ...c.stages.map(s => s.state + (s.due_date || ''))].join('|')} c={c} members={members} isProc={isProc} onChange={load} />)}
        </>
      ) : <Members members={members} isProc={isProc} onChange={load} />}
    </div>
  );
}
