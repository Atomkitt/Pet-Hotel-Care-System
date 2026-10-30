// routes/rooms.routes.js
const express = require('express');
const router = express.Router();
const roomsController = require('../controllers/rooms.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');

router.use(authenticate);

router.get('/', authorizeRoles('User', 'Admin', 'Developer'), roomsController.getAllRooms);
router.get('/available', authorizeRoles('User', 'Admin', 'Developer'), roomsController.getAvailableRooms);
router.put('/:id/status', authorizeRoles('Admin', 'Developer'), roomsController.updateRoomStatus);

module.exports = router;
