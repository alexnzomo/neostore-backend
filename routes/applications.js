const express = require('express');
const Application = require('../models/Application');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Submit an application (logged-in user)
router.post('/', protect, async (req, res) => {
  try {
    const existing = await Application.findOne({ userId: req.user._id, status: 'pending' });
    if (existing) return res.status(400).json({ error: 'You already have a pending application' });
    const application = new Application({ ...req.body, userId: req.user._id, userEmail: req.user.email, userName: req.user.fullName });
    await application.save();
    res.status(201).json({ message: 'Application submitted', application });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all pending applications (admin/owner only)
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const apps = await Application.find({ status: 'pending' }).sort({ submittedAt: -1 });
    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject application (admin/owner)
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { status } = req.body; // 'approved' or 'rejected'
    const application = await Application.findById(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    if (application.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    application.status = status;
    application.reviewedBy = req.user._id;
    application.reviewedAt = new Date();
    await application.save();

    // If approved, update user's role
    if (status === 'approved') {
      await User.findByIdAndUpdate(application.userId, { role: application.role });
    }
    res.json({ message: `Application ${status}`, application });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;