const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, num, optDate, oneOf, audit, tx, isWide, inScope } = require('../util');
const { REASONS, isProcurementHead } = require('./lookups');
const recurrence = require('../recurrence');
const phasing = require('../phasing');
const { CATEGORY_LABEL } = require('../planLib');

const router = express.Router();

const SELECT = `
  SELECT r.*, d.name AS department, dv.name AS division, su.name AS sub_unit, ${CATEGORY_LABEL} AS category, c.manual_type, bc.code AS budget_code, bc.description AS budget_code_desc,
         u.name AS requested_by_name, a.name AS authorised_by_name, pi.id AS plan_item_id
  FROM requests r
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN divisions dv ON dv.id = d.division_id
  LEFT JOIN sub_units su ON su.id = r.sub_unit_id
  JOIN categories c ON c.id = r.category_id
  LEFT JOIN budget_codes bc ON bc.id = r.budget_code_id
  JOIN users u ON u.id = r.requested_by
  LEFT JOIN users a ON a.id = r.authorised_by
  LEFT JOIN plan_items pi ON pi.request_id = r.id AND pi.recur_index = 0`;

async function getRequest(id) {
  const [rows] = await pool.query(`${SELECT} WHERE r.id = ?`, [id]);
  return rows[0] || null;
}

async function load(req) {
  const r = await getRequest(Number(req.params.id));
  const procHead = r && r.status === 'authorised' && await isProcurementHead(req.user);
  if (!r || !(inScope(req.user, r.department_id, r.sub_unit_id) || procHead)) throw new HttpError(404, 'Request not found.');
  return r;
}

// The procurement unit (and its department head) may amend a request it has received - authorised by the
// department head - until the plan it belongs to is submitted to management.
async function canAmend(user, r) {
  if (r.status !== 'authorised') return false;
  if (!['procurement', 'admin'].includes(user.role) && !(await isProcurementHead(user))) return false;
  const [[plan]] = await pool.query('SELECT status FROM plans WHERE fy = ?', [r.plan_fy]);
  return !plan || ['planning', 'changes_requested'].includes(plan.status);
}

// A budget code must belong to the chosen Budget Category; it is required once codes exist for that category.
async function checkBudgetCode(f, raw) {
  const id = raw === '' || raw == null ? null : Number(raw);
  const [codes] = await pool.query('SELECT id, active FROM budget_codes WHERE expense_type = ?', [f.expense_type]);
  if (id == null) {
    if (codes.some(c => c.active)) throw new HttpError(400, `Choose the budget code (${f.expense_type}).`);
    return null;
  }
  const c = codes.find(x => x.id === id);
  if (!c) throw new HttpError(400, `That budget code is not a ${f.expense_type} code.`);
  return id;
}

// Which sub unit does a new/edited request belong to? A sub-unit requester always files for their own
// unit; everyone else may pick one of the department's sub units, or leave it department-level.
async function resolveSubUnit(user, departmentId, requested) {
  if (user.role === 'requester' && user.sub_unit_id) return user.sub_unit_id;
  if (requested === undefined || requested === null || requested === '') return null;
  const [rows] = await pool.query('SELECT id FROM sub_units WHERE id = ? AND department_id = ?', [Number(requested), departmentId]);
  if (!rows.length) throw new HttpError(400, 'That sub unit does not belong to the department.');
  return rows[0].id;
}

function parseBody(body, departmentId) {
  const reason = oneOf(body.reason || 'New', REASONS, 'Reason');
  const reasonNote = optString(body.reason_note, 200);
  if (reason === 'Other' && !reasonNote) throw new HttpError(400, 'Describe the reason when "Other" is selected.');
  const recur = oneOf(body.recurrence || 'one_time', recurrence.RECURRENCE, 'Recurrence');
  let budgetPhasing;
  try { budgetPhasing = phasing.parse(body.budget_phasing); } catch (e) { throw new HttpError(400, e.message); }
  const f = {
    budget_phasing: budgetPhasing && JSON.stringify(budgetPhasing),
    expense_type: oneOf(body.expense_type, recurrence.EXPENSE_TYPES, 'Budget category'),
    recurrence: recur,
    annual_increase_pct: recur === 'recurrent' && body.annual_increase_pct !== undefined && body.annual_increase_pct !== ''
      ? num(body.annual_increase_pct, 'Annual increase %', { max: 100 }) : 0,
    department_id: departmentId,
    category_id: Number(body.category_id),
    title: reqString(body.title, 'Title'),
    description: optString(body.description),
    reason, reason_note: reasonNote, // optional detail for any reason; required for "Other"
    tce_excl_vat_mn: num(body.tce_excl_vat_mn, 'Estimated cost (excl. VAT)', { max: 1e7 }),
    vat_pct: body.vat_pct === undefined || body.vat_pct === '' ? 18 : num(body.vat_pct, 'VAT %', { max: 100 }),
    funding_source: oneOf(body.funding_source || 'LECO', rules.FUNDING_SOURCES, 'Funding source'),
    funding_agency: optString(body.funding_agency, 120),
    priority: oneOf(body.priority || 'N', ['U', 'P', 'N'], 'Priority'),
    plan_fy: num(body.plan_fy, 'Planning year', { min: 2000, max: 2200 }),
    year_offset: num(body.year_offset === undefined || body.year_offset === '' ? 0 : body.year_offset, 'Year within plan', { min: 0, max: 2 }),
    required_date: optDate(body.required_date, 'Required date')
  };
  if (!Number.isInteger(f.category_id)) throw new HttpError(400, 'Choose the main procurement category and sub category.');
  if (!Number.isInteger(f.plan_fy)) throw new HttpError(400, 'Planning year must be a whole year.');
  return f;
}

