// routes/users.js
const express = require('express');
const User = require('../models/User');
const PickupStation = require('../models/PickupStation');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { logAction } = require('../utils/audit');
const { createNotification } = require('../utils/notifications'); // ✅ NEW
const { sanitizeBody } = require('../middleware/sanitize'); // ✅ NEW
const { body, validationResult } = require('express-validator'); // ✅ NEW

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

// Update user role (owner only) – with validation and sanitisation
router.put(
  '/:id/role',
  protect,
  allowRoles('owner'),
  sanitizeBody(['role']), // ✅ NEW
  [
    body('role')
      .isIn(['customer', 'vendor', 'agent', 'station_manager', 'admin', 'owner'])
      .withMessage('Invalid role'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { role } = req.body;
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const oldRole = user.role; // ✅ for audit log
      if (user.role === 'owner' && role !== 'owner') {
        return res.status(403).json({ error: 'Cannot demote the platform owner' });
      }

      user.role = role;
      await user.save();

      await logAction(req, 'role_change', user._id, { oldRole, newRole: role });
      res.json({ message: 'Role updated', user: { id: user._id, role: user.role } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Assign station to a station manager (admin/owner only) – with checks & notification
router.put(
  '/:id/assign-station',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['stationId']), // ✅ NEW
  [
    body('stationId').notEmpty().withMessage('Station ID required'),
    body('stationId').isMongoId().withMessage('Invalid station ID'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { stationId } = req.body;
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role !== 'station_manager') {
        return res.status(400).json({ error: 'User is not a station manager' });
      }

      const station = await PickupStation.findById(stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });

      // Check if the station already has a manager
      if (station.managerId) {
        const currentManager = await User.findById(station.managerId);
        return res.status(400).json({
          error: `Station already has a manager: ${currentManager?.fullName || 'Unknown user'}. Please unassign them first.`
        });
      }

      // Check if the user already manages a station
      if (user.stationId) {
        const existingStation = await PickupStation.findById(user.stationId);
        return res.status(400).json({
          error: `User already manages station: ${existingStation?.name || 'Unknown station'}. Please unassign them first.`
        });
      }

      user.stationId = stationId;
      station.managerId = user._id;
      await user.save();
      await station.save();

      await logAction(req, 'station_assign', user._id, { stationId });
      // ✅ Send notification to the new station manager
      await createNotification(
        user._id,
        'system',
        'Station Manager Assignment',
        `You have been assigned as manager of "${station.name}". Please visit your station dashboard.`,
        '/station-manager.html'
      );

      res.json({ success: true, user: { id: user._id, stationId: user.stationId } });
    } catch (err) {
      console.error('Station assignment error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Unassign a station manager (admin/owner only)
router.delete(
  '/:stationId/unassign-manager',
  protect,
  allowRoles('admin', 'owner'),
  async (req, res) => {
    try {
      const station = await PickupStation.findById(req.params.stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });
      if (!station.managerId) return res.status(400).json({ error: 'Station has no manager' });

      const manager = await User.findById(station.managerId);
      if (manager) {
        manager.stationId = null;
        await manager.save();
      }
      station.managerId = null;
      await station.save();

      await logAction(req, 'station_unassign', manager?._id, { stationId: station._id });

      res.json({ success: true, message: 'Station manager removed' });
    } catch (err) {
      console.error('Unassign station manager error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Suspend or unsuspend user (admin/owner) – with sanitisation & validation
router.put(
  '/:id/suspend',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['isSuspended', 'suspendedUntil']), // ✅ NEW
  [
    body('isSuspended').isBoolean().withMessage('isSuspended must be boolean'),
    body('suspendedUntil')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { isSuspended, suspendedUntil } = req.body;
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'owner') return res.status(403).json({ error: 'Cannot suspend the owner' });

      user.isSuspended = isSuspended;
      if (suspendedUntil) user.suspendedUntil = new Date(suspendedUntil);

      await user.save();
      await logAction(req, isSuspended ? 'suspend_user' : 'unsuspend_user', user._id, { suspendedUntil });

      res.json({ message: `User ${isSuspended ? 'suspended' : 'unsuspended'}`, user: { id: user._id, isSuspended: user.isSuspended } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Delete user (owner only)
router.delete('/:id', protect, allowRoles('owner'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete the owner' });
    await user.deleteOne();
    await logAction(req, 'delete_user', user._id, { deletedUser: user.email });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password (public, after code verification) – already sanitized in auth.js
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