const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Get unread notifications
router.get('/unread', protect, async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.user._id, isRead: false }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all notifications (paginated)
router.get('/all', protect, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const notifications = await Notification.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Notification.countDocuments({ userId: req.user._id });
    res.json({ notifications, total, limit, skip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark single notification as read
router.put('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, userId: req.user._id });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    notification.isRead = true;
    await notification.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all as read
router.put('/read-all', protect, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, isRead: false },
      { isRead: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a notification
router.delete('/:id', protect, async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, userId: req.user._id });
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    await notification.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Create a notification (agent/station/admin/owner only)
router.post('/', protect, async (req, res) => {
  try {
    const { userId, type, title, message, link } = req.body;

    const allowedRoles = ['agent', 'station_manager', 'admin', 'owner'];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized to send notifications' });
    }

    if (!userId || !title || !message) {
      return res.status(400).json({ error: 'Missing required fields: userId, title, message' });
    }

    const notification = new Notification({
      userId,
      type: type || 'system',
      title,
      message,
      link: link || null,
      isRead: false,
      createdAt: new Date()
    });
    await notification.save();

    res.status(201).json({ success: true, notification });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;