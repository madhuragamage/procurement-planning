const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, oneOf, audit, tx } = require('../util');
const rules = require('../rules');

const recurrence = require('../recurrence');

const router = express.Router();
const REASONS = ['ROL', 'Replacement', 'New', 'Action Plan', 'Other'];

async function loadLimits() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'limits'");
  return rules.mergeLimits(rows.length ? rows[0].value : null);
}

// The department that is the Supplies unit; its department head may view (not edit) the Supplies function.
async function loadSuppliesDepartment() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'supplies_unit'");
  return rows.length && rows[0].value.department_id ? Number(rows[0].value.department_id) : null;
}
const SUPPLIES_VIEW_ROLES = ['supplies', 'procurement', 'admin', 'management', 'executive'];
async function canViewSupplies(user) {
  if (SUPPLIES_VIEW_ROLES.includes(user.role)) return true;
  return user.role === 'dept_head' && !!user.department_id && user.department_id === await loadSuppliesDepartment();
}

async function loadReminderDays() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'reminders'");
  return rows.length ? Number(rows[0].value.lead_days) || 30 : 30;
}

const patchSql = (table, body, allowed) => {
  const sets = []; const vals = [];
  for (const [key, fn] of Object.entries(allowed)) {
    if (body[key] !== undefined) { sets.push(`${key} = ?`); vals.push(fn(body[key])); }
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, vals };
};
const active = v => (v ? 1 : 0);

// Everything the UI needs to populate dropdowns, in one call.
router.get('/', wrap(async (req, res) => {
  const [divisions] = await pool.query('SELECT id, name, active FROM divisions ORDER BY name');
  const [departments] = await pool.query('SELECT d.id, d.code, d.name, d.active, d.division_id, v.name AS division FROM departments d LEFT JOIN divisions v ON v.id = d.division_id ORDER BY d.name');
  const [subUnits] = await pool.query('SELECT id, department_id, name, active FROM sub_units ORDER BY name');
  const [categories] = await pool.query('SELECT id, name, manual_type, active FROM categories ORDER BY name');
  const [org] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  res.json({
    divisions, departments, subUnits, categories,
    reminders: { lead_days: await loadReminderDays() },
    suppliesUnit: { department_id: await loadSuppliesDepartment() },
    fundingSources: rules.FUNDING_SOURCES, reasons: REASONS, expenseTypes: recurrence.EXPENSE_TYPES,
    org: org.length ? org[0].value : {},
    methods: rules.METHODS, biddingProcedures: rules.BIDDING_PROCEDURES,
    committeeLevels: rules.COMMITTEE_LEVELS, milestones: rules.MILESTONES,
    limits: await loadLimits(), defaultLimits: rules.DEFAULT_LIMITS
  });
}));

