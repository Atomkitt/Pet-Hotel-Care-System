// controllers/pets.controller.js
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const {
  PRIVATE_VACCINE_DIR,
  removeUploadedFile,
  removePrivateVaccineFile
} = require('../middleware/upload');
const { sendServerError } = require('../middleware/security');

const VALID_SPECIES = ['Dog', 'Cat'];
const VALID_BEHAVIORS = ['Friendly', 'Aggressive', 'Anxious', 'High-Energy'];

function formatPetForClient(row) {
  if (!row) return row;
  return {
    ...row,
    vaccine_card_url: row.vaccine_card_url ? `/api/pets/${row.pet_id}/vaccine-card` : null
  };
}

function cleanupRequestFiles(req) {
  if (!req.files) return;
  if (req.files.photo && req.files.photo[0]) {
    removeUploadedFile(`/uploads/${req.files.photo[0].filename}`);
  }
  if (req.files.vaccine_card && req.files.vaccine_card[0]) {
    removePrivateVaccineFile(req.files.vaccine_card[0].filename);
  }
}

// GET /api/pets
async function getPets(req, res) {
  try {
    if ((req.user.role === 'Admin' || req.user.role === 'Developer') && req.query.all === 'true') {
      const [rows] = await pool.execute(
        'SELECT p.*, u.name AS owner_name FROM pets p JOIN users u ON p.user_id = u.user_id ORDER BY p.pet_id ASC'
      );
      return res.json(rows.map(formatPetForClient));
    }

    const [rows] = await pool.execute(
      'SELECT pet_id, user_id, name, species, breed, weight_kg, behavior_status, medical_notes, photo_url, vaccine_card_url FROM pets WHERE user_id = ? ORDER BY pet_id ASC',
      [req.user.user_id]
    );
    return res.json(rows.map(formatPetForClient));
  } catch (err) {
    return sendServerError(res, 'pets.getPets Error', 'Failed to retrieve pets', err);
  }
}

// GET /api/pets/:id/vaccine-card (Authenticated & Ownership/RBAC-Protected Document Stream)
async function getPetVaccineCard(req, res) {
  try {
    const petId = Number(req.params.id);
    if (Number.isNaN(petId) || petId <= 0) {
      return res.status(400).json({ error: 'Invalid pet ID.' });
    }

    const [rows] = await pool.execute(
      'SELECT pet_id, user_id, vaccine_card_url FROM pets WHERE pet_id = ?',
      [petId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pet not found.' });
    }

    const pet = rows[0];
    if (req.user.role === 'User' && pet.user_id !== req.user.user_id) {
      return res.status(403).json({
        error: 'Forbidden: You do not have permission to view this vaccine certificate.'
      });
    }

    if (!pet.vaccine_card_url) {
      return res.status(404).json({ error: 'No vaccine certificate uploaded for this pet.' });
    }

    const safeFilename = path.basename(String(pet.vaccine_card_url));
    const filePath = path.join(PRIVATE_VACCINE_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vaccine certificate file not found on server.' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(filePath);
  } catch (err) {
    return sendServerError(res, 'pets.getPetVaccineCard Error', 'Failed to retrieve vaccine certificate', err);
  }
}

// POST /api/pets
async function createPet(req, res) {
  try {
    const {
      name,
      species = 'Dog',
      breed = '',
      weight_kg,
      behavior_status = 'Friendly',
      medical_notes = ''
    } = req.body || {};

    const cleanName = name ? String(name).trim() : '';
    const cleanBreed = breed ? String(breed).trim() : '';
    const cleanNotes = medical_notes ? String(medical_notes).trim() : '';

    if (!cleanName || cleanName.length > 50 || weight_kg === undefined || weight_kg === null || Number.isNaN(Number(weight_kg))) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Pet name (1-50 chars) and valid weight_kg are required.' });
    }

    if (cleanBreed.length > 50 || cleanNotes.length > 2000) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Breed must be <= 50 chars and medical_notes <= 2000 chars.' });
    }

    const numericWeight = Number(weight_kg);
    if (numericWeight <= 0 || numericWeight > 999.99) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'weight_kg must be between 0.01 and 999.99 kg.' });
    }

    if (!VALID_SPECIES.includes(species)) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Invalid species. Must be Dog or Cat.' });
    }

    if (!VALID_BEHAVIORS.includes(behavior_status)) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Invalid behavior_status value.' });
    }

    let targetUserId = req.user.user_id;
    if ((req.user.role === 'Admin' || req.user.role === 'Developer') && req.body && req.body.user_id !== undefined) {
      const requestedOwnerId = Number(req.body.user_id);
      if (Number.isNaN(requestedOwnerId) || requestedOwnerId <= 0) {
        cleanupRequestFiles(req);
        return res.status(400).json({ error: 'Invalid user_id specified.' });
      }
      const [ownerRows] = await pool.execute('SELECT user_id FROM users WHERE user_id = ?', [requestedOwnerId]);
      if (ownerRows.length === 0) {
        cleanupRequestFiles(req);
        return res.status(404).json({ error: 'Specified pet owner user_id does not exist.' });
      }
      targetUserId = requestedOwnerId;
    }

    const photoUrl = req.files && req.files.photo && req.files.photo[0]
      ? `/uploads/${req.files.photo[0].filename}`
      : null;

    const vaccineFilename = req.files && req.files.vaccine_card && req.files.vaccine_card[0]
      ? req.files.vaccine_card[0].filename
      : null;

    const [result] = await pool.execute(
      'INSERT INTO pets (user_id, name, species, breed, weight_kg, behavior_status, medical_notes, photo_url, vaccine_card_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        targetUserId,
        cleanName,
        species,
        cleanBreed || null,
        numericWeight,
        behavior_status,
        cleanNotes || null,
        photoUrl,
        vaccineFilename
      ]
    );

    const [createdRows] = await pool.execute(
      'SELECT pet_id, user_id, name, species, breed, weight_kg, behavior_status, medical_notes, photo_url, vaccine_card_url FROM pets WHERE pet_id = ?',
      [result.insertId]
    );

    return res.status(201).json({
      message: 'Pet profile created successfully',
      pet: formatPetForClient(createdRows[0])
    });
  } catch (err) {
    cleanupRequestFiles(req);
    return sendServerError(res, 'pets.createPet Error', 'Failed to create pet profile', err);
  }
}

