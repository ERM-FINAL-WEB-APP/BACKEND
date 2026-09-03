/**
 * Tiny wrapper around the Notification model.
 *
 *   await notify(user._id, {
 *     title: 'Leave Approved',
 *     body:  'Your leave for 12-15 Mar was approved.',
 *     type:  'leave',
 *     link:  '/(tabs)/leave',
 *   });
 *
 * Notifications fail silently — they're a UX nicety and should never
 * abort the parent request (e.g. status-update API) if the DB write fails.
 */

const Notification = require('../models/Notification');

const VALID_TYPES = ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'];

async function notify(userId, opts = {}) {
  if (!userId || !opts || !opts.title) return null;
  try {
    const payload = {
      user:  userId,
      title: String(opts.title).slice(0, 200),
      body:  String(opts.body || '').slice(0, 800),
      type:  VALID_TYPES.includes(opts.type) ? opts.type : 'general',
      link:  opts.link || '',
    };
    const doc = await Notification.create(payload);
    console.log(
      `[notify] ✓ → user=${userId} type=${payload.type} title="${payload.title}"`
    );

    // #545 — Real system/OS push. This backend has NO Firebase service account,
    // so we delegate the FCM fan-out to the ERM Mobile backend (which does),
    // server-to-server. It pushes to EVERY device the user has registered —
    // their phone AND any browser running the ERM Web app — so a web-originated
    // event (e.g. a manager approval) arrives as a real notification, not just
    // the in-app bell. Fire-and-forget: never blocks or fails the notify().
    pushViaMobile(userId, payload, doc && doc._id).catch(() => {});

    return doc;
  } catch (err) {
    console.error('[notify] FAILED:', err.message);
    return null;
  }
}

// Best-effort call to the mobile backend's admin FCM endpoint.
async function pushViaMobile(userId, payload, notificationId) {
  const MOBILE_API   = (process.env.MOBILE_API_URL     || '').trim().replace(/\/+$/, '');
  const ADMIN_SECRET = (process.env.MOBILE_ADMIN_SECRET || '').trim();
  if (!MOBILE_API || !ADMIN_SECRET) {
    // Not configured — the in-app bell still works; system push is disabled.
    return;
  }
  if (typeof fetch !== 'function') return; // Node < 18
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`${MOBILE_API}/api/notification/admin/push`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
        body: JSON.stringify({
          userId: String(userId),
          title:  payload.title,
          body:   payload.body,
          link:   payload.link,
          type:   payload.type,
          notificationId: notificationId ? String(notificationId) : '',
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) console.warn('[notify] mobile push responded', r.status);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[notify] mobile push failed:', e.message);
  }
}

module.exports = { notify };
