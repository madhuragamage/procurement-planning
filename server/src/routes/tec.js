const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const tec = require('../tec');
const mailer = require('../mailer');
const lib = require('../planLib');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, optDate, oneOf, audit, tx } = require('../util');

const router = express.Router();
const PROC = ['procurement', 'admin'];
const VIEW = ['procurement', 'admin', 'management', 'executive'];
const ROLES = ['chair', 'member', 'secretary'];
const today = () => new Date().toISOString().slice(0, 10);

async function settings() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'tec'");
  return { reminder_days: rows.length ? Number(rows[0].value.reminder_days) || 7 : 7 };
}
async function orgName() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  return rows.length ? rows[0].value.name : '';
}

const COMMITTEE_SELECT = `
  SELECT t.*, ${lib.ITEM_REF} AS ref_no, i.bid_no, i.title, i.method, i.plan_fy, i.tce_excl_vat_mn, i.vat_pct, d.name AS department, u.name AS created_by_name
  FROM tec_committees t
  JOIN plan_items i ON i.id = t.plan_item_id
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  JOIN users u ON u.id = t.created_by`;

async function loadAssignments(committeeIds) {
  if (!committeeIds.length) return [];
  const [rows] = await pool.query(
    `SELECT a.*, m.name, m.email, m.designation FROM tec_assignments a JOIN tec_members m ON m.id = a.member_id
     WHERE a.committee_id IN (?) ORDER BY FIELD(a.role, 'chair', 'secretary', 'member'), m.name`, [committeeIds]);
  return rows;
}

