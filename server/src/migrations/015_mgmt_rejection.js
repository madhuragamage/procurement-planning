// A procurement that management removes from a submitted plan is rejected by management (not sent back to the
// procurement inbox). It can come back only deliberately: through a plan revision once the plan is approved, or
// by the procurement unit reinstating it while the plan is still being prepared.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'requests', 'mgmt_rejected_at'))) {
    await db.query('ALTER TABLE requests ADD COLUMN mgmt_rejected_at DATETIME NULL, ADD COLUMN mgmt_rejected_by INT NULL');
  }
  // Requests already removed by management (logged as "<ref> <title> removed from the plan: <reason>") that are
  // still authorised and out of the plan become rejected by management.
  const [removed] = await db.query("SELECT entity_id AS fy, comment, user_id, at FROM audit_log WHERE action = 'mgmt-remove' ORDER BY id");
  for (const a of removed) {
    const ref = String(a.comment || '').split(' ')[0].replace(/\/R\d+$/, '');
    const reason = (String(a.comment).match(/removed from the plan: (.*)$/) || [])[1] || null;
    const [[r]] = await db.query(
      "SELECT r.id FROM requests r WHERE r.ref_no = ? AND r.status = 'authorised' AND NOT EXISTS (SELECT 1 FROM plan_items i WHERE i.request_id = r.id)", [ref]);
    if (!r) continue;
    await db.query("UPDATE requests SET status = 'rejected', mgmt_rejected_at = ?, mgmt_rejected_by = ?, review_comment = ? WHERE id = ?",
      [a.at, a.user_id, `Removed from the ${a.fy} plan by management${reason ? `: ${reason}` : ''}`, r.id]);
  }
};
