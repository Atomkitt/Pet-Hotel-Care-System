// controllers/rooms.controller.js
const pool = require('../db');
const { emitEvent } = require('../socket');
const { sendServerError, parseBookingDateRange } = require('../middleware/security');

const VALID_ROOM_STATUSES = ['Available', 'Occupied', 'Maintenance'];

// GET /api/rooms
async function getAllRooms(req, res) {
  try {
    const [rooms] = await pool.execute(
      'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms ORDER BY room_number ASC'
    );

    const isStaffOrDev = req.user.role === 'Admin' || req.user.role === 'Developer';

    // Privacy guard: Only expose active guest / pet / vaccine details to Staff (Admin) and Developers
    if (!isStaffOrDev) {
      return res.json(
        rooms.map((room) => ({
          ...room,
          active_stay: null
        }))
      );
    }

    // Prioritize stays actively covering NOW() before upcoming Confirmed reservations
    const [activeStays] = await pool.execute(
      `SELECT b.booking_id, b.room_id, b.check_in_date, b.check_out_date, b.booking_status,
              u.name AS owner_name, p.pet_id, p.name AS pet_name, p.species, p.breed,
              p.weight_kg, p.behavior_status, p.photo_url, p.vaccine_card_url
       FROM bookings b
       JOIN users u ON b.user_id = u.user_id
       JOIN booking_pets bp ON b.booking_id = bp.booking_id
       JOIN pets p ON bp.pet_id = p.pet_id
       WHERE b.booking_status = ?
       ORDER BY (CASE WHEN NOW() BETWEEN b.check_in_date AND b.check_out_date THEN 0 ELSE 1 END) ASC,
                b.check_in_date ASC, bp.booking_pet_id ASC`,
      ['Confirmed']
    );

    const stayByRoom = new Map();
    for (const row of activeStays) {
      if (!stayByRoom.has(row.room_id)) {
        stayByRoom.set(row.room_id, {
          booking_id: row.booking_id,
          check_in_date: row.check_in_date,
          check_out_date: row.check_out_date,
          owner_name: row.owner_name,
          pets: [],
          has_aggressive_pet: false
        });
      }
      const entry = stayByRoom.get(row.room_id);
      if (entry.booking_id === row.booking_id) {
        entry.pets.push({
          pet_id: row.pet_id,
          name: row.pet_name,
          species: row.species,
          breed: row.breed,
          weight_kg: row.weight_kg,
          behavior_status: row.behavior_status,
          photo_url: row.photo_url,
          vaccine_card_url: row.vaccine_card_url ? `/api/pets/${row.pet_id}/vaccine-card` : null
        });
        if (row.behavior_status === 'Aggressive') {
          entry.has_aggressive_pet = true;
        }
      }
    }

    const enriched = rooms.map((room) => ({
      ...room,
      active_stay: stayByRoom.get(room.room_id) || null
    }));

    return res.json(enriched);
  } catch (err) {
    return sendServerError(res, 'rooms.getAllRooms Error', 'Failed to retrieve rooms', err);
  }
}

// GET /api/rooms/available
async function getAvailableRooms(req, res) {
  try {
    const { check_in, check_out } = req.query;

    if (check_in && check_out) {
      const parsedRange = parseBookingDateRange(check_in, check_out, { rejectPast: false });
      if (!parsedRange.ok) {
        return res.status(400).json({ error: parsedRange.error });
      }

      const [rows] = await pool.execute(
        'SELECT r.room_id, r.room_number, r.room_type, r.max_capacity, r.base_price_per_night, r.status FROM rooms r WHERE r.status != ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.room_id = r.room_id AND b.booking_status IN (?, ?) AND b.check_in_date < ? AND b.check_out_date > ?) ORDER BY r.room_number ASC',
        ['Maintenance', 'Pending', 'Confirmed', parsedRange.checkOutDt, parsedRange.checkInDt]
      );

      return res.json(rows);
    }

    const [rows] = await pool.execute(
      'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms WHERE status = ? ORDER BY room_number ASC',
      ['Available']
    );

    return res.json(rows);
  } catch (err) {
    return sendServerError(res, 'rooms.getAvailableRooms Error', 'Failed to retrieve available rooms', err);
  }
}

// PUT /api/rooms/:id/status
async function updateRoomStatus(req, res) {
  const roomId = Number(req.params.id);
  const { status } = req.body || {};

  if (Number.isNaN(roomId) || roomId <= 0 || !VALID_ROOM_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Valid room ID and status (Available, Occupied, Maintenance) are required.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [roomRows] = await conn.execute(
      'SELECT room_id, room_number, status FROM rooms WHERE room_id = ? FOR UPDATE',
      [roomId]
    );

    if (roomRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Room not found.' });
    }

    // Prevent overriding a room that currently holds an active Checked-In stay
    if (status !== 'Occupied') {
      const [activeConfirmed] = await conn.execute(
        'SELECT booking_id FROM bookings WHERE room_id = ? AND booking_status = ? LIMIT 1 FOR UPDATE',
        [roomId, 'Confirmed']
      );
      if (activeConfirmed.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          error: `Cannot set Room #${roomRows[0].room_number} to '${status}' while Booking #${activeConfirmed[0].booking_id} is Checked-In. Please checkout or cancel the stay first.`
        });
      }
    }

    await conn.execute(
      'UPDATE rooms SET status = ? WHERE room_id = ?',
      [status, roomId]
    );

    await conn.commit();

    emitEvent('room:status_changed', {
      reason: 'manual_room_status',
      room_id: roomId,
      status
    });

    return res.json({ message: `Room status updated to ${status}.`, room_id: roomId, status });
  } catch (err) {
    await conn.rollback();
    return sendServerError(res, 'rooms.updateRoomStatus Error', 'Failed to update room status', err);
  } finally {
    conn.release();
  }
}

module.exports = {
  getAllRooms,
  getAvailableRooms,
  updateRoomStatus
};
