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

// Get all users (admin/owner only) – PAGINATED
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;

    // 🔴 Owner-only fields hidden from non-owners
    const projection = req.user.role === 'owner'
      ? '-password'
      : '-password -walletBalance -referralCode -canApproveWithdrawals';

    const [users, total] = await Promise.all([
      User.find().select(projection).skip(skip).limit(limit),
      User.countDocuments()
    ]);

    res.json({ users, total, limit, skip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single user (admin/owner only)
router.get('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Non-owners cannot see soft-deleted users
    if (user.deletedAt && req.user.role !== 'owner') {
      return res.status(404).json({ error: 'User not found' });
    }

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
        return res.status(403).json({ error: 'Cannot demote the platform principal' });
      }

      // Guard: no user can change their own role
      if (user._id.toString() === req.user._id.toString() && role !== user.role) {
        return res.status(403).json({
          error: 'You cannot change your own role. Ask another user with sufficient privileges to change it.'
        });
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

// Assign station to a station manager OR agent (admin/owner only)
router.put(
  '/:id/assign-station',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['stationId']),
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

      if (!['station_manager', 'agent'].includes(user.role)) {
        return res.status(400).json({ error: 'Only station managers and agents can be assigned to a station' });
      }

      const station = await PickupStation.findById(stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });

      // Station manager-specific checks (one manager per station, one station per manager)
      if (user.role === 'station_manager') {
        if (station.managerId) {
          const currentManager = await User.findById(station.managerId);
          return res.status(400).json({
            error: `Station already has a manager: ${currentManager?.fullName || 'Unknown user'}. Please unassign them first.`
          });
        }
        if (user.stationId) {
          const existingStation = await PickupStation.findById(user.stationId);
          return res.status(400).json({
            error: `User already manages station: ${existingStation?.name || 'Unknown station'}. Please unassign them first.`
          });
        }
        station.managerId = user._id;
        await station.save();
      } else {
        // Agents: many agents per station, one station per agent
        if (user.stationId && user.stationId.toString() !== stationId) {
          const existingStation = await PickupStation.findById(user.stationId);
          return res.status(400).json({
            error: `Agent is currently assigned to ${existingStation?.name || 'another station'}. Unassign first.`
          });
        }
      }

      user.stationId = stationId;
      await user.save();

      await logAction(req, 'station_assign', user._id, { stationId, role: user.role });

      await createNotification(
        user._id,
        'system',
        user.role === 'station_manager' ? 'Station Manager Assignment' : 'Station Assignment',
        user.role === 'station_manager'
          ? `You have been assigned as manager of "${station.name}". Please visit your station dashboard.`
          : `You have been assigned to "${station.name}" as a delivery agent.`,
        user.role === 'station_manager' ? '/station_manager.html' : '/agent.html'
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

// Unassign a user (agent) from their station (admin/owner only)
router.delete(
  '/:userId/unassign-user-station',
  protect,
  allowRoles('admin', 'owner'),
  async (req, res) => {
    try {
      const user = await User.findById(req.params.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (user.role === 'station_manager') {
        return res.status(400).json({
          error: 'Station managers must be unassigned via the station endpoint, not this one.'
        });
      }

      if (!user.stationId) {
        return res.status(400).json({ error: 'User is not assigned to a station' });
      }

      const previousStationId = user.stationId;
      user.stationId = null;
      await user.save();

      await logAction(req, 'station_unassign', user._id, { stationId: previousStationId });

      res.json({ success: true, message: 'User removed from station' });
    } catch (err) {
      console.error('Unassign user station error:', err);
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
      if (user.role === 'owner') return res.status(403).json({ error: 'Cannot suspend the platform principal'});

      // Guard: only owner can suspend another admin
      if (user.role === 'admin' && req.user.role !== 'owner') {
        return res.status(403).json({
          error: 'Only a user with sufficient privileges can suspend another administrator.'
        });
      }

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

// Toggle finance approver privilege for an admin (owner only)
router.put(
  '/:id/finance-role',
  protect,
  allowRoles('owner'),
  sanitizeBody(['canApproveWithdrawals']),
  [
    body('canApproveWithdrawals').isBoolean().withMessage('Must be true or false'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { canApproveWithdrawals } = req.body;
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'owner') {
        return res.status(400).json({ error: 'Platform principal always has approval rights — no flag needed' });
      }
      if (user.role !== 'admin') {
        return res.status(400).json({ error: 'Finance approver role only applies to admin users' });
      }

      user.canApproveWithdrawals = canApproveWithdrawals;
      await user.save();

      await logAction(req, 'finance_role_change', user._id, { canApproveWithdrawals });

      res.json({
        success: true,
        user: { id: user._id, canApproveWithdrawals: user.canApproveWithdrawals }
      });
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
    if (user.role === 'owner') return res.status(403).json({ error: 'Cannot delete the platform principal' });
    if (user.deletedAt) return res.status(400).json({ error: 'User already deleted' });

    // Refuse if there are active orders — must be resolved first
    const Order = require('../models/Order');
    const activeOrders = await Order.countDocuments({
      $or: [{ customerId: user._id }, { assignedAgentId: user._id }],
      deliveryStatus: { $nin: ['delivered', 'cancelled'] }
    });
    if (activeOrders > 0) {
      return res.status(400).json({
        error: `User has ${activeOrders} active order(s). Resolve or reassign them first.`
      });
    }

    // Refuse if the user is a station manager still attached to a station
    if (user.stationId) {
      return res.status(400).json({
        error: 'User is a station manager. Unassign them from their station first.'
      });
    }

    // If they have financial history (products or settlements), soft delete
    const Product = require('../models/Product');
    const Settlement = require('../models/Settlement');
    const [activeProducts, vendorSettlements] = await Promise.all([
      Product.countDocuments({ vendorId: user._id, isDeleted: { $ne: true } }),
      Settlement.countDocuments({ vendorId: user._id })
    ]);

    if (activeProducts > 0 || vendorSettlements > 0) {
      // 🔴 SOFT DELETE: preserve financial history
      await User.softDelete(user._id, req.user._id, `Admin deletion via API (had ${activeProducts} products, ${vendorSettlements} settlements)`);
      await logAction(req, 'soft_delete_user', user._id, {
        deletedEmail: user.email,
        activeProducts,
        vendorSettlements
      });
      return res.json({
        message: 'User soft-deleted. Financial history preserved. The user cannot log in.',
        softDeleted: true
      });
    }

    // No financial history — safe to hard delete
    const deletedEmail = user.email;
    await user.deleteOne();
    await logAction(req, 'delete_user', user._id, { deletedUser: deletedEmail });
    res.json({ message: 'User deleted permanently.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reactivate a soft-deleted user (owner only)
router.post(
  '/:id/reactivate',
  protect,
  allowRoles('owner'),
  [
    body('email')
      .isEmail()
      .withMessage('Valid email required')
      .normalizeEmail(),
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Full name required')
      .isLength({ max: 100 })
      .withMessage('Full name too long'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!user.deletedAt) return res.status(400).json({ error: 'User is not deleted' });

      const { email, fullName } = req.body;
      const normalizedEmail = email.trim().toLowerCase();

      // Check email is not taken by ANOTHER user
      const existing = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: user._id }
      });
      if (existing) {
        return res.status(400).json({ error: 'Email already in use by another account' });
      }

      // Restore fields
      user.deletedAt = null;
      user.deletedBy = null;
      user.deleteReason = null;
      user.isSuspended = false;
      user.email = normalizedEmail;
      user.fullName = fullName.trim();
      // walletBalance, phone, referralCode, canApproveWithdrawals remain at their soft-delete values (0, null, null, false)
      // The owner must manually re-enable those if needed

      await user.save();

      await logAction(req, 'reactivate_user', user._id, {
        restoredEmail: normalizedEmail,
        restoredFullName: fullName.trim()
      });

      res.json({
        success: true,
        message: 'User reactivated. Wallet balance, phone, and referral code remain zeroed. Please update those fields manually if needed.',
        userId: user._id
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Reset password — verifies OTP in the SAME request
router.post('/reset-password', async (req, res) => {
  const { email, newPassword, code } = req.body;

  if (!email || !newPassword || !code) {
    return res.status(400).json({ error: 'Email, new password, and reset code are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const Otp = require('../models/Otp');
    const normalizedEmail = email.trim().toLowerCase();

    const otpDoc = await Otp.findOne({ email: normalizedEmail, otp: code });
    if (!otpDoc) {
      return res.status(400).json({ error: 'Invalid or expired reset code' });
    }
    if (otpDoc.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: otpDoc._id });
      return res.status(400).json({ error: 'Reset code expired. Please request a new one.' });
    }

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      await Otp.deleteOne({ _id: otpDoc._id });
      return res.status(404).json({ error: 'User not found' });
    }

    user.password = newPassword;
    await user.save();

    await Otp.deleteOne({ _id: otpDoc._id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;