const WRITERS = ['requester', 'dept_head', 'procurement', 'admin'];

router.get('/', wrap(async (req, res) => {
  const where = []; const params = [];
  if (await isProcurementHead(req.user)) {
    // Head of the procurement unit: own department, plus every request received by the procurement unit.
    where.push("(r.department_id = ? OR r.status = 'authorised')"); params.push(req.user.department_id);
  } else if (!isWide(req.user)) {
    where.push('r.department_id = ?'); params.push(req.user.department_id);
    if (req.user.role === 'requester' && req.user.sub_unit_id) { where.push('r.sub_unit_id = ?'); params.push(req.user.sub_unit_id); }
  }
  if (req.query.status) { where.push('r.status = ?'); params.push(String(req.query.status)); }
  if (req.query.plan_fy) { where.push('r.plan_fy = ?'); params.push(Number(req.query.plan_fy)); }
  if (req.query.department_id && isWide(req.user)) { where.push('r.department_id = ?'); params.push(Number(req.query.department_id)); }
  if (req.query.unplanned === '1') where.push('pi.id IS NULL');
  const [rows] = await pool.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC`, params);
  // can_amend: the procurement unit / its head may still change this request.
  const [plans] = await pool.query('SELECT fy, status FROM plans');
  const locked = new Set(plans.filter(p => !['planning', 'changes_requested'].includes(p.status)).map(p => p.fy));
  const amender = ['procurement', 'admin'].includes(req.user.role) || await isProcurementHead(req.user);
  res.json(rows.map(r => ({ ...r, can_amend: amender && r.status === 'authorised' && !locked.has(r.plan_fy) })));
}));

router.get('/:id', wrap(async (req, res) => {
  const r = await load(req);
  const [history] = await pool.query(
    "SELECT a.action, a.comment, a.at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'request' AND a.entity_id = ? ORDER BY a.id", [String(r.id)]);
  res.json({ ...r, history, can_amend: await canAmend(req.user, r) });
}));

router.post('/', requireRole(...WRITERS), wrap(async (req, res) => {
  const privileged = ['procurement', 'admin'].includes(req.user.role);
  const departmentId = privileged && req.body.department_id ? Number(req.body.department_id) : req.user.department_id;
  if (!Number.isInteger(departmentId)) throw new HttpError(400, 'Your account has no department.');
  const f = parseBody(req.body, departmentId);
  f.budget_code_id = await checkBudgetCode(f, req.body.budget_code_id);
  const subUnitId = await resolveSubUnit(req.user, departmentId, req.body.sub_unit_id);
  const id = await tx(async conn => {
    const tmp = 'TMP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const [r] = await conn.query(
      `INSERT INTO requests (ref_no, department_id, sub_unit_id, category_id, title, description, reason, reason_note, expense_type, budget_code_id, recurrence, annual_increase_pct, budget_phasing, tce_excl_vat_mn, vat_pct, funding_source, funding_agency, priority, plan_fy, year_offset, required_date, requested_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tmp, f.department_id, subUnitId, f.category_id, f.title, f.description, f.reason, f.reason_note, f.expense_type, f.budget_code_id, f.recurrence, f.annual_increase_pct, f.budget_phasing, f.tce_excl_vat_mn, f.vat_pct, f.funding_source, f.funding_agency, f.priority, f.plan_fy, f.year_offset, f.required_date, req.user.id]);
    const [[dept]] = await conn.query('SELECT code FROM departments WHERE id = ?', [f.department_id]);
    const ref = `${dept.code}-${f.plan_fy}-${String(r.insertId).padStart(4, '0')}`;
    await conn.query('UPDATE requests SET ref_no = ? WHERE id = ?', [ref, r.insertId]);
    await audit(conn, 'request', r.insertId, 'create', req.user.id, null);
    return r.insertId;
  });
  res.status(201).json(await getRequest(id));
}));

// Fields an amendment can change, for the audit trail.
const AMEND_FIELDS = ['category_id', 'title', 'description', 'reason', 'reason_note', 'expense_type', 'budget_code_id', 'recurrence', 'annual_increase_pct',
  'tce_excl_vat_mn', 'vat_pct', 'funding_source', 'funding_agency', 'priority', 'plan_fy', 'year_offset', 'required_date'];

