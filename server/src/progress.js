// Plan progress. Pure functions over plan items (cancelled items are excluded from every figure).
//
// Item progress = share of the 13 Annex III milestones that have an actual date (completed = 100%).
// Expected progress = share whose scheduled date is on or before today. Comparing the two shows whether
// the plan is ahead of or behind its own schedule. Plan-level figures are weighted by TCE incl. VAT.

const rules = require('./rules');

const N = rules.MILESTONES.length;
const r1 = n => Math.round(n * 10) / 10;

function itemProgress(item, today) {
  const ms = item.milestones || {};
  let done = 0; let due = 0;
  for (const m of rules.MILESTONES) {
    const e = ms[m.key];
    if (!e) continue;
    if (e.actual) done += 1;
    if (e.scheduled && e.scheduled <= today) due += 1;
  }
  return { actual: item.status === 'completed' ? 100 : (done / N) * 100, expected: (due / N) * 100 };
}

function isOverdue(item, today) {
  if (['completed', 'cancelled'].includes(item.status)) return false;
  const ms = item.milestones || {};
  return rules.MILESTONES.some(m => {
    const e = ms[m.key];
    if (!e || e.actual) return false;
    const target = e.revised || e.scheduled;
    return !!target && target < today;
  });
}

function summarise(items, today) {
  const live = items.filter(i => i.status !== 'cancelled');
  const value = i => rules.tceInclVat(i.tce_excl_vat_mn, i.vat_pct);
  const totalValue = live.reduce((s, i) => s + value(i), 0);
  let actualW = 0; let expectedW = 0;
  for (const i of live) {
    const p = itemProgress(i, today);
    const w = totalValue > 0 ? value(i) / totalValue : 1 / live.length;
    actualW += p.actual * w; expectedW += p.expected * w;
  }
  const count = s => live.filter(i => i.status === s).length;
  const withAward = live.filter(i => i.award_value_mn != null);
  return {
    count: live.length,
    value: Math.round(totalValue * 100) / 100,
    actual_pct: live.length ? r1(actualW) : 0,
    expected_pct: live.length ? r1(expectedW) : 0,
    stages: { not_started: count('planned'), in_progress: count('in_progress'), awarded: count('awarded'), completed: count('completed') },
    completed_pct: live.length ? r1((count('completed') / live.length) * 100) : 0,
    awarded_or_done_pct: live.length ? r1(((count('awarded') + count('completed')) / live.length) * 100) : 0,
    awarded_value: Math.round(withAward.reduce((s, i) => s + i.award_value_mn, 0) * 100) / 100,
    awarded_estimate: Math.round(withAward.reduce((s, i) => s + value(i), 0) * 100) / 100,
    overdue: live.filter(i => isOverdue(i, today)).length
  };
}

function groupSummaries(items, today, keyFn) {
  const groups = new Map();
  for (const i of items) {
    if (i.status === 'cancelled') continue;
    const k = keyFn(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, ...summarise(list, today) })).sort((a, b) => b.value - a.value);
}

// ---- Progress against the Procurement Time Schedule (counted by procurement, not by value) ----

// The Procurement Time Schedule date of each milestone: the schedule the procurement unit set once execution
// was authorised (auto / custom weeks from the start date), else the approved plan's scheduled dates. Later
// revised dates (slippage) do not move it.
function scheduleDates(item) {
  if (item.schedule_mode && item.schedule_start && item.schedule_weeks) return rules.scheduleFromWeeks(item.schedule_start, item.schedule_weeks);
  const ms = item.milestones || {};
  return Object.fromEntries(rules.MILESTONES.map(m => [m.key, (ms[m.key] && ms[m.key].scheduled) || null]));
}

