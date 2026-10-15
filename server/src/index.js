require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('./middleware/auth');
const migrate = require('./migrate');

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));
// Brute-force guard: only failed sign-in / registration attempts count, so signing in and out
// (and session checks such as /me) never lock anyone out.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true, message: { error: 'Too many failed sign-in attempts - try again in 15 minutes.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);
app.use('/api/auth', require('./routes/auth'));

// Everything below needs a signed-in user.
app.use('/api', requireAuth);
// Supplies Unit officers work only with the files forwarded to them: the Supplies API and reference data.
app.use('/api', (req, res, next) => {
  if (req.user.role !== 'supplies') return next();
  if (req.path.startsWith('/supplies') || (req.method === 'GET' && /^\/lookups\/?$/.test(req.path))) return next();
  res.status(403).json({ error: 'Supplies Unit users can only access Supplies files.' });
});
app.use('/api/users', require('./routes/users'));
app.use('/api/lookups', require('./routes/lookups'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/plan-items', require('./routes/planItems'));
app.use('/api/execution-requests', require('./routes/executionRequests'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/revisions', require('./routes/revisions'));
app.use('/api/change-requests', require('./routes/changeRequests'));
app.use('/api/tec', require('./routes/tec'));
app.use('/api/supplies', require('./routes/supplies'));
app.use('/api/budgets', require('./routes/budgets'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/dashboard', require('./routes/dashboard'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That value already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const port = process.env.PORT || 4000;
// Reminder e-mails, checked at start-up and every hour: TEC members (before the due date and once it
// lapses), suppliers (Performance Bond / proforma invoice overdue) and bond expiry notices to Supplies.
function scheduleReminders() {
  const { runReminders } = require('./routes/tec');
  const { runJob } = require('./routes/supplies');
  const tick = () => Promise.all([
    runReminders().then(n => { if (n) console.log(`TEC reminders sent: ${n}`); }).catch(e => console.error('TEC reminder job failed:', e.message)),
    runJob().then(n => { if (n) console.log(`Supplies reminders sent: ${n}`); }).catch(e => console.error('Supplies reminder job failed:', e.message))
  ]);
  tick();
  setInterval(tick, 60 * 60 * 1000);
}

migrate()
  .then(() => app.listen(port, () => { console.log(`Procurement Planning API listening on :${port}`); scheduleReminders(); }))
  .catch(e => { console.error('Startup failed:', e); process.exit(1); });
