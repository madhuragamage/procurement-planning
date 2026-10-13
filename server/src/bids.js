// Bid numbers: when the P&P unit starts executing a procurement it is classed as a tender or a quotation
// and given a bid number (e.g. T/2026/0001, Q/2026/0001), kept alongside the procurement reference.
// db / util are loaded on use so suggestType() stays a pure, testable function.
const rules = require('./rules');

const BID_TYPES = ['tender', 'quotation'];

// Competitive bidding is a tender; shopping is a quotation. Other methods must be chosen explicitly.
function suggestType(method) {
  const fam = rules.methodFamily(method);
  if (fam === 'ICB' || fam === 'NCB') return 'tender';
  if (fam === 'SHOPPING') return 'quotation';
  return null;
}

async function prefixes(conn) {
  const [rows] = await (conn || require('./db')).query("SELECT value FROM settings WHERE `key` = 'bid_numbering'");
  const v = rows.length ? rows[0].value : {};
  return { tender: v.tender || 'T', quotation: v.quotation || 'Q' };
}

// Gives the item its bid number inside the caller's transaction (no-op if it already has one).
async function assign(conn, itemId, bidType) {
  const { HttpError, oneOf } = require('./util');
  const type = oneOf(bidType, BID_TYPES, 'Tender or quotation');
  const [[it]] = await conn.query('SELECT bid_no FROM plan_items WHERE id = ? FOR UPDATE', [itemId]);
  if (!it) throw new HttpError(404, 'Plan item not found.');
  if (it.bid_no) return it.bid_no;
  const prefix = (await prefixes(conn))[type];
  const year = new Date().getFullYear();
  const stem = `${prefix}/${year}/`;
  // Lock the year's numbers for this prefix so two people cannot take the same one.
  const [rows] = await conn.query('SELECT bid_no FROM plan_items WHERE bid_no LIKE ? FOR UPDATE', [stem.replace(/[%_]/g, '\\$&') + '%']);
  const next = rows.reduce((m, r) => Math.max(m, Number(r.bid_no.slice(stem.length)) || 0), 0) + 1;
  const bidNo = stem + String(next).padStart(4, '0');
  await conn.query('UPDATE plan_items SET bid_type = ?, bid_no = ? WHERE id = ?', [type, bidNo, itemId]);
  return bidNo;
}

module.exports = { BID_TYPES, suggestType, assign, prefixes };
