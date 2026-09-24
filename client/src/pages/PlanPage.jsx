import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import ItemForm from '../components/ItemForm.jsx';
import { Status, Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt, YEAR_LABELS, label } from '../lib/format.js';

export default function PlanPage() {
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
  const isProc = ['procurement', 'admin'].includes(user.role);
  const act = (path, msg) => async comment => { await run(() => api.post(`/plans/${fy}/${path}`, { comment }), msg); load(); };
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
            <CommentAction busy={busy} actions={[
              { label: 'Approve plan', primary: true, onClick: act('approve', 'Plan approved.') },
              { label: 'Return with changes', onClick: act('return', 'Plan returned to procurement.') }
            ]} />
          ) : <div className="hint">Awaiting management approval. Management can approve it or return it with change comments.</div>
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
                  <thead><tr><th>Ref</th><th>Description</th><th>Department</th><th>Category</th><th>Method</th><th>Committee</th><th style={{ textAlign: 'right' }}>Incl. VAT (Mn)</th><th>Start</th><th>Delivery</th><th>Checks</th><th></th></tr></thead>
                  <tbody>{list.map(it => (
                    <tr key={it.id}>
                      <td>{it.ref_no}</td><td className="wrap">{it.title}</td><td>{it.department}</td><td>{it.category}</td>
                      <td>{it.method || <span className="pill bad">none</span>}</td><td>{it.committee_level}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(it.tce_incl_vat_mn)}</td><td>{it.procurement_start}</td><td>{it.expected_delivery}</td>
                      <td title={it.checks.warnings.join('\n')}>{it.checks.warnings.length ? <span className="pill warn">{it.checks.warnings.length} warning{it.checks.warnings.length > 1 ? 's' : ''}</span> : <span className="pill ok">ok</span>}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        {canEdit ? <>
                          <button className="mini plain" onClick={() => { setEditing(it); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>edit</button>
                          <button className="mini" disabled={busy} onClick={async () => { if (confirm(`Remove ${it.ref_no} from the plan? The request stays authorised.`)) { await run(() => api.del('/plan-items/' + it.id)); load(); } }}>remove</button>
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
