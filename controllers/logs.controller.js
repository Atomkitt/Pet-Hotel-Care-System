// controllers/logs.controller.js
const pool = require('../db');
const { emitEvent } = require('../socket');
const { sendServerError } = require('../middleware/security');

const VALID_ACTIVITIES = ['Meal', 'Potty', 'Walk', 'Medication', 'General'];

// POST /api/logs
async function createLog(req, res) {
  try {
    const { booking_id, pet_id, activity_type, details } = req.body || {};

    const bookingId = Number(booking_id);
    if (Number.isNaN(bookingId) || bookingId <= 0 || !activity_type || !details || !String(details).trim()) {
      return res.status(400).json({
        error: 'booking_id, activity_type, and non-empty details are required.'
      });
    }

    if (!VALID_ACTIVITIES.includes(activity_type)) {
      return res.status(400).json({
        error: 'Invalid activity_type. Must be Meal, Potty, Walk, Medication, or General.'
      });
    }

    const [bookingRows] = await pool.execute(
      'SELECT booking_id, user_id, room_id, booking_status FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (bookingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = bookingRows[0];
    if (booking.booking_status !== 'Confirmed') {
      return res.status(400).json({
        error: `Daily care logs can only be recorded for active Checked-In ('Confirmed') stays (current status: '${booking.booking_status}').`
      });
    }

    let resolvedPetId = null;
    if (pet_id !== undefined && pet_id !== null && String(pet_id).trim() !== '') {
      const requestedPetId = Number(pet_id);
      if (Number.isNaN(requestedPetId) || requestedPetId <= 0) {
        return res.status(400).json({ error: 'Invalid pet_id specified.' });
      }

      // Enforce relational integrity: verify the specified pet actually belongs to this booking
      const [membership] = await pool.execute(
        'SELECT pet_id FROM booking_pets WHERE booking_id = ? AND pet_id = ?',
        [bookingId, requestedPetId]
      );

      if (membership.length === 0) {
        return res.status(400).json({
          error: 'Selected pet is not registered under this booking.'
        });
      }
      resolvedPetId = requestedPetId;
    } else {
      const [bpRows] = await pool.execute(
        'SELECT pet_id FROM booking_pets WHERE booking_id = ? ORDER BY booking_pet_id ASC LIMIT 1',
        [bookingId]
      );

      if (bpRows.length === 0) {
        return res.status(400).json({ error: 'No pets are linked to this booking.' });
      }
      resolvedPetId = bpRows[0].pet_id;
    }

    const cleanDetails = String(details).trim().slice(0, 255);

    const [result] = await pool.execute(
      'INSERT INTO daily_logs (booking_id, pet_id, activity_type, details) VALUES (?, ?, ?, ?)',
      [bookingId, resolvedPetId, activity_type, cleanDetails]
    );

    const [createdRows] = await pool.execute(
      'SELECT dl.log_id, dl.booking_id, dl.pet_id, p.name AS pet_name, dl.log_time, dl.activity_type, dl.details FROM daily_logs dl JOIN pets p ON dl.pet_id = p.pet_id WHERE dl.log_id = ?',
      [result.insertId]
    );

    const newLog = createdRows[0];

    // Emit real-time care log update strictly to the pet owner, staff, and authorized booking channel
    emitEvent(
      'log:added',
      {
        action: 'created',
        booking_id: bookingId,
        room_id: booking.room_id,
        user_id: booking.user_id,
        log: newLog
      },
      [`user:${booking.user_id}`, 'role:Admin', 'role:Developer', `booking:${bookingId}`]
    );

    return res.status(201).json({
      message: 'Daily care log recorded successfully.',
      log: newLog
    });
  } catch (err) {
    return sendServerError(res, 'logs.createLog Error', 'Failed to create daily care log', err);
  }
}

// GET /api/logs/:booking_id
async function getLogsByBooking(req, res) {
  try {
    const bookingId = Number(req.params.booking_id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Invalid booking_id.' });
    }

    const [bookingRows] = await pool.execute(
      'SELECT booking_id, user_id FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (bookingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    if (req.user.role === 'User' && bookingRows[0].user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden: You can only view care logs for your own stays.' });
    }

    const [rows] = await pool.execute(
      'SELECT dl.log_id, dl.booking_id, dl.pet_id, p.name AS pet_name, dl.log_time, dl.activity_type, dl.details FROM daily_logs dl JOIN pets p ON dl.pet_id = p.pet_id WHERE dl.booking_id = ? ORDER BY dl.log_time DESC, dl.log_id DESC',
      [bookingId]
    );

    return res.json(rows);
  } catch (err) {
    return sendServerError(res, 'logs.getLogsByBooking Error', 'Failed to retrieve daily logs', err);
  }
}

// DELETE /api/logs/:id
async function deleteLog(req, res) {
  try {
    const logId = Number(req.params.id);
    if (Number.isNaN(logId) || logId <= 0) {
      return res.status(400).json({ error: 'Invalid log ID.' });
    }

    const [existingRows] = await pool.execute(
      'SELECT dl.log_id, dl.booking_id, b.user_id, b.room_id FROM daily_logs dl JOIN bookings b ON dl.booking_id = b.booking_id WHERE dl.log_id = ?',
      [logId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Care log entry not found.' });
    }

    const target = existingRows[0];

    await pool.execute(
      'DELETE FROM daily_logs WHERE log_id = ?',
      [logId]
    );

    emitEvent(
      'log:added',
      {
        action: 'deleted',
        log_id: logId,
        booking_id: target.booking_id,
        room_id: target.room_id,
        user_id: target.user_id
      },
      [`user:${target.user_id}`, 'role:Admin', 'role:Developer', `booking:${target.booking_id}`]
    );

    return res.json({ message: 'Daily care log deleted successfully.' });
  } catch (err) {
    return sendServerError(res, 'logs.deleteLog Error', 'Failed to delete daily log', err);
  }
}

module.exports = {
  createLog,
  getLogsByBooking,
  deleteLog
};
