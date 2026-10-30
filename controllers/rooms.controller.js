// controllers/rooms.controller.js
const pool = require('../db');
const { emitEvent } = require('../socket');
const { sendServerError, parseBookingDateRange, computePeakConcurrentPets } = require('../middleware/security');

const VALID_ROOM_STATUSES = ['Available', 'Occupied', 'Maintenance'];

// GET /api/rooms
async function getAllRooms(req, res) {
  try {
    const [rooms] = await pool.execute(
      'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms ORDER BY room_number ASC'
    );

    const isStaffOrDev = req.user.role === 'Admin' || req.user.role === 'Developer';

    // Privacy guard: Customers never see other guests' names, pets, or vaccine details.
    // We only compute the requesting customer's OWN booked pet count per room (if check_in & check_out provided).
    if (!isStaffOrDev) {
      const myPetsByRoom = new Map();
      const { check_in, check_out } = req.query || {};
      if (check_in && check_out) {
        const parsed = parseBookingDateRange(check_in, check_out, { rejectPast: false });
        if (parsed.ok) {
          const [myStays] = await pool.execute(
            `SELECT b.booking_id, b.room_id, b.check_in_date, b.check_out_date,
                    COUNT(bp.pet_id) AS pet_count
             FROM bookings b
             LEFT JOIN booking_pets bp ON b.booking_id = bp.booking_id
             WHERE b.user_id = ?
               AND b.booking_status IN (?, ?)
               AND b.check_in_date < ?
               AND b.check_out_date > ?
             GROUP BY b.booking_id`,
            [req.user.user_id, 'Pending', 'Confirmed', parsed.checkOutDt, parsed.checkInDt]
          );

          const groupedByRoom = new Map();
          for (const row of myStays) {
            if (!groupedByRoom.has(row.room_id)) groupedByRoom.set(row.room_id, []);
            groupedByRoom.get(row.room_id).push(row);
          }
          for (const [rId, list] of groupedByRoom.entries()) {
            myPetsByRoom.set(rId, computePeakConcurrentPets(list, parsed.checkInDt, parsed.checkOutDt));
          }
        }
      }

      return res.json(
        rooms.map((room) => ({
          ...room,
          my_occupied_pets: myPetsByRoom.get(room.room_id) || 0,
          active_stay: null
        }))
      );
    }

    // Prioritize stays actively covering NOW() before upcoming Confirmed reservations
    const [activeStays] = await pool.execute(
      `SELECT b.booking_id, b.user_id, b.room_id, b.check_in_date, b.check_out_date, b.booking_status,
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
          booking_ids: [row.booking_id],
          user_id: row.user_id,
          check_in_date: row.check_in_date,
          check_out_date: row.check_out_date,
          owner_name: row.owner_name,
          pets: [],
          seen_pet_ids: new Set(),
          has_aggressive_pet: false
        });
      }

      const entry = stayByRoom.get(row.room_id);
      const overlapsPrimaryWindow =
        new Date(row.check_in_date) < new Date(entry.check_out_date) &&
        new Date(row.check_out_date) > new Date(entry.check_in_date);

      // Combine same-owner add-on Confirmed bookings sharing this active room stay window
      if (entry.booking_id === row.booking_id || (entry.user_id === row.user_id && overlapsPrimaryWindow)) {
        if (!entry.booking_ids.includes(row.booking_id)) {
          entry.booking_ids.push(row.booking_id);
        }
        if (new Date(row.check_out_date) > new Date(entry.check_out_date)) {
          entry.check_out_date = row.check_out_date;
        }
        if (!entry.seen_pet_ids.has(row.pet_id)) {
          entry.seen_pet_ids.add(row.pet_id);
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
    }

    const enriched = rooms.map((room) => {
      const rawStay = stayByRoom.get(room.room_id) || null;
      let cleanStay = null;
      let occupiedPets = 0;

      if (rawStay) {
        const { seen_pet_ids, ...rest } = rawStay;
        cleanStay = rest;
        occupiedPets = cleanStay.pets.length;
      }

      const maxCap = Number(room.max_capacity);
      const remainingCapacity = room.status === 'Maintenance' ? 0 : Math.max(0, maxCap - occupiedPets);

      return {
        ...room,
        occupied_pets: occupiedPets,
        remaining_capacity: remainingCapacity,
        active_stay: cleanStay
      };
    });

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

      const [rooms] = await pool.execute(
        'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms WHERE status != ? ORDER BY room_number ASC',
        ['Maintenance']
      );

      const [overlappingStays] = await pool.execute(
        `SELECT b.booking_id, b.user_id, b.room_id, b.check_in_date, b.check_out_date,
                COUNT(bp.pet_id) AS pet_count
         FROM bookings b
         LEFT JOIN booking_pets bp ON b.booking_id = bp.booking_id
         WHERE b.booking_status IN (?, ?)
           AND b.check_in_date < ?
           AND b.check_out_date > ?
         GROUP BY b.booking_id`,
        ['Pending', 'Confirmed', parsedRange.checkOutDt, parsedRange.checkInDt]
      );

      const staysByRoom = new Map();
      for (const stay of overlappingStays) {
        if (!staysByRoom.has(stay.room_id)) staysByRoom.set(stay.room_id, []);
        staysByRoom.get(stay.room_id).push(stay);
      }

      const availableRooms = [];
      for (const room of rooms) {
        const roomStays = staysByRoom.get(room.room_id) || [];
        // Option 2 (Private Per Owner): Block if another guest already holds this room during these dates
        const heldByAnotherOwner = roomStays.some((s) => s.user_id !== req.user.user_id);
        if (heldByAnotherOwner) {
          continue;
        }

        const occupiedPets = computePeakConcurrentPets(roomStays, parsedRange.checkInDt, parsedRange.checkOutDt);
        const maxCap = Number(room.max_capacity);
        const remainingCapacity = Math.max(0, maxCap - occupiedPets);

        if (remainingCapacity > 0) {
          availableRooms.push({
            ...room,
            occupied_pets: occupiedPets,
            remaining_capacity: remainingCapacity,
            is_owner_addon: occupiedPets > 0
          });
        }
      }

      return res.json(availableRooms);
    }

    const [rows] = await pool.execute(
      'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms WHERE status = ? ORDER BY room_number ASC',
      ['Available']
    );

    return res.json(
      rows.map((r) => ({
        ...r,
        occupied_pets: 0,
        remaining_capacity: Number(r.max_capacity),
        is_owner_addon: false
      }))
    );
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
