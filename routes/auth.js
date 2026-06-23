const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');

// ========== CSRF helper (attached to req by server.js) ==========
// We'll use req.setCsrfToken() which is added in server.js

const router = express.Router();

// ---------- Register ----------
router.post('/register', [
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { fullName, email, password, referralCode } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  let referredBy = null;
  if (referralCode) {
    const referrer = await User.findOne({ referralCode });
    if (referrer) referredBy = referrer._id;
  }

  const userId = await User.getNextUserId();
  const newUser = new User({ userId, fullName, email, password, referredBy });
  await newUser.save();

  const token = jwt.sign({ id: newUser._id, role: newUser.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  // ✅ Set CSRF token cookie
  const csrfToken = req.setCsrfToken();

  res.status(201).json({
    message: 'User registered successfully',
    user: { id: newUser._id, userId: newUser.userId, fullName, email, role: newUser.role },
    csrfToken   // optional – frontend can read it from cookie anyway
  });
});

// ---------- Login ----------
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.isSuspended) {
    return res.status(403).json({ error: 'Account suspended' });
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  // ✅ Set CSRF token cookie
  const csrfToken = req.setCsrfToken();

  res.json({
    message: 'Login successful',
    user: { id: user._id, userId: user.userId, fullName: user.fullName, email: user.email, role: user.role },
    csrfToken   // optional – frontend can read it from cookie
  });
});

// ---------- Logout ----------
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('csrfToken');
  res.json({ message: 'Logged out' });
});

// ---------- Get current user ----------
router.get('/me', protect, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;