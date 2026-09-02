/**
 * notifyManager — notify an employee's MANAGER when the employee submits
 * something that needs manager action (leave, permission, allowance,
 * attendance regularisation).
 *
 * Inverse of managerController.resolveTeamIds: an employee's `assignedTo`
 * holds their manager's display name, so we resolve the manager User from
 * it (managers directory first, then a name match) and drop a Notification
 * on their bell. Best-effort — never throws into the request path.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const { notify } = require('./notify');

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveManagerId(employee) {
  const raw = String(employee?.assignedTo || '').trim();
  if (!raw) return null;
  const base = raw.split(/\s*[-–—]\s*/)[0].trim();
  if (!base) return null;
  const rx = new RegExp('^\\s*' + esc(base) + '\\s*$', 'i');

  try {
    const mgrCol = mongoose.connection.db.collection('managers');
    const hit = await mgrCol.findOne({ isActive: true, name: rx });
    if (hit && hit.email) {
      const u = await User.findOne({ email: String(hit.email).toLowerCase() }).select('_id').lean();
      if (u) return u._id;
    }
  } catch { /* directory optional */ }

  try {
    const u = await User.findOne({ name: rx }).select('_id').lean();
    if (u) return u._id;
  } catch { /* ignore */ }

  try {
    const first = base.split(/\s+/)[0];
    const cands = await User.find({ firstName: new RegExp('^' + esc(first) + '$', 'i') })
      .select('_id firstName lastName name')
      .lean();
    for (const c of cands) {
      const full = (c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).trim();
      if (full && full.toLowerCase() === base.toLowerCase()) return c._id;
    }
    if (cands.length === 1) return cands[0]._id;
  } catch { /* ignore */ }

  return null;
}

async function notifyManagerOfRequest(employeeUserId, opts = {}) {
  try {
    const emp = await User.findById(employeeUserId)
      .select('assignedTo firstName lastName name employeeId')
      .lean();
    if (!emp) return null;

    const managerId = await resolveManagerId(emp);
    if (!managerId) return null;
    if (String(managerId) === String(employeeUserId)) return null;

    const empName =
      emp.name || [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim() || 'An employee';
    const empTag = emp.employeeId ? ` (${emp.employeeId})` : '';
    // Distinguish a Permission from a Leave (both stored as type:'leave').
    // Callers pass an explicit `kindLabel` to override the type default.
    const kindLabel =
      opts.kindLabel ? opts.kindLabel
        : opts.type === 'allowance' ? 'allowance claim'
          : opts.type === 'attendance' ? 'attendance request'
            : 'leave request';

    return await notify(managerId, {
      title: `New ${kindLabel} from ${empName}`,
      body: `${empName}${empTag} submitted: ${opts.summary || kindLabel}. Tap to review.`,
      type: opts.type || 'general',
      link: opts.link || '/manager',
    });
  } catch (e) {
    console.warn('[notifyManager] failed:', e.message);
    return null;
  }
}

module.exports = { notifyManagerOfRequest, resolveManagerId };
