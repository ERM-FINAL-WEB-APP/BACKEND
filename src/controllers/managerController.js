/**
 * Manager Controller — team-scoped reads for the ERM Web "Manager
 * Access" page.
 *
 * The HRMS Employee form has an `assignedTo` field that's a free-text
 * manager name (e.g. "Vivek", "Vishnu K"). Every endpoint here:
 *   1. Resolves the logged-in user (via JWT — handled by authMiddleware).
 *   2. Builds the list of subordinate user _ids whose `assignedTo`
 *      matches the manager's display name (case-insensitive,
 *      whitespace-tolerant).
 *   3. Filters the requested resource (leaves / allowances / attendance
 *      / locations / complaints) to those subordinates only.
 *
 * No subordinates → returns empty arrays, never errors.
 */

const mongoose       = require('mongoose');
const User           = require('../models/User');
const Leave          = require('../models/Leave');
const Allowance      = require('../models/Allowance');
const Attendance     = require('../models/Attendance');
const LocationPing   = require('../models/LocationPing');
const Complaint      = require('../models/Complaint');

/**
 * Resolve the logged-in manager's display name. Tries firstName + lastName
 * first (HRMS canonical), falls back to `name` (mobile legacy), and as a
 * last resort the bare firstName. Used to match `assignedTo` strings on
 * subordinate records.
 */
function managerDisplayNames(user) {
  if (!user) return [];
  const names = new Set();
  const first = (user.firstName || '').trim();
  const last  = (user.lastName  || '').trim();
  const full  = [first, last].filter(Boolean).join(' ').trim();
  if (full)            names.add(full);
  if (first)           names.add(first);
  if (user.name)       names.add(String(user.name).trim());
  if (user.employeeId) names.add(String(user.employeeId).trim());
  if (user.userId)     names.add(String(user.userId).trim());
  return [...names].filter(Boolean);
}

/**
 * Build a Mongo filter that matches `assignedTo` against ANY of the
 * manager's possible display names — case-insensitive, ignoring leading/
 * trailing whitespace. Lets `assignedTo: "Vivek - Technical Lead"`
 * still match a manager whose name is "Vivek".
 */
function assignedToFilter(names) {
  if (!names || names.length === 0) return { _id: null };  // matches nothing
  const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the manager's name as:
  //   • exact (whitespace-tolerant)
  //   • name followed by " - title"
  //   • name followed by " \u2014 title" (em dash — what the dropdown
  //     displays). Legacy rows from before the value-only fix may have
  //     the rendered text stored.
  //   • name followed by " \u2013 title" (en dash, defensive)
  const orClauses = names.flatMap((n) => {
    const safe = escape(n.trim());
    return [
      { assignedTo: new RegExp(`^\\s*${safe}\\s*$`, 'i') },
      { assignedTo: new RegExp(`^\\s*${safe}\\s*[-–—]`, 'i') },
    ];
  });
  return { $or: orClauses };
}

