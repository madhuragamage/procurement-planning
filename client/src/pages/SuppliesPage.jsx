import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Msg, useAction, CommentAction } from '../components/ui.jsx';
import { fmt } from '../lib/format.js';

const today = () => new Date().toISOString().slice(0, 10);
const BOND = { bid: 'Bid bond', performance: 'Performance Bond', advance: 'Advance Payment Bond' };
const LETTER = {
  acceptance: 'Acceptance', rejection: 'Rejection', delivery_extension: 'Delivery extension', delay_reminder: 'Delay / delivery reminder',
  bond_extension_request: 'Bond extension request', forfeiture: 'Forfeiture letter', pb_pi_request: 'Performance Bond / proforma invoice request', other: 'Other'
};
const EMAIL_STATUS = { sent: ['sent', 'ok'], failed: ['failed', 'bad'], not_configured: ['not sent — e-mail not set up', 'warn'] };
const ref = c => <>{c.bid_no ? <b>{c.bid_no}</b> : null}<div className="hint" style={{ margin: 0 }}>{c.ref_no}</div></>;

function Progress({ p }) {
  return (
    <div title={`${p.done} of ${p.total} steps`} style={{ minWidth: 110 }}>
      <div className="bar"><div style={{ width: p.pct + '%' }}></div></div>
      <span className="hint" style={{ margin: 0 }}>{p.done}/{p.total}{p.overdue ? <span className="pill bad" style={{ marginLeft: 6 }}>{p.overdue} overdue</span> : null}</span>
    </div>
  );
}

// Step 2: award details entered by the Supplies Department.
function AwardForm({ c, canEdit, onSaved }) {
  const [f, setF] = useState(() => ({
    supplier_name: '', supplier_address: '', supplier_email: '', supplier_phone: '', supplier_contact: '', award_ref: '', award_date: '', order_type: '', order_no: '',
    local_cost_lkr: '', foreign_currency: '', foreign_cost: '', incoterm: '', freight_lkr: '', insurance_lkr: '', bid_bond_amount: '', bid_bond_validity: '', bid_validity: '',
    delivery_date: '', payment_mode: 'local', pb_amount: '', pb_validity: '', pb_due: '', pi_due: '', notes: '',
    ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined))
  }));
  const { busy, error, ok, run } = useAction();
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const inp = (k, label, type = 'text', extra = {}) => (
    <label className="field"><span>{label}</span><input type={type} step={type === 'number' ? 'any' : undefined} value={f[k] ?? ''} disabled={!canEdit} onChange={e => set(k, e.target.value)} {...extra} /></label>
  );
  const chk = (k, label) => <label className="chk"><input type="checkbox" checked={!!Number(f[k])} disabled={!canEdit} onChange={e => set(k, e.target.checked ? 1 : 0)} /> {label}</label>;
  const imported = f.payment_mode !== 'local';
  const pbDefault = f.delivery_date ? new Date(new Date(f.delivery_date + 'T00:00:00Z').getTime() + (c.settings?.pb_validity_extra_days || 60) * 86400000).toISOString().slice(0, 10) : '';

  return (
    <form onSubmit={async e => { e.preventDefault(); if (await run(() => api.put('/supplies/contracts/' + c.id, f), 'Award details saved.')) onSaved(); }}>
      <Msg error={error} ok={ok} />
      <div className="section-title" style={{ marginTop: 0 }}>Supplier</div>
      <div className="grid g4">{inp('supplier_name', 'Supplier', 'text', { required: true })}{inp('supplier_contact', 'Contact person')}{inp('supplier_email', 'E-mail (for reminders)', 'email')}{inp('supplier_phone', 'Phone')}</div>
      {inp('supplier_address', 'Address')}
      <div className="section-title">Award</div>
      <div className="grid g4">
        {inp('award_ref', 'Award / LoA reference')}{inp('award_date', 'Award date', 'date')}
        <label className="field"><span>Order by</span><select value={f.order_type || ''} disabled={!canEdit} onChange={e => set('order_type', e.target.value)}><option value="">—</option><option value="purchase_order">Purchase Order</option><option value="letter_of_acceptance">Letter of Acceptance</option></select></label>
        {inp('order_no', 'P/Order / LoA No')}
      </div>
      <div className="section-title">Awarded cost</div>
      <div className="grid g4">
        {inp('local_cost_lkr', 'Local cost (LKR)', 'number')}
        <label className="field"><span>Payment</span><select value={f.payment_mode} disabled={!canEdit} onChange={e => set('payment_mode', e.target.value)}><option value="local">Local (no LC / TT)</option><option value="LC">Import — Letter of Credit</option><option value="TT">Import — Telegraphic Transfer</option></select></label>
        {inp('foreign_currency', 'Foreign currency (e.g. USD)', 'text', { maxLength: 3 })}{inp('foreign_cost', 'Foreign cost', 'number')}
      </div>
      {imported && <div className="grid g4">
        <label className="field"><span>Basis (ICB)</span><select value={f.incoterm || ''} disabled={!canEdit} onChange={e => set('incoterm', e.target.value)}><option value="">—</option>{['CIF', 'FOB', 'CFR', 'EXW', 'DAP', 'DDP'].map(x => <option key={x}>{x}</option>)}</select></label>
        {inp('freight_lkr', 'Freight (LKR)', 'number')}{inp('insurance_lkr', 'Insurance (LKR)', 'number')}
      </div>}
      <div className="section-title">Bonds and dates</div>
      <div className="grid g4">{inp('bid_bond_amount', 'Bid bond amount (if any)', 'number')}{inp('bid_bond_validity', 'Bid bond valid until', 'date')}{inp('bid_validity', 'Bid validity date', 'date')}{inp('delivery_date', 'Delivery date', 'date')}</div>
      <div className="grid g4">
        {inp('pb_amount', 'Expected Performance Bond amount', 'number')}
        {inp('pb_validity', `Performance Bond valid until${pbDefault ? ` (default ${pbDefault})` : ''}`, 'date')}
        {inp('pb_due', 'Performance Bond due from supplier', 'date')}{inp('pi_due', 'Proforma invoice due from supplier', 'date')}
      </div>
      <p className="hint">Performance Bond validity defaults to the delivery date + {c.settings?.pb_validity_extra_days || 60} days. The due dates for the bond and proforma invoice are set automatically ({c.settings?.pb_days || 14} / {c.settings?.pi_days || 14} days) when you record that the supplier was informed.</p>
      <div className="section-title">What this contract needs (decides which steps apply)</div>
      <div className="grid g4">
        {chk('advance_bond_required', 'Advance payment bond')}{chk('proof_required', 'Proof approval (printing)')}{chk('contract_agreement_required', 'Formal contract agreement')}{chk('fat_required', 'Factory acceptance test')}
        {chk('duty_waiver_required', 'Duty waiver')}{chk('batch_delivery', 'Delivered in batches (e.g. poles)')}
      </div>
      {inp('notes', 'Notes')}
      {canEdit && <button className="primary" disabled={busy}>Save award details</button>}
    </form>
  );
}

