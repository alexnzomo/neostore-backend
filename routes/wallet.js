const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const WalletService = require('../services/walletService');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const WalletPIN = require('../models/WalletPIN');
const { protect } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Helper middleware to verify temp token (for PIN-protected operations)
const verifyTempToken = async (req, res, next) => {
  const tempToken = req.headers['x-temp-token'] || req.body.tempToken;
  if (!tempToken) {
    return res.status(401).json({ error: 'PIN verification required' });
  }
  try {
    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    if (decoded.userId !== req.user._id.toString() || decoded.purpose !== 'wallet-operation') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.tempTokenData = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'PIN session expired. Please verify PIN again.' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// ========== Balance & Transactions ==========

// Get balance
router.get('/balance', protect, async (req, res) => {
  try {
    const balance = await WalletService.getBalance(req.user._id);
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get transaction history
router.get('/transactions', protect, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const result = await WalletService.getTransactionHistory(req.user._id, limit, skip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single transaction
router.get('/transactions/:id', protect, async (req, res) => {
  try {
    const transaction = await WalletTransaction.findById(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    if (transaction.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    res.json(transaction);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PIN Management ==========

// Set or update wallet PIN
router.post('/pin/set', protect, [
  body('pin').isLength({ min: 4, max: 6 }).withMessage('PIN must be 4-6 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { pin } = req.body;
    const userId = req.user._id;
    const pinHash = await bcrypt.hash(pin, 10);
    
    await WalletPIN.findOneAndUpdate(
      { userId },
      { userId, pinHash, failedAttempts: 0, lockedUntil: null },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'PIN set successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify PIN – returns a temporary token valid for 1 minute
router.post('/pin/verify', protect, [
  body('pin').isLength({ min: 4, max: 6 }).withMessage('PIN must be 4-6 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { pin } = req.body;
    const userId = req.user._id;
    const pinRecord = await WalletPIN.findOne({ userId });
    if (!pinRecord) {
      return res.status(404).json({ error: 'PIN not set' });
    }
    if (pinRecord.lockedUntil && pinRecord.lockedUntil > new Date()) {
      return res.status(403).json({ error: 'PIN locked. Try again later.' });
    }
    const isValid = await pinRecord.comparePIN(pin);
    if (!isValid) {
      pinRecord.failedAttempts += 1;
      if (pinRecord.failedAttempts >= 5) {
        pinRecord.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // lock 15 minutes
      }
      await pinRecord.save();
      return res.status(401).json({ error: 'Invalid PIN' });
    }
    // Reset failed attempts on success
    pinRecord.failedAttempts = 0;
    pinRecord.lockedUntil = null;
    await pinRecord.save();

    // Generate a temporary token (valid for 1 minute) for this operation
    const tempToken = jwt.sign(
      { userId: userId.toString(), purpose: 'wallet-operation' },
      process.env.JWT_SECRET,
      { expiresIn: '1m' }
    );
    res.json({ success: true, tempToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Sensitive Operations (PIN-protected) ==========

// Transfer between users (requires PIN verification)
router.post('/transfer', protect, verifyTempToken, [
  body('receiverEmail').isEmail().withMessage('Valid receiver email required'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { receiverEmail, amount } = req.body;
    const senderId = req.user._id;

    const receiver = await User.findOne({ email: receiverEmail });
    if (!receiver) throw new Error('Receiver not found');

    const result = await WalletService.transfer(
      senderId,
      receiver._id,
      amount,
      `Transfer to ${receiver.fullName || receiver.email}`
    );

    res.json({
      success: true,
      senderBalance: result.senderBalance,
      receiverBalance: result.receiverBalance,
      transaction: result.debitTransaction
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pay from wallet (debit) – requires PIN verification
router.post('/pay', protect, verifyTempToken, [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES'),
  body('orderId').notEmpty().withMessage('Order ID required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, orderId } = req.body;
    const userId = req.user._id;

    const result = await WalletService.debit(
      userId,
      amount,
      `Payment for order #${orderId}`,
      orderId,
      'order'
    );

    // Optionally update order payment status to 'fully_paid' (you can do this in order route)
    // For now, return success
    res.json({ success: true, newBalance: result.newBalance, transaction: result.transaction });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Top up does not require PIN (it's adding money)
// ... (existing topup endpoint remains unchanged)

module.exports = router;