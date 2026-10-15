const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const progress = require('../progress');
const { requireRole } = require('../middleware/auth');
const { wrap, isWide, inScope } = require('../util');
const lib = require('../planLib');
const { loadReminderDays } = require('./lookups');
const { availability } = require('./budgets');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (iso, t) => rules.diffDays(t, iso);
const r2 = n => Math.round(n * 100) / 100;
const incl = i => rules.tceInclVat(i.tce_excl_vat_mn, i.vat_pct);

// Statutory / periodic calendar (Manual Chapter 4 and Section 2.2(1)(g)).
function deadlinesFor(t) {
  const year = Number(t.slice(0, 4));
  const out = [];
  const nextJan = `${t.slice(5) > '01-31' ? year + 1 : year}-01-31`;
  out.push({ label: 'Consolidated MPP and DAPP to NPC (before end of January)', date: nextJan, days: daysUntil(nextJan, t) });
  for (const [q, end] of [[1, `${year}-03-31`], [2, `${year}-06-30`], [3, `${year}-09-30`], [4, `${year}-12-31`]]) {
    if (end >= t) { out.push({ label: `Quarterly Procurement Performance Report - Q${q} ${year} (quarter end)`, date: end, days: daysUntil(end, t) }); break; }
  }
  const halfEnd = t.slice(5) <= '06-30' ? `${year}-06-30` : `${year}-12-31`;
  out.push({ label: 'Bi-annual plan revision window (half-year end)', date: halfEnd, days: daysUntil(halfEnd, t) });
  return out;
}

// Items in approved/frozen plans whose planned start is near (or past) and whose execution has not yet
// been requested (or was returned). These drive the reminder to the requesting department.
async function loadReminders(user, t) {
  const lead = await loadReminderDays();
  const [rows] = await pool.query(`${lib.ITEM_SELECT} JOIN plans p ON p.fy = i.plan_fy
    WHERE p.status IN ('approved','frozen') AND i.status = 'planned' AND i.exec_status IN ('not_requested','returned')
      AND i.procurement_start IS NOT NULL ORDER BY i.procurement_start`);
  const limit = rules.addDays(t, lead);
  return {
    lead_days: lead,
    items: rows.filter(i => i.procurement_start <= limit && inScope(user, i.department_id, i.sub_unit_id))
      .map(i => ({ id: i.id, ref_no: i.ref_no, title: i.title, department: i.department, sub_unit: i.sub_unit, method: i.method, plan_fy: i.plan_fy,
        procurement_start: i.procurement_start, days_to_start: daysUntil(i.procurement_start, t), exec_status: i.exec_status, tce_incl_vat_mn: r2(incl(i)) }))
  };
}

async function annualItems(fy, user) {
  const plan = await lib.getPlan(fy);
  const status = plan ? plan.status : 'planning';
  const all = (await lib.loadItems(fy)).filter(i => i.year_offset === 0);
  const items = isWide(user) ? all : await lib.visibleItems(user, all);
  return { plan, status, items };
}

