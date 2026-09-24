const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { wrap } = require('../util');
const lib = require('../planLib');

const router = express.Router();

function daysUntil(iso, today) { return rules.diffDays(today, iso); }

router.get('/', wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const wide = ['admin', 'procurement', 'management'].includes(req.user.role);
  const deptFilter = wide ? '' : ' WHERE department_id = ?';
  const deptParams = wide ? [] : [req.user.department_id];

  const [reqCounts] = await pool.query(`SELECT status, COUNT(*) AS n FROM requests${deptFilter} GROUP BY status`, deptParams);
  const [planRows] = await pool.query('SELECT fy, status, version FROM plans ORDER BY fy DESC LIMIT 5');
  const [itemCounts] = await pool.query('SELECT status, COUNT(*) AS n FROM plan_items GROUP BY status');

  const [toAuthorise] = await pool.query("SELECT COUNT(*) AS n FROM requests WHERE status = 'submitted' AND department_id = ?", [req.user.department_id || 0]);
  const [toPlan] = await pool.query("SELECT COUNT(*) AS n FROM requests r LEFT JOIN plan_items i ON i.request_id = r.id WHERE r.status = 'authorised' AND i.id IS NULL");
  const [planSubmitted] = await pool.query("SELECT COUNT(*) AS n FROM plans WHERE status = 'submitted'");
  const [revSubmitted] = await pool.query("SELECT COUNT(*) AS n FROM plan_revisions WHERE status = 'submitted'");

  // Delayed items across approved plans (year 1 of each cycle).
  const [items] = await pool.query(`${lib.ITEM_SELECT} JOIN plans p ON p.fy = i.plan_fy WHERE p.status IN ('approved','frozen') AND i.status NOT IN ('completed','cancelled')`);
  const delayed = items.map(i => ({ id: i.id, ref_no: i.ref_no, title: i.title, department: i.department, ...lib.delaySummary(i, today) }))
    .filter(d => d.overdue.length).sort((a, b) => b.max_overdue_days - a.max_overdue_days);

  // Statutory / periodic calendar (Manual Chapter 4 and Section 2.2(1)(g)).
  const deadlines = [];
  const nextJan = `${today.slice(5) > '01-31' ? year + 1 : year}-01-31`;
  deadlines.push({ label: 'Consolidated MPP and DAPP to NPC (before end of January)', date: nextJan, days: daysUntil(nextJan, today) });
  for (const [q, end] of [[1, `${year}-03-31`], [2, `${year}-06-30`], [3, `${year}-09-30`], [4, `${year}-12-31`]]) {
    if (end >= today) { deadlines.push({ label: `Quarterly Procurement Performance Report - Q${q} ${year} (quarter end)`, date: end, days: daysUntil(end, today) }); break; }
  }
  const halfEnd = today.slice(5) <= '06-30' ? `${year}-06-30` : `${year}-12-31`;
  deadlines.push({ label: 'Bi-annual plan revision window (half-year end)', date: halfEnd, days: daysUntil(halfEnd, today) });

  res.json({
    today, role: req.user.role,
    requests: Object.fromEntries(reqCounts.map(r => [r.status, r.n])),
    items: Object.fromEntries(itemCounts.map(r => [r.status, r.n])),
    plans: planRows,
    todo: { to_authorise: toAuthorise[0].n, to_plan: toPlan[0].n, plans_awaiting_approval: planSubmitted[0].n, revisions_awaiting_approval: revSubmitted[0].n },
    delayed: delayed.slice(0, 10), delayed_count: delayed.length,
    deadlines
  });
}));

module.exports = router;
