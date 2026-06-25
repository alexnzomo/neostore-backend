// routes/verification.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Otp = require('../models/Otp');          // ✅ Must exist – create models/Otp.js
const { sendEmail } = require('../utils/email');

// ========== Helper: normalize email ==========
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// ========== Send OTP for registration ==========
router.post('/send-verification', async (req, res) => {
  const rawEmail = req.body.email;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required' });

  const email = normalizeEmail(rawEmail);
  console.log(`[send-verification] Received for ${email}`);

  // Check if email already registered
  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`[send-verification] Email already registered: ${email}`);
    return res.status(400).json({ error: 'Email already registered' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  // Delete any old OTPs for this email
  await Otp.deleteMany({ email });

  // Save new OTP
  await Otp.create({ email, otp, expiresAt });
  console.log(`[send-verification] OTP saved for ${email}: ${otp}, expires at ${expiresAt}`);

  try {
    await sendEmail({
      to: email,
      subject: 'Your Mwecheche Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    console.log(`[send-verification] Email sent to ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[send-verification] Email error:`, err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ========== Verify OTP for registration ==========
router.post('/verify-and-register', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  console.log(`[verify-and-register] Received for ${email} with code ${code}`);

  const otpDoc = await Otp.findOne({ email, otp: code });
  if (!otpDoc) {
    console.log(`[verify-and-register] OTP not found for ${email} with code ${code}`);
    return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
  }

  if (otpDoc.expiresAt < new Date()) {
    console.log(`[verify-and-register] OTP expired for ${email}`);
    await Otp.deleteOne({ _id: otpDoc._id });
    return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  }

  // Code is valid – delete it so it cannot be reused
  await Otp.deleteOne({ _id: otpDoc._id });
  console.log(`[verify-and-register] OTP verified for ${email}`);
  res.json({ success: true });
});

// ========== Generic OTP for applications ==========
router.post('/send-verification-generic', async (req, res) => {
  const rawEmail = req.body.email;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required' });

  const email = normalizeEmail(rawEmail);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await Otp.deleteMany({ email });
  await Otp.create({ email, otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Your Mwecheche Verification Code',
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

router.post('/verify-code', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  const otpDoc = await Otp.findOne({ email, otp: code });

  if (!otpDoc) {
    return res.status(400).json({ error: 'Invalid or expired code.' });
  }
  if (otpDoc.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: otpDoc._id });
    return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  }

  await Otp.deleteOne({ _id: otpDoc._id });
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
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await Otp.deleteMany({ email });
  await Otp.create({ email, otp, expiresAt });

  try {
    await sendEmail({
      to: email,
      subject: 'Reset Your Mwecheche Password',
      html: `<p>Your password reset code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

router.post('/verify-reset-code', async (req, res) => {
  const { email: rawEmail, code } = req.body;
  if (!rawEmail || !code) return res.status(400).json({ error: 'Email and code are required' });

  const email = normalizeEmail(rawEmail);
  const otpDoc = await Otp.findOne({ email, otp: code });

  if (!otpDoc) {
    return res.status(400).json({ error: 'Invalid or expired code.' });
  }
  if (otpDoc.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: otpDoc._id });
    return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  }

  await Otp.deleteOne({ _id: otpDoc._id });
  res.json({ success: true });
});

module.exports = router;