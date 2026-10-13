const test = require('node:test');
const assert = require('node:assert');
const phasing = require('../src/phasing');
const rules = require('../src/rules');

test('phasing.parse accepts shares adding to 100 and drops trailing empty years', () => {
  assert.deepStrictEqual(phasing.parse([40, 60]), [40, 60]);
  assert.deepStrictEqual(phasing.parse(['30', '70', '']), [30, 70]);
  assert.strictEqual(phasing.parse([100, 0, 0]), null);
  assert.strictEqual(phasing.parse(null), null);
  assert.throws(() => phasing.parse([40, 50]), /add up to 100/);
  assert.throws(() => phasing.parse([120, -20]), /between 0 and 100/);
  assert.throws(() => phasing.parse([25, 25, 25, 25]), /at most 3/);
});

test('phasing.share gives each year its fraction; unphased is all in the start year', () => {
  assert.strictEqual(phasing.share([40, 60], 0), 0.4);
  assert.strictEqual(phasing.share([40, 60], 1), 0.6);
  assert.strictEqual(phasing.share([40, 60], 2), 0);
  assert.strictEqual(phasing.share(null, 0), 1);
  assert.strictEqual(phasing.share(null, 1), 0);
});

test('dateGuidance works back from the required date', () => {
  const g = rules.dateGuidance({ requiredDate: '2027-12-31', method: 'NCB', tceInclMn: 30, manualType: 'goods', today: '2027-01-10' });
  // 28 prep + 14 bidding (NCB < 50 Mn) + 35 award approval + 21 signing + 60 delivery (goods <= 50 Mn)
  assert.strictEqual(g.total_days, 158);
  assert.strictEqual(g.feasible, true);
  assert.strictEqual(g.delivery, '2027-12-31');
  assert.strictEqual(g.start, rules.addDays('2027-12-31', -158));
});

test('dateGuidance flags a required date that cannot be met', () => {
  const g = rules.dateGuidance({ requiredDate: '2027-02-01', method: 'ICB', tceInclMn: 300, manualType: 'goods', today: '2027-01-10' });
  assert.strictEqual(g.feasible, false);
  assert.strictEqual(g.start, '2027-01-10');
  assert.ok(g.late_days > 0);
  // international procurement adds shipping time to goods delivery
  assert.strictEqual(rules.deliveryDays('goods', 300, 'ICB'), 120 + 60);
});
