// routes/pets.routes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const petsController = require('../controllers/pets.controller');
const { authenticate, authorizeRoles } = require('../middleware/auth');
const { handlePetUploads } = require('../middleware/upload');

const petUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many file upload requests. Please try again shortly.' }
});

router.use(authenticate);

router.get('/', authorizeRoles('User', 'Admin', 'Developer'), petsController.getPets);
router.get('/:id/vaccine-card', authorizeRoles('User', 'Admin', 'Developer'), petsController.getPetVaccineCard);
router.post('/', authorizeRoles('User', 'Admin', 'Developer'), petUploadLimiter, handlePetUploads, petsController.createPet);
router.put('/:id', authorizeRoles('User', 'Admin', 'Developer'), petUploadLimiter, handlePetUploads, petsController.updatePet);
router.delete('/:id', authorizeRoles('User', 'Admin', 'Developer'), petsController.deletePet);

module.exports = router;
