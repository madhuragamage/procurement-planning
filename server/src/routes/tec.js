const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const tec = require('../tec');
const mailer = require('../mailer');
const lib = require('../planLib');
const progress = require('../progress');
const { requireRole } = require('../middleware/auth');
const { wrap, HttpError, reqString, optString, optDate, oneOf, audit, tx } = require('../util');

// Bid Evaluation Committee (BEC / TEC). A committee has two tasks (stages), each activated separately with
// its own due date: 1 = preparation of bidding documents / specifications (on appointment), 2 = bid
// evaluation (after bid opening). Members submit, and are reminded, per task.
const router = express.Router();
const PROC = ['procurement', 'admin'];
const VIEW = ['procurement', 'admin', 'management', 'executive'];
const ROLES = ['chair', 'member', 'secretary'];
const today = () => new Date().toISOString().slice(0, 10);
const stageNo = v => { const s = Number(v); if (s !== 1 && s !== 2) throw new HttpError(400, 'Task must be 1 or 2.'); return s; };

// Reminder lead time and the signature block used on every BEC e-mail.
async function settings() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'tec'");
  const v = rows.length ? rows[0].value : {};
  return { reminder_days: Number(v.reminder_days) || 7, signature: Object.fromEntries(tec.SIGNATURE_FIELDS.map(k => [k, (v.signature && v.signature[k]) || ''])) };
}
async function orgName() {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  return rows.length ? rows[0].value.name : '';
}
// What every e-mail needs besides the committee: organisation name and signature block.
async function mailContext() {
  return { org: await orgName(), sig: (await settings()).signature };
}

const COMMITTEE_SELECT = `
  SELECT t.*, ${lib.ITEM_REF} AS ref_no, i.bid_no, i.title, i.method, i.plan_fy, i.tce_excl_vat_mn, i.vat_pct, d.name AS department, u.name AS created_by_name,
         i.milestones AS item_milestones, i.schedule_mode, i.schedule_start, i.schedule_weeks
  FROM tec_committees t
  JOIN plan_items i ON i.id = t.plan_item_id
  JOIN requests r ON r.id = i.request_id
  JOIN departments d ON d.id = r.department_id
  JOIN users u ON u.id = t.created_by`;

async function loadStages(committeeIds, conn) {
  if (!committeeIds.length) return [];
  const [rows] = await (conn || pool).query('SELECT * FROM tec_stages WHERE committee_id IN (?) ORDER BY stage', [committeeIds]);
  return rows;
}

// Members with their per-task progress: tasks = { 1: {...}, 2: {...} }.
async function loadAssignments(committeeIds) {
  if (!committeeIds.length) return [];
  const [rows] = await pool.query(
    `SELECT a.*, m.name, m.email, m.designation FROM tec_assignments a JOIN tec_members m ON m.id = a.member_id
     WHERE a.committee_id IN (?) ORDER BY FIELD(a.role, 'chair', 'secretary', 'member'), m.name`, [committeeIds]);
  if (!rows.length) return [];
  const [tasks] = await pool.query('SELECT * FROM tec_task_progress WHERE assignment_id IN (?)', [rows.map(r => r.id)]);
  return rows.map(a => ({ ...a, tasks: Object.fromEntries(tasks.filter(x => x.assignment_id === a.id).map(x => [x.stage, x])) }));
}

