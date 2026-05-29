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
  const orClauses = names.flatMap((n) => {
    const safe = escape(n.trim());
    // Match either an exact name OR a name followed by " - <title>" suffix.
    return [
      { assignedTo: new RegExp(`^\\s*${safe}\\s*$`, 'i') },
      { assignedTo: new RegExp(`^\\s*${safe}\\s*-`, 'i') },
    ];
  });
  return { $or: orClauses };
}

/** Resolve the list of subordinate ObjectIds for the logged-in manager. */
async function resolveTeamIds(req) {
  const me = await User.findById(req.user.id).lean();
  if (!me) return { manager: null, team: [], names: [] };
  const names = managerDisplayNames(me);
  const team = await User
    .find(assignedToFilter(names))
    .select('_id firstName lastName name email employeeId designation department designationTitle departmentName photoUrl presence lastLocation lastSeenAt')
    .lean();
  return { manager: me, team, names };
}

/**
 * GET /api/manager/team
 * Returns the list of subordinates assigned to the logged-in manager.
 */
exports.team = async (req, res) => {
  try {
    const { manager, team, names } = await resolveTeamIds(req);
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
    doc.managerStatus = status === 'approved' ? 'Approved' : 'Rejected';
    await doc.save();
    res.json({ success: true, item: doc });
  } catch (err) {
    console.error('[manager.actLeave]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /api/manager/allowances/:id   { managerStatus } */
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
    doc.managerStatus = status === 'approved' ? 'Approved' : 'Rejected';
    await doc.save();
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

    const rows = await Attendance.find({
      user: { $in: team.map((u) => u._id) },
      date: { $gte: start, $lte: end },
    }).lean();

    const summaryByUser = new Map();
    for (const u of team) {
      summaryByUser.set(String(u._id), {
        userId:     String(u._id),
        employeeId: u.employeeId,
        name:       u.name || [u.firstName, u.lastName].filter(Boolean).join(' ').trim(),
        designation: pickLabel(u.designation, u.designationTitle),
        present: 0, late: 0, absent: 0, permission: 0, halfday: 0,
        totalWorkedHours: 0,
      });
    }
    for (const r of rows) {
      const s = summaryByUser.get(String(r.user));
      if (!s) continue;
      const st = String(r.status || '').toLowerCase();
      if      (st === 'present')      s.present    += 1;
      else if (st === 'late')         s.late       += 1;
      else if (st === 'absent')       s.absent     += 1;
      else if (st === 'permission')   s.permission += 1;
      else if (st === 'halfday' || st === 'half-day') s.halfday += 1;
      s.totalWorkedHours += Number(r.workedHours || 0);
    }
    res.json({
      success: true,
      month, year,
      items: [...summaryByUser.values()],
    });
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
      audience:     'manager-team',
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
