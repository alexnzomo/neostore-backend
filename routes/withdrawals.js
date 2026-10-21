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
    body('amount').isFloat({ min: 100 }).withMessage('Minimum withdrawal amount is KES 100'),
    body('method').isIn(['bank', 'mpesa']).withMessage('Invalid withdrawal method'),
    body('pin').isLength({ min: 4, max: 6 }).withMessage('Wallet PIN required (4-6 digits)'),
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

      // ✅ VERIFY PIN FIRST
      const pinRecord = await require('../models/WalletPIN').findOne({ userId: req.user._id });
      if (!pinRecord) {
        return res.status(400).json({ error: 'No wallet PIN set. Please set a PIN first.' });
      }
      if (pinRecord.lockedUntil && pinRecord.lockedUntil > new Date()) {
        return res.status(403).json({ error: 'PIN locked due to too many failed attempts. Try again later.' });
      }
      const isPinValid = await pinRecord.comparePIN(req.body.pin);
      if (!isPinValid) {
        pinRecord.failedAttempts += 1;
        if (pinRecord.failedAttempts >= 5) {
          pinRecord.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        }
        await pinRecord.save();
        return res.status(400).json({ error: 'Invalid PIN.' });
      }
      pinRecord.failedAttempts = 0;
      pinRecord.lockedUntil = null;
      await pinRecord.save();

      // ✅ Check cooldown
      if (pinRecord.pinChangedAt) {
        const cooldownHours = pinRecord.pinChangeReason === 'forgot_reset' ? 24 : 1;
        const hoursSince = (Date.now() - pinRecord.pinChangedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSince < cooldownHours) {
          return res.status(403).json({
            error: `For security, withdrawals are disabled for ${Math.ceil(cooldownHours - hoursSince)} more hour(s) after a recent PIN change.`
          });
        }
      }

      // ✅ Check if withdrawals are frozen
      const frozenSetting = await Settings.findOne({ key: 'withdrawals_frozen' });
      if (frozenSetting && frozenSetting.value === 'true') {
        return res.status(403).json({ error: 'Withdrawals are currently frozen. Please try again later.' });
      }

      // 2. Validate method-specific details BEFORE deducting money
      if (method === 'bank' && (!bankDetails || !bankDetails.bankName || !bankDetails.accountNumber)) {
        return res.status(400).json({ error: 'Bank details required' });
      }
      if (method === 'mpesa' && !mpesaNumber) {
        return res.status(400).json({ error: 'M-Pesa number required' });
      }

      // 3. Calculate fee
      let flatFee = 30, percentageFee = 1, threshold = 10000;
      try {
        const flatSetting = await Settings.findOne({ key: 'withdrawalFeeFlat' });
        if (flatSetting) flatFee = flatSetting.value;
        const percSetting = await Settings.findOne({ key: 'withdrawalFeePercentage' });
        if (percSetting) percentageFee = percSetting.value;
        const threshSetting = await Settings.findOne({ key: 'withdrawalFeeThreshold' });
        if (threshSetting) threshold = threshSetting.value;
      } catch (e) {}

      const fee = amount >= threshold ? Math.round((amount * percentageFee) / 100) : flatFee;
      const totalDebit = amount + fee;

      // 4. Check balance (must cover amount + fee)
      const balance = await WalletService.getBalance(req.user._id);
      if (balance < totalDebit) {
        return res.status(400).json({ error: `Insufficient wallet balance (requires KES ${totalDebit} including fee).` });
      }

      // 5. FREEZE FUNDS: Deduct immediately so user can't spend it while admin processes
      await WalletService.debit(
        req.user._id,
        totalDebit,
        `Withdrawal request via ${method}`,
        null,
        'withdrawal'
      );

      // 6. Create the request, saving the fee!
      const withdrawal = new Withdrawal({
        userId: req.user._id,
        amount,
        fee: fee,
        method,
        bankDetails: method === 'bank' ? bankDetails : null,
        mpesaNumber: method === 'mpesa' ? mpesaNumber : null,
        status: 'pending'
      });
      await withdrawal.save();

      await logAction(req, 'withdrawal_request', req.user._id, { amount, method, withdrawalId: withdrawal._id });

      await createNotification(
        req.user._id,
        'system',
        'Withdrawal request submitted',
        `Your withdrawal request of KES ${amount} has been submitted for review. A fee of KES ${fee} was applied.`,
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
      .populate('reviewedBy', 'fullName')
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
      .populate('reviewedBy', 'fullName')
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

      if (status === 'approved') {
        if (withdrawal.status !== 'pending') {
          return res.status(400).json({ error: 'Only pending can be approved' });
        }
        withdrawal.status = 'approved';
        withdrawal.reviewedBy = req.user._id;
        withdrawal.reviewedAt = new Date();

        await logAction(req, 'withdrawal_approve', withdrawal.userId._id, { withdrawalId: withdrawal._id, amount: withdrawal.amount });

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
        
        // REFUND THE FROZEN FUNDS (Using the saved fee)
        const refundAmount = withdrawal.amount + (withdrawal.fee || 30);
        await WalletService.credit(
          withdrawal.userId._id,
          refundAmount,
          `Refund: Withdrawal rejected`,
          withdrawal._id,
          'refund'
        );

        withdrawal.status = 'rejected';
        withdrawal.reviewedBy = req.user._id;
        withdrawal.reviewedAt = new Date();

        await logAction(req, 'withdrawal_reject', withdrawal.userId._id, { withdrawalId: withdrawal._id, reason: adminNote });

        await createNotification(
          withdrawal.userId._id,
          'system',
          'Withdrawal rejected',
          `Your withdrawal request of KES ${withdrawal.amount} has been rejected and the funds refunded. Reason: ${adminNote || 'No reason provided.'}`,
          '/account.html'
        );

      } else if (status === 'completed') {
        if (withdrawal.status !== 'approved') {
          return res.status(400).json({ error: 'Must be approved first' });
        }

        // Funds were ALREADY frozen at request time. Just mark completed. No balance check needed.
        withdrawal.status = 'completed';
        withdrawal.completedAt = new Date();

        await logAction(req, 'withdrawal_complete', withdrawal.userId._id, {
          withdrawalId: withdrawal._id,
          amount: withdrawal.amount,
          fee: withdrawal.fee,
          totalDebit: withdrawal.amount + withdrawal.fee,
          method: withdrawal.method
        });

        await createNotification(
          withdrawal.userId._id,
          'system',
          'Withdrawal completed',
          `Your withdrawal request of KES ${withdrawal.amount} has been completed. Funds have been sent to your ${withdrawal.method} account.`,
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