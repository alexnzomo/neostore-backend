const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

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

// Update user role (owner only – because admin cannot change owner)
router.put('/:id/role', protect, allowRoles('owner'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!['customer', 'vendor', 'agent', 'station_manager', 'admin', 'owner'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Prevent changing the only owner's role away from owner
    if (user.role === 'owner' && role !== 'owner') {
      return res.status(403).json({ error: 'Cannot demote the platform owner' });
    }
    user.role = role;
    await user.save();
    res.json({ message: 'Role updated', user: { id: user._id, role: user.role } });
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

module.exports = router;