// controllers/bookings.controller.js
const pool = require('../db');
const { emitEvent } = require('../socket');
const { removePrivateSlipFile } = require('../middleware/upload');
const { sendServerError, parseBookingDateRange } = require('../middleware/security');

const VALID_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];

function calculateGroomingFeeForWeight(weightKg) {
  const w = Number(weightKg);
  if (w < 8) return 500;
  if (w <= 20) return 800;
  return 1200;
}

function formatBookingRow(booking) {
  return {
    ...booking,
    payment_status: booking.payment_status || 'Unpaid',
    payment_slip_url: booking.payment_slip_url ? `/api/payments/${booking.booking_id}/slip` : null
  };
}

/**
 * Single batched query (eliminates N+1 query pattern) to attach pets to bookings.
 */
async function attachBookingPets(bookings) {
  if (!bookings || bookings.length === 0) return [];

  const bookingIds = bookings.map((b) => Number(b.booking_id));
  const placeholders = bookingIds.map(() => '?').join(', ');

  const [petRows] = await pool.execute(
    `SELECT bp.booking_id, bp.booking_pet_id, bp.pet_id, bp.has_grooming, bp.grooming_duration_mins, bp.extra_charge,
            p.name, p.species, p.breed, p.weight_kg, p.behavior_status, p.medical_notes, p.photo_url, p.vaccine_card_url
     FROM booking_pets bp
     JOIN pets p ON bp.pet_id = p.pet_id
     WHERE bp.booking_id IN (${placeholders})
     ORDER BY bp.booking_pet_id ASC`,
    bookingIds
  );

  const petsByBooking = new Map();
  for (const row of petRows) {
    if (!petsByBooking.has(row.booking_id)) {
      petsByBooking.set(row.booking_id, []);
    }
    const { booking_id, ...petDetail } = row;
    petsByBooking.get(booking_id).push({
      ...petDetail,
      vaccine_card_url: petDetail.vaccine_card_url ? `/api/pets/${petDetail.pet_id}/vaccine-card` : null
    });
  }

  return bookings.map((b) => ({
    ...formatBookingRow(b),
    pets: petsByBooking.get(b.booking_id) || []
  }));
}

