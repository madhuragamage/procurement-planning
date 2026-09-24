const pool = require('./db');
const rules = require('./rules');
const { HttpError, num, optString, optDate, oneOf, reqString } = require('./util');

const ITEM_SELECT = `
  SELECT i.*, r.ref_no, r.department_id, d.name AS department, d.code AS department_code,
         r.category_id, c.name AS category, c.manual_type, r.priority, r.required_date
  FROM plan_items i
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  JOIN categories c ON c.id = r.category_id`;

const EDITABLE_STATES = ['planning', 'changes_requested'];

async function getPlan(fy, conn) {
  const db = conn || pool;
  const [rows] = await db.query('SELECT * FROM plans WHERE fy = ?', [fy]);
  return rows[0] || null;
}

async function ensurePlan(fy, conn) {
  const db = conn || pool;
  await db.query('INSERT IGNORE INTO plans (fy) VALUES (?)', [fy]);
  return getPlan(fy, conn);
}

// Plan contents may only be edited directly while planning / after management returned it.
// After that (submitted, approved, frozen) the only route is a revision.
async function assertPlanEditable(fy, conn) {
  const plan = await getPlan(fy, conn);
  const status = plan ? plan.status : 'planning';
  if (EDITABLE_STATES.includes(status)) return plan;
  const why = status === 'submitted' ? 'is awaiting management approval'
    : status === 'approved' ? 'has been approved'
    : 'is frozen';
  throw new HttpError(409, `The ${fy} plan ${why} and cannot be edited directly. Raise a plan revision instead.`);
}

async function loadItems(fy, conn) {
  const [rows] = await (conn || pool).query(`${ITEM_SELECT} WHERE i.plan_fy = ? ORDER BY i.year_offset, d.name, i.id`, [fy]);
  return rows;
}

async function loadItem(id, conn) {
  const [rows] = await (conn || pool).query(`${ITEM_SELECT} WHERE i.id = ?`, [id]);
  return rows[0] || null;
}

// Validates and normalises the fields procurement may set on a plan item. Only keys present in
// `body` are returned, so this serves both create and partial update.
function parseItemFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = reqString(body.title, 'Title');
  if (body.description !== undefined) out.description = optString(body.description);
  if (body.tce_excl_vat_mn !== undefined) out.tce_excl_vat_mn = num(body.tce_excl_vat_mn, 'TCE (excl. VAT)', { max: 1e7 });
  if (body.vat_pct !== undefined) out.vat_pct = num(body.vat_pct, 'VAT %', { max: 100 });
  if (body.funding_source !== undefined) out.funding_source = oneOf(body.funding_source, ['GOSL', 'Foreign'], 'Funding source');
  if (body.funding_agency !== undefined) out.funding_agency = optString(body.funding_agency, 120);
  if (body.year_offset !== undefined) out.year_offset = num(body.year_offset, 'Year', { min: 0, max: 2 });
  if (body.method !== undefined) out.method = body.method === '' || body.method === null ? null : oneOf(body.method, rules.METHODS, 'Method');
  if (body.bidding_procedure !== undefined) out.bidding_procedure = body.bidding_procedure === '' || body.bidding_procedure === null ? null : oneOf(body.bidding_procedure, rules.BIDDING_PROCEDURES, 'Bidding procedure');
  if (body.prequalification !== undefined) out.prequalification = body.prequalification ? 1 : 0;
  if (body.committee_level !== undefined) out.committee_level = body.committee_level === '' || body.committee_level === null ? null : oneOf(body.committee_level, rules.COMMITTEE_LEVELS, 'Committee level');
  if (body.procurement_start !== undefined) out.procurement_start = optDate(body.procurement_start, 'Procurement start');
  if (body.expected_delivery !== undefined) out.expected_delivery = optDate(body.expected_delivery, 'Expected delivery');
  if (body.remarks !== undefined) out.remarks = optString(body.remarks);
  const s = out.procurement_start, e = out.expected_delivery;
  if (s && e && e < s) throw new HttpError(400, 'Expected delivery cannot be before the procurement start date.');
  return out;
}

