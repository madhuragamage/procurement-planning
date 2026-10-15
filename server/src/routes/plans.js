const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, audit, tx, isWide } = require('../util');
const lib = require('../planLib');
const { loadLimits } = require('./lookups');
const { availability } = require('./budgets');

const router = express.Router();

function summarise(items) {
  const byYear = [0, 1, 2].map(o => ({ year_offset: o, count: 0, tce_incl_vat_mn: 0 }));
  for (const it of items) {
    if (it.status === 'cancelled') continue;
    const y = byYear[it.year_offset];
    y.count += 1;
    y.tce_incl_vat_mn += rules.tceInclVat(it.tce_excl_vat_mn, it.vat_pct);
  }
  byYear.forEach(y => { y.tce_incl_vat_mn = Math.round(y.tce_incl_vat_mn * 100) / 100; });
  return byYear;
}

function incompleteItems(items) {
  return items.filter(it => it.status !== 'cancelled' && (!it.method || !it.procurement_start || !it.expected_delivery))
    .map(it => ({ id: it.id, ref_no: it.ref_no, title: it.title, missing: [!it.method && 'method', !it.procurement_start && 'procurement start', !it.expected_delivery && 'expected delivery'].filter(Boolean) }));
}

router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM plan_items i WHERE i.plan_fy = p.fy) AS item_count FROM plans p ORDER BY p.fy DESC`);
  res.json(isWide(req.user) ? rows : rows.filter(p => ['approved', 'frozen'].includes(p.status)));
}));

router.get('/:fy', wrap(async (req, res) => {
  const fy = Number(req.params.fy);
  if (!Number.isInteger(fy)) throw new HttpError(400, 'Invalid year.');
  const plan = (await lib.getPlan(fy)) || { fy, status: 'planning', version: 0, review_comment: null, virtual: true };
  const allItems = await lib.loadItems(fy);
  if (!isWide(req.user)) {
    // Department users only see their own unit's items, and only once management has approved the plan.
    const mine = await lib.visibleItems(req.user, allItems);
    const approved = ['approved', 'frozen'].includes(plan.status);
    return res.json({
      plan: { fy: plan.fy, status: plan.status, version: plan.version, frozen_at: plan.frozen_at || null, restricted: true },
      summary: summarise(mine), incomplete: [], unplanned_authorised: 0, pending_revisions: 0, budget_warnings: [],
      item_count: mine.length, visible: approved
    });
  }
  const items = allItems;
  const [[pending]] = await pool.query(
    "SELECT COUNT(*) AS n FROM requests WHERE plan_fy = ? AND status = 'authorised' AND id NOT IN (SELECT request_id FROM plan_items)", [fy]);
  const [[revs]] = await pool.query("SELECT COUNT(*) AS n FROM plan_revisions WHERE plan_fy = ? AND status = 'submitted'", [fy]);

  // Budget warnings: any department over its allocation in any of the three plan years.
  const budgetWarnings = [];
  for (let o = 0; o < 3; o++) {
    for (const d of await availability(fy + o)) {
      for (const [type, t] of Object.entries(d.by_type)) {
        if (t.over_budget) budgetWarnings.push(`${d.department} ${fy + o} ${type}: committed LKR ${t.committed} Mn exceeds allocation LKR ${t.allocated} Mn`);
      }
    }
  }
  res.json({ plan, summary: summarise(items), incomplete: incompleteItems(items), unplanned_authorised: pending.n, pending_revisions: revs.n, budget_warnings: budgetWarnings, item_count: items.length });
}));

router.post('/:fy/submit', requireRole('procurement', 'admin'), wrap(async (req, res) => {
  const fy = Number(req.params.fy);
  await tx(async conn => {
    await lib.ensurePlan(fy, conn);
    const plan = await lib.getPlan(fy, conn);
    if (!lib.EDITABLE_STATES.includes(plan.status)) throw new HttpError(409, `The ${fy} plan is already ${plan.status.replace('_', ' ')}.`);
    const items = await lib.loadItems(fy, conn);
    if (!items.some(i => i.status !== 'cancelled')) throw new HttpError(400, 'Add at least one item before submitting the plan.');
    const bad = incompleteItems(items);
    if (bad.length) throw new HttpError(400, `${bad.length} item(s) still need a method and dates: ${bad.slice(0, 5).map(b => b.ref_no).join(', ')}${bad.length > 5 ? '...' : ''}`);
    await conn.query("UPDATE plans SET status = 'submitted', submitted_at = NOW(), review_comment = NULL WHERE fy = ?", [fy]);
    await audit(conn, 'plan', fy, 'submit', req.user.id, optString(req.body.comment, 1000));
  });
  res.json({ ok: true });
}));

router.post('/:fy/return', requireRole('management'), wrap(async (req, res) => {
  const fy = Number(req.params.fy);
  const comment = optString(req.body.comment, 2000);
  if (!comment) throw new HttpError(400, 'Describe the changes management requires.');
  await tx(async conn => {
    const plan = await lib.getPlan(fy, conn);
    if (!plan || plan.status !== 'submitted') throw new HttpError(409, 'Only a submitted plan can be returned.');
    await conn.query("UPDATE plans SET status = 'changes_requested', review_comment = ? WHERE fy = ?", [comment, fy]);
    await audit(conn, 'plan', fy, 'return', req.user.id, comment);
  });
  res.json({ ok: true });
}));

router.post('/:fy/approve', requireRole('management'), wrap(async (req, res) => {
  const fy = Number(req.params.fy);
  await tx(async conn => {
    const [[plan]] = await conn.query('SELECT * FROM plans WHERE fy = ? FOR UPDATE', [fy]);
    if (!plan || plan.status !== 'submitted') throw new HttpError(409, 'Only a submitted plan can be approved.');
    await conn.query("UPDATE plans SET status = 'approved', version = version + 1, approved_by = ?, approved_at = NOW(), review_comment = ? WHERE fy = ?",
      [req.user.id, optString(req.body.comment, 1000), fy]);
    await lib.snapshotPlan(conn, fy, 'Approved by management', req.user.id);
    await audit(conn, 'plan', fy, 'approve', req.user.id, optString(req.body.comment, 1000));
  });
  res.json({ ok: true });
}));

router.post('/:fy/freeze', requireRole('management', 'procurement', 'admin'), wrap(async (req, res) => {
  const fy = Number(req.params.fy);
  await tx(async conn => {
    const [[plan]] = await conn.query('SELECT * FROM plans WHERE fy = ? FOR UPDATE', [fy]);
    if (!plan || plan.status !== 'approved') throw new HttpError(409, 'Only an approved plan can be frozen.');
    await conn.query("UPDATE plans SET status = 'frozen', frozen_at = NOW() WHERE fy = ?", [fy]);
    await audit(conn, 'plan', fy, 'freeze', req.user.id, null);
  });
  res.json({ ok: true });
}));

router.get('/:fy/snapshots', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT s.id, s.fy, s.version, s.label, s.created_at, u.name AS created_by FROM plan_snapshots s LEFT JOIN users u ON u.id = s.created_by WHERE s.fy = ? ORDER BY s.id DESC', [Number(req.params.fy)]);
  res.json(rows);
}));

router.get('/:fy/snapshots/:id', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM plan_snapshots WHERE id = ? AND fy = ?', [Number(req.params.id), Number(req.params.fy)]);
  if (!rows.length) throw new HttpError(404, 'Snapshot not found.');
  res.json({ ...rows[0], data: JSON.parse(rows[0].data) });
}));

module.exports = router;
