// routes/auth.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

// Strict brute-force rate limiter specifically for credential submission endpoints
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 login/register attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts from this IP. Please try again after 15 minutes.'
  }
});

router.post('/register', credentialLimiter, authController.register);
router.post('/login', credentialLimiter, authController.login);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;
