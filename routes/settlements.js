const express = require('express');
const Settlement = require('../models/Settlement');
const Order = require('../models/Order');
const User = require('../models/User');
const PickupStation = require('../models/PickupStation');
const WalletService = require('../services/walletService');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const KYC = require('../models/KYC');
const { createNotification } = require('../utils/notifications'); // ✅ ADDED
const { logAction } = require('../utils/audit');

const router = express.Router();

// Get settlements for current vendor
router.get('/vendor', protect, async (req, res) => {
  try {
    const settlements = await Settlement.find({ vendorId: req.user._id })
      .populate('orderId', 'orderId totalKES')
      .sort({ createdAt: -1 });
    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get settlements for current agent
router.get('/agent', protect, async (req, res) => {
  try {
    const settlements = await Settlement.find({ agentId: req.user._id })
      .populate('orderId', 'orderId totalKES')
      .sort({ createdAt: -1 });
    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get settlements for current station manager
router.get('/station', protect, async (req, res) => {
  try {
    const settlements = await Settlement.find({ stationId: req.user.stationId })
      .populate('orderId', 'orderId totalKES')
      .sort({ createdAt: -1 });
    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: get all settlements
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const settlements = await Settlement.find()
      .populate('orderId', 'orderId totalKES')
      .populate('vendorId', 'fullName email')
      .populate('agentId', 'fullName email')
      .sort({ createdAt: -1 });
    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: mark settlement as paid (vendor, agent, or station) – auto‑credit wallet
router.put('/:id/paid', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { type } = req.body;
    const settlement = await Settlement.findById(req.params.id);
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    let userId = null;
    let amount = 0;
    let description = '';

    if (type === 'vendor') {
      if (settlement.vendorPaid) return res.status(400).json({ error: 'Vendor already paid' });
      userId = settlement.vendorId;
      amount = settlement.vendorEarnings;
      description = `Earnings from order #${settlement.orderId}`;
      settlement.vendorPaid = true;
    } else if (type === 'agent') {
      if (settlement.agentPaid) return res.status(400).json({ error: 'Agent already paid' });
      userId = settlement.agentId;
      amount = settlement.agentEarnings;
      description = `Delivery earnings from order #${settlement.orderId}`;
      settlement.agentPaid = true;
    } else if (type === 'station') {
      if (settlement.stationPaid) return res.status(400).json({ error: 'Station already paid' });
      const station = await PickupStation.findById(settlement.stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });
      if (!station.managerId) return res.status(400).json({ error: 'Station has no manager assigned' });
      userId = station.managerId;
      amount = settlement.stationEarnings;
      description = `Pickup station earnings from order #${settlement.orderId}`;
      settlement.stationPaid = true;
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }

    if (!userId) return res.status(400).json({ error: 'No user to credit' });

    // KYC check
    const kyc = await KYC.findOne({ userId });
    if (!kyc || kyc.status !== 'verified') {
      return res.status(400).json({
        error: 'User KYC not verified. Cannot process payout.'
      });
    }

    // Credit wallet
    const result = await WalletService.credit(
      userId,
      amount,
      description,
      settlement._id,
      'settlement'
    );

    await logAction(req, 'settlement_payout', userId, { amount, type, settlementId: settlement._id });

    // ✅ Create notification
    await createNotification(
      userId,
      'settlement',
      'Payout received',
      `You received KES ${amount} from settlement for order #${settlement.orderId}`,
      '/account.html'
    );

    // If all parties paid, set paidAt
    if (settlement.vendorPaid && settlement.agentPaid && settlement.stationPaid) {
      settlement.paidAt = new Date();
      settlement.settledBy = req.user._id;
    }
    await settlement.save();

    res.json({
      success: true,
      settlement,
      walletTransaction: result.transaction,
      newBalance: result.newBalance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;