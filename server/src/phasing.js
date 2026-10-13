// Budget phasing: a procurement that starts in one year may need only part of its value in that year's
// budget and the rest in the following years. Stored as percentages by year counted from the start year,
// e.g. [40, 60] = 40% in the start year, 60% the year after. null / [] = everything in the start year.

const MAX_YEARS = 3;

// Validates user input. Returns a clean array (trailing zero years dropped), or null for single-year.
// Throws an Error with a user-facing message when invalid.
function parse(raw) {
  if (raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return null;
  if (!Array.isArray(raw) || raw.length > MAX_YEARS) throw new Error(`Budget phasing covers at most ${MAX_YEARS} years.`);
  const p = raw.map(v => (v === '' || v == null ? 0 : Number(v)));
  if (p.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error('Each year\'s budget share must be between 0 and 100%.');
  const sum = p.reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 100) > 0.01) throw new Error(`Budget shares must add up to 100% (now ${Math.round(sum * 100) / 100}%).`);
  while (p.length && p[p.length - 1] === 0) p.pop();
  return p.length <= 1 ? null : p.map(v => Math.round(v * 100) / 100);
}

// Fraction of the value needed k years after the start year.
function share(phasing, k) {
  const p = Array.isArray(phasing) && phasing.length > 1 ? phasing : [100];
  return k >= 0 && k < p.length ? p[k] / 100 : 0;
}

// Number of budget years the value is spread over.
const span = phasing => (Array.isArray(phasing) && phasing.length > 1 ? phasing.length : 1);

module.exports = { MAX_YEARS, parse, share, span };
