// Department-initiated requests to modify or cancel an item of an approved plan. The procurement unit
// either includes them in a draft revision (which management then decides on) or returns them.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS change_requests (
    id INT AUTO_INCREMENT PRIMARY KEY, plan_item_id INT NOT NULL, action ENUM('modify','cancel') NOT NULL,
    payload JSON NULL, reason TEXT NOT NULL, requested_by INT NOT NULL,
    status ENUM('pending','included','returned') NOT NULL DEFAULT 'pending', revision_id INT NULL,
    decided_by INT NULL, decided_at DATETIME NULL, decision_comment VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_item_id) REFERENCES plan_items(id), FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (revision_id) REFERENCES plan_revisions(id), FOREIGN KEY (decided_by) REFERENCES users(id),
    INDEX idx_cr_status (status)) ENGINE=InnoDB`);
  if (!(await hasColumn(db, 'revision_changes', 'change_request_id'))) {
    await db.query('ALTER TABLE revision_changes ADD COLUMN change_request_id INT NULL, ADD CONSTRAINT fk_rc_change_request FOREIGN KEY (change_request_id) REFERENCES change_requests(id)');
  }
};
