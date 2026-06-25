// routes/verification.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { sendEmail } = require('../utils/email');

// In‑memory OTP store (use Redis in production)
const otpStore = new Map();

// ========== Send OTP for registration ==========
router.post('/send-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Check if email already registered
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  otpStore.set(email, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Your NeoStore Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ========== Verify OTP for registration ==========
router.post('/verify-and-register', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  const stored = otpStore.get(email);
  if (!stored) return res.status(400).json({ error: 'No code sent to this email' });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (stored.otp !== code) return res.status(400).json({ error: 'Invalid code' });

  otpStore.delete(email);
  res.json({ success: true });
});

// ========== Generic OTP for applications ==========
router.post('/send-verification-generic', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otpStore.set(email, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Your NeoStore Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.post('/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  const stored = otpStore.get(email);
  if (!stored) return res.status(400).json({ error: 'No code sent' });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (stored.otp !== code) return res.status(400).json({ error: 'Invalid code' });
  otpStore.delete(email);
  res.json({ success: true });
});

// ========== Password Reset ==========
router.post('/send-reset-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otpStore.set(`reset-${email}`, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Reset Your NeoStore Password',
      html: `<p>Your password reset code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email' });
  }
});

router.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

  const stored = otpStore.get(`reset-${email}`);
  if (!stored) return res.status(400).json({ error: 'No code sent' });
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(`reset-${email}`);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (stored.otp !== code) return res.status(400).json({ error: 'Invalid code' });
  otpStore.delete(`reset-${email}`);
  res.json({ success: true });
});

module.exports = router;