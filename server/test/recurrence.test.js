const test = require('node:test');
const assert = require('node:assert');
const { addYears, escalate, projections } = require('../src/recurrence');

test('addYears keeps the calendar date and handles 29 February', () => {
  assert.strictEqual(addYears('2027-03-15', 1), '2028-03-15');
  assert.strictEqual(addYears('2028-02-29', 1), '2029-02-28');
  assert.strictEqual(addYears(null, 1), null);
});

test('escalate compounds the yearly increase', () => {
  assert.strictEqual(escalate(100, 10, 0), 100);
  assert.strictEqual(escalate(100, 10, 1), 110);
  assert.strictEqual(escalate(100, 10, 2), 121);
  assert.strictEqual(escalate(100, 0, 2), 100);
});

test('a recurrent item in the annual year repeats in both tentative years', () => {
  const p = projections({ year_offset: 0, tce_excl_vat_mn: 50, procurement_start: '2027-02-01', expected_delivery: '2027-06-30' }, 5);
  assert.deepStrictEqual(p, [
    { recur_index: 1, year_offset: 1, tce_excl_vat_mn: 52.5, procurement_start: '2028-02-01', expected_delivery: '2028-06-30' },
    { recur_index: 2, year_offset: 2, tce_excl_vat_mn: 55.125, procurement_start: '2029-02-01', expected_delivery: '2029-06-30' }
  ]);
});

test('projections stop at the end of the three-year cycle', () => {
  assert.strictEqual(projections({ year_offset: 1, tce_excl_vat_mn: 10 }, 5).length, 1);
  assert.strictEqual(projections({ year_offset: 2, tce_excl_vat_mn: 10 }, 5).length, 0);
});