async function loadCommittee(id, conn) {
  const [[c]] = await (conn || pool).query(`${COMMITTEE_SELECT} WHERE t.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Committee not found.');
  return c;
}

const withState = (c, t) => ({ ...c, overdue: c.status === 'active' && c.due_date < t, days_left: c.status === 'active' ? rules.diffDays(t, c.due_date) : null });

// Records the date of a milestone in the item's schedule if it is still empty (TEC appointment / evaluation).
async function markMilestone(conn, itemId, key, date) {
  const [[it]] = await conn.query('SELECT milestones FROM plan_items WHERE id = ? FOR UPDATE', [itemId]);
  const ms = { ...(it && it.milestones || {}) };
  const e = { scheduled: null, revised: null, actual: null, ...(ms[key] || {}) };
  if (e.actual) return;
  ms[key] = { ...e, actual: date };
  await conn.query('UPDATE plan_items SET milestones = ? WHERE id = ?', [JSON.stringify(ms), itemId]);
}

async function sendAppointment(assignmentId) {
  const [[a]] = await pool.query('SELECT a.*, m.name, m.email FROM tec_assignments a JOIN tec_members m ON m.id = a.member_id WHERE a.id = ?', [assignmentId]);
  const c = await loadCommittee(a.committee_id);
  const mail = tec.appointmentMail({ member: a, role: a.role, c, org: await orgName() });
  const status = await mailer.send({ to: a.email, ...mail, kind: 'tec-appointment', entity: 'tec', entityId: c.id });
  await pool.query('UPDATE tec_assignments SET appointment_sent_at = NOW() WHERE id = ?', [a.id]);
  return status;
}

async function sendReminder(a, c, kind, t, org) {
  const mail = tec.reminderMail({ member: a, c, kind, today: t, org });
  const status = await mailer.send({ to: a.email, ...mail, kind: `tec-reminder-${kind}`, entity: 'tec', entityId: c.id });
  if (kind === 'before') await pool.query('UPDATE tec_assignments SET reminder_before_at = NOW() WHERE id = ?', [a.id]);
  if (kind === 'overdue') await pool.query('UPDATE tec_assignments SET reminder_overdue_at = NOW() WHERE id = ?', [a.id]);
  return status;
}

// Hourly job: e-mail members who have not submitted, once `reminder_days` before the due date and once
// after it lapses. Each is sent at most once per assignment (extending the due date re-arms them).
async function runReminders() {
  const t = today();
  const { reminder_days: lead } = await settings();
  const org = await orgName();
  const [committees] = await pool.query(`${COMMITTEE_SELECT} WHERE t.status = 'active'`);
  let sent = 0;
  for (const c of committees) {
    const before = c.due_date >= t && rules.diffDays(t, c.due_date) <= lead;
    const lapsed = c.due_date < t;
    if (!before && !lapsed) continue;
    for (const a of await loadAssignments([c.id])) {
      if (a.submitted_on) continue;
      if (before && !a.reminder_before_at) { await sendReminder(a, c, 'before', t, org); sent += 1; }
      if (lapsed && !a.reminder_overdue_at) { await sendReminder(a, c, 'overdue', t, org); sent += 1; }
    }
  }
  return sent;
}

router.get('/status', requireRole(...VIEW), wrap(async (req, res) => {
  res.json({ email_configured: mailer.configured(), ...(await settings()) });
}));

// ---- Members directory with performance ----
router.get('/members', requireRole(...VIEW), wrap(async (req, res) => {
  const t = today();
  const [members] = await pool.query('SELECT m.*, d.name AS department FROM tec_members m LEFT JOIN departments d ON d.id = m.department_id ORDER BY m.active DESC, m.name');
  const [rows] = await pool.query(
    `SELECT a.member_id, a.submitted_on, t.due_date, t.appointed_on, t.status AS committee_status
     FROM tec_assignments a JOIN tec_committees t ON t.id = a.committee_id WHERE t.status <> 'cancelled'`);
  res.json(members.map(m => ({ ...m, performance: tec.performance(rows.filter(r => r.member_id === m.id), t) })));
}));

router.get('/members/:id', requireRole(...VIEW), wrap(async (req, res) => {
  const [[m]] = await pool.query('SELECT m.*, d.name AS department FROM tec_members m LEFT JOIN departments d ON d.id = m.department_id WHERE m.id = ?', [Number(req.params.id)]);
  if (!m) throw new HttpError(404, 'Member not found.');
  const [history] = await pool.query(
    `SELECT a.role, a.submitted_on, a.appointment_sent_at, a.reminder_before_at, a.reminder_overdue_at, t.id AS committee_id, t.appointed_on, t.due_date, t.status AS committee_status,
            ${lib.ITEM_REF} AS ref_no, i.title
     FROM tec_assignments a JOIN tec_committees t ON t.id = a.committee_id JOIN plan_items i ON i.id = t.plan_item_id JOIN requests r ON r.id = i.request_id
     WHERE a.member_id = ? ORDER BY t.appointed_on DESC`, [m.id]);
  const t = today();
  res.json({ ...m, performance: tec.performance(history.filter(h => h.committee_status !== 'cancelled'), t), history });
}));

function parseMember(body) {
  const email = reqString(body.email, 'E-mail', 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid e-mail address.');
  return {
    name: reqString(body.name, 'Name', 120), email, designation: optString(body.designation, 120),
    department_id: body.department_id ? Number(body.department_id) : null, phone: optString(body.phone, 40),
    active: body.active === undefined ? 1 : (body.active ? 1 : 0)
  };
}
router.post('/members', requireRole(...PROC), wrap(async (req, res) => {
  const m = parseMember(req.body);
  const [r] = await pool.query('INSERT INTO tec_members (name, email, designation, department_id, phone, active) VALUES (?,?,?,?,?,?)', [m.name, m.email, m.designation, m.department_id, m.phone, m.active]);
  await audit(null, 'tec_member', r.insertId, 'create', req.user.id, m.name);
  res.status(201).json({ id: r.insertId });
}));
router.put('/members/:id', requireRole(...PROC), wrap(async (req, res) => {
  const m = parseMember(req.body);
  await pool.query('UPDATE tec_members SET name=?, email=?, designation=?, department_id=?, phone=?, active=? WHERE id=?', [m.name, m.email, m.designation, m.department_id, m.phone, m.active, Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---- Committees ----
router.get('/committees', requireRole(...VIEW), wrap(async (req, res) => {
  const where = []; const params = [];
  if (req.query.plan_fy) { where.push('i.plan_fy = ?'); params.push(Number(req.query.plan_fy)); }
  if (req.query.status) { where.push('t.status = ?'); params.push(String(req.query.status)); }
  if (req.query.plan_item_id) { where.push('t.plan_item_id = ?'); params.push(Number(req.query.plan_item_id)); }
  const [rows] = await pool.query(`${COMMITTEE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.status = 'active' DESC, t.due_date`, params);
  const members = await loadAssignments(rows.map(r => r.id));
  const t = today();
  res.json(rows.map(c => ({ ...withState(c, t), members: members.filter(m => m.committee_id === c.id) })));
}));

router.get('/committees/:id', requireRole(...VIEW), wrap(async (req, res) => {
  const c = await loadCommittee(Number(req.params.id));
  const [emails] = await pool.query("SELECT id, to_email, subject, kind, status, error, created_at FROM email_log WHERE entity = 'tec' AND entity_id = ? ORDER BY id DESC", [String(c.id)]);
  res.json({ ...withState(c, today()), members: await loadAssignments([c.id]), emails });
}));

function parseRoster(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one member.');
  const seen = new Set();
  const out = list.map(x => {
    const id = Number(x.member_id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Choose each member from the directory.');
    if (seen.has(id)) throw new HttpError(400, 'A member is listed twice.');
    seen.add(id);
    return { member_id: id, role: oneOf(x.role || 'member', ROLES, 'Role') };
  });
  if (out.filter(x => x.role === 'chair').length > 1) throw new HttpError(400, 'Only one chairperson can be appointed.');
  return out;
}

// Appoints a committee for an item whose execution has been accepted, and e-mails every member.
router.post('/committees', requireRole(...PROC), wrap(async (req, res) => {
  const itemId = Number(req.body.plan_item_id);
  const appointed = optDate(req.body.appointed_on, 'Date of appointment') || today();
  const due = optDate(req.body.due_date, 'Due date');
  if (!due) throw new HttpError(400, 'Set the date by which the evaluation must be completed.');
  if (due < appointed) throw new HttpError(400, 'The due date cannot be before the date of appointment.');
  const roster = parseRoster(req.body.members);
  const id = await tx(async conn => {
    const [[it]] = await conn.query('SELECT id, status, exec_status FROM plan_items WHERE id = ?', [itemId]);
    if (!it || it.status === 'cancelled') throw new HttpError(404, 'Plan item not found.');
    if (it.exec_status !== 'accepted') throw new HttpError(409, 'Execution of this procurement has not been accepted yet.');
    const [[open]] = await conn.query("SELECT id FROM tec_committees WHERE plan_item_id = ? AND status = 'active'", [itemId]);
    if (open) throw new HttpError(409, `This procurement already has an active TEC (#${open.id}).`);
    const [members] = await conn.query('SELECT id, active FROM tec_members WHERE id IN (?)', [roster.map(r => r.member_id)]);
    if (members.length !== roster.length || members.some(m => !m.active)) throw new HttpError(400, 'Every member must be an active member of the directory.');
    const [r] = await conn.query('INSERT INTO tec_committees (plan_item_id, appointed_on, due_date, notes, created_by) VALUES (?,?,?,?,?)',
      [itemId, appointed, due, optString(req.body.notes, 2000), req.user.id]);
    for (const m of roster) await conn.query('INSERT INTO tec_assignments (committee_id, member_id, role) VALUES (?,?,?)', [r.insertId, m.member_id, m.role]);
    await markMilestone(conn, itemId, 'appoint_bec', appointed);
    await audit(conn, 'plan_item', itemId, 'tec-appointed', req.user.id, `TEC #${r.insertId}, ${roster.length} member(s), due ${due}`);
    return r.insertId;
  });
  const statuses = [];
  for (const a of await loadAssignments([id])) statuses.push(await sendAppointment(a.id));
  res.status(201).json({ id, emails: statuses });
}));

