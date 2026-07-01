// routes/withdrawals.js
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
const { sanitizeBody } = require('../middleware/sanitize');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// ========== User endpoints ==========

// Request a withdrawal
router.post(
  '/',
  protect,
  requireKYC,
  sanitizeBody(['amount', 'method', 'bankDetails.bankName', 'bankDetails.accountName', 'bankDetails.accountNumber', 'mpesaNumber']),
  [
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be positive'),
    body('method').isIn(['bank', 'mpesa']).withMessage('Invalid withdrawal method'),
    body('bankDetails').custom((value, { req }) => {
      if (req.body.method === 'bank' && (!value || !value.bankName || !value.accountNumber)) {
        throw new Error('Bank details (bankName, accountNumber) required for bank withdrawals');
      }
      return true;
    }),
    body('mpesaNumber').custom((value, { req }) => {
      if (req.body.method === 'mpesa' && !value) {
        throw new Error('M‑Pesa number required for M‑Pesa withdrawals');
      }
      return true;
    }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { amount, method, bankDetails, mpesaNumber } = req.body;

      // ✅ Check if withdrawals are frozen
      const frozenSetting = await Settings.findOne({ key: 'withdrawals_frozen' });
      if (frozenSetting && frozenSetting.value === 'true') {
        return res.status(403).json({ error: 'Withdrawals are currently frozen. Please try again later.' });
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

      // Audit log
      await logAction(req, 'withdrawal_request', req.user._id, { amount, method, withdrawalId: withdrawal._id });

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
      console.error('Withdrawal request error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

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
router.put(
  '/:id',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['status', 'adminNote']),
  [
    body('status').isIn(['approved', 'rejected', 'completed']).withMessage('Invalid status'),
    body('adminNote').optional().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { status, adminNote } = req.body;
      const withdrawal = await Withdrawal.findById(req.params.id).populate('userId', 'fullName email');
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

        // Audit
        await logAction(req, 'withdrawal_approve', withdrawal.userId._id, { withdrawalId: withdrawal._id, amount: withdrawal.amount });

        // Notify user
        await createNotification(
          withdrawal.userId._id,
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

        // Audit
        await logAction(req, 'withdrawal_reject', withdrawal.userId._id, { withdrawalId: withdrawal._id, reason: adminNote });

        // Notify user
        await createNotification(
          withdrawal.userId._id,
          'system',
          'Withdrawal rejected',
          `Your withdrawal request of KES ${withdrawal.amount} has been rejected. Reason: ${adminNote || 'No reason provided.'}`,
          '/account.html'
        );

      } else if (status === 'completed') {
        if (withdrawal.status !== 'approved') {
          return res.status(400).json({ error: 'Must be approved first' });
        }

        // ✅ ===== TIERED FEE LOGIC (INSERTED HERE) =====
        let flatFee = 30;        // default
        let percentageFee = 1;   // default 1%
        let threshold = 10000;   // default KES 10,000

        try {
          const flatSetting = await Settings.findOne({ key: 'withdrawalFeeFlat' });
          if (flatSetting) flatFee = flatSetting.value;
          
          const percSetting = await Settings.findOne({ key: 'withdrawalFeePercentage' });
          if (percSetting) percentageFee = percSetting.value;
          
          const threshSetting = await Settings.findOne({ key: 'withdrawalFeeThreshold' });
          if (threshSetting) threshold = threshSetting.value;
        } catch (e) {}

        let fee;
        if (withdrawal.amount >= threshold) {
          // Percentage fee (rounded to whole KES)
          fee = Math.round((withdrawal.amount * percentageFee) / 100);
        } else {
          // Flat fee
          fee = flatFee;
        }

        const totalDebit = withdrawal.amount + fee;
        // ===== END TIERED FEE LOGIC =====

        // Check balance (against totalDebit, not just withdrawal.amount)
        const balance = await WalletService.getBalance(withdrawal.userId._id);
        if (balance < totalDebit) {
          return res.status(400).json({ error: 'Insufficient balance (including fee)' });
        }

        // Deduct from wallet (totalDebit = amount + fee)
        const result = await WalletService.debit(
          withdrawal.userId._id,
          totalDebit,
          `Withdrawal via ${withdrawal.method} (fee: KES ${fee})`,
          withdrawal._id,
          'withdrawal'
        );
        withdrawal.status = 'completed';
        withdrawal.completedAt = new Date();

        // Audit
        await logAction(req, 'withdrawal_complete', withdrawal.userId._id, {
          withdrawalId: withdrawal._id,
          amount: withdrawal.amount,
          fee: fee,
          totalDebit: totalDebit,
          method: withdrawal.method,
          newBalance: result.newBalance
        });

        // Notify user
        await createNotification(
          withdrawal.userId._id,
          'system',
          'Withdrawal completed',
          `Your withdrawal request of KES ${withdrawal.amount} has been completed. A fee of KES ${fee} was deducted. Funds have been sent to your ${withdrawal.method} account.`,
          '/account.html'
        );
      }

      if (adminNote) withdrawal.adminNote = adminNote;
      await withdrawal.save();

      res.json(withdrawal);
    } catch (err) {
      console.error('Withdrawal update error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;