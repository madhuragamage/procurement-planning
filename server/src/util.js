const pool = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function audit(conn, entity, entityId, action, userId, comment) {
  await (conn || pool).query(
    'INSERT INTO audit_log (entity, entity_id, action, user_id, comment) VALUES (?,?,?,?,?)',
    [entity, String(entityId), action, userId || null, comment || null]
  );
}

async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function reqString(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${name} is required.`);
  if (v.length > max) throw new HttpError(400, `${name} is too long.`);
  return v.trim();
}
function optString(v, max = 2000) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'Invalid text value.');
  return v.trim();
}
function num(v, name, { min = 0, max = 1e9 } = {}) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}.`);
  return n;
}
function optDate(v, name) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${name} must be a date (YYYY-MM-DD).`);
  return v;
}
function oneOf(v, list, name) {
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}.`);
  return v;
}

module.exports = { HttpError, wrap, audit, tx, reqString, optString, num, optDate, oneOf };
