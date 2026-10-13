const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { wrap, HttpError, isWide } = require('../util');
const lib = require('../planLib');
const { availability } = require('./budgets');
const phasing = require('../phasing');

const router = express.Router();

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const incl = it => rules.tceInclVat(it.tce_excl_vat_mn, it.vat_pct);
const money = { align: 'right' };
const YEAR_LABELS = fy => [`${fy} (Annual)`, `${fy + 1} (Tentative)`, `${fy + 2} (Tentative)`];
const TYPE_ORDER = { goods: 0, works: 1, services: 2 };
const TYPE_LABEL = { goods: 'Goods', works: 'Works', services: 'Non-consulting services' };

async function meta(fy) {
  const plan = await lib.getPlan(fy);
  const [org] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  return { org: org.length ? org[0].value.name : '', fy, plan_status: plan ? plan.status : 'planning', plan_version: plan ? plan.version : 0, generated_at: new Date().toISOString() };
}

const filters = (items, q) => items.filter(i =>
  (!q.department_id || i.department_id === Number(q.department_id)) &&
  (!q.category_id || i.category_id === Number(q.category_id)) &&
  (!q.expense_type || i.expense_type === q.expense_type));

// "2026: 40% · 2027: 60%" for a phased item, '' when the whole value falls in the start year.
const phasingLabel = (it, fy) => phasing.span(it.budget_phasing) > 1
  ? it.budget_phasing.map((p, k) => `${fy + it.year_offset + k}: ${p}%`).join(' · ') : '';

const recurLabel = it => it.recurrence === 'recurrent' ? `Recurrent (+${Number(it.annual_increase_pct)}%/yr)` : 'One time';

function totalsRow(rows, keys, label = 'Total') {
  const t = { _total: true, title: label };
  for (const k of keys) t[k] = r2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  return t;
}

const base = it => ({
  ref_no: it.ref_no, title: it.title, department: it.department, division: it.division || '', sub_unit: it.sub_unit || '', reason: it.reason + (it.reason_note ? ` (${it.reason_note})` : ''), category: it.category, type: TYPE_LABEL[it.manual_type],
  expense: it.expense_type, recurrence: recurLabel(it),
  method: it.method || '', committee: it.committee_level || '', funding: it.funding_source + (it.funding_agency ? ` (${it.funding_agency})` : ''),
  tce_excl: r2(it.tce_excl_vat_mn), tce_incl: r2(incl(it)), start: it.procurement_start || '', delivery: it.expected_delivery || ''
});

