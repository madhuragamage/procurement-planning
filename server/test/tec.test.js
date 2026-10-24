const test = require('node:test');
const assert = require('node:assert');
const tec = require('../src/tec');

const row = (appointed_on, due_date, submitted_on, committee_status = 'active') => ({ appointed_on, due_date, submitted_on, committee_status });

test('performance classifies each assignment and averages the timings', () => {
  const p = tec.performance([
    row('2027-01-01', '2027-01-21', '2027-01-15'),             // on time, 14 days taken
    row('2027-02-01', '2027-02-21', '2027-02-25'),             // 4 days late, 24 days taken
    row('2027-03-01', '2027-03-21', null),                     // overdue (today is later)
    row('2027-03-01', '2027-04-30', null),                     // pending
    row('2027-01-01', '2027-01-10', null, 'completed')         // committee closed without this member
  ], '2027-04-01');
  assert.deepStrictEqual(p, {
    assignments: 5, on_time: 1, late: 1, pending: 1, overdue: 1, not_submitted: 1,
    avg_days_taken: 19, avg_days_late: 4, on_time_pct: 25
  });
});

test('performance of a member with no history is empty', () => {
  const p = tec.performance([], '2027-01-01');
  assert.strictEqual(p.assignments, 0);
  assert.strictEqual(p.on_time_pct, null);
});

test('e-mails name the procurement, the role and the due date', () => {
  const c = { ref_no: 'PP-2026-0004', title: 'AC maintenance', department: 'P&P', method: 'NCB', appointed_on: '2026-10-01', due_date: '2026-10-21' };
  const a = tec.appointmentMail({ member: { name: 'A. Perera' }, role: 'chair', c, org: 'LECO' });
  assert.match(a.subject, /PP-2026-0004/);
  assert.match(a.text, /Chairperson/);
  assert.match(a.text, /21 October 2026/);
  const before = tec.reminderMail({ member: { name: 'A. Perera' }, c, kind: 'before', today: '2026-10-14' });
  assert.match(before.text, /7 days from today/);
  const late = tec.reminderMail({ member: { name: 'A. Perera' }, c, kind: 'overdue', today: '2026-10-23' });
  assert.match(late.subject, /^OVERDUE/);
  assert.match(late.text, /2 days ago/);
});

test('e-mails carry the date, letter reference and signature block', () => {
  const c = { bid_no: 'T/2026/0001', ref_no: 'ENG-2026-0002', title: 'Transformers', department: 'Engineering', appointed_on: '2026-10-13', due_date: '2026-11-03', letter_ref: 'PROC/TEC/2026/014' };
  const sig = { signatory_name: 'K. L. Fernando', signatory_designation: 'Procurement Manager', unit: 'Procurement Unit, P&P Division', organisation: '', phone: '+94 11 2345678', email: 'procurement@leco.lk' };
  const a = tec.appointmentMail({ member: { name: 'A. Perera' }, role: 'member', c, org: 'Lanka Electricity Company (Pvt) Ltd', sig, today: '2026-10-13' });
  assert.match(a.text, /^Date: 13 October 2026\nOur ref: PROC\/TEC\/2026\/014\n/);
  assert.match(a.subject, /\(Ref: PROC\/TEC\/2026\/014\)/);
  assert.match(a.text, /K\. L\. Fernando\nProcurement Manager\nProcurement Unit, P&P Division\nLanka Electricity Company \(Pvt\) Ltd\nTel: \+94 11 2345678\nE-mail: procurement@leco\.lk$/);
  const r = tec.reminderMail({ member: { name: 'A. Perera' }, c, kind: 'before', today: '2026-10-27', sig });
  assert.match(r.text, /Appointment letter: PROC\/TEC\/2026\/014 dated 13 October 2026/);
  // nothing configured: falls back to the organisation, no reference line
  const bare = tec.appointmentMail({ member: { name: 'A' }, role: 'member', c: { ...c, letter_ref: null }, org: 'LECO', today: '2026-10-13' });
  assert.doesNotMatch(bare.text, /Our ref/);
  assert.match(bare.text, /Thank you\.\n\nLECO$/);
});

test('the BEC has two tasks tied to their milestones', () => {
  assert.strictEqual(tec.STAGES[1].milestone, 'prep_docs');
  assert.strictEqual(tec.STAGES[2].milestone, 'evaluation');
});

test('each task is measured from its own activation, not the appointment', () => {
  const rows = [
    // task 1: appointed 1 Jan, due 21 Jan, submitted 20 Jan -> on time
    { stage: 1, appointed_on: '2027-01-01', activated_on: '2027-01-01', due_date: '2027-01-21', submitted_on: '2027-01-20' },
    // task 2: started 1 Apr (after bid opening), due 21 Apr, submitted 24 Apr -> 3 days late, 23 days taken
    { stage: 2, appointed_on: '2027-01-01', activated_on: '2027-04-01', due_date: '2027-04-21', submitted_on: '2027-04-24' }
  ];
  const o2 = tec.outcome(rows[1], '2027-05-01');
  assert.deepStrictEqual([o2.key, o2.allowed, o2.taken, o2.late], ['late', 20, 23, 3]);
  const p = tec.performance(rows, '2027-05-01');
  assert.deepStrictEqual([p.on_time, p.late, p.on_time_pct, p.avg_days_taken], [1, 1, 50, 21]);
  // a task closed without the member's submission
  assert.strictEqual(tec.outcome({ activated_on: '2027-01-01', due_date: '2027-01-21', stage_completed_on: '2027-01-22' }, '2027-02-01').key, 'not_submitted');
});

test('appointment explains both tasks; activation e-mail gives the evaluation due date', () => {
  const c = { bid_no: 'T/2026/0001', ref_no: 'ENG-2026-0002', title: 'Transformers', department: 'Engineering', appointed_on: '2026-10-13', due_date: '2026-11-03' };
  const a = tec.appointmentMail({ member: { name: 'A' }, role: 'member', c, org: 'LECO', today: '2026-10-13' });
  assert.match(a.subject, /Bid Evaluation Committee/);
  assert.match(a.text, /1\. Preparation of bidding documents \/ specifications — starts now; to be completed by 3 November 2026/);
  assert.match(a.text, /2\. Bid evaluation — you will be notified separately/);
  const s2 = tec.stageActivatedMail({ member: { name: 'A' }, c: { ...c, stage_due: '2027-01-15' }, stage: 2, org: 'LECO', today: '2026-12-20' });
  assert.match(s2.subject, /^Bid evaluation task started — T\/2026\/0001 — due 15 January 2027/);
  const r = tec.reminderMail({ member: { name: 'A' }, c: { ...c, stage_due: '2027-01-15' }, stage: 2, kind: 'before', today: '2027-01-08' });
  assert.match(r.subject, /^Reminder: Bid evaluation for T\/2026\/0001/);
  assert.match(r.text, /task 2 of 2/);
});
