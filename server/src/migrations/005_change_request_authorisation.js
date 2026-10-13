// Change requests raised by department users need their department head's authorisation before they
// reach the procurement unit ('submitted' -> 'pending'); a head's own requests go straight to 'pending'.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  await db.query("ALTER TABLE change_requests MODIFY status ENUM('submitted','pending','included','returned') NOT NULL DEFAULT 'submitted'");
  if (!(await hasColumn(db, 'change_requests', 'authorised_by'))) {
    await db.query('ALTER TABLE change_requests ADD COLUMN authorised_by INT NULL, ADD COLUMN authorised_at DATETIME NULL, ADD CONSTRAINT fk_cr_authorised_by FOREIGN KEY (authorised_by) REFERENCES users(id)');
  }
};
