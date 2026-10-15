const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, oneOf, audit, tx } = require('../util');
const lib = require('../planLib');
const rules = require('../rules');
const recurrence = require('../recurrence');
const { EXPENSE_TYPES } = recurrence;
const { loadLimits } = require('./lookups');

const router = express.Router();
const PROC = ['procurement', 'admin'];

async function loadRevision(id, conn) {
  const [rows] = await (conn || pool).query(
    `SELECT v.*, u.name AS created_by_name, dcd.name AS decided_by_name FROM plan_revisions v
     JOIN users u ON u.id = v.created_by LEFT JOIN users dcd ON dcd.id = v.decided_by WHERE v.id = ?`, [id]);
  return rows[0] || null;
}

async function loadChanges(revisionId, conn) {
  const [rows] = await (conn || pool).query(
    `SELECT ch.*, COALESCE(i.title, ra.title) AS item_title, COALESCE(${lib.ITEM_REF}, ra.ref_no) AS item_ref FROM revision_changes ch
     LEFT JOIN plan_items i ON i.id = ch.item_id LEFT JOIN requests r ON r.id = i.request_id
     LEFT JOIN requests ra ON ch.action = 'add' AND ra.id = JSON_EXTRACT(ch.payload, '$.request_id')
     WHERE ch.revision_id = ? ORDER BY ch.id`, [revisionId]);
  return rows;
}

