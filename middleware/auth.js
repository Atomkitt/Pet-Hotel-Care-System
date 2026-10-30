// middleware/auth.js
require('dotenv').config({ quiet: true });
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendServerError } = require('./security');

const VALID_ROLES = ['User', 'Admin', 'Developer'];
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.trim().length < 32) {
  throw new Error(
    '[Security Fatal]: JWT_SECRET environment variable must be configured and at least 32 characters long.'
  );
}

function getClearCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  };
}

/**
 * Production JWT Cookie Authentication Middleware.
 * Extracts and verifies `req.cookies.token` (HttpOnly JWT) and syncs the
 * active user profile & RBAC role against MySQL using parameterized `?` queries.
 */
async function authenticate(req, res, next) {
  try {
    const token = req.cookies && req.cookies.token;

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized: Please log in to access this resource.'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      res.clearCookie('token', getClearCookieOptions());
      return res.status(401).json({
        error: 'Unauthorized: Session expired or invalid token. Please log in again.'
      });
    }

    if (!decoded || !decoded.user_id) {
      res.clearCookie('token', getClearCookieOptions());
      return res.status(401).json({
        error: 'Unauthorized: Malformed token payload.'
      });
    }

    const [rows] = await pool.execute(
      'SELECT user_id, name, email, phone, role FROM users WHERE user_id = ?',
      [Number(decoded.user_id)]
    );

    if (rows.length === 0) {
      res.clearCookie('token', getClearCookieOptions());
      return res.status(401).json({
        error: 'Unauthorized: Account no longer exists.'
      });
    }

    req.user = rows[0];
    return next();
  } catch (err) {
    return sendServerError(res, 'RBAC Middleware Error', 'Authentication verification failed', err);
  }
}

/**
 * Enforces strict 3-tier Role-Based Access Control (User, Admin, Developer).
 */
function authorizeRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized: Authentication required.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Forbidden: Insufficient role privileges',
        currentRole: req.user.role,
        requiredRoles: allowedRoles
      });
    }

    return next();
  };
}

module.exports = {
  authenticate,
  authorizeRoles,
  VALID_ROLES,
  JWT_SECRET,
  getClearCookieOptions
};
