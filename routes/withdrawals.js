const express = require('express');
const Withdrawal = require('../models/Withdrawal');
const WalletService = require('../services/walletService');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { requireKYC } = require('../middleware/kyc');
const { createNotification } = require('../utils/notifications');
const { logAction } = require('../utils/audit');

const router = express.Router();

// ========== User endpoints ==========

// Request a withdrawal
router.post('/', protect, requireKYC, async (req, res) => {
  try {
    const { amount, method, bankDetails, mpesaNumber } = req.body;

    // ✅ Check if withdrawals are frozen
    const frozenSetting = await Settings.findOne({ key: 'withdrawals_frozen' });
    if (frozenSetting && frozenSetting.value === 'true') {
      return res.status(403).json({ error: 'Withdrawals are currently frozen. Please try again later.' });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    if (!method) {
      return res.status(400).json({ error: 'Method required' });
    }

    // Check balance
    const balance = await WalletService.getBalance(req.user._id);
    if (balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    // Validate method-specific details
    if (method === 'bank' && (!bankDetails || !bankDetails.bankName || !bankDetails.accountNumber)) {
      return res.status(400).json({ error: 'Bank details required' });
    }
    if (method === 'mpesa' && !mpesaNumber) {
      return res.status(400).json({ error: 'M-Pesa number required' });
    }

    const withdrawal = new Withdrawal({
      userId: req.user._id,
      amount,
      method,
      bankDetails: method === 'bank' ? bankDetails : null,
      mpesaNumber: method === 'mpesa' ? mpesaNumber : null,
      status: 'pending'
    });
    await withdrawal.save();

    // Notify user
    await createNotification(
      req.user._id,
      'system',
      'Withdrawal request submitted',
      `Your withdrawal request of KES ${amount} has been submitted for review.`,
      '/account.html'
    );

    res.status(201).json(withdrawal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's own withdrawal history
router.get('/my', protect, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Admin endpoints ==========

// Get all pending withdrawals
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ status: 'pending' })
      .populate('userId', 'fullName email')
      .sort({ createdAt: 1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all withdrawals (with filter)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const withdrawals = await Withdrawal.find(filter)
      .populate('userId', 'fullName email')
      .sort({ createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: approve, reject, or complete a withdrawal
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    // Status transition logic
    if (status === 'approved') {
      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending can be approved' });
      }
      withdrawal.status = 'approved';
      withdrawal.reviewedBy = req.user._id;
      withdrawal.reviewedAt = new Date();

      // Notify user
      await createNotification(
        withdrawal.userId,
        'system',
        'Withdrawal approved',
        `Your withdrawal request of KES ${withdrawal.amount} has been approved and is being processed.`,
        '/account.html'
      );

    } else if (status === 'rejected') {
      if (withdrawal.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending can be rejected' });
      }
      withdrawal.status = 'rejected';
      withdrawal.reviewedBy = req.user._id;
      withdrawal.reviewedAt = new Date();

      // Notify user
      await createNotification(
        withdrawal.userId,
        'system',
        'Withdrawal rejected',
        `Your withdrawal request of KES ${withdrawal.amount} has been rejected. Reason: ${adminNote || 'No reason provided.'}`,
        '/account.html'
      );

    } else if (status === 'completed') {
      if (withdrawal.status !== 'approved') {
        return res.status(400).json({ error: 'Must be approved first' });
      }
      // Deduct from wallet
      const balance = await WalletService.getBalance(withdrawal.userId);
      if (balance < withdrawal.amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      const result = await WalletService.debit(
        withdrawal.userId,
        withdrawal.amount,
        `Withdrawal via ${withdrawal.method}`,
        withdrawal._id,
        'withdrawal'
      );
      withdrawal.status = 'completed';
      withdrawal.completedAt = new Date();

      // Audit log
      await logAction(req, 'withdrawal_complete', withdrawal.userId, {
        amount: withdrawal.amount,
        method: withdrawal.method,
        withdrawalId: withdrawal._id
      });

      // Notify user
      await createNotification(
        withdrawal.userId,
        'system',
        'Withdrawal completed',
        `Your withdrawal request of KES ${withdrawal.amount} has been completed and funds have been sent to your ${withdrawal.method} account.`,
        '/account.html'
      );

    } else {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (adminNote) withdrawal.adminNote = adminNote;
    await withdrawal.save();

    res.json(withdrawal);
  } catch (err) {
    console.error('Withdrawal update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;