const FIELD_LABEL = {
  title: 'Title', description: 'Description', tce_excl_vat_mn: 'TCE excl. VAT (Mn)', vat_pct: 'VAT %', funding_source: 'Funding', funding_agency: 'Funding agency',
  year_offset: 'Plan year', method: 'Method', bidding_procedure: 'Bidding procedure', prequalification: 'Prequalification', committee_level: 'Committee',
  procurement_start: 'Procurement start', expected_delivery: 'Expected delivery', remarks: 'Remarks'
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const inclOf = (excl, vat) => rules.tceInclVat(excl, vat);

// What a revision does to the plan, for management: every addition, modification (old -> new) and
// cancellation with its value effect (incl. VAT, LKR Mn), and the plan totals before and after.
async function revisionReport(v) {
  const plan = await lib.getPlan(v.plan_fy);
  const items = (await lib.loadItems(v.plan_fy)).filter(i => i.status !== 'cancelled');
  const [org] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  const changes = await loadChanges(v.id);
  const rows = []; let n = 0;
  const totals = { add: 0, addValue: 0, mod: 0, cancel: 0, cancelValue: 0 };
  const byYear = new Map(); const byType = Object.fromEntries(EXPENSE_TYPES.map(t => [t, 0]));
  const effect = (year, type, amount) => { byYear.set(year, (byYear.get(year) || 0) + amount); byType[type] += amount; };
  const yearOf = o => `${v.plan_fy + o}${o === 0 ? ' (annual)' : ' (tentative)'}`;
  const source = c => c.change_request_id ? 'Department' : 'Procurement unit';

  for (const c of changes) {
    if (c.action === 'add') {
      const [[r]] = await pool.query('SELECT r.*, d.name AS department FROM requests r JOIN departments d ON d.id = r.department_id WHERE r.id = ?', [c.payload.request_id]);
      if (!r) continue;
      const p = { ...c.payload };
      const value = inclOf(r.tce_excl_vat_mn, r.vat_pct);
      totals.add += 1; totals.addValue += value; effect(r.year_offset, r.expense_type, value);
      const detail = [p.method && `method ${p.method}`, p.procurement_start && `start ${p.procurement_start}`, p.expected_delivery && `delivery ${p.expected_delivery}`].filter(Boolean).join(', ');
      rows.push({ no: ++n, action: 'Addition', ref_no: r.ref_no, title: r.title, department: r.department, expense: r.expense_type, year: yearOf(r.year_offset),
        change: 'New item', current: '', proposed: detail, effect: r2(value), reason: c.reason, source: source(c) });
      if (r.recurrence === 'recurrent') {
        for (const x of recurrence.projections({ year_offset: r.year_offset, tce_excl_vat_mn: r.tce_excl_vat_mn, procurement_start: p.procurement_start, expected_delivery: p.expected_delivery }, r.annual_increase_pct)) {
          const xv = inclOf(x.tce_excl_vat_mn, r.vat_pct);
          totals.addValue += xv; effect(x.year_offset, r.expense_type, xv);
          rows.push({ no: '', action: 'Addition', ref_no: `${r.ref_no}/R${x.recur_index}`, title: r.title, department: r.department, expense: r.expense_type, year: yearOf(x.year_offset),
            change: `Recurrent repeat (+${Number(r.annual_increase_pct)}% per year)`, current: '', proposed: x.procurement_start ? `start ${x.procurement_start}` : '', effect: r2(xv), reason: '', source: '' });
        }
      }
      continue;
    }
    const it = await lib.loadItem(c.item_id);
    if (!it) continue;
    const oldValue = inclOf(it.tce_excl_vat_mn, it.vat_pct);
    const common = { ref_no: it.ref_no, title: it.title, department: it.department, expense: it.expense_type, reason: c.reason, source: source(c) };
    if (c.action === 'cancel') {
      totals.cancel += 1; totals.cancelValue += oldValue; effect(it.year_offset, it.expense_type, -oldValue);
      rows.push({ no: ++n, action: 'Cancellation', ...common, year: yearOf(it.year_offset), change: 'Item removed from the plan', current: r2(oldValue) + ' Mn', proposed: '', effect: -r2(oldValue) });
      continue;
    }
    totals.mod += 1;
    const f = lib.parseItemFields(c.payload || {});
    const merged = { ...it, ...f };
    const newValue = inclOf(merged.tce_excl_vat_mn, merged.vat_pct);
    effect(it.year_offset, it.expense_type, -oldValue); effect(merged.year_offset, it.expense_type, newValue);
    // One row per changed field; the value effect sits on the first cost-related row.
    let first = true, effectShown = false;
    const show = (key, x) => key === 'year_offset' ? yearOf(Number(x)) : key === 'prequalification' ? (x ? 'Yes' : 'No') : (x ?? '');
    for (const [k, val] of Object.entries(f)) {
      const money = !effectShown && (k === 'tce_excl_vat_mn' || k === 'vat_pct');
      if (money) effectShown = true;
      rows.push({ no: first ? ++n : '', action: first ? 'Modification' : '', ...(first ? common : { ref_no: '', title: '', department: '', expense: '', reason: '', source: '' }),
        year: first ? yearOf(it.year_offset) : '', change: FIELD_LABEL[k] || k, current: show(k, it[k]), proposed: show(k, val),
        effect: money ? r2(newValue - oldValue) : null });
      first = false;
    }
  }

  const before = items.reduce((s, i) => s + inclOf(i.tce_excl_vat_mn, i.vat_pct), 0);
  const net = [...byYear.values()].reduce((s, x) => s + x, 0);
  return {
    meta: { org: org.length ? org[0].value.name : '', fy: v.plan_fy, plan_status: plan ? plan.status : 'planning', plan_version: plan ? plan.version : 0, generated_at: new Date().toISOString() },
    title: `Plan revision #${v.id} — ${v.title}`,
    subtitle: `${v.kind === 'urgent' ? 'Urgent' : 'Bi-annual'} revision of the ${v.plan_fy}-${v.plan_fy + 2} procurement plan (status: ${v.status}). ${v.justification || ''} Values incl. VAT, LKR million; the effect column is the change to the plan total.`,
    columns: [{ key: 'no', label: 'No.' }, { key: 'action', label: 'Action' }, { key: 'ref_no', label: 'Ref' }, { key: 'title', label: 'Procurement' }, { key: 'department', label: 'Department' },
      { key: 'expense', label: 'CAPEX / OPEX' }, { key: 'year', label: 'Plan year' }, { key: 'change', label: 'Change' }, { key: 'current', label: 'Current' }, { key: 'proposed', label: 'Proposed' },
      { key: 'effect', label: 'Value effect', align: 'right' }, { key: 'reason', label: 'Reason' }, { key: 'source', label: 'Raised by' }],
    rows: rows.length ? [...rows, { _total: true, title: 'Net change to the plan', effect: r2(net) }] : [],
    landscape: true,
    summary: [
      { label: `Additions (+LKR ${r2(totals.addValue)} Mn)`, value: totals.add },
      { label: 'Modifications', value: totals.mod },
      { label: `Cancellations (-LKR ${r2(totals.cancelValue)} Mn)`, value: totals.cancel },
      { label: 'Net change (LKR Mn)', value: (net >= 0 ? '+' : '') + r2(net).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      { label: 'Plan total before (LKR Mn)', value: r2(before).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      { label: 'Plan total after (LKR Mn)', value: r2(before + net).toLocaleString('en-US', { minimumFractionDigits: 2 }) },
      ...EXPENSE_TYPES.filter(t => byType[t]).map(t => ({ label: `Net change ${t} (LKR Mn)`, value: (byType[t] >= 0 ? '+' : '') + r2(byType[t]).toLocaleString('en-US', { minimumFractionDigits: 2 }) })),
      ...[...byYear.entries()].sort((a, b) => a[0] - b[0]).filter(([, x]) => Math.abs(x) > 1e-9).map(([o, x]) => ({ label: `Net change ${v.plan_fy + o} (LKR Mn)`, value: (x >= 0 ? '+' : '') + r2(x).toLocaleString('en-US', { minimumFractionDigits: 2 }) }))
    ]
  };
}

router.get('/', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const params = []; let where = '';
  if (req.query.plan_fy) { where = 'WHERE v.plan_fy = ?'; params.push(Number(req.query.plan_fy)); }
  const [rows] = await pool.query(
    `SELECT v.*, u.name AS created_by_name, (SELECT COUNT(*) FROM revision_changes c WHERE c.revision_id = v.id) AS change_count
     FROM plan_revisions v JOIN users u ON u.id = v.created_by ${where} ORDER BY v.id DESC`, params);
  res.json(rows);
}));

// Requests and items already taken up by a draft or submitted revision of this plan, so they are not offered again.
router.get('/open-claims', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.action, c.item_id, JSON_EXTRACT(c.payload, '$.request_id') AS request_id, v.id AS revision_id FROM revision_changes c
     JOIN plan_revisions v ON v.id = c.revision_id WHERE v.status IN ('draft','submitted') AND v.plan_fy = ?`, [Number(req.query.plan_fy)]);
  res.json({
    requests: rows.filter(r => r.action === 'add').map(r => ({ request_id: Number(r.request_id), revision_id: r.revision_id })),
    cancelled_items: rows.filter(r => r.action === 'cancel').map(r => ({ item_id: r.item_id, revision_id: r.revision_id }))
  });
}));

router.get('/:id/report', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const v = await loadRevision(Number(req.params.id));
  if (!v) throw new HttpError(404, 'Revision not found.');
  res.json(await revisionReport(v));
}));

router.get('/:id', requireRole('admin', 'procurement', 'management', 'executive'), wrap(async (req, res) => {
  const v = await loadRevision(Number(req.params.id));
  if (!v) throw new HttpError(404, 'Revision not found.');
  res.json({ ...v, changes: await loadChanges(v.id) });
}));

router.post('/', requireRole(...PROC), wrap(async (req, res) => {
  const fy = Number(req.body.plan_fy);
  if (!Number.isInteger(fy)) throw new HttpError(400, 'plan_fy is required.');
  const plan = await lib.getPlan(fy);
  if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, `Revisions apply to an approved plan; the ${fy} plan is ${plan ? plan.status.replace('_', ' ') : 'not started'}.`);
  const [r] = await pool.query('INSERT INTO plan_revisions (plan_fy, kind, title, justification, created_by) VALUES (?,?,?,?,?)',
    [fy, oneOf(req.body.kind || 'bi_annual', ['bi_annual', 'urgent'], 'Kind'), reqString(req.body.title, 'Title'), optString(req.body.justification), req.user.id]);
  await audit(null, 'revision', r.insertId, 'create', req.user.id, req.body.title);
  res.status(201).json(await loadRevision(r.insertId));
}));

async function draftRevision(req) {
  const v = await loadRevision(Number(req.params.id));
  if (!v) throw new HttpError(404, 'Revision not found.');
  if (v.status !== 'draft') throw new HttpError(409, 'Only draft revisions can be changed.');
  return v;
}

router.post('/:id/changes', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  const action = oneOf(req.body.action, ['add', 'modify', 'cancel'], 'Action');
  const reason = optString(req.body.reason, 1000);
  let itemId = null; let payload = {};
  if (action === 'add') {
    const requestId = Number(req.body.request_id);
    const [[r]] = await pool.query('SELECT id, status, plan_fy, ref_no FROM requests WHERE id = ?', [requestId]);
    if (!r) throw new HttpError(404, 'Request not found.');
    if (r.status !== 'authorised') throw new HttpError(409, 'Only department-head-authorised requests can be added.');
    if (r.plan_fy !== v.plan_fy) throw new HttpError(400, `Request ${r.ref_no} belongs to the ${r.plan_fy} plan cycle.`);
    const [[dupe]] = await pool.query('SELECT id FROM plan_items WHERE request_id = ?', [requestId]);
    if (dupe) throw new HttpError(409, 'That request is already in the plan.');
    const [[claimed]] = await pool.query(
      `SELECT v.id FROM revision_changes c JOIN plan_revisions v ON v.id = c.revision_id
       WHERE c.action = 'add' AND v.status IN ('draft','submitted') AND JSON_EXTRACT(c.payload, '$.request_id') = ?`, [requestId]);
    if (claimed) throw new HttpError(409, `Request ${r.ref_no} is already being added by revision #${claimed.id}.`);
    payload = { request_id: requestId, ...req.body.payload };
    lib.parseItemFields(payload); // validate now so bad data cannot reach approval
    if (!reason) throw new HttpError(400, 'Give a reason for adding this item.');
  } else {
    itemId = Number(req.body.item_id);
    const item = await lib.loadItem(itemId);
    if (!item || item.plan_fy !== v.plan_fy) throw new HttpError(404, 'Plan item not found in this plan.');
    if (item.status === 'cancelled') throw new HttpError(409, 'That item is already cancelled.');
    if (!reason) throw new HttpError(400, 'Give a reason for this change.');
    const [[cancelling]] = await pool.query(
      `SELECT v.id FROM revision_changes c JOIN plan_revisions v ON v.id = c.revision_id
       WHERE c.action = 'cancel' AND c.item_id = ? AND v.status IN ('draft','submitted')`, [itemId]);
    if (cancelling) throw new HttpError(409, `${item.ref_no} is already being cancelled by revision #${cancelling.id}.`);
    if (action === 'modify') {
      payload = req.body.payload || {};
      if (!Object.keys(lib.parseItemFields(payload)).length) throw new HttpError(400, 'Nothing to modify.');
    }
  }
  const [r] = await pool.query('INSERT INTO revision_changes (revision_id, item_id, action, payload, reason) VALUES (?,?,?,?,?)',
    [v.id, itemId, action, JSON.stringify(payload), reason]);
  res.status(201).json({ id: r.insertId });
}));

