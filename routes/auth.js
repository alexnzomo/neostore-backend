// routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { body, validationResult } = require('express-validator');
const { protect } = require('../middleware/auth');
const { sanitizeBody } = require('../middleware/sanitize');
const { logAction } = require('../utils/audit');
const { sendWelcomeEmail } = require('../utils/email');

const router = express.Router();

// ========== Register ==========
router.post(
  '/register',
  sanitizeBody(['fullName', 'email']),
  [
    body('fullName').trim().notEmpty().withMessage('Full name required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    // ✅ Fixed: accepts null, undefined, or empty string as missing
    body('referralCode')
      .optional({ nullable: true, checkFalsy: true })
      .isAlphanumeric()
      .withMessage('Referral code must be alphanumeric'),
  ],
  async (req, res) => {
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
    await sendWelcomeEmail(newUser);

    const token = jwt.sign({ id: newUser._id, role: newUser.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const csrfToken = req.setCsrfToken();

    res.status(201).json({
      message: 'User registered successfully',
      user: { id: newUser._id, userId: newUser.userId, fullName, email, role: newUser.role },
      csrfToken,
    });
  }
);

// ========== Login ==========
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      await logAction(req, 'login_failed', null, { email, reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.isSuspended) {
      await logAction(req, 'login_failed', user._id, { reason: 'suspended' });
      return res.status(403).json({ error: 'Account suspended' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await logAction(req, 'login_failed', user._id, { reason: 'wrong_password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await logAction(req, 'login_success', user._id, { email: user.email });

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const csrfToken = req.setCsrfToken();

    res.json({
      message: 'Login successful',
      user: { id: user._id, userId: user.userId, fullName: user.fullName, email: user.email, role: user.role },
      csrfToken,
    });
  }
);

// ========== Logout ==========
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('csrfToken');
  res.json({ message: 'Logged out' });
});

// ========== Get current user ==========
router.get('/me', protect, async (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;