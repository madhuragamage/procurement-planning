import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import ItemForm from '../components/ItemForm.jsx';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, YEAR_LABELS, label, FUNDING_LABEL, suggestBidType } from '../lib/format.js';

function RecurPill({ it }) {
  if (it.recurrence !== 'recurrent') return null;
  return <span className="pill warn" style={{ marginLeft: 6 }} title={`Recurrent annually, +${Number(it.annual_increase_pct)}% per year`}>{it.recur_index > 0 ? `recurrent, repeat ${it.recur_index}` : 'recurrent'}</span>;
}

function FullPlanPage() {
  const { user } = useAuth();
  const { fy } = useApp();
  const [info, setInfo] = useState(null);
  const [items, setItems] = useState([]);
  const [snaps, setSnaps] = useState([]);
  const [editing, setEditing] = useState(null);
  const [snapView, setSnapView] = useState(null);
  const { busy, error, ok, run } = useAction();

  const load = useCallback(async () => {
    const [i, list, s] = await Promise.all([api.get('/plans/' + fy), api.get('/plan-items?plan_fy=' + fy), api.get(`/plans/${fy}/snapshots`)]);
    setInfo(i); setItems(list); setSnaps(s); setEditing(null);
  }, [fy]);
  useEffect(() => { setInfo(null); load(); }, [load]);

  if (!info) return <div className="loading"><span className="spinner"></span> Loading…</div>;
  const { plan } = info;
  const canEdit = ['procurement', 'admin'].includes(user.role) && ['planning', 'changes_requested'].includes(plan.status);
  // Management may amend a submitted plan (edit / remove items) and then approve it.
  const mgmtAmend = user.role === 'management' && plan.status === 'submitted';
  const amendCount = (info.amendments || []).length;
  const isProc = ['procurement', 'admin'].includes(user.role);
  const act = (path, msg) => async comment => { await run(() => api.post(`/plans/${fy}/${path}`, { comment }), msg); load(); };
  const tracking = ['approved', 'frozen'].includes(plan.status);
  // Starting execution needs the tender / quotation class, which creates the bid number.
  const startNow = async it => {
    let type = suggestBidType(it.method);
    const answer = window.prompt(`Start execution of ${it.ref_no}. Procure by tender (T) or quotation (Q)?`, type === 'quotation' ? 'Q' : type === 'tender' ? 'T' : '');
    if (answer === null) return;
    type = /^q/i.test(answer.trim()) ? 'quotation' : /^t/i.test(answer.trim()) ? 'tender' : '';
    if (!type) { window.alert('Enter T for tender or Q for quotation.'); return; }
    const out = await run(() => api.post('/execution-requests', { plan_item_id: it.id, note: 'Started by the procurement unit', bid_type: type }), `${it.ref_no}: execution started.`);
    if (out && out.bid_no) window.alert(`${it.ref_no}: bid number ${out.bid_no}`);
    load();
  };
  const grandTotal = info.summary.reduce((s, y) => s + y.tce_incl_vat_mn, 0);

  return (
    <div>
      <div className="between" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Master procurement plan {fy}-{fy + 2}</h2>
          <span className="hint" style={{ margin: 0 }}>Annual plan for {fy} with tentative plans for {fy + 1} and {fy + 2}.</span>
        </div>
        <div><Status value={plan.status} /> <span className="pill warn">version {plan.version}</span></div>
      </div>
      <Msg error={error} ok={ok} />

      {plan.status === 'changes_requested' && plan.review_comment && (
        <div className="error-banner"><b>Management requested changes:</b> {plan.review_comment}</div>
      )}

      <div className="grid g4">
        {info.summary.map(y => (
          <div className="stat" key={y.year_offset}><div className="v">{fmt(y.tce_incl_vat_mn)}</div><div className="l">{YEAR_LABELS(fy)[y.year_offset]} · {y.count} items · LKR Mn</div></div>
        ))}
        <div className="stat ok"><div className="v">{fmt(grandTotal)}</div><div className="l">Total incl. VAT · LKR Mn</div></div>
      </div>

      {(info.incomplete.length > 0 || info.unplanned_authorised > 0 || info.budget_warnings.length > 0) && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Before this plan can go to management</h2>
          <ul className="warnlist">
            {info.unplanned_authorised > 0 && <li>{info.unplanned_authorised} authorised request(s) for {fy} still need a method — <Link to="/app/inbox">open the inbox</Link>.</li>}
            {info.incomplete.map(i => <li key={i.id}>{i.ref_no} {i.title}: needs {i.missing.join(', ')}.</li>)}
            {info.budget_warnings.map(w => <li key={w}>Budget: {w}</li>)}
          </ul>
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <h2>Workflow</h2>
        <p className="hint">Planning → submitted to management → approved → frozen. After approval, changes go through bi-annual or urgent plan revisions.</p>
        {plan.status === 'planning' || plan.status === 'changes_requested' ? (
          isProc ? <CommentAction busy={busy} actions={[{ label: 'Submit for management approval', primary: true, onClick: act('submit', 'Plan submitted to management.') }]} />
            : <div className="hint">The procurement unit submits the plan for approval.</div>
        ) : plan.status === 'submitted' ? (
          user.role === 'management' ? (
            <>
              <p className="hint" style={{ marginTop: 0 }}>Approve the plan as submitted, <b>amend items yourself</b> (edit or remove them in the lists below) and then approve, or return it to procurement with your comments.</p>
              {amendCount > 0 && (
                <div className="hintbox" style={{ marginBottom: 10 }}>
                  <b>Your amendments ({amendCount})</b>
                  <ul className="warnlist" style={{ color: 'var(--text)' }}>{info.amendments.map(a => <li key={a.id}>{a.action === 'mgmt-remove' ? 'Removed: ' : 'Amended: '}{a.comment} <span className="hint" style={{ margin: 0 }}>({a.user}, {String(a.at).slice(0, 16).replace('T', ' ')})</span></li>)}</ul>
                </div>
              )}
              <CommentAction busy={busy} actions={[
                { label: amendCount ? `Approve with ${amendCount} amendment${amendCount > 1 ? 's' : ''}` : 'Approve plan', primary: true, onClick: act('approve', amendCount ? 'Plan approved with your amendments.' : 'Plan approved.') },
                { label: 'Return with changes', onClick: act('return', 'Plan returned to procurement.') }
              ]} />
            </>
          ) : <div className="hint">Awaiting management approval. Management can approve it as submitted, amend it and approve, or return it with change comments.{amendCount ? ` Management has made ${amendCount} amendment(s) so far.` : ''}</div>
        ) : plan.status === 'approved' ? (
          ['management', 'procurement', 'admin'].includes(user.role)
            ? <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><button className="primary" disabled={busy} onClick={async () => { await run(() => api.post(`/plans/${fy}/freeze`), 'Plan frozen.'); load(); }}>Freeze plan</button><span className="hint" style={{ margin: 0 }}>Freezing locks item edits; only approved revisions can change the plan.</span></div>
            : <div className="hint">Approved, awaiting freeze.</div>
        ) : (
          <div className="hint">This plan is frozen{plan.frozen_at ? ' since ' + plan.frozen_at.slice(0, 10) : ''}. {info.pending_revisions > 0 ? `${info.pending_revisions} revision(s) awaiting management. ` : ''}<Link to="/app/revisions">Manage revisions</Link>.</div>
        )}
      </div>

      {editing && <div style={{ marginTop: 14 }}><ItemForm mode="edit" source={editing} categoryId={editing.category_id} onCancel={() => setEditing(null)} onSaved={() => { load(); }} /></div>}

      {[0, 1, 2].map(o => {
        const list = items.filter(i => i.year_offset === o && i.status !== 'cancelled');
        return (
          <Fragment key={o}>
            <div className="section-title">{o === 0 ? 'Annual procurement plan' : 'Tentative plan'} — {YEAR_LABELS(fy)[o]}</div>
            <div className="card">
              {list.length === 0 ? <div className="empty">No items.</div> : (
                <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
                  <thead><tr><th>Ref</th><th>Description</th><th>Department</th><th>Category</th><th>Type</th><th>Method</th><th>Committee</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Start</th><th>Delivery</th><th>Checks</th><th>Execution</th><th></th></tr></thead>
                  <tbody>{list.map(it => (
                    <tr key={it.id}>
                      <td>{it.bid_no ? <><b>{it.bid_no}</b><div className="hint" style={{ margin: 0 }}>{it.ref_no}</div></> : it.ref_no}</td><td className="wrap">{it.title}<RecurPill it={it} />{it.mgmt_amended_at && <span className="pill warn" style={{ marginLeft: 6 }} title={`Amended by management on ${String(it.mgmt_amended_at).slice(0, 10)}`}>amended by management</span>}</td><td>{it.department}</td><td>{it.category}</td><td>{it.expense_type}</td>
                      <td>{it.method || <span className="pill bad">none</span>}</td><td>{it.committee_level}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(it.tce_incl_vat_mn)}</td><td>{it.procurement_start}</td><td>{it.expected_delivery}</td>
                      <td title={it.checks.warnings.join('\n')}>{it.checks.warnings.length ? <span className="pill warn">{it.checks.warnings.length} warning{it.checks.warnings.length > 1 ? 's' : ''}</span> : <span className="pill ok">ok</span>}</td>
                      <td>{tracking ? <><Status value={it.exec_status} />{isProc && it.status === 'planned' && !['accepted', 'requested'].includes(it.exec_status) && <button className="mini plain" style={{ marginLeft: 6 }} disabled={busy} onClick={() => startNow(it)}>start</button>}</> : ''}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {canEdit || mgmtAmend ? <>
                          <button className="mini plain" onClick={() => { setEditing(it); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{mgmtAmend ? 'amend' : 'edit'}</button>
                          <button className="mini" disabled={busy} onClick={async () => {
                            const msg = mgmtAmend
                              ? (it.recur_index > 0 ? `Remove this repeat (${it.ref_no}) from the plan? The original procurement stays in the plan.` : `Remove ${it.ref_no} from the plan? It will be REJECTED by management${it.recurrence === 'recurrent' ? ' (with its recurrent repeats)' : ''}; it can come back only through a plan revision if required.`)
                              : `Remove ${it.ref_no} from the plan?${it.recurrence === 'recurrent' && it.recur_index === 0 ? ' Its recurrent repeats in later years are removed too.' : ''} The request stays authorised and returns to the procurement inbox.`;
                            if (mgmtAmend) {
                              const reason = window.prompt(`${msg}\n\nReason for removing it (recorded with your amendments):`, '');
                              if (reason === null) return;
                              await run(() => api.del('/plan-items/' + it.id, { reason }), it.recur_index > 0 ? `${it.ref_no} removed.` : `${it.ref_no} removed and rejected by management.`); load();
                            } else if (confirm(msg)) { await run(() => api.del('/plan-items/' + it.id)); load(); }
                          }}>remove</button>
                        </> : <span className="hint" style={{ margin: 0 }}>locked</span>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          </Fragment>
        );
      })}

      {items.some(i => i.status === 'cancelled') && (
        <>
          <div className="section-title">Cancelled by revision</div>
          <div className="card"><div className="tbl-wrap"><table><tbody>
            {items.filter(i => i.status === 'cancelled').map(i => <tr key={i.id}><td>{i.ref_no}</td><td className="wrap">{i.title}</td><td className="wrap">{i.remarks}</td></tr>)}
          </tbody></table></div></div>
        </>
      )}

      <div className="section-title">Approved versions</div>
      <div className="card">
        {snaps.length === 0 ? <div className="empty">A snapshot is stored each time management approves the plan or a revision.</div> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Version</th><th>Event</th><th>When</th><th>By</th><th></th></tr></thead>
            <tbody>{snaps.map(s => (
              <tr key={s.id}><td>v{s.version}</td><td className="wrap">{s.label}</td><td>{s.created_at.slice(0, 16).replace('T', ' ')}</td><td>{s.created_by}</td>
                <td><button className="mini plain" onClick={async () => setSnapView(await api.get(`/plans/${fy}/snapshots/${s.id}`))}>view</button></td></tr>
            ))}</tbody>
          </table></div>
        )}
        {snapView && (
          <div style={{ marginTop: 14 }}>
            <div className="between"><b>Snapshot v{snapView.version} — {snapView.label}</b><button className="mini plain" onClick={() => setSnapView(null)}>close</button></div>
            <div className="tbl-wrap"><table>
              <thead><tr><th>Ref</th><th>Description</th><th>Year</th><th>Method</th><th style={{ textAlign: 'right' }}>Excl. VAT</th><th>Start</th><th>Delivery</th><th>Status</th></tr></thead>
              <tbody>{snapView.data.items.map(i => <tr key={i.id}><td>{i.ref_no}</td><td className="wrap">{i.title}</td><td>+{i.year_offset}</td><td>{i.method}</td><td style={{ textAlign: 'right' }}>{fmt(i.tce_excl_vat_mn)}</td><td>{i.procurement_start}</td><td>{i.expected_delivery}</td><td>{label(i.status)}</td></tr>)}</tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

const CHANGE_STATE = c => c.status === 'submitted' ? ['awaiting department head', 'warn']
  : c.status === 'pending' ? ['authorised — with the procurement unit', 'warn']
  : c.status === 'returned' ? [`returned by ${c.decided_by_name || 'reviewer'}`, 'bad']
  : c.revision_status === 'approved' ? [`approved in revision #${c.revision_id}`, 'ok']
  : c.revision_status === 'rejected' ? [`rejected by management (revision #${c.revision_id})`, 'bad']
  : c.revision_status === 'submitted' ? [`awaiting management (revision #${c.revision_id})`, 'warn']
  : [`in draft revision #${c.revision_id}`, 'warn'];

// A department asks for one of its approved items to be modified or cancelled through a plan revision.
function ChangeRequestForm({ item, fy, onDone, onCancel }) {
  const { user } = useAuth();
  const [action, setAction] = useState('modify');
  const [p, setP] = useState({ tce_excl_vat_mn: '', year_offset: '', procurement_start: '', expected_delivery: '', remarks: '' });
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const set = (k, v) => setP(x => ({ ...x, [k]: v }));
  async function send(e) {
    e.preventDefault();
    const payload = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== ''));
    if (await run(() => api.post('/change-requests', { plan_item_id: item.id, action, reason, payload: action === 'modify' ? payload : undefined }))) {
      onDone(`${item.ref_no}: ${action === 'cancel' ? 'cancellation' : 'modification'} request sent to ${user.role === 'dept_head' ? 'the procurement unit' : 'your department head for authorisation'}.`);
    }
  }
  return (
    <form className="card" onSubmit={send} style={{ marginBottom: 14, borderColor: 'var(--accent-2)' }}>
      <h2>Request a change — {item.ref_no} {item.title}</h2>
      <p className="hint">The approved plan can only change through a plan revision. {user.role === 'dept_head' ? 'As department head, your request goes straight to the procurement unit' : 'Your department head authorises the request first; it then goes to the procurement unit'}, which adds it to a revision for management approval (or returns it with a comment).</p>
      <Msg error={error} />
      <div className="grid g4">
        <label className="field"><span>Request</span>
          <select value={action} onChange={e => setAction(e.target.value)}><option value="modify">Modify this item</option><option value="cancel">Cancel this item</option></select></label>
      </div>
      {action === 'modify' && (
        <div className="grid g4">
          <label className="field"><span>New cost excl. VAT (LKR Mn)</span><input type="number" step="any" min="0" value={p.tce_excl_vat_mn} placeholder={`now ${item.tce_excl_vat_mn}`} onChange={e => set('tce_excl_vat_mn', e.target.value)} /></label>
          <label className="field"><span>Move to plan year</span>
            <select value={p.year_offset} onChange={e => set('year_offset', e.target.value)}><option value="">keep ({YEAR_LABELS(fy)[item.year_offset]})</option>{YEAR_LABELS(fy).map((l, i) => i !== item.year_offset && <option key={i} value={i}>{l}</option>)}</select></label>
          <label className="field"><span>New procurement start</span><input type="date" value={p.procurement_start} onChange={e => set('procurement_start', e.target.value)} /></label>
          <label className="field"><span>New expected delivery</span><input type="date" value={p.expected_delivery} onChange={e => set('expected_delivery', e.target.value)} /></label>
        </div>
      )}
      {action === 'modify' && <label className="field"><span>Other change / remarks</span><input type="text" value={p.remarks} onChange={e => set('remarks', e.target.value)} placeholder="e.g. revised scope or quantity" /></label>}
      <label className="field"><span>Reason (required)</span><input type="text" value={reason} onChange={e => setReason(e.target.value)} required /></label>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" disabled={busy}>Send request</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// Department users see only their own unit's items, and only after management approves the plan.
function DepartmentPlan() {
  const { user } = useAuth();
  const { fy, lookups } = useApp();
  const [info, setInfo] = useState(null);
  const [items, setItems] = useState([]);
  const [changes, setChanges] = useState([]);
  const [changing, setChanging] = useState(null);
  const { busy, error, ok, run, setOk } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + lookups.reminders.lead_days * 86400000).toISOString().slice(0, 10);

  const load = useCallback(async () => {
    const i = await api.get('/plans/' + fy);
    setInfo(i);
    const approvedPlan = ['approved', 'frozen'].includes(i.plan.status);
    setItems(approvedPlan ? await api.get('/plan-items?plan_fy=' + fy) : []);
    setChanges(approvedPlan ? await api.get('/change-requests?plan_fy=' + fy) : []);
  }, [fy]);
  // Items with a change request still open (with procurement, or in a revision not yet decided).
  const openChange = id => changes.some(c => c.plan_item_id === id && (['submitted', 'pending'].includes(c.status) || (c.status === 'included' && ['draft', 'submitted'].includes(c.revision_status))));
  useEffect(() => { setInfo(null); load(); }, [load]);

  if (!info) return <div className="loading"><span className="spinner"></span> Loading…</div>;
  const approved = ['approved', 'frozen'].includes(info.plan.status);
  const request = async it => {
    const note = window.prompt('Note for the procurement unit (optional):', '');
    if (note === null) return;
    await run(() => api.post('/execution-requests', { plan_item_id: it.id, note }), `${it.ref_no}: execution request sent to the procurement unit.`);
    load();
  };

  return (
    <div>
      <div className="between" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Approved procurement plan {fy}-{fy + 2}</h2>
          <span className="hint" style={{ margin: 0 }}>{user.department}{user.sub_unit ? ' / ' + user.sub_unit : ''} — your unit's planned procurements</span>
        </div>
        <div><Status value={info.plan.status} /> {approved && <span className="pill warn">version {info.plan.version}</span>}</div>
      </div>
      <Msg error={error} ok={ok} />
      {!approved ? (
        <div className="card"><div className="empty">The {fy} plan has not been approved by management yet. Your unit's items appear here once it is.</div></div>
      ) : (
        <>
          <p className="hint">When a procurement's planned start date approaches, send an <b>execution request</b> so the procurement unit can begin. Approval in the plan does not start procurement by itself. To change or cancel an item, use <b>request change</b>.</p>
          {changing && <ChangeRequestForm item={changing} fy={fy} onCancel={() => setChanging(null)} onDone={msg => { setChanging(null); setOk(msg); load(); }} />}
          {[0, 1, 2].map(o => {
            const list = items.filter(i => i.year_offset === o && i.status !== 'cancelled');
            return (
              <div key={o}>
                <div className="section-title">{o === 0 ? 'Annual plan' : 'Tentative plan'} — {YEAR_LABELS(fy)[o]}</div>
                <div className="card">
                  {list.length === 0 ? <div className="empty">No items for your unit.</div> : (
                    <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
                      <thead><tr><th>Ref</th><th>Description</th><th>Unit</th><th>Type</th><th>Reason</th><th>Method</th><th>Funding</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Planned start</th><th>Delivery</th><th>Status</th><th>Execution</th><th></th></tr></thead>
                      <tbody>{list.map(it => {
                        const near = it.status === 'planned' && it.procurement_start && it.procurement_start <= soon && ['not_requested', 'returned'].includes(it.exec_status);
                        const canRequest = it.status === 'planned' && ['not_requested', 'returned'].includes(it.exec_status);
                        return (
                          <tr key={it.id}>
                            <td>{it.ref_no}</td><td className="wrap">{it.title}<RecurPill it={it} /></td><td>{it.sub_unit || it.department}</td><td>{it.expense_type}</td><td>{it.reason}</td><td>{it.method}</td><td>{FUNDING_LABEL[it.funding_source]}</td>
                            <td style={{ textAlign: 'right' }}>{fmt(it.tce_incl_vat_mn)}</td>
                            <td>{it.procurement_start}{near && <span className={'pill ' + (it.procurement_start < today ? 'bad' : 'warn')} style={{ marginLeft: 6 }}>{it.procurement_start < today ? 'due' : 'soon'}</span>}</td>
                            <td>{it.expected_delivery}</td><td><Status value={it.status} /></td><td><Status value={it.exec_status} /></td>
                            <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {canRequest && <button className={near ? 'primary' : 'mini plain'} style={near ? { padding: '5px 10px', fontSize: 12 } : undefined} disabled={busy} onClick={() => request(it)}>request execution</button>}
                              {openChange(it.id) ? <span className="pill warn">change requested</span>
                                : <button className="mini plain" onClick={() => { setChanging(it); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>request change</button>}
                            </td>
                          </tr>
                        );
                      })}</tbody>
                    </table></div>
                  )}
                </div>
              </div>
            );
          })}

          <div className="section-title">Your change requests</div>
          <div className="card">
            {changes.length === 0 ? <div className="empty">No modification or cancellation requests yet.</div> : (
              <div className="tbl-wrap"><table>
                <thead><tr><th>Ref</th><th>Description</th><th>Request</th><th>Proposed</th><th>Reason</th><th>Sent</th><th>Status</th><th>Comment</th></tr></thead>
                <tbody>{changes.map(c => {
                  const [txt, cls] = CHANGE_STATE(c);
                  return (
                    <tr key={c.id}><td>{c.ref_no}</td><td className="wrap">{c.title}</td><td>{c.action === 'cancel' ? 'cancellation' : 'modification'}</td>
                      <td className="wrap">{Object.entries(c.payload || {}).map(([k, v]) => `${label(k)}: ${v}`).join('; ')}</td><td className="wrap">{c.reason}</td>
                      <td>{c.created_at.slice(0, 10)}</td><td><span className={'pill ' + cls}>{txt}</span></td><td className="wrap">{c.decision_comment || ''}</td></tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function PlanPage() {
  const { user } = useAuth();
  return ['requester', 'dept_head'].includes(user.role) ? <DepartmentPlan /> : <FullPlanPage />;
}
