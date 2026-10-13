const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const sup = require('../supplies');
const mailer = require('../mailer');
const lib = require('../planLib');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, optDate, num, oneOf, audit, tx } = require('../util');

const router = express.Router();
const SUP = ['supplies', 'admin'];
const PROC = ['procurement', 'admin'];
const today = () => new Date().toISOString().slice(0, 10);
// Read access: Supplies Unit, procurement, management, Board/CEO, admin, and the Supplies department's head.
const { canViewSupplies } = require('./lookups');
const viewGuard = wrap(async (req, res, next) => {
  if (!(await canViewSupplies(req.user))) throw new HttpError(403, 'Your role is not permitted to do this.');
  next();
});

async function settings() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'supplies'");
  return { ...sup.DEFAULTS, ...(rows.length ? rows[0].value : {}) };
}
async function orgName() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  return rows.length ? rows[0].value.name : '';
}

const SELECT = `
  SELECT sc.*, i.bid_no, i.bid_type, ${lib.ITEM_REF} AS ref_no, i.title, i.method, i.plan_fy, i.tce_excl_vat_mn, i.vat_pct, i.award_value_mn,
         d.name AS department, su.name AS sub_unit, c.name AS category, r.expense_type,
         fu.name AS forwarded_by_name, au.name AS accepted_by_name, ou.name AS officer_name
  FROM supply_contracts sc
  JOIN plan_items i ON i.id = sc.plan_item_id
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  LEFT JOIN sub_units su ON su.id = r.sub_unit_id
  JOIN categories c ON c.id = r.category_id
  JOIN users fu ON fu.id = sc.forwarded_by
  LEFT JOIN users au ON au.id = sc.accepted_by
  LEFT JOIN users ou ON ou.id = sc.officer_id`;

async function loadContract(id, conn) {
  const [[c]] = await (conn || pool).query(`${SELECT} WHERE sc.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Supplies file not found.');
  return c;
}

function withSteps(c, s, t) {
  const st = sup.steps(c, s, t);
  return { ...c, progress: { total: st.total, done: st.done, pct: st.pct, next: st.next, overdue: st.overdue.length },
    delivery_overdue: !!c.delivery_date && c.delivery_date < t && !(c.steps && c.steps.goods_delivered && c.steps.goods_delivered.date) && c.status !== 'closed' };
}

// ---------- Forwarding by the procurement unit after award ----------
router.post('/forward', requireRole(...PROC), wrap(async (req, res) => {
  const itemId = Number(req.body.plan_item_id);
  const id = await tx(async conn => {
    const [[it]] = await conn.query('SELECT * FROM plan_items WHERE id = ? FOR UPDATE', [itemId]);
    if (!it || it.status === 'cancelled') throw new HttpError(404, 'Plan item not found.');
    if (!it.bid_no) throw new HttpError(409, 'Give the procurement its bid number first.');
    const award = it.milestones && it.milestones.contract_award && it.milestones.contract_award.actual;
    if (!['awarded', 'completed'].includes(it.status) && !award) throw new HttpError(409, 'Forward the file once the award has been made (record the contract award date or set the status to awarded).');
    const [[dup]] = await conn.query('SELECT id FROM supply_contracts WHERE plan_item_id = ?', [itemId]);
    if (dup) throw new HttpError(409, 'This file has already been forwarded to the Supplies Department.');
    const [r] = await conn.query(
      `INSERT INTO supply_contracts (plan_item_id, forwarded_on, forwarded_by, forward_note, supplier_name, award_date, local_cost_lkr, steps)
       VALUES (?,?,?,?,?,?,?,?)`,
      [itemId, today(), req.user.id, optString(req.body.note, 500), it.contractor || null, award || it.contract_date || null,
        it.award_value_mn == null ? null : Math.round(it.award_value_mn * 1e6 * 100) / 100, JSON.stringify({ file_received: { date: today() } })]);
    await audit(conn, 'plan_item', itemId, 'forwarded-to-supplies', req.user.id, optString(req.body.note, 500));
    return r.insertId;
  });
  res.status(201).json({ id });
}));

// ---------- Contracts ----------
router.get('/contracts', viewGuard, wrap(async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('sc.status = ?'); params.push(String(req.query.status)); }
  if (req.query.plan_item_id) { where.push('sc.plan_item_id = ?'); params.push(Number(req.query.plan_item_id)); }
  const [rows] = await pool.query(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY FIELD(sc.status, 'forwarded', 'accepted', 'closed'), sc.forwarded_on DESC`, params);
  const s = await settings(); const t = today();
  res.json(rows.map(c => withSteps(c, s, t)));
}));

