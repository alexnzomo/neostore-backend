const express = require('express');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const Order = require('../models/Order');
const Settlement = require('../models/Settlement');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');

const router = express.Router();

/**
 * GET /api/reports
 * Returns key platform metrics for admin/owner dashboard.
 * Access: admin or owner only.
 */
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    // 1. Total number of orders
    const totalOrders = await Order.countDocuments();

    // 2. Total sales (sum of all order totals in KES)
    const totalSalesAgg = await Order.aggregate([
      { $group: { _id: null, total: { $sum: '$totalKES' } } }
    ]);
    const totalSales = totalSalesAgg[0]?.total || 0;

    // 3. Total platform commission earned (from settlements)
    const totalCommissionAgg = await Settlement.aggregate([
      { $group: { _id: null, total: { $sum: '$platformCommission' } } }
    ]);
    const totalCommission = totalCommissionAgg[0]?.total || 0;

    // 4. Total wallet balance across all users
    const totalWalletAgg = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$walletBalance' } } }
    ]);
    const totalWalletBalance = totalWalletAgg[0]?.total || 0;

    // 5. Total number of registered users
    const totalUsers = await User.countDocuments();

    // 6. Number of pending settlements (any party unpaid)
    const pendingSettlements = await Settlement.countDocuments({
      $or: [
        { vendorPaid: false },
        { agentPaid: false },
        { stationPaid: false }
      ]
    });

    // 7. (Optional) Total number of withdrawals pending
    const pendingWithdrawals = await require('../models/Withdrawal').countDocuments({ status: 'pending' });

    // 8. (Optional) Total amount of pending withdrawals
    const pendingWithdrawalAgg = await require('../models/Withdrawal').aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingWithdrawalAmount = pendingWithdrawalAgg[0]?.total || 0;

    res.json({
      totalOrders,
      totalSales,
      totalCommission,
      totalWalletBalance,
      totalUsers,
      pendingSettlements,
      pendingWithdrawals,
      pendingWithdrawalAmount
    });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;