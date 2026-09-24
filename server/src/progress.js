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

module.exports = { itemProgress, isOverdue, summarise, groupSummaries };
