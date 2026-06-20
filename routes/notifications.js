const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Get unread notifications
router.get('/unread', protect, async (req, res) => {
  const notifications = await Notification.find({ userId: req.user._id, isRead: false }).sort({ createdAt: -1 });
  res.json(notifications);
});

// Mark as read
router.put('/:id/read', protect, async (req, res) => {
  await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
  res.json({ success: true });
});

// Mark all as read
router.put('/read-all', protect, async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, isRead: false }, { isRead: true });
  res.json({ success: true });
});

module.exports = router;