const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, num, audit, isWide } = require('../util');

const router = express.Router();
const MANAGE = ['procurement', 'management', 'admin'];

// Budget year = plan cycle + the item's year offset (an item planned in the 2027 cycle for year 2 is a 2029 commitment).
async function availability(year) {
  const [budgetRows] = await pool.query(
    'SELECT b.department_id, d.name AS department, b.category_id, c.name AS category, SUM(b.amount_mn) AS amount FROM budgets b JOIN departments d ON d.id = b.department_id LEFT JOIN categories c ON c.id = b.category_id WHERE b.year = ? GROUP BY b.department_id, b.category_id, d.name, c.name', [year]);
  const [committedRows] = await pool.query(
    `SELECT r.department_id, d.name AS department, r.category_id, c.name AS category,
            SUM(i.tce_excl_vat_mn * (1 + i.vat_pct / 100)) AS amount
     FROM plan_items i JOIN requests r ON r.id = i.request_id JOIN departments d ON d.id = r.department_id JOIN categories c ON c.id = r.category_id
     WHERE i.status <> 'cancelled' AND i.plan_fy + i.year_offset = ? GROUP BY r.department_id, r.category_id, d.name, c.name`, [year]);
  const [pipelineRows] = await pool.query(
    `SELECT r.department_id, d.name AS department, r.category_id, c.name AS category,
            SUM(r.tce_excl_vat_mn * (1 + r.vat_pct / 100)) AS amount
     FROM requests r JOIN departments d ON d.id = r.department_id JOIN categories c ON c.id = r.category_id
     LEFT JOIN plan_items i ON i.request_id = r.id
     WHERE r.status = 'authorised' AND i.id IS NULL AND r.plan_fy + r.year_offset = ? GROUP BY r.department_id, r.category_id, d.name, c.name`, [year]);

  const depts = new Map();
  const dept = (id, name) => {
    if (!depts.has(id)) depts.set(id, { department_id: id, department: name, allocated: 0, committed: 0, pipeline: 0, categories: new Map() });
    return depts.get(id);
  };
  const cat = (d, id, name) => {
    const key = id == null ? 0 : id;
    if (!d.categories.has(key)) d.categories.set(key, { category_id: id, category: name || 'All categories', allocated: 0, committed: 0, pipeline: 0 });
    return d.categories.get(key);
  };
  for (const b of budgetRows) { const d = dept(b.department_id, b.department); d.allocated += b.amount; cat(d, b.category_id, b.category).allocated += b.amount; }
  for (const c of committedRows) { const d = dept(c.department_id, c.department); d.committed += c.amount; cat(d, c.category_id, c.category).committed += c.amount; }
  for (const p of pipelineRows) { const d = dept(p.department_id, p.department); d.pipeline += p.amount; cat(d, p.category_id, p.category).pipeline += p.amount; }

  const r2 = n => Math.round(n * 100) / 100;
  return [...depts.values()].sort((a, b) => a.department.localeCompare(b.department)).map(d => ({
    department_id: d.department_id, department: d.department,
    allocated: r2(d.allocated), committed: r2(d.committed), pipeline: r2(d.pipeline),
    remaining: r2(d.allocated - d.committed), over_budget: d.committed > d.allocated + 1e-9,
    categories: [...d.categories.values()].filter(c => c.category_id != null).map(c => ({
      ...c, allocated: r2(c.allocated), committed: r2(c.committed), pipeline: r2(c.pipeline),
      remaining: c.allocated ? r2(c.allocated - c.committed) : null, over_budget: c.allocated > 0 && c.committed > c.allocated + 1e-9
    }))
  }));
}

router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, d.name AS department, c.name AS category FROM budgets b JOIN departments d ON d.id = b.department_id LEFT JOIN categories c ON c.id = b.category_id
     ${req.query.year ? 'WHERE b.year = ?' : ''} ORDER BY b.year DESC, d.name, c.name`, req.query.year ? [Number(req.query.year)] : []);
  res.json(isWide(req.user) ? rows : rows.filter(b => b.department_id === req.user.department_id));
}));

router.get('/availability', wrap(async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year)) throw new HttpError(400, 'year is required.');
  const data = await availability(year);
  res.json(isWide(req.user) ? data : data.filter(d => d.department_id === req.user.department_id));
}));

function parse(body) {
  const year = num(body.year, 'Year', { min: 2000, max: 2200 });
  const department_id = Number(body.department_id);
  if (!Number.isInteger(department_id)) throw new HttpError(400, 'Department is required.');
  const category_id = body.category_id ? Number(body.category_id) : null;
  return { year, department_id, category_id, amount_mn: num(body.amount_mn, 'Amount (LKR Mn)', { max: 1e8 }), source: optString(body.source, 80) };
}

router.post('/', requireRole(...MANAGE), wrap(async (req, res) => {
  const b = parse(req.body);
  const [r] = await pool.query('INSERT INTO budgets (year, department_id, category_id, amount_mn, source) VALUES (?,?,?,?,?)', [b.year, b.department_id, b.category_id, b.amount_mn, b.source]);
  await audit(null, 'budget', r.insertId, 'create', req.user.id, `${b.year}: LKR ${b.amount_mn} Mn`);
  res.status(201).json({ id: r.insertId });
}));

router.put('/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const b = parse(req.body);
  const [r] = await pool.query('UPDATE budgets SET year=?, department_id=?, category_id=?, amount_mn=?, source=? WHERE id=?', [b.year, b.department_id, b.category_id, b.amount_mn, b.source, Number(req.params.id)]);
  if (!r.affectedRows) throw new HttpError(404, 'Budget line not found.');
  await audit(null, 'budget', req.params.id, 'edit', req.user.id, `${b.year}: LKR ${b.amount_mn} Mn`);
  res.json({ ok: true });
}));

router.delete('/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  await pool.query('DELETE FROM budgets WHERE id = ?', [Number(req.params.id)]);
  await audit(null, 'budget', req.params.id, 'delete', req.user.id, null);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.availability = availability;
