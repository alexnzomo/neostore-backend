const express = require('express');
const User = require('../models/User');
const PickupStation = require('../models/PickupStation'); // ✅ ADDED
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { logAction } = require('../utils/audit');

const router = express.Router();

// Get all users (admin/owner only)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single user (admin/owner only)
router.get('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user role (owner only)
router.put('/:id/role', protect, allowRoles('owner'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!['customer', 'vendor', 'agent', 'station_manager', 'admin', 'owner'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner' && role !== 'owner') {
      return res.status(403).json({ error: 'Cannot demote the platform owner' });
    }
    user.role = role;
    await user.save();
    await logAction(req, 'role_change', userId, { oldRole: user.role, newRole: role });
    res.json({ message: 'Role updated', user: { id: user._id, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Assign station to a user (admin/owner only)
router.put('/:id/assign-station', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { stationId } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Optional: Check if the user is a station manager
    if (user.role !== 'station_manager') {
      return res.status(400).json({ error: 'User is not a station manager' });
    }

    // Validate station exists
    if (stationId) {
      const station = await PickupStation.findById(stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });
    }

    user.stationId = stationId || null;
    await user.save();
    await logAction(req, 'station_assign', userId, { stationId });

    res.json({ success: true, user: { id: user._id, stationId: user.stationId } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suspend or unsuspend user (admin/owner)
router.put('/:id/suspend', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { isSuspended, suspendedUntil } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot suspend the owner' });
    user.isSuspended = isSuspended;
    if (suspendedUntil) user.suspendedUntil = new Date(suspendedUntil);
    await user.save();
    res.json({ message: `User ${isSuspended ? 'suspended' : 'unsuspended'}`, user: { id: user._id, isSuspended: user.isSuspended } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user (owner only)
router.delete('/:id', protect, allowRoles('owner'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete the owner' });
    await user.deleteOne();
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password (public)
router.post('/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) {
    return res.status(400).json({ error: 'Email and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = newPassword;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;