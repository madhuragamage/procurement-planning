const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, optString, optDate, num, oneOf, audit, tx } = require('../util');
const lib = require('../planLib');
const { loadLimits } = require('./lookups');

const router = express.Router();
const PROC = ['procurement', 'admin'];

function withDerived(item, limits) {
  const check = rules.checkItem(item, item.manual_type, limits);
  return { ...item, tce_incl_vat_mn: check.tce_incl_vat_mn, checks: check, delay: lib.delaySummary(item, new Date().toISOString().slice(0, 10)) };
}

router.get('/', wrap(async (req, res) => {
  const where = []; const params = [];
  if (req.query.plan_fy) { where.push('i.plan_fy = ?'); params.push(Number(req.query.plan_fy)); }
  if (req.query.status) { where.push('i.status = ?'); params.push(String(req.query.status)); }
  if (req.query.department_id) { where.push('r.department_id = ?'); params.push(Number(req.query.department_id)); }
  if (req.query.category_id) { where.push('r.category_id = ?'); params.push(Number(req.query.category_id)); }
  if (req.query.expense_type) { where.push('r.expense_type = ?'); params.push(String(req.query.expense_type)); }
  const [rows] = await pool.query(`${lib.ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.plan_fy, i.year_offset, d.name, i.id`, params);
  const limits = await loadLimits();
  res.json((await lib.visibleItems(req.user, rows)).map(r => withDerived(r, limits)));
}));

router.get('/:id', wrap(async (req, res) => {
  const found = await lib.loadItem(Number(req.params.id));
  const item = found && (await lib.visibleItems(req.user, [found]))[0];
  if (!item) throw new HttpError(404, 'Plan item not found.');
  const [history] = await pool.query(
    "SELECT a.action, a.comment, a.at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'plan_item' AND a.entity_id = ? ORDER BY a.id", [String(item.id)]);
  res.json({ ...withDerived(item, await loadLimits()), history });
}));

router.post('/', requireRole(...PROC), wrap(async (req, res) => {
  const requestId = Number(req.body.request_id);
  if (!Number.isInteger(requestId)) throw new HttpError(400, 'request_id is required.');
  const limits = await loadLimits();
  const id = await tx(async conn => {
    const created = await lib.createItem(conn, requestId, req.body, req.user.id, limits);
    await audit(conn, 'plan_item', created.id, 'create', req.user.id, `from ${created.ref_no}${created.repeats ? ` with ${created.repeats} recurrent repeat(s)` : ''}`);
    return created.id;
  });
  res.status(201).json(withDerived(await lib.loadItem(id), limits));
}));

router.put('/:id', requireRole(...PROC), wrap(async (req, res) => {
  const limits = await loadLimits();
  await tx(async conn => {
    const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!cur) throw new HttpError(404, 'Plan item not found.');
    await lib.assertPlanEditable(cur.plan_fy, conn);
    const f = lib.parseItemFields(req.body);
    const merged = { ...cur, ...f };
    if (merged.expected_delivery && merged.procurement_start && merged.expected_delivery < merged.procurement_start) {
      throw new HttpError(400, 'Expected delivery cannot be before the procurement start date.');
    }
    const incl = rules.tceInclVat(merged.tce_excl_vat_mn, merged.vat_pct);
    if (req.body.auto_committee) f.committee_level = rules.committeeLevel(incl, merged.funding_source, limits);
    else if (merged.method && !merged.committee_level && f.committee_level === undefined) f.committee_level = rules.committeeLevel(incl, merged.funding_source, limits);
    if (merged.procurement_start && (req.body.regenerate_schedule || !cur.milestones)) {
      const fresh = rules.buildSchedule({ start: merged.procurement_start, delivery: merged.expected_delivery, method: merged.method, tceInclMn: incl });
      f.milestones = JSON.stringify(lib.mergeSchedule(cur.milestones, fresh));
    }
    const cols = Object.keys(f);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    await conn.query(`UPDATE plan_items SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), cur.id]);
    await audit(conn, 'plan_item', cur.id, 'edit', req.user.id, cols.filter(c => c !== 'milestones').join(', '));
  });
  res.json(withDerived(await lib.loadItem(Number(req.params.id)), limits));
}));

router.delete('/:id', requireRole(...PROC), wrap(async (req, res) => {
  await tx(async conn => {
    const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!cur) throw new HttpError(404, 'Plan item not found.');
    await lib.assertPlanEditable(cur.plan_fy, conn);
    // Removing the item itself also removes its projected repeats, so the request can be planned again.
    const [repeats] = cur.recur_index === 0
      ? await conn.query('SELECT id FROM plan_items WHERE request_id = ? AND recur_index > 0', [cur.request_id]) : [[]];
    for (const x of [cur, ...repeats]) {
      await conn.query('DELETE FROM plan_items WHERE id = ?', [x.id]);
      await audit(conn, 'plan_item', x.id, 'remove', req.user.id, x === cur ? 'removed from plan (request stays authorised)' : `recurrent repeat of #${cur.id} removed with it`);
    }
  });
  res.json({ ok: true });
}));

// Working schedule once execution is authorised. GET gives the standard (auto) weeks per milestone for this
// item; PUT applies either those or custom weeks from a start date, writing each milestone's target date.
const autoWeeks = (item, start) => {
  const gaps = rules.milestoneGaps({ method: item.method, tceInclMn: rules.tceInclVat(item.tce_excl_vat_mn, item.vat_pct), manualType: item.manual_type, start, delivery: item.expected_delivery });
  return Object.fromEntries(Object.entries(gaps).map(([k, d]) => [k, Math.round((d / 7) * 10) / 10]));
};

