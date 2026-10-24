const test = require('node:test');
const assert = require('node:assert');
const rules = require('../src/rules');
const p = require('../src/progress');

const sched = (start) => rules.buildSchedule({ start, delivery: '2027-12-31', method: 'NCB', tceInclMn: 100 });
const item = (over = {}) => ({ status: 'planned', tce_excl_vat_mn: 100, vat_pct: 0, milestones: sched('2027-01-01'), ...over });

test('a fresh item has no actual progress; expected progress follows the schedule', () => {
  assert.deepStrictEqual(p.itemProgress(item(), '2026-12-31'), { actual: 0, expected: 0 });
  const mid = p.itemProgress(item(), '2027-03-22');
  assert.strictEqual(mid.actual, 0);
  assert.ok(mid.expected > 30 && mid.expected < 70, mid.expected);
  assert.strictEqual(p.itemProgress(item(), '2028-01-01').expected, 100);
});

test('actual progress counts milestones with actual dates; completed is 100%', () => {
  const it = item();
  it.milestones.appoint_pc.actual = '2027-01-02';
  it.milestones.appoint_bec.actual = '2027-01-05';
  assert.ok(Math.abs(p.itemProgress(it, '2027-02-01').actual - (2 / 13) * 100) < 1e-9);
  assert.strictEqual(p.itemProgress(item({ status: 'completed' }), '2027-02-01').actual, 100);
});

test('summary weights by value, skips cancelled items and counts stages', () => {
  const big = item({ tce_excl_vat_mn: 900, status: 'completed' });
  const small = item({ tce_excl_vat_mn: 100 });
  const gone = item({ tce_excl_vat_mn: 5000, status: 'cancelled' });
  const s = p.summarise([big, small, gone], '2027-01-01');
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.value, 1000);
  assert.strictEqual(s.actual_pct, 90); // 0.9 * 100 + 0.1 * 0
  assert.deepStrictEqual(s.stages, { not_started: 1, in_progress: 0, awarded: 0, completed: 1 });
  assert.strictEqual(s.completed_pct, 50);
});

test('summary of an empty set is all zeros, not NaN', () => {
  const s = p.summarise([], '2027-01-01');
  assert.strictEqual(s.actual_pct, 0);
  assert.strictEqual(s.count, 0);
});

test('overdue: past target without an actual date, ignoring finished and cancelled items', () => {
  assert.strictEqual(p.isOverdue(item(), '2027-01-10'), true);   // appoint_pc was due 2027-01-01
  assert.strictEqual(p.isOverdue(item(), '2026-12-01'), false);
  const it = item(); it.milestones.appoint_pc.revised = '2027-02-01'; it.milestones.appoint_bec.revised = '2027-02-01';
  assert.strictEqual(p.isOverdue(it, '2027-01-10'), false);      // revised target is still ahead
  assert.strictEqual(p.isOverdue(item({ status: 'completed' }), '2027-06-01'), false);
  assert.strictEqual(p.isOverdue(item({ status: 'cancelled' }), '2027-06-01'), false);
});

test('groupSummaries groups by key, biggest value first', () => {
  const rows = p.groupSummaries([item({ dept: 'A', tce_excl_vat_mn: 10 }), item({ dept: 'B', tce_excl_vat_mn: 50 }), item({ dept: 'A', tce_excl_vat_mn: 10 })], '2027-01-01', i => i.dept);
  assert.deepStrictEqual(rows.map(r => [r.name, r.count]), [['B', 1], ['A', 2]]);
});

const progress = p;
const msDates = (dates, actuals = {}) => Object.fromEntries(Object.entries(dates).map(([k, d]) => [k, { scheduled: d, revised: null, actual: actuals[k] || null }]));

test('milestone progress counts due, achieved, on time, late and overdue per milestone', () => {
  const a = { status: 'in_progress', milestones: msDates({ appoint_pc: '2027-01-05', appoint_bec: '2027-01-10', prep_docs: '2027-02-01' }, { appoint_pc: '2027-01-04', appoint_bec: '2027-01-12' }) };
  const b = { status: 'planned', milestones: msDates({ appoint_pc: '2027-01-08', appoint_bec: '2027-01-20' }) };
  const p = progress.milestoneProgress([a, b, { status: 'cancelled', milestones: {} }], '2027-01-15');
  const pc = p.milestones.find(m => m.key === 'appoint_pc');
  assert.deepStrictEqual([pc.due, pc.achieved_due, pc.on_time, pc.late, pc.overdue], [2, 1, 1, 0, 1]);
  const bec = p.milestones.find(m => m.key === 'appoint_bec');
  assert.deepStrictEqual([bec.due, bec.achieved_due, bec.late, bec.overdue], [1, 1, 1, 0]);
  assert.strictEqual(p.procurements, 2);
  assert.strictEqual(p.overall.due, 3);
  assert.strictEqual(p.overall.achieved_pct, 66.7);
  assert.strictEqual(p.stages.find(s => s.key === 'not_started').count, 1);
  assert.strictEqual(p.stages.find(s => s.key === 'appoint_bec').count, 1);
});

test('the custom Time Schedule (weeks) is the target, not later revised dates', () => {
  const weeks = Object.fromEntries(require('../src/rules').MILESTONES.map(m => [m.key, 1]));
  const item = { schedule_mode: 'custom', schedule_start: '2027-01-04', schedule_weeks: weeks, milestones: { appoint_pc: { scheduled: '2026-12-01', revised: '2027-03-01', actual: null } } };
  assert.strictEqual(progress.scheduleDates(item).appoint_pc, '2027-01-11');
});

test('schedule compliance: done on time, late, overdue and still within schedule', () => {
  const t = '2027-06-01';
  const on = { status: 'awarded', milestones: msDates({ signing: '2027-05-01' }, { signing: '2027-04-28' }) };
  const late = { status: 'awarded', milestones: msDates({ signing: '2027-05-01' }, { signing: '2027-05-11' }) };
  const over = { status: 'in_progress', milestones: msDates({ signing: '2027-05-15' }) };
  const ahead = { status: 'planned', milestones: msDates({ signing: '2027-09-01' }) };
  assert.deepStrictEqual([on, late, over, ahead].map(i => progress.complianceOf(i, t).state), ['done_on_time', 'done_late', 'overdue', 'in_schedule']);
  assert.strictEqual(progress.complianceOf(late, t).days, 10);
  const s = progress.complianceSummary([on, late, over, ahead], t);
  assert.deepStrictEqual([s.done, s.not_done, s.done_on_time_pct, s.within_schedule_pct], [2, 2, 50, 33.3]);
});
