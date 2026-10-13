import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from './ui.jsx';
import { fmt, YEAR_LABELS, FUNDING_LABEL, recurYears, phasingLabel } from '../lib/format.js';

const pick = (s, fy) => ({
  title: s.title || '', tce_excl_vat_mn: s.tce_excl_vat_mn, vat_pct: s.vat_pct, funding_source: s.funding_source, funding_agency: s.funding_agency || '',
  year_offset: s.year_offset, method: s.method || '', bidding_procedure: s.bidding_procedure || '', prequalification: !!s.prequalification,
  committee_level: s.committee_level || '', procurement_start: s.procurement_start || '', expected_delivery: s.expected_delivery || '', remarks: s.remarks || '',
  regenerate_schedule: false, plan_fy: s.plan_fy ?? fy
});

// How to choose the start and delivery dates: work back from the department's required date by the
// steps this method and value need, with a one-click "use these dates".
function DateGuidance({ g, hasMethod, onUse }) {
  return (
    <div className="hintbox" style={{ marginBottom: 12, borderLeft: `4px solid ${g.feasible === false ? 'var(--bad)' : 'var(--accent-2)'}` }}>
      <div className="between">
        <div><b>Setting the dates</b> — department needs it by <b>{g.required_date || 'no date given'}</b>{!hasMethod && ' · choose a method for a more accurate estimate'}</div>
        <button type="button" className="mini plain" onClick={onUse}>use start {g.start} · delivery {g.delivery}</button>
      </div>
      <div style={{ marginTop: 6, color: g.feasible === false ? 'var(--bad)' : 'inherit' }}>{g.note}</div>
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer' }}>How this is worked out ({g.total_days} days end to end)</summary>
        <table style={{ marginTop: 6 }}><tbody>
          {g.steps.map(s => <tr key={s.label}><td className="wrap">{s.label}</td><td style={{ textAlign: 'right' }}>{s.days} d</td></tr>)}
        </tbody></table>
        <div className="hint" style={{ marginTop: 6 }}>
          1. Pick the method from the value and category (the checks below confirm the committee and Shopping limits). 2. Count back from the required date by the steps above to get the latest start date. 3. If that date has passed, start as soon as possible and agree the later delivery date with the department. Bidding periods follow Section 6.3; the other durations are planning defaults that can be adjusted.
        </div>
      </details>
    </div>
  );
}

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
        procurement_start: f.procurement_start, expected_delivery: f.expected_delivery, required_date: source.required_date || ''
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
      {phasingLabel(source) && <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>Budget phased over years: {phasingLabel(source)} of the value.</div>}
      {source.recurrence === 'recurrent' && (
        <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
          {editing
            ? (source.recur_index > 0
              ? `Projected repeat ${source.recur_index} of a recurrent need (+${Number(source.annual_increase_pct)}% per year). Edit it independently of the original item.`
              : `Recurrent need (+${Number(source.annual_increase_pct)}% per year). Its projected repeats in later years are separate items; edit them on their own. Removing this item removes them too.`)
            : (Number(f.year_offset) < 2
              ? <>Recurrent annually (+{Number(source.annual_increase_pct)}% per year). Adding it also creates tentative items for {recurYears(f.tce_excl_vat_mn, f.vat_pct, source.annual_increase_pct, Number(f.year_offset)).slice(1).map(y => `${Number(source.plan_fy) + y.offset} (LKR ${fmt(y.incl)} Mn)`).join(' and ')}, with start and delivery dates moved on by a year each.</>
              : 'Recurrent annually, but this is the last year of the cycle, so no repeats are added.')}
        </div>
      )}
      <label className="field"><span>Title</span><input type="text" value={f.title} onChange={e => set('title', e.target.value)} required /></label>
      <div className="grid g4">
        <label className="field"><span>TCE excl. VAT (LKR Mn)</span>
          <input type="number" step="any" min="0" value={f.tce_excl_vat_mn} onChange={e => set('tce_excl_vat_mn', e.target.value)} required /></label>
        <label className="field"><span>VAT %</span>
          <input type="number" step="any" min="0" max="100" value={f.vat_pct} onChange={e => set('vat_pct', e.target.value)} /></label>
        <label className="field"><span>Funding</span>
          <select value={f.funding_source} onChange={e => set('funding_source', e.target.value)}>{lookups.fundingSources.map(x => <option key={x} value={x}>{FUNDING_LABEL[x]}</option>)}</select></label>
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
      {hints && hints.guidance && <DateGuidance g={hints.guidance} hasMethod={!!f.method} onUse={() => setF(p => ({ ...p, procurement_start: hints.guidance.start, expected_delivery: hints.guidance.delivery, regenerate_schedule: editing || p.regenerate_schedule }))} />}
      <div className="grid g4">
        <label className="field"><span>Procurement start</span><input type="date" value={f.procurement_start} onChange={e => set('procurement_start', e.target.value)} /></label>
        <label className="field"><span>Expected delivery / completion</span><input type="date" value={f.expected_delivery} onChange={e => set('expected_delivery', e.target.value)} /></label>
        {editing && <label className="chk" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.regenerate_schedule} onChange={e => set('regenerate_schedule', e.target.checked)} /> Re-draft milestone dates from these dates</label>}
      </div>
      {hints && hints.guidance && hints.guidance.delivery_vs_required_days > 0 && (
        <div className="error-banner">Expected delivery is {hints.guidance.delivery_vs_required_days} days after the date the department requested ({hints.guidance.required_date}). Explain why in Remarks — the department sees it in the "Expected dates" report.</div>
      )}
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