async function schedulable(conn, id) {
  const item = await lib.loadItem(id, conn);
  if (!item) throw new HttpError(404, 'Plan item not found.');
  if (item.status === 'cancelled') throw new HttpError(409, 'This item has been cancelled.');
  if (item.exec_status !== 'accepted') throw new HttpError(409, 'The schedule is set once execution has been authorised.');
  return item;
}

router.get('/:id/schedule', requireRole(...PROC), wrap(async (req, res) => {
  const item = await schedulable(pool, Number(req.params.id));
  const start = optDate(req.query.start, 'Start') || item.schedule_start || item.procurement_start || new Date().toISOString().slice(0, 10);
  res.json({ mode: item.schedule_mode, start, auto_weeks: autoWeeks(item, start), custom_weeks: item.schedule_weeks || null, milestones: rules.MILESTONES });
}));

router.put('/:id/schedule', requireRole(...PROC), wrap(async (req, res) => {
  const mode = oneOf(req.body.mode, ['auto', 'custom'], 'Schedule');
  const start = optDate(req.body.start, 'Start date');
  if (!start) throw new HttpError(400, 'Enter the date the procurement starts.');
  const out = await tx(async conn => {
    const item = await schedulable(conn, Number(req.params.id));
    let weeks = autoWeeks(item, start);
    if (mode === 'custom') {
      weeks = {};
      for (const m of rules.MILESTONES) {
        const v = req.body.weeks && req.body.weeks[m.key];
        weeks[m.key] = v === '' || v == null ? 0 : num(v, `Weeks for "${m.label}"`, { min: 0, max: 260 });
      }
    }
    const dates = rules.scheduleFromWeeks(start, weeks);
    const ms = { ...(item.milestones || {}) };
    for (const m of rules.MILESTONES) ms[m.key] = { scheduled: null, revised: null, actual: null, ...(ms[m.key] || {}), revised: dates[m.key] };
    await conn.query('UPDATE plan_items SET milestones = ?, schedule_mode = ?, schedule_start = ?, schedule_weeks = ? WHERE id = ?',
      [JSON.stringify(ms), mode, start, JSON.stringify(weeks), item.id]);
    const total = Object.values(weeks).reduce((s, w) => s + w, 0);
    await audit(conn, 'plan_item', item.id, 'schedule-set', req.user.id, `${mode} from ${start}: ${Math.round(total * 10) / 10} weeks, completion ${dates.completion}`);
    return { dates, weeks };
  });
  res.json({ ok: true, ...out });
}));

// Progress tracking after approval: revised/actual dates and contract details. The approved
// schedule itself is untouched, so this is allowed on a frozen plan.
router.put('/:id/execution', requireRole(...PROC), wrap(async (req, res) => {
  const limits = await loadLimits();
  await tx(async conn => {
    const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!cur) throw new HttpError(404, 'Plan item not found.');
    const plan = await lib.getPlan(cur.plan_fy, conn);
    if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, 'Progress can be recorded once the plan is approved.');
    if (cur.status === 'cancelled') throw new HttpError(409, 'This item has been cancelled.');
    if (cur.exec_status !== 'accepted') throw new HttpError(409, 'Execution has not been requested by the department and accepted by the procurement unit yet. See Procurement inbox → Execution requests.');

    const f = {};
    const ms = { ...(cur.milestones || {}) };
    let touched = false;
    if (req.body.milestones && typeof req.body.milestones === 'object') {
      for (const m of rules.MILESTONES) {
        const inc = req.body.milestones[m.key];
        if (!inc) continue;
        if (inc.scheduled !== undefined) throw new HttpError(400, 'Scheduled dates are part of the approved plan; change them through a plan revision.');
        const e = { scheduled: null, revised: null, actual: null, ...(ms[m.key] || {}) };
        if (inc.revised !== undefined) e.revised = optDate(inc.revised, `${m.label} revised date`);
        if (inc.actual !== undefined) e.actual = optDate(inc.actual, `${m.label} actual date`);
        ms[m.key] = e; touched = true;
      }
    }
    if (touched) f.milestones = JSON.stringify(ms);
    if (req.body.contractor !== undefined) f.contractor = optString(req.body.contractor, 160);
    if (req.body.award_value_mn !== undefined) f.award_value_mn = req.body.award_value_mn === '' || req.body.award_value_mn === null ? null : num(req.body.award_value_mn, 'Award value', { max: 1e7 });
    if (req.body.contract_date !== undefined) f.contract_date = optDate(req.body.contract_date, 'Contract date');
    if (req.body.remarks !== undefined) f.remarks = optString(req.body.remarks);
    if (req.body.status !== undefined) {
      f.status = oneOf(req.body.status, ['planned', 'in_progress', 'awarded', 'completed'], 'Status');
    } else if (touched) {
      const a = k => ms[k] && ms[k].actual;
      if (a('completion')) f.status = 'completed';
      else if (a('contract_award') || a('signing')) f.status = 'awarded';
      else if (cur.status === 'planned' && Object.values(ms).some(e => e && e.actual)) f.status = 'in_progress';
    }
    const cols = Object.keys(f);
    if (!cols.length) throw new HttpError(400, 'Nothing to update.');
    await conn.query(`UPDATE plan_items SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), cur.id]);
    await audit(conn, 'plan_item', cur.id, 'progress', req.user.id, cols.filter(c => c !== 'milestones').concat(touched ? ['milestones'] : []).join(', '));
  });
  res.json(withDerived(await lib.loadItem(Number(req.params.id)), limits));
}));

module.exports = router;
module.exports.withDerived = withDerived;
