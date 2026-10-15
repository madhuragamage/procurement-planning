// Display order of sub categories within each main category, as in LECO's category list. Sub categories
// added later go to the end (sort_order 999).

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

const ORDER = {
  goods: ['Standard Materials', 'Tools', 'IT-related', 'Vehicles', 'Administration related'],
  works: ['Land', 'Building', 'Civil Works'],
  services: ['IT-related', 'Administration', 'Finance', 'Engineering', 'Corporate'],
  consultancy: ['IT-related', 'Administration', 'Finance', 'Engineering', 'Corporate']
};

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'categories', 'sort_order'))) await db.query('ALTER TABLE categories ADD COLUMN sort_order INT NOT NULL DEFAULT 999');
  for (const [main, names] of Object.entries(ORDER)) {
    for (const [n, name] of names.entries()) await db.query('UPDATE categories SET sort_order = ? WHERE manual_type = ? AND name = ?', [n + 1, main, name]);
  }
};
