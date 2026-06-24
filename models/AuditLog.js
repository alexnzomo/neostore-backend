const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userRole: { type: String, required: true },
  action: { type: String, required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  targetEmail: { type: String },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  ipAddress: { type: String },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AuditLog', auditLogSchema);