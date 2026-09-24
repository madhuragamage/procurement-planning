const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, oneOf, audit, tx } = require('../util');
const lib = require('../planLib');
const rules = require('../rules');
const { loadLimits } = require('./lookups');

const router = express.Router();
const PROC = ['procurement', 'admin'];

async function loadRevision(id, conn) {
  const [rows] = await (conn || pool).query(
    `SELECT v.*, u.name AS created_by_name, dcd.name AS decided_by_name FROM plan_revisions v
     JOIN users u ON u.id = v.created_by LEFT JOIN users dcd ON dcd.id = v.decided_by WHERE v.id = ?`, [id]);
  return rows[0] || null;
}

async function loadChanges(revisionId, conn) {
  const [rows] = await (conn || pool).query(
    `SELECT ch.*, i.title AS item_title, r.ref_no AS item_ref FROM revision_changes ch
     LEFT JOIN plan_items i ON i.id = ch.item_id LEFT JOIN requests r ON r.id = i.request_id WHERE ch.revision_id = ? ORDER BY ch.id`, [revisionId]);
  return rows;
}

router.get('/', wrap(async (req, res) => {
  const params = []; let where = '';
  if (req.query.plan_fy) { where = 'WHERE v.plan_fy = ?'; params.push(Number(req.query.plan_fy)); }
  const [rows] = await pool.query(
    `SELECT v.*, u.name AS created_by_name, (SELECT COUNT(*) FROM revision_changes c WHERE c.revision_id = v.id) AS change_count
     FROM plan_revisions v JOIN users u ON u.id = v.created_by ${where} ORDER BY v.id DESC`, params);
  res.json(rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const v = await loadRevision(Number(req.params.id));
  if (!v) throw new HttpError(404, 'Revision not found.');
  res.json({ ...v, changes: await loadChanges(v.id) });
}));

router.post('/', requireRole(...PROC), wrap(async (req, res) => {
  const fy = Number(req.body.plan_fy);
  if (!Number.isInteger(fy)) throw new HttpError(400, 'plan_fy is required.');
  const plan = await lib.getPlan(fy);
  if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, `Revisions apply to an approved plan; the ${fy} plan is ${plan ? plan.status.replace('_', ' ') : 'not started'}.`);
  const [r] = await pool.query('INSERT INTO plan_revisions (plan_fy, kind, title, justification, created_by) VALUES (?,?,?,?,?)',
    [fy, oneOf(req.body.kind || 'bi_annual', ['bi_annual', 'urgent'], 'Kind'), reqString(req.body.title, 'Title'), optString(req.body.justification), req.user.id]);
  await audit(null, 'revision', r.insertId, 'create', req.user.id, req.body.title);
  res.status(201).json(await loadRevision(r.insertId));
}));

async function draftRevision(req) {
  const v = await loadRevision(Number(req.params.id));
  if (!v) throw new HttpError(404, 'Revision not found.');
  if (v.status !== 'draft') throw new HttpError(409, 'Only draft revisions can be changed.');
  return v;
}

router.post('/:id/changes', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  const action = oneOf(req.body.action, ['add', 'modify', 'cancel'], 'Action');
  const reason = optString(req.body.reason, 1000);
  let itemId = null; let payload = {};
  if (action === 'add') {
    const requestId = Number(req.body.request_id);
    const [[r]] = await pool.query('SELECT id, status, plan_fy, ref_no FROM requests WHERE id = ?', [requestId]);
    if (!r) throw new HttpError(404, 'Request not found.');
    if (r.status !== 'authorised') throw new HttpError(409, 'Only department-head-authorised requests can be added.');
    if (r.plan_fy !== v.plan_fy) throw new HttpError(400, `Request ${r.ref_no} belongs to the ${r.plan_fy} plan cycle.`);
    const [[dupe]] = await pool.query('SELECT id FROM plan_items WHERE request_id = ?', [requestId]);
    if (dupe) throw new HttpError(409, 'That request is already in the plan.');
    payload = { request_id: requestId, ...req.body.payload };
    lib.parseItemFields(payload); // validate now so bad data cannot reach approval
    if (!reason) throw new HttpError(400, 'Give a reason for adding this item.');
  } else {
    itemId = Number(req.body.item_id);
    const item = await lib.loadItem(itemId);
    if (!item || item.plan_fy !== v.plan_fy) throw new HttpError(404, 'Plan item not found in this plan.');
    if (item.status === 'cancelled') throw new HttpError(409, 'That item is already cancelled.');
    if (!reason) throw new HttpError(400, 'Give a reason for this change.');
    if (action === 'modify') {
      payload = req.body.payload || {};
      if (!Object.keys(lib.parseItemFields(payload)).length) throw new HttpError(400, 'Nothing to modify.');
    }
  }
  const [r] = await pool.query('INSERT INTO revision_changes (revision_id, item_id, action, payload, reason) VALUES (?,?,?,?,?)',
    [v.id, itemId, action, JSON.stringify(payload), reason]);
  res.status(201).json({ id: r.insertId });
}));

