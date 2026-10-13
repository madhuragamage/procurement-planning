const express = require('express');
const pool = require('../db');
const rules = require('../rules');
const { wrap, HttpError } = require('../util');
const { loadLimits } = require('./lookups');

const router = express.Router();

// Live rule hints for the assignment form. Nothing here is persisted.
router.post('/suggest', wrap(async (req, res) => {
  const b = req.body || {};
  const tce = Number(b.tce_excl_vat_mn);
  const vat = b.vat_pct === undefined || b.vat_pct === '' ? 18 : Number(b.vat_pct);
  if (!Number.isFinite(tce) || tce < 0 || !Number.isFinite(vat) || vat < 0) throw new HttpError(400, 'Enter valid cost and VAT values.');
  let manualType = null;
  if (b.category_id) {
    const [rows] = await pool.query('SELECT manual_type FROM categories WHERE id = ?', [Number(b.category_id)]);
    if (rows.length) manualType = rows[0].manual_type;
  }
  const limits = await loadLimits();
  const item = {
    tce_excl_vat_mn: tce, vat_pct: vat, funding_source: b.funding_source, method: b.method || null,
    prequalification: !!b.prequalification, committee_level: b.committee_level || null,
    procurement_start: b.procurement_start || null, expected_delivery: b.expected_delivery || null
  };
  const check = rules.checkItem(item, manualType, limits);
  const schedule = item.procurement_start
    ? rules.buildSchedule({ start: item.procurement_start, delivery: item.expected_delivery, method: item.method, tceInclMn: check.tce_incl_vat_mn })
    : null;
  const guidance = rules.dateGuidance({
    requiredDate: b.required_date || null, method: item.method, tceInclMn: check.tce_incl_vat_mn, manualType,
    prequalification: item.prequalification, today: new Date().toISOString().slice(0, 10)
  });
  if (item.expected_delivery && guidance.required_date) guidance.delivery_vs_required_days = rules.diffDays(guidance.required_date, item.expected_delivery);
  res.json({ ...check, manual_type: manualType, schedule, guidance });
}));

module.exports = router;
