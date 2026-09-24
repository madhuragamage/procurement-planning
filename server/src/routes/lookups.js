const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, oneOf, audit } = require('../util');
const rules = require('../rules');

const router = express.Router();

async function loadLimits() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'limits'");
  return rules.mergeLimits(rows.length ? rows[0].value : null);
}

// Everything the UI needs to populate dropdowns, in one call.
router.get('/', wrap(async (req, res) => {
  const [departments] = await pool.query('SELECT id, code, name, active FROM departments ORDER BY name');
  const [categories] = await pool.query('SELECT id, name, manual_type, active FROM categories ORDER BY name');
  const [org] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  res.json({
    departments, categories,
    org: org.length ? org[0].value : {},
    methods: rules.METHODS, biddingProcedures: rules.BIDDING_PROCEDURES,
    committeeLevels: rules.COMMITTEE_LEVELS, milestones: rules.MILESTONES,
    limits: await loadLimits(), defaultLimits: rules.DEFAULT_LIMITS
  });
}));

router.post('/departments', requireRole('admin'), wrap(async (req, res) => {
  const [r] = await pool.query('INSERT INTO departments (code, name) VALUES (?,?)', [reqString(req.body.code, 'Code', 20).toUpperCase(), reqString(req.body.name, 'Name', 120)]);
  await audit(null, 'department', r.insertId, 'create', req.user.id, req.body.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/departments/:id', requireRole('admin'), wrap(async (req, res) => {
  const sets = []; const vals = [];
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(reqString(req.body.name, 'Name', 120)); }
  if (req.body.code !== undefined) { sets.push('code = ?'); vals.push(reqString(req.body.code, 'Code', 20).toUpperCase()); }
  if (req.body.active !== undefined) { sets.push('active = ?'); vals.push(req.body.active ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  await pool.query(`UPDATE departments SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(req.params.id)]);
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
  const sets = []; const vals = [];
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(reqString(req.body.name, 'Name', 80)); }
  if (req.body.manual_type !== undefined) { sets.push('manual_type = ?'); vals.push(oneOf(req.body.manual_type, ['goods', 'works', 'services'], 'Manual type')); }
  if (req.body.active !== undefined) { sets.push('active = ?'); vals.push(req.body.active ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  await pool.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(req.params.id)]);
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
