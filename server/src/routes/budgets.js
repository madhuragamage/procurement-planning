const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, num, oneOf, audit, isWide } = require('../util');
const recurrence = require('../recurrence');
const { EXPENSE_TYPES } = recurrence;
const phasing = require('../phasing');
const rules = require('../rules');
const { CATEGORY_LABEL } = require('../planLib');

const router = express.Router();
const MANAGE = ['procurement', 'management', 'admin'];

// Budget year = plan cycle + the item's year offset (an item planned in the 2027 cycle for year 2 is a 2029 commitment).
// CAPEX and OPEX are separate allocations: each is compared only with plan items of the same type.
async function availability(year) {
  const [budgetRows] = await pool.query(
    `SELECT b.department_id, d.name AS department, b.expense_type, b.category_id, ${CATEGORY_LABEL} AS category, SUM(b.amount_mn) AS amount
     FROM budgets b JOIN departments d ON d.id = b.department_id LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.year = ? GROUP BY b.department_id, b.expense_type, b.category_id, d.name, c.manual_type, c.name`, [year]);
  // A procurement counts in this budget year by its phasing share: one starting up to (MAX_YEARS - 1)
  // years earlier may still need part of its value now.
  const back = phasing.MAX_YEARS - 1;
  const [itemRows] = await pool.query(
    `SELECT r.department_id, d.name AS department, r.expense_type, r.category_id, ${CATEGORY_LABEL} AS category, r.budget_phasing,
            i.plan_fy + i.year_offset AS start_year, i.tce_excl_vat_mn, i.vat_pct
     FROM plan_items i JOIN requests r ON r.id = i.request_id JOIN departments d ON d.id = r.department_id JOIN categories c ON c.id = r.category_id
     WHERE i.status <> 'cancelled' AND i.plan_fy + i.year_offset BETWEEN ? AND ?`, [year - back, year]);
  const committedRows = itemRows.map(x => ({ ...x, amount: rules.tceInclVat(x.tce_excl_vat_mn, x.vat_pct) * phasing.share(x.budget_phasing, year - x.start_year) }));
  // Authorised but not yet planned. A recurrent request also counts in each later cycle year, escalated yearly.
  const [reqRows] = await pool.query(
    `SELECT r.department_id, d.name AS department, r.expense_type, r.category_id, ${CATEGORY_LABEL} AS category, r.budget_phasing,
            r.plan_fy + r.year_offset AS start_year, r.year_offset, r.tce_excl_vat_mn, r.vat_pct, r.recurrence, r.annual_increase_pct
     FROM requests r JOIN departments d ON d.id = r.department_id JOIN categories c ON c.id = r.category_id
     LEFT JOIN plan_items i ON i.request_id = r.id AND i.recur_index = 0
     WHERE r.status = 'authorised' AND i.id IS NULL AND r.plan_fy + r.year_offset BETWEEN ? AND ?`, [year - back - 2, year]);
  const pipelineRows = [];
  for (const x of reqRows) {
    const repeats = x.recurrence === 'recurrent' ? 2 - x.year_offset : 0;
    for (let n = 0; n <= repeats; n++) {
      const value = rules.tceInclVat(recurrence.escalate(x.tce_excl_vat_mn, x.annual_increase_pct, n), x.vat_pct);
      pipelineRows.push({ ...x, amount: value * phasing.share(x.budget_phasing, year - (x.start_year + n)) });
    }
  }

  const blank = () => ({ allocated: 0, committed: 0, pipeline: 0 });
  const depts = new Map();
  const dept = (id, name) => {
    if (!depts.has(id)) depts.set(id, { department_id: id, department: name, ...blank(), types: Object.fromEntries(EXPENSE_TYPES.map(t => [t, blank()])), categories: new Map() });
    return depts.get(id);
  };
  const cat = (d, type, id, name) => {
    const key = type + ':' + (id == null ? 0 : id);
    if (!d.categories.has(key)) d.categories.set(key, { expense_type: type, category_id: id, category: name || 'All categories', ...blank() });
    return d.categories.get(key);
  };
  const add = (rows, field) => {
    for (const x of rows) {
      if (!x.amount) continue;
      const d = dept(x.department_id, x.department);
      d[field] += x.amount; d.types[x.expense_type][field] += x.amount;
      cat(d, x.expense_type, x.category_id, x.category)[field] += x.amount;
    }
  };
  add(budgetRows, 'allocated'); add(committedRows, 'committed'); add(pipelineRows, 'pipeline');

  const r2 = n => Math.round(n * 100) / 100;
  const sum = t => ({ allocated: r2(t.allocated), committed: r2(t.committed), pipeline: r2(t.pipeline), remaining: r2(t.allocated - t.committed), over_budget: t.committed > t.allocated + 1e-9 });
  return [...depts.values()].sort((a, b) => a.department.localeCompare(b.department)).map(d => {
    // by_type: one entry per Budget Category (CAPEX, OPEX, Inventory), each checked against its own allocation.
    const byType = Object.fromEntries(EXPENSE_TYPES.map(t => [t, sum(d.types[t])]));
    return {
      department_id: d.department_id, department: d.department,
      ...sum(d), over_budget: Object.values(byType).some(t => t.over_budget), by_type: byType,
      categories: [...d.categories.values()].filter(c => c.category_id != null)
        .sort((a, b) => a.expense_type.localeCompare(b.expense_type) || a.category.localeCompare(b.category)).map(c => ({
          ...c, allocated: r2(c.allocated), committed: r2(c.committed), pipeline: r2(c.pipeline),
          remaining: c.allocated ? r2(c.allocated - c.committed) : null, over_budget: c.allocated > 0 && c.committed > c.allocated + 1e-9
        }))
    };
  });
}

