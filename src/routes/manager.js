/**
 * Manager routes — all require a logged-in user (JWT).
 *
 * The controller resolves the manager's team via the `assignedTo` field
 * on the User docs, so any signed-in employee with subordinates
 * automatically gets data; an employee with no subordinates sees empty
 * arrays everywhere.
 */
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const mgr     = require('../controllers/managerController');

router.get('/me',                   auth, mgr.me);
router.get('/team',                 auth, mgr.team);
router.get('/leaves',               auth, mgr.leaves);
router.patch('/leaves/:id',         auth, mgr.actLeave);
router.get('/allowances',           auth, mgr.allowances);
router.patch('/allowances/:id',     auth, mgr.actAllowance);
router.get('/attendance',           auth, mgr.attendance);
router.get('/attendance-summary',   auth, mgr.attendanceSummary);
router.get('/live-locations',       auth, mgr.liveLocations);
// Attendance regularisation queue — subordinates' filed requests
// surface here for the manager to approve or reject.
router.get  ('/attendance-requests',     auth, mgr.attendanceRequests);
router.patch('/attendance-requests/:id', auth, mgr.actAttendanceRequest);

// Manager-scoped announcements — posts go ONLY to assigned team.
router.post  ('/announcements',     auth, mgr.postAnnouncement);
router.get   ('/announcements',     auth, mgr.myAnnouncements);
router.delete('/announcements/:id', auth, mgr.deleteAnnouncement);

module.exports = router;
