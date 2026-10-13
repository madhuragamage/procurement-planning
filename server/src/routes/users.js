const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, oneOf, audit } = require('../util');

const router = express.Router();
const ROLES = ['admin', 'requester', 'dept_head', 'procurement', 'management', 'executive', 'supplies'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLS = 'u.id, u.email, u.name, u.role, u.department_id, d.name AS department, u.sub_unit_id, su.name AS sub_unit, u.active, u.created_at';

// A sub unit must belong to the user's department; empty means department-level.
async function checkSubUnit(value, departmentId) {
  if (value === undefined || value === null || value === '') return null;
  const [rows] = await pool.query('SELECT id FROM sub_units WHERE id = ? AND department_id = ?', [Number(value), departmentId]);
  if (!rows.length) throw new HttpError(400, 'That sub unit does not belong to the selected department.');
  return rows[0].id;
}

router.get('/', requireRole('admin'), wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT ${COLS} FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN sub_units su ON su.id = u.sub_unit_id ORDER BY u.name`);
  res.json(rows);
}));

router.post('/', requireRole('admin'), wrap(async (req, res) => {
  const email = reqString(req.body.email, 'Email', 190).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const name = reqString(req.body.name, 'Name', 120);
  const role = oneOf(req.body.role, ROLES, 'Role');
  const password = req.body.password;
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const dept = Number(req.body.department_id);
  if (!Number.isInteger(dept)) throw new HttpError(400, 'Department is required.');
  const subUnit = await checkSubUnit(req.body.sub_unit_id, dept);
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query('INSERT INTO users (email, name, password_hash, role, department_id, sub_unit_id) VALUES (?,?,?,?,?,?)', [email, name, hash, role, dept, subUnit]);
  await audit(null, 'user', r.insertId, 'create', req.user.id, `${email} as ${role}`);
  res.status(201).json({ id: r.insertId });
}));

router.put('/:id', requireRole('admin'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const sets = []; const vals = [];
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(reqString(req.body.name, 'Name', 120)); }
  if (req.body.role !== undefined) {
    sets.push('role = ?'); vals.push(oneOf(req.body.role, ROLES, 'Role'));
    if (id === req.user.id && req.body.role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role.');
  }
  if (req.body.department_id !== undefined || req.body.sub_unit_id !== undefined) {
    const [[cur]] = await pool.query('SELECT department_id, sub_unit_id FROM users WHERE id = ?', [id]);
    if (!cur) throw new HttpError(404, 'User not found.');
    const dept = req.body.department_id !== undefined ? Number(req.body.department_id) : cur.department_id;
    // Changing department clears the sub unit unless a valid new one is supplied.
    const sub = req.body.sub_unit_id !== undefined ? req.body.sub_unit_id : (dept === cur.department_id ? cur.sub_unit_id : null);
    sets.push('department_id = ?', 'sub_unit_id = ?'); vals.push(dept, await checkSubUnit(sub, dept));
  }
  if (req.body.active !== undefined) {
    if (id === req.user.id && !req.body.active) throw new HttpError(400, 'You cannot deactivate your own account.');
    sets.push('active = ?'); vals.push(req.body.active ? 1 : 0);
  }
  if (req.body.password) {
    if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    sets.push('password_hash = ?'); vals.push(await bcrypt.hash(req.body.password, 10));
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  await audit(null, 'user', id, 'update', req.user.id, Object.keys(req.body).filter(k => k !== 'password').join(','));
  res.json({ ok: true });
}));

module.exports = router;
