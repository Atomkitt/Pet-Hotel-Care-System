// controllers/auth.controller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { JWT_SECRET, getClearCookieOptions } = require('../middleware/auth');
const { sendServerError } = require('../middleware/security');

const SALT_ROUNDS = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BCRYPT_BYTES = 72;

function getAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ONE_DAY_MS,
    path: '/'
  };
}

function signAuthToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      role: user.role,
      name: user.name,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
}

// POST /api/auth/register
async function register(req, res) {
  try {
    const { name, email, password, phone } = req.body || {};

    if (!name || !email || !password || !phone) {
      return res.status(400).json({
        error: 'Name, email, phone, and password are all required.'
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPhone = String(phone).trim();
    const rawPassword = String(password);

    if (!cleanName || cleanName.length > 100) {
      return res.status(400).json({ error: 'Name must be between 1 and 100 characters.' });
    }

    if (cleanEmail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address (max 100 chars).' });
    }

    if (!cleanPhone || cleanPhone.length > 20) {
      return res.status(400).json({ error: 'Phone number must be between 1 and 20 characters.' });
    }

    const passwordBytes = Buffer.byteLength(rawPassword, 'utf8');
    if (rawPassword.length < 8 || passwordBytes > MAX_BCRYPT_BYTES) {
      return res.status(400).json({
        error: 'Password must be between 8 and 72 characters long.'
      });
    }

    const [existing] = await pool.execute(
      'SELECT user_id FROM users WHERE email = ?',
      [cleanEmail]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(rawPassword, SALT_ROUNDS);

    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?)',
      [cleanName, cleanEmail, passwordHash, cleanPhone, 'User']
    );

    const newUser = {
      user_id: result.insertId,
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      role: 'User'
    };

    const token = signAuthToken(newUser);
    res.cookie('token', token, getAuthCookieOptions());

    return res.status(201).json({
      message: 'Account registered successfully.',
      user: newUser
    });
  } catch (err) {
    return sendServerError(res, 'auth.register Error', 'Failed to register user', err);
  }
}

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const rawPassword = String(password);

    if (Buffer.byteLength(rawPassword, 'utf8') > MAX_BCRYPT_BYTES) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const [rows] = await pool.execute(
      'SELECT user_id, name, email, password_hash, phone, role FROM users WHERE email = ?',
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(rawPassword, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const safeUser = {
      user_id: user.user_id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role
    };

    const token = signAuthToken(safeUser);
    res.cookie('token', token, getAuthCookieOptions());

    return res.json({
      message: 'Login successful.',
      user: safeUser
    });
  } catch (err) {
    return sendServerError(res, 'auth.login Error', 'Authentication failed', err);
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  res.clearCookie('token', getClearCookieOptions());
  return res.json({ message: 'Logged out successfully.' });
}

// GET /api/auth/me
async function getCurrentUser(req, res) {
  return res.json({ user: req.user });
}

module.exports = {
  register,
  login,
  logout,
  getCurrentUser
};
