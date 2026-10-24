// The BEC (TEC) has two tasks in a procurement, activated separately so that waiting for bids is never
// counted as committee delay:
//   stage 1 - preparation of bidding documents / specifications (activated on appointment)
//   stage 2 - bid evaluation (activated later, normally after bid opening)
// Each stage has its own activation date, due date and completion; each member has a submission (and
// reminders) per stage. Committees from before this change had a single task - the evaluation, whose
// completion recorded the "Bid evaluation" milestone - so they become stage 2.

module.exports = async function run(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS tec_stages (
    id INT AUTO_INCREMENT PRIMARY KEY, committee_id INT NOT NULL, stage TINYINT NOT NULL,
    activated_on DATE NOT NULL, due_date DATE NOT NULL, completed_on DATE NULL,
    UNIQUE KEY uq_tec_stage (committee_id, stage),
    FOREIGN KEY (committee_id) REFERENCES tec_committees(id) ON DELETE CASCADE) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS tec_task_progress (
    id INT AUTO_INCREMENT PRIMARY KEY, assignment_id INT NOT NULL, stage TINYINT NOT NULL,
    submitted_on DATE NULL, reminder_before_at DATETIME NULL, reminder_overdue_at DATETIME NULL,
    UNIQUE KEY uq_tec_task (assignment_id, stage),
    FOREIGN KEY (assignment_id) REFERENCES tec_assignments(id) ON DELETE CASCADE) ENGINE=InnoDB`);

  await db.query(`INSERT IGNORE INTO tec_stages (committee_id, stage, activated_on, due_date, completed_on)
    SELECT id, 2, appointed_on, due_date, completed_on FROM tec_committees`);
  await db.query(`INSERT IGNORE INTO tec_task_progress (assignment_id, stage, submitted_on, reminder_before_at, reminder_overdue_at)
    SELECT id, 2, submitted_on, reminder_before_at, reminder_overdue_at FROM tec_assignments`);
};