async function activeCommittee(id) {
  const c = await loadCommittee(id);
  if (c.status !== 'active') throw new HttpError(409, 'This committee is no longer active.');
  return c;
}

router.post('/committees/:id/members', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const [m] = parseRoster([req.body]);
  const [[mem]] = await pool.query('SELECT active FROM tec_members WHERE id = ?', [m.member_id]);
  if (!mem || !mem.active) throw new HttpError(400, 'Choose an active member of the directory.');
  if (m.role === 'chair') {
    const [[chair]] = await pool.query("SELECT id FROM tec_assignments WHERE committee_id = ? AND role = 'chair'", [c.id]);
    if (chair) throw new HttpError(400, 'This committee already has a chairperson.');
  }
  const [r] = await pool.query('INSERT INTO tec_assignments (committee_id, member_id, role) VALUES (?,?,?)', [c.id, m.member_id, m.role]);
  const email = await sendAppointment(r.insertId);
  res.status(201).json({ id: r.insertId, email });
}));

router.delete('/committees/:id/members/:aid', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const [r] = await pool.query('DELETE FROM tec_assignments WHERE id = ? AND committee_id = ? AND submitted_on IS NULL', [Number(req.params.aid), c.id]);
  if (!r.affectedRows) throw new HttpError(409, 'Only a member who has not submitted can be removed.');
  res.json({ ok: true });
}));