// POST /api/bookings (Multi-pet transactional booking creation with room + pet overlap locks)
async function createBooking(req, res) {
  const { room_id, check_in_date, check_out_date, pet_ids, has_grooming = false } = req.body || {};

  if (!room_id || !check_in_date || !check_out_date || !Array.isArray(pet_ids) || pet_ids.length === 0) {
    return res.status(400).json({
      error: 'room_id, check_in_date, check_out_date, and a non-empty pet_ids array are required.'
    });
  }

  const numericRoomId = Number(room_id);
  if (Number.isNaN(numericRoomId) || numericRoomId <= 0) {
    return res.status(400).json({ error: 'Valid room_id is required.' });
  }

  const uniquePetIds = [...new Set(pet_ids.map((id) => Number(id)).filter((id) => !Number.isNaN(id) && id > 0))];
  if (uniquePetIds.length === 0) {
    return res.status(400).json({ error: 'At least one valid pet_id is required.' });
  }

  const parsedDates = parseBookingDateRange(check_in_date, check_out_date, { rejectPast: true });
  if (!parsedDates.ok) {
    return res.status(400).json({ error: parsedDates.error });
  }

  const { checkInDt, checkOutDt, nights } = parsedDates;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Lock and verify target room
    const [roomRows] = await conn.execute(
      'SELECT room_id, room_number, room_type, max_capacity, base_price_per_night, status FROM rooms WHERE room_id = ? FOR UPDATE',
      [numericRoomId]
    );

    if (roomRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Selected room does not exist.' });
    }

    const room = roomRows[0];
    if (room.status === 'Maintenance') {
      await conn.rollback();
      return res.status(409).json({ error: `Room ${room.room_number} is currently under maintenance.` });
    }

    if (uniquePetIds.length > Number(room.max_capacity)) {
      await conn.rollback();
      return res.status(400).json({
        error: `Room ${room.room_number} (${room.room_type}) has a maximum capacity of ${room.max_capacity} pet(s), but ${uniquePetIds.length} were selected.`
      });
    }

    // 2. Check room date collision against Pending or Confirmed bookings
    const [roomConflicts] = await conn.execute(
      'SELECT booking_id FROM bookings WHERE room_id = ? AND booking_status IN (?, ?) AND check_in_date < ? AND check_out_date > ? FOR UPDATE',
      [room.room_id, 'Pending', 'Confirmed', checkOutDt, checkInDt]
    );

    if (roomConflicts.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        error: `Room ${room.room_number} is already reserved for the selected dates.`
      });
    }

    // 3. Validate each pet belongs to user (unless Admin/Developer)
    const petPlaceholders = uniquePetIds.map(() => '?').join(', ');
    const [petRows] = await conn.execute(
      `SELECT pet_id, user_id, name, weight_kg FROM pets WHERE pet_id IN (${petPlaceholders}) FOR UPDATE`,
      uniquePetIds
    );

    if (petRows.length !== uniquePetIds.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'One or more selected pets could not be found.' });
    }

    for (const pet of petRows) {
      if (req.user.role === 'User' && pet.user_id !== req.user.user_id) {
        await conn.rollback();
        return res.status(403).json({ error: `Pet "${pet.name}" does not belong to your account.` });
      }
    }

    // 4. Prevent double-booking the same pet across overlapping dates in another room
    const [petConflicts] = await conn.execute(
      `SELECT p.name AS pet_name, b.booking_id, r.room_number
       FROM booking_pets bp
       JOIN bookings b ON bp.booking_id = b.booking_id
       JOIN pets p ON bp.pet_id = p.pet_id
       JOIN rooms r ON b.room_id = r.room_id
       WHERE bp.pet_id IN (${petPlaceholders})
         AND b.booking_status IN (?, ?)
         AND b.check_in_date < ?
         AND b.check_out_date > ?
       LIMIT 1
       FOR UPDATE`,
      [...uniquePetIds, 'Pending', 'Confirmed', checkOutDt, checkInDt]
    );

    if (petConflicts.length > 0) {
      await conn.rollback();
      const conflict = petConflicts[0];
      return res.status(409).json({
        error: `Pet "${conflict.pet_name}" already has an overlapping reservation (#${conflict.booking_id} in Room ${conflict.room_number}) during those dates.`
      });
    }

    const lodgingCharge = nights * Number(room.base_price_per_night);
    const multiPetSurcharge = petRows.length > 1 ? (petRows.length - 1) * 300 * nights : 0;
    const groomingFlag = Boolean(has_grooming);
    let groomingTotal = 0;

    for (const pet of petRows) {
      if (groomingFlag) {
        groomingTotal += calculateGroomingFeeForWeight(pet.weight_kg);
      }
    }

    const estimatedTotal = lodgingCharge + multiPetSurcharge + groomingTotal;

    // 5. Insert booking record (status = 'Pending', payment_status = 'Unpaid')
    const [bookingResult] = await conn.execute(
      'INSERT INTO bookings (user_id, room_id, check_in_date, check_out_date, total_price, booking_status, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.user_id, room.room_id, checkInDt, checkOutDt, estimatedTotal, 'Pending', 'Unpaid']
    );

    const newBookingId = bookingResult.insertId;

    // 6. Insert junction records into booking_pets
    for (const pet of petRows) {
      const petExtra = groomingFlag ? calculateGroomingFeeForWeight(pet.weight_kg) : 0;
      const durationMins = groomingFlag ? 60 : 0;

      await conn.execute(
        'INSERT INTO booking_pets (booking_id, pet_id, has_grooming, grooming_duration_mins, extra_charge) VALUES (?, ?, ?, ?, ?)',
        [newBookingId, pet.pet_id, groomingFlag ? 1 : 0, durationMins, petExtra]
      );
    }

    await conn.commit();

    const bookingPayload = {
      booking_id: newBookingId,
      user_id: req.user.user_id,
      owner_name: req.user.name,
      room_id: room.room_id,
      room_number: room.room_number,
      room_type: room.room_type,
      check_in_date: checkInDt,
      check_out_date: checkOutDt,
      nights,
      total_price: estimatedTotal,
      booking_status: 'Pending',
      payment_status: 'Unpaid',
      pets: petRows.map((p) => p.name)
    };

    // Real-time Socket.IO broadcasts (Private details scoped to staff, non-sensitive room refresh globally)
    emitEvent('booking:created', bookingPayload, ['role:Admin', 'role:Developer']);
    emitEvent('room:status_changed', {
      reason: 'booking_created',
      room_id: room.room_id,
      room_number: room.room_number
    });

    return res.status(201).json({
      message: 'Reservation created successfully. Please scan PromptPay QR and upload your transfer slip for staff confirmation.',
      booking: bookingPayload
    });
  } catch (err) {
    await conn.rollback();
    return sendServerError(res, 'bookings.createBooking Error', 'Failed to create booking', err);
  } finally {
    conn.release();
  }
}

