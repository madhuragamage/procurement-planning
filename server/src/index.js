require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts - try again later.' } });

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Everything below needs a signed-in user.
app.use('/api', requireAuth);
app.use('/api/users', require('./routes/users'));
app.use('/api/lookups', require('./routes/lookups'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/plan-items', require('./routes/planItems'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/revisions', require('./routes/revisions'));
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
app.listen(port, () => console.log(`Procurement Planning API listening on :${port}`));
