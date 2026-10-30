// routes/bookings.routes.js
const express = require('express');
const router = express.Router();
const bookingsController = require('../controllers/bookings.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');

router.use(authenticate);

router.get('/my', authorizeRoles('User', 'Admin', 'Developer'), bookingsController.getMyBookings);
router.get('/', authorizeRoles('Admin', 'Developer'), bookingsController.getAllBookings);
router.get('/:id/invoice-preview', authorizeRoles('Admin', 'Developer'), bookingsController.previewCheckoutInvoice);
router.post('/', authorizeRoles('User', 'Admin', 'Developer'), bookingsController.createBooking);
router.put('/:id/status', authorizeRoles('User', 'Admin', 'Developer'), bookingsController.updateBookingStatus);
router.delete('/:id', authorizeRoles('User', 'Admin', 'Developer'), bookingsController.deleteBooking);
router.post('/:id/checkout', authorizeRoles('Admin', 'Developer'), bookingsController.checkoutBooking);

module.exports = router;