// GET /api/bookings/my
async function getMyBookings(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT b.booking_id, b.user_id, b.room_id, r.room_number, r.room_type, r.base_price_per_night,
              b.check_in_date, b.check_out_date, b.total_price, b.booking_status, b.payment_status, b.payment_slip_url
       FROM bookings b
       JOIN rooms r ON b.room_id = r.room_id
       WHERE b.user_id = ?
       ORDER BY FIELD(b.booking_status, ?, ?, ?, ?), b.booking_id DESC
       LIMIT 100`,
      [req.user.user_id, 'Confirmed', 'Pending', 'Completed', 'Cancelled']
    );

    const bookingsWithPets = await attachBookingPets(rows);
    return res.json(bookingsWithPets);
  } catch (err) {
    return sendServerError(res, 'bookings.getMyBookings Error', 'Failed to retrieve your bookings', err);
  }
}

// GET /api/bookings (Staff / Developer view of all bookings)
async function getAllBookings(req, res) {
  try {
    const statusFilter = req.query.status;
    let rows;

    if (statusFilter && VALID_BOOKING_STATUSES.includes(statusFilter)) {
      const [filtered] = await pool.execute(
        `SELECT b.booking_id, b.user_id, u.name AS owner_name, u.phone AS owner_phone, b.room_id,
                r.room_number, r.room_type, r.base_price_per_night, b.check_in_date, b.check_out_date,
                b.total_price, b.booking_status, b.payment_status, b.payment_slip_url
         FROM bookings b
         JOIN users u ON b.user_id = u.user_id
         JOIN rooms r ON b.room_id = r.room_id
         WHERE b.booking_status = ?
         ORDER BY b.check_in_date ASC, b.booking_id DESC
         LIMIT 200`,
        [statusFilter]
      );
      rows = filtered;
    } else {
      const [allRows] = await pool.execute(
        `SELECT b.booking_id, b.user_id, u.name AS owner_name, u.phone AS owner_phone, b.room_id,
                r.room_number, r.room_type, r.base_price_per_night, b.check_in_date, b.check_out_date,
                b.total_price, b.booking_status, b.payment_status, b.payment_slip_url
         FROM bookings b
         JOIN users u ON b.user_id = u.user_id
         JOIN rooms r ON b.room_id = r.room_id
         ORDER BY FIELD(b.booking_status, ?, ?, ?, ?), b.check_in_date ASC, b.booking_id DESC
         LIMIT 200`,
        ['Confirmed', 'Pending', 'Completed', 'Cancelled']
      );
      rows = allRows;
    }

    const bookingsWithPets = await attachBookingPets(rows);
    return res.json(bookingsWithPets);
  } catch (err) {
    return sendServerError(res, 'bookings.getAllBookings Error', 'Failed to retrieve bookings', err);
  }
}

// PUT /api/bookings/:id/status (Transactional with collision checks; fires trg_after_booking_status_change)
async function updateBookingStatus(req, res) {
  const bookingId = Number(req.params.id);
  const { status } = req.body || {};

  if (Number.isNaN(bookingId) || bookingId <= 0 || !VALID_BOOKING_STATUSES.includes(status)) {
    return res.status(400).json({
      error: 'Valid booking ID and status (Pending, Confirmed, Completed, Cancelled) are required.'
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.execute(
      'SELECT booking_id, user_id, room_id, check_in_date, check_out_date, booking_status, payment_status FROM bookings WHERE booking_id = ? FOR UPDATE',
      [bookingId]
    );

    if (existingRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = existingRows[0];

    if (req.user.role === 'User') {
      if (booking.user_id !== req.user.user_id) {
        await conn.rollback();
        return res.status(403).json({ error: 'Forbidden: You can only modify your own bookings.' });
      }
      if (status !== 'Cancelled' || booking.booking_status !== 'Pending') {
        await conn.rollback();
        return res.status(403).json({
          error: 'Customers can only cancel upcoming Pending reservations prior to check-in.'
        });
      }
    }

    const [roomLockRows] = await conn.execute(
      'SELECT room_id, room_number, status FROM rooms WHERE room_id = ? FOR UPDATE',
      [booking.room_id]
    );
    const roomBefore = roomLockRows[0];

    // Prevent collisions or checking into a Maintenance room when confirming
    if (status === 'Confirmed' && booking.booking_status !== 'Confirmed') {
      if (roomBefore && roomBefore.status === 'Maintenance') {
        await conn.rollback();
        return res.status(409).json({
          error: `Cannot check in: Room #${roomBefore.room_number} is currently in Maintenance mode.`
        });
      }

      const [overlappingRoomStays] = await conn.execute(
        'SELECT booking_id FROM bookings WHERE room_id = ? AND booking_id != ? AND booking_status = ? AND check_in_date < ? AND check_out_date > ? LIMIT 1 FOR UPDATE',
        [booking.room_id, bookingId, 'Confirmed', booking.check_out_date, booking.check_in_date]
      );

      if (overlappingRoomStays.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          error: `Room #${roomBefore.room_number} already has an overlapping Checked-In booking (#${overlappingRoomStays[0].booking_id}).`
        });
      }
    }

    if (status === 'Confirmed') {
      await conn.execute(
        'UPDATE bookings SET booking_status = ?, payment_status = ? WHERE booking_id = ?',
        ['Confirmed', 'Paid', bookingId]
      );
    } else {
      await conn.execute(
        'UPDATE bookings SET booking_status = ? WHERE booking_id = ?',
        [status, bookingId]
      );
    }

    const [roomRows] = await conn.execute(
      'SELECT room_id, room_number, status FROM rooms WHERE room_id = ?',
      [booking.room_id]
    );

    await conn.commit();

    const updatedRoom = roomRows[0] || null;

    // Public room availability refresh (no PII)
    emitEvent('room:status_changed', {
      reason: 'room_availability_updated',
      room: updatedRoom
    });

    // Scoped status notification to the booking owner & staff
    emitEvent(
      'room:status_changed',
      {
        reason: 'booking_status_updated',
        booking_id: bookingId,
        booking_status: status,
        room: updatedRoom
      },
      [`user:${booking.user_id}`, 'role:Admin', 'role:Developer']
    );

    return res.json({
      message: `Booking #${bookingId} updated to '${status}'.`,
      booking_id: bookingId,
      booking_status: status,
      room: updatedRoom
    });
  } catch (err) {
    await conn.rollback();
    return sendServerError(res, 'bookings.updateBookingStatus Error', 'Failed to update booking status', err);
  } finally {
    conn.release();
  }
}

