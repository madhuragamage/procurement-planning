// Multi-year budget phasing: the share (%) of a procurement's value needed in each budget year, counted
// from the year the procurement starts. NULL means the whole value falls in the start year.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'requests', 'budget_phasing'))) await db.query('ALTER TABLE requests ADD COLUMN budget_phasing JSON NULL');
};