function buildInsert(table, fields) {
  const cols = Object.keys(fields);
  return { sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals: cols.map(c => fields[c]) };
}

// Merge a freshly built schedule under any revised/actual dates already recorded.
function mergeSchedule(existing, fresh) {
  const out = {};
  for (const m of rules.MILESTONES) {
    const old = (existing && existing[m.key]) || {};
    const nw = (fresh && fresh[m.key]) || {};
    out[m.key] = { scheduled: nw.scheduled || null, revised: old.revised || null, actual: old.actual || null };
  }
  return out;
}

async function snapshotPlan(conn, fy, label, userId) {
  const plan = await getPlan(fy, conn);
  const items = await loadItems(fy, conn);
  await conn.query(
    'INSERT INTO plan_snapshots (fy, version, label, data, created_by) VALUES (?,?,?,?,?)',
    [fy, plan.version, label, JSON.stringify({ plan, items }), userId || null]
  );
}

// Creates a plan item from an authorised, unplanned request (inside a transaction).
// `viaRevision` skips the editable-plan check because an approved revision is the sanctioned path.
async function createItem(conn, requestId, body, userId, limits, { viaRevision = false } = {}) {
  const [[r]] = await conn.query('SELECT r.*, c.manual_type FROM requests r JOIN categories c ON c.id = r.category_id WHERE r.id = ? FOR UPDATE', [requestId]);
  if (!r) throw new HttpError(404, 'Request not found.');
  if (r.status !== 'authorised') throw new HttpError(409, `Request ${r.ref_no} is not authorised by its department head.`);
  const [[dupe]] = await conn.query('SELECT id FROM plan_items WHERE request_id = ?', [requestId]);
  if (dupe) throw new HttpError(409, `Request ${r.ref_no} is already in a plan.`);
  await ensurePlan(r.plan_fy, conn);
  if (!viaRevision) await assertPlanEditable(r.plan_fy, conn);

  const f = parseItemFields(body);
  const item = {
    request_id: r.id, plan_fy: r.plan_fy, year_offset: r.year_offset, title: r.title, description: r.description,
    tce_excl_vat_mn: r.tce_excl_vat_mn, vat_pct: r.vat_pct, funding_source: r.funding_source, funding_agency: r.funding_agency,
    ...f
  };
  const incl = rules.tceInclVat(item.tce_excl_vat_mn, item.vat_pct);
  if (item.method && !item.committee_level) item.committee_level = rules.committeeLevel(incl, item.funding_source, limits);
  if (item.procurement_start) {
    item.milestones = JSON.stringify(rules.buildSchedule({ start: item.procurement_start, delivery: item.expected_delivery, method: item.method, tceInclMn: incl }));
  }
  const { sql, vals } = buildInsert('plan_items', item);
  const [ins] = await conn.query(sql, vals);
  return { id: ins.insertId, ref_no: r.ref_no, plan_fy: r.plan_fy };
}

// A milestone is overdue when it has no actual date and its current target (revised, else scheduled)
// is already past. Slippage compares an achieved milestone against its original schedule.
function delaySummary(item, today) {
  const overdue = [];
  let slippage = 0;
  const ms = item.milestones || {};
  for (const m of rules.MILESTONES) {
    const e = ms[m.key];
    if (!e) continue;
    const target = e.revised || e.scheduled;
    if (e.actual) {
      if (e.scheduled) slippage = Math.max(slippage, rules.diffDays(e.scheduled, e.actual));
    } else if (target && target < today && item.status !== 'cancelled') {
      overdue.push({ key: m.key, label: m.label, due: target, days: rules.diffDays(target, today) });
    }
  }
  return { overdue, max_overdue_days: overdue.reduce((a, o) => Math.max(a, o.days), 0), max_slippage_days: Math.max(0, slippage) };
}

module.exports = {
  createItem, delaySummary,
  ITEM_SELECT, EDITABLE_STATES, getPlan, ensurePlan, assertPlanEditable, loadItems, loadItem,
  parseItemFields, buildInsert, mergeSchedule, snapshotPlan
};