router.put('/:id', requireRole(...WRITERS), wrap(async (req, res) => {
  const r = await load(req);
  const editable = ['draft', 'returned'].includes(r.status);
  const amending = !editable && await canAmend(req.user, r);
  if (!editable && !amending) {
    throw new HttpError(409, r.status === 'authorised'
      ? 'Only the procurement unit (or its department head) can amend this request, and only before the plan is submitted for approval.'
      : 'Only draft or returned requests can be edited.');
  }
  const f = parseBody(req.body, r.department_id);
  f.budget_code_id = await checkBudgetCode(f, req.body.budget_code_id);
  const subUnitId = ['procurement', 'admin'].includes(req.user.role) || req.user.role === 'dept_head'
    ? await resolveSubUnit(req.user, r.department_id, req.body.sub_unit_id === undefined ? r.sub_unit_id : req.body.sub_unit_id)
    : r.sub_unit_id;
  const changed = AMEND_FIELDS.filter(k => String(f[k] ?? '') !== String(r[k] ?? ''));
  await tx(async conn => {
    // A request already in the (still editable) plan keeps its plan item in step.
    const [items] = await conn.query('SELECT * FROM plan_items WHERE request_id = ? ORDER BY recur_index FOR UPDATE', [r.id]);
    if (amending && items.length) {
      if (f.plan_fy !== r.plan_fy) throw new HttpError(409, 'This request is already in the plan; remove it from the plan before moving it to another cycle.');
      const recurChanged = f.recurrence !== r.recurrence || Number(f.annual_increase_pct) !== Number(r.annual_increase_pct) || (items.length > 1 && f.year_offset !== r.year_offset);
      if (recurChanged) throw new HttpError(409, 'This request is already in the plan with its recurrent repeats; remove it from the plan before changing recurrence, the yearly increase or the plan year.');
    }
    await conn.query(
      `UPDATE requests SET sub_unit_id=?, category_id=?, title=?, description=?, reason=?, reason_note=?, expense_type=?, budget_code_id=?, recurrence=?, annual_increase_pct=?, budget_phasing=?, tce_excl_vat_mn=?, vat_pct=?, funding_source=?, funding_agency=?, priority=?, plan_fy=?, year_offset=?, required_date=? WHERE id=?`,
      [subUnitId, f.category_id, f.title, f.description, f.reason, f.reason_note, f.expense_type, f.budget_code_id, f.recurrence, f.annual_increase_pct, f.budget_phasing, f.tce_excl_vat_mn, f.vat_pct, f.funding_source, f.funding_agency, f.priority, f.plan_fy, f.year_offset, f.required_date, r.id]);
    for (const it of amending ? items : []) {
      const k = it.recur_index;
      await conn.query('UPDATE plan_items SET title=?, description=?, tce_excl_vat_mn=?, vat_pct=?, funding_source=?, funding_agency=?, year_offset=? WHERE id=?',
        [f.title, f.description, recurrence.escalate(f.tce_excl_vat_mn, f.annual_increase_pct, k), f.vat_pct, f.funding_source, f.funding_agency, f.year_offset + k, it.id]);
    }
    await audit(conn, 'request', r.id, amending ? 'amend' : 'edit', req.user.id, amending ? `amended by ${req.user.role === 'dept_head' ? 'procurement head' : 'procurement unit'}: ${changed.join(', ') || 'no field changes'}` : null);
  });
  res.json(await getRequest(r.id));
}));

router.delete('/:id', requireRole(...WRITERS), wrap(async (req, res) => {
  const r = await load(req);
  if (r.status !== 'draft') throw new HttpError(409, 'Only draft requests can be deleted.');
  if (req.user.role !== 'admin' && r.requested_by !== req.user.id) throw new HttpError(403, 'Only the author can delete a draft.');
  await pool.query('DELETE FROM audit_log WHERE entity = ? AND entity_id = ?', ['request', String(r.id)]);
  await pool.query('DELETE FROM requests WHERE id = ?', [r.id]);
  res.json({ ok: true });
}));

router.post('/:id/submit', requireRole(...WRITERS), wrap(async (req, res) => {
  const r = await load(req);
  if (!['draft', 'returned'].includes(r.status)) throw new HttpError(409, 'Only draft or returned requests can be submitted.');
  if (!(r.tce_excl_vat_mn > 0)) throw new HttpError(400, 'Enter an estimated cost above zero before submitting.');
  if (!r.required_date) throw new HttpError(400, 'Enter the tentative required date before submitting.');
  await pool.query("UPDATE requests SET status = 'submitted', review_comment = NULL WHERE id = ?", [r.id]);
  await audit(null, 'request', r.id, 'submit', req.user.id, null);
  res.json(await getRequest(r.id));
}));

// Department head authorisation covers the department and all its sub units.
async function decide(req, res, { to, action, needsComment }) {
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

router.post('/:id/authorise', requireRole('dept_head', 'admin'), wrap((req, res) => decide(req, res, { to: 'authorised', action: 'authorise' })));
router.post('/:id/return', requireRole('dept_head', 'admin'), wrap((req, res) => decide(req, res, { to: 'returned', action: 'return', needsComment: true })));
router.post('/:id/reject', requireRole('dept_head', 'admin'), wrap((req, res) => decide(req, res, { to: 'rejected', action: 'reject', needsComment: true })));

module.exports = router;
