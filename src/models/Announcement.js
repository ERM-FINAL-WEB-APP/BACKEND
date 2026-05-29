const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    category: {
      type: String,
      enum: ['holiday', 'policy', 'event', 'general'],
      default: 'general',
    },
    postedBy: { type: String, default: 'HR' },
    audience: {
      type: String,
      enum: ['all', 'department', 'team', 'manager-team'],
      default: 'all',
    },
    // When audience === 'manager-team', this is the manager who posted.
    // Used by the announcement reader to filter for assignees of THIS
    // manager only.
    postedByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Optional explicit audience list — if non-empty, only these user
    // IDs see the announcement. Used by manager posts: the controller
    // resolves the manager's team at post-time and snapshots the list
    // here so even if HR re-assigns someone later, the audience for
    // THIS announcement doesn't drift.
    audienceUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
      index: true,
    },
    isActive: { type: Boolean, default: true },
    // When this row came from an HRMS-posted announcement, externalId stores
    // the HRMS document _id so subsequent updates / deletes from HRMS can
    // find and refresh the right mobile row instead of duplicating.
    externalId: { type: String, default: null, index: true, sparse: true },
  },
  { timestamps: true }
);

announcementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
