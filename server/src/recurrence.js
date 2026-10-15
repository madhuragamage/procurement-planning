// Annually recurrent procurements: the same need repeats in each later year of the three-year plan cycle,
// with the estimate increased by a fixed percentage per year (compounded).

const EXPENSE_TYPES = ['CAPEX', 'OPEX', 'Inventory']; // the "Budget Category"
const RECURRENCE = ['one_time', 'recurrent'];

// Same calendar date k years later; 29 Feb falls back to 28 Feb in a non-leap year.
function addYears(iso, k) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const ny = y + k;
  const last = new Date(Date.UTC(ny, m, 0)).getUTCDate();
  return `${ny}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const escalate = (amount, pct, k) => Math.round(Number(amount) * Math.pow(1 + (Number(pct) || 0) / 100, k) * 1000) / 1000;

// Repeats of an item in the later years of its cycle (year offsets up to 2). Returns [] for one-time needs.
function projections({ year_offset, tce_excl_vat_mn, procurement_start, expected_delivery }, pct) {
  const out = [];
  for (let k = 1; year_offset + k <= 2; k++) {
    out.push({
      recur_index: k, year_offset: year_offset + k,
      tce_excl_vat_mn: escalate(tce_excl_vat_mn, pct, k),
      procurement_start: addYears(procurement_start, k), expected_delivery: addYears(expected_delivery, k)
    });
  }
  return out;
}

module.exports = { EXPENSE_TYPES, RECURRENCE, addYears, escalate, projections };