// PUT /api/pets/:id
async function updatePet(req, res) {
  try {
    const petId = Number(req.params.id);
    if (Number.isNaN(petId) || petId <= 0) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Invalid pet ID.' });
    }

    const [existingRows] = await pool.execute(
      'SELECT * FROM pets WHERE pet_id = ?',
      [petId]
    );

    if (existingRows.length === 0) {
      cleanupRequestFiles(req);
      return res.status(404).json({ error: 'Pet not found.' });
    }

    const existing = existingRows[0];
    if (req.user.role === 'User' && existing.user_id !== req.user.user_id) {
      cleanupRequestFiles(req);
      return res.status(403).json({ error: 'Forbidden: You can only update your own pets.' });
    }

    const body = req.body || {};
    const updatedName = body.name !== undefined ? String(body.name).trim() : existing.name;
    const updatedSpecies = body.species !== undefined ? body.species : existing.species;
    const updatedBreed = body.breed !== undefined ? (body.breed ? String(body.breed).trim() : null) : existing.breed;
    const updatedWeight = body.weight_kg !== undefined ? Number(body.weight_kg) : Number(existing.weight_kg);
    const updatedBehavior = body.behavior_status !== undefined ? body.behavior_status : existing.behavior_status;
    const updatedNotes = body.medical_notes !== undefined
      ? (body.medical_notes ? String(body.medical_notes).trim() : null)
      : existing.medical_notes;

    if (!updatedName || updatedName.length > 50 || Number.isNaN(updatedWeight) || updatedWeight <= 0 || updatedWeight > 999.99) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Valid name (1-50 chars) and weight_kg (0.01-999.99) are required.' });
    }

    if ((updatedBreed && updatedBreed.length > 50) || (updatedNotes && updatedNotes.length > 2000)) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Breed must be <= 50 chars and medical_notes <= 2000 chars.' });
    }

    if (!VALID_SPECIES.includes(updatedSpecies) || !VALID_BEHAVIORS.includes(updatedBehavior)) {
      cleanupRequestFiles(req);
      return res.status(400).json({ error: 'Invalid species or behavior_status.' });
    }

    const newPhotoFile = req.files && req.files.photo && req.files.photo[0];
    const newVaccineFile = req.files && req.files.vaccine_card && req.files.vaccine_card[0];

    const updatedPhotoUrl = newPhotoFile ? `/uploads/${newPhotoFile.filename}` : existing.photo_url;
    const updatedVaccineRef = newVaccineFile ? newVaccineFile.filename : existing.vaccine_card_url;

    await pool.execute(
      'UPDATE pets SET name = ?, species = ?, breed = ?, weight_kg = ?, behavior_status = ?, medical_notes = ?, photo_url = ?, vaccine_card_url = ? WHERE pet_id = ?',
      [
        updatedName,
        updatedSpecies,
        updatedBreed,
        updatedWeight,
        updatedBehavior,
        updatedNotes,
        updatedPhotoUrl,
        updatedVaccineRef,
        petId
      ]
    );

    if (newPhotoFile && existing.photo_url) {
      removeUploadedFile(existing.photo_url);
    }
    if (newVaccineFile && existing.vaccine_card_url) {
      removePrivateVaccineFile(existing.vaccine_card_url);
    }

    const [updatedRows] = await pool.execute(
      'SELECT pet_id, user_id, name, species, breed, weight_kg, behavior_status, medical_notes, photo_url, vaccine_card_url FROM pets WHERE pet_id = ?',
      [petId]
    );

    return res.json({
      message: 'Pet profile updated successfully',
      pet: formatPetForClient(updatedRows[0])
    });
  } catch (err) {
    cleanupRequestFiles(req);
    return sendServerError(res, 'pets.updatePet Error', 'Failed to update pet profile', err);
  }
}

// DELETE /api/pets/:id
async function deletePet(req, res) {
  try {
    const petId = Number(req.params.id);
    if (Number.isNaN(petId) || petId <= 0) {
      return res.status(400).json({ error: 'Invalid pet ID.' });
    }

    const [existingRows] = await pool.execute(
      'SELECT * FROM pets WHERE pet_id = ?',
      [petId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Pet not found.' });
    }

    if (req.user.role === 'User' && existingRows[0].user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden: You can only delete your own pets.' });
    }

    await pool.execute(
      'DELETE FROM pets WHERE pet_id = ?',
      [petId]
    );

    removeUploadedFile(existingRows[0].photo_url);
    removePrivateVaccineFile(existingRows[0].vaccine_card_url);

    return res.json({ message: 'Pet profile deleted successfully.' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
      return res.status(409).json({
        error: 'Cannot delete pet because it is referenced by existing bookings or daily care logs (ON DELETE RESTRICT).'
      });
    }
    return sendServerError(res, 'pets.deletePet Error', 'Failed to delete pet profile', err);
  }
}

module.exports = {
  getPets,
  getPetVaccineCard,
  createPet,
  updatePet,
  deletePet
};
