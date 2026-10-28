// 1. Management may amend a submitted plan before approving it: items record when and by whom.
// 2. Request reference numbers become <plan year>-<running number>-<department code>, e.g. 2027-01-DD, numbered
//    from 01 each plan year across all departments (repeat orders keep the /R1, /R2 suffix on the plan item).

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'plan_items', 'mgmt_amended_at'))) {
    await db.query('ALTER TABLE plan_items ADD COLUMN mgmt_amended_at DATETIME NULL, ADD COLUMN mgmt_amended_by INT NULL');
  }

  // Renumber existing requests in the order they were created, per plan year.
  const [rows] = await db.query('SELECT r.id, r.plan_fy, d.code FROM requests r JOIN departments d ON d.id = r.department_id ORDER BY r.plan_fy, r.id');
  const seq = new Map();
  const renamed = rows.map(r => {
    const n = (seq.get(r.plan_fy) || 0) + 1; seq.set(r.plan_fy, n);
    return { id: r.id, ref: `${r.plan_fy}-${String(n).padStart(2, '0')}-${r.code}` };
  });
  // Two passes so the unique key never sees a clash between an old and a new number.
  for (const r of renamed) await db.query('UPDATE requests SET ref_no = ? WHERE id = ?', [`RENUM-${r.id}`, r.id]);
  for (const r of renamed) await db.query('UPDATE requests SET ref_no = ? WHERE id = ?', [r.ref, r.id]);
};
