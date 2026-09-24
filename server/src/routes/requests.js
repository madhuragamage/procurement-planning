const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, num, optDate, oneOf, audit, tx } = require('../util');

const router = express.Router();

const SELECT = `
  SELECT r.*, d.name AS department, c.name AS category, c.manual_type, u.name AS requested_by_name,
         a.name AS authorised_by_name, pi.id AS plan_item_id
  FROM requests r
  JOIN departments d ON d.id = r.department_id
  JOIN categories c ON c.id = r.category_id
  JOIN users u ON u.id = r.requested_by
  LEFT JOIN users a ON a.id = r.authorised_by
  LEFT JOIN plan_items pi ON pi.request_id = r.id`;

const WIDE_ROLES = ['admin', 'procurement', 'management'];

function canSee(user, r) { return WIDE_ROLES.includes(user.role) || r.department_id === user.department_id; }

async function getRequest(id) {
  const [rows] = await pool.query(`${SELECT} WHERE r.id = ?`, [id]);
  return rows[0] || null;
}

async function load(req) {
  const r = await getRequest(Number(req.params.id));
  if (!r || !canSee(req.user, r)) throw new HttpError(404, 'Request not found.');
  return r;
}

function parseBody(body, isProcurementOrAdmin, user) {
  const departmentId = isProcurementOrAdmin && body.department_id ? Number(body.department_id) : user.department_id;
  if (!Number.isInteger(departmentId)) throw new HttpError(400, 'Your account has no department.');
  const f = {
    department_id: departmentId,
    category_id: Number(body.category_id),
    title: reqString(body.title, 'Title'),
    description: optString(body.description),
    tce_excl_vat_mn: num(body.tce_excl_vat_mn, 'Estimated cost (excl. VAT)', { max: 1e7 }),
    vat_pct: body.vat_pct === undefined || body.vat_pct === '' ? 18 : num(body.vat_pct, 'VAT %', { max: 100 }),
    funding_source: oneOf(body.funding_source || 'GOSL', ['GOSL', 'Foreign'], 'Funding source'),
    funding_agency: optString(body.funding_agency, 120),
    priority: oneOf(body.priority || 'N', ['U', 'P', 'N'], 'Priority'),
    plan_fy: num(body.plan_fy, 'Planning year', { min: 2000, max: 2200 }),
    year_offset: num(body.year_offset === undefined || body.year_offset === '' ? 0 : body.year_offset, 'Year within plan', { min: 0, max: 2 }),
    required_date: optDate(body.required_date, 'Required date')
  };
  if (!Number.isInteger(f.category_id)) throw new HttpError(400, 'Category is required.');
  if (!Number.isInteger(f.plan_fy)) throw new HttpError(400, 'Planning year must be a whole year.');
  return f;
}

router.get('/', wrap(async (req, res) => {
  const where = []; const params = [];
  if (!WIDE_ROLES.includes(req.user.role)) { where.push('r.department_id = ?'); params.push(req.user.department_id); }
  if (req.query.status) { where.push('r.status = ?'); params.push(String(req.query.status)); }
  if (req.query.plan_fy) { where.push('r.plan_fy = ?'); params.push(Number(req.query.plan_fy)); }
  if (req.query.department_id && WIDE_ROLES.includes(req.user.role)) { where.push('r.department_id = ?'); params.push(Number(req.query.department_id)); }
  if (req.query.unplanned === '1') where.push('pi.id IS NULL');
  const [rows] = await pool.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`, params);
  res.json(rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const r = await load(req);
  const [history] = await pool.query(
    "SELECT a.action, a.comment, a.at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'request' AND a.entity_id = ? ORDER BY a.id", [String(r.id)]);
  res.json({ ...r, history });
}));

router.post('/', requireRole('requester', 'dept_head', 'procurement', 'admin'), wrap(async (req, res) => {
  const f = parseBody(req.body, ['procurement', 'admin'].includes(req.user.role), req.user);
  const id = await tx(async conn => {
    const tmp = 'TMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const [r] = await conn.query(
      `INSERT INTO requests (ref_no, department_id, category_id, title, description, tce_excl_vat_mn, vat_pct, funding_source, funding_agency, priority, plan_fy, year_offset, required_date, requested_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tmp, f.department_id, f.category_id, f.title, f.description, f.tce_excl_vat_mn, f.vat_pct, f.funding_source, f.funding_agency, f.priority, f.plan_fy, f.year_offset, f.required_date, req.user.id]);
    const [[dept]] = await conn.query('SELECT code FROM departments WHERE id = ?', [f.department_id]);
    const ref = `${dept.code}-${f.plan_fy}-${String(r.insertId).padStart(4, '0')}`;
    await conn.query('UPDATE requests SET ref_no = ? WHERE id = ?', [ref, r.insertId]);
    await audit(conn, 'request', r.insertId, 'create', req.user.id, null);
    return r.insertId;
  });
  res.status(201).json(await getRequest(id));
}));

