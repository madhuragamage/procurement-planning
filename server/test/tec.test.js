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
  assert.match(a.text, /2026-10-21/);
  const before = tec.reminderMail({ member: { name: 'A. Perera' }, c, kind: 'before', today: '2026-10-14' });
  assert.match(before.text, /7 days from today/);
  const late = tec.reminderMail({ member: { name: 'A. Perera' }, c, kind: 'overdue', today: '2026-10-23' });
  assert.match(late.subject, /^OVERDUE/);
  assert.match(late.text, /2 days ago/);
});
