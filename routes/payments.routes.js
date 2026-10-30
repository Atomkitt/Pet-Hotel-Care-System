// routes/payments.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');
const { handlePaymentSlipUpload } = require('../middleware/upload');

const slipUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment slip submissions. Please try again shortly.' }
});

router.use(authenticate);

router.post('/generate-qr', authorizeRoles('User', 'Admin', 'Developer'), paymentsController.generatePromptPayQR);
router.post('/confirm', authorizeRoles('User', 'Admin', 'Developer'), slipUploadLimiter, handlePaymentSlipUpload, paymentsController.confirmPayment);
router.get('/:booking_id/slip', authorizeRoles('User', 'Admin', 'Developer'), paymentsController.getPaymentSlip);

module.exports = router;
