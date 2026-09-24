import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from './ui.jsx';
import { fmt, YEAR_LABELS } from '../lib/format.js';

const pick = (s, fy) => ({
  title: s.title || '', tce_excl_vat_mn: s.tce_excl_vat_mn, vat_pct: s.vat_pct, funding_source: s.funding_source, funding_agency: s.funding_agency || '',
  year_offset: s.year_offset, method: s.method || '', bidding_procedure: s.bidding_procedure || '', prequalification: !!s.prequalification,
  committee_level: s.committee_level || '', procurement_start: s.procurement_start || '', expected_delivery: s.expected_delivery || '', remarks: s.remarks || '',
  regenerate_schedule: false, plan_fy: s.plan_fy ?? fy
});

// Assign (create) or edit a plan item, with live hints from the Manual's rules.
export default function ItemForm({ mode, source, categoryId, onSaved, onCancel }) {
  const { lookups } = useApp();
  const [f, setF] = useState(() => pick(source));
  const [hints, setHints] = useState(null);
  const { busy, error, run } = useAction();
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const editing = mode === 'edit';

  useEffect(() => {
    const t = setTimeout(() => {
      api.post('/rules/suggest', {
        tce_excl_vat_mn: f.tce_excl_vat_mn, vat_pct: f.vat_pct, funding_source: f.funding_source, category_id: categoryId,
        method: f.method, prequalification: f.prequalification, committee_level: f.committee_level,
        procurement_start: f.procurement_start, expected_delivery: f.expected_delivery
      }).then(setHints).catch(() => setHints(null));
    }, 250);
    return () => clearTimeout(t);
  }, [f.tce_excl_vat_mn, f.vat_pct, f.funding_source, f.method, f.prequalification, f.committee_level, f.procurement_start, f.expected_delivery, categoryId]);

  async function save(e) {
    e.preventDefault();
    const { plan_fy, ...body } = f;
    const out = await run(() => editing
      ? api.put('/plan-items/' + source.id, body)
      : api.post('/plan-items', { request_id: source.id, ...body }));
    if (out) onSaved(out);
  }

  const showBidding = ['ICB', 'LIB', 'NCB', 'LNB'].includes(f.method);

  return (
    <form className="card" onSubmit={save} style={{ marginBottom: 16, borderColor: 'var(--accent-2)' }}>
      <h2>{editing ? `Edit plan item ${source.ref_no}` : `Assign method and schedule — ${source.ref_no}`}</h2>
      <p className="hint">Values you enter are checked against the National Procurement Manual as you type. Warnings do not block saving; they flag what the approving committee will question.</p>
      <Msg error={error} />
      <label className="field"><span>Title</span><input type="text" value={f.title} onChange={e => set('title', e.target.value)} required /></label>
      <div className="grid g4">
        <label className="field"><span>TCE excl. VAT (LKR Mn)</span>
          <input type="number" step="any" min="0" value={f.tce_excl_vat_mn} onChange={e => set('tce_excl_vat_mn', e.target.value)} required /></label>
        <label className="field"><span>VAT %</span>
          <input type="number" step="any" min="0" max="100" value={f.vat_pct} onChange={e => set('vat_pct', e.target.value)} /></label>
        <label className="field"><span>Funding</span>
          <select value={f.funding_source} onChange={e => set('funding_source', e.target.value)}><option value="GOSL">GOSL / own funds</option><option value="Foreign">Foreign funded</option></select></label>
        <label className="field"><span>Plan year (cycle {source.plan_fy ?? ''})</span>
          <select value={f.year_offset} onChange={e => set('year_offset', Number(e.target.value))}>
            {YEAR_LABELS(Number(source.plan_fy) || 0).map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select></label>
      </div>

      <div className="section-title" style={{ marginTop: 6 }}>Method</div>
      <div className="grid g4">
        <label className="field"><span>Procurement method</span>
          <select value={f.method} onChange={e => set('method', e.target.value)}>
            <option value="">Not assigned</option>
            {lookups.methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select></label>
        <label className="field"><span>Bidding procedure</span>
          <select value={f.bidding_procedure} onChange={e => set('bidding_procedure', e.target.value)}>
            <option value="">—</option>
            {lookups.biddingProcedures.map(m => <option key={m} value={m}>{m}</option>)}
          </select></label>
        <label className="field"><span>Approving committee</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={f.committee_level} onChange={e => set('committee_level', e.target.value)}>
              <option value="">Auto (by value)</option>
              {lookups.committeeLevels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {hints && <button type="button" className="mini plain" title="Use the level required by Section 2.9(1)" onClick={() => set('committee_level', hints.suggested_committee)}>use {hints.suggested_committee}</button>}
          </div></label>
        <label className="chk" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.prequalification} onChange={e => set('prequalification', e.target.checked)} /> Prequalification (Annex VIII)</label>
      </div>
      {!showBidding && f.method && <p className="hint">Bidding procedure and prequalification apply to competitive bidding (ICB/LIB/NCB/LNB).</p>}

      <div className="section-title" style={{ marginTop: 6 }}>Dates</div>
      <div className="grid g4">
        <label className="field"><span>Procurement start</span><input type="date" value={f.procurement_start} onChange={e => set('procurement_start', e.target.value)} /></label>
        <label className="field"><span>Expected delivery / completion</span><input type="date" value={f.expected_delivery} onChange={e => set('expected_delivery', e.target.value)} /></label>
        {editing && <label className="chk" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.regenerate_schedule} onChange={e => set('regenerate_schedule', e.target.checked)} /> Re-draft milestone dates from these dates</label>}
      </div>
      <label className="field"><span>Remarks</span><input type="text" value={f.remarks} onChange={e => set('remarks', e.target.value)} /></label>

      {hints && (
        <div className="hintbox">
          <div><b>Manual check</b> — TCE incl. VAT: LKR {fmt(hints.tce_incl_vat_mn)} Mn · approving committee required: <b>{hints.suggested_committee}</b>
            {hints.min_bidding_days ? <> · minimum bidding period: <b>{hints.min_bidding_days} days</b> (Sec. 6.3)</> : null}
            {hints.shopping_authority ? <> · Shopping authority: <b>{hints.shopping_authority}</b></> : null}</div>
          {hints.annex && <div>Annex {hints.annex.annex}: bidding stage max {hints.annex.maxWeeks} weeks, compulsory {hints.annex.compulsoryWeeks} weeks.</div>}
          {hints.warnings.length > 0 && <ul className="warnlist">{hints.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          {hints.schedule && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer' }}>Draft milestone schedule</summary>
              <table style={{ marginTop: 6 }}><tbody>
                {lookups.milestones.map(m => <tr key={m.key}><td className="wrap">{m.label}</td><td>{hints.schedule[m.key] && hints.schedule[m.key].scheduled}</td></tr>)}
              </tbody></table>
              <div className="hint" style={{ marginTop: 6 }}>Lead times are planning defaults; the schedule can be adjusted on the Execution page as revised dates once the plan is approved.</div>
            </details>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="primary" type="submit" disabled={busy}>{editing ? 'Save item' : 'Add to plan'}</button>
        <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