router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, d.name AS department, ${CATEGORY_LABEL} AS category FROM budgets b JOIN departments d ON d.id = b.department_id LEFT JOIN categories c ON c.id = b.category_id
     ${req.query.year ? 'WHERE b.year = ?' : ''} ORDER BY b.year DESC, d.name, b.expense_type, c.name`, req.query.year ? [Number(req.query.year)] : []);
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
  const expense_type = oneOf(body.expense_type, EXPENSE_TYPES, 'Expenditure type (CAPEX / OPEX)');
  return { year, department_id, expense_type, category_id, amount_mn: num(body.amount_mn, 'Amount (LKR Mn)', { max: 1e8 }), source: optString(body.source, 80) };
}

router.post('/', requireRole(...MANAGE), wrap(async (req, res) => {
  const b = parse(req.body);
  const [r] = await pool.query('INSERT INTO budgets (year, department_id, expense_type, category_id, amount_mn, source) VALUES (?,?,?,?,?,?)', [b.year, b.department_id, b.expense_type, b.category_id, b.amount_mn, b.source]);
  await audit(null, 'budget', r.insertId, 'create', req.user.id, `${b.year} ${b.expense_type}: LKR ${b.amount_mn} Mn`);
  res.status(201).json({ id: r.insertId });
}));

router.put('/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const b = parse(req.body);
  const [r] = await pool.query('UPDATE budgets SET year=?, department_id=?, expense_type=?, category_id=?, amount_mn=?, source=? WHERE id=?', [b.year, b.department_id, b.expense_type, b.category_id, b.amount_mn, b.source, Number(req.params.id)]);
  if (!r.affectedRows) throw new HttpError(404, 'Budget line not found.');
  await audit(null, 'budget', req.params.id, 'edit', req.user.id, `${b.year} ${b.expense_type}: LKR ${b.amount_mn} Mn`);
  res.json({ ok: true });
}));

router.delete('/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  await pool.query('DELETE FROM budgets WHERE id = ?', [Number(req.params.id)]);
  await audit(null, 'budget', req.params.id, 'delete', req.user.id, null);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.availability = availability;