// Changing the due date (e.g. an extension) re-arms both reminders for members who have not submitted.
router.put('/committees/:id', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const due = optDate(req.body.due_date, 'Due date') || c.due_date;
  if (due < c.appointed_on) throw new HttpError(400, 'The due date cannot be before the date of appointment.');
  await pool.query('UPDATE tec_committees SET due_date = ?, notes = ? WHERE id = ?', [due, req.body.notes === undefined ? c.notes : optString(req.body.notes, 2000), c.id]);
  if (due !== c.due_date) {
    await pool.query('UPDATE tec_assignments SET reminder_before_at = NULL, reminder_overdue_at = NULL WHERE committee_id = ? AND submitted_on IS NULL', [c.id]);
    await audit(null, 'plan_item', c.plan_item_id, 'tec-extended', req.user.id, `TEC #${c.id}: due ${c.due_date} -> ${due}`);
  }
  res.json({ ok: true });
}));

router.post('/assignments/:aid/submission', requireRole(...PROC), wrap(async (req, res) => {
  const [[a]] = await pool.query('SELECT a.*, t.status, t.appointed_on FROM tec_assignments a JOIN tec_committees t ON t.id = a.committee_id WHERE a.id = ?', [Number(req.params.aid)]);
  if (!a) throw new HttpError(404, 'Assignment not found.');
  if (a.status === 'cancelled') throw new HttpError(409, 'This committee was cancelled.');
  const date = req.body.submitted_on === null ? null : (optDate(req.body.submitted_on, 'Submission date') || today());
  if (date && date < a.appointed_on) throw new HttpError(400, 'The submission date cannot be before the appointment.');
  await pool.query('UPDATE tec_assignments SET submitted_on = ?, remarks = ? WHERE id = ?', [date, optString(req.body.remarks, 500), a.id]);
  res.json({ ok: true });
}));

router.post('/committees/:id/complete', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const date = optDate(req.body.completed_on, 'Completion date') || today();
  if (date < c.appointed_on) throw new HttpError(400, 'The completion date cannot be before the appointment.');
  await tx(async conn => {
    await conn.query("UPDATE tec_committees SET status = 'completed', completed_on = ? WHERE id = ?", [date, c.id]);
    await markMilestone(conn, c.plan_item_id, 'evaluation', date);
    await audit(conn, 'plan_item', c.plan_item_id, 'tec-completed', req.user.id, `TEC #${c.id} report ${date}`);
  });
  res.json({ ok: true });
}));

router.post('/committees/:id/cancel', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const reason = optString(req.body.comment, 500);
  if (!reason) throw new HttpError(400, 'Give the reason for cancelling this committee.');
  await pool.query("UPDATE tec_committees SET status = 'cancelled', notes = CONCAT(COALESCE(notes, ''), IF(notes IS NULL OR notes = '', '', ' | '), ?) WHERE id = ?", [`Cancelled: ${reason}`, c.id]);
  await audit(null, 'plan_item', c.plan_item_id, 'tec-cancelled', req.user.id, reason);
  res.json({ ok: true });
}));

// Reminder sent now by the procurement unit to every member who has not submitted.
router.post('/committees/:id/remind', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const t = today(); const org = await orgName();
  const statuses = [];
  for (const a of await loadAssignments([c.id])) if (!a.submitted_on) statuses.push(await sendReminder(a, c, c.due_date < t ? 'overdue' : 'manual', t, org));
  if (!statuses.length) throw new HttpError(409, 'Every member has already submitted.');
  res.json({ ok: true, emails: statuses });
}));

router.post('/assignments/:aid/resend-appointment', requireRole(...PROC), wrap(async (req, res) => {
  res.json({ ok: true, email: await sendAppointment(Number(req.params.aid)) });
}));

router.put('/settings', requireRole('admin'), wrap(async (req, res) => {
  const days = Number(req.body.reminder_days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new HttpError(400, 'Reminder lead time must be 1-60 days.');
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('tec', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ reminder_days: days })]);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.runReminders = runReminders;
