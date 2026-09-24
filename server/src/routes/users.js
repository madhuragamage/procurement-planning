const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, oneOf, audit } = require('../util');

const router = express.Router();
const ROLES = ['admin', 'requester', 'dept_head', 'procurement', 'management'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLS = 'u.id, u.email, u.name, u.role, u.department_id, d.name AS department, u.active, u.created_at';

router.get('/', requireRole('admin'), wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT ${COLS} FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.name`);
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
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query('INSERT INTO users (email, name, password_hash, role, department_id) VALUES (?,?,?,?,?)', [email, name, hash, role, dept]);
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
  if (req.body.department_id !== undefined) { sets.push('department_id = ?'); vals.push(Number(req.body.department_id)); }
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
