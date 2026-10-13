const test = require('node:test');
const assert = require('node:assert');
const sup = require('../src/supplies');
const bids = require('../src/bids');

test('addWorkingDays skips weekends', () => {
  assert.strictEqual(sup.addWorkingDays('2026-10-09', 1), '2026-10-12'); // Friday -> Monday
  assert.strictEqual(sup.addWorkingDays('2026-10-12', 1), '2026-10-13');
});

test('only the steps a contract needs apply', () => {
  const local = { status: 'accepted', payment_mode: 'local', forwarded_on: '2026-10-01', accepted_on: '2026-10-01', steps: {} };
  const keys = sup.steps(local, {}, '2026-10-05').list.map(s => s.key);
  assert.ok(keys.includes('pb_received') && keys.includes('goods_delivered'));
  assert.ok(!keys.includes('lc_application') && !keys.includes('proof_requested') && !keys.includes('ab_received') && !keys.includes('bid_bond_released'));
  const importJob = { ...local, payment_mode: 'LC', proof_required: 1, advance_bond_required: 1, bid_bond_amount: 1000, fat_required: 1, duty_waiver_required: 1, contract_agreement_required: 1, award_date: '2026-09-20', order_type: 'letter_of_acceptance' };
  const all = sup.steps(importJob, {}, '2026-10-05').list.map(s => s.key);
  assert.strictEqual(all.length, sup.STEPS.length);
});

test('due dates and overdue flags follow the work procedure', () => {
  const c = { status: 'accepted', payment_mode: 'local', forwarded_on: '2026-10-01', accepted_on: '2026-10-02', pb_due: '2026-10-17', delivery_date: '2026-12-01',
    contract_agreement_required: 1, award_date: '2026-09-20', steps: { file_received: { date: '2026-10-01' }, accepted: { date: '2026-10-02' } } };
  const st = sup.steps(c, {}, '2026-10-20');
  const by = k => st.list.find(s => s.key === k);
  assert.strictEqual(by('accepted').late_days, 1);                 // same-day rule missed by a day
  assert.strictEqual(by('supplier_informed').due, '2026-10-05');   // Friday + 1 working day = Monday
  assert.strictEqual(by('pb_received').overdue, true);
  assert.strictEqual(by('contract_agreement').due, '2026-10-20');  // award + 30 days
  assert.strictEqual(by('goods_delivered').overdue, false);
  assert.strictEqual(st.next.key, 'po_copies_sent');
  assert.strictEqual(sup.pbValidity('2026-12-01', { pb_validity_extra_days: 60 }), '2027-01-30');
});

test('bid type follows the method', () => {
  assert.strictEqual(bids.suggestType('NCB'), 'tender');
  assert.strictEqual(bids.suggestType('ICB'), 'tender');
  assert.strictEqual(bids.suggestType('Shopping-National'), 'quotation');
  assert.strictEqual(bids.suggestType('Direct Contracting'), null);
});

const rules = require('../src/rules');

test('auto schedule gaps add up to the drafted schedule', () => {
  const gaps = rules.milestoneGaps({ method: 'NCB', tceInclMn: 30, manualType: 'goods', start: '2027-01-04', delivery: null });
  assert.strictEqual(gaps.opening, 14 - 7);                 // NCB < 50 Mn: 14-day bidding, half before clarification
  assert.strictEqual(gaps.completion, 60);                  // goods <= 50 Mn delivery default
  const draft = rules.buildSchedule({ start: '2027-01-04', method: 'NCB', tceInclMn: 30 });
  const fromGaps = rules.scheduleFromWeeks('2027-01-04', Object.fromEntries(Object.entries(gaps).map(([k, d]) => [k, d / 7])));
  assert.strictEqual(fromGaps.signing, draft.signing.scheduled);
  // with an expected delivery date, completion runs up to it
  const g2 = rules.milestoneGaps({ method: 'NCB', tceInclMn: 30, manualType: 'goods', start: '2027-01-04', delivery: '2027-09-30' });
  assert.strictEqual(rules.scheduleFromWeeks('2027-01-04', Object.fromEntries(Object.entries(g2).map(([k, d]) => [k, d / 7]))).completion, '2027-09-30');
});

test('custom weeks are cumulative from the start date', () => {
  const weeks = Object.fromEntries(rules.MILESTONES.map(m => [m.key, 1]));
  weeks.appoint_pc = 0; weeks.completion = 10;
  const d = rules.scheduleFromWeeks('2027-01-04', weeks);
  assert.strictEqual(d.appoint_pc, '2027-01-04');
  assert.strictEqual(d.appoint_bec, '2027-01-11');
  assert.strictEqual(d.signing, rules.addDays('2027-01-04', 11 * 7));
  assert.strictEqual(d.completion, rules.addDays('2027-01-04', 21 * 7));
});