async function loadCommittee(id, conn) {
  const [[c]] = await (conn || pool).query(`${COMMITTEE_SELECT} WHERE t.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Committee not found.');
  return c;
}

// The Procurement Time Schedule dates relevant to the BEC, so its task dates can be set to match: the schedule
// set when execution was authorised, else the approved plan dates.
function scheduleFor(item) {
  const d = progress.scheduleDates(item);
  return { source: item.schedule_mode ? `${item.schedule_mode} Time Schedule` : 'approved plan schedule',
    appoint_bec: d.appoint_bec, prep_docs: d.prep_docs, opening: d.opening, evaluation: d.evaluation };
}

// The committee with its two tasks' state and which one is in progress.
function withState(c, stages, t) {
  const st = [1, 2].map(n => {
    const s = stages.find(x => x.committee_id === c.id && x.stage === n);
    if (!s) return { stage: n, label: tec.STAGES[n].label, state: 'not_activated' };
    const state = s.completed_on ? 'completed' : s.due_date < t ? 'overdue' : 'active';
    return { ...s, label: tec.STAGES[n].label, state, days_left: s.completed_on ? null : rules.diffDays(t, s.due_date) };
  });
  const current = c.status !== 'active' ? null : st[1].state !== 'not_activated' && !st[1].completed_on ? 2 : !st[0].completed_on ? 1 : null;
  const cur = current ? st[current - 1] : null;
  return {
    ...c, stages: st, current_stage: current,
    awaiting_stage2: c.status === 'active' && !!st[0].completed_on && st[1].state === 'not_activated',
    overdue: !!cur && cur.state === 'overdue', days_left: cur ? cur.days_left : null, due_date: cur ? cur.due_date : c.due_date,
    schedule: scheduleFor({ milestones: c.item_milestones, schedule_mode: c.schedule_mode, schedule_start: c.schedule_start, schedule_weeks: c.schedule_weeks })
  };
}

// Records the date of a milestone in the item's schedule if it is still empty.
async function markMilestone(conn, itemId, key, date) {
  const [[it]] = await conn.query('SELECT milestones FROM plan_items WHERE id = ? FOR UPDATE', [itemId]);
  const ms = { ...(it && it.milestones || {}) };
  const e = { scheduled: null, revised: null, actual: null, ...(ms[key] || {}) };
  if (e.actual) return;
  ms[key] = { ...e, actual: date };
  await conn.query('UPDATE plan_items SET milestones = ? WHERE id = ?', [JSON.stringify(ms), itemId]);
}

// Task rows for every member of a committee in a stage that is now active.
async function openTasks(conn, committeeId, stage) {
  await conn.query('INSERT IGNORE INTO tec_task_progress (assignment_id, stage) SELECT id, ? FROM tec_assignments WHERE committee_id = ?', [stage, committeeId]);
}

async function sendAppointment(assignmentId) {
  const [[a]] = await pool.query('SELECT a.*, m.name, m.email FROM tec_assignments a JOIN tec_members m ON m.id = a.member_id WHERE a.id = ?', [assignmentId]);
  const c = await loadCommittee(a.committee_id);
  const stages = await loadStages([c.id]);
  const s1 = stages.find(s => s.stage === 1); const s2 = stages.find(s => s.stage === 2);
  const active2 = !!s2 && !s2.completed_on;
  const mail = tec.appointmentMail({ member: a, role: a.role, c: { ...c, due_date: s1 ? s1.due_date : c.due_date, stage_due: s2 && s2.due_date }, today: today(), activeStage: active2 ? 2 : 1, ...(await mailContext()) });
  const status = await mailer.send({ to: a.email, ...mail, kind: 'tec-appointment', entity: 'tec', entityId: c.id });
  await pool.query('UPDATE tec_assignments SET appointment_sent_at = NOW() WHERE id = ?', [a.id]);
  return status;
}

async function sendReminder(a, c, stage, kind, t, ctx) {
  const mail = tec.reminderMail({ member: a, c: { ...c, stage_due: stage.due_date }, stage: stage.stage, kind, today: t, ...ctx });
  const status = await mailer.send({ to: a.email, ...mail, kind: `tec-reminder-${kind}`, entity: 'tec', entityId: c.id });
  const task = a.tasks[stage.stage];
  if (task && kind === 'before') await pool.query('UPDATE tec_task_progress SET reminder_before_at = NOW() WHERE id = ?', [task.id]);
  if (task && kind === 'overdue') await pool.query('UPDATE tec_task_progress SET reminder_overdue_at = NOW() WHERE id = ?', [task.id]);
  return status;
}

// Hourly job: for each task in progress, e-mail members who have not submitted, once `reminder_days`
// before its due date and once after it lapses (extending the due date re-arms them).
async function runReminders() {
  const t = today();
  const { reminder_days: lead } = await settings();
  const ctx = await mailContext();
  const [committees] = await pool.query(`${COMMITTEE_SELECT} WHERE t.status = 'active'`);
  const stages = await loadStages(committees.map(c => c.id));
  let sent = 0;
  for (const c of committees) {
    for (const s of stages.filter(x => x.committee_id === c.id && !x.completed_on)) {
      const before = s.due_date >= t && rules.diffDays(t, s.due_date) <= lead;
      const lapsed = s.due_date < t;
      if (!before && !lapsed) continue;
      for (const a of await loadAssignments([c.id])) {
        const task = a.tasks[s.stage];
        if (!task || task.submitted_on) continue;
        if (before && !task.reminder_before_at) { await sendReminder(a, c, s, 'before', t, ctx); sent += 1; }
        if (lapsed && !task.reminder_overdue_at) { await sendReminder(a, c, s, 'overdue', t, ctx); sent += 1; }
      }
    }
  }
  return sent;
}

router.get('/status', requireRole(...VIEW), wrap(async (req, res) => {
  res.json({ email_configured: mailer.configured(), ...(await settings()), organisation_default: await orgName(), stages: tec.STAGES });
}));

// ---- Members directory with performance (per task) ----
const TASK_ROWS = `
  SELECT a.member_id, a.role, p.stage, p.submitted_on, p.reminder_before_at, p.reminder_overdue_at, s.activated_on, s.due_date, s.completed_on AS stage_completed_on,
         t.id AS committee_id, t.appointed_on, t.status AS committee_status, t.letter_ref, i.bid_no, i.plan_fy, ${lib.ITEM_REF} AS ref_no, i.title
  FROM tec_task_progress p JOIN tec_assignments a ON a.id = p.assignment_id JOIN tec_committees t ON t.id = a.committee_id
  JOIN tec_stages s ON s.committee_id = t.id AND s.stage = p.stage
  JOIN plan_items i ON i.id = t.plan_item_id JOIN requests r ON r.id = i.request_id
  WHERE t.status <> 'cancelled'`;

const memberPerformance = (rows, t) => ({
  ...tec.performance(rows, t),
  by_stage: { 1: tec.performance(rows.filter(r => r.stage === 1), t), 2: tec.performance(rows.filter(r => r.stage === 2), t) }
});

router.get('/members', requireRole(...VIEW), wrap(async (req, res) => {
  const t = today();
  const [members] = await pool.query('SELECT m.*, d.name AS department FROM tec_members m LEFT JOIN departments d ON d.id = m.department_id ORDER BY m.active DESC, m.name');
  const [rows] = await pool.query(TASK_ROWS);
  res.json(members.map(m => ({ ...m, performance: memberPerformance(rows.filter(r => r.member_id === m.id), t) })));
}));

router.get('/members/:id', requireRole(...VIEW), wrap(async (req, res) => {
  const [[m]] = await pool.query('SELECT m.*, d.name AS department FROM tec_members m LEFT JOIN departments d ON d.id = m.department_id WHERE m.id = ?', [Number(req.params.id)]);
  if (!m) throw new HttpError(404, 'Member not found.');
  const [rows] = await pool.query(`${TASK_ROWS} AND a.member_id = ? ORDER BY t.appointed_on DESC, p.stage`, [m.id]);
  const t = today();
  res.json({ ...m, performance: memberPerformance(rows, t), history: rows.map(r => ({ ...r, task: tec.STAGES[r.stage].short, outcome: tec.outcome(r, t) })) });
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
  const [rows] = await pool.query(`${COMMITTEE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.status = 'active' DESC, t.appointed_on DESC`, params);
  const ids = rows.map(r => r.id);
  const [members, stages] = [await loadAssignments(ids), await loadStages(ids)];
  const t = today();
  res.json(rows.map(c => ({ ...withState(c, stages, t), members: members.filter(m => m.committee_id === c.id) })));
}));

router.get('/committees/:id', requireRole(...VIEW), wrap(async (req, res) => {
  const c = await loadCommittee(Number(req.params.id));
  const [emails] = await pool.query("SELECT id, to_email, subject, kind, status, error, created_at FROM email_log WHERE entity = 'tec' AND entity_id = ? ORDER BY id DESC", [String(c.id)]);
  res.json({ ...withState(c, await loadStages([c.id]), today()), members: await loadAssignments([c.id]), emails });
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

// Time Schedule dates for a procurement, shown when appointing its BEC.
router.get('/schedule/:itemId', requireRole(...VIEW), wrap(async (req, res) => {
  const [[it]] = await pool.query('SELECT milestones, schedule_mode, schedule_start, schedule_weeks FROM plan_items WHERE id = ?', [Number(req.params.itemId)]);
  if (!it) throw new HttpError(404, 'Plan item not found.');
  res.json(scheduleFor(it));
}));

// Appoints the BEC for an item whose execution has been accepted. Task 1 (bidding documents / specifications)
// starts on appointment with its own due date; every member is e-mailed.
router.post('/committees', requireRole(...PROC), wrap(async (req, res) => {
  const itemId = Number(req.body.plan_item_id);
  const appointed = optDate(req.body.appointed_on, 'Date of appointment') || today();
  const due = optDate(req.body.due_date, 'Due date for the bidding documents / specifications');
  if (!due) throw new HttpError(400, 'Set the date by which the bidding documents / specifications must be ready.');
  if (due < appointed) throw new HttpError(400, 'The due date cannot be before the date of appointment.');
  const roster = parseRoster(req.body.members);
  const id = await tx(async conn => {
    const [[it]] = await conn.query('SELECT id, status, exec_status FROM plan_items WHERE id = ?', [itemId]);
    if (!it || it.status === 'cancelled') throw new HttpError(404, 'Plan item not found.');
    if (it.exec_status !== 'accepted') throw new HttpError(409, 'Execution of this procurement has not been accepted yet.');
    const [[open]] = await conn.query("SELECT id FROM tec_committees WHERE plan_item_id = ? AND status = 'active'", [itemId]);
    if (open) throw new HttpError(409, `This procurement already has an active BEC (#${open.id}).`);
    const [members] = await conn.query('SELECT id, active FROM tec_members WHERE id IN (?)', [roster.map(r => r.member_id)]);
    if (members.length !== roster.length || members.some(m => !m.active)) throw new HttpError(400, 'Every member must be an active member of the directory.');
    const [r] = await conn.query('INSERT INTO tec_committees (plan_item_id, appointed_on, due_date, letter_ref, notes, created_by) VALUES (?,?,?,?,?,?)',
      [itemId, appointed, due, optString(req.body.letter_ref, 80), optString(req.body.notes, 2000), req.user.id]);
    for (const m of roster) await conn.query('INSERT INTO tec_assignments (committee_id, member_id, role) VALUES (?,?,?)', [r.insertId, m.member_id, m.role]);
    await conn.query('INSERT INTO tec_stages (committee_id, stage, activated_on, due_date) VALUES (?, 1, ?, ?)', [r.insertId, appointed, due]);
    await openTasks(conn, r.insertId, 1);
    await markMilestone(conn, itemId, 'appoint_bec', appointed);
    await audit(conn, 'plan_item', itemId, 'tec-appointed', req.user.id, `BEC #${r.insertId}, ${roster.length} member(s); bidding documents due ${due}`);
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

// Task 2 (bid evaluation) is activated separately - normally once the bids have been opened - so the time
// spent waiting for bids is not counted against the committee.
router.post('/committees/:id/stages/2/activate', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const activated = optDate(req.body.activated_on, 'Start date') || today();
  const due = optDate(req.body.due_date, 'Due date for the bid evaluation');
  if (!due) throw new HttpError(400, 'Set the date by which the bid evaluation must be completed.');
  if (due < activated) throw new HttpError(400, 'The due date cannot be before the start date.');
  await tx(async conn => {
    const stages = await loadStages([c.id], conn);
    const s1 = stages.find(s => s.stage === 1);
    if (!s1 || !s1.completed_on) throw new HttpError(409, 'Complete task 1 (bidding documents / specifications) before starting the bid evaluation.');
    if (stages.some(s => s.stage === 2)) throw new HttpError(409, 'The bid evaluation task has already been started.');
    if (activated < s1.completed_on) throw new HttpError(400, 'The bid evaluation cannot start before the bidding documents were completed.');
    await conn.query('INSERT INTO tec_stages (committee_id, stage, activated_on, due_date) VALUES (?, 2, ?, ?)', [c.id, activated, due]);
    await openTasks(conn, c.id, 2);
    await audit(conn, 'plan_item', c.plan_item_id, 'tec-stage2-started', req.user.id, `BEC #${c.id}: bid evaluation ${activated} -> due ${due}`);
  });
  const ctx = await mailContext();
  const statuses = [];
  for (const a of await loadAssignments([c.id])) {
    const mail = tec.stageActivatedMail({ member: a, c: { ...c, stage_due: due }, stage: 2, today: today(), ...ctx });
    statuses.push(await mailer.send({ to: a.email, ...mail, kind: 'tec-stage2-started', entity: 'tec', entityId: c.id }));
  }
  res.json({ ok: true, emails: statuses });
}));

// Marks a task completed: records its milestone; completing task 2 closes the committee.
router.post('/committees/:id/stages/:stage/complete', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const stage = stageNo(req.params.stage);
  const date = optDate(req.body.completed_on, 'Completion date') || today();
  await tx(async conn => {
    const [[s]] = await conn.query('SELECT * FROM tec_stages WHERE committee_id = ? AND stage = ? FOR UPDATE', [c.id, stage]);
    if (!s) throw new HttpError(409, 'That task has not been started.');
    if (s.completed_on) throw new HttpError(409, 'That task is already completed.');
    if (date < s.activated_on) throw new HttpError(400, 'The completion date cannot be before the task started.');
    await conn.query('UPDATE tec_stages SET completed_on = ? WHERE id = ?', [date, s.id]);
    await markMilestone(conn, c.plan_item_id, tec.STAGES[stage].milestone, date);
    if (stage === 2) await conn.query("UPDATE tec_committees SET status = 'completed', completed_on = ? WHERE id = ?", [date, c.id]);
    await audit(conn, 'plan_item', c.plan_item_id, `tec-stage${stage}-completed`, req.user.id, `BEC #${c.id}: ${tec.STAGES[stage].label} completed ${date}`);
  });
  res.json({ ok: true });
}));