router.get('/contracts/:id', viewGuard, wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const s = await settings(); const t = today();
  const [bonds] = await pool.query("SELECT * FROM supply_bonds WHERE contract_id = ? ORDER BY FIELD(kind, 'bid', 'performance', 'advance'), id", [c.id]);
  const [deliveries] = await pool.query('SELECT * FROM supply_deliveries WHERE contract_id = ? ORDER BY batch_no', [c.id]);
  const [letters] = await pool.query('SELECT l.*, u.name AS created_by_name FROM supply_letters l JOIN users u ON u.id = l.created_by WHERE contract_id = ? ORDER BY letter_date DESC, id DESC', [c.id]);
  const [extensions] = await pool.query('SELECT * FROM supply_extensions WHERE contract_id = ? ORDER BY requested_on DESC', [c.id]);
  const [emails] = await pool.query("SELECT id, to_email, subject, kind, status, error, created_at FROM email_log WHERE entity = 'supply' AND entity_id = ? ORDER BY id DESC", [String(c.id)]);
  const st = sup.steps(c, s, t);
  res.json({ ...withSteps(c, s, t), step_list: st.list, bonds: bonds.map(b => bondState(b, t, s)), deliveries, letters, extensions, emails, settings: s });
}));

// Supplies Unit officers who can be made responsible for a file.
router.get('/officers', viewGuard, wrap(async (req, res) => {
  const [rows] = await pool.query("SELECT u.id, u.name, u.email, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.role = 'supplies' AND u.active = 1 ORDER BY u.name");
  res.json(rows);
}));

router.post('/contracts/:id/officer', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const officer = Number(req.body.officer_id);
  const [[u]] = await pool.query("SELECT id, name FROM users WHERE id = ? AND role = 'supplies' AND active = 1", [officer]);
  if (!u) throw new HttpError(400, 'Choose an active Supplies Unit officer.');
  await pool.query('UPDATE supply_contracts SET officer_id = ? WHERE id = ?', [u.id, c.id]);
  await audit(null, 'plan_item', c.plan_item_id, 'supplies-officer', req.user.id, u.name);
  res.json({ ok: true });
}));

router.post('/contracts/:id/accept', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  if (c.status !== 'forwarded') throw new HttpError(409, 'This file has already been accepted.');
  const steps = { ...(c.steps || {}), accepted: { date: today() } };
  // The officer who accepts becomes responsible unless another Supplies Unit officer is already assigned.
  const self = req.user.role === 'supplies' ? req.user.id : null;
  await pool.query("UPDATE supply_contracts SET status = 'accepted', accepted_on = ?, accepted_by = ?, officer_id = COALESCE(officer_id, ?), steps = ? WHERE id = ?",
    [today(), req.user.id, self, JSON.stringify(steps), c.id]);
  await audit(null, 'plan_item', c.plan_item_id, 'supplies-accepted', req.user.id, null);
  res.json({ ok: true });
}));

const money = (v, name) => (v === '' || v == null ? null : num(v, name, { max: 1e13 }));
const flag = v => (v ? 1 : 0);