router.get('/', wrap(async (req, res) => {
  const t = today();
  const fy = Number(req.query.plan_fy) || Number(t.slice(0, 4)) + 1;
  const wide = isWide(req.user);
  const scopeSql = wide ? '' : ' WHERE department_id = ?' + (req.user.role === 'requester' && req.user.sub_unit_id ? ' AND sub_unit_id = ?' : '');
  const scopeParams = wide ? [] : [req.user.department_id, ...(req.user.role === 'requester' && req.user.sub_unit_id ? [req.user.sub_unit_id] : [])];

  // The same scope as an "AND ..." clause on the requests table aliased r.
  const rScope = wide ? '' : ' AND r.department_id = ?' + (scopeParams.length > 1 ? ' AND r.sub_unit_id = ?' : '');

  const [reqCounts] = await pool.query(`SELECT status, COUNT(*) AS n FROM requests${scopeSql} GROUP BY status`, scopeParams);
  const [planRows] = await pool.query('SELECT fy, status, version FROM plans ORDER BY fy DESC LIMIT 5');
  const [toAuthorise] = await pool.query("SELECT COUNT(*) AS n FROM requests WHERE status = 'submitted' AND department_id = ?", [req.user.department_id || 0]);
  const [toPlan] = await pool.query(`SELECT COUNT(*) AS n FROM requests r LEFT JOIN plan_items i ON i.request_id = r.id AND i.recur_index = 0 WHERE r.status = 'authorised' AND i.id IS NULL${rScope}`, scopeParams);
  const [planSubmitted] = await pool.query("SELECT COUNT(*) AS n FROM plans WHERE status = 'submitted'");
  const [revSubmitted] = await pool.query("SELECT COUNT(*) AS n FROM plan_revisions WHERE status = 'submitted'");
  const [execPending] = await pool.query(
    `SELECT COUNT(*) AS n FROM execution_requests e JOIN plan_items i ON i.id = e.plan_item_id JOIN requests r ON r.id = i.request_id WHERE e.status = 'pending'${rScope}`, scopeParams);

  const [changeToAuthorise] = await pool.query(
    `SELECT COUNT(*) AS n FROM change_requests c JOIN plan_items i ON i.id = c.plan_item_id JOIN requests r ON r.id = i.request_id
     WHERE c.status = 'submitted' AND r.department_id = ?`, [req.user.department_id || 0]);
  const [changePending] = await pool.query(
    `SELECT COUNT(*) AS n FROM change_requests c JOIN plan_items i ON i.id = c.plan_item_id JOIN requests r ON r.id = i.request_id WHERE c.status = 'pending'${rScope}`, scopeParams);

  // Department users: everything of theirs still waiting on someone (themselves, their head or procurement).
  let pending = null;
  if (!wide) {
    const [reqs] = await pool.query(
      `SELECT r.id, r.ref_no, r.title, r.status, r.review_comment, r.updated_at, r.expense_type FROM requests r
       LEFT JOIN plan_items pi ON pi.request_id = r.id AND pi.recur_index = 0
       WHERE (r.status IN ('draft','submitted','returned') OR (r.status = 'authorised' AND pi.id IS NULL))${rScope}
       ORDER BY r.updated_at DESC`, scopeParams);
    const [execs] = await pool.query(
      `SELECT e.id, e.plan_item_id, ${lib.ITEM_REF} AS ref_no, i.title, e.status, e.decision_comment, e.created_at, e.decided_at, i.procurement_start
       FROM execution_requests e JOIN plan_items i ON i.id = e.plan_item_id JOIN requests r ON r.id = i.request_id
       WHERE (e.status = 'pending' OR (e.status = 'returned' AND i.exec_status = 'returned'))${rScope}
       ORDER BY e.created_at DESC`, scopeParams);
    // Change requests still open, plus recent outcomes (returned, or decided by management) from the last 30 days.
    const [changes] = await pool.query(
      `SELECT c.id, c.action, c.status, c.reason, c.decision_comment, c.created_at, c.decided_at, ${lib.ITEM_REF} AS ref_no, i.title,
              v.id AS revision_id, v.status AS revision_status, v.decided_at AS revision_decided_at, v.decision_comment AS revision_comment
       FROM change_requests c JOIN plan_items i ON i.id = c.plan_item_id JOIN requests r ON r.id = i.request_id LEFT JOIN plan_revisions v ON v.id = c.revision_id
       WHERE (c.status IN ('submitted','pending') OR (c.status = 'included' AND (v.status IN ('draft','submitted') OR v.decided_at >= NOW() - INTERVAL 30 DAY))
              OR (c.status = 'returned' AND c.decided_at >= NOW() - INTERVAL 30 DAY))${rScope}
       ORDER BY c.created_at DESC`, scopeParams);
    pending = { requests: reqs, execution_requests: execs, change_requests: changes };
  }

  // Progress of the selected cycle's annual plan (department users: their own unit's items).
  const { status: planStatus, items } = await annualItems(fy, req.user);
  const tracking = ['approved', 'frozen'].includes(planStatus);
  const prog = tracking ? {
    overall: progress.summarise(items, t),
    by_department: wide ? progress.groupSummaries(items, t, i => i.department) : [],
    by_category: progress.groupSummaries(items, t, i => i.category)
  } : null;

  const delayed = items.filter(i => tracking && progress.isOverdue(i, t))
    .map(i => ({ id: i.id, ref_no: i.ref_no, title: i.title, department: i.department, ...lib.delaySummary(i, t) }))
    .sort((a, b) => b.max_overdue_days - a.max_overdue_days);

  res.json({
    today: t, role: req.user.role, plan_fy: fy, plan_status: planStatus,
    requests: Object.fromEntries(reqCounts.map(r => [r.status, r.n])),
    plans: planRows,
    todo: { to_authorise: toAuthorise[0].n, to_plan: toPlan[0].n, plans_awaiting_approval: planSubmitted[0].n, revisions_awaiting_approval: revSubmitted[0].n, execution_requests_pending: execPending[0].n, change_requests_pending: changePending[0].n, change_requests_to_authorise: changeToAuthorise[0].n },
    progress: prog, pending,
    supplies: req.user.role !== 'executive' && await require('./lookups').canViewSupplies(req.user) ? await require('./supplies').dashboardCounts(req.user) : null,
    reminders: await loadReminders(req.user, t),
    delayed: delayed.slice(0, 10), delayed_count: delayed.length,
    deadlines: deadlinesFor(t)
  });
}));

