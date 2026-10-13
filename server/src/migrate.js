const pool = require('./db');

// Ordered list of migrations. schema.sql is the version-1 baseline; every migration here runs once
// (tracked in schema_migrations) on both fresh and existing databases.
const MIGRATIONS = [
  { id: '002_org_reasons_execution', run: require('./migrations/002_org_reasons_execution') },
  { id: '003_expense_type_recurrence', run: require('./migrations/003_expense_type_recurrence') },
  { id: '004_change_requests', run: require('./migrations/004_change_requests') },
  { id: '005_change_request_authorisation', run: require('./migrations/005_change_request_authorisation') },
  { id: '006_budget_phasing', run: require('./migrations/006_budget_phasing') },
  { id: '007_tec', run: require('./migrations/007_tec') },
  { id: '008_bid_numbers_supplies', run: require('./migrations/008_bid_numbers_supplies') },
  { id: '009_execution_schedule', run: require('./migrations/009_execution_schedule') }
];

async function waitForDb(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (e) { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('Database is not reachable.');
}

async function migrate() {
  await waitForDb();
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const [done] = await pool.query('SELECT id FROM schema_migrations');
  const applied = new Set(done.map(r => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    console.log('Applying migration', m.id);
    await m.run(pool);
    await pool.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
  }
}

module.exports = migrate;