// DELETE /api/bookings/:id
async function deleteBooking(req, res) {
  try {
    const bookingId = Number(req.params.id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Invalid booking ID.' });
    }

    const [existingRows] = await pool.execute(
      'SELECT booking_id, user_id, room_id, booking_status, payment_slip_url FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = existingRows[0];
    if (req.user.role === 'User') {
      if (booking.user_id !== req.user.user_id) {
        return res.status(403).json({ error: 'Forbidden: You can only cancel your own reservations.' });
      }
      if (booking.booking_status !== 'Pending') {
        return res.status(400).json({ error: 'Only Pending reservations can be deleted directly.' });
      }
    } else if (booking.booking_status === 'Confirmed') {
      return res.status(400).json({
        error: 'Cannot delete an active Checked-In stay directly. Please Cancel or Checkout the booking first so room status stays synchronized.'
      });
    }

    await pool.execute(
      'DELETE FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (booking.payment_slip_url) {
      removePrivateSlipFile(booking.payment_slip_url);
    }

    emitEvent('room:status_changed', {
      reason: 'booking_deleted',
      room_id: booking.room_id
    });

    return res.json({ message: `Reservation #${bookingId} removed.` });
  } catch (err) {
    return sendServerError(res, 'bookings.deleteBooking Error', 'Failed to delete booking', err);
  }
}

// GET /api/bookings/:id/invoice-preview (Non-mutating preview before finalizing Checkout)
async function previewCheckoutInvoice(req, res) {
  try {
    const bookingId = Number(req.params.id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Invalid booking ID.' });
    }

    const [rows] = await pool.execute(
      `SELECT b.booking_id, b.user_id, b.room_id, r.room_number, r.room_type, r.base_price_per_night,
              b.check_in_date, b.check_out_date, b.total_price, b.booking_status
       FROM bookings b
       JOIN rooms r ON b.room_id = r.room_id
       WHERE b.booking_id = ?`,
      [bookingId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const b = rows[0];
    if (b.booking_status !== 'Confirmed' && b.booking_status !== 'Completed') {
      return res.status(400).json({
        error: `Cannot preview checkout invoice for a '${b.booking_status}' booking.`
      });
    }

    const [petRows] = await pool.execute(
      `SELECT bp.booking_pet_id, bp.has_grooming, bp.extra_charge, p.name, p.weight_kg
       FROM booking_pets bp
       JOIN pets p ON bp.pet_id = p.pet_id
       WHERE bp.booking_id = ?
       ORDER BY bp.booking_pet_id ASC`,
      [bookingId]
    );

    const dIn = new Date(b.check_in_date);
    const dOut = new Date(b.check_out_date);
    const utcIn = Date.UTC(dIn.getFullYear(), dIn.getMonth(), dIn.getDate());
    const utcOut = Date.UTC(dOut.getFullYear(), dOut.getMonth(), dOut.getDate());
    const stayNights = Math.max(1, Math.round((utcOut - utcIn) / 86400000));

    const petCount = petRows.length;
    const guestPets = petCount > 0 ? petRows.map((p) => p.name).join(' & ') : 'N/A';
    const multiPetSurcharge = petCount > 1 ? (petCount - 1) * 300 * stayNights : 0;

    let groomingFee = 0;
    let lodgingCharge = stayNights * Number(b.base_price_per_night);
    let totalPrice = 0;

    if (b.booking_status === 'Completed') {
      groomingFee = petRows.reduce((sum, p) => sum + Number(p.extra_charge || 0), 0);
      totalPrice = Number(b.total_price);
      lodgingCharge = Math.max(0, totalPrice - multiPetSurcharge - groomingFee);
    } else {
      groomingFee = petRows.reduce(
        (sum, p) => sum + (p.has_grooming ? calculateGroomingFeeForWeight(p.weight_kg) : 0),
        0
      );
      totalPrice = lodgingCharge + multiPetSurcharge + groomingFee;
    }

    return res.json({
      invoice: {
        booking_id: bookingId,
        room_number: b.room_number,
        room_type: b.room_type,
        guest_pets: guestPets,
        stay_nights: stayNights,
        pet_count: petCount,
        lodging_charge: lodgingCharge,
        multi_pet_surcharge: multiPetSurcharge,
        grooming_fee: groomingFee,
        total_price: totalPrice,
        booking_status: b.booking_status
      }
    });
  } catch (err) {
    return sendServerError(res, 'bookings.previewCheckoutInvoice Error', 'Failed to preview invoice', err);
  }
}

// POST /api/bookings/:id/checkout (Executes Stored Procedure sp_finalize_and_calculate_bill)
async function checkoutBooking(req, res) {
  try {
    const bookingId = Number(req.params.id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Invalid booking ID.' });
    }

    const [existingRows] = await pool.execute(
      'SELECT booking_id, user_id, room_id, booking_status FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = existingRows[0];
    if (booking.booking_status === 'Cancelled' || booking.booking_status === 'Pending') {
      return res.status(400).json({
        error: `Cannot execute checkout for a '${booking.booking_status}' booking. Only Checked-In ('Confirmed') stays can be finalized.`
      });
    }

    const [spResultSets] = await pool.query(
      'CALL sp_finalize_and_calculate_bill(?)',
      [bookingId]
    );

    const invoice = Array.isArray(spResultSets) && Array.isArray(spResultSets[0])
      ? spResultSets[0][0]
      : null;

    const [roomRows] = await pool.execute(
      'SELECT room_id, room_number, status FROM rooms WHERE room_id = ?',
      [booking.room_id]
    );

    const updatedRoom = roomRows[0] || null;

    // 1. Non-sensitive public room status update for floor selectors
    emitEvent('room:status_changed', {
      reason: 'room_released',
      room: updatedRoom
    });

    // 2. Private checkout settlement notification ONLY to pet owner & staff
    emitEvent(
      'room:status_changed',
      {
        reason: 'checkout_completed',
        booking_id: bookingId,
        booking_status: 'Completed',
        room: updatedRoom,
        invoice
      },
      [`user:${booking.user_id}`, 'role:Admin', 'role:Developer']
    );

    return res.json({
      message: 'Checkout finalized via sp_finalize_and_calculate_bill; room released by trigger.',
      invoice,
      room: updatedRoom
    });
  } catch (err) {
    if (err && err.sqlState === '45000') {
      return res.status(400).json({ error: err.message });
    }
    return sendServerError(res, 'bookings.checkoutBooking Error', 'Checkout Stored Procedure failed', err);
  }
}

module.exports = {
  createBooking,
  getMyBookings,
  getAllBookings,
  updateBookingStatus,
  deleteBooking,
  previewCheckoutInvoice,
  checkoutBooking
};
