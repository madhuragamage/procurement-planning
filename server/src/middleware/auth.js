const jwt = require('jsonwebtoken');
const pool = require('../db');

const COOKIE_NAME = 'lp_session';

function signSession(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  };
}

// Loads the user fresh on every request so role/department/deactivation changes take effect at once.
async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Session expired - please sign in again.' }); }
  try {
    const [rows] = await pool.query(
      'SELECT u.id, u.email, u.name, u.role, u.department_id, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ? AND u.active = 1',
      [payload.sub]
    );
    if (!rows.length) return res.status(401).json({ error: 'Account not found or deactivated.' });
    req.user = rows[0];
    next();
  } catch (e) { next(e); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your role is not permitted to do this.' });
    next();
  };
}

module.exports = { COOKIE_NAME, signSession, cookieOptions, requireAuth, requireRole };