// Extends a task's due date; re-arms its reminders for members who have not submitted.
router.put('/committees/:id/stages/:stage', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const stage = stageNo(req.params.stage);
  const due = optDate(req.body.due_date, 'Due date');
  if (!due) throw new HttpError(400, 'Enter the new due date.');
  const [[s]] = await pool.query('SELECT * FROM tec_stages WHERE committee_id = ? AND stage = ?', [c.id, stage]);
  if (!s || s.completed_on) throw new HttpError(409, 'Only a task in progress can be extended.');
  if (due < s.activated_on) throw new HttpError(400, 'The due date cannot be before the task started.');
  await pool.query('UPDATE tec_stages SET due_date = ? WHERE id = ?', [due, s.id]);
  if (stage === 1) await pool.query('UPDATE tec_committees SET due_date = ? WHERE id = ?', [due, c.id]);
  await pool.query(`UPDATE tec_task_progress p JOIN tec_assignments a ON a.id = p.assignment_id SET p.reminder_before_at = NULL, p.reminder_overdue_at = NULL
                    WHERE a.committee_id = ? AND p.stage = ? AND p.submitted_on IS NULL`, [c.id, stage]);
  await audit(null, 'plan_item', c.plan_item_id, 'tec-extended', req.user.id, `BEC #${c.id} ${tec.STAGES[stage].short}: due ${s.due_date} -> ${due}`);
  res.json({ ok: true });
}));