router.put('/:id', wrap(async (req, res) => {
  const r = await load(req);
  if (!['draft', 'returned'].includes(r.status)) throw new HttpError(409, 'Only draft or returned requests can be edited.');
  const privileged = ['procurement', 'admin'].includes(req.user.role);
  if (!privileged && !['requester', 'dept_head'].includes(req.user.role)) throw new HttpError(403, 'Your role is not permitted to edit requests.');
  if (!privileged && r.department_id !== req.user.department_id) throw new HttpError(403, 'You can only edit your own department\'s requests.');
  const f = parseBody({ ...req.body, department_id: r.department_id }, false, { department_id: r.department_id });
  await pool.query(
    `UPDATE requests SET category_id=?, title=?, description=?, tce_excl_vat_mn=?, vat_pct=?, funding_source=?, funding_agency=?, priority=?, plan_fy=?, year_offset=?, required_date=? WHERE id=?`,
    [f.category_id, f.title, f.description, f.tce_excl_vat_mn, f.vat_pct, f.funding_source, f.funding_agency, f.priority, f.plan_fy, f.year_offset, f.required_date, r.id]);
  await audit(null, 'request', r.id, 'edit', req.user.id, null);
  res.json(await getRequest(r.id));
}));

router.delete('/:id', wrap(async (req, res) => {
  const r = await load(req);
  if (r.status !== 'draft') throw new HttpError(409, 'Only draft requests can be deleted.');
  if (!['admin'].includes(req.user.role) && r.requested_by !== req.user.id) throw new HttpError(403, 'Only the author can delete a draft.');
  await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['request', String(r.id)]);
  await pool.query('DELETE FROM requests WHERE id = ?', [r.id]);
  res.json({ ok: true });
}));

router.post('/:id/submit', requireRole('requester', 'dept_head', 'procurement', 'admin'), wrap(async (req, res) => {
  const r = await load(req);
  if (!['draft', 'returned'].includes(r.status)) throw new HttpError(409, 'Only draft or returned requests can be submitted.');
  if (!(r.tce_excl_vat_mn > 0)) throw new HttpError(400, 'Enter an estimated cost above zero before submitting.');
  if (!r.required_date) throw new HttpError(400, 'Enter the tentative required date before submitting.');
  await pool.query("UPDATE requests SET status = 'submitted', review_comment = NULL WHERE id = ?", [r.id]);
  await audit(null, 'request', r.id, 'submit', req.user.id, null);
  res.json(await getRequest(r.id));
}));

async function decide(req, res, next, { to, action, needsComment }) {
  const r = await load(req);
  if (r.status !== 'submitted') throw new HttpError(409, 'Only submitted requests can be reviewed.');
  if (req.user.role !== 'admin' && r.department_id !== req.user.department_id) throw new HttpError(403, 'You can only review your own department\'s requests.');
  const comment = optString(req.body.comment, 1000);
  if (needsComment && !comment) throw new HttpError(400, 'A comment is required.');
  if (to === 'authorised') {
    await pool.query("UPDATE requests SET status = 'authorised', authorised_by = ?, authorised_at = NOW(), review_comment = ? WHERE id = ?", [req.user.id, comment, r.id]);
  } else {
    await pool.query('UPDATE requests SET status = ?, review_comment = ? WHERE id = ?', [to, comment, r.id]);
  }
  await audit(null, 'request', r.id, action, req.user.id, comment);
  res.json(await getRequest(r.id));
}

// Department head authorisation (the brief's second workflow step).
router.post('/:id/authorise', requireRole('dept_head', 'admin'), wrap((req, res, next) => decide(req, res, next, { to: 'authorised', action: 'authorise' })));
router.post('/:id/return', requireRole('dept_head', 'admin'), wrap((req, res, next) => decide(req, res, next, { to: 'returned', action: 'return', needsComment: true })));
router.post('/:id/reject', requireRole('dept_head', 'admin'), wrap((req, res, next) => decide(req, res, next, { to: 'rejected', action: 'reject', needsComment: true })));

module.exports = router;
