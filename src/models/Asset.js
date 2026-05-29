/**
 * Asset model — POINTS TO THE SAME `assets` COLLECTION AS HRMS.
 *
 * HRMS owns asset creation / assignment through its Asset.jsx page.
 * The ERM Web backend only READS from this collection (read-only here),
 * filtered by the signed-in employee's employeeId, so a logged-in
 * employee can see laptops / phones / ID cards assigned to them on
 * their Profile.
 *
 * Schema is `strict: false` so any field HRMS adds is round-tripped.
 */
const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema(
  {
    assetId:      { type: String, index: true },
    assetName:    { type: String, default: '' },
    type:         { type: String, default: '' },
    employeeId:   { type: String, default: '', uppercase: true, trim: true, index: true },
    employeeName: { type: String, default: '' },
    serialNo:     { type: String, default: '' },
    issuedDate:   { type: Date,   default: null },
    returnedDate: { type: Date,   default: null },
    condition:    { type: String, default: '' },
    status:       { type: String, default: 'Assigned' },
    purchaseDate: { type: Date,   default: null },
    purchasePrice:{ type: Number, default: 0 },
  },
  {
    collection: 'assets',     // ← same collection HRMS writes to
    timestamps: true,
    strict: false,
  }
);

module.exports = mongoose.model('Asset', assetSchema);