const BUILDERS = {
  async mpp(items, q, fy) {
    // Year columns show the budget needed in each year: a phased item is spread from its start year.
    const rows = items.map((it, n) => {
      const b = base(it); const v = incl(it);
      const col = o => { const s = phasing.share(it.budget_phasing, o - it.year_offset); return s ? r2(v * s) : null; };
      const later = [3, 4].reduce((s, o) => s + v * phasing.share(it.budget_phasing, o - it.year_offset), 0);
      return { no: n + 1, ...b, vat: r2(v - it.tce_excl_vat_mn), phasing: phasingLabel(it, fy), y0: col(0), y1: col(1), y2: col(2), later: later ? r2(later) : null };
    });
    const y = YEAR_LABELS(fy);
    const hasLater = rows.some(r => r.later);
    return {
      title: `Master Procurement Plan ${fy}-${fy + 2} (Annex I format)`, subtitle: 'Three-year rolling plan; year 1 is the annual plan, years 2-3 are tentative. Year columns show the budget required in each year (phased procurements are spread over their years). Values in LKR million.',
      columns: [{ key: 'no', label: 'No.' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Description of procurement' }, { key: 'department', label: 'Department' }, { key: 'sub_unit', label: 'Sub unit' }, { key: 'type', label: 'Type' }, { key: 'category', label: 'Category' }, { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'recurrence', label: 'Recurrence' }, { key: 'reason', label: 'Reason' },
        { key: 'method', label: 'Method' }, { key: 'committee', label: 'Committee' }, { key: 'funding', label: 'Funding' }, { key: 'tce_excl', label: 'TCE excl. VAT', ...money }, { key: 'vat', label: 'VAT', ...money }, { key: 'tce_incl', label: 'TCE incl. VAT', ...money },
        { key: 'phasing', label: 'Budget phasing' }, { key: 'y0', label: y[0], ...money }, { key: 'y1', label: y[1], ...money }, { key: 'y2', label: y[2], ...money },
        ...(hasLater ? [{ key: 'later', label: `After ${fy + 2}`, ...money }] : []), { key: 'start', label: 'Procurement start' }, { key: 'delivery', label: 'Expected delivery' }],
      rows: [...rows, totalsRow(rows, ['tce_excl', 'vat', 'tce_incl', 'y0', 'y1', 'y2', 'later'])]
    };
  },

  async appp(items, q, fy) {
    const rows = items.filter(i => i.year_offset === 0).map((it, n) => ({
      no: n + 1, ...base(it), procedure: it.bidding_procedure || '', pq: it.prequalification ? 'Yes' : 'No', priority: { U: 'Urgent', P: 'Priority', N: 'Normal' }[it.priority]
    }));
    return {
      title: `Annual Procurement Plan ${fy} (Annex II format)`, subtitle: 'Procurement planned for the coming financial year. Values in LKR million.',
      columns: [{ key: 'no', label: 'No.' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Description' }, { key: 'department', label: 'Department' }, { key: 'sub_unit', label: 'Sub unit' }, { key: 'type', label: 'Type' }, { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'recurrence', label: 'Recurrence' }, { key: 'reason', label: 'Reason' }, { key: 'method', label: 'Method' }, { key: 'procedure', label: 'Procedure' }, { key: 'pq', label: 'PQ' },
        { key: 'committee', label: 'Committee' }, { key: 'funding', label: 'Funding' }, { key: 'priority', label: 'Priority' }, { key: 'tce_excl', label: 'TCE excl. VAT', ...money }, { key: 'tce_incl', label: 'TCE incl. VAT', ...money }, { key: 'start', label: 'Start' }, { key: 'delivery', label: 'Delivery' }],
      rows: [...rows, totalsRow(rows, ['tce_excl', 'tce_incl'])]
    };
  },

  // One year of the cycle on its own (the annual year or one tentative year), grouped CAPEX then OPEX.
  async 'year-plan'(items, q, fy) {
    const offset = q.year_offset === undefined || q.year_offset === '' ? 0 : Number(q.year_offset);
    if (![0, 1, 2].includes(offset)) throw new HttpError(400, 'year_offset must be 0, 1 or 2.');
    const year = fy + offset;
    const order = (a, b) => a.expense_type.localeCompare(b.expense_type) || a.department.localeCompare(b.department) || a.id - b.id;
    const row = it => ({
      no: ++n, ...base(it), vat: r2(incl(it) - it.tce_excl_vat_mn), procedure: it.bidding_procedure || '', phasing: phasingLabel(it, fy),
      priority: { U: 'Urgent', P: 'Priority', N: 'Normal' }[it.priority], budget_year: r2(incl(it) * phasing.share(it.budget_phasing, offset - it.year_offset))
    });
    const keys = ['tce_excl', 'vat', 'tce_incl', 'budget_year'];
    const rows = []; let n = 0;
    for (const type of ['CAPEX', 'OPEX']) {
      const part = items.filter(i => i.year_offset === offset && i.expense_type === type).sort(order).map(row);
      if (part.length) rows.push(...part, totalsRow(part, keys, `Subtotal ${type} — starting in ${year}`));
    }
    // Phased procurements started in an earlier year of this cycle that still need budget in this year.
    const continuing = items.filter(i => i.year_offset < offset && phasing.share(i.budget_phasing, offset - i.year_offset) > 0).sort(order).map(row);
    if (continuing.length) rows.push(...continuing, totalsRow(continuing, keys, `Subtotal — continuing from earlier years`));
    rows.push(totalsRow(rows.filter(r => !r._total), keys, `Total ${year}`));
    return {
      title: `Procurement plan for ${year}${offset === 0 ? ' (annual plan)' : ` (tentative, ${fy}-${fy + 2} cycle)`}`,
      subtitle: `Procurements planned to start in ${year}, grouped by CAPEX and OPEX, followed by phased procurements started earlier in the cycle that still need budget in ${year}. "Required in ${year}" is the budget share for that year. Values in LKR million.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Description of procurement' }, { key: 'department', label: 'Department' }, { key: 'sub_unit', label: 'Sub unit' },
        { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'category', label: 'Category' }, { key: 'reason', label: 'Reason' }, { key: 'recurrence', label: 'Recurrence' },
        { key: 'method', label: 'Method' }, { key: 'procedure', label: 'Procedure' }, { key: 'committee', label: 'Committee' }, { key: 'funding', label: 'Funding' }, { key: 'priority', label: 'Priority' },
        { key: 'tce_excl', label: 'TCE excl. VAT', ...money }, { key: 'vat', label: 'VAT', ...money }, { key: 'tce_incl', label: 'TCE incl. VAT', ...money },
        { key: 'phasing', label: 'Budget phasing' }, { key: 'budget_year', label: `Required in ${year}`, ...money }, { key: 'start', label: 'Start' }, { key: 'delivery', label: 'Delivery' }],
      rows, landscape: true
    };
  },

  // For requesting departments: when the procurement unit expects to start and deliver each of their
  // procurements, against the date they asked for.
  async 'expected-dates'(items, q, fy) {
    const sel = [...items].filter(i => i.status !== 'cancelled')
      .sort((a, b) => a.department.localeCompare(b.department) || (a.sub_unit || '').localeCompare(b.sub_unit || '') || (a.procurement_start || '9').localeCompare(b.procurement_start || '9') || a.id - b.id);
    const counts = { on_time: 0, late: 0, no_date: 0, unscheduled: 0 };
    const rows = sel.map((it, n) => {
      const ms = it.milestones || {};
      const target = (ms.completion && (ms.completion.revised || ms.completion.scheduled)) || it.expected_delivery || '';
      let variance = '';
      if (!target) { variance = 'Not scheduled yet'; counts.unscheduled += 1; }
      else if (!it.required_date) { variance = 'No date requested'; counts.no_date += 1; }
      else {
        const d = rules.diffDays(it.required_date, target);
        if (d > 0) { variance = `${d} days later than requested`; counts.late += 1; }
        else { variance = d === 0 ? 'On the requested date' : `${-d} days before the requested date`; counts.on_time += 1; }
      }
      const award = ms.contract_award || {};
      return {
        no: n + 1, department: it.department, sub_unit: it.sub_unit || '', bid_no: it.bid_no || '', ref_no: it.ref_no, title: it.title, year: YEAR_LABELS(fy)[it.year_offset],
        method: it.method || '', required: it.required_date || '', start: it.procurement_start || '', award: award.revised || award.scheduled || '',
        delivery: target, variance, execution: { not_requested: 'Not requested', requested: 'Requested', accepted: 'In execution', returned: 'Returned' }[it.exec_status] || '',
        status: it.status.replace('_', ' '), remarks: it.remarks || ''
      };
    });
    return {
      title: `Expected procurement dates ${fy}-${fy + 2} — for requesting departments`,
      subtitle: 'Planned procurement start, contract award and delivery / completion dates set by the procurement unit, against the date each department requested. Revised dates recorded during execution replace the original schedule. Send an execution request before the planned start date.',
      columns: [{ key: 'no', label: 'No.' }, { key: 'department', label: 'Department' }, { key: 'sub_unit', label: 'Sub unit' }, { key: 'bid_no', label: 'Bid No' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Procurement' },
        { key: 'year', label: 'Plan year' }, { key: 'method', label: 'Method' }, { key: 'required', label: 'Requested by department' }, { key: 'start', label: 'Planned start' },
        { key: 'award', label: 'Expected contract award' }, { key: 'delivery', label: 'Expected delivery / completion' }, { key: 'variance', label: 'Against request' },
        { key: 'execution', label: 'Execution' }, { key: 'status', label: 'Status' }, { key: 'remarks', label: 'Remarks' }],
      rows, landscape: true,
      summary: [
        { label: 'Procurements', value: sel.length }, { label: 'On or before the requested date', value: counts.on_time },
        { label: 'Later than requested', value: counts.late }, { label: 'Not scheduled yet / no date requested', value: counts.unscheduled + counts.no_date }
      ]
    };
  },

  async dapp(items, q, fy) {
    const sel = items.filter(i => i.year_offset === 0 && i.status !== 'cancelled')
      .sort((a, b) => TYPE_ORDER[a.manual_type] - TYPE_ORDER[b.manual_type] || a.id - b.id);
    const rows = [];
    for (const it of sel) {
      for (const [kind, label] of [['scheduled', 'Schedule'], ['revised', 'Revised'], ['actual', 'Actual']]) {
        const row = { ref_no: kind === 'scheduled' ? it.ref_no : '', title: kind === 'scheduled' ? it.title : '', type: kind === 'scheduled' ? TYPE_LABEL[it.manual_type] : '', kind: label };
        for (const m of rules.MILESTONES) row[m.key] = (it.milestones && it.milestones[m.key] && it.milestones[m.key][kind]) || '';
        rows.push(row);
      }
    }
    return {
      title: `Detailed Annual Procurement Plan ${fy} (Annex III format)`, subtitle: 'Schedule, revised and actual dates per procurement milestone, grouped by Goods, Works and Non-consulting services.',
      columns: [{ key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Procurement' }, { key: 'type', label: 'Type' }, { key: 'kind', label: '' }, ...rules.MILESTONES.map(m => ({ key: m.key, label: m.label }))],
      rows, landscape: true
    };
  },

  // Items whose procurement starts in the first quarter, so preparatory work can begin before the annual plan cycle completes.
  async preparatory(items, q, fy) {
    const cutoff = `${fy}-03-31`;
    const rows = items.filter(i => i.year_offset === 0 && i.procurement_start && i.procurement_start <= cutoff).map((it, n) => ({
      no: n + 1, ...base(it), procedure: it.bidding_procedure || ''
    }));
    return {
      title: `Preparatory Procurement Plan ${fy} (Annex VI format)`, subtitle: `Procurements whose start date falls on or before ${cutoff}, so preparatory activities can begin early. Values in LKR million.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Description' }, { key: 'department', label: 'Department' }, { key: 'method', label: 'Method' }, { key: 'procedure', label: 'Procedure' },
        { key: 'committee', label: 'Committee' }, { key: 'tce_incl', label: 'TCE incl. VAT', ...money }, { key: 'start', label: 'Start' }, { key: 'delivery', label: 'Delivery' }],
      rows: [...rows, totalsRow(rows, ['tce_incl'])]
    };
  },

  async 'by-category'(items, q, fy) {
    const sorted = [...items].sort((a, b) => a.category.localeCompare(b.category) || a.year_offset - b.year_offset || a.id - b.id);
    const rows = []; let cur = null; let bucket = [];
    const flush = () => { if (cur !== null) rows.push(totalsRow(bucket, ['tce_incl'], `Subtotal - ${cur}`)); bucket = []; };
    for (const it of sorted) {
      if (it.category !== cur) { flush(); cur = it.category; }
      const row = { ...base(it), year: YEAR_LABELS(fy)[it.year_offset] };
      bucket.push(row); rows.push(row);
    }
    flush();
    rows.push(totalsRow(sorted.map(base), ['tce_incl'], 'Grand total'));
    return {
      title: `Procurement plan ${fy}-${fy + 2} by category`, subtitle: 'Category-wise listing with subtotals. Values in LKR million.',
      columns: [{ key: 'category', label: 'Category' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Description' }, { key: 'department', label: 'Department' }, { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'year', label: 'Plan year' }, { key: 'method', label: 'Method' }, { key: 'tce_incl', label: 'TCE incl. VAT', ...money }, { key: 'start', label: 'Start' }, { key: 'delivery', label: 'Delivery' }],
      rows
    };
  },

  async 'dept-category'(items, q, fy) {
    const cats = [...new Set(items.map(i => i.category))].sort();
    const depts = [...new Set(items.map(i => i.department))].sort();
    const rows = depts.map(d => {
      const row = { department: d, count: 0, total: 0 };
      for (const c of cats) row['c_' + c] = 0;
      for (const it of items.filter(i => i.department === d)) { row['c_' + it.category] += incl(it); row.total += incl(it); row.count += 1; }
      for (const k of Object.keys(row)) if (k.startsWith('c_') || k === 'total') row[k] = r2(row[k]);
      return row;
    });
    const tot = { _total: true, department: 'Total', count: rows.reduce((s, r) => s + r.count, 0), total: r2(rows.reduce((s, r) => s + r.total, 0)) };
    for (const c of cats) tot['c_' + c] = r2(rows.reduce((s, r) => s + r['c_' + c], 0));
    return {
      title: `Department x category summary ${fy}-${fy + 2}`, subtitle: 'TCE incl. VAT in LKR million across the three plan years.',
      columns: [{ key: 'department', label: 'Department' }, { key: 'count', label: 'Items', ...money }, ...cats.map(c => ({ key: 'c_' + c, label: c, ...money })), { key: 'total', label: 'Total', ...money }],
      rows: [...rows, tot]
    };
  },

  async 'by-division'(items, q, fy) {
    const groups = new Map();
    for (const it of items) {
      const k = (it.division || 'Unassigned') + '|' + it.department;
      const g = groups.get(k) || { division: it.division || 'Unassigned', department: it.department, count: 0, total: 0 };
      g.count += 1; g.total += incl(it); groups.set(k, g);
    }
    const rows = [...groups.values()].map(g => ({ ...g, total: r2(g.total) })).sort((a, b) => a.division.localeCompare(b.division) || a.department.localeCompare(b.department));
    return {
      title: `Summary by division and department ${fy}-${fy + 2}`, subtitle: 'LKR million incl. VAT across the three plan years.',
      columns: [{ key: 'division', label: 'Division' }, { key: 'department', label: 'Department' }, { key: 'count', label: 'Items', ...money }, { key: 'total', label: 'TCE incl. VAT', ...money }],
      rows: [...rows, { _total: true, division: 'Total', count: rows.reduce((s, r) => s + r.count, 0), total: r2(rows.reduce((s, r) => s + r.total, 0)) }]
    };
  },

  async 'by-method'(items, q, fy) {
    const groups = new Map();
    for (const it of items) { const k = it.method || '(not assigned)'; const g = groups.get(k) || { method: k, count: 0, total: 0 }; g.count += 1; g.total += incl(it); groups.set(k, g); }
    const rows = [...groups.values()].map(g => ({ ...g, total: r2(g.total) })).sort((a, b) => b.total - a.total);
    return { title: `Summary by procurement method ${fy}-${fy + 2}`, subtitle: 'LKR million incl. VAT.', columns: [{ key: 'method', label: 'Method' }, { key: 'count', label: 'Items', ...money }, { key: 'total', label: 'TCE incl. VAT', ...money }], rows: [...rows, { _total: true, method: 'Total', count: rows.reduce((s, r) => s + r.count, 0), total: r2(rows.reduce((s, r) => s + r.total, 0)) }] };
  },

  async 'by-committee'(items, q, fy) {
    const groups = new Map();
    for (const it of items) { const k = it.committee_level || '(not assigned)'; const g = groups.get(k) || { committee: k, count: 0, total: 0 }; g.count += 1; g.total += incl(it); groups.set(k, g); }
    const rows = [...groups.values()].map(g => ({ ...g, total: r2(g.total) }));
    return { title: `Summary by approving committee ${fy}-${fy + 2}`, subtitle: 'LKR million incl. VAT.', columns: [{ key: 'committee', label: 'Committee' }, { key: 'count', label: 'Items', ...money }, { key: 'total', label: 'TCE incl. VAT', ...money }], rows: [...rows, { _total: true, committee: 'Total', count: rows.reduce((s, r) => s + r.count, 0), total: r2(rows.reduce((s, r) => s + r.total, 0)) }] };
  },

  // Quarterly Procurement Performance Report (Manual Section 2.2(1)(g)) for the line ministry.
  async performance(items, q, fy) {
    const quarter = Number(q.quarter) || 1;
    if (quarter < 1 || quarter > 4) throw new HttpError(400, 'quarter must be 1-4.');
    const qEnd = [`${fy}-03-31`, `${fy}-06-30`, `${fy}-09-30`, `${fy}-12-31`][quarter - 1];
    const today = new Date().toISOString().slice(0, 10);
    const asOf = qEnd < today ? qEnd : today;
    const sel = items.filter(i => i.year_offset === 0 && i.procurement_start && i.procurement_start <= qEnd);
    const rows = sel.map((it, n) => {
      const ms = it.milestones || {};
      const award = ms.contract_award || {}; const comp = ms.completion || {};
      const d = lib.delaySummary(it, asOf);
      const delay = Math.max(d.max_overdue_days, d.max_slippage_days);
      return {
        no: n + 1, bid_no: it.bid_no || '', ref_no: it.ref_no, title: it.title, department: it.department, method: it.method || '',
        tce_incl: r2(incl(it)), planned_award: award.scheduled || '', actual_award: award.actual || '', contractor: it.contractor || '',
        award_value: it.award_value_mn == null ? null : r2(it.award_value_mn), planned_completion: comp.revised || comp.scheduled || '', actual_completion: comp.actual || '',
        status: it.status.replace('_', ' '), delay_days: delay || '', remarks: it.remarks || ''
      };
    });
    const count = s => sel.filter(i => i.status === s).length;
    const awardTotal = sel.reduce((s, i) => s + (i.award_value_mn || 0), 0);
    const estAwarded = sel.filter(i => i.award_value_mn != null).reduce((s, i) => s + incl(i), 0);
    return {
      title: `Quarterly Procurement Performance Report - Q${quarter} ${fy}`, subtitle: `Position as at ${asOf}. Progress against the ${fy} Detailed Annual Procurement Plan. Values in LKR million.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'bid_no', label: 'Bid No' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Procurement' }, { key: 'department', label: 'Department' }, { key: 'method', label: 'Method' }, { key: 'tce_incl', label: 'Estimate incl. VAT', ...money },
        { key: 'planned_award', label: 'Planned award' }, { key: 'actual_award', label: 'Actual award' }, { key: 'contractor', label: 'Supplier / contractor' }, { key: 'award_value', label: 'Award value', ...money },
        { key: 'planned_completion', label: 'Planned completion' }, { key: 'actual_completion', label: 'Actual completion' }, { key: 'status', label: 'Status' }, { key: 'delay_days', label: 'Delay (days)', ...money }, { key: 'remarks', label: 'Remarks' }],
      rows, landscape: true,
      summary: [
        { label: 'Procurements due to have started', value: sel.length },
        { label: 'Planned', value: count('planned') }, { label: 'In progress', value: count('in_progress') }, { label: 'Awarded', value: count('awarded') },
        { label: 'Completed', value: count('completed') }, { label: 'Cancelled', value: count('cancelled') },
        { label: 'Delayed', value: rows.filter(r => r.delay_days).length },
        { label: 'Estimate of awarded items (LKR Mn)', value: r2(estAwarded) }, { label: 'Total award value (LKR Mn)', value: r2(awardTotal) }
      ]
    };
  }
};

router.get('/budget', wrap(async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year)) throw new HttpError(400, 'year is required.');
  const data = (await availability(year)).filter(d => isWide(req.user) || d.department_id === req.user.department_id);
  const types = ['CAPEX', 'OPEX'].filter(t => !req.query.expense_type || t === req.query.expense_type);
  const rows = []; const keys = ['allocated', 'committed', 'pipeline', 'remaining'];
  for (const type of types) {
    const part = data.map(d => d[type.toLowerCase()]).map((t, n) => t && (t.allocated || t.committed || t.pipeline)
      ? { department: data[n].department, expense: type, ...t, state: t.over_budget ? 'OVER BUDGET' : 'OK' } : null).filter(Boolean);
    rows.push(...part, { ...totalsRow(part, keys, `Total ${type}`), department: `Total ${type}` });
  }
  if (types.length > 1) rows.push({ ...totalsRow(rows.filter(r => !r._total), keys, 'Grand total'), department: 'Grand total' });
  res.json({
    meta: await meta(year), title: `Budget availability ${year}`, subtitle: 'CAPEX and OPEX allocations are tracked separately. Committed = planned items (incl. VAT) scheduled for this budget year; pipeline = authorised requests not yet planned (recurrent ones in each later year). LKR million.',
    columns: [{ key: 'department', label: 'Department' }, { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'allocated', label: 'Allocated', ...money }, { key: 'committed', label: 'Committed', ...money }, { key: 'pipeline', label: 'Pipeline', ...money }, { key: 'remaining', label: 'Remaining', ...money }, { key: 'state', label: '' }],
    rows
  });
}));

router.get('/:type', wrap(async (req, res) => {
  const builder = BUILDERS[req.params.type];
  if (!builder) throw new HttpError(404, 'Unknown report.');
  const fy = Number(req.query.plan_fy);
  if (!Number.isInteger(fy)) throw new HttpError(400, 'plan_fy is required.');
  const all = await lib.visibleItems(req.user, await lib.loadItems(fy));
  const items = filters(all.filter(i => i.status !== 'cancelled' || req.params.type === 'performance'), req.query);
  const out = await builder(items, req.query, fy);
  res.json({ meta: await meta(fy), ...out });
}));

module.exports = router;