router.delete('/:id/changes/:cid', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  await tx(async conn => {
    const [[ch]] = await conn.query('SELECT * FROM revision_changes WHERE id = ? AND revision_id = ?', [Number(req.params.cid), v.id]);
    if (!ch) throw new HttpError(404, 'Change not found.');
    await conn.query('DELETE FROM revision_changes WHERE id = ?', [ch.id]);
    // A department's request taken out of the revision goes back to the procurement unit's queue.
    if (ch.change_request_id) {
      await conn.query("UPDATE change_requests SET status = 'pending', revision_id = NULL, decided_by = NULL, decided_at = NULL WHERE id = ?", [ch.change_request_id]);
    }
  });
  res.json({ ok: true });
}));

router.post('/:id/submit', requireRole(...PROC), wrap(async (req, res) => {
  const v = await draftRevision(req);
  const changes = await loadChanges(v.id);
  if (!changes.length) throw new HttpError(400, 'Add at least one change before submitting.');
  await pool.query("UPDATE plan_revisions SET status = 'submitted', submitted_at = NOW() WHERE id = ?", [v.id]);
  await audit(null, 'revision', v.id, 'submit', req.user.id, null);
  res.json({ ok: true });
}));

router.post('/:id/reject', requireRole('management'), wrap(async (req, res) => {
  const v = await loadRevision(Number(req.params.id));
  if (!v || v.status !== 'submitted') throw new HttpError(409, 'Only a submitted revision can be rejected.');
  const comment = optString(req.body.comment, 1000);
  if (!comment) throw new HttpError(400, 'A comment is required.');
  await pool.query("UPDATE plan_revisions SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_comment = ? WHERE id = ?", [req.user.id, comment, v.id]);
  await audit(null, 'revision', v.id, 'reject', req.user.id, comment);
  res.json({ ok: true });
}));