// Award details entered by the Supplies Department (step 2).
router.put('/contracts/:id', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  if (c.status === 'forwarded') throw new HttpError(409, 'Accept the file first.');
  const b = req.body; const s = await settings();
  const email = optString(b.supplier_email, 190);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid supplier e-mail address.');
  const f = {
    supplier_name: optString(b.supplier_name, 200), supplier_address: optString(b.supplier_address, 400), supplier_email: email,
    supplier_phone: optString(b.supplier_phone, 60), supplier_contact: optString(b.supplier_contact, 120),
    award_ref: optString(b.award_ref, 80), award_date: optDate(b.award_date, 'Award date'),
    order_type: b.order_type ? oneOf(b.order_type, ['purchase_order', 'letter_of_acceptance'], 'Order type') : null, order_no: optString(b.order_no, 80),
    local_cost_lkr: money(b.local_cost_lkr, 'Local cost (LKR)'), foreign_currency: b.foreign_currency ? String(b.foreign_currency).toUpperCase().slice(0, 3) : null,
    foreign_cost: money(b.foreign_cost, 'Foreign cost'), incoterm: optString(b.incoterm, 10), freight_lkr: money(b.freight_lkr, 'Freight (LKR)'), insurance_lkr: money(b.insurance_lkr, 'Insurance (LKR)'),
    bid_bond_amount: money(b.bid_bond_amount, 'Bid bond amount'), bid_bond_validity: optDate(b.bid_bond_validity, 'Bid bond validity'), bid_validity: optDate(b.bid_validity, 'Bid validity'),
    delivery_date: optDate(b.delivery_date, 'Delivery date'),
    advance_bond_required: flag(b.advance_bond_required), proof_required: flag(b.proof_required), contract_agreement_required: flag(b.contract_agreement_required),
    payment_mode: oneOf(b.payment_mode || 'local', ['local', 'LC', 'TT'], 'Payment'), fat_required: flag(b.fat_required), duty_waiver_required: flag(b.duty_waiver_required),
    batch_delivery: flag(b.batch_delivery), pb_amount: money(b.pb_amount, 'Performance Bond amount'),
    pb_validity: optDate(b.pb_validity, 'Performance Bond validity'), pb_due: optDate(b.pb_due, 'Performance Bond due date'), pi_due: optDate(b.pi_due, 'Proforma invoice due date'),
    officer_id: b.officer_id ? Number(b.officer_id) : c.officer_id, notes: optString(b.notes, 4000)
  };
  if (!f.supplier_name) throw new HttpError(400, 'Enter the supplier.');
  if (!f.pb_validity && f.delivery_date) f.pb_validity = sup.pbValidity(f.delivery_date, s);
  const cols = Object.keys(f);
  await pool.query(`UPDATE supply_contracts SET ${cols.map(k => k + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(k => f[k]), c.id]);
  // Keep the bid bond in the register in step with the award details.
  if (f.bid_bond_amount) {
    const [[bb]] = await pool.query("SELECT id FROM supply_bonds WHERE contract_id = ? AND kind = 'bid'", [c.id]);
    if (bb) await pool.query('UPDATE supply_bonds SET amount = ?, expiry_date = COALESCE(?, expiry_date) WHERE id = ?', [f.bid_bond_amount, f.bid_bond_validity, bb.id]);
    else await pool.query("INSERT INTO supply_bonds (contract_id, kind, amount, expiry_date, status) VALUES (?, 'bid', ?, ?, 'held')", [c.id, f.bid_bond_amount, f.bid_bond_validity]);
  }
  await audit(null, 'plan_item', c.plan_item_id, 'supplies-updated', req.user.id, null);
  res.json({ ok: true });
}));

// Steps that also keep the bond register up to date.
const BOND_STEP = {
  pb_received: ['performance', 'received_on'], pb_to_legal: ['performance', 'sent_to_legal_on'], pb_legal_cleared: ['performance', 'legal_cleared_on'],
  ab_received: ['advance', 'received_on'], ab_to_legal: ['advance', 'sent_to_legal_on'], ab_legal_cleared: ['advance', 'legal_cleared_on']
};

router.post('/contracts/:id/steps', requireRole(...SUP), wrap(async (req, res) => {
  const key = oneOf(req.body.key, sup.STEP_KEYS, 'Step');
  const date = req.body.date === null ? null : (optDate(req.body.date, 'Date') || today());
  const s = await settings();
  const out = await tx(async conn => {
    const [[c]] = await conn.query('SELECT * FROM supply_contracts WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    if (!c) throw new HttpError(404, 'Supplies file not found.');
    if (c.status === 'forwarded') throw new HttpError(409, 'Accept the file first.');
    if (['file_received', 'accepted'].includes(key)) throw new HttpError(400, 'This step is recorded automatically.');
    const steps = { ...(c.steps || {}) };
    if (date) steps[key] = { date, note: optString(req.body.note, 300) }; else delete steps[key];
    const set = { steps: JSON.stringify(steps) };
    // Informing the supplier starts the clocks for the Performance Bond and proforma invoice.
    if (key === 'supplier_informed' && date) {
      if (!c.pb_due) set.pb_due = rules.addDays(date, s.pb_days);
      if (!c.pi_due) set.pi_due = rules.addDays(date, s.pi_days);
    }
    const cols = Object.keys(set);
    await conn.query(`UPDATE supply_contracts SET ${cols.map(k => k + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(k => set[k]), c.id]);
    if (BOND_STEP[key]) {
      const [kind, col] = BOND_STEP[key];
      const [[bond]] = await conn.query('SELECT id FROM supply_bonds WHERE contract_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', [c.id, kind]);
      if (bond) await conn.query(`UPDATE supply_bonds SET ${col} = ?${col === 'received_on' && date ? ", status = IF(status = 'expected', 'held', status)" : ''} WHERE id = ?`, [date, bond.id]);
      else if (date) {
        await conn.query(`INSERT INTO supply_bonds (contract_id, kind, amount, expiry_date, status, ${col}) VALUES (?,?,?,?, 'held', ?)`,
          [c.id, kind, kind === 'performance' ? c.pb_amount : null, kind === 'performance' ? c.pb_validity : null, date]);
      }
    }
    if (key === 'bid_bond_released') {
      await conn.query(`UPDATE supply_bonds SET status = ?, released_on = ? WHERE contract_id = ? AND kind = 'bid'`, [date ? 'released' : 'held', date, c.id]);
    }
    await audit(conn, 'plan_item', c.plan_item_id, 'supplies-step', req.user.id, `${key}: ${date || 'cleared'}`);
    return { pb_due: set.pb_due || c.pb_due, pi_due: set.pi_due || c.pi_due };
  });
  res.json({ ok: true, ...out });
}));