router.put('/committees/:id', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  await pool.query('UPDATE tec_committees SET notes = ?, letter_ref = ? WHERE id = ?', [
    req.body.notes === undefined ? c.notes : optString(req.body.notes, 2000),
    req.body.letter_ref === undefined ? c.letter_ref : optString(req.body.letter_ref, 80), c.id]);
  res.json({ ok: true });
}));

router.post('/committees/:id/members', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const [m] = parseRoster([req.body]);
  const [[mem]] = await pool.query('SELECT active FROM tec_members WHERE id = ?', [m.member_id]);
  if (!mem || !mem.active) throw new HttpError(400, 'Choose an active member of the directory.');
  if (m.role === 'chair') {
    const [[chair]] = await pool.query("SELECT id FROM tec_assignments WHERE committee_id = ? AND role = 'chair'", [c.id]);
    if (chair) throw new HttpError(400, 'This committee already has a chairperson.');
  }
  const id = await tx(async conn => {
    const [r] = await conn.query('INSERT INTO tec_assignments (committee_id, member_id, role) VALUES (?,?,?)', [c.id, m.member_id, m.role]);
    // The new member takes part in the task(s) still in progress.
    for (const s of (await loadStages([c.id], conn)).filter(x => !x.completed_on)) await conn.query('INSERT INTO tec_task_progress (assignment_id, stage) VALUES (?,?)', [r.insertId, s.stage]);
    return r.insertId;
  });
  const email = await sendAppointment(id);
  res.status(201).json({ id, email });
}));

