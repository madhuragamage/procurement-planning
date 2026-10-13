// Technical Evaluation Committees: a directory of members, committees appointed per plan item with a due
// date for the evaluation, each member's appointment / reminder e-mails and submission, and an e-mail log.

module.exports = async function run(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS tec_members (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE,
    designation VARCHAR(120) NULL, department_id INT NULL, phone VARCHAR(40) NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES departments(id)) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS tec_committees (
    id INT AUTO_INCREMENT PRIMARY KEY, plan_item_id INT NOT NULL, appointed_on DATE NOT NULL, due_date DATE NOT NULL,
    status ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active', completed_on DATE NULL, notes TEXT NULL,
    created_by INT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_item_id) REFERENCES plan_items(id), FOREIGN KEY (created_by) REFERENCES users(id),
    INDEX idx_tec_status (status)) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS tec_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY, committee_id INT NOT NULL, member_id INT NOT NULL,
    role ENUM('chair','member','secretary') NOT NULL DEFAULT 'member',
    appointment_sent_at DATETIME NULL, reminder_before_at DATETIME NULL, reminder_overdue_at DATETIME NULL,
    submitted_on DATE NULL, remarks VARCHAR(500) NULL,
    UNIQUE KEY uq_tec_member (committee_id, member_id),
    FOREIGN KEY (committee_id) REFERENCES tec_committees(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES tec_members(id)) ENGINE=InnoDB`);
  await db.query(`CREATE TABLE IF NOT EXISTS email_log (
    id INT AUTO_INCREMENT PRIMARY KEY, to_email VARCHAR(190) NOT NULL, subject VARCHAR(250) NOT NULL, body TEXT NOT NULL,
    kind VARCHAR(40) NOT NULL, entity VARCHAR(30) NULL, entity_id VARCHAR(30) NULL,
    status ENUM('sent','failed','not_configured') NOT NULL, error VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_entity (entity, entity_id)) ENGINE=InnoDB`);
  await db.query("INSERT IGNORE INTO settings (`key`, value) VALUES ('tec', JSON_OBJECT('reminder_days', 7))");
};