// For each milestone from the appointment of the Procurement Committee onwards: how many procurements were due
// to reach it by today, how many reached it (on time / late) and how many are overdue; and how many
// procurements stand at each stage (the furthest milestone with an actual date).
function milestoneProgress(items, today) {
  const live = items.filter(i => i.status !== 'cancelled');
  const rows = rules.MILESTONES.map(m => ({ key: m.key, label: m.label, scheduled: 0, due: 0, achieved: 0, achieved_due: 0, on_time: 0, late: 0, overdue: 0 }));
  const stage = new Map([['not_started', 0], ...rules.MILESTONES.map(m => [m.key, 0])]);
  for (const i of live) {
    const sched = scheduleDates(i);
    const ms = i.milestones || {};
    let furthest = 'not_started';
    rules.MILESTONES.forEach((m, n) => {
      const r = rows[n]; const target = sched[m.key]; const actual = ms[m.key] && ms[m.key].actual;
      if (target) r.scheduled += 1;
      if (target && target <= today) { r.due += 1; if (actual) r.achieved_due += 1; }
      if (actual) { r.achieved += 1; furthest = m.key; if (target) { if (actual <= target) r.on_time += 1; else r.late += 1; } }
      else if (target && target < today) r.overdue += 1;
    });
    stage.set(furthest, stage.get(furthest) + 1);
  }
  const due = rows.reduce((s, r) => s + r.due, 0);
  const achievedOfDue = rows.reduce((s, r) => s + r.achieved_due, 0);
  const achieved = rows.reduce((s, r) => s + r.achieved, 0);
  const onTime = rows.reduce((s, r) => s + r.on_time, 0);
  return {
    procurements: live.length,
    milestones: rows.map(r => ({ ...r, achieved_pct: r.due ? r1((r.achieved_due / r.due) * 100) : null })),
    overall: { due, achieved, achieved_of_due: achievedOfDue, achieved_pct: due ? r1((achievedOfDue / due) * 100) : null,
      on_time: onTime, on_time_pct: achieved ? r1((onTime / achieved) * 100) : null, overdue: rows.reduce((s, r) => s + r.overdue, 0) },
    stages: [{ key: 'not_started', label: 'Not started', count: stage.get('not_started') }, ...rules.MILESTONES.map(m => ({ key: m.key, label: m.label, count: stage.get(m.key) }))]
  };
}

// A procurement is "done" when its contract is signed - the end of the procurement process (delivery then
// belongs to the Supplies Unit). Change DONE_MILESTONE to 'completion' to measure up to delivery instead.
const DONE_MILESTONE = 'signing';
const DONE_LABEL = rules.MILESTONES.find(m => m.key === DONE_MILESTONE).label;
const COMPLIANCE = {
  done_on_time: 'Done within schedule', done_late: 'Done, but late', overdue: 'Not done — schedule passed',
  in_schedule: 'Not done — still within schedule', no_schedule: 'No time schedule'
};

function complianceOf(item, today) {
  const target = scheduleDates(item)[DONE_MILESTONE];
  const ms = item.milestones || {};
  // If signing itself was not recorded, a later-stage actual (contract award, completion) shows it is done.
  const fallback = DONE_MILESTONE === 'signing' ? ['contract_award', 'completion'] : [];
  const done = [DONE_MILESTONE, ...fallback].map(k => ms[k] && ms[k].actual).find(Boolean) || null;
  let state;
  if (done) state = !target || done <= target ? 'done_on_time' : 'done_late';
  else if (!target) state = 'no_schedule';
  else state = target < today ? 'overdue' : 'in_schedule';
  return { state, target, done, days: done && target ? rules.diffDays(target, done) : (!done && target ? rules.diffDays(target, today) : null) };
}

function complianceSummary(items, today) {
  const live = items.filter(i => i.status !== 'cancelled');
  const value = i => rules.tceInclVat(i.tce_excl_vat_mn, i.vat_pct);
  const counts = Object.fromEntries(Object.keys(COMPLIANCE).map(k => [k, { count: 0, value: 0 }]));
  for (const i of live) { const c = counts[complianceOf(i, today).state]; c.count += 1; c.value += value(i); }
  for (const c of Object.values(counts)) c.value = Math.round(c.value * 100) / 100;
  const done = counts.done_on_time.count + counts.done_late.count;
  const due = done + counts.overdue.count;
  return {
    total: live.length, by_state: counts, done, not_done: counts.overdue.count + counts.in_schedule.count + counts.no_schedule.count,
    done_on_time_pct: done ? r1((counts.done_on_time.count / done) * 100) : null,
    // of the procurements whose schedule date has passed (or which are done), how many were done in time
    within_schedule_pct: due ? r1((counts.done_on_time.count / due) * 100) : null
  };
}

function complianceGroups(items, today, keyFn) {
  const groups = new Map();
  for (const i of items) {
    if (i.status === 'cancelled') continue;
    const k = keyFn(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, ...complianceSummary(list, today) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

module.exports = {
  itemProgress, isOverdue, summarise, groupSummaries,
  scheduleDates, milestoneProgress, DONE_MILESTONE, DONE_LABEL, COMPLIANCE, complianceOf, complianceSummary, complianceGroups
};
