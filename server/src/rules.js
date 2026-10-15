// Business rules from Sri Lanka's National Procurement Manual 2024 (Goods, Works, Non-consulting
// Services). All monetary values are LKR million (Mn). Pure functions - no I/O.

const METHODS = [
  'ICB', 'LIB', 'NCB', 'LNB', 'Shopping-National', 'Shopping-International',
  'Direct Contracting', 'Force Account', 'Emergency', 'CBO', 'Co-financing'
];
const BIDDING_PROCEDURES = ['Single-envelope', 'Two-envelope', 'Two-stage'];
const FUNDING_SOURCES = ['LECO', 'GOSL', 'Foreign', 'Grant'];
const COMMITTEE_LEVELS = ['CAO/AO/PD', 'RPC', 'DPC/PPC', 'MPC', 'HLPC/SHLPC'];

// Section 2.9(1): the lowest committee whose limit (inclusive, TCE incl. VAT) covers the value.
// upTo: null means unlimited.
const DEFAULT_LIMITS = {
  committee: {
    GOSL: [
      { level: 'RPC', upTo: 50 }, { level: 'DPC/PPC', upTo: 400 },
      { level: 'MPC', upTo: 750 }, { level: 'HLPC/SHLPC', upTo: null }
    ],
    Foreign: [
      { level: 'RPC', upTo: 100 }, { level: 'DPC/PPC', upTo: 800 },
      { level: 'MPC', upTo: 1500 }, { level: 'HLPC/SHLPC', upTo: null }
    ]
  },
  // Section 2.9(2): shopping caps per approving authority.
  shopping: {
    GOSL: {
      'CAO/AO/PD': { works: 2, goods: 1, services: 1 },
      RPC: { works: 6, goods: 6, services: 6 },
      'DPC/PPC': { works: 20, goods: 20, services: 20 },
      MPC: { works: 40, goods: 25, services: 25 }
    },
    Foreign: {
      'CAO/AO/PD': { works: 2, goods: 1, services: 1 },
      RPC: { works: 6, goods: 6, services: 6 },
      'DPC/PPC': { works: 30, goods: 30, services: 30 },
      MPC: { works: 40, goods: 35, services: 35 }
    }
  }
};

// Section 6.3 minimum bidding periods (days).
// Section 2.9 distinguishes GOSL-funded from foreign-funded procurement. LECO own funds follow the
// GOSL limits; grants are treated as foreign-funded (change here if LECO's grants are domestic).
function limitClass(funding) {
  return funding === 'Foreign' || funding === 'Grant' ? 'Foreign' : 'GOSL';
}

function methodFamily(method) {
  if (method === 'ICB' || method === 'LIB') return 'ICB';
  if (method === 'NCB' || method === 'LNB') return 'NCB';
  if (method === 'Shopping-National' || method === 'Shopping-International') return 'SHOPPING';
  return null;
}

function tceInclVat(exclMn, vatPct) {
  const e = Number(exclMn) || 0;
  const v = Number(vatPct) || 0;
  return Math.round(e * (1 + v / 100) * 1e6) / 1e6;
}

function mergeLimits(overrides) {
  if (!overrides) return DEFAULT_LIMITS;
  return {
    committee: { ...DEFAULT_LIMITS.committee, ...(overrides.committee || {}) },
    shopping: { ...DEFAULT_LIMITS.shopping, ...(overrides.shopping || {}) }
  };
}

function committeeLevel(tceInclMn, funding, limits = DEFAULT_LIMITS) {
  const rows = limits.committee[limitClass(funding)];
  for (const r of rows) {
    if (r.upTo === null || tceInclMn <= r.upTo) return r.level;
  }
  return rows[rows.length - 1].level;
}

// Lowest approving authority that may procure this value by Shopping, or null if above every cap.
function shoppingAuthority(tceInclMn, manualType, funding, limits = DEFAULT_LIMITS) {
  const table = limits.shopping[limitClass(funding)];
  // Consultancy services use the services limits (the Manual's Shopping table has goods / works / services).
  const type = manualType === 'works' ? 'works' : ['services', 'consultancy'].includes(manualType) ? 'services' : 'goods';
  for (const level of ['CAO/AO/PD', 'RPC', 'DPC/PPC', 'MPC']) {
    const cap = table[level] && table[level][type];
    if (cap != null && tceInclMn <= cap) return level;
  }
  return null;
}

