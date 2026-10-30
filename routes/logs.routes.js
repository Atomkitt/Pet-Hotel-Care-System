// routes/logs.routes.js
const express = require('express');
const router = express.Router();
const logsController = require('../controllers/logs.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');

router.use(authenticate);

router.post('/', authorizeRoles('Admin', 'Developer'), logsController.createLog);
router.get('/:booking_id', authorizeRoles('User', 'Admin', 'Developer'), logsController.getLogsByBooking);
router.delete('/:id', authorizeRoles('Admin', 'Developer'), logsController.deleteLog);

module.exports = router;
