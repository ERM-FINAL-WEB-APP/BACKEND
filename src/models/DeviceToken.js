const mongoose = require('mongoose');

/**
 * DeviceToken — one row per FCM registration token (browser OR phone).
 *
 * MIRROR of the ERM Mobile backend's DeviceToken model, pointing at the SAME
 * `devicetokens` collection in the shared MongoDB. So a browser token that the
 * ERM Web app registers here is found by the mobile backend's firebase-admin
 * sender (utils/fcm.js) exactly like a phone token — one user can own many
 * device rows (several browsers + their phone).
 *
 * `token` is globally unique: re-registering the same token just refreshes it,
 * and a shared device is reassigned to whoever is currently logged in.
 */
const deviceTokenSchema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role:     { type: String, default: 'employee' },
    token:    { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: 'web' },
    deviceId: { type: String, default: '' },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