router.post('/contracts/:id/close', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  if (c.status !== 'accepted') throw new HttpError(409, 'Only an accepted file can be closed.');
  await pool.query("UPDATE supply_contracts SET status = 'closed', closed_on = ? WHERE id = ?", [optDate(req.body.closed_on, 'Close date') || today(), c.id]);
  await audit(null, 'plan_item', c.plan_item_id, 'supplies-closed', req.user.id, optString(req.body.comment, 500));
  res.json({ ok: true });
}));

// ---------- E-mails to the supplier ----------
async function mailSupplier(c, mail, kind, letterKind, userId) {
  if (!c.supplier_email) throw new HttpError(400, 'Enter the supplier\'s e-mail address first.');
  const status = await mailer.send({ to: c.supplier_email, ...mail, kind, entity: 'supply', entityId: c.id });
  if (letterKind) await pool.query('INSERT INTO supply_letters (contract_id, kind, letter_date, summary, created_by) VALUES (?,?,?,?,?)', [c.id, letterKind, today(), `E-mail: ${mail.subject} (${status.replace('_', ' ')})`, userId]);
  return status;
}

router.post('/contracts/:id/remind', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const what = oneOf(req.body.what, ['pb', 'pi', 'delivery'], 'Reminder');
  const t = today(); const org = await orgName();
  const mail = what === 'delivery' ? sup.deliveryReminderMail({ c, today: t, org }) : sup.supplierReminderMail({ c, what, today: t, org });
  const status = await mailSupplier(c, mail, `supply-reminder-${what}`, what === 'delivery' ? 'delay_reminder' : 'pb_pi_request', req.user.id);
  if (what !== 'delivery') await pool.query(`UPDATE supply_contracts SET ${what}_reminded_at = NOW() WHERE id = ?`, [c.id]);
  res.json({ ok: true, email: status });
}));

// ---------- Bond register ----------
function bondState(b, t, s) {
  const days = b.expiry_date ? rules.diffDays(t, b.expiry_date) : null;
  const live = ['held', 'expected'].includes(b.status);
  return { ...b, days_to_expiry: days, expiring: live && days != null && days >= 0 && days <= s.bond_notice_days, expired: live && days != null && days < 0 };
}
function parseBond(body) {
  return {
    kind: oneOf(body.kind, ['bid', 'performance', 'advance'], 'Bond type'), bond_no: optString(body.bond_no, 80), bank: optString(body.bank, 160),
    amount: money(body.amount, 'Amount'), currency: (body.currency || 'LKR').toUpperCase().slice(0, 3),
    issued_on: optDate(body.issued_on, 'Issue date'), expiry_date: optDate(body.expiry_date, 'Expiry date'), received_on: optDate(body.received_on, 'Received date'),
    sent_to_legal_on: optDate(body.sent_to_legal_on, 'Sent to legal'), legal_cleared_on: optDate(body.legal_cleared_on, 'Legal clearance'),
    status: oneOf(body.status || 'held', ['expected', 'held', 'released', 'returned', 'forfeited'], 'Status'), released_on: optDate(body.released_on, 'Release date'),
    extension_requested_on: optDate(body.extension_requested_on, 'Extension requested'), forfeiture_letter_on: optDate(body.forfeiture_letter_on, 'Forfeiture letter'),
    notes: optString(body.notes, 500)
  };
}

