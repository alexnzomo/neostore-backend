const crypto = require('crypto');

/**
 * Generate a CSRF token and set it as a cookie (non‑httpOnly).
 * The frontend will read this cookie and send the token back
 * in the `X-CSRF-Token` header for state‑changing requests.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {string} The generated CSRF token
 */
function setCsrfToken(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('csrfToken', token, {
    httpOnly: false,          // ✅ Frontend must be able to read it
    secure: process.env.NODE_ENV === 'production', // ✅ Required when sameSite='none'
    sameSite: 'none',         // ✅ Cross‑domain (Netlify + Render)
    path: '/'
  });
  return token;
}

/**
 * Middleware to verify the CSRF token for all non‑GET requests.
 * Compares the token from the cookie against the token sent in the
 * `X-CSRF-Token` header (or `_csrf` body field).
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function verifyCsrfToken(req, res, next) {
  // Skip verification for safe methods (GET, HEAD, OPTIONS)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const tokenFromCookie = req.cookies.csrfToken;
  const tokenFromHeader = req.headers['x-csrf-token'] || req.body._csrf;

  if (!tokenFromCookie || !tokenFromHeader) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  if (tokenFromCookie !== tokenFromHeader) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  next();
}

module.exports = { setCsrfToken, verifyCsrfToken };