router.delete('/committees/:id/members/:aid', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const [[done]] = await pool.query('SELECT COUNT(*) AS n FROM tec_task_progress WHERE assignment_id = ? AND submitted_on IS NOT NULL', [Number(req.params.aid)]);
  if (done.n) throw new HttpError(409, 'Only a member who has not submitted anything can be removed.');
  const [r] = await pool.query('DELETE FROM tec_assignments WHERE id = ? AND committee_id = ?', [Number(req.params.aid), c.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Member not found on this committee.');
  res.json({ ok: true });
}));

// A member's submission for one task (null clears it).
router.post('/tasks/:pid/submission', requireRole(...PROC), wrap(async (req, res) => {
  const [[p]] = await pool.query(
    `SELECT p.*, s.activated_on, t.status FROM tec_task_progress p JOIN tec_assignments a ON a.id = p.assignment_id JOIN tec_committees t ON t.id = a.committee_id
     JOIN tec_stages s ON s.committee_id = t.id AND s.stage = p.stage WHERE p.id = ?`, [Number(req.params.pid)]);
  if (!p) throw new HttpError(404, 'Task not found.');
  if (p.status === 'cancelled') throw new HttpError(409, 'This committee was cancelled.');
  const date = req.body.submitted_on === null ? null : (optDate(req.body.submitted_on, 'Submission date') || today());
  if (date && date < p.activated_on) throw new HttpError(400, 'The submission date cannot be before the task started.');
  await pool.query('UPDATE tec_task_progress SET submitted_on = ? WHERE id = ?', [date, p.id]);
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

// Reminder sent now to every member who has not submitted the task in progress.
router.post('/committees/:id/remind', requireRole(...PROC), wrap(async (req, res) => {
  const c = await activeCommittee(Number(req.params.id));
  const t = today(); const ctx = await mailContext();
  const s = (await loadStages([c.id])).filter(x => !x.completed_on).sort((a, b) => b.stage - a.stage)[0];
  if (!s) throw new HttpError(409, 'No task is in progress.');
  const statuses = [];
  for (const a of await loadAssignments([c.id])) {
    const task = a.tasks[s.stage];
    if (task && !task.submitted_on) statuses.push(await sendReminder(a, c, s, s.due_date < t ? 'overdue' : 'manual', t, ctx));
  }
  if (!statuses.length) throw new HttpError(409, 'Every member has already submitted this task.');
  res.json({ ok: true, emails: statuses });
}));

router.post('/assignments/:aid/resend-appointment', requireRole(...PROC), wrap(async (req, res) => {
  res.json({ ok: true, email: await sendAppointment(Number(req.params.aid)) });
}));

// Reminder lead time and the signature block (name, designation, unit, organisation, phone, e-mail).
router.put('/settings', requireRole(...PROC), wrap(async (req, res) => {
  const cur = await settings();
  const days = req.body.reminder_days === undefined ? cur.reminder_days : Number(req.body.reminder_days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new HttpError(400, 'Reminder lead time must be 1-60 days.');
  const sig = { ...cur.signature };
  for (const k of tec.SIGNATURE_FIELDS) if (req.body.signature && req.body.signature[k] !== undefined) sig[k] = optString(req.body.signature[k], 160) || '';
  if (sig.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sig.email)) throw new HttpError(400, 'Enter a valid e-mail address for the signature.');
  await pool.query("INSERT INTO settings (`key`, value) VALUES ('tec', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ reminder_days: days, signature: sig })]);
  await audit(null, 'settings', 'tec', 'update', req.user.id, null);
  res.json({ ok: true });
}));

// Sample e-mails with the given (unsaved) signature and reference, for the preview.
router.post('/preview', requireRole(...VIEW), wrap(async (req, res) => {
  const cur = await settings();
  const sig = { ...cur.signature, ...(req.body.signature || {}) };
  const t = today();
  const c = {
    bid_no: 'T/2026/0001', ref_no: 'ENG-2026-0002', title: 'Supply of distribution transformers', department: 'Engineering & Projects', method: 'NCB',
    appointed_on: t, due_date: rules.addDays(t, 21), letter_ref: optString(req.body.letter_ref, 80) || 'PROC/TEC/2026/001'
  };
  const evalStart = rules.addDays(t, 70); const evalDue = rules.addDays(evalStart, 21);
  const org = await orgName();
  const member = { name: 'A. B. Perera' };
  res.json({
    appointment: tec.appointmentMail({ member, role: 'chair', c, today: t, org, sig }),
    reminder: tec.reminderMail({ member, c, kind: 'before', stage: 1, today: rules.addDays(c.due_date, -cur.reminder_days), org, sig }),
    stage2: tec.stageActivatedMail({ member, c: { ...c, stage_due: evalDue }, stage: 2, today: evalStart, org, sig }),
    overdue: tec.reminderMail({ member, c: { ...c, stage_due: evalDue }, kind: 'overdue', stage: 2, today: rules.addDays(evalDue, 1), org, sig })
  });
}));

// ---------- Reports: BEC member progress (per member) and task details ----------
router.get('/reports/:type', requireRole(...VIEW), wrap(async (req, res) => {
  const t = today();
  const fy = Number(req.query.plan_fy) || null;
  const [rows] = await pool.query(
    `SELECT x.*, m.name, m.designation, d.name AS member_department FROM (${TASK_ROWS}${fy ? ' AND i.plan_fy = ?' : ''}) x
     JOIN tec_members m ON m.id = x.member_id LEFT JOIN departments d ON d.id = m.department_id ORDER BY m.name, x.appointed_on, x.stage`, fy ? [fy] : []);
  const list = rows.map(a => ({ ...a, o: tec.outcome(a, t) }));
  const [[org]] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  const meta = { org: org ? org.value.name : '', fy, plan_status: '—', plan_version: '—', generated_at: new Date().toISOString() };
  const count = (xs, k) => xs.filter(x => x.o.key === k).length;
  const avg = xs => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : '');
  const rate = xs => { const decided = xs.filter(x => x.o.key !== 'pending'); return decided.length ? `${Math.round((count(xs, 'on_time') / decided.length) * 1000) / 10}%` : '—'; };
  const scope = fy ? `committees for the ${fy} plan cycle` : 'all committees';
  const byStage = n => list.filter(x => x.stage === n);
  const summary = [
    { label: 'Members appointed', value: new Set(list.map(a => a.member_id)).size }, { label: 'Tasks (both stages)', value: list.length },
    { label: 'Completed within allocated time', value: count(list, 'on_time') }, { label: 'Completed late', value: count(list, 'late') },
    { label: 'Overdue (time lapsed, not submitted)', value: count(list, 'overdue') }, { label: 'In progress (within time)', value: count(list, 'pending') },
    { label: `On-time rate — ${tec.STAGES[1].short.toLowerCase()}`, value: rate(byStage(1)) }, { label: `On-time rate — ${tec.STAGES[2].short.toLowerCase()}`, value: rate(byStage(2)) }
  ];
  const int = { align: 'right', int: true };

  if (req.params.type === 'members') {
    const byMember = new Map();
    for (const a of list) { if (!byMember.has(a.member_id)) byMember.set(a.member_id, []); byMember.get(a.member_id).push(a); }
    const row = (xs, extra) => ({
      ...extra, committees: new Set(xs.map(x => x.committee_id)).size, tasks: xs.length,
      on_time: count(xs, 'on_time'), late: count(xs, 'late'), overdue: count(xs, 'overdue'), pending: count(xs, 'pending'), not_submitted: count(xs, 'not_submitted'),
      avg_allowed: avg(xs.map(x => x.o.allowed)), avg_taken: avg(xs.filter(x => x.o.taken != null).map(x => x.o.taken)),
      avg_late: avg(xs.filter(x => x.o.key === 'late').map(x => x.o.late)),
      rate_prep: rate(xs.filter(x => x.stage === 1)), rate_eval: rate(xs.filter(x => x.stage === 2)), rate: rate(xs)
    });
    const out = [...byMember.values()].map(xs => row(xs, { member: xs[0].name, designation: xs[0].designation || '', department: xs[0].member_department || 'External' }))
      .sort((a, b) => (parseFloat(b.rate) || -1) - (parseFloat(a.rate) || -1) || b.tasks - a.tasks);
    out.forEach((r, n) => { r.no = n + 1; });
    return res.json({
      meta, title: 'BEC member progress — tasks completed within the allocated time',
      subtitle: `Each Bid Evaluation Committee member's two tasks — ${tec.STAGES[1].label.toLowerCase()} (from appointment) and ${tec.STAGES[2].label.toLowerCase()} (from its activation after bid opening) — against the time given for each (${scope}, cancelled committees excluded). As at ${t}. On-time rate = completed within time ÷ tasks whose time has passed or which are closed.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'member', label: 'Member' }, { key: 'designation', label: 'Designation' }, { key: 'department', label: 'Department' },
        { key: 'committees', label: 'Committees', ...int }, { key: 'tasks', label: 'Tasks', ...int }, { key: 'on_time', label: 'Within time', ...int }, { key: 'late', label: 'Late', ...int },
        { key: 'overdue', label: 'Overdue', ...int }, { key: 'pending', label: 'In progress', ...int }, { key: 'not_submitted', label: 'Not submitted', ...int },
        { key: 'avg_allowed', label: 'Avg days allowed', ...int }, { key: 'avg_taken', label: 'Avg days taken', ...int }, { key: 'avg_late', label: 'Avg days late', ...int },
        { key: 'rate_prep', label: `On time: ${tec.STAGES[1].short}`, align: 'right' }, { key: 'rate_eval', label: `On time: ${tec.STAGES[2].short}`, align: 'right' }, { key: 'rate', label: 'On-time rate', align: 'right' }],
      rows: out.length ? [...out, { _total: true, ...row(list, { member: 'All members' }) }] : [],
      summary, landscape: true
    });
  }
  if (req.params.type === 'assignments') {
    const out = [...list].sort((a, b) => a.name.localeCompare(b.name) || String(a.appointed_on).localeCompare(String(b.appointed_on)) || a.committee_id - b.committee_id || a.stage - b.stage).map((a, n) => ({
      no: n + 1, member: a.name, role: tec.ROLE_LABEL[a.role], tec: `#${a.committee_id}${a.letter_ref ? ` (${a.letter_ref})` : ''}`, bid_no: a.bid_no || '', procurement: `${a.ref_no} — ${a.title}`,
      task: `${a.stage}. ${tec.STAGES[a.stage].short}`, started: a.activated_on, due: a.due_date, allowed: a.o.allowed, submitted: a.submitted_on || '', taken: a.o.taken ?? '', result: a.o.label,
      reminders: [a.reminder_before_at && 'before due', a.reminder_overdue_at && 'overdue'].filter(Boolean).join(', ')
    }));
    return res.json({
      meta, title: 'BEC task details — time allowed and taken per task',
      subtitle: `Every BEC member's tasks (${scope}): task 1 ${tec.STAGES[1].label.toLowerCase()} and task 2 ${tec.STAGES[2].label.toLowerCase()}, each with the days allowed (task start to due date), the days taken to submit and the result. As at ${t}.`,
      columns: [{ key: 'no', label: 'No.' }, { key: 'member', label: 'Member' }, { key: 'role', label: 'Role' }, { key: 'tec', label: 'BEC (letter ref)' }, { key: 'bid_no', label: 'Bid No' },
        { key: 'procurement', label: 'Procurement' }, { key: 'task', label: 'Task' }, { key: 'started', label: 'Started' }, { key: 'due', label: 'Due' }, { key: 'allowed', label: 'Days allowed', ...int },
        { key: 'submitted', label: 'Submitted' }, { key: 'taken', label: 'Days taken', ...int }, { key: 'result', label: 'Result' }, { key: 'reminders', label: 'Reminders sent' }],
      rows: out, summary, landscape: true
    });
  }
  throw new HttpError(404, 'Unknown report.');
}));

// ---------- Progress monitoring per task (committee level) ----------
// For each task (1 bidding documents / specifications, 2 bid evaluation): every committee's task with its
// time used, members submitted and result, plus totals. Committees that finished task 1 but have not
// started the bid evaluation are listed separately - that wait (for bids) is not committee time.
async function taskProgress(fy, t) {
  const [committees] = await pool.query(`${COMMITTEE_SELECT} WHERE t.status <> 'cancelled'${fy ? ' AND i.plan_fy = ?' : ''} ORDER BY t.appointed_on`, fy ? [fy] : []);
  const ids = committees.map(c => c.id);
  const [stages, members] = [await loadStages(ids), await loadAssignments(ids)];
  const avg = xs => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : null);
  const out = {};
  for (const n of [1, 2]) {
    const rows = [];
    for (const c of committees) {
      const s = stages.find(x => x.committee_id === c.id && x.stage === n);
      if (!s) continue;
      const mine = members.filter(m => m.committee_id === c.id && m.tasks[n]);
      const submitted = mine.filter(m => m.tasks[n].submitted_on).length;
      const allowed = rules.diffDays(s.activated_on, s.due_date);
      const end = s.completed_on || t;
      const used = rules.diffDays(s.activated_on, end);
      let state, days;
      if (s.completed_on) { days = rules.diffDays(s.due_date, s.completed_on); state = days > 0 ? 'completed_late' : 'completed_on_time'; }
      else if (s.due_date < t) { state = 'overdue'; days = rules.diffDays(s.due_date, t); }
      else { state = 'in_progress'; days = rules.diffDays(t, s.due_date); }
      rows.push({
        committee_id: c.id, bid_no: c.bid_no, ref_no: c.ref_no, title: c.title, department: c.department, letter_ref: c.letter_ref,
        activated_on: s.activated_on, due_date: s.due_date, completed_on: s.completed_on, allowed, used, state, days,
        members: mine.length, submitted, time_pct: allowed > 0 ? Math.min(100, Math.round((used / allowed) * 100)) : 100,
        submitted_pct: mine.length ? Math.round((submitted / mine.length) * 100) : 0
      });
    }
    const done = rows.filter(r => r.completed_on);
    const onTime = rows.filter(r => r.state === 'completed_on_time').length;
    const decided = rows.filter(r => r.state !== 'in_progress');
    const tasks = members.flatMap(m => (m.tasks[n] ? [{ ...m.tasks[n], s: stages.find(x => x.committee_id === m.committee_id && x.stage === n) }] : [])).filter(x => x.s);
    const memberOutcome = tasks.map(x => tec.outcome({ ...x, activated_on: x.s.activated_on, due_date: x.s.due_date, stage_completed_on: x.s.completed_on }, t).key);
    out[n] = {
      stage: n, label: tec.STAGES[n].label, milestone: tec.STAGES[n].milestone,
      summary: {
        started: rows.length, in_progress: rows.filter(r => r.state === 'in_progress').length, overdue: rows.filter(r => r.state === 'overdue').length,
        completed: done.length, completed_on_time: onTime, completed_late: rows.filter(r => r.state === 'completed_late').length,
        on_time_pct: decided.length ? Math.round((onTime / decided.length) * 1000) / 10 : null,
        avg_allowed: avg(rows.map(r => r.allowed)), avg_taken: avg(done.map(r => r.used)),
        avg_late: avg(rows.filter(r => r.state === 'completed_late').map(r => r.days)),
        members: { total: tasks.length, ...Object.fromEntries(['on_time', 'late', 'overdue', 'pending', 'not_submitted'].map(k => [k, memberOutcome.filter(x => x === k).length])) }
      },
      committees: rows
    };
  }
  // Task 1 done, bid evaluation not started yet (waiting for bid opening).
  out.awaiting = committees.filter(c => c.status === 'active').map(c => {
    const s1 = stages.find(x => x.committee_id === c.id && x.stage === 1);
    const s2 = stages.find(x => x.committee_id === c.id && x.stage === 2);
    return s1 && s1.completed_on && !s2 ? { committee_id: c.id, bid_no: c.bid_no, ref_no: c.ref_no, title: c.title, department: c.department, task1_completed: s1.completed_on, waiting_days: rules.diffDays(s1.completed_on, t) } : null;
  }).filter(Boolean);
  return out;
}

router.get('/progress', requireRole(...VIEW), wrap(async (req, res) => {
  res.json({ today: today(), ...(await taskProgress(Number(req.query.plan_fy) || null, today())) });
}));

// Report: progress of each task, committee by committee.
router.get('/reports-progress', requireRole(...VIEW), wrap(async (req, res) => {
  const t = today(); const fy = Number(req.query.plan_fy) || null;
  const p = await taskProgress(fy, t);
  const [[org]] = await pool.query("SELECT value FROM settings WHERE `key` = 'org'");
  const RESULT = { completed_on_time: () => 'Completed within time', completed_late: r => `Completed ${r.days} d late`, overdue: r => `Overdue ${r.days} d`, in_progress: r => `In progress — ${r.days} d left` };
  const rows = [];
  for (const n of [1, 2]) {
    const g = p[n];
    rows.push({ _total: true, task: `Task ${n}: ${g.label}`, result: `${g.summary.started} started · ${g.summary.completed} completed · on time ${g.summary.on_time_pct == null ? '—' : g.summary.on_time_pct + '%'}` });
    for (const r of g.committees) {
      rows.push({ task: `${n}. ${tec.STAGES[n].short}`, bec: `#${r.committee_id}${r.letter_ref ? ` (${r.letter_ref})` : ''}`, bid_no: r.bid_no || '', procurement: `${r.ref_no} — ${r.title}`, department: r.department,
        started: r.activated_on, due: r.due_date, completed: r.completed_on || '', allowed: r.allowed, used: r.used, members: `${r.submitted} of ${r.members}`, result: RESULT[r.state](r) });
    }
  }
  if (p.awaiting.length) {
    rows.push({ _total: true, task: 'Task 1 done — bid evaluation not started (waiting for bids; not counted as BEC time)' });
    for (const a of p.awaiting) rows.push({ task: 'awaiting task 2', bec: `#${a.committee_id}`, bid_no: a.bid_no || '', procurement: `${a.ref_no} — ${a.title}`, department: a.department, completed: '', started: '', due: '', result: `task 1 completed ${a.task1_completed} · waiting ${a.waiting_days} d` });
  }
  const s = n => p[n].summary;
  const int = { align: 'right', int: true };
  res.json({
    meta: { org: org ? org.value.name : '', fy, plan_status: '—', plan_version: '—', generated_at: new Date().toISOString() },
    title: 'BEC / TEC progress by task — bidding documents and bid evaluation',
    subtitle: `Each Bid Evaluation Committee's two tasks monitored separately (${fy ? `committees for the ${fy} plan cycle` : 'all committees'}): task 1 ${tec.STAGES[1].label.toLowerCase()} timed from appointment, task 2 ${tec.STAGES[2].label.toLowerCase()} timed from its start after bid opening. Days used = start to completion (or to today if still open). As at ${t}.`,
    columns: [{ key: 'task', label: 'Task' }, { key: 'bec', label: 'BEC' }, { key: 'bid_no', label: 'Bid No' }, { key: 'procurement', label: 'Procurement' }, { key: 'department', label: 'Department' },
      { key: 'started', label: 'Started' }, { key: 'due', label: 'Due' }, { key: 'completed', label: 'Completed' }, { key: 'allowed', label: 'Days allowed', ...int }, { key: 'used', label: 'Days used', ...int },
      { key: 'members', label: 'Members submitted' }, { key: 'result', label: 'Result' }],
    rows, landscape: true,
    summary: [
      { label: 'Task 1 — in progress / overdue', value: `${s(1).in_progress} / ${s(1).overdue}` }, { label: 'Task 1 — completed on time / late', value: `${s(1).completed_on_time} / ${s(1).completed_late}` },
      { label: 'Task 1 — on-time rate', value: s(1).on_time_pct == null ? '—' : s(1).on_time_pct + '%' }, { label: 'Awaiting bid evaluation start', value: p.awaiting.length },
      { label: 'Task 2 — in progress / overdue', value: `${s(2).in_progress} / ${s(2).overdue}` }, { label: 'Task 2 — completed on time / late', value: `${s(2).completed_on_time} / ${s(2).completed_late}` },
      { label: 'Task 2 — on-time rate', value: s(2).on_time_pct == null ? '—' : s(2).on_time_pct + '%' }
    ]
  });
}));

// Counts for the main dashboard: committees per task and tasks overdue.
async function dashboardCounts() {
  const t = today();
  const [committees] = await pool.query("SELECT id, status FROM tec_committees WHERE status = 'active'");
  const stages = await loadStages(committees.map(c => c.id));
  const states = committees.map(c => withState(c, stages, t));
  return {
    active: states.length, in_stage1: states.filter(c => c.current_stage === 1).length, in_stage2: states.filter(c => c.current_stage === 2).length,
    awaiting_stage2: states.filter(c => c.awaiting_stage2).length, overdue: states.filter(c => c.overdue).length
  };
}

module.exports = router;
module.exports.runReminders = runReminders;
module.exports.dashboardCounts = dashboardCounts;
