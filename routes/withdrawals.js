const express = require('express');
const Withdrawal = require('../models/Withdrawal');
const WalletService = require('../services/walletService');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// ========== User endpoints ==========

// Request a withdrawal
router.post('/', protect, async (req, res) => {
  const { amount, method, bankDetails, mpesaNumber } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  if (!method) return res.status(400).json({ error: 'Method required' });

  // Check if user has sufficient balance
  const balance = await WalletService.getBalance(req.user._id);
  if (balance < amount) return res.status(400).json({ error: 'Insufficient wallet balance' });

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
  res.status(201).json(withdrawal);
});

// Get user's own withdrawal history
router.get('/my', protect, async (req, res) => {
  const withdrawals = await Withdrawal.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(withdrawals);
});

// ========== Admin endpoints ==========

// Get all pending withdrawals
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const withdrawals = await Withdrawal.find({ status: 'pending' })
    .populate('userId', 'fullName email')
    .sort({ createdAt: 1 });
  res.json(withdrawals);
});

// Get all withdrawals (with filter)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { status } = req.query;
  const filter = status ? { status } : {};
  const withdrawals = await Withdrawal.find(filter)
    .populate('userId', 'fullName email')
    .sort({ createdAt: -1 });
  res.json(withdrawals);
});

// Admin: approve, reject, or complete a withdrawal
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { status, adminNote } = req.body;
  const withdrawal = await Withdrawal.findById(req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Not found' });

  // Status transition logic
  if (status === 'approved') {
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Only pending can be approved' });
    withdrawal.status = 'approved';
    withdrawal.reviewedBy = req.user._id;
    withdrawal.reviewedAt = new Date();
  } else if (status === 'rejected') {
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Only pending can be rejected' });
    withdrawal.status = 'rejected';
    withdrawal.reviewedBy = req.user._id;
    withdrawal.reviewedAt = new Date();
  } else if (status === 'completed') {
    if (withdrawal.status !== 'approved') return res.status(400).json({ error: 'Must be approved first' });
    // Deduct from wallet
    const balance = await WalletService.getBalance(withdrawal.userId);
    if (balance < withdrawal.amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    await WalletService.debit(
      withdrawal.userId,
      withdrawal.amount,
      `Withdrawal via ${withdrawal.method}`,
      withdrawal._id,
      'withdrawal'
    );
    withdrawal.status = 'completed';
    withdrawal.completedAt = new Date();
  } else {
    return res.status(400).json({ error: 'Invalid status' });
  }

  if (adminNote) withdrawal.adminNote = adminNote;
  await withdrawal.save();
  res.json(withdrawal);
});

module.exports = router;