router.get('/bonds', viewGuard, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, sc.supplier_name, sc.status AS contract_status, i.bid_no, ${lib.ITEM_REF} AS ref_no, i.title
     FROM supply_bonds b JOIN supply_contracts sc ON sc.id = b.contract_id JOIN plan_items i ON i.id = sc.plan_item_id JOIN requests r ON r.id = i.request_id
     ORDER BY FIELD(b.status, 'held', 'expected', 'released', 'returned', 'forfeited'), b.expiry_date IS NULL, b.expiry_date`);
  const s = await settings(); const t = today();
  res.json(rows.map(b => bondState(b, t, s)));
}));
router.post('/contracts/:id/bonds', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const b = parseBond(req.body);
  const cols = Object.keys(b);
  const [r] = await pool.query(`INSERT INTO supply_bonds (contract_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, [c.id, ...cols.map(k => b[k])]);
  await audit(null, 'plan_item', c.plan_item_id, 'bond-added', req.user.id, `${b.kind} ${b.bond_no || ''}`);
  res.status(201).json({ id: r.insertId });
}));
router.put('/bonds/:bid', requireRole(...SUP), wrap(async (req, res) => {
  const [[old]] = await pool.query('SELECT * FROM supply_bonds WHERE id = ?', [Number(req.params.bid)]);
  if (!old) throw new HttpError(404, 'Bond not found.');
  const b = parseBond({ ...old, ...req.body });
  const cols = Object.keys(b);
  // A new expiry date (extension) re-arms the expiry notice.
  const rearm = b.expiry_date !== old.expiry_date ? ', expiry_notice_at = NULL' : '';
  await pool.query(`UPDATE supply_bonds SET ${cols.map(k => k + ' = ?').join(', ')}${rearm} WHERE id = ?`, [...cols.map(k => b[k]), old.id]);
  res.json({ ok: true });
}));
router.delete('/bonds/:bid', requireRole(...SUP), wrap(async (req, res) => {
  await pool.query('DELETE FROM supply_bonds WHERE id = ?', [Number(req.params.bid)]);
  res.json({ ok: true });
}));

