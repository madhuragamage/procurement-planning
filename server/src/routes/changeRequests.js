const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, oneOf, audit, tx, isWide, inScope } = require('../util');
const lib = require('../planLib');

const router = express.Router();
const PROC = ['procurement', 'admin'];
// What a department may propose for its own item; method and committee stay with the procurement unit.
const DEPT_FIELDS = ['tce_excl_vat_mn', 'year_offset', 'procurement_start', 'expected_delivery', 'remarks'];

const SELECT = `
  SELECT cr.*, u.name AS requested_by_name, dcd.name AS decided_by_name, au.name AS authorised_by_name, v.status AS revision_status, v.title AS revision_title,
         i.title, i.plan_fy, i.year_offset, i.tce_excl_vat_mn, i.vat_pct, i.procurement_start, i.expected_delivery, i.status AS item_status,
         ${lib.ITEM_REF} AS ref_no, r.department_id, r.sub_unit_id, r.expense_type, d.name AS department, su.name AS sub_unit
  FROM change_requests cr
  JOIN plan_items i ON i.id = cr.plan_item_id
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN sub_units su ON su.id = r.sub_unit_id
  JOIN users u ON u.id = cr.requested_by
  LEFT JOIN users dcd ON dcd.id = cr.decided_by
  LEFT JOIN users au ON au.id = cr.authorised_by
  LEFT JOIN plan_revisions v ON v.id = cr.revision_id`;

