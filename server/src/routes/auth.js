const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { COOKIE_NAME, signSession, cookieOptions, requireAuth } = require('../middleware/auth');
const { wrap, HttpError, reqString } = require('../util');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, department_id: u.department_id, department: u.department || null });

// Open only while the users table is empty: the first account becomes the administrator.
router.post('/register', wrap(async (req, res) => {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  if (n > 0) throw new HttpError(403, 'Registration is closed. Ask an administrator to create your account.');
  const email = reqString(req.body.email, 'Email', 190).toLowerCase();
  const name = reqString(req.body.name || email.split('@')[0], 'Name', 120);
  const password = req.body.password;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query('INSERT INTO users (email, name, password_hash, role, department_id) VALUES (?,?,?,?,1)', [email, name, hash, 'admin']);
  const user = { id: r.insertId, email, name, role: 'admin', department_id: 1 };
  res.cookie(COOKIE_NAME, signSession(user), cookieOptions());
  res.status(201).json({ user: publicUser(user) });
}));

router.post('/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const [rows] = await pool.query(
    'SELECT u.*, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.email = ?', [email]);
  const u = rows[0];
  const ok = u && u.active && await bcrypt.compare(password, u.password_hash);
  if (!ok) throw new HttpError(401, 'Invalid email or password.');
  res.cookie(COOKIE_NAME, signSession(u), cookieOptions());
  res.json({ user: publicUser(u) });
}));

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.get('/setup-needed', wrap(async (req, res) => {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users');
  res.json({ setupNeeded: n === 0 });
}));

module.exports = router;
