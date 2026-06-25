// routes/verification.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { sendEmail } = require('../utils/email');

// In‑memory OTP store (use Redis in production)
const otpStore = new Map();

// ========== Helper: normalize email ==========
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// ========== Send OTP for registration ==========
router.post('/send-verification', async (req, res) => {
  const rawEmail = req.body.email;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required' });

  const email = normalizeEmail(rawEmail);

  // Check if email already registered
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  otpStore.set(email, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Your Mwecheche Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ========== Verify OTP for registration ==========
router.post('/verify-and-register', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  const stored = otpStore.get(email);

  if (!stored) {
    return res.status(400).json({ error: 'No code sent to this email. Please request a new code.' });
  }
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (stored.otp !== code) {
    return res.status(400).json({ error: 'Invalid code. Please try again.' });
  }

  otpStore.delete(email);
  res.json({ success: true });
});

// ========== Generic OTP for applications ==========
router.post('/send-verification-generic', async (req, res) => {
  const rawEmail = req.body.email;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required' });

  const email = normalizeEmail(rawEmail);

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otpStore.set(email, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Your Mwecheche Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

router.post('/verify-code', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  const stored = otpStore.get(email);

  if (!stored) {
    return res.status(400).json({ error: 'No code sent. Please request a new code.' });
  }
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (stored.otp !== code) {
    return res.status(400).json({ error: 'Invalid code. Please try again.' });
  }

  otpStore.delete(email);
  res.json({ success: true });
});

// ========== Password Reset ==========
router.post('/send-reset-code', async (req, res) => {
  const rawEmail = req.body.email;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required' });

  const email = normalizeEmail(rawEmail);
  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otpStore.set(`reset-${email}`, { otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Reset Your Mwecheche Password',
      html: `<p>Your password reset code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

router.post('/verify-reset-code', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  const stored = otpStore.get(`reset-${email}`);

  if (!stored) {
    return res.status(400).json({ error: 'No code sent. Please request a new code.' });
  }
  if (Date.now() > stored.expiresAt) {
    otpStore.delete(`reset-${email}`);
    return res.status(400).json({ error: 'Code expired. Please request a new code.' });
  }
  if (stored.otp !== code) {
    return res.status(400).json({ error: 'Invalid code. Please try again.' });
  }

  otpStore.delete(`reset-${email}`);
  res.json({ success: true });
});

module.exports = router;