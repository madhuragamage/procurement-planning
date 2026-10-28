const pool = require('./db');
const rules = require('./rules');
const { HttpError, num, optString, optDate, oneOf, reqString, isWide, inScope } = require('./util');

const recurrence = require('./recurrence');

// "Main category / Sub category" (categories aliased c), e.g. "Goods / IT-related" - sub names repeat across mains.
const MAIN_CATEGORY_LABEL = { goods: 'Goods', works: 'Works', services: 'Non-Consultancy Services', consultancy: 'Consultancy Services' };
const CATEGORY_LABEL = `CONCAT(CASE c.manual_type ${Object.entries(MAIN_CATEGORY_LABEL).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} END, ' / ', c.name)`;

// Projected repeats of a recurrent request show as REF/R1, REF/R2 (plan items aliased i, requests r).
const ITEM_REF = "CONCAT(r.ref_no, IF(i.recur_index > 0, CONCAT('/R', i.recur_index), ''))";

// A recurrent repeat is needed on the same date in its own year, hence the shifted required_date.
const ITEM_SELECT = `
  SELECT i.*, ${ITEM_REF} AS ref_no, r.department_id, d.name AS department, d.code AS department_code, dv.name AS division,
         r.sub_unit_id, su.name AS sub_unit, r.reason, r.reason_note, r.expense_type, r.recurrence, r.annual_increase_pct, r.budget_phasing,
         r.category_id, ${CATEGORY_LABEL} AS category, c.manual_type, r.priority,
         DATE_ADD(r.required_date, INTERVAL i.recur_index YEAR) AS required_date, bc.code AS budget_code, bc.description AS budget_code_desc
  FROM plan_items i
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN divisions dv ON dv.id = d.division_id
  LEFT JOIN sub_units su ON su.id = r.sub_unit_id
  JOIN categories c ON c.id = r.category_id
  LEFT JOIN budget_codes bc ON bc.id = r.budget_code_id`;

// Department users (requester / dept_head) see only their own unit's items, and only once management
// has approved the plan. Procurement, management, executive and admin see everything.
async function visibleItems(user, items) {
  if (isWide(user)) return items;
  const [rows] = await pool.query("SELECT fy FROM plans WHERE status IN ('approved','frozen')");
  const approved = new Set(rows.map(r => r.fy));
  return items.filter(i => approved.has(i.plan_fy) && inScope(user, i.department_id, i.sub_unit_id));
}

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
// Management may amend the plan only while it is submitted for its approval (then approve or return it).
async function assertPlanEditable(fy, conn, user) {
  const plan = await getPlan(fy, conn);
  const status = plan ? plan.status : 'planning';
  if (user && user.role === 'management') {
    if (status === 'submitted') return plan;
    throw new HttpError(409, `Management can amend the ${fy} plan only while it is submitted for approval (it is ${status.replace('_', ' ')}).`);
  }
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
  if (body.funding_source !== undefined) out.funding_source = oneOf(body.funding_source, rules.FUNDING_SOURCES, 'Funding source');
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
  // A request management removed from the plan comes back only through an approved plan revision.
  const mgmtRejected = r.status === 'rejected' && !!r.mgmt_rejected_at;
  if (r.status !== 'authorised' && !(viaRevision && mgmtRejected)) {
    throw new HttpError(409, mgmtRejected ? `Request ${r.ref_no} was rejected by management; it can return to the plan only through a plan revision.` : `Request ${r.ref_no} is not authorised by its department head.`);
  }
  if (mgmtRejected) {
    await conn.query("UPDATE requests SET status = 'authorised', mgmt_rejected_at = NULL, mgmt_rejected_by = NULL, review_comment = CONCAT(COALESCE(review_comment, ''), ' | returned to the plan by revision') WHERE id = ?", [r.id]);
  }
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
  const [ins] = await insertItem(conn, item, limits, !!f.committee_level);

  // A recurrent need is repeated in each later year of the cycle as a tentative item, escalated yearly.
  const repeats = r.recurrence === 'recurrent' ? recurrence.projections(item, r.annual_increase_pct) : [];
  for (const p of repeats) {
    await insertItem(conn, { ...item, ...p, milestones: undefined, committee_level: f.committee_level ? item.committee_level : undefined }, limits, !!f.committee_level);
  }
  return { id: ins.insertId, ref_no: r.ref_no, plan_fy: r.plan_fy, repeats: repeats.length };
}

// Fills in the committee level (unless chosen explicitly) and draft schedule, then inserts.
function insertItem(conn, item, limits, committeeChosen) {
  const row = { ...item };
  delete row.milestones;
  const incl = rules.tceInclVat(row.tce_excl_vat_mn, row.vat_pct);
  if (row.method && !committeeChosen) row.committee_level = rules.committeeLevel(incl, row.funding_source, limits);
  if (!row.committee_level) delete row.committee_level;
  if (row.procurement_start) {
    row.milestones = JSON.stringify(rules.buildSchedule({ start: row.procurement_start, delivery: row.expected_delivery, method: row.method, tceInclMn: incl }));
  }
  const { sql, vals } = buildInsert('plan_items', row);
  return conn.query(sql, vals);
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
  visibleItems, createItem, delaySummary,
  ITEM_SELECT, ITEM_REF, CATEGORY_LABEL, MAIN_CATEGORY_LABEL, EDITABLE_STATES, getPlan, ensurePlan, assertPlanEditable, loadItems, loadItem,
  parseItemFields, buildInsert, mergeSchedule, snapshotPlan
};