// Approval applies every change atomically, bumps the plan version and stores a snapshot.
router.post('/:id/approve', requireRole('management'), wrap(async (req, res) => {
  const limits = await loadLimits();
  const version = await tx(async conn => {
    const [[v]] = await conn.query('SELECT * FROM plan_revisions WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!v || v.status !== 'submitted') throw new HttpError(409, 'Only a submitted revision can be approved.');
    const [[plan]] = await conn.query('SELECT * FROM plans WHERE fy = ? FOR UPDATE', [v.plan_fy]);
    if (!plan || !['approved', 'frozen'].includes(plan.status)) throw new HttpError(409, 'The plan is not in an approved state.');
    const changes = await loadChanges(v.id, conn);
    for (const ch of changes) {
      if (ch.action === 'add') {
        const created = await lib.createItem(conn, ch.payload.request_id, ch.payload, req.user.id, limits, { viaRevision: true });
        await audit(conn, 'plan_item', created.id, 'revision-add', req.user.id, `revision #${v.id}: ${ch.reason}`);
      } else if (ch.action === 'modify') {
        const [[cur]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [ch.item_id]);
        if (!cur || cur.status === 'cancelled') throw new HttpError(409, `Item #${ch.item_id} can no longer be modified.`);
        const f = lib.parseItemFields(ch.payload);
        const merged = { ...cur, ...f };
        if (merged.procurement_start && (f.procurement_start !== undefined || f.expected_delivery !== undefined || f.method !== undefined)) {
          const incl = rules.tceInclVat(merged.tce_excl_vat_mn, merged.vat_pct);
          f.milestones = JSON.stringify(lib.mergeSchedule(cur.milestones, rules.buildSchedule({ start: merged.procurement_start, delivery: merged.expected_delivery, method: merged.method, tceInclMn: incl })));
        }
        const cols = Object.keys(f);
        await conn.query(`UPDATE plan_items SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => f[c]), cur.id]);
        await audit(conn, 'plan_item', cur.id, 'revision-modify', req.user.id, `revision #${v.id}: ${ch.reason}`);
      } else {
        await conn.query("UPDATE plan_items SET status = 'cancelled', remarks = CONCAT(COALESCE(remarks, ''), IF(remarks IS NULL OR remarks = '', '', ' | '), ?) WHERE id = ?", [`Cancelled by revision #${v.id}: ${ch.reason}`, ch.item_id]);
        await audit(conn, 'plan_item', ch.item_id, 'revision-cancel', req.user.id, `revision #${v.id}: ${ch.reason}`);
      }
    }
    const newVersion = plan.version + 1;
    await conn.query('UPDATE plans SET version = ? WHERE fy = ?', [newVersion, v.plan_fy]);
    await conn.query("UPDATE plan_revisions SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_comment = ?, applied_version = ? WHERE id = ?",
      [req.user.id, optString(req.body.comment, 1000), newVersion, v.id]);
    await lib.snapshotPlan(conn, v.plan_fy, `Revision #${v.id}: ${v.title}`, req.user.id);
    await audit(conn, 'revision', v.id, 'approve', req.user.id, optString(req.body.comment, 1000));
    return newVersion;
  });
  res.json({ ok: true, version });
}));

module.exports = router;