router.get('/', wrap(async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('cr.status = ?'); params.push(String(req.query.status)); }
  if (req.query.plan_fy) { where.push('i.plan_fy = ?'); params.push(Number(req.query.plan_fy)); }
  const [rows] = await pool.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cr.id DESC`, params);
  res.json(isWide(req.user) ? rows : rows.filter(r => inScope(req.user, r.department_id, r.sub_unit_id)));
}));

// A department asks for one of its approved-plan items to be modified or cancelled. A department user's
// request first goes to their department head; a head's own request goes straight to procurement.
router.post('/',requireRole('requester', 'dept_head'), wrap(async (req, res) => {
  const itemId = Number(req.body.plan_item_id);
  const item = Number.isInteger(itemId) && await lib.loadItem(itemId);
  if (!item || !inScope(req.user, item.department_id, item.sub_unit_id)) throw new HttpError(404, 'Plan item not found.');
  const plan = await lib.getPlan(item.plan_fy);
  if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, 'Changes can be requested once management has approved the plan.');
  if (item.status === 'cancelled') throw new HttpError(409, 'That item is already cancelled.');
  const action = oneOf(req.body.action, ['modify', 'cancel'], 'Action');
  const reason = optString(req.body.reason, 1000);
  if (!reason) throw new HttpError(400, 'Give the reason for this change.');
  let payload = null;
  if (action === 'modify') {
    const raw = {};
    for (const k of DEPT_FIELDS) if (req.body.payload && req.body.payload[k] !== undefined && req.body.payload[k] !== '') raw[k] = req.body.payload[k];
    payload = lib.parseItemFields(raw);
    if (!Object.keys(payload).length) throw new HttpError(400, 'Enter at least one value to change.');
  }
  const [[open]] = await pool.query(
    `SELECT cr.id FROM change_requests cr LEFT JOIN plan_revisions v ON v.id = cr.revision_id
     WHERE cr.plan_item_id = ? AND (cr.status IN ('submitted','pending') OR (cr.status = 'included' AND v.status IN ('draft','submitted')))`, [itemId]);
  if (open) throw new HttpError(409, 'A change request for this item is already in progress.');
  const head = req.user.role === 'dept_head';
  const [r] = await pool.query('INSERT INTO change_requests (plan_item_id, action, payload, reason, requested_by, status, authorised_by, authorised_at) VALUES (?,?,?,?,?,?,?,?)',
    [itemId, action, payload && JSON.stringify(payload), reason, req.user.id, head ? 'pending' : 'submitted', head ? req.user.id : null, head ? new Date() : null]);
  await audit(null, 'plan_item', itemId, `change-requested-${action}`, req.user.id, reason);
  const [[row]] = await pool.query(`${SELECT} WHERE cr.id = ?`, [r.insertId]);
  res.status(201).json(row);
}));

// Department head authorisation, for their department and all its sub units.
async function headDecision(req, res, approve) {
  const comment = optString(req.body.comment, 500);
  if (!approve && !comment) throw new HttpError(400, 'Tell the requester what to change or why it cannot go ahead.');
  await tx(async conn => {
    const [[cr]] = await conn.query(
      'SELECT cr.*, r.department_id FROM change_requests cr JOIN plan_items i ON i.id = cr.plan_item_id JOIN requests r ON r.id = i.request_id WHERE cr.id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!cr) throw new HttpError(404, 'Change request not found.');
    if (req.user.role !== 'admin' && cr.department_id !== req.user.department_id) throw new HttpError(403, 'You can only authorise your own department\'s requests.');
    if (cr.status !== 'submitted') throw new HttpError(409, 'That change request is not waiting for authorisation.');
    if (approve) {
      await conn.query("UPDATE change_requests SET status = 'pending', authorised_by = ?, authorised_at = NOW(), decision_comment = ? WHERE id = ?", [req.user.id, comment, cr.id]);
    } else {
      await conn.query("UPDATE change_requests SET status = 'returned', decided_by = ?, decided_at = NOW(), decision_comment = ? WHERE id = ?", [req.user.id, comment, cr.id]);
    }
    await audit(conn, 'plan_item', cr.plan_item_id, approve ? 'change-request-authorised' : 'change-request-returned-by-head', req.user.id, comment);
  });
  res.json({ ok: true });
}
router.post('/:id/authorise', requireRole('dept_head', 'admin'), wrap((req, res) => headDecision(req, res, true)));
router.post('/:id/return-to-requester', requireRole('dept_head', 'admin'), wrap((req, res) => headDecision(req, res, false)));

async function pendingRequest(conn, id) {
  const [[cr]] = await conn.query('SELECT * FROM change_requests WHERE id = ? FOR UPDATE', [id]);
  if (!cr) throw new HttpError(404, 'Change request not found.');
  if (cr.status === 'submitted') throw new HttpError(409, 'That change request has not been authorised by the department head yet.');
  if (cr.status !== 'pending') throw new HttpError(409, 'That change request has already been dealt with.');
  return cr;
}

// The procurement unit puts the request into one of its draft revisions, unchanged.
router.post('/:id/include', requireRole(...PROC), wrap(async (req, res) => {
  await tx(async conn => {
    const cr = await pendingRequest(conn, Number(req.params.id));
    const [[v]] = await conn.query('SELECT * FROM plan_revisions WHERE id = ? FOR UPDATE', [Number(req.body.revision_id)]);
    const [[item]] = await conn.query('SELECT plan_fy, status FROM plan_items WHERE id = ?', [cr.plan_item_id]);
    if (!v || v.status !== 'draft') throw new HttpError(409, 'Choose a draft revision.');
    if (v.plan_fy !== item.plan_fy) throw new HttpError(400, `That revision is for the ${v.plan_fy} plan; this item is in the ${item.plan_fy} plan.`);
    if (item.status === 'cancelled') throw new HttpError(409, 'That item is already cancelled.');
    const [[clash]] = await conn.query("SELECT id FROM revision_changes WHERE revision_id = ? AND item_id = ? AND action = 'cancel'", [v.id, cr.plan_item_id]);
    if (clash) throw new HttpError(409, 'That revision already cancels this item.');
    await conn.query('INSERT INTO revision_changes (revision_id, item_id, action, payload, reason, change_request_id) VALUES (?,?,?,?,?,?)',
      [v.id, cr.plan_item_id, cr.action, JSON.stringify(cr.payload || {}), `Department request: ${cr.reason}`, cr.id]);
    await conn.query("UPDATE change_requests SET status = 'included', revision_id = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [v.id, req.user.id, cr.id]);
    await audit(conn, 'plan_item', cr.plan_item_id, 'change-request-included', req.user.id, `revision #${v.id}`);
  });
  res.json({ ok: true });
}));

router.post('/:id/return', requireRole(...PROC), wrap(async (req, res) => {
  const comment = optString(req.body.comment, 500);
  if (!comment) throw new HttpError(400, 'Tell the department why the change is not being taken forward.');
  await tx(async conn => {
    const cr = await pendingRequest(conn, Number(req.params.id));
    await conn.query("UPDATE change_requests SET status = 'returned', decided_by = ?, decided_at = NOW(), decision_comment = ? WHERE id = ?", [req.user.id, comment, cr.id]);
    await audit(conn, 'plan_item', cr.plan_item_id, 'change-request-returned', req.user.id, comment);
  });
  res.json({ ok: true });
}));

module.exports = router;
module.exports.DEPT_FIELDS = DEPT_FIELDS;
