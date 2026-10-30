// routes/dev.routes.js
const express = require('express');
const router = express.Router();
const devController = require('../controllers/dev.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');

router.use(authenticate);
router.use(authorizeRoles('Developer'));

router.get('/users', devController.getUsers);
router.put('/users/:id/role', devController.updateUserRole);
router.get('/dev/pool-status', devController.getPoolStatus);
router.post('/dev/execute-test', devController.executeRoutineTest);

module.exports = router;