router.post('/divisions', requireRole('admin'), wrap(async (req, res) => {
  const [r] = await pool.query('INSERT INTO divisions (name) VALUES (?)', [reqString(req.body.name, 'Name', 120)]);
  await audit(null, 'division', r.insertId, 'create', req.user.id, req.body.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/divisions/:id', requireRole('admin'), wrap(async (req, res) => {
  const { sql, vals } = patchSql('divisions', req.body, { name: v => reqString(v, 'Name', 120), active });
  await pool.query(sql, [...vals, Number(req.params.id)]);
  res.json({ ok: true });
}));

router.post('/departments', requireRole('admin'), wrap(async (req, res) => {
  const division = Number(req.body.division_id);
  if (!Number.isInteger(division)) throw new HttpError(400, 'Division is required.');
  const [r] = await pool.query('INSERT INTO departments (code, name, division_id) VALUES (?,?,?)',
    [reqString(req.body.code, 'Code', 20).toUpperCase(), reqString(req.body.name, 'Name', 120), division]);
  await audit(null, 'department', r.insertId, 'create', req.user.id, req.body.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/departments/:id', requireRole('admin'), wrap(async (req, res) => {
  const { sql, vals } = patchSql('departments', req.body, {
    name: v => reqString(v, 'Name', 120), code: v => reqString(v, 'Code', 20).toUpperCase(), division_id: Number, active
  });
  await pool.query(sql, [...vals, Number(req.params.id)]);
  res.json({ ok: true });
}));

// Moves every user, request and budget line of one department into another, then deactivates the source.
// Used to fold a legacy department into the real structure without losing history.
router.post('/departments/:id/merge', requireRole('admin'), wrap(async (req, res) => {
  const from = Number(req.params.id); const into = Number(req.body.into_id);
  if (!Number.isInteger(into) || from === into) throw new HttpError(400, 'Choose a different department to move records into.');
  const subUnit = req.body.sub_unit_id ? Number(req.body.sub_unit_id) : null;
  const moved = await tx(async conn => {
    const [[target]] = await conn.query('SELECT id FROM departments WHERE id = ?', [into]);
    if (!target) throw new HttpError(404, 'Target department not found.');
    if (subUnit) {
      const [ok] = await conn.query('SELECT id FROM sub_units WHERE id = ? AND department_id = ?', [subUnit, into]);
      if (!ok.length) throw new HttpError(400, 'That sub unit does not belong to the target department.');
    }
    const [u] = await conn.query('UPDATE users SET department_id = ?, sub_unit_id = ? WHERE department_id = ?', [into, subUnit, from]);
    const [r] = await conn.query('UPDATE requests SET department_id = ?, sub_unit_id = ? WHERE department_id = ?', [into, subUnit, from]);
    const [b] = await conn.query('UPDATE budgets SET department_id = ? WHERE department_id = ?', [into, from]);
    await conn.query('UPDATE sub_units SET active = 0 WHERE department_id = ?', [from]);
    await conn.query('UPDATE departments SET active = 0 WHERE id = ?', [from]);
    await audit(conn, 'department', from, 'merge', req.user.id, `into #${into}: ${u.affectedRows} users, ${r.affectedRows} requests, ${b.affectedRows} budget lines`);
    return { users: u.affectedRows, requests: r.affectedRows, budgets: b.affectedRows };
  });
  res.json({ ok: true, moved });
}));

router.post('/sub-units', requireRole('admin'), wrap(async (req, res) => {
  const dept = Number(req.body.department_id);
  if (!Number.isInteger(dept)) throw new HttpError(400, 'Department is required.');
  const [r] = await pool.query('INSERT INTO sub_units (department_id, name) VALUES (?,?)', [dept, reqString(req.body.name, 'Name', 120)]);
  await audit(null, 'sub_unit', r.insertId, 'create', req.user.id, req.body.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/sub-units/:id', requireRole('admin'), wrap(async (req, res) => {
  const { sql, vals } = patchSql('sub_units', req.body, { name: v => reqString(v, 'Name', 120), active });
  await pool.query(sql, [...vals, Number(req.params.id)]);
  res.json({ ok: true });
}));

// The procurement unit maintains the category list (per the brief).
router.post('/categories', requireRole('admin', 'procurement'), wrap(async (req, res) => {
  const type = oneOf(req.body.manual_type, ['goods', 'works', 'services'], 'Manual type');
  const [r] = await pool.query('INSERT INTO categories (name, manual_type) VALUES (?,?)', [reqString(req.body.name, 'Name', 80), type]);
  await audit(null, 'category', r.insertId, 'create', req.user.id, req.body.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/categories/:id', requireRole('admin', 'procurement'), wrap(async (req, res) => {
  const { sql, vals } = patchSql('categories', req.body, {
    name: v => reqString(v, 'Name', 80), manual_type: v => oneOf(v, ['goods', 'works', 'services'], 'Manual type'), active
  });
  await pool.query(sql, [...vals, Number(req.params.id)]);
  res.json({ ok: true });
}));

// Authority-limit overrides (Section 2.9 limits change by circular).
router.put('/limits', requireRole('admin'), wrap(async (req, res) => {
  const v = req.body;
  if (!v || typeof v !== 'object' || (!v.committee && !v.shopping)) throw new HttpError(400, 'Provide committee and/or shopping limits.');
  const merged = rules.mergeLimits(v);
  for (const f of ['GOSL', 'Foreign']) {
    const rows = merged.committee[f];
    const sorted = Array.isArray(rows) && rows.every((r, i) => i === 0 || r.upTo === null || (rows[i - 1].upTo !== null && r.upTo > rows[i - 1].upTo));
    if (!Array.isArray(rows) || !rows.length || rows[rows.length - 1].upTo !== null || !sorted) {
      throw new HttpError(400, `Committee limits for ${f} must be an ascending list ending with an unlimited level.`);
    }
  }
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('limits', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(v)]);
  await audit(null, 'settings', 'limits', 'update', req.user.id, null);
  res.json({ ok: true });
}));

router.delete('/limits', requireRole('admin'), wrap(async (req, res) => {
  await pool.query("DELETE FROM settings WHERE `key` = 'limits'");
  await audit(null, 'settings', 'limits', 'reset', req.user.id, null);
  res.json({ ok: true });
}));

router.put('/reminders', requireRole('admin'), wrap(async (req, res) => {
  const days = Number(req.body.lead_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Lead time must be a whole number of days between 1 and 365.');
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('reminders', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ lead_days: days })]);
  res.json({ ok: true });
}));

router.put('/supplies-unit', requireRole('admin'), wrap(async (req, res) => {
  const dept = req.body.department_id ? Number(req.body.department_id) : null;
  if (dept) {
    const [rows] = await pool.query('SELECT id FROM departments WHERE id = ?', [dept]);
    if (!rows.length) throw new HttpError(404, 'Department not found.');
  }
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('supplies_unit', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ department_id: dept })]);
  await audit(null, 'settings', 'supplies_unit', 'update', req.user.id, dept ? `department #${dept}` : 'none');
  res.json({ ok: true });
}));

router.put('/org', requireRole('admin'), wrap(async (req, res) => {
  const name = reqString(req.body.name, 'Organisation name', 160);
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('org', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ name })]);
  res.json({ ok: true });
}));

router.get('/audit', requireRole('admin', 'procurement', 'management'), wrap(async (req, res) => {
  const params = []; let where = '';
  if (req.query.entity) {
    where = 'WHERE a.entity = ?'; params.push(String(req.query.entity));
    if (req.query.entity_id) { where += ' AND a.entity_id = ?'; params.push(String(req.query.entity_id)); }
  }
  const [rows] = await pool.query(
    `SELECT a.id, a.entity, a.entity_id, a.action, a.comment, a.at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.id DESC LIMIT 300`, params);
  res.json(rows);
}));

module.exports = router;
module.exports.loadLimits = loadLimits;
module.exports.loadReminderDays = loadReminderDays;
module.exports.REASONS = REASONS;
module.exports.canViewSupplies = canViewSupplies;