function minBiddingDays(method, tceInclMn) {
  const fam = methodFamily(method);
  if (fam === 'ICB') return 42;
  if (fam === 'NCB') return tceInclMn >= 50 ? 21 : 14;
  if (method === 'Shopping-National') return 7;
  if (method === 'Shopping-International') return 14;
  return null;
}

// Annex VIII (with prequalification) / Annex IX (without): [upper bound Mn, ICB max, ICB compulsory,
// NCB max, NCB compulsory] in weeks; the last band is open-ended.
const ANNEX_VIII = [
  [50, 8, 6, 4, 2], [250, 9, 6, 6, 3], [750, 10, 6, 8, 3], [2000, 15, 6, 12, 3], [null, 17, 6, 14, 3]
];
const ANNEX_IX = [
  [50, 8, 6, 4, 2], [250, 8, 6, 6, 3], [750, 9, 6, 6, 3], [2000, 13, 6, 10, 3], [null, 15, 6, 12, 3]
];

function annexBiddingWeeks(tceInclMn, method, prequalification) {
  const fam = methodFamily(method);
  if (fam !== 'ICB' && fam !== 'NCB') return null;
  const table = prequalification ? ANNEX_VIII : ANNEX_IX;
  const band = table.find(b => b[0] === null || tceInclMn <= b[0]);
  const icb = fam === 'ICB';
  return {
    annex: prequalification ? 'VIII' : 'IX',
    maxWeeks: icb ? band[1] : band[3],
    compulsoryWeeks: icb ? band[2] : band[4]
  };
}

