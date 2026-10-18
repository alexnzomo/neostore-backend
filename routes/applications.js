const express = require('express');
const Application = require('../models/Application');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// Submit an application (logged-in user)
router.post('/', protect, async (req, res) => {
  try {
    const existing = await Application.findOne({ userId: req.user._id, status: 'pending' });
    if (existing) return res.status(400).json({ error: 'You already have a pending application' });

    const {
      role, businessName, phone, address, taxId, reason,
      nationalId, idImageUrl, proofOfAddress, dob, country
    } = req.body;

    if (!role || !businessName || !phone || !address || !reason || !nationalId || !proofOfAddress || !dob || !country) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['vendor', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Role must be vendor or agent' });
    }

    const application = new Application({
      userId: req.user._id,
      userEmail: req.user.email,
      userName: req.user.fullName,
      role, businessName, phone, address, taxId, reason,
      nationalId, idImageUrl, proofOfAddress, dob, country,
      status: 'pending'
    });
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
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }

    const application = await Application.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status, reviewedBy: req.user._id, reviewedAt: new Date() } },
      { new: true }
    );

    if (!application) {
      const existing = await Application.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Application not found' });
      return res.status(400).json({ error: 'Already processed' });
    }

    if (status === 'approved') {
      await User.findByIdAndUpdate(application.userId, { role: application.role });
      await createNotification(
        application.userId,
        'system',
        '✅ Application Approved',
        `Your application to become a ${application.role} has been approved.`,
        '/account.html'
      );
    } else {
      await createNotification(
        application.userId,
        'system',
        '❌ Application Rejected',
        `Your application to become a ${application.role} was not approved.`,
        '/account.html'
      );
    }

    res.json({ message: `Application ${status}`, application });
  } catch (err) {
    console.error('Application update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;