function Steps({ c, canEdit, onChange }) {
  const [edit, setEdit] = useState({});
  const { busy, error, ok, run } = useAction();
  const save = async (s, date) => { if (await run(() => api.post(`/supplies/contracts/${c.id}/steps`, { key: s.key, date, note: edit[s.key]?.note ?? s.note }), date ? `${s.label}: ${date}` : `${s.label}: cleared`)) { setEdit(e => ({ ...e, [s.key]: undefined })); onChange(); } };
  const remind = async what => { if (await run(() => api.post(`/supplies/contracts/${c.id}/remind`, { what }), 'Reminder e-mailed to the supplier and logged as a letter.')) onChange(); };
  let group = null;
  return (
    <>
      <Msg error={error} ok={ok} />
      <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
        <thead><tr><th>Step</th><th>Due</th><th>Done on</th><th>Note</th><th></th></tr></thead>
        <tbody>{c.step_list.map(s => {
          const head = s.group !== group; group = s.group;
          const auto = ['file_received', 'accepted'].includes(s.key);
          const e = edit[s.key] || {};
          return (
            <Fragment key={s.key}>
              {head && <tr><td colSpan={5} style={{ background: 'var(--panel-2)', fontWeight: 700, fontFamily: 'var(--disp)' }}>{s.group}</td></tr>}
              <tr>
                <td className="wrap">{s.label}{s.rule && <div className="hint" style={{ margin: 0 }}>{s.rule}</div>}</td>
                <td>{s.due || ''}{s.overdue && <span className="pill bad" style={{ marginLeft: 6 }}>overdue</span>}{s.late_days > 0 && <span className="pill warn" style={{ marginLeft: 6 }}>{s.late_days} d late</span>}</td>
                <td>{s.date
                  ? <span className="pill ok">{s.date}</span>
                  : canEdit && !auto ? <input type="date" value={e.date || today()} onChange={ev => setEdit(x => ({ ...x, [s.key]: { ...e, date: ev.target.value } }))} style={{ width: 150 }} /> : ''}</td>
                <td>{canEdit && !auto && !s.date ? <input type="text" value={e.note ?? s.note ?? ''} placeholder="optional" onChange={ev => setEdit(x => ({ ...x, [s.key]: { ...e, note: ev.target.value } }))} /> : <span className="hint" style={{ margin: 0 }}>{s.note || ''}</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {canEdit && !auto && (s.date
                    ? <button className="mini" disabled={busy} onClick={() => save(s, null)}>clear</button>
                    : <button className="mini plain" disabled={busy} onClick={() => save(s, e.date || today())}>done</button>)}
                  {canEdit && s.key === 'pb_received' && !s.date && c.pb_due && <button className="mini plain" style={{ marginLeft: 4 }} disabled={busy} onClick={() => remind('pb')}>remind supplier</button>}
                  {canEdit && s.key === 'pi_received' && !s.date && c.pi_due && <button className="mini plain" style={{ marginLeft: 4 }} disabled={busy} onClick={() => remind('pi')}>remind supplier</button>}
                  {canEdit && s.key === 'goods_delivered' && s.overdue && <button className="mini plain" style={{ marginLeft: 4 }} disabled={busy} onClick={() => remind('delivery')}>delay reminder</button>}
                </td>
              </tr>
            </Fragment>
          );
        })}</tbody>
      </table></div>
      <p className="hint" style={{ marginTop: 8 }}>Suppliers who have not sent the Performance Bond or proforma invoice by the due date are reminded by e-mail automatically, then every {c.settings?.reminder_interval_days || 7} days until it is recorded{c.pb_reminded_at ? ` (last bond reminder ${String(c.pb_reminded_at).slice(0, 10)})` : ''}{c.pi_reminded_at ? ` (last invoice reminder ${String(c.pi_reminded_at).slice(0, 10)})` : ''}.</p>
    </>
  );
}

const blankBond = { kind: 'performance', bond_no: '', bank: '', amount: '', currency: 'LKR', issued_on: '', expiry_date: '', received_on: '', status: 'held' };

function Bonds({ c, canEdit, onChange }) {
  const [f, setF] = useState(null);
  const { busy, error, ok, run } = useAction();
  const patch = async (b, body, msg) => { if (await run(() => api.put('/supplies/bonds/' + b.id, body), msg)) onChange(); };
  return (
    <>
      <Msg error={error} ok={ok} />
      {c.bonds.length === 0 ? <div className="empty">No bonds recorded.</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
          <thead><tr><th>Bond</th><th>No / bank</th><th style={{ textAlign: 'right' }}>Amount</th><th>Received</th><th>Legal</th><th>Valid until</th><th>Status</th><th>Extension / forfeiture</th></tr></thead>
          <tbody>{c.bonds.map(b => (
            <tr key={b.id}>
              <td>{BOND[b.kind]}</td><td>{b.bond_no || '—'}<div className="hint" style={{ margin: 0 }}>{b.bank || ''}</div></td>
              <td style={{ textAlign: 'right' }}>{fmt(b.amount)} {b.currency}</td><td>{b.received_on || ''}</td>
              <td>{b.legal_cleared_on ? `cleared ${b.legal_cleared_on}` : b.sent_to_legal_on ? `sent ${b.sent_to_legal_on}` : ''}</td>
              <td>{canEdit ? <input type="date" defaultValue={b.expiry_date || ''} onBlur={e => e.target.value !== (b.expiry_date || '') && patch(b, { expiry_date: e.target.value }, 'Validity updated; expiry notice re-armed.')} style={{ width: 150 }} /> : b.expiry_date}
                {b.expiring && <span className="pill warn" style={{ marginLeft: 4 }}>{b.days_to_expiry} d</span>}{b.expired && <span className="pill bad" style={{ marginLeft: 4 }}>expired</span>}</td>
              <td>{canEdit ? <select value={b.status} onChange={e => patch(b, { status: e.target.value, released_on: ['released', 'returned'].includes(e.target.value) ? today() : b.released_on }, 'Bond status updated.')} style={{ width: 'auto' }}>
                {['expected', 'held', 'released', 'returned', 'forfeited'].map(s => <option key={s}>{s}</option>)}</select> : b.status}</td>
              <td className="wrap">
                {b.extension_requested_on ? `extension requested ${b.extension_requested_on}` : canEdit && ['held', 'expected'].includes(b.status) ? <button className="mini plain" onClick={() => patch(b, { extension_requested_on: today() }, 'Extension request recorded.')}>extension requested today</button> : ''}
                {b.forfeiture_letter_on ? ` · forfeiture letter ${b.forfeiture_letter_on}` : canEdit && b.extension_requested_on && b.status === 'held' ? <button className="mini" style={{ marginLeft: 4 }} onClick={() => patch(b, { forfeiture_letter_on: today() }, 'Forfeiture letter recorded.')}>forfeiture letter today</button> : ''}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {canEdit && (f ? (
        <form className="hintbox" style={{ marginTop: 10 }} onSubmit={async e => { e.preventDefault(); if (await run(() => api.post(`/supplies/contracts/${c.id}/bonds`, f), 'Bond added to the register.')) { setF(null); onChange(); } }}>
          <div className="grid g4">
            <label className="field"><span>Bond</span><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>{Object.entries(BOND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field"><span>Bond No</span><input type="text" value={f.bond_no} onChange={e => setF({ ...f, bond_no: e.target.value })} /></label>
            <label className="field"><span>Issuing bank</span><input type="text" value={f.bank} onChange={e => setF({ ...f, bank: e.target.value })} /></label>
            <label className="field"><span>Amount / currency</span><div className="row"><input type="number" step="any" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /><input type="text" maxLength={3} value={f.currency} onChange={e => setF({ ...f, currency: e.target.value })} style={{ maxWidth: 70 }} /></div></label>
          </div>
          <div className="grid g4">
            <label className="field"><span>Issued</span><input type="date" value={f.issued_on} onChange={e => setF({ ...f, issued_on: e.target.value })} /></label>
            <label className="field"><span>Valid until</span><input type="date" value={f.expiry_date} onChange={e => setF({ ...f, expiry_date: e.target.value })} required /></label>
            <label className="field"><span>Received</span><input type="date" value={f.received_on} onChange={e => setF({ ...f, received_on: e.target.value })} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" disabled={busy}>Add bond</button><button type="button" className="ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      ) : <button className="mini plain" style={{ marginTop: 8 }} onClick={() => setF({ ...blankBond, amount: c.pb_amount || '', expiry_date: c.pb_validity || '' })}>+ add bond</button>)}
    </>
  );
}

function Deliveries({ c, canEdit, onChange }) {
  const [f, setF] = useState(null);
  const { busy, error, ok, run } = useAction();
  const patch = async (d, body) => { if (await run(() => api.put('/supplies/deliveries/' + d.id, body), `Batch ${d.batch_no} updated.`)) onChange(); };
  const dateCell = (d, k) => canEdit ? <input type="date" defaultValue={d[k] || ''} onBlur={e => e.target.value !== (d[k] || '') && patch(d, { [k]: e.target.value })} style={{ width: 145 }} /> : d[k] || '';
  return (
    <>
      <Msg error={error} ok={ok} />
      <p className="hint">{c.batch_delivery ? 'Delivered in batches: record each batch with its inspection (e.g. RC / PS pole inspection) and delivery to stores.' : 'Record the delivery (one batch), its inspection and handover.'} Mark the "Goods delivered" step when the last batch is in.</p>
      {c.deliveries.length > 0 && (
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
          <thead><tr><th>Batch</th><th>Description / qty</th><th>Inspection arranged</th><th>Inspected</th><th>Result</th><th>Delivered</th><th>Location</th><th>Handed over</th><th></th></tr></thead>
          <tbody>{c.deliveries.map(d => (
            <tr key={d.id}>
              <td>{d.batch_no}</td><td className="wrap">{d.description}{d.quantity ? ` — ${d.quantity}` : ''}</td>
              <td>{dateCell(d, 'inspection_arranged_on')}</td><td>{dateCell(d, 'inspected_on')}</td>
              <td>{canEdit ? <select value={d.inspection_result} onChange={e => patch(d, { inspection_result: e.target.value })} style={{ width: 'auto' }}>{['pending', 'accepted', 'rejected'].map(x => <option key={x}>{x}</option>)}</select> : d.inspection_result}</td>
              <td>{dateCell(d, 'delivered_on')}</td>
              <td>{canEdit ? <input type="text" defaultValue={d.location || ''} placeholder="Ekala / Waskaduwa" onBlur={e => e.target.value !== (d.location || '') && patch(d, { location: e.target.value })} style={{ width: 130 }} /> : d.location}</td>
              <td>{dateCell(d, 'handed_over_on')}{canEdit ? <input type="text" defaultValue={d.handed_over_to || ''} placeholder="to (dept / staff)" onBlur={e => e.target.value !== (d.handed_over_to || '') && patch(d, { handed_over_to: e.target.value })} style={{ width: 150, marginTop: 4 }} /> : ` ${d.handed_over_to || ''}`}</td>
              <td>{canEdit && <button className="mini" onClick={async () => { if (confirm(`Delete batch ${d.batch_no}?`) && await run(() => api.del('/supplies/deliveries/' + d.id))) onChange(); }}>delete</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {canEdit && (f ? (
        <form className="hintbox" style={{ marginTop: 10 }} onSubmit={async e => { e.preventDefault(); if (await run(() => api.post(`/supplies/contracts/${c.id}/deliveries`, f), 'Batch added.')) { setF(null); onChange(); } }}>
          <div className="grid g4">
            <label className="field" style={{ gridColumn: 'span 2' }}><span>Description</span><input type="text" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
            <label className="field"><span>Quantity</span><input type="text" value={f.quantity} onChange={e => setF({ ...f, quantity: e.target.value })} /></label>
            <label className="field"><span>Inspection arranged</span><input type="date" value={f.inspection_arranged_on} onChange={e => setF({ ...f, inspection_arranged_on: e.target.value })} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button className="primary" disabled={busy}>Add batch</button><button type="button" className="ghost" onClick={() => setF(null)}>Cancel</button></div>
        </form>
      ) : <button className="mini plain" style={{ marginTop: 8 }} onClick={() => setF({ description: '', quantity: '', inspection_arranged_on: '' })}>+ add {c.deliveries.length ? 'batch' : 'delivery'}</button>)}
    </>
  );
}

function Letters({ c, canEdit, onChange }) {
  const [f, setF] = useState({ kind: 'acceptance', letter_date: today(), reference: '', summary: '' });
  const { busy, error, ok, run } = useAction();
  return (
    <>
      <Msg error={error} ok={ok} />
      {c.letters.length === 0 ? <div className="empty">No letters recorded.</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Date</th><th>Letter</th><th>Reference</th><th>Summary</th><th>By</th><th></th></tr></thead>
          <tbody>{c.letters.map(l => <tr key={l.id}><td>{l.letter_date}</td><td>{LETTER[l.kind]}</td><td>{l.reference || ''}</td><td className="wrap">{l.summary || ''}</td><td>{l.created_by_name}</td>
            <td>{canEdit && <button className="mini" onClick={async () => { if (await run(() => api.del('/supplies/letters/' + l.id))) onChange(); }}>delete</button>}</td></tr>)}</tbody>
        </table></div>
      )}
      {canEdit && (
        <form className="addrow" onSubmit={async e => { e.preventDefault(); if (await run(() => api.post(`/supplies/contracts/${c.id}/letters`, f), 'Letter recorded.')) { setF({ ...f, reference: '', summary: '' }); onChange(); } }}>
          <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>{Object.entries(LETTER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input type="date" value={f.letter_date} onChange={e => setF({ ...f, letter_date: e.target.value })} />
          <input type="text" placeholder="Reference" value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} />
          <input type="text" placeholder="Summary" value={f.summary} onChange={e => setF({ ...f, summary: e.target.value })} style={{ flex: 1 }} />
          <button className="mini plain" disabled={busy}>record letter</button>
        </form>
      )}
    </>
  );
}

function Extensions({ c, canEdit, onChange }) {
  const [f, setF] = useState({ requested_on: today(), requested_delivery: '', reason: '', delay_waiver: false });
  const [by, setBy] = useState('');
  const { busy, error, ok, run } = useAction();
  const decide = async (x, decision) => { if (await run(() => api.post(`/supplies/extensions/${x.id}/decide`, { decision, decided_by: by }), decision === 'granted' ? 'Extension granted — contract delivery date moved. Check the Performance Bond validity.' : 'Request refused.')) onChange(); };
  return (
    <>
      <Msg error={error} ok={ok} />
      {c.extensions.length === 0 ? <div className="empty">No extension or delay-waiver requests.</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Requested</th><th>Type</th><th>Delivery: current → requested</th><th>Reason</th><th>Decision</th></tr></thead>
          <tbody>{c.extensions.map(x => (
            <tr key={x.id}><td>{x.requested_on}</td><td>{x.delay_waiver ? 'Delay waiver' : 'Delivery extension'}</td><td>{x.current_delivery || '—'} → {x.requested_delivery}</td><td className="wrap">{x.reason || ''}</td>
              <td>{x.decision === 'pending' ? (canEdit ? <span style={{ display: 'inline-flex', gap: 4 }}>
                <input type="text" placeholder="approved by" value={by} onChange={e => setBy(e.target.value)} style={{ width: 130 }} />
                <button className="mini plain" disabled={busy} onClick={() => decide(x, 'granted')}>granted</button><button className="mini" disabled={busy} onClick={() => decide(x, 'refused')}>refused</button></span> : 'for approval')
                : <span className={'pill ' + (x.decision === 'granted' ? 'ok' : 'bad')}>{x.decision} {x.decided_on}{x.decided_by ? ` (${x.decided_by})` : ''}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {canEdit && (
        <form className="addrow" onSubmit={async e => { e.preventDefault(); if (await run(() => api.post(`/supplies/contracts/${c.id}/extensions`, f), 'Request recorded — it appears on the delay-waiver approval schedule.')) { setF({ ...f, requested_delivery: '', reason: '' }); onChange(); } }}>
          <input type="date" value={f.requested_on} onChange={e => setF({ ...f, requested_on: e.target.value })} title="Date of the supplier's request" />
          <input type="date" value={f.requested_delivery} onChange={e => setF({ ...f, requested_delivery: e.target.value })} title="Delivery date requested" required />
          <input type="text" placeholder="Reason" value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} style={{ flex: 1 }} />
          <label className="chk"><input type="checkbox" checked={f.delay_waiver} onChange={e => setF({ ...f, delay_waiver: e.target.checked })} /> delay waiver</label>
          <button className="mini plain" disabled={busy}>record request</button>
        </form>
      )}
    </>
  );
}

function ContractDetail({ id, canEdit, officers, onChange }) {
  const [c, setC] = useState(null);
  const [tab, setTab] = useState('steps');
  const { busy, error, ok, run } = useAction();
  const load = useCallback(async () => { setC(await api.get('/supplies/contracts/' + id)); onChange(); }, [id, onChange]);
  useEffect(() => { api.get('/supplies/contracts/' + id).then(setC); }, [id]);
  if (!c) return <div className="loading"><span className="spinner"></span> Loading…</div>;
  const editable = canEdit && c.status === 'accepted';
  const TABS = [['steps', 'Process steps'], ['award', 'Award details'], ['bonds', `Bonds (${c.bonds.length})`], ['deliveries', `Delivery and inspection (${c.deliveries.length})`], ['letters', `Letters (${c.letters.length})`], ['extensions', `Extensions (${c.extensions.length})`], ['emails', `E-mails (${c.emails.length})`]];

  return (
    <div className="card" style={{ marginTop: 16, borderColor: 'var(--accent-2)' }}>
      <div className="between">
        <div><h2 style={{ margin: 0 }}>{c.bid_no || c.ref_no} — {c.title}</h2>
          <div className="hint" style={{ margin: 0 }}>Procurement ref {c.ref_no} · {c.department}{c.sub_unit ? ' / ' + c.sub_unit : ''} · {c.method || ''} · forwarded {c.forwarded_on} by {c.forwarded_by_name}{c.forward_note ? ` — “${c.forward_note}”` : ''}</div></div>
        <span className={'pill ' + (c.status === 'closed' ? 'ok' : c.status === 'forwarded' ? 'warn' : 'ok')}>{c.status === 'forwarded' ? 'awaiting acceptance' : c.status}</span>
      </div>
      <Msg error={error} ok={ok} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 13 }}>
        Handled by:
        {canEdit && c.status !== 'closed'
          ? <select value={c.officer_id || ''} onChange={async e => { if (await run(() => api.post(`/supplies/contracts/${c.id}/officer`, { officer_id: e.target.value }), 'Officer assigned.')) load(); }} style={{ width: 'auto' }}>
            <option value="" disabled>assign a Supplies Unit officer…</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          : <b>{c.officer_name || 'not assigned'}</b>}
      </div>
      {c.status === 'forwarded' && (
        <div className="hintbox" style={{ marginTop: 10 }}>
          <b>Accept the file</b> — accept it in the system on the day it is received, then enter the award details.
          {canEdit && <div style={{ marginTop: 8 }}><button className="primary" disabled={busy} onClick={async () => { if (await run(() => api.post(`/supplies/contracts/${c.id}/accept`), 'File accepted. Enter the award details.')) { setTab('award'); load(); } }}>Accept file</button></div>}
        </div>
      )}
      {c.status !== 'forwarded' && <>
        <div className="grid g4" style={{ margin: '12px 0' }}>
          <div className="stat"><div className="v" style={{ fontSize: 16 }}>{c.supplier_name || '—'}</div><div className="l">Supplier</div></div>
          <div className="stat"><div className="v" style={{ fontSize: 16 }}>{c.delivery_date || '—'}</div><div className="l">Delivery date{c.delivery_overdue ? ' — OVERDUE' : ''}</div></div>
          <div className="stat"><div className="v" style={{ fontSize: 16 }}>{c.step_list.find(s => s.key === 'pb_received')?.date || (c.pb_due ? `due ${c.pb_due}` : '—')}</div><div className="l">Performance Bond</div></div>
          <div className="stat"><div className="v" style={{ fontSize: 16 }}>{c.progress.done} / {c.progress.total}</div><div className="l">Steps done{c.progress.overdue ? ` · ${c.progress.overdue} overdue` : ''}</div></div>
        </div>
        <div className="tabbar">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'steps' && <Steps c={c} canEdit={editable} onChange={load} />}
        {tab === 'award' && <AwardForm key={c.id} c={c} canEdit={editable} onSaved={load} />}
        {tab === 'bonds' && <Bonds c={c} canEdit={editable} onChange={load} />}
        {tab === 'deliveries' && <Deliveries c={c} canEdit={editable} onChange={load} />}
        {tab === 'letters' && <Letters c={c} canEdit={editable} onChange={load} />}
        {tab === 'extensions' && <Extensions c={c} canEdit={editable} onChange={load} />}
        {tab === 'emails' && (c.emails.length === 0 ? <div className="empty">No e-mails yet.</div> : (
          <div className="tbl-wrap"><table><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>{c.emails.map(e => <tr key={e.id}><td>{String(e.created_at).slice(0, 16).replace('T', ' ')}</td><td>{e.to_email}</td><td className="wrap">{e.subject}</td><td><span className={'pill ' + EMAIL_STATUS[e.status][1]} title={e.error || ''}>{EMAIL_STATUS[e.status][0]}</span></td></tr>)}</tbody></table></div>
        ))}
        {editable && <div style={{ marginTop: 16 }}><CommentAction busy={busy} actions={[{ label: 'Close the file (all done)', onClick: async comment => { if (c.progress.done < c.progress.total && !confirm(`${c.progress.total - c.progress.done} step(s) are not recorded. Close anyway?`)) return; if (await run(() => api.post(`/supplies/contracts/${c.id}/close`, { comment }), 'File closed.')) load(); } }]} /></div>}
      </>}
    </div>
  );
}

function BondRegister() {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('live');
  useEffect(() => { api.get('/supplies/bonds').then(setRows); }, []);
  const shown = rows.filter(b => filter === 'all' || (filter === 'live' ? ['held', 'expected'].includes(b.status) : b.expiring || b.expired));
  return (
    <div className="card">
      <div className="between"><h2 style={{ margin: 0 }}>Bond register</h2>
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto' }}><option value="live">Held / expected</option><option value="attention">Expiring or expired</option><option value="all">All</option></select></div>
      <p className="hint">Bid, performance and advance payment bonds. The Supplies Department is e-mailed before a held bond expires. For the printable register use Reports → Bond register.</p>
      {shown.length === 0 ? <div className="empty">No bonds.</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
          <thead><tr><th>Bond</th><th>Bid No / ref</th><th>Supplier</th><th>Bond No / bank</th><th style={{ textAlign: 'right' }}>Amount</th><th>Valid until</th><th>Status</th></tr></thead>
          <tbody>{shown.map(b => (
            <tr key={b.id}><td>{BOND[b.kind]}</td><td>{ref(b)}</td><td>{b.supplier_name || ''}</td><td>{b.bond_no || '—'}<div className="hint" style={{ margin: 0 }}>{b.bank || ''}</div></td>
              <td style={{ textAlign: 'right' }}>{fmt(b.amount)} {b.currency}</td>
              <td>{b.expiry_date || ''}{b.expiring && <span className="pill warn" style={{ marginLeft: 4 }}>{b.days_to_expiry} d</span>}{b.expired && <span className="pill bad" style={{ marginLeft: 4 }}>expired</span>}</td>
              <td>{b.status}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

// Workload per Supplies Unit officer, for the head of the Supplies department and management.
function Officers({ rows, officers }) {
  const open = rows.filter(c => c.status !== 'closed');
  const list = [...officers.map(o => ({ id: o.id, name: o.name })), { id: null, name: 'Not assigned' }].map(o => {
    const mine = open.filter(c => (c.officer_id || null) === o.id);
    const closed = rows.filter(c => c.status === 'closed' && (c.officer_id || null) === o.id);
    return { ...o, open: mine.length, awaiting: mine.filter(c => c.status === 'forwarded').length, overdueFiles: mine.filter(c => c.progress.overdue).length,
      overdueSteps: mine.reduce((s, c) => s + c.progress.overdue, 0), late: mine.filter(c => c.delivery_overdue).length, closed: closed.length };
  }).filter(o => o.id !== null || o.open);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h2>Supplies Unit officers</h2>
      <p className="hint">Open files each officer is handling, and how many have overdue steps or deliveries.</p>
      {list.length === 0 ? <div className="empty">No Supplies Unit users yet — add them under Admin → Users with the role "Supplies Unit".</div> : (
        <div className="tbl-wrap"><table>
          <thead><tr><th>Officer</th><th style={{ textAlign: 'right' }}>Open files</th><th style={{ textAlign: 'right' }}>To accept</th><th style={{ textAlign: 'right' }}>Files with overdue steps</th><th style={{ textAlign: 'right' }}>Overdue steps</th><th style={{ textAlign: 'right' }}>Deliveries overdue</th><th style={{ textAlign: 'right' }}>Closed</th></tr></thead>
          <tbody>{list.map(o => (
            <tr key={o.id ?? 'none'}><td>{o.name}</td><td style={{ textAlign: 'right' }}>{o.open}</td><td style={{ textAlign: 'right' }}>{o.awaiting || ''}</td>
              <td style={{ textAlign: 'right' }}>{o.overdueFiles ? <span className="pill bad">{o.overdueFiles}</span> : ''}</td><td style={{ textAlign: 'right' }}>{o.overdueSteps || ''}</td>
              <td style={{ textAlign: 'right' }}>{o.late ? <span className="pill bad">{o.late}</span> : ''}</td><td style={{ textAlign: 'right' }}>{o.closed || ''}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function SuppliesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('files');
  const [rows, setRows] = useState([]);
  const [officers, setOfficers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [filter, setFilter] = useState('open');
  const [officerFilter, setOfficerFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  const canEdit = ['supplies', 'admin'].includes(user.role);
  const load = useCallback(async () => { setRows(await api.get('/supplies/contracts')); }, []);
  useEffect(() => { load(); api.get('/supplies/settings').then(setSettings); api.get('/supplies/officers').then(setOfficers); }, [load]);

  const shown = rows.filter(c => (filter === 'all' || (filter === 'open' ? c.status !== 'closed' : c.status === filter))
    && (!officerFilter || String(c.officer_id || 'none') === officerFilter));
  const awaiting = rows.filter(c => c.status === 'forwarded').length;
  const overdue = rows.filter(c => c.status !== 'closed' && c.progress.overdue).length;
  const late = rows.filter(c => c.delivery_overdue).length;

  return (
    <div>
      <h2 style={{ margin: '0 0 4px' }}>Supplies Unit</h2>
      {!canEdit && <div className="note" style={{ marginTop: 0, marginBottom: 10 }}>View only. {user.role === 'dept_head' ? 'As head of the Supplies department you can follow every file, officer, bond and report; the Supplies Unit officers record the work.' : 'Files are handled by the Supplies Unit.'}</div>}
      <p className="hint">Procurement files forwarded after award. Accept each file on the day it arrives, enter the award details, and record each step of the work procedure; the steps that apply depend on the contract (imports, proof approval, advance payment, FAT, duty waiver).</p>
      {settings && !settings.email_configured && <div className="error-banner">E-mail is not set up on the server yet, so reminders to suppliers and bond expiry notices are logged but not delivered.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className={'stat ' + (awaiting ? 'warn' : '')}><div className="v">{awaiting}</div><div className="l">Files awaiting acceptance</div></div>
        <div className="stat"><div className="v">{rows.filter(c => c.status === 'accepted').length}</div><div className="l">Files in progress</div></div>
        <div className={'stat ' + (overdue ? 'bad' : 'ok')}><div className="v">{overdue}</div><div className="l">Files with overdue steps</div></div>
        <div className={'stat ' + (late ? 'bad' : 'ok')}><div className="v">{late}</div><div className="l">Deliveries overdue</div></div>
      </div>
      <div className="tabbar">
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Files</button>
        <button className={tab === 'bonds' ? 'on' : ''} onClick={() => setTab('bonds')}>Bond register</button>
        <button className={tab === 'officers' ? 'on' : ''} onClick={() => setTab('officers')}>Officers</button>
      </div>
      {tab === 'bonds' ? <BondRegister /> : tab === 'officers' ? <Officers rows={rows} officers={officers} /> : (
        <>
          <div className="card">
            <div className="between" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Files</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={officerFilter} onChange={e => setOfficerFilter(e.target.value)} style={{ width: 'auto' }}><option value="">All officers</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}<option value="none">Not assigned</option></select>
                <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto' }}><option value="open">Open</option><option value="forwarded">Awaiting acceptance</option><option value="accepted">In progress</option><option value="closed">Closed</option><option value="all">All</option></select>
              </div></div>
            {shown.length === 0 ? <div className="empty">No files.</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
                <thead><tr><th>Bid No / ref</th><th>Description</th><th>Department</th><th>Supplier</th><th>Handled by</th><th>Received</th><th>Delivery due</th><th>Progress</th><th>Next step</th><th></th></tr></thead>
                <tbody>{shown.map(c => (
                  <tr key={c.id} style={openId === c.id ? { background: 'var(--panel-2)' } : undefined}>
                    <td>{ref(c)}</td><td className="wrap">{c.title}</td><td>{c.department}</td><td>{c.supplier_name || '—'}</td><td>{c.officer_name || <span className="hint" style={{ margin: 0 }}>not assigned</span>}</td><td>{c.forwarded_on}</td>
                    <td>{c.delivery_date || ''}{c.delivery_overdue && <span className="pill bad" style={{ marginLeft: 4 }}>overdue</span>}</td>
                    <td>{c.status === 'forwarded' ? <span className="pill warn">accept</span> : c.status === 'closed' ? <span className="pill ok">closed</span> : <Progress p={c.progress} />}</td>
                    <td className="wrap">{c.status === 'forwarded' ? 'Accept the file' : c.status === 'closed' ? '' : c.progress.next ? c.progress.next.label : 'All steps done — close the file'}</td>
                    <td><button className="mini plain" onClick={() => setOpenId(openId === c.id ? null : c.id)}>{openId === c.id ? 'close' : 'open'}</button></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          {openId && <ContractDetail key={openId} id={openId} canEdit={canEdit} officers={officers} onChange={load} />}
        </>
      )}
    </div>
  );
}
