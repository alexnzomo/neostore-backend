const express = require('express');
const PickupApplication = require('../models/PickupApplication');
const PickupStation = require('../models/PickupStation');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const router = express.Router();

// Submit a pickup station application (logged-in user)
router.post('/', protect, async (req, res) => {
  const { stationName, address, city, county, phone, email, hours, notes } = req.body;
  if (!stationName || !address || !city || !county || !phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const existing = await PickupApplication.findOne({ userId: req.user._id, status: 'pending' });
  if (existing) return res.status(400).json({ error: 'You already have a pending application' });
  const application = new PickupApplication({
    userId: req.user._id,
    userName: req.user.fullName,
    userEmail: req.user.email,
    stationName,
    address,
    city,
    county,
    phone,
    email,
    hours,
    notes
  });
  await application.save();

  // Notify owner on new pickup station application (fire-and-forget)
  try {
    const owners = await User.find({ role: 'owner' });
    for (const owner of owners) {
      await createNotification(
        owner._id,
        'system',
        '📍 New Pickup Station Application',
        `${req.user.fullName} (${req.user.email}) applied to open "${stationName}". Review in Applications tab.`,
        '/admin.html?tab=applications'
      );
    }
  } catch (notifyErr) {
    console.error('Pickup application owner notification failed:', notifyErr.message);
  }

  res.status(201).json({ message: 'Application submitted', application });
});

// Get all pending applications (admin/owner only)
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const apps = await PickupApplication.find({ status: 'pending' }).sort({ submittedAt: -1 });
  res.json(apps);
});

// Approve or reject application (admin/owner)
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be approved or rejected' });
    }

    // Pre-check if approving (best effort — re-checked atomically below)
    if (status === 'approved') {
      const pendingApp = await PickupApplication.findById(req.params.id);
      if (!pendingApp) return res.status(404).json({ error: 'Not found' });
      const existingStation = await PickupStation.findOne({ managerId: pendingApp.userId });
      if (existingStation) {
        return res.status(400).json({
          error: `User already manages a station: ${existingStation.name}. Please unassign them first.`
        });
      }
    }

    // Atomic claim
    const application = await PickupApplication.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status, reviewedBy: req.user._id, reviewedAt: new Date() } },
      { new: true }
    );

    if (!application) {
      const existing = await PickupApplication.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      return res.status(400).json({ error: 'Already processed' });
    }

    if (status === 'approved') {
      // Re-check after claim to close the race window
      const racingStation = await PickupStation.findOne({ managerId: application.userId });
      if (racingStation) {
        // Undo our claim
        await PickupApplication.findByIdAndUpdate(application._id, {
          $set: { status: 'pending', reviewedBy: null, reviewedAt: null }
        });
        return res.status(400).json({
          error: `User already manages a station: ${racingStation.name}. Please unassign them first.`
        });
      }

      const newStation = new PickupStation({
        name: application.stationName,
        address: application.address,
        city: application.city,
        county: application.county,
        phone: application.phone,
        email: application.email || '',
        hours: application.hours || '',
        managerId: application.userId,
        approvedBy: req.user._id,
        approvedAt: new Date()
      });
      await newStation.save();

      await User.findByIdAndUpdate(application.userId, {
        role: 'station_manager',
        stationId: newStation._id
      });

      await createNotification(
        application.userId,
        'system',
        '✅ Pickup Station Approved',
        `Your application for "${application.stationName}" has been approved. You are now a station manager.`,
        '/station_manager.html'
      );
    } else {
      await createNotification(
        application.userId,
        'system',
        '❌ Pickup Station Rejected',
        `Your application for "${application.stationName}" was not approved.`,
        '/account.html'
      );
    }

    res.json({ message: `Application ${status}` });
  } catch (err) {
    console.error('Pickup application update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;