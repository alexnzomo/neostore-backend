const express = require('express');
const PickupApplication = require('../models/PickupApplication');
const PickupStation = require('../models/PickupStation');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

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
  res.status(201).json({ message: 'Application submitted', application });
});

// Get all pending applications (admin/owner only)
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const apps = await PickupApplication.find({ status: 'pending' }).sort({ submittedAt: -1 });
  res.json(apps);
});

// Approve or reject application (admin/owner)
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { status } = req.body; // 'approved' or 'rejected'
  const application = await PickupApplication.findById(req.params.id);
  if (!application) return res.status(404).json({ error: 'Not found' });
  if (application.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
  application.status = status;
  application.reviewedBy = req.user._id;
  application.reviewedAt = new Date();
  await application.save();
  // If approved, create a pickup station record
  if (status === 'approved') {
    const newStation = new PickupStation({
      name: application.stationName,
      address: application.address,
      city: application.city,
      county: application.county,
      phone: application.phone,
      email: application.email || '',
      hours: application.hours || '',
      approvedBy: req.user._id,
      approvedAt: new Date()
    });
    await newStation.save();
  }
  res.json({ message: `Application ${status}` });
});

module.exports = router;