// ---------- Deliveries (batches) and inspection ----------
function parseDelivery(body) {
  return {
    description: optString(body.description, 300), quantity: optString(body.quantity, 80),
    inspection_arranged_on: optDate(body.inspection_arranged_on, 'Inspection arranged'), inspected_on: optDate(body.inspected_on, 'Inspection date'),
    inspection_result: oneOf(body.inspection_result || 'pending', ['pending', 'accepted', 'rejected'], 'Inspection result'), inspected_by: optString(body.inspected_by, 120),
    delivered_on: optDate(body.delivered_on, 'Delivery date'), location: optString(body.location, 120),
    handed_over_on: optDate(body.handed_over_on, 'Handover date'), handed_over_to: optString(body.handed_over_to, 200), notes: optString(body.notes, 500)
  };
}
router.post('/contracts/:id/deliveries', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const d = parseDelivery(req.body);
  const [[mx]] = await pool.query('SELECT COALESCE(MAX(batch_no), 0) AS n FROM supply_deliveries WHERE contract_id = ?', [c.id]);
  const cols = Object.keys(d);
  const [r] = await pool.query(`INSERT INTO supply_deliveries (contract_id, batch_no, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`, [c.id, mx.n + 1, ...cols.map(k => d[k])]);
  res.status(201).json({ id: r.insertId });
}));
router.put('/deliveries/:did', requireRole(...SUP), wrap(async (req, res) => {
  const [[old]] = await pool.query('SELECT * FROM supply_deliveries WHERE id = ?', [Number(req.params.did)]);
  if (!old) throw new HttpError(404, 'Delivery not found.');
  const d = parseDelivery({ ...old, ...req.body });
  const cols = Object.keys(d);
  await pool.query(`UPDATE supply_deliveries SET ${cols.map(k => k + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(k => d[k]), old.id]);
  res.json({ ok: true });
}));
router.delete('/deliveries/:did', requireRole(...SUP), wrap(async (req, res) => {
  await pool.query('DELETE FROM supply_deliveries WHERE id = ?', [Number(req.params.did)]);
  res.json({ ok: true });
}));

// ---------- Letters to suppliers ----------
router.post('/contracts/:id/letters', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const kind = oneOf(req.body.kind, ['acceptance', 'rejection', 'delivery_extension', 'delay_reminder', 'bond_extension_request', 'forfeiture', 'pb_pi_request', 'other'], 'Letter type');
  const [r] = await pool.query('INSERT INTO supply_letters (contract_id, kind, letter_date, reference, summary, created_by) VALUES (?,?,?,?,?,?)',
    [c.id, kind, optDate(req.body.letter_date, 'Letter date') || today(), optString(req.body.reference, 80), optString(req.body.summary, 500), req.user.id]);
  res.status(201).json({ id: r.insertId });
}));
router.delete('/letters/:lid', requireRole(...SUP), wrap(async (req, res) => {
  await pool.query('DELETE FROM supply_letters WHERE id = ?', [Number(req.params.lid)]);
  res.json({ ok: true });
}));

// ---------- Delivery extension / delay waiver requests ----------
router.post('/contracts/:id/extensions', requireRole(...SUP), wrap(async (req, res) => {
  const c = await loadContract(Number(req.params.id));
  const requested = optDate(req.body.requested_delivery, 'Requested delivery date');
  if (!requested) throw new HttpError(400, 'Enter the delivery date the supplier asks for.');
  const [r] = await pool.query('INSERT INTO supply_extensions (contract_id, requested_on, current_delivery, requested_delivery, reason, delay_waiver) VALUES (?,?,?,?,?,?)',
    [c.id, optDate(req.body.requested_on, 'Request date') || today(), c.delivery_date, requested, optString(req.body.reason, 500), flag(req.body.delay_waiver)]);
  res.status(201).json({ id: r.insertId });
}));
// A granted extension moves the contract delivery date; the Performance Bond validity may then need extending.
router.post('/extensions/:eid/decide', requireRole(...SUP), wrap(async (req, res) => {
  const decision = oneOf(req.body.decision, ['granted', 'refused'], 'Decision');
  await tx(async conn => {
    const [[e]] = await conn.query('SELECT * FROM supply_extensions WHERE id = ? FOR UPDATE', [Number(req.params.eid)]);
    if (!e) throw new HttpError(404, 'Request not found.');
    if (e.decision !== 'pending') throw new HttpError(409, 'Already decided.');
    await conn.query('UPDATE supply_extensions SET decision = ?, decided_on = ?, decided_by = ? WHERE id = ?', [decision, optDate(req.body.decided_on, 'Decision date') || today(), optString(req.body.decided_by, 120), e.id]);
    if (decision === 'granted') await conn.query('UPDATE supply_contracts SET delivery_date = ? WHERE id = ?', [e.requested_delivery, e.contract_id]);
  });
  res.json({ ok: true });
}));

router.get('/settings', viewGuard, wrap(async (req, res) => res.json({ ...(await settings()), email_configured: mailer.configured() })));
router.put('/settings', requireRole('admin', 'supplies'), wrap(async (req, res) => {
  const out = {};
  for (const k of Object.keys(sup.DEFAULTS)) {
    const v = Number(req.body[k] === undefined ? sup.DEFAULTS[k] : req.body[k]);
    if (!Number.isInteger(v) || v < 1 || v > 365) throw new HttpError(400, `${k.replace(/_/g, ' ')} must be 1-365 days.`);
    out[k] = v;
  }
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('supplies', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(out)]);
  res.json({ ok: true });
}));

// ---------- Hourly job: supplier reminders and bond expiry notices ----------
async function runJob() {
  const s = await settings(); const t = today(); const org = await orgName();
  const [contracts] = await pool.query(`${SELECT} WHERE sc.status = 'accepted'`);
  let sent = 0;
  for (const c of contracts) {
    if (!c.supplier_email) continue;
    const steps = c.steps || {};
    for (const what of ['pb', 'pi']) {
      const due = c[`${what}_due`]; const got = steps[what === 'pb' ? 'pb_received' : 'pi_received'];
      const last = c[`${what}_reminded_at`];
      const lastDay = last ? new Date(last).toISOString().slice(0, 10) : null;
      // Once the period lapses, remind the supplier and repeat every reminder_interval_days until received.
      if (due && due < t && !(got && got.date) && (!lastDay || rules.diffDays(lastDay, t) >= s.reminder_interval_days)) {
        await mailer.send({ to: c.supplier_email, ...sup.supplierReminderMail({ c, what, today: t, org }), kind: `supply-reminder-${what}`, entity: 'supply', entityId: c.id });
        await pool.query(`UPDATE supply_contracts SET ${what}_reminded_at = NOW() WHERE id = ?`, [c.id]);
        sent += 1;
      }
    }
  }
  // Bond expiry: notify the Supplies Department (all active Supplies users, and the file's officer) once, N days ahead.
  const [bonds] = await pool.query(
    `SELECT b.*, sc.officer_id, sc.supplier_name, i.bid_no, ${lib.ITEM_REF} AS ref_no, i.title FROM supply_bonds b
     JOIN supply_contracts sc ON sc.id = b.contract_id JOIN plan_items i ON i.id = sc.plan_item_id JOIN requests r ON r.id = i.request_id
     WHERE b.status IN ('held','expected') AND b.expiry_date IS NOT NULL AND b.expiry_notice_at IS NULL AND sc.status <> 'closed'`);
  const due = bonds.filter(b => { const d = rules.diffDays(t, b.expiry_date); return d >= 0 && d <= s.bond_notice_days; });
  if (due.length) {
    const [staff] = await pool.query("SELECT id, email FROM users WHERE active = 1 AND role = 'supplies'");
    const [officers] = await pool.query('SELECT id, email FROM users WHERE id IN (?)', [[0, ...due.map(b => b.officer_id).filter(Boolean)]]);
    for (const b of due) {
      const officer = officers.find(u => u.id === b.officer_id);
      const to = [...new Set([...staff.map(u => u.email), ...(officer ? [officer.email] : [])])];
      for (const addr of to) { await mailer.send({ to: addr, ...sup.bondExpiryMail({ b, c: b, today: t }), kind: 'bond-expiry', entity: 'supply', entityId: b.contract_id }); sent += 1; }
      await pool.query('UPDATE supply_bonds SET expiry_notice_at = NOW() WHERE id = ?', [b.id]);
    }
  }
  return sent;
}

// ---------- Reports ----------
const r2 = n => (n == null ? null : Math.round(Number(n) * 100) / 100);
async function reportMeta() { return { org: await orgName(), plan_status: '—', plan_version: '—', generated_at: new Date().toISOString() }; }

router.get('/reports/:type', viewGuard, wrap(async (req, res) => {
  const s = await settings(); const t = today();
  if (req.params.type === 'status') {
    const [rows] = await pool.query(`${SELECT} WHERE sc.status <> 'closed' OR sc.closed_on >= ? ORDER BY sc.forwarded_on`, [rules.addDays(t, -90)]);
    const out = rows.map((c, n) => {
      const st = sup.steps(c, s, t);
      const g = k => (c.steps && c.steps[k] && c.steps[k].date) || '';
      return {
        no: n + 1, bid_no: c.bid_no, ref_no: c.ref_no, title: c.title, department: c.department, supplier: c.supplier_name || '', order_no: c.order_no || '',
        forwarded: c.forwarded_on, accepted: c.accepted_on || '', pb: g('pb_received') || (c.pb_due ? `due ${c.pb_due}` : ''), delivery_due: c.delivery_date || '',
        delivered: g('goods_delivered'), progress: `${st.done}/${st.total} (${st.pct}%)`, next: c.status === 'forwarded' ? 'Accept the file' : st.next ? st.next.label : 'All steps done',
        overdue: st.overdue.map(o => o.label).join('; '), status: c.status
      };
    });
    return res.json({
      meta: await reportMeta(), title: 'Status update schedule — goods and services', subtitle: `All open Supplies Department files (and those closed in the last 90 days), with the next step and anything overdue, as at ${t}.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'bid_no', label: 'Bid No' }, { key: 'ref_no', label: 'Procurement ref' }, { key: 'title', label: 'Description' }, { key: 'department', label: 'Department' },
        { key: 'supplier', label: 'Supplier' }, { key: 'order_no', label: 'P/O / LoA No' }, { key: 'forwarded', label: 'Received' }, { key: 'accepted', label: 'Accepted' }, { key: 'pb', label: 'Performance Bond' },
        { key: 'delivery_due', label: 'Delivery due' }, { key: 'delivered', label: 'Delivered' }, { key: 'progress', label: 'Steps done' }, { key: 'next', label: 'Next step' }, { key: 'overdue', label: 'Overdue' }, { key: 'status', label: 'File' }],
      rows: out, landscape: true,
      summary: [{ label: 'Open files', value: rows.filter(c => c.status !== 'closed').length }, { label: 'Awaiting acceptance', value: rows.filter(c => c.status === 'forwarded').length },
        { label: 'Files with overdue steps', value: out.filter(o => o.overdue).length }, { label: 'Deliveries overdue', value: rows.filter(c => withSteps(c, s, t).delivery_overdue).length }]
    });
  }
  if (req.params.type === 'bonds') {
    const [rows] = await pool.query(
      `SELECT b.*, sc.supplier_name, i.bid_no, ${lib.ITEM_REF} AS ref_no, i.title FROM supply_bonds b JOIN supply_contracts sc ON sc.id = b.contract_id
       JOIN plan_items i ON i.id = sc.plan_item_id JOIN requests r ON r.id = i.request_id ORDER BY b.status <> 'held', b.expiry_date`);
    const KIND = { bid: 'Bid bond', performance: 'Performance Bond', advance: 'Advance Payment Bond' };
    const out = rows.map((b, n) => { const x = bondState(b, t, s); return {
      no: n + 1, kind: KIND[b.kind], bid_no: b.bid_no, ref_no: b.ref_no, supplier: b.supplier_name || '', bond_no: b.bond_no || '', bank: b.bank || '', amount: r2(b.amount), currency: b.currency,
      received: b.received_on || '', legal: b.legal_cleared_on || (b.sent_to_legal_on ? `sent ${b.sent_to_legal_on}` : ''), expiry: b.expiry_date || '',
      state: x.expired ? 'EXPIRED' : x.expiring ? `expires in ${x.days_to_expiry} d` : b.status, notes: [b.extension_requested_on && `extension requested ${b.extension_requested_on}`, b.forfeiture_letter_on && `forfeiture letter ${b.forfeiture_letter_on}`, b.notes].filter(Boolean).join('; ')
    }; });
    return res.json({
      meta: await reportMeta(), title: 'Bond register — bid, performance and advance payment bonds', subtitle: `Expiry notices go to the Supplies Department ${s.bond_notice_days} days before a held bond expires. As at ${t}.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'kind', label: 'Bond' }, { key: 'bid_no', label: 'Bid No' }, { key: 'ref_no', label: 'Procurement ref' }, { key: 'supplier', label: 'Supplier' }, { key: 'bond_no', label: 'Bond No' },
        { key: 'bank', label: 'Bank' }, { key: 'amount', label: 'Amount', align: 'right' }, { key: 'currency', label: 'Cur.' }, { key: 'received', label: 'Received' }, { key: 'legal', label: 'Legal clearance' },
        { key: 'expiry', label: 'Valid until' }, { key: 'state', label: 'Status' }, { key: 'notes', label: 'Notes' }],
      rows: out, landscape: true,
      summary: [{ label: 'Bonds held', value: rows.filter(b => b.status === 'held').length }, { label: `Expiring within ${s.bond_notice_days} days`, value: out.filter(o => /expires in/.test(o.state)).length }, { label: 'Expired, not released', value: out.filter(o => o.state === 'EXPIRED').length }]
    });
  }
  if (req.params.type === 'delay-waiver') {
    const [rows] = await pool.query(
      `SELECT e.*, sc.supplier_name, i.bid_no, ${lib.ITEM_REF} AS ref_no, i.title FROM supply_extensions e JOIN supply_contracts sc ON sc.id = e.contract_id
       JOIN plan_items i ON i.id = sc.plan_item_id JOIN requests r ON r.id = i.request_id ORDER BY e.decision = 'pending' DESC, e.requested_on`);
    const out = rows.map((e, n) => ({
      no: n + 1, bid_no: e.bid_no, ref_no: e.ref_no, title: e.title, supplier: e.supplier_name || '', requested_on: e.requested_on, current: e.current_delivery || '', requested: e.requested_delivery,
      days: e.current_delivery ? rules.diffDays(e.current_delivery, e.requested_delivery) : '', type: e.delay_waiver ? 'Delay waiver' : 'Delivery extension', reason: e.reason || '',
      decision: e.decision === 'pending' ? 'For approval' : `${e.decision} ${e.decided_on || ''}${e.decided_by ? ` (${e.decided_by})` : ''}`
    }));
    return res.json({
      meta: await reportMeta(), title: 'Schedule for approval of delay waivers and delivery extensions', subtitle: 'Supplier requests to waive delay or extend the delivery period, for submission to the approving authority.',
      columns: [{ key: 'no', label: 'No.' }, { key: 'bid_no', label: 'Bid No' }, { key: 'ref_no', label: 'Procurement ref' }, { key: 'title', label: 'Description' }, { key: 'supplier', label: 'Supplier' },
        { key: 'type', label: 'Request' }, { key: 'requested_on', label: 'Requested on' }, { key: 'current', label: 'Current delivery' }, { key: 'requested', label: 'Requested delivery' },
        { key: 'days', label: 'Extension (days)', align: 'right' }, { key: 'reason', label: 'Reason' }, { key: 'decision', label: 'Decision' }],
      rows: out, landscape: true,
      summary: [{ label: 'Awaiting approval', value: rows.filter(e => e.decision === 'pending').length }, { label: 'Granted', value: rows.filter(e => e.decision === 'granted').length }, { label: 'Refused', value: rows.filter(e => e.decision === 'refused').length }]
    });
  }
  throw new HttpError(404, 'Unknown report.');
}));

// Counts for the dashboard.
async function dashboardCounts() {
  const s = await settings(); const t = today();
  const [rows] = await pool.query(`${SELECT} WHERE sc.status <> 'closed'`);
  const list = rows.map(c => ({ c, x: withSteps(c, s, t) }));
  const [bonds] = await pool.query("SELECT * FROM supply_bonds b JOIN supply_contracts sc ON sc.id = b.contract_id WHERE b.status IN ('held','expected') AND sc.status <> 'closed'");
  const states = bonds.map(b => bondState(b, t, s));
  return {
    awaiting_acceptance: rows.filter(c => c.status === 'forwarded').length,
    with_overdue_steps: list.filter(({ x }) => x.progress.overdue > 0).length,
    deliveries_overdue: list.filter(({ x }) => x.delivery_overdue).length,
    bonds_expiring: states.filter(b => b.expiring).length, bonds_expired: states.filter(b => b.expired).length,
    open_files: rows.length
  };
}

module.exports = router;
module.exports.runJob = runJob;
module.exports.dashboardCounts = dashboardCounts;
