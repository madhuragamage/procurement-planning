SET NAMES utf8mb4;

CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','requester','dept_head','procurement','management') NOT NULL,
  department_id INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB;

CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  manual_type ENUM('goods','works','services') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ref_no VARCHAR(40) NOT NULL UNIQUE,
  department_id INT NOT NULL,
  category_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  tce_excl_vat_mn DECIMAL(14,3) NOT NULL DEFAULT 0,
  vat_pct DECIMAL(5,2) NOT NULL DEFAULT 18,
  funding_source ENUM('GOSL','Foreign') NOT NULL DEFAULT 'GOSL',
  funding_agency VARCHAR(120) NULL,
  priority ENUM('U','P','N') NOT NULL DEFAULT 'N',
  plan_fy INT NOT NULL,
  year_offset TINYINT NOT NULL DEFAULT 0,
  required_date DATE NULL,
  status ENUM('draft','submitted','authorised','returned','rejected') NOT NULL DEFAULT 'draft',
  review_comment TEXT NULL,
  requested_by INT NOT NULL,
  authorised_by INT NULL,
  authorised_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (authorised_by) REFERENCES users(id),
  INDEX idx_req_status (status),
  INDEX idx_req_fy (plan_fy)
) ENGINE=InnoDB;

CREATE TABLE plans (
  fy INT PRIMARY KEY,
  status ENUM('planning','submitted','changes_requested','approved','frozen') NOT NULL DEFAULT 'planning',
  version INT NOT NULL DEFAULT 0,
  review_comment TEXT NULL,
  submitted_at DATETIME NULL,
  approved_by INT NULL,
  approved_at DATETIME NULL,
  frozen_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE plan_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL UNIQUE,
  plan_fy INT NOT NULL,
  year_offset TINYINT NOT NULL DEFAULT 0,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  tce_excl_vat_mn DECIMAL(14,3) NOT NULL DEFAULT 0,
  vat_pct DECIMAL(5,2) NOT NULL DEFAULT 18,
  funding_source ENUM('GOSL','Foreign') NOT NULL DEFAULT 'GOSL',
  funding_agency VARCHAR(120) NULL,
  method VARCHAR(30) NULL,
  bidding_procedure VARCHAR(30) NULL,
  prequalification TINYINT(1) NOT NULL DEFAULT 0,
  committee_level VARCHAR(20) NULL,
  procurement_start DATE NULL,
  expected_delivery DATE NULL,
  milestones JSON NULL,
  contractor VARCHAR(160) NULL,
  award_value_mn DECIMAL(14,3) NULL,
  contract_date DATE NULL,
  status ENUM('planned','in_progress','awarded','completed','cancelled') NOT NULL DEFAULT 'planned',
  remarks TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES requests(id),
  FOREIGN KEY (plan_fy) REFERENCES plans(fy),
  INDEX idx_pi_fy (plan_fy)
) ENGINE=InnoDB;

CREATE TABLE plan_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fy INT NOT NULL,
  version INT NOT NULL,
  label VARCHAR(160) NOT NULL,
  data LONGTEXT NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fy) REFERENCES plans(fy),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_snap_fy (fy)
) ENGINE=InnoDB;

CREATE TABLE plan_revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_fy INT NOT NULL,
  kind ENUM('bi_annual','urgent') NOT NULL DEFAULT 'bi_annual',
  title VARCHAR(200) NOT NULL,
  justification TEXT NULL,
  status ENUM('draft','submitted','approved','rejected') NOT NULL DEFAULT 'draft',
  created_by INT NOT NULL,
  submitted_at DATETIME NULL,
  decided_by INT NULL,
  decided_at DATETIME NULL,
  decision_comment TEXT NULL,
  applied_version INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_fy) REFERENCES plans(fy),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (decided_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE revision_changes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  revision_id INT NOT NULL,
  item_id INT NULL,
  action ENUM('add','modify','cancel') NOT NULL,
  payload JSON NULL,
  reason TEXT NULL,
  FOREIGN KEY (revision_id) REFERENCES plan_revisions(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES plan_items(id)
) ENGINE=InnoDB;

CREATE TABLE budgets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  year INT NOT NULL,
  department_id INT NOT NULL,
  category_id INT NULL,
  amount_mn DECIMAL(14,3) NOT NULL,
  source VARCHAR(80) NULL,
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  INDEX idx_budget_year (year)
) ENGINE=InnoDB;

CREATE TABLE settings (
  `key` VARCHAR(60) PRIMARY KEY,
  value JSON NOT NULL
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity VARCHAR(30) NOT NULL,
  entity_id VARCHAR(30) NOT NULL,
  action VARCHAR(40) NOT NULL,
  user_id INT NULL,
  comment TEXT NULL,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_entity (entity, entity_id)
) ENGINE=InnoDB;

INSERT INTO departments (code, name) VALUES
  ('PROC', 'Procurement Unit'),
  ('ENG',  'Engineering & Projects'),
  ('OPS',  'Operations & Maintenance'),
  ('FIN',  'Finance'),
  ('HRA',  'Human Resources & Administration'),
  ('IT',   'Information Technology');

INSERT INTO categories (name, manual_type) VALUES
  ('Land', 'works'),
  ('Building', 'works'),
  ('Civil Works', 'works'),
  ('Services', 'services'),
  ('Materials', 'goods'),
  ('Tools', 'goods'),
  ('Vehicles', 'goods'),
  ('IT Equipment', 'goods');

INSERT INTO settings (`key`, value) VALUES ('org', JSON_OBJECT('name', 'Lanka Electricity Company (Pvt) Ltd'));
