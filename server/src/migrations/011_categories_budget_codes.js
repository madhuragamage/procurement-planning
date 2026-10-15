// Main procurement category (Goods / Works / Non-Consultancy Services / Consultancy Services) with sub
// categories, the "Budget Category" (CAPEX / OPEX / Inventory) and admin-maintained budget codes.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}
async function hasIndex(db, table, name) {
  const [r] = await db.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
}

// [main category, sub category, earlier name it replaces (kept id)]
const SUBS = [
  ['goods', 'Standard Materials', 'Materials'], ['goods', 'Tools', 'Tools'], ['goods', 'IT-related', 'IT Equipment'],
  ['goods', 'Vehicles', 'Vehicles'], ['goods', 'Administration related', null],
  ['works', 'Land', 'Land'], ['works', 'Building', 'Building'], ['works', 'Civil Works', 'Civil Works'],
  ['services', 'IT-related', null], ['services', 'Administration', null], ['services', 'Finance', null], ['services', 'Engineering', null], ['services', 'Corporate', null],
  ['consultancy', 'IT-related', null], ['consultancy', 'Administration', null], ['consultancy', 'Finance', null], ['consultancy', 'Engineering', null], ['consultancy', 'Corporate', null]
];

module.exports = async function run(db) {
  // The same sub category name may appear under several main categories.
  await db.query("ALTER TABLE categories MODIFY manual_type ENUM('goods','works','services','consultancy') NOT NULL");
  if (!(await hasIndex(db, 'categories', 'uq_category_main_name'))) await db.query('ALTER TABLE categories ADD UNIQUE KEY uq_category_main_name (manual_type, name)');
  if (await hasIndex(db, 'categories', 'name')) await db.query('ALTER TABLE categories DROP INDEX name');

  const keep = new Set();
  for (const [main, name, old] of SUBS) {
    let [[row]] = await db.query('SELECT id FROM categories WHERE manual_type = ? AND name = ?', [main, name]);
    if (!row && old) [[row]] = await db.query('SELECT id FROM categories WHERE name = ? AND id NOT IN (?)', [old, [0, ...keep]]);
    if (row) await db.query('UPDATE categories SET manual_type = ?, name = ?, active = 1 WHERE id = ?', [main, name, row.id]);
    else row = { id: (await db.query('INSERT INTO categories (name, manual_type) VALUES (?,?)', [name, main]))[0].insertId };
    keep.add(row.id);
  }
  // Earlier categories not in the new list: removed if unused, otherwise kept but retired.
  const [others] = await db.query('SELECT id FROM categories WHERE id NOT IN (?)', [[0, ...keep]]);
  for (const c of others) {
    const [[used]] = await db.query('SELECT (SELECT COUNT(*) FROM requests WHERE category_id = ?) + (SELECT COUNT(*) FROM budgets WHERE category_id = ?) AS n', [c.id, c.id]);
    if (used.n) await db.query('UPDATE categories SET active = 0 WHERE id = ?', [c.id]);
    else await db.query('DELETE FROM categories WHERE id = ?', [c.id]);
  }

  // Budget Category: CAPEX / OPEX / Inventory.
  await db.query("ALTER TABLE requests MODIFY expense_type ENUM('CAPEX','OPEX','Inventory') NOT NULL DEFAULT 'CAPEX'");
  await db.query("ALTER TABLE budgets MODIFY expense_type ENUM('CAPEX','OPEX','Inventory') NOT NULL DEFAULT 'CAPEX'");

  await db.query(`CREATE TABLE IF NOT EXISTS budget_codes (
    id INT AUTO_INCREMENT PRIMARY KEY, expense_type ENUM('CAPEX','OPEX','Inventory') NOT NULL, code VARCHAR(30) NOT NULL,
    description VARCHAR(200) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_budget_code (expense_type, code)) ENGINE=InnoDB`);
  if (!(await hasColumn(db, 'requests', 'budget_code_id'))) {
    await db.query('ALTER TABLE requests ADD COLUMN budget_code_id INT NULL, ADD CONSTRAINT fk_req_budget_code FOREIGN KEY (budget_code_id) REFERENCES budget_codes(id)');
  }
  // The two examples given.
  await db.query("INSERT IGNORE INTO budget_codes (expense_type, code, description) VALUES ('OPEX', '30860', 'Consultancy fees'), ('OPEX', '30530', 'Computer maintenance')");
};
