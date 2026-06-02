require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const { startKeepAlive } = require('./keepAlive');

const app = express();

// ─── CORS — manual middleware (same as HRMS) ────────────────────────
// Three frontends consume this backend:
//   • ERM mobile app (no Origin header → always allowed)
//   • ERM web app    (origin set via CORS_ORIGINS env var)
//   • HRMS admin     (server-to-server, uses x-admin-secret instead)
//
// Manual instead of cors() package so we never run into Render-edge
// quirks where the preflight slips past the package middleware. Sets
// headers first thing on every request, short-circuits OPTIONS with
// 204 before anything else can touch the response.
//
// Set CORS_ORIGINS on Render with the deployed web-app URL, e.g.:
//   CORS_ORIGINS=https://erm-web.vercel.app,https://erm.tescocompany.in
// Leave it unset locally so npm run dev allows everything.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin.replace(/\/+$/, ''));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, X-Admin-Email, X-Admin-Secret, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// gzip every JSON response > 1 KB. The daily-route polyline is the
// biggest payload the HRMS asks for (a few KB after simplification)
// and gzips down to roughly 30% of that. Saves ~200-500 ms on the
// HRMS-proxy round-trip, depending on the user's last-mile speed.
app.use(compression({ threshold: 1024 }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/allowance', require('./routes/allowance'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/payslip', require('./routes/payslip'));
app.use('/api/announcement', require('./routes/announcement'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/complaint',    require('./routes/complaint'));
// Admin one-off maintenance (backfill emp id, etc.) — gated by x-admin-secret.
app.use('/api/admin',        require('./routes/adminBackfill'));
app.use('/api/manager',      require('./routes/manager'));

app.get('/', (req, res) => {
  res.json({
    name: 'Tesco ERM API',
    status: 'running',
    docs: '/api/health',
    endpoints: [
      'POST /api/auth/login',
      'GET  /api/health',
      'GET  /api/profile',
      'POST /api/attendance/checkin',
      'POST /api/attendance/checkout',
      'GET  /api/attendance/today',
      'GET  /api/attendance/monthly',
      'POST /api/leave/apply',
      'POST /api/leave/permission',
      'POST /api/allowance/submit',
      'GET  /api/announcement',
      'POST /api/announcement',
      'GET  /api/notification',
      'PATCH /api/notification/read-all',
    ],
  });
});

app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date(), uptime: process.uptime() })
);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Server error', error: err.message });
});

// ─── Startup email-provider sanity check ─────────────────────────────
// Hit the SendGrid /v3/api_keys/me endpoint at boot so the operator
// sees IMMEDIATELY whether the API key is still valid, instead of
// finding out 30 minutes later when a user tries forgot-password.
async function checkEmailProviders() {
  // Resend — verify by listing API keys (any 200 means the key works)
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/api-keys', {
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
      });
      if (r.ok) console.log('[emailService] ✓ RESEND_API_KEY is valid');
      else console.warn('[emailService] ⚠ RESEND_API_KEY rejected (HTTP ' + r.status + ')');
    } catch (e) {
      console.warn('[emailService] could not verify Resend key:', e.message);
    }
  }
  // SendGrid — same idea, hit a known harmless endpoint
  if (process.env.SENDGRID_API_KEY) {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/user/profile', {
        headers: { 'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY },
      });
      if (r.ok) {
        console.log('[emailService] ✓ SENDGRID_API_KEY is valid');
      } else {
        const txt = await r.text().catch(() => '');
        console.warn('');
        console.warn('==================================================');
        console.warn('  ⚠  SENDGRID_API_KEY IS REVOKED OR EXPIRED');
        console.warn('  HTTP ' + r.status + ': ' + (txt || 'no body'));
        console.warn('  Fix:');
        console.warn('    1. sendgrid.com → Settings → API Keys');
        console.warn('    2. Create new key with Full Access');
        console.warn('    3. Copy key into .env (SENDGRID_API_KEY=SG.…)');
        console.warn('    4. Restart this server');
        console.warn('    5. Also verify the sender at');
        console.warn('       Settings → Sender Authentication');
        console.warn('==================================================');
        console.warn('');
      }
    } catch (e) {
      console.warn('[emailService] could not verify SendGrid key:', e.message);
    }
  }
  if (!process.env.SENDGRID_API_KEY && !process.env.RESEND_API_KEY) {
    console.warn('[emailService] No email provider configured — OTP will fall back to console + dev response.');
  }
}

const PORT = process.env.PORT || 5000;
// Health probe used by keepAlive.js self-pinger.
app.get('/api/_health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Kick off the keep-alive cron once the server is up
  startKeepAlive(PORT);
  // Verify email providers a beat later so the log lines come AFTER
  // the "Server running" banner instead of getting buried above it.
  setTimeout(checkEmailProviders, 500);
});
