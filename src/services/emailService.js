/**
 * Email service — sends OTPs via Twilio SendGrid (HTTPS API).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SENDGRID
 * ─────────────────────────────────────────────────────────────────────────
 * Render free tier BLOCKS outbound SMTP (ports 25, 465, 587), so we must
 * use an HTTPS-based provider on port 443. SendGrid (owned by Twilio) gives
 * 100 free emails/day on a verified single sender — enough for password
 * resets on a small team — and works out of the box on Render.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SETUP (one-time)
 * ─────────────────────────────────────────────────────────────────────────
 *  1. Create an account at https://signup.sendgrid.com
 *  2. Verify a sender:
 *       Settings → Sender Authentication → Verify a Single Sender
 *       (e.g. tescodigitalproject2026@gmail.com)
 *  3. Create an API key:
 *       Settings → API Keys → Create API Key → Full Access
 *  4. On Render → Environment, set:
 *       SENDGRID_API_KEY    = SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *       SENDGRID_FROM       = tescodigitalproject2026@gmail.com   (verified sender)
 *       SENDGRID_FROM_NAME  = Tesco ERM                           (optional)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BEHAVIOR
 * ─────────────────────────────────────────────────────────────────────────
 *  - If SendGrid env vars are set    → email goes through SendGrid.
 *  - If SendGrid env vars are missing → falls back to console-mock so dev
 *                                       work can continue without keys
 *                                       (OTP printed to server logs).
 */

const fs   = require('fs');
const path = require('path');

let provider = 'none';

// ─── Logo (read once on startup) ─────────────────────────────────────────────
// Logo lives in backend/src/assets/logo.png (copied from frontend/assets/logo.png)
// We embed it as an inline CID attachment so email clients (Gmail, Outlook,
// Apple Mail) render it as a proper image instead of stripping a data URI.
// The CID equals the filename so the same <img src="cid:logo.png"> tag works
// across every provider we might add later.
const LOGO_CID  = 'logo.png';
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');
let   LOGO_BUFFER = null;
let   LOGO_BASE64 = null;
try {
  LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
  LOGO_BASE64 = LOGO_BUFFER.toString('base64');
  console.log(`[emailService] Logo loaded (${LOGO_BUFFER.length} bytes) from ${LOGO_PATH}`);
} catch (err) {
  console.warn(`[emailService] Logo NOT found at ${LOGO_PATH} — email will render without logo. (${err.message})`);
}

// ─── SendGrid (HTTPS — works on Render free tier) ───────────────────────────
function hasSendGrid() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
}

// ─── Resend (HTTPS — alternative to SendGrid) ───────────────────────
// Resend is a developer-friendly transactional email service. Signup at
// resend.com gives you an API key in one click; first 3000 emails/month
// are free. Same HTTPS-on-443 model as SendGrid so it works on Render
// free tier. To switch: set RESEND_API_KEY + RESEND_FROM in .env, no
// code change needed.
function hasResend() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

async function sendViaResend(toEmail, subject, html, text) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromAddr = (process.env.RESEND_FROM || '').trim();
  const fromName = (process.env.RESEND_FROM_NAME || process.env.SENDGRID_FROM_NAME || 'Tesco ERM').trim();
  const from     = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const payload = {
    from,
    to:      [toEmail],
    subject,
    html,
    text,
  };
  if (LOGO_BASE64) {
    payload.attachments = [{
      filename:   'logo.png',
      content:    LOGO_BASE64,
      content_id: LOGO_CID,
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      errMsg = j?.message || j?.error || JSON.stringify(j);
    } catch (_) {}
    throw new Error(`Resend: ${errMsg}`);
  }
  const data = await res.json().catch(() => ({}));
  return { messageId: data?.id || 'queued' };
}

async function sendViaSendGrid(toEmail, subject, html, text) {
  const apiKey    = process.env.SENDGRID_API_KEY;
  const fromEmail = (process.env.SENDGRID_FROM      || '').trim();
  const fromName  = (process.env.SENDGRID_FROM_NAME || 'Tesco ERM').trim();

  const payload = {
    personalizations: [{ to: [{ email: toEmail }] }],
    from:    { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html',  value: html },
    ],
  };

  // Inline logo (CID) — the HTML references <img src="cid:logo.png">.
  if (LOGO_BASE64) {
    payload.attachments = [{
      content:     LOGO_BASE64,
      filename:    'logo.png',
      type:        'image/png',
      disposition: 'inline',
      content_id:  LOGO_CID,
    }];
  }

  // Use global fetch (Node 18+) — no extra dependency needed.
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  // SendGrid returns 202 Accepted with an empty body on success.
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      // SendGrid error format: { errors: [{ message, field, help }] }
      if (j.errors && j.errors.length)
        errMsg = j.errors.map((e) => e.message).join('; ');
      else errMsg = JSON.stringify(j);
    } catch (_) {}
    throw new Error(`SendGrid: ${errMsg}`);
  }

  return { messageId: res.headers.get('x-message-id') || 'queued' };
}

