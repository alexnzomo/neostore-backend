const express = require('express');
const AuditLog = require('../models/AuditLog');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get audit logs (admin/owner only)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const skip = parseInt(req.query.skip) || 0;
    const logs = await AuditLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'fullName email')
      .populate('targetUserId', 'fullName email');
    const total = await AuditLog.countDocuments();
    res.json({ logs, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;