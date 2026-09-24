const test = require('node:test');
const assert = require('node:assert');
const r = require('../src/rules');

test('tceInclVat applies VAT', () => {
  assert.strictEqual(r.tceInclVat(100, 18), 118);
  assert.strictEqual(r.tceInclVat(0, 18), 0);
  assert.strictEqual(r.tceInclVat(50, 0), 50);
});

test('committee level boundaries - GOSL (inclusive upper limits)', () => {
  assert.strictEqual(r.committeeLevel(50, 'GOSL'), 'RPC');
  assert.strictEqual(r.committeeLevel(50.01, 'GOSL'), 'DPC/PPC');
  assert.strictEqual(r.committeeLevel(400, 'GOSL'), 'DPC/PPC');
  assert.strictEqual(r.committeeLevel(400.01, 'GOSL'), 'MPC');
  assert.strictEqual(r.committeeLevel(750, 'GOSL'), 'MPC');
  assert.strictEqual(r.committeeLevel(750.01, 'GOSL'), 'HLPC/SHLPC');
});

test('committee level boundaries - Foreign funded', () => {
  assert.strictEqual(r.committeeLevel(100, 'Foreign'), 'RPC');
  assert.strictEqual(r.committeeLevel(100.01, 'Foreign'), 'DPC/PPC');
  assert.strictEqual(r.committeeLevel(800, 'Foreign'), 'DPC/PPC');
  assert.strictEqual(r.committeeLevel(1500, 'Foreign'), 'MPC');
  assert.strictEqual(r.committeeLevel(1500.01, 'Foreign'), 'HLPC/SHLPC');
});

test('shopping authority by value and type', () => {
  assert.strictEqual(r.shoppingAuthority(1, 'goods', 'GOSL'), 'CAO/AO/PD');
  assert.strictEqual(r.shoppingAuthority(1.01, 'goods', 'GOSL'), 'RPC');
  assert.strictEqual(r.shoppingAuthority(2, 'works', 'GOSL'), 'CAO/AO/PD');
  assert.strictEqual(r.shoppingAuthority(6, 'works', 'GOSL'), 'RPC');
  assert.strictEqual(r.shoppingAuthority(20, 'services', 'GOSL'), 'DPC/PPC');
  assert.strictEqual(r.shoppingAuthority(25, 'goods', 'GOSL'), 'MPC');
  assert.strictEqual(r.shoppingAuthority(25.01, 'goods', 'GOSL'), null);
  assert.strictEqual(r.shoppingAuthority(40, 'works', 'GOSL'), 'MPC');
  assert.strictEqual(r.shoppingAuthority(40.01, 'works', 'GOSL'), null);
  assert.strictEqual(r.shoppingAuthority(30, 'goods', 'Foreign'), 'DPC/PPC');
  assert.strictEqual(r.shoppingAuthority(35, 'goods', 'Foreign'), 'MPC');
  assert.strictEqual(r.shoppingAuthority(35.01, 'goods', 'Foreign'), null);
});

test('minimum bidding periods (Section 6.3)', () => {
  assert.strictEqual(r.minBiddingDays('ICB', 900), 42);
  assert.strictEqual(r.minBiddingDays('LIB', 10), 42);
  assert.strictEqual(r.minBiddingDays('NCB', 50), 21);
  assert.strictEqual(r.minBiddingDays('NCB', 49.99), 14);
  assert.strictEqual(r.minBiddingDays('LNB', 100), 21);
  assert.strictEqual(r.minBiddingDays('Shopping-National', 5), 7);
  assert.strictEqual(r.minBiddingDays('Shopping-International', 5), 14);
  assert.strictEqual(r.minBiddingDays('Direct Contracting', 5), null);
});

test('Annex VIII / IX bidding weeks', () => {
  assert.deepStrictEqual(r.annexBiddingWeeks(2500, 'ICB', true), { annex: 'VIII', maxWeeks: 17, compulsoryWeeks: 6 });
  assert.deepStrictEqual(r.annexBiddingWeeks(2500, 'NCB', true), { annex: 'VIII', maxWeeks: 14, compulsoryWeeks: 3 });
  assert.deepStrictEqual(r.annexBiddingWeeks(2000, 'ICB', false), { annex: 'IX', maxWeeks: 13, compulsoryWeeks: 6 });
  assert.deepStrictEqual(r.annexBiddingWeeks(2000.01, 'ICB', false), { annex: 'IX', maxWeeks: 15, compulsoryWeeks: 6 });
  assert.deepStrictEqual(r.annexBiddingWeeks(50, 'NCB', false), { annex: 'IX', maxWeeks: 4, compulsoryWeeks: 2 });
  assert.deepStrictEqual(r.annexBiddingWeeks(300, 'NCB', false), { annex: 'IX', maxWeeks: 6, compulsoryWeeks: 3 });
  assert.strictEqual(r.annexBiddingWeeks(300, 'Shopping-National', false), null);
});

test('date helpers', () => {
  assert.strictEqual(r.addDays('2027-01-31', 1), '2027-02-01');
  assert.strictEqual(r.addDays('2027-12-31', 1), '2028-01-01');
  assert.strictEqual(r.diffDays('2027-01-01', '2027-03-01'), 59);
});

test('buildSchedule orders milestones and honours delivery date', () => {
  const s = r.buildSchedule({ start: '2027-02-01', delivery: '2027-12-15', method: 'NCB', tceInclMn: 100 });
  const keys = r.MILESTONES.map(m => m.key);
  assert.deepStrictEqual(Object.keys(s), keys);
  assert.strictEqual(s.appoint_pc.scheduled, '2027-02-01');
  assert.strictEqual(s.invitation.scheduled, '2027-03-01');
  assert.strictEqual(s.opening.scheduled, '2027-03-22'); // 21-day NCB >= 50 Mn
  assert.strictEqual(s.completion.scheduled, '2027-12-15');
  const dates = keys.slice(0, -1).map(k => s[k].scheduled);
  assert.deepStrictEqual([...dates].sort(), dates);
  assert.deepStrictEqual(r.buildSchedule({ start: null }), {});
});

test('checkItem flags shopping over cap, low committee and short windows', () => {
  const over = r.checkItem({ method: 'Shopping-National', tce_excl_vat_mn: 30, vat_pct: 18, funding_source: 'GOSL' }, 'goods');
  assert.ok(over.warnings.some(w => /exceeds the Shopping limit/.test(w)));

  const low = r.checkItem({ method: 'NCB', tce_excl_vat_mn: 400, vat_pct: 18, funding_source: 'GOSL', committee_level: 'RPC' }, 'works');
  assert.strictEqual(low.suggested_committee, 'MPC'); // 472 Mn incl. VAT
  assert.ok(low.warnings.some(w => /below the authority limit/.test(w)));

  const short = r.checkItem({ method: 'ICB', tce_excl_vat_mn: 100, vat_pct: 18, funding_source: 'GOSL', procurement_start: '2027-01-01', expected_delivery: '2027-01-20' }, 'works');
  assert.ok(short.warnings.some(w => /shorter than the minimum bidding period/.test(w)));
  assert.strictEqual(short.annex.annex, 'IX');

  const ok = r.checkItem({ method: 'NCB', tce_excl_vat_mn: 10, vat_pct: 18, funding_source: 'GOSL', procurement_start: '2027-01-01', expected_delivery: '2027-08-01' }, 'goods');
  assert.deepStrictEqual(ok.warnings, []);
});
