const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.protect = async (req, res, next) => {
  // ✅ Only accept token from httpOnly cookie
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authorized, no token' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    // ✅ Suspension check
    if (user.isSuspended) {
      return res.status(403).json({ error: 'Account suspended' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};