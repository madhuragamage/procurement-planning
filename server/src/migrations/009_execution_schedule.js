// Working schedule chosen by the procurement unit once execution is authorised: the standard (auto) lead
// times or a custom number of weeks per milestone. The resulting dates are stored as each milestone's
// revised (target) date; the approved plan's scheduled dates stay as the baseline.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'plan_items', 'schedule_mode'))) {
    await db.query("ALTER TABLE plan_items ADD COLUMN schedule_mode ENUM('auto','custom') NULL, ADD COLUMN schedule_start DATE NULL, ADD COLUMN schedule_weeks JSON NULL");
  }
};
