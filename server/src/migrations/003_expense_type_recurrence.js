// CAPEX / OPEX classification on requests and budget lines, and annually recurrent procurements that are
// projected into the tentative years of the plan cycle with a yearly percentage increase.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}
async function addColumn(db, table, column, ddl) {
  if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
async function hasIndex(db, table, name) {
  const [r] = await db.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
}

module.exports = async function run(db) {
  await addColumn(db, 'requests', 'expense_type', "ENUM('CAPEX','OPEX') NOT NULL DEFAULT 'CAPEX'");
  await addColumn(db, 'requests', 'recurrence', "ENUM('one_time','recurrent') NOT NULL DEFAULT 'one_time'");
  await addColumn(db, 'requests', 'annual_increase_pct', 'DECIMAL(5,2) NOT NULL DEFAULT 0');
  await addColumn(db, 'budgets', 'expense_type', "ENUM('CAPEX','OPEX') NOT NULL DEFAULT 'CAPEX'");

  // A recurrent request yields one plan item per remaining cycle year: recur_index 0 is the item itself,
  // 1 and 2 are the projected repeats. So request_id is unique per recur_index rather than outright.
  await addColumn(db, 'plan_items', 'recur_index', 'TINYINT NOT NULL DEFAULT 0');
  if (!(await hasIndex(db, 'plan_items', 'uq_item_request_recur'))) {
    await db.query('ALTER TABLE plan_items ADD UNIQUE KEY uq_item_request_recur (request_id, recur_index)');
  }
  if (await hasIndex(db, 'plan_items', 'request_id')) await db.query('ALTER TABLE plan_items DROP INDEX request_id');
};
