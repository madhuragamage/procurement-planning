// LECO organisation structure (division > department > sub unit), request reason and extra funding
// sources, executive (Board/CEO) role, and department-initiated execution requests.

const ORG = [
  ['Engineering', [
    ['DD', 'D&D', ['DCC', 'SGS', 'Training', 'RD&D']],
    ['PP', 'P&P', ['Planning', 'Procurement']],
    ['PRJ', 'Projects', ['Projects']],
    ['IT', 'IT', ['IT']],
    ['CIV', 'Civil', ['Civil']],
    ['PSS', 'PSSREIP', ['PSSREIP', 'VNM']]
  ]],
  ['Operations', [
    ['DGMW', 'DGM-W', ['Nugegoda', 'Kotte', 'Kelaniya', 'Negombo']],
    ['DGMS', 'DGM-S', ['Galle', 'Kalutara', 'Moratuwa']]
  ]],
  ['Corporate Strategic', [
    ['CS', 'Customer Service', ['Customer Services']],
    ['REG', 'Regulatory', ['Regulatory']]
  ]],
  ['HR & Admin', [
    ['LA', 'Legal & Admin', ['Legal', 'Admin']],
    ['HR', 'HR', ['HR']]
  ]],
  ['Finance', [
    ['FIN', 'Finance', ['Finance']],
    ['TRE', 'Treasury', ['Treasury']]
  ]],
  ['Audit', [['AUD', 'Audit', ['Audit']]]],
  ['Corporate', [['CORP', 'Corporate', ['Corporate']]]]
];

// Departments created by the version-1 seed, mapped onto the real structure where they correspond.
const LEGACY_CODE_MAP = { PROC: 'PP', FIN: 'FIN', IT: 'IT' };

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}
async function addColumn(db, table, column, ddl) {
  if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

module.exports = async function run(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS divisions (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB`);
  await addColumn(db, 'departments', 'division_id', 'INT NULL');
  await db.query(`CREATE TABLE IF NOT EXISTS sub_units (
    id INT AUTO_INCREMENT PRIMARY KEY, department_id INT NOT NULL, name VARCHAR(120) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_sub_unit (department_id, name), FOREIGN KEY (department_id) REFERENCES departments(id)) ENGINE=InnoDB`);

  await db.query("ALTER TABLE users MODIFY role ENUM('admin','requester','dept_head','procurement','management','executive') NOT NULL");
  await addColumn(db, 'users', 'sub_unit_id', 'INT NULL');

  await addColumn(db, 'requests', 'sub_unit_id', 'INT NULL');
  await addColumn(db, 'requests', 'reason', "VARCHAR(20) NOT NULL DEFAULT 'New'");
  await addColumn(db, 'requests', 'reason_note', 'VARCHAR(200) NULL');
  await db.query("ALTER TABLE requests MODIFY funding_source ENUM('LECO','GOSL','Foreign','Grant') NOT NULL DEFAULT 'LECO'");
  await db.query("ALTER TABLE plan_items MODIFY funding_source ENUM('LECO','GOSL','Foreign','Grant') NOT NULL DEFAULT 'LECO'");

  // Existing items already past 'planned' keep working: treat their execution as accepted.
  const fresh = !(await hasColumn(db, 'plan_items', 'exec_status'));
  await addColumn(db, 'plan_items', 'exec_status', "ENUM('not_requested','requested','accepted','returned') NOT NULL DEFAULT 'not_requested'");
  if (fresh) await db.query("UPDATE plan_items SET exec_status = 'accepted' WHERE status <> 'planned'");

  await db.query(`CREATE TABLE IF NOT EXISTS execution_requests (
    id INT AUTO_INCREMENT PRIMARY KEY, plan_item_id INT NOT NULL, requested_by INT NOT NULL, note VARCHAR(500) NULL,
    on_behalf TINYINT(1) NOT NULL DEFAULT 0, status ENUM('pending','accepted','returned') NOT NULL DEFAULT 'pending',
    decided_by INT NULL, decided_at DATETIME NULL, decision_comment VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_item_id) REFERENCES plan_items(id), FOREIGN KEY (requested_by) REFERENCES users(id), FOREIGN KEY (decided_by) REFERENCES users(id),
    INDEX idx_exec_status (status)) ENGINE=InnoDB`);

  // Foreign keys added after the fact (idempotent: skipped when they already exist).
  const fk = async (table, name, ddl) => {
    const [r] = await db.query('SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?', [table, name]);
    if (!r.length) await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${ddl}`);
  };
  await fk('departments', 'fk_dept_division', 'FOREIGN KEY (division_id) REFERENCES divisions(id)');
  await fk('users', 'fk_user_subunit', 'FOREIGN KEY (sub_unit_id) REFERENCES sub_units(id)');
  await fk('requests', 'fk_req_subunit', 'FOREIGN KEY (sub_unit_id) REFERENCES sub_units(id)');

  await db.query("INSERT IGNORE INTO settings (`key`, value) VALUES ('reminders', JSON_OBJECT('lead_days', 30))");

  // Organisation structure.
  const wantedCodes = new Set();
  for (const [divName, depts] of ORG) {
    await db.query('INSERT IGNORE INTO divisions (name) VALUES (?)', [divName]);
    const [[div]] = await db.query('SELECT id FROM divisions WHERE name = ?', [divName]);
    for (const [code, name, subs] of depts) {
      wantedCodes.add(code);
      let [[dept]] = await db.query('SELECT id FROM departments WHERE code = ?', [code]);
      if (!dept) {
        const legacy = Object.keys(LEGACY_CODE_MAP).find(k => LEGACY_CODE_MAP[k] === code);
        if (legacy) [[dept]] = await db.query('SELECT id FROM departments WHERE code = ?', [legacy]);
      }
      if (dept) await db.query('UPDATE departments SET code = ?, name = ?, division_id = ?, active = 1 WHERE id = ?', [code, name, div.id, dept.id]);
      else {
        const [ins] = await db.query('INSERT INTO departments (code, name, division_id) VALUES (?,?,?)', [code, name, div.id]);
        dept = { id: ins.insertId };
      }
      for (const s of subs) await db.query('INSERT IGNORE INTO sub_units (department_id, name) VALUES (?,?)', [dept.id, s]);
    }
  }

  // Leftover version-1 departments with no counterpart: drop if unused, otherwise keep but deactivate.
  const [leftovers] = await db.query('SELECT id, code FROM departments WHERE division_id IS NULL');
  for (const d of leftovers) {
    const [[used]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE department_id = ?) + (SELECT COUNT(*) FROM requests WHERE department_id = ?) + (SELECT COUNT(*) FROM budgets WHERE department_id = ?) AS n`, [d.id, d.id, d.id]);
    if (used.n === 0) await db.query('DELETE FROM departments WHERE id = ?', [d.id]);
    else await db.query('UPDATE departments SET active = 0 WHERE id = ?', [d.id]);
  }
};
