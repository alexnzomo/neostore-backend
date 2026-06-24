const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

async function logAction(req, action, targetUserId = null, details = {}) {
  try {
    const user = req.user;
    if (!user) return;
    let targetEmail = null;
    if (targetUserId) {
      const targetUser = await User.findById(targetUserId).select('email');
      if (targetUser) targetEmail = targetUser.email;
    }
    const audit = new AuditLog({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action,
      targetUserId,
      targetEmail,
      details,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      userAgent: req.headers['user-agent']
    });
    await audit.save();
  } catch (err) {
    console.error('❌ Audit log error:', err);
  }
}

module.exports = { logAction };