router.delete('/:id/changes/:cid', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  await pool.query('DELETE FROM revision_changes WHERE id = ? AND revision_id = ?', [Number(req.params.cid), v.id]);
  res.json({ ok: true });
}));

router.post('/:id/submit', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  const changes = await loadChanges(v.id);
  if (!changes.length) throw new HttpError(400, 'Add at least one change before submitting.');
  await pool.query("UPDATE plan_revisions SET status = 'submitted', submitted_at = NOW() WHERE id = ?", [v.id]);
  await audit(null, 'revision', v.id, 'submit', req.user.id, null);
  res.json({ ok: true });
}));

router.post('/:id/reject', requireRole('management'), wrap(async (req, res) => {
  const v = await loadRevision(Number(req.params.id));
  if (!v || v.status !== 'submitted') throw new HttpError(409, 'Only a submitted revision can be rejected.');
  const comment = optString(req.body.comment, 1000);
  if (!comment) throw new HttpError(400, 'A comment is required.');
  await pool.query("UPDATE plan_revisions SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_comment = ? WHERE id = ?", [req.user.id, comment, v.id]);
  await audit(null, 'revision', v.id, 'reject', req.user.id, comment);
  res.json({ ok: true });
}));

// Approval applies every change atomically, bumps the plan version and stores a snapshot.
router.post('/:id/approve', requireRole('management'), wrap(async (req, res) => {
  const limits = await loadLimits();
  const version = await tx(async conn => {
    const [[v]] = await conn.query('SELECT * FROM plan_revisions WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!v || v.status !== 'submitted') throw new HttpError(409, 'Only a submitted revision can be approved.');
    const [[plan]] = await conn.query('SELECT * FROM plans WHERE fy = ? FOR UPDATE', [v.plan_fy]);
    if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, 'The plan is not in an approved state.');
    const changes = await loadChanges(v.id, conn);
    for (const ch of changes) {
      if (ch.action === 'add') {
        const created = await lib.createItem(conn, ch.payload.request_id, ch.payload, req.user.id, limits, { viaRevision: true });
        await audit(conn, 'plan_item', created.id, 'revision-add', req.user.id, `revision #${v.id}: ${ch.reason}`);
      } else if (ch.action === 'modify') {
        const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [ch.item_id]);
        if (!cur || cur.status === 'cancelled') throw new HttpError(409, `Item #${ch.item_id} can no longer be modified.`);
        const f = lib.parseItemFields(ch.payload);
        const merged = { ...cur, ...f };
        if (merged.procurement_start && (f.procurement_start !== undefined || f.expected_delivery !== undefined || f.method !== undefined)) {
          const incl = rules.tceInclVat(merged.tce_excl_vat_mn, merged.vat_pct);
          f.milestones = JSON.stringify(lib.mergeSchedule(cur.milestones, rules.buildSchedule({ start: merged.procurement_start, delivery: merged.expected_delivery, method: merged.method, tceInclMn: incl })));
        }
        const cols = Object.keys(f);
        await conn.query(`UPDATE plan_items SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), cur.id]);
        await audit(conn, 'plan_item', cur.id, 'revision-modify', req.user.id, `revision #${v.id}: ${ch.reason}`);
      } else {
        await conn.query("UPDATE plan_items SET status = 'cancelled', remarks = CONCAT(COALESCE(remarks, ''), IF(remarks IS NULL OR remarks = '', '', ' | '), ?) WHERE id = ?", [`Cancelled by revision #${v.id}: ${ch.reason}`, ch.item_id]);
        await audit(conn, 'plan_item', ch.item_id, 'revision-cancel', req.user.id, `revision #${v.id}: ${ch.reason}`);
      }
    }
    const newVersion = plan.version + 1;
    await conn.query('UPDATE plans SET version = ? WHERE fy = ?', [newVersion, v.plan_fy]);
    await conn.query("UPDATE plan_revisions SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_comment = ?, applied_version = ? WHERE id = ?",
      [req.user.id, optString(req.body.comment, 1000), newVersion, v.id]);
    await lib.snapshotPlan(conn, v.plan_fy, `Revision #${v.id}: ${v.title}`, req.user.id);
    await audit(conn, 'revision', v.id, 'approve', req.user.id, optString(req.body.comment, 1000));
    return newVersion;
  });
  res.json({ ok: true, version });
}));

module.exports = router;