// Board / CEO view: read-only, whole-company summary of the selected plan cycle.
router.get('/board', requireRole('admin', 'management', 'executive', 'procurement'), wrap(async (req, res) => {
  const t = today();
  const fy = Number(req.query.plan_fy) || Number(t.slice(0, 4)) + 1;
  const plan = (await lib.getPlan(fy)) || { fy, status: 'planning', version: 0 };
  const all = (await lib.loadItems(fy)).filter(i => i.status !== 'cancelled');
  const annual = all.filter(i => i.year_offset === 0);
  const tracking = ['approved', 'frozen'].includes(plan.status);

  const overall = progress.summarise(annual, t);
  const byDivision = progress.groupSummaries(annual, t, i => i.division || 'Unassigned');
  const byDepartment = progress.groupSummaries(annual, t, i => i.department);
  const threeYear = r2(all.reduce((s, i) => s + incl(i), 0));
  const byYear = [0, 1, 2].map(o => ({ year: fy + o, count: all.filter(i => i.year_offset === o).length, value: r2(all.filter(i => i.year_offset === o).reduce((s, i) => s + incl(i), 0)) }));

  const byMethod = progress.groupSummaries(annual, t, i => i.method || 'Not assigned').map(m => ({ name: m.name, count: m.count, value: m.value }));
  const byCommittee = progress.groupSummaries(annual, t, i => i.committee_level || 'Not assigned').map(m => ({ name: m.name, count: m.count, value: m.value }));

  const row = i => {
    const p = progress.itemProgress(i, t);
    const d = lib.delaySummary(i, t);
    return { id: i.id, ref_no: i.ref_no, title: i.title, department: i.department, division: i.division, method: i.method, committee: i.committee_level,
      value: r2(incl(i)), status: i.status, actual_pct: Math.round(p.actual), expected_pct: Math.round(p.expected),
      overdue_days: d.max_overdue_days, overdue_milestone: d.overdue[0] ? d.overdue[0].label : null, start: i.procurement_start, delivery: i.expected_delivery };
  };
  const topValue = [...annual].sort((a, b) => incl(b) - incl(a)).slice(0, 10).map(row);
  const delayed = tracking ? annual.filter(i => progress.isOverdue(i, t)).map(row).sort((a, b) => b.overdue_days - a.overdue_days).slice(0, 10) : [];

  const [depts] = await pool.query('SELECT d.id, v.name AS division FROM departments d LEFT JOIN divisions v ON v.id = d.division_id');
  const divOf = new Map(depts.map(d => [d.id, d.division || 'Unassigned']));
  const budgetByDiv = new Map();
  for (const d of await availability(fy)) {
    const k = divOf.get(d.department_id) || 'Unassigned';
    const b = budgetByDiv.get(k) || { name: k, allocated: 0, committed: 0 };
    b.allocated += d.allocated; b.committed += d.committed; budgetByDiv.set(k, b);
  }

  const [reqCounts] = await pool.query('SELECT status, COUNT(*) AS n FROM requests WHERE plan_fy = ? GROUP BY status', [fy]);
  const [[execPending]] = await pool.query("SELECT COUNT(*) AS n FROM execution_requests WHERE status = 'pending'");
  const [[revPending]] = await pool.query("SELECT COUNT(*) AS n FROM plan_revisions WHERE status = 'submitted'");
  const reminders = await loadReminders({ role: 'admin' }, t);

  res.json({
    today: t, plan_fy: fy, plan, tracking,
    headline: { ...overall, annual_value: overall.value, three_year_value: threeYear, savings: r2(overall.awarded_estimate - overall.awarded_value) },
    by_year: byYear, by_division: byDivision, by_department: byDepartment, by_method: byMethod, by_committee: byCommittee,
    top_value: topValue, delayed,
    budget: [...budgetByDiv.values()].map(b => ({ ...b, allocated: r2(b.allocated), committed: r2(b.committed) })).sort((a, b) => b.committed - a.committed),
    pipeline: { requests: Object.fromEntries(reqCounts.map(r => [r.status, r.n])), execution_requests_pending: execPending.n, revisions_pending: revPending.n, starting_soon_without_request: reminders.items.length },
    deadlines: deadlinesFor(t)
  });
}));

module.exports = router;
