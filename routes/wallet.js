const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const WalletService = require('../services/walletService');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const WalletPIN = require('../models/WalletPIN');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { body, validationResult } = require('express-validator');
const { requireKYC } = require('../middleware/kyc');

// In-memory OTP store (expires after 5 minutes)
const otpStore = new Map();

// Helper to send email (import from server.js or use a shared utility)
const { sendEmail } = require('../utils/email'); // Assume you have a utils/email.js

const router = express.Router();

// ========== Helper middleware for PIN‑protected operations ==========
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

router.get('/balance', protect, async (req, res) => {
  try {
    const balance = await WalletService.getBalance(req.user._id);
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

router.get('/transactions/:userId', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;
    const result = await WalletService.getTransactionHistory(userId, limit, skip);
    res.json(result.transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/topup', protect, [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES'),
  body('paymentMethod').isIn(['stripe', 'mpesa']).withMessage('Invalid payment method')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, paymentMethod } = req.body;
    const userId = req.user._id;

    const result = await WalletService.credit(
      userId,
      amount,
      `Wallet top‑up via ${paymentMethod}`,
      null,
      'topup',
      { paymentMethod }
    );

    res.json({ success: true, newBalance: result.newBalance, transaction: result.transaction });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/pay', protect, requireKYC, verifyTempToken, [
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

    res.json({ success: true, newBalance: result.newBalance, transaction: result.transaction });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/transfer', protect, requireKYC, verifyTempToken, [
  body('receiverEmail').isEmail().withMessage('Valid receiver email required'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { receiverEmail, amount } = req.body;
    const senderId = req.user._id;
    const sender = req.user;

    const receiver = await User.findOne({ email: receiverEmail });
    if (!receiver) throw new Error('Receiver not found');

    const result = await WalletService.transfer(
      senderId,
      receiver._id,
      amount,
      `Transfer to ${receiver.fullName || receiver.email}`
    );

    // ===== ADD NOTIFICATIONS =====
    const { createNotification } = require('../utils/notifications');
    if (result.success) {
      await createNotification(
        senderId,
        'transfer',
        'Transfer sent',
        `You sent KES ${amount} to ${receiver.fullName || receiver.email}. New balance: KES ${result.senderBalance.toFixed(2)}`,
        '/account.html'
      );
      await createNotification(
        receiver._id,
        'transfer',
        'Transfer received',
        `You received KES ${amount} from ${sender.fullName || sender.email}. New balance: KES ${result.receiverBalance.toFixed(2)}`,
        '/account.html'
      );
    }
    // ===== END NOTIFICATIONS =====

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

// ========== PIN Management ==========

// Existing PIN set (without OTP – kept for backward compatibility, but we can deprecate)
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

// Request OTP for PIN change
router.post('/pin/request-otp', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const email = req.user.email;

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Store OTP in memory (could also store in DB or Redis)
    otpStore.set(userId.toString(), { otp, expiresAt });

    // Send email
    await sendEmail({
      to: email,
      subject: 'Wallet PIN Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });

    res.json({ success: true, message: 'OTP sent to your email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Verify OTP and set PIN
router.post('/pin/verify-otp', protect, [
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  body('newPin').isLength({ min: 4, max: 6 }).withMessage('PIN must be 4-6 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const userId = req.user._id;
    const { otp, newPin } = req.body;

    const stored = otpStore.get(userId.toString());
    if (!stored) {
      return res.status(400).json({ error: 'No OTP request found. Please request a new code.' });
    }
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(userId.toString());
      return res.status(400).json({ error: 'OTP expired. Please request a new code.' });
    }
    if (stored.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    // OTP is valid – set PIN
    const pinHash = await bcrypt.hash(newPin, 10);
    await WalletPIN.findOneAndUpdate(
      { userId },
      { userId, pinHash, failedAttempts: 0, lockedUntil: null },
      { upsert: true, new: true }
    );

    // Clear OTP
    otpStore.delete(userId.toString());

    res.json({ success: true, message: 'PIN set successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Verify PIN (existing)
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
        pinRecord.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      }
      await pinRecord.save();
      return res.status(401).json({ error: 'Invalid PIN' });
    }
    pinRecord.failedAttempts = 0;
    pinRecord.lockedUntil = null;
    await pinRecord.save();

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

module.exports = router;