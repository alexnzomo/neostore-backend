const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

// Models
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const WalletPIN = require('../models/WalletPIN');
const TopUpRequest = require('../models/TopUpRequest');

// Services & Helpers
const WalletService = require('../services/walletService');
const { createNotification } = require('../utils/notifications');
const { sendEmail } = require('../utils/email');

// Middleware
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { requireKYC } = require('../middleware/kyc');

// Stripe (direct import)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// ========== In‑memory OTP store ==========
const otpStore = new Map();

// ========== Helper: M‑Pesa initiation (uses global function from server.js) ==========
async function initiateMpesaPayment(phoneNumber, amount, accountRef) {
  if (typeof global.initiateMpesaPayment === 'function') {
    return global.initiateMpesaPayment(phoneNumber, amount, accountRef);
  }
  throw new Error(
    'M-Pesa initiation function not available. Please attach it to `global.initiateMpesaPayment` in server.js.'
  );
}

// ========== Helper: PIN temporary token verification ==========
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

// ========== Balance ==========
router.get('/balance', protect, async (req, res) => {
  try {
    const balance = await WalletService.getBalance(req.user._id);
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Own transactions ==========
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

// ========== Single transaction (own only) ==========
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

// ========== Admin: view any user's transactions ==========
router.get('/transactions/:userId', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const transactions = await WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(transactions);
  } catch (err) {
    console.error('Error fetching user transactions:', err);
    res.status(500).json({ error: 'Failed to load transactions: ' + err.message });
  }
});

// ========== OWNER‑ONLY Manual Top‑up ==========
router.post('/topup', protect, allowRoles('owner'), [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES'),
  body('userId').notEmpty().withMessage('User ID required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, userId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await WalletService.credit(
      userId,
      amount,
      `Manual top‑up by owner ${req.user.fullName}`,
      null,
      'topup',
      { adminId: req.user._id }
    );

    await createNotification(
      userId,
      'system',
      'Wallet top‑up',
      `Your wallet has been credited with KES ${amount.toFixed(2)} by owner.`,
      '/account.html'
    );

    res.json({ success: true, newBalance: result.newBalance, transaction: result.transaction });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== Real Payment Top‑up Initiation (Stripe / M‑Pesa) ==========
router.post('/topup/initiate', protect, [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least 1 KES'),
  body('method').isIn(['stripe', 'mpesa']).withMessage('Invalid payment method')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { amount, method, phoneNumber } = req.body;
    const userId = req.user._id;

    if (method === 'stripe') {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // cents
        currency: 'kes',
        metadata: {
          userId: userId.toString(),
          type: 'wallet_topup',
          amount: amount.toString()
        }
      });
      return res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    if (method === 'mpesa') {
      if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number required for M‑Pesa' });
      }
      const mpesaResponse = await initiateMpesaPayment(
        phoneNumber,
        amount,
        `TOPUP-${userId.toString().slice(-6)}`
      );
      if (mpesaResponse.ResponseCode === '0') {
        const topUp = new TopUpRequest({
          userId,
          amount,
          merchantRequestId: mpesaResponse.MerchantRequestID,
          checkoutRequestId: mpesaResponse.CheckoutRequestID,
          status: 'pending'
        });
        await topUp.save();
        return res.json({
          success: true,
          merchantRequestId: mpesaResponse.MerchantRequestID,
          message: 'STK push sent. Complete payment on your phone.'
        });
      } else {
        return res.status(400).json({ error: 'Failed to initiate M‑Pesa payment' });
      }
    }

    return res.status(400).json({ error: 'Invalid payment method' });
  } catch (err) {
    console.error('Top‑up initiation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== Pay from wallet (for orders) ==========
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

// ========== Transfer between users ==========
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

// Request OTP
router.post('/pin/request-otp', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const email = req.user.email;

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    otpStore.set(userId.toString(), { otp, expiresAt });

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
  body('newPin').isLength({ min: 4, max: 6 }).withMessage('PIN must be 4‑6 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const userId = req.user._id;
    const { otp, newPin } = req.body;

    const stored = otpStore.get(userId.toString());
    if (!stored) return res.status(400).json({ error: 'No OTP request found. Please request a new code.' });
    if (Date.now() > stored.expiresAt) {
      otpStore.delete(userId.toString());
      return res.status(400).json({ error: 'OTP expired. Please request a new code.' });
    }
    if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP.' });

    const pinHash = await bcrypt.hash(newPin, 10);
    await WalletPIN.findOneAndUpdate(
      { userId },
      { userId, pinHash, failedAttempts: 0, lockedUntil: null },
      { upsert: true, new: true }
    );
    otpStore.delete(userId.toString());

    res.json({ success: true, message: 'PIN set successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Verify PIN (returns temporary token)
router.post('/pin/verify', protect, [
  body('pin').isLength({ min: 4, max: 6 }).withMessage('PIN must be 4‑6 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { pin } = req.body;
    const userId = req.user._id;
    const pinRecord = await WalletPIN.findOne({ userId });
    if (!pinRecord) return res.status(404).json({ error: 'PIN not set' });
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