// ─── HTML template ───────────────────────────────────────────────────────────
function buildHtml(otp, fromName) {
  const logoSrc = LOGO_BASE64 ? `cid:${LOGO_CID}` : '';
  const logoImg = logoSrc
    ? `<img src="${logoSrc}" alt="${fromName}" width="180" style="display:block; max-width:180px; height:auto; margin:0 auto;" />`
    : '';

  return `
  <div style="font-family: Arial, Helvetica, sans-serif; max-width:520px; margin:0 auto; padding:32px 24px; background:#f6f9f5; border-radius:12px;">
    <div style="text-align:center; padding-bottom:18px;">
      ${logoImg}
    </div>

    <div style="background:#ffffff; border-radius:10px; padding:28px 24px; box-shadow:0 4px 12px rgba(0,0,0,0.04);">
      <h2 style="margin:0 0 8px; color:#1A1A1A; font-size:20px;">Password Reset OTP</h2>
      <p style="margin:0 0 22px; color:#6b6b6b; font-size:14px; line-height:1.5;">
        Use the One-Time Password below to verify your identity and set a new password.
        This code is valid for <b>10 minutes</b>.
      </p>

      <div style="text-align:center; margin:18px 0 22px;">
        <div style="display:inline-block; padding:14px 28px; background:#F4FBF3; border:1.5px dashed #3FAE3B; border-radius:10px;">
          <span style="font-size:30px; font-weight:800; letter-spacing:8px; color:#1F6A1E;">${otp}</span>
        </div>
      </div>

      <p style="margin:0 0 6px; color:#6b6b6b; font-size:12.5px;">
        If you didn't request this, you can safely ignore this email.
      </p>
      <p style="margin:0; color:#9a9a9a; font-size:11.5px;">
        For security, never share this code with anyone — including ${fromName} staff.
      </p>
    </div>

    <p style="text-align:center; margin:18px 0 0; color:#9a9a9a; font-size:11px;">
      © ${new Date().getFullYear()} ${fromName}. Sent automatically — please do not reply.
    </p>
  </div>
  `;
}

// ─── Main send function ───────────────────────────────────────────────────────
async function sendOtpEmail(toEmail, otp) {
  const fromName = (process.env.SENDGRID_FROM_NAME || 'Tesco ERM').trim();
  const html     = buildHtml(otp, fromName);
  const subject  = `Your Tesco ERM password reset code: ${otp}`;
  const text     = `Your Tesco ERM OTP is ${otp}. Valid for 10 minutes. Do not share this code.`;

  // Try Resend first if configured (more reliable + better DX).
  if (hasResend()) {
    try {
      provider = 'resend';
      const data = await sendViaResend(toEmail, subject, html, text);
      console.log(`[emailService] ✓ Resend → ${toEmail} (id: ${data?.messageId})`);
      return { sent: true, info: data, provider: 'resend' };
    } catch (err) {
      console.error('[emailService] Resend FAILED:', err.message);
      // Fall through to SendGrid if available.
      if (!hasSendGrid()) {
        return { sent: false, error: err.message, provider: 'resend' };
      }
    }
  }

  if (hasSendGrid()) {
    try {
      provider = 'sendgrid';
      const data = await sendViaSendGrid(toEmail, subject, html, text);
      console.log(`[emailService] ✓ SendGrid → ${toEmail} (messageId: ${data?.messageId})`);
      return { sent: true, info: data, provider: 'sendgrid' };
    } catch (err) {
      console.error('[emailService] SendGrid FAILED:', err.message);
      return { sent: false, error: err.message, provider: 'sendgrid' };
    }
  }

  // No provider configured — log the OTP so dev can still test the flow.
  console.error(
    `[emailService] No email provider configured — OTP for ${toEmail} = ${otp}` +
    '\n  Set EITHER:'  +
    '\n    • SENDGRID_API_KEY + SENDGRID_FROM   (signup.sendgrid.com)'  +
    '\n    • RESEND_API_KEY + RESEND_FROM       (resend.com — easier)'
  );
  return {
    sent:  false,
    error: 'No email provider configured. Set SENDGRID_API_KEY + SENDGRID_FROM or RESEND_API_KEY + RESEND_FROM.',
    provider: 'none',
  };
}

// ─── Status endpoint ─────────────────────────────────────────────────────────
function getStatus() {
  return {
    activeProvider: provider,
    resend: {
      configured: hasResend(),
      hasApiKey:  !!process.env.RESEND_API_KEY,
      hasFrom:    !!process.env.RESEND_FROM,
      from:       process.env.RESEND_FROM || null,
      fromName:   process.env.RESEND_FROM_NAME || null,
    },
    sendgrid: {
      configured: hasSendGrid(),
      hasApiKey:  !!process.env.SENDGRID_API_KEY,
      hasFrom:    !!process.env.SENDGRID_FROM,
      from:       process.env.SENDGRID_FROM || null,
      fromName:   process.env.SENDGRID_FROM_NAME || null,
    },
  };
}

module.exports = { sendOtpEmail, getStatus, hasSendGrid, hasResend };
