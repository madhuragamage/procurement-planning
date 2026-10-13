const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, audit, tx, isWide, inScope } = require('../util');
const lib = require('../planLib');
const bids = require('../bids');

const router = express.Router();
const PROC = ['procurement', 'admin'];

const SELECT = `
  SELECT e.*, u.name AS requested_by_name, dcd.name AS decided_by_name,
         i.title, i.plan_fy, i.year_offset, i.method, i.bid_no, i.bid_type, i.procurement_start, i.expected_delivery, i.tce_excl_vat_mn, i.vat_pct,
         ${lib.ITEM_REF} AS ref_no, r.department_id, r.sub_unit_id, d.name AS department, su.name AS sub_unit
  FROM execution_requests e
  JOIN plan_items i ON i.id = e.plan_item_id
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN sub_units su ON su.id = r.sub_unit_id
  JOIN users u ON u.id = e.requested_by
  LEFT JOIN users dcd ON dcd.id = e.decided_by`;

router.get('/', wrap(async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('e.status = ?'); params.push(String(req.query.status)); }
  const [rows] = await pool.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC`, params);
  res.json(isWide(req.user) ? rows : rows.filter(r => inScope(req.user, r.department_id, r.sub_unit_id)));
}));

// A department asks the procurement unit to start executing an item that is already in the approved
// plan. The procurement unit itself may raise one on a department's behalf; that is accepted at once.
router.post('/', requireRole('requester', 'dept_head', ...PROC), wrap(async (req, res) => {
  const itemId = Number(req.body.plan_item_id);
  if (!Number.isInteger(itemId)) throw new HttpError(400, 'plan_item_id is required.');
  const note = optString(req.body.note, 500);
  const onBehalf = PROC.includes(req.user.role);
  const id = await tx(async conn => {
    const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [itemId]);
    const full = cur && await lib.loadItem(itemId, conn);
    if (!full || (!onBehalf && !inScope(req.user, full.department_id, full.sub_unit_id))) throw new HttpError(404, 'Plan item not found.');
    const plan = await lib.getPlan(full.plan_fy, conn);
    if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, 'Execution can be requested once management has approved the plan.');
    if (full.status !== 'planned') throw new HttpError(409, 'This procurement has already started or finished.');
    if (full.exec_status === 'requested') throw new HttpError(409, 'An execution request is already waiting for the procurement unit.');
    if (full.exec_status === 'accepted') throw new HttpError(409, 'Execution has already been accepted by the procurement unit.');

    const [ins] = await conn.query(
      'INSERT INTO execution_requests (plan_item_id, requested_by, note, on_behalf, status, decided_by, decided_at) VALUES (?,?,?,?,?,?,?)',
      [itemId, req.user.id, note, onBehalf ? 1 : 0, onBehalf ? 'accepted' : 'pending', onBehalf ? req.user.id : null, onBehalf ? new Date() : null]);
    await conn.query('UPDATE plan_items SET exec_status = ? WHERE id = ?', [onBehalf ? 'accepted' : 'requested', itemId]);
    const bidNo = onBehalf ? await bids.assign(conn, itemId, req.body.bid_type) : null;
    await audit(conn, 'plan_item', itemId, onBehalf ? 'execution-started' : 'execution-requested', req.user.id, [bidNo && `bid ${bidNo}`, note].filter(Boolean).join(' — ') || null);
    return ins.insertId;
  });
  const [[row]] = await pool.query(`${SELECT} WHERE e.id = ?`, [id]);
  res.status(201).json(row);
}));

async function decide(req, res, { to, action, needsComment }) {
  const comment = optString(req.body.comment, 500);
  if (needsComment && !comment) throw new HttpError(400, 'Tell the department what is missing or why it cannot proceed yet.');
  await tx(async conn => {
    const [[e]] = await conn.query('SELECT * FROM execution_requests WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!e) throw new HttpError(404, 'Execution request not found.');
    if (e.status !== 'pending') throw new HttpError(409, 'That request has already been decided.');
    await conn.query('UPDATE execution_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_comment = ? WHERE id = ?', [to, req.user.id, comment, e.id]);
    await conn.query('UPDATE plan_items SET exec_status = ? WHERE id = ?', [to, e.plan_item_id]);
    // Starting execution classes the procurement as a tender or quotation and gives it its bid number.
    const bidNo = to === 'accepted' ? await bids.assign(conn, e.plan_item_id, req.body.bid_type) : null;
    await audit(conn, 'plan_item', e.plan_item_id, action, req.user.id, [bidNo && `bid ${bidNo}`, comment].filter(Boolean).join(' — ') || null);
    return bidNo;
  }).then(bidNo => res.json({ ok: true, bid_no: bidNo }));
}

// Bid number for an item whose execution was accepted before bid numbers existed.
router.post('/bid-number/:itemId', requireRole(...PROC), wrap(async (req, res) => {
  const bidNo = await tx(async conn => {
    const [[it]] = await conn.query('SELECT exec_status, bid_no FROM plan_items WHERE id = ?', [Number(req.params.itemId)]);
    if (!it) throw new HttpError(404, 'Plan item not found.');
    if (it.exec_status !== 'accepted') throw new HttpError(409, 'A bid number is given when execution is accepted.');
    if (it.bid_no) throw new HttpError(409, `This procurement already has bid number ${it.bid_no}.`);
    const no = await bids.assign(conn, Number(req.params.itemId), req.body.bid_type);
    await audit(conn, 'plan_item', req.params.itemId, 'bid-number', req.user.id, no);
    return no;
  });
  res.json({ ok: true, bid_no: bidNo });
}));

router.post('/:id/accept', requireRole(...PROC), wrap((req, res) => decide(req, res, { to: 'accepted', action: 'execution-accepted' })));
router.post('/:id/return', requireRole(...PROC), wrap((req, res) => decide(req, res, { to: 'returned', action: 'execution-returned', needsComment: true })));

module.exports = router;
