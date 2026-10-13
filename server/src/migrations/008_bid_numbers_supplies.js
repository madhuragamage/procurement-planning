// Bid numbers (tender / quotation) assigned when the P&P unit starts executing a procurement, and the
// Supplies Department's post-award contract file: award details, process steps, bond register,
// deliveries (batches) with inspection, supplier correspondence and delivery-extension requests.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  await db.query("ALTER TABLE users MODIFY role ENUM('admin','requester','dept_head','procurement','management','executive','supplies') NOT NULL");

  if (!(await hasColumn(db, 'plan_items', 'bid_no'))) {
    await db.query("ALTER TABLE plan_items ADD COLUMN bid_type ENUM('tender','quotation') NULL, ADD COLUMN bid_no VARCHAR(40) NULL, ADD UNIQUE KEY uq_bid_no (bid_no)");
  }

  await db.query(`CREATE TABLE IF NOT EXISTS supply_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY, plan_item_id INT NOT NULL UNIQUE,
    status ENUM('forwarded','accepted','closed') NOT NULL DEFAULT 'forwarded',
    forwarded_on DATE NOT NULL, forwarded_by INT NOT NULL, forward_note VARCHAR(500) NULL,
    accepted_on DATE NULL, accepted_by INT NULL, officer_id INT NULL,
    supplier_name VARCHAR(200) NULL, supplier_address VARCHAR(400) NULL, supplier_email VARCHAR(190) NULL,
    supplier_phone VARCHAR(60) NULL, supplier_contact VARCHAR(120) NULL,
    award_ref VARCHAR(80) NULL, award_date DATE NULL, order_type ENUM('purchase_order','letter_of_acceptance') NULL, order_no VARCHAR(80) NULL,
    local_cost_lkr DECIMAL(16,2) NULL, foreign_currency VARCHAR(3) NULL, foreign_cost DECIMAL(16,2) NULL,
    incoterm VARCHAR(10) NULL, freight_lkr DECIMAL(16,2) NULL, insurance_lkr DECIMAL(16,2) NULL,
    bid_bond_amount DECIMAL(16,2) NULL, bid_bond_validity DATE NULL, bid_validity DATE NULL, delivery_date DATE NULL,
    advance_bond_required TINYINT(1) NOT NULL DEFAULT 0, proof_required TINYINT(1) NOT NULL DEFAULT 0,
    contract_agreement_required TINYINT(1) NOT NULL DEFAULT 0, payment_mode ENUM('local','LC','TT') NOT NULL DEFAULT 'local',
    fat_required TINYINT(1) NOT NULL DEFAULT 0, duty_waiver_required TINYINT(1) NOT NULL DEFAULT 0, batch_delivery TINYINT(1) NOT NULL DEFAULT 0,
    pb_amount DECIMAL(16,2) NULL, pb_validity DATE NULL, pb_due DATE NULL, pi_due DATE NULL,
    pb_reminded_at DATETIME NULL, pi_reminded_at DATETIME NULL,
    steps JSON NULL, notes TEXT NULL, closed_on DATE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_item_id) REFERENCES plan_items(id), FOREIGN KEY (forwarded_by) REFERENCES users(id),
    FOREIGN KEY (accepted_by) REFERENCES users(id), FOREIGN KEY (officer_id) REFERENCES users(id),
    INDEX idx_sc_status (status)) ENGINE=InnoDB`);

  await db.query(`CREATE TABLE IF NOT EXISTS supply_bonds (
    id INT AUTO_INCREMENT PRIMARY KEY, contract_id INT NOT NULL, kind ENUM('bid','performance','advance') NOT NULL,
    bond_no VARCHAR(80) NULL, bank VARCHAR(160) NULL, amount DECIMAL(16,2) NULL, currency VARCHAR(3) NOT NULL DEFAULT 'LKR',
    issued_on DATE NULL, expiry_date DATE NULL, received_on DATE NULL, sent_to_legal_on DATE NULL, legal_cleared_on DATE NULL,
    status ENUM('expected','held','released','returned','forfeited') NOT NULL DEFAULT 'held', released_on DATE NULL,
    extension_requested_on DATE NULL, forfeiture_letter_on DATE NULL, expiry_notice_at DATETIME NULL, notes VARCHAR(500) NULL,
    FOREIGN KEY (contract_id) REFERENCES supply_contracts(id) ON DELETE CASCADE, INDEX idx_bond_expiry (expiry_date)) ENGINE=InnoDB`);

  await db.query(`CREATE TABLE IF NOT EXISTS supply_deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY, contract_id INT NOT NULL, batch_no INT NOT NULL, description VARCHAR(300) NULL, quantity VARCHAR(80) NULL,
    inspection_arranged_on DATE NULL, inspected_on DATE NULL, inspection_result ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
    inspected_by VARCHAR(120) NULL, delivered_on DATE NULL, location VARCHAR(120) NULL, handed_over_on DATE NULL, handed_over_to VARCHAR(200) NULL,
    notes VARCHAR(500) NULL,
    FOREIGN KEY (contract_id) REFERENCES supply_contracts(id) ON DELETE CASCADE) ENGINE=InnoDB`);

  await db.query(`CREATE TABLE IF NOT EXISTS supply_letters (
    id INT AUTO_INCREMENT PRIMARY KEY, contract_id INT NOT NULL,
    kind ENUM('acceptance','rejection','delivery_extension','delay_reminder','bond_extension_request','forfeiture','pb_pi_request','other') NOT NULL,
    letter_date DATE NOT NULL, reference VARCHAR(80) NULL, summary VARCHAR(500) NULL, created_by INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contract_id) REFERENCES supply_contracts(id) ON DELETE CASCADE, FOREIGN KEY (created_by) REFERENCES users(id)) ENGINE=InnoDB`);

  await db.query(`CREATE TABLE IF NOT EXISTS supply_extensions (
    id INT AUTO_INCREMENT PRIMARY KEY, contract_id INT NOT NULL, requested_on DATE NOT NULL, current_delivery DATE NULL,
    requested_delivery DATE NOT NULL, reason VARCHAR(500) NULL, delay_waiver TINYINT(1) NOT NULL DEFAULT 0,
    decision ENUM('pending','granted','refused') NOT NULL DEFAULT 'pending', decided_on DATE NULL, decided_by VARCHAR(120) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contract_id) REFERENCES supply_contracts(id) ON DELETE CASCADE) ENGINE=InnoDB`);

  await db.query(`INSERT IGNORE INTO settings (\`key\`, value) VALUES ('supplies', JSON_OBJECT(
    'pb_days', 14, 'pi_days', 14, 'pb_validity_extra_days', 60, 'bond_notice_days', 7, 'reminder_interval_days', 7, 'contract_agreement_days', 30))`);
  await db.query("INSERT IGNORE INTO settings (`key`, value) VALUES ('bid_numbering', JSON_OBJECT('tender', 'T', 'quotation', 'Q'))");
};