function isoToUtc(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function addDays(iso, days) {
  const t = new Date(isoToUtc(iso) + days * 86400000);
  return t.toISOString().slice(0, 10);
}
function diffDays(aIso, bIso) {
  return Math.round((isoToUtc(bIso) - isoToUtc(aIso)) / 86400000);
}

// Annex III milestone list (keys are stable identifiers stored in plan_items.milestones).
const MILESTONES = [
  { key: 'appoint_pc', label: 'Appointment of Procurement Committee' },
  { key: 'appoint_bec', label: 'Appointment of Bid Evaluation Committee' },
  { key: 'prep_docs', label: 'Preparation of bidding documents / specifications' },
  { key: 'approve_docs', label: 'Approval of bidding documents' },
  { key: 'invitation', label: 'Invitation for bids' },
  { key: 'clarification', label: 'Clarification / pre-bid meeting' },
  { key: 'opening', label: 'Bid closing and opening' },
  { key: 'evaluation', label: 'Bid evaluation' },
  { key: 'determination', label: 'Determination of award' },
  { key: 'approve_award', label: 'Approval of award' },
  { key: 'contract_award', label: 'Contract award' },
  { key: 'signing', label: 'Contract signing' },
  { key: 'completion', label: 'Completion / delivery' }
];

// Default lead times (days from procurement start) used to draft a schedule. These are planning
// defaults, not values fixed by the Manual - procurement can override every date.
const DEFAULT_LEADS = {
  appoint_pc: 0, appoint_bec: 3, prep_docs: 14, approve_docs: 21, invitation: 28
};

function buildSchedule({ start, delivery, method, tceInclMn }) {
  if (!start) return {};
  const bid = minBiddingDays(method, tceInclMn) || 14;
  const s = {};
  for (const k of Object.keys(DEFAULT_LEADS)) s[k] = addDays(start, DEFAULT_LEADS[k]);
  s.clarification = addDays(s.invitation, Math.floor(bid / 2));
  s.opening = addDays(s.invitation, bid);
  s.evaluation = addDays(s.opening, 21);
  s.determination = addDays(s.evaluation, 7);
  s.approve_award = addDays(s.determination, 7);
  s.contract_award = addDays(s.approve_award, 7);
  s.signing = addDays(s.contract_award, 14);
  s.completion = delivery || null;
  const out = {};
  for (const m of MILESTONES) out[m.key] = { scheduled: s[m.key] || null, revised: null, actual: null };
  return out;
}

// Days from the previous milestone to each milestone under the standard (auto) schedule - the same lead
// times buildSchedule uses. The first milestone is counted from the procurement start. Completion is the
// delivery period after signing: up to the expected delivery date if one is given, else the planning default.
function milestoneGaps({ method, tceInclMn, manualType, start, delivery }) {
  const bid = minBiddingDays(method, tceInclMn) || 14;
  const half = Math.floor(bid / 2);
  const gaps = {
    appoint_pc: DEFAULT_LEADS.appoint_pc, appoint_bec: DEFAULT_LEADS.appoint_bec - DEFAULT_LEADS.appoint_pc,
    prep_docs: DEFAULT_LEADS.prep_docs - DEFAULT_LEADS.appoint_bec, approve_docs: DEFAULT_LEADS.approve_docs - DEFAULT_LEADS.prep_docs,
    invitation: DEFAULT_LEADS.invitation - DEFAULT_LEADS.approve_docs, clarification: half, opening: bid - half,
    evaluation: 21, determination: 7, approve_award: 7, contract_award: 7, signing: 14
  };
  const toSigning = Object.values(gaps).reduce((s, d) => s + d, 0);
  const fromDelivery = start && delivery ? diffDays(addDays(start, toSigning), delivery) : null;
  gaps.completion = fromDelivery != null && fromDelivery > 0 ? fromDelivery : deliveryDays(manualType, tceInclMn, method);
  return gaps;
}

// Milestone dates from a start date and the weeks allowed for each milestone (counted from the previous
// one). Weeks may be fractional (0.5 = 3.5 days, rounded to whole days).
function scheduleFromWeeks(start, weeks) {
  const out = {};
  let days = 0;
  for (const m of MILESTONES) {
    days += Math.round((Number(weeks[m.key]) || 0) * 7);
    out[m.key] = addDays(start, days);
  }
  return out;
}

// Planning defaults (not Manual values) for the time from contract signing to delivery / completion,
// by category type and value band [upper bound LKR Mn incl. VAT, days]. Adjust to LECO experience.
const DELIVERY_DAYS = {
  goods: [[10, 45], [50, 60], [250, 90], [null, 120]],
  works: [[10, 90], [50, 120], [250, 180], [null, 365]],
  services: [[10, 30], [50, 30], [250, 45], [null, 60]]
};
const INTERNATIONAL_EXTRA_DAYS = 60; // shipping and clearing for ICB / international shopping
const PREQUALIFICATION_DAYS = 42;    // a prequalification round before bidding

function deliveryDays(manualType, tceInclMn, method) {
  const bands = DELIVERY_DAYS[manualType === 'consultancy' ? 'services' : manualType] || DELIVERY_DAYS.goods;
  const days = bands.find(b => b[0] === null || tceInclMn <= b[0])[1];
  const intl = methodFamily(method) === 'ICB' || method === 'Shopping-International';
  return days + (intl && manualType !== 'works' ? INTERNATIONAL_EXTRA_DAYS : 0);
}

// How to set the procurement start and expected delivery for a request: work back from the date the
// department needs it by the procurement steps (same lead times as buildSchedule) and a delivery period.
// If that start date has already passed, start today and give the earliest achievable delivery instead.
function dateGuidance({ requiredDate, method, tceInclMn, manualType, prequalification, today }) {
  const bid = minBiddingDays(method, tceInclMn) || 14;
  const steps = [
    { label: 'Committee appointment, specifications and approval of bidding documents', days: DEFAULT_LEADS.invitation },
    ...(prequalification ? [{ label: 'Prequalification (Annex VIII)', days: PREQUALIFICATION_DAYS }] : []),
    { label: `Bidding period${minBiddingDays(method, tceInclMn) ? ' (Section 6.3 minimum)' : ' (planning default)'}`, days: bid },
    { label: 'Evaluation, determination and approval of award', days: 21 + 7 + 7 },
    { label: 'Contract award and signing', days: 7 + 14 },
    { label: `Delivery / completion after signing (${manualType || 'goods'}, planning default)`, days: deliveryDays(manualType, tceInclMn, method) }
  ];
  const total = steps.reduce((s, x) => s + x.days, 0);
  const out = { steps, total_days: total, required_date: requiredDate || null, method: method || null };
  if (!requiredDate) {
    out.start = today; out.delivery = addDays(today, total); out.feasible = null;
    out.note = 'No required date was given by the department; dates shown are the earliest if procurement starts today.';
    return out;
  }
  const latestStart = addDays(requiredDate, -total);
  if (latestStart >= today) {
    out.start = latestStart; out.delivery = requiredDate; out.feasible = true;
    out.note = `Start by ${latestStart} to deliver by the required date (${total} days end to end). Starting earlier adds a safety margin.`;
  } else {
    out.start = today; out.delivery = addDays(today, total); out.feasible = false;
    out.late_days = diffDays(requiredDate, out.delivery);
    out.note = `The required date cannot be met: the steps need ${total} days, so even starting today delivery is about ${out.delivery} (${out.late_days} days late). Tell the department, or consider a faster method if the value allows.`;
  }
  return out;
}

// Checks an item's method/values/dates against the Manual and returns human-readable warnings.
function checkItem(item, manualType, limits = DEFAULT_LIMITS) {
  const warnings = [];
  const incl = tceInclVat(item.tce_excl_vat_mn, item.vat_pct);
  const funding = limitClass(item.funding_source);
  const suggestedLevel = committeeLevel(incl, funding, limits);
  const fam = methodFamily(item.method);
  const out = {
    tce_incl_vat_mn: incl,
    suggested_committee: suggestedLevel,
    min_bidding_days: item.method ? minBiddingDays(item.method, incl) : null,
    annex: null,
    shopping_authority: null,
    warnings
  };

  if (fam === 'SHOPPING') {
    const auth = shoppingAuthority(incl, manualType, funding, limits);
    out.shopping_authority = auth;
    if (!auth) warnings.push(`LKR ${incl} Mn exceeds the Shopping limit for ${manualType || 'this category'} (${funding}) - use NCB/ICB.`);
  }
  if (item.method === 'Shopping-International' && funding === 'GOSL' && incl < 1) {
    warnings.push('International shopping is unusual at this value; confirm national shopping is not sufficient.');
  }
  if (out.min_bidding_days == null && item.method && !fam) {
    warnings.push(`${item.method} is a special method - record the justification in remarks and confirm approval by the committee.`);
  }
  if (fam === 'ICB' || fam === 'NCB') {
    out.annex = annexBiddingWeeks(incl, item.method, !!item.prequalification);
  }
  if (item.committee_level && item.committee_level !== suggestedLevel) {
    const chosen = COMMITTEE_LEVELS.indexOf(item.committee_level);
    const needed = COMMITTEE_LEVELS.indexOf(suggestedLevel);
    if (chosen >= 0 && needed >= 0 && chosen < needed) {
      warnings.push(`${item.committee_level} is below the authority limit for LKR ${incl} Mn - Section 2.9(1) requires ${suggestedLevel}.`);
    }
  }
  if (item.procurement_start && item.expected_delivery) {
    const total = diffDays(item.procurement_start, item.expected_delivery);
    if (total < 0) warnings.push('Expected delivery is before the procurement start date.');
    else if (out.annex) {
      const compulsoryDays = out.annex.compulsoryWeeks * 7;
      if (total < compulsoryDays) warnings.push(`Only ${total} days from start to delivery; Annex ${out.annex.annex} bidding stage alone needs at least ${compulsoryDays} days.`);
    }
    if (out.min_bidding_days && total >= 0 && total < out.min_bidding_days) {
      warnings.push(`Window of ${total} days is shorter than the minimum bidding period of ${out.min_bidding_days} days (Section 6.3).`);
    }
  }
  return out;
}

module.exports = {
  METHODS, FUNDING_SOURCES, limitClass, BIDDING_PROCEDURES, COMMITTEE_LEVELS, DEFAULT_LIMITS, MILESTONES, ANNEX_VIII, ANNEX_IX,
  methodFamily, tceInclVat, mergeLimits, committeeLevel, shoppingAuthority, minBiddingDays,
  annexBiddingWeeks, addDays, diffDays, buildSchedule, checkItem, deliveryDays, dateGuidance, milestoneGaps, scheduleFromWeeks
};
