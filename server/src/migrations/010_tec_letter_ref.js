// Appointment letter reference number for a TEC, quoted in its appointment and reminder e-mails.

async function hasColumn(db, table, column) {
  const [r] = await db.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r.length > 0;
}

module.exports = async function run(db) {
  if (!(await hasColumn(db, 'tec_committees', 'letter_ref'))) await db.query('ALTER TABLE tec_committees ADD COLUMN letter_ref VARCHAR(80) NULL');
};