/** Resolve the list of subordinate ObjectIds for the logged-in manager. */
async function resolveTeamIds(req) {
  const me = await User.findById(req.user.id).lean();
  if (!me) return { manager: null, team: [], names: [] };
  const names = managerDisplayNames(me);

  // ADDITIONAL: pull this user's canonical name from the shared
  // `managers` directory. HR adds entries there using whatever name
  // they want shown in the Assigned-To dropdown — that's the value
  // that ends up in employees' assignedTo field. If it diverges from
  // the User row's firstName + lastName concat (different spacing,
  // initials, etc.) the team query would miss every subordinate.
  // We match the directory entry by EITHER email OR existing names
  // so we catch both Convert-to-Manager and Add-Manager flows.
  try {
    const mgrCol = require('mongoose').connection.db.collection('managers');
    const orClauses = [];
    if (me.email) orClauses.push({ email: String(me.email).toLowerCase() });
    for (const n of names) {
      orClauses.push({ name: new RegExp(`^\\s*${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') });
    }
    if (orClauses.length > 0) {
      const hits = await mgrCol.find({ isActive: true, $or: orClauses }).toArray();
      for (const h of hits) {
        if (h && h.name) names.push(String(h.name).trim());
      }
    }
  } catch (e) {
    // Non-fatal — fall back to User-row names. We still log so ops
    // can see if the lookup is silently failing in prod.
    console.warn('[manager.resolveTeamIds] directory lookup failed:', e.message);
  }

  // De-dupe & drop empties.
  const uniqNames = [...new Set(names.filter((s) => s && String(s).trim()))];
  const team = await User
    .find(assignedToFilter(uniqNames))
    .select('_id firstName lastName name email phone employeeId designation department designationTitle departmentName photoUrl presence lastLocation lastSeenAt')
    .lean();
  return { manager: me, team, names: uniqNames };
}

/**
 * GET /api/manager/team
 * Returns the list of subordinates assigned to the logged-in manager.
 */
exports.team = async (req, res) => {
  try {
    const { manager, team, names } = await resolveTeamIds(req);
    const tag = manager
      ? (manager.email || manager.employeeId || String(manager._id))
      : 'unknown';
    console.log(
      `[manager.team] ${tag} role=${manager?.role || 'n/a'} ` +
      `names=[${names.join(' | ')}] team=${team.length}`
    );
    res.json({
      success: true,
      manager: manager ? {
        _id:        manager._id,
        name:       [manager.firstName, manager.lastName].filter(Boolean).join(' ').trim() || manager.name,
        employeeId: manager.employeeId,
        email:      manager.email,
      } : null,
      managerDisplayNames: names,
      count: team.length,
      team:  team.map((u) => ({
        _id:        u._id,
        employeeId: u.employeeId,
        name:       u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        email:      u.email,
        phone:      u.phone || '',
        photoUrl:   u.photoUrl || '',
        designation: pickLabel(u.designation, u.designationTitle),
        department:  pickLabel(u.department,  u.departmentName),
        presence:    u.presence    || 'offline',
        lastLocation:u.lastLocation || null,
        lastSeenAt:  u.lastSeenAt   || null,
      })),
    });
  } catch (err) {
    console.error('[manager.team]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/leaves?status=pending|approved|rejected&month=&year=
 * Leave + permission requests filed by the logged-in manager's team.
 */
exports.leaves = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const q = { user: { $in: ids } };
    if (req.query.status) q.status = String(req.query.status).toLowerCase();

    const items = await Leave
      .find(q)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.leaves]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/allowances?type=travel|petrol&status=
 */
exports.allowances = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const q = { user: { $in: ids } };
    if (req.query.type)   q.type   = String(req.query.type).toLowerCase();
    if (req.query.status) q.status = String(req.query.status).toLowerCase();

    const items = await Allowance
      .find(q)
      .populate('user', 'firstName lastName name employeeId email designation department designationTitle departmentName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.allowances]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/leaves/:id   { managerStatus: 'Approved' | 'Rejected' }
 * Manager acts on a subordinate's request. Stored as managerStatus on
 * the Leave row so the HRMS "Status" column knows whether to enable
 * HR's Approve/Reject buttons.
 */
exports.actLeave = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await Leave.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'This request does not belong to your team.' });
    }
    const status = String(req.body.managerStatus || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'managerStatus must be Approved or Rejected' });
    }
    const me = await User.findById(req.user.id).lean();
    const myName =
      (me && (me.name || [me.firstName, me.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';
    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName;
    doc.managerStatusAt = new Date();
    // When the manager REJECTS, mark the request as final on the HR
    // side too — HR doesn't need to review a request the manager has
    // already declined, and leaving status='pending' caused the ERM
    // apps to render a stale "Pending" badge forever (the employee
    // never saw a visible change). Setting status='rejected' here
    // also feeds the leave-history list, which already styles
    // rejected rows in red.
    if (status === 'rejected') {
      doc.status     = 'rejected';
      doc.reviewedAt = new Date();
      doc.reviewedBy = doc.reviewedBy || `Manager (${myName})`;
      doc.hrComment  = doc.hrComment  || `Manager rejection (${myName}).`;
    }
    await doc.save();

    // Fire a notification to the employee for BOTH approval and
    // rejection. The previous body read "Awaiting HR review." in
    // both branches, which gave the employee no signal that a
    // rejection had happened — they couldn't tell the two emails
    // apart at a glance. Now the title + body explicitly call out
    // approve vs reject.
    try {
      const { notify } = require('../utils/notify');
      const kind = doc.requestType === 'permission' ? 'Permission' : 'Leave';
      const when = kind === 'Permission'
        ? `${doc.date}${doc.startTime && doc.endTime ? ` (${doc.startTime} - ${doc.endTime})` : ''}`
        : `${doc.startDate}${doc.endDate && doc.endDate !== doc.startDate ? ` - ${doc.endDate}` : ''}`;
      const isApproved = doc.managerStatus === 'Approved';
      const title = isApproved
        ? `${kind} approved by your manager`
        : `${kind} rejected by your manager`;
      const body  = isApproved
        ? `Your ${kind.toLowerCase()} request for ${when} is approved. Awaiting HR review.`
        : `Your ${kind.toLowerCase()} request for ${when} was rejected by ${myName}.`;
      // Coerce doc.user to ObjectId-safe form. If `doc.user` was
      // populated upstream, .  / ObjectId-style strings need to be
      // unwrapped before notify() so the Notification.create call
      // doesn't trip mongoose's cast check (we observed a silent
      // failure when notify received a populated user object on
      // rejection, which is the only branch where status flips
      // managerStatus AND status simultaneously).
      const userIdForNotif = doc.user?._id || doc.user;
      console.log(`[manager.actLeave] firing notify status=${status} user=${userIdForNotif}`);
      const out = await notify(userIdForNotif, {
        title,
        body,
        type: 'leave',
        link: '/(tabs)/leave',
      });
      if (!out) {
        console.warn('[manager.actLeave] notify returned null for user', String(userIdForNotif));
      } else {
        console.log(`[manager.actLeave] ✓ notif saved id=${out._id} for user=${userIdForNotif}`);
      }
    } catch (e) {
      console.warn('[manager.actLeave] notify failed:', e.message);
    }

    // ── Dual-write to the mobile backend ──────────────────────────────
    // Earlier deployments split ERM Web Backend + ERM Mobile Backend
    // onto different MongoDB databases, and the rejection notif never
    // reached the employee because the Notification doc landed in the
    // wrong DB. We now ALSO forward the decision to the mobile backend
    // (which writes to its own canonical Notification collection AND
    // updates the same Leave doc by ObjectId). Safe to call even when
    // both backends share a DB — the second write is idempotent (same
    // ObjectId, same status). Gated by MOBILE_API_URL + MOBILE_ADMIN_SECRET
    // env vars so local dev doesn't need a second service running.
    try {
      const MOBILE_API   = (process.env.MOBILE_API_URL   || '').trim().replace(/\/+$/, '');
      const ADMIN_SECRET = (process.env.MOBILE_ADMIN_SECRET || '').trim();
      if (MOBILE_API && ADMIN_SECRET) {
        const payload = {
          status:       doc.status,           // 'rejected' on rejection, unchanged on approve
          managerStatus: status,               // 'approved' | 'rejected'
          reviewedBy:    `Manager (${myName})`,
          hrComment:     doc.hrComment || '',
        };
        const url = `${MOBILE_API}/api/leave/admin/${encodeURIComponent(doc._id)}`;
        const r = await fetch(url, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
          body:    JSON.stringify(payload),
        });
        if (!r.ok) {
          console.warn('[manager.actLeave] mobile dual-write HTTP', r.status);
        } else {
          console.log('[manager.actLeave] ✓ mobile dual-write OK');
        }
      } else {
        console.log('[manager.actLeave] MOBILE_API_URL / MOBILE_ADMIN_SECRET not set; skipping mobile dual-write');
      }
    } catch (e) {
      console.warn('[manager.actLeave] mobile dual-write failed:', e.message);
    }

    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actLeave]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/allowances/:id
 * Body: { managerStatus: 'Approved'|'Rejected',
 *         approvedAmount?, rejectedAmount?, amountComment? }
 *
 * Manager can now split a claim into an approved portion + rejected
 * portion (same shape HR uses on HRMS). The breakdown is stored on the
 * Allowance doc so HR sees it on the HRMS Allowance page and the
 * employee sees it on the ERM apps.
 */
exports.actAllowance = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await Allowance.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'This request does not belong to your team.' });
    }
    const status = String(req.body.managerStatus || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'managerStatus must be Approved or Rejected' });
    }

    // Validate amounts when supplied. Approved cannot exceed the claim;
    // rejected fills the gap. Missing amounts default to a full approve
    // (= entire claim) or full reject (rejectedAmount = entire claim).
    const claimed = Number(doc.amount) || 0;
    let approvedAmount = req.body.approvedAmount;
    let rejectedAmount = req.body.rejectedAmount;
    if (approvedAmount !== undefined) approvedAmount = Number(approvedAmount);
    if (rejectedAmount !== undefined) rejectedAmount = Number(rejectedAmount);
    if (status === 'approved') {
      // If amounts weren't sent, treat it as a full approve.
      if (!isFinite(approvedAmount)) approvedAmount = claimed;
      if (approvedAmount < 0 || approvedAmount > claimed) {
        return res.status(400).json({ success: false, message: `approvedAmount must be between 0 and ${claimed}` });
      }
      rejectedAmount = Math.max(0, claimed - approvedAmount);
    } else {
      // Full reject — everything goes to rejected.
      approvedAmount = 0;
      rejectedAmount = claimed;
    }

    const me2 = await User.findById(req.user.id).lean();
    const myName2 =
      (me2 && (me2.name || [me2.firstName, me2.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';
    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName2;
    doc.managerStatusAt = new Date();
    doc.approvedAmount  = approvedAmount;
    doc.rejectedAmount  = rejectedAmount;
    if (typeof req.body.amountComment === 'string') {
      doc.amountComment = req.body.amountComment;
    }
    await doc.save();

    try {
      const { notify } = require('../utils/notify');
      // Compose a rich notification body the employee can see at a glance.
      // Includes: claim ₹, approved ₹, rejected ₹ (when partial), and the
      // manager's reason comment when supplied — that way the employee
      // knows exactly what was approved and why anything was rejected.
      const claimedAmt = Number(doc.amount) || 0;
      const approvedRs = Math.max(0, Number(approvedAmount) || 0);
      const rejectedRs = Math.max(0, Number(rejectedAmount) || 0);
      const fmt = (n) => '\u20b9' + Number(n).toLocaleString('en-IN');
      let bodyLine;
      if (status === 'approved' && rejectedRs > 0) {
        bodyLine = `Approved ${fmt(approvedRs)} of your ${fmt(claimedAmt)} claim ` +
                   `(${fmt(rejectedRs)} not approved). Awaiting HR review.`;
      } else if (status === 'approved') {
        bodyLine = `Approved ${fmt(approvedRs)} for your claim. Awaiting HR review.`;
      } else {
        bodyLine = `Your ${fmt(claimedAmt)} claim was rejected by your manager.`;
      }
      // Append the manager's comment as the "reason" line when present.
      const reason = String(req.body.amountComment || '').trim();
      if (reason) bodyLine += ` Reason: ${reason}`;
      await notify(doc.user, {
        title: `Allowance ${doc.managerStatus.toLowerCase()} by your manager`,
        body:  bodyLine,
        type:  'allowance',
      });
    } catch (e) {
      console.warn('[manager.actAllowance] notify failed:', e.message);
    }

    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actAllowance]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/attendance?date=YYYY-MM-DD
 * Team attendance roll for a single date — used by the Reports tab.
 */
exports.attendance = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    const ids = team.map((u) => u._id);
    if (ids.length === 0) return res.json({ success: true, items: [] });

    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const items = await Attendance
      .find({ user: { $in: ids }, date })
      .populate('user', 'firstName lastName name employeeId email designation designationTitle')
      .lean();
    res.json({ success: true, date, items });
  } catch (err) {
    console.error('[manager.attendance]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/attendance-summary?month=&year=
 * Per-team-member summary (present / late / absent / permission)
 * for the requested month — drives the Reports tab.
 */
exports.attendanceSummary = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    if (team.length === 0) return res.json({ success: true, items: [] });

    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const year  = parseInt(req.query.year,  10) || new Date().getFullYear();
    const monthStr = String(month).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end   = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;

    // #470 — Use the canonical monthly summary (same counts HR + the
    // employee card + HRMS show). The old raw-status aggregation diverged
    // on permission days, HR-overridden days, Sundays, and future months.
    const { computeMonthlySummary } = require('./attendanceController');

    const hourRows = await Attendance.find({
      user: { $in: team.map((u) => u._id) },
      date: { $gte: start, $lte: end },
    }).select('user workedHours').lean();
    const hoursByUser = new Map();
    for (const r of hourRows) {
      const k = String(r.user);
      hoursByUser.set(k, (hoursByUser.get(k) || 0) + Number(r.workedHours || 0));
    }

    const items = await Promise.all(team.map(async (u) => {
      let s = { present: 0, late: 0, absent: 0, permission: 0, halfday: 0, leave: 0 };
      try { s = await computeMonthlySummary(u._id, month, year); }
      catch (e) { console.warn('[manager.attendanceSummary] failed for', String(u._id), e.message); }
      return {
        userId:      String(u._id),
        employeeId:  u.employeeId,
        name:        u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        designation: pickLabel(u.designation, u.designationTitle),
        present:     s.present    || 0,
        late:        s.late       || 0,
        absent:      s.absent     || 0,
        permission:  s.permission || 0,
        halfday:     s.halfday    || 0,
        leave:       s.leave      || 0,
        totalWorkedHours: hoursByUser.get(String(u._id)) || 0,
      };
    }));

    res.json({ success: true, month, year, items });
  } catch (err) {
    console.error('[manager.attendanceSummary]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/live-locations
 * Latest GPS sample for each team member, today only. Drives the
 * Live Tracking tab on the manager dashboard.
 */
exports.liveLocations = async (req, res) => {
  try {
    const { team } = await resolveTeamIds(req);
    if (team.length === 0) return res.json({ success: true, data: [] });

    const today = new Date().toISOString().slice(0, 10);
    const attendanceMap = new Map();
    const atts = await Attendance.find({
      user: { $in: team.map((u) => u._id) },
      date: today,
    }).select('user checkIn checkOut workedHours').lean();
    for (const a of atts) attendanceMap.set(String(a.user), a);

    const out = await Promise.all(team.map(async (u) => {
      const ping = await LocationPing.findOne({ user: u._id, date: today })
        .sort({ recordedAt: -1 })
        .lean()
        .catch(() => null);

      let lat = null, lng = null, recordedAt = null, speed = null;
      if (ping) {
        lat = ping.lat; lng = ping.lng; recordedAt = ping.recordedAt; speed = ping.speed;
      } else if (u.lastLocation && u.lastLocation.lat != null) {
        lat = u.lastLocation.lat; lng = u.lastLocation.lng; recordedAt = u.lastSeenAt;
      }

      const att = attendanceMap.get(String(u._id));
      const isCheckedIn = !!(att && att.checkIn && !att.checkOut);

      let status = 'offline';
      if (lat != null && recordedAt) {
        const ageMin = (Date.now() - new Date(recordedAt).getTime()) / 60000;
        if (ageMin <= 25 && isCheckedIn) status = 'active';
        else if (u.presence === 'idle')  status = 'idle';
      } else if (isCheckedIn) {
        status = 'active';
      }

      return {
        _id:        String(u._id),
        employeeId: u.employeeId,
        name:       u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        designation: pickLabel(u.designation, u.designationTitle),
        photoUrl:   u.photoUrl || '',
        lat, lng, speed,
        status,
        checkIn:    att?.checkIn  || null,
        checkOut:   att?.checkOut || null,
        lastSeen:   recordedAt,
      };
    }));

    res.json({ success: true, data: out, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[manager.liveLocations]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/me
 *
 * Single source of truth for "am I a manager?". Returns isManager: true
 * if ANY of the following holds:
 *   1. The logged-in user's role field is 'manager' (set when HR flipped
 *      Convert-to-Manager in HRMS Employee List).
 *   2. The logged-in user's email matches an active row in the shared
 *      Manager directory (HRMS Manager page or auto-upserted by the
 *      Convert toggle).
 *   3. The logged-in user has at least one subordinate (someone whose
 *      assignedTo matches their name).
 *
 * Used by the ERM Web Sidebar to decide whether to show the
 * "Manager Access" link. Centralising this here means we don't have to
 * keep three frontend checks in sync.
 */
exports.me = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(404).json({ success: false, message: 'User not found' });

    const signals = { byRole: false, byDirectory: false, byTeam: false };
    let directoryName = '';

    // Signal 1 — explicit role on the user row
    signals.byRole = String(me.role || '').toLowerCase() === 'manager';

    // Signal 2 — email present in the active managers directory
    try {
      const mongoose = require('mongoose');
      const mgrCol = mongoose.connection.db.collection('managers');
      if (me.email) {
        const hit = await mgrCol.findOne({ email: String(me.email).toLowerCase(), isActive: true });
        if (hit) { signals.byDirectory = true; directoryName = hit.name || ''; }
      }
      if (!signals.byDirectory) {
        // Also try by name (full or partial — same logic as resolveTeamIds).
        const fullName = [me.firstName || '', me.lastName || ''].filter(Boolean).join(' ').trim();
        if (fullName) {
          const hit = await mgrCol.findOne({
            name: new RegExp(`^\\s*${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'),
            isActive: true,
          });
          if (hit) { signals.byDirectory = true; directoryName = hit.name || ''; }
        }
      }
    } catch (e) {
      console.warn('[manager.me] directory check failed:', e.message);
    }

    // Signal 3 — has subordinates
    let teamSize = 0;
    try {
      const { team } = await resolveTeamIds(req);
      teamSize = team.length;
      signals.byTeam = teamSize > 0;
    } catch (e) {
      console.warn('[manager.me] team resolution failed:', e.message);
    }

    const isManager = signals.byRole || signals.byDirectory || signals.byTeam;
    const tag = me.email || me.employeeId || String(me._id);
    console.log(`[manager.me] ${tag} isManager=${isManager} byRole=${signals.byRole} byDirectory=${signals.byDirectory} byTeam=${signals.byTeam} teamSize=${teamSize}`);
    res.json({ success: true, isManager, signals, teamSize, directoryName });
  } catch (err) {
    console.error('[manager.me]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── helpers ────────────────────────────────────────────────────────
function pickLabel(value, sidecar) {
  const isHex = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
  if (value && typeof value === 'object') {
    const t = value.title || value.name || '';
    if (t && !isHex(t)) return t;
  }
  if (typeof value === 'string' && value && !isHex(value)) return value;
  if (sidecar && typeof sidecar === 'string' && !isHex(sidecar)) return sidecar;
  return '';
}


/* ─── Manager announcements ────────────────────────────────────────── */

const Announcement = require('../models/Announcement');

/**
 * POST /api/manager/announcements
 * Body: { title, body, category? }
 *
 * Posts an announcement that ONLY the manager's direct team will see.
 * The audience is snapshotted at post-time — re-assignments after the
 * fact don't change who sees this specific announcement.
 */
exports.postAnnouncement = async (req, res) => {
  try {
    const { manager, team } = await resolveTeamIds(req);
    if (!manager) return res.status(401).json({ success: false, message: 'Manager not found.' });
    if (team.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You don\'t have any subordinates. Only managers can post team announcements.',
      });
    }
    const title = String(req.body?.title || '').trim();
    const body  = String(req.body?.body  || '').trim();
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Title and body are required.' });
    }
    const category = ['holiday','policy','event','general'].includes(req.body?.category)
      ? req.body.category
      : 'general';

    const postedByName =
      manager.name ||
      [manager.firstName, manager.lastName].filter(Boolean).join(' ').trim() ||
      'Manager';

    const doc = await Announcement.create({
      title,
      body,
      category,
      audience:        'manager-team',
      postedBy:        postedByName,
      postedByUser:    manager._id,
      audienceUserIds: team.map((u) => u._id),
      isActive:        true,
    });

    // Fire a notification to each team member so the bell badge ticks.
    try {
      const { notify } = require('../utils/notify');
      await Promise.all(team.map((u) =>
        notify(u._id, {
          title: `New announcement from ${postedByName}`,
          body:  title,
          type:  'announcement',
        })
      ));
    } catch (e) {
      console.warn('[manager.postAnnouncement] notify failed:', e.message);
    }

    res.status(201).json({ success: true, announcement: doc, teamSize: team.length });
  } catch (err) {
    console.error('[manager.postAnnouncement]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/manager/announcements
 * Announcements this manager has posted to their team. Useful for the
 * manager to review / audit what they've sent.
 */
exports.myAnnouncements = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.json({ success: true, items: [] });
    const items = await Announcement.find({
      postedByUser: me._id,
      // Match BOTH team-scoped audience values: 'manager-team' (posted from
      // ERM web) and 'team' (posted from ERM mobile) — so a manager sees
      // their own team announcements regardless of which app posted them.
      audience:     { $in: ['team', 'manager-team'] },
      isActive:     true,
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.myAnnouncements]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/manager/announcements/:id
 * Soft-delete one of the manager's own team announcements.
 */
exports.deleteAnnouncement = async (req, res) => {
  try {
    const me = await User.findById(req.user.id).lean();
    if (!me) return res.status(401).json({ success: false, message: 'Unauthorised.' });
    const doc = await Announcement.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    if (String(doc.postedByUser) !== String(me._id)) {
      return res.status(403).json({ success: false, message: 'You can only delete your own announcements.' });
    }
    doc.isActive = false;
    await doc.save();
    res.json({ success: true });
  } catch (err) {
    console.error('[manager.deleteAnnouncement]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};


/**
 * GET /api/manager/attendance-requests?status=pending|approved|rejected
 * Lists every regularisation request filed by the manager's team. The
 * mobile backend owns the `attendancerequests` collection; ERM Web
 * reads the same MongoDB so we just project + scope to the team here.
 */
exports.attendanceRequests = async (req, res) => {
  try {
    const AttendanceRequest = require('../models/AttendanceRequest');
    const { team } = await resolveTeamIds(req);
    const teamIds  = team.map((u) => u._id);
    const filter = { user: { $in: teamIds } };
    const status = String(req.query.status || '').toLowerCase();
    if (['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      filter.status = status;
    }
    const items = await AttendanceRequest.find(filter)
      .populate('user', 'firstName lastName name employeeId email designation designationTitle department departmentName')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, items });
  } catch (err) {
    console.error('[manager.attendanceRequests]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/manager/attendance-requests/:id  { status, hrComment? }
 * Manager approves or rejects a subordinate's attendance request.
 * Same status field + notification flow as HR's admin path.
 */
exports.actAttendanceRequest = async (req, res) => {
  try {
    const AttendanceRequest = require('../models/AttendanceRequest');
    const { team } = await resolveTeamIds(req);
    const ids = new Set(team.map((u) => String(u._id)));
    const doc = await AttendanceRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
    if (!ids.has(String(doc.user))) {
      return res.status(403).json({ success: false, message: 'Request does not belong to your team.' });
    }
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be approved or rejected' });
    }
    const me = await User.findById(req.user.id).lean();
    const myName =
      (me && (me.name || [me.firstName, me.lastName].filter(Boolean).join(' ').trim())) ||
      'Manager';

    // Updated Jun 2026 — manager writes to managerStatus first, then
    // chooses whether the request moves on to HR:
    //   * Manager Approved -> managerStatus = 'Approved', status stays
    //     'pending' so HR sees it in HRMS Attendance Requests and makes
    //     the final call. HR's status column is empty until they act.
    //   * Manager Rejected -> managerStatus = 'Rejected', status moves
    //     to 'rejected' immediately so the request is closed. HR doesn't
    //     need to act (the rejection IS the final decision).
    doc.managerStatus   = status === 'approved' ? 'Approved' : 'Rejected';
    doc.managerStatusBy = myName;
    doc.managerStatusAt = new Date();
    if (typeof req.body.managerComment === 'string' && req.body.managerComment) {
      doc.managerComment = req.body.managerComment;
    } else if (typeof req.body.hrComment === 'string' && req.body.hrComment) {
      // Backwards-compat: the older modal sent the comment under
      // hrComment. Treat it as the manager note here.
      doc.managerComment = req.body.hrComment;
    }
    if (status === 'rejected') {
      doc.status     = 'rejected';
      doc.reviewedBy = `Manager (${myName})`;
      doc.reviewedAt = new Date();
    } else {
      doc.status = 'pending';
    }
    await doc.save();

    try {
      const { notify } = require('../utils/notify');
      const userIdForNotif = doc.user?._id || doc.user;
      const noteSuffix = doc.managerComment ? ` Note: \"${doc.managerComment}\"` : '';
      const bodyLine = status === 'approved'
        ? `Your regularisation for ${doc.date} was approved by ${myName}. Awaiting HR review.${noteSuffix}`
        : `Your regularisation for ${doc.date} was rejected by ${myName}.${noteSuffix}`;
      await notify(userIdForNotif, {
        title: `Attendance request ${status} by your manager`,
        body:  bodyLine,
        type:  'attendance',
        link:  '/(tabs)/attendance',
      });
    } catch (e) {
      console.warn('[manager.actAttendanceRequest] notify failed:', e.message);
    }
    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actAttendanceRequest]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
