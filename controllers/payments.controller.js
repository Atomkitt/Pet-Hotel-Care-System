// controllers/payments.controller.js
const fs = require('fs');
const path = require('path');
const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const pool = require('../db');
const { emitEvent } = require('../socket');
const { PRIVATE_SLIP_DIR, removePrivateSlipFile } = require('../middleware/upload');
const { sendServerError, computePeakConcurrentPets } = require('../middleware/security');

const DEFAULT_PROMPTPAY_ID = process.env.PROMPTPAY_ID || '061-852-5229';

// POST /api/payments/generate-qr
async function generatePromptPayQR(req, res) {
  try {
    const bookingId = Number(req.body && req.body.booking_id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Valid booking_id is required.' });
    }

    const [rows] = await pool.execute(
      'SELECT b.booking_id, b.user_id, b.room_id, r.room_number, r.room_type, b.total_price, b.booking_status, b.payment_status, b.payment_slip_url FROM bookings b JOIN rooms r ON b.room_id = r.room_id WHERE b.booking_id = ?',
      [bookingId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = rows[0];
    if (req.user.role === 'User' && booking.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden: You can only generate payment QR for your own booking.' });
    }

    if (booking.booking_status === 'Cancelled') {
      return res.status(400).json({ error: 'Cannot generate QR code for a Cancelled booking.' });
    }

    const amount = Number(booking.total_price);
    if (amount <= 0) {
      return res.status(400).json({ error: 'Booking amount must be greater than 0 THB.' });
    }

    const promptPayTarget = process.env.PROMPTPAY_ID || DEFAULT_PROMPTPAY_ID;
    const payload = generatePayload(promptPayTarget, { amount });

    const [qrDataUrl, qrSvg] = await Promise.all([
      QRCode.toDataURL(payload, {
        width: 260,
        margin: 2,
        color: { dark: '#0F172A', light: '#FFFFFF' }
      }),
      QRCode.toString(payload, { type: 'svg', margin: 1 })
    ]);

    return res.json({
      booking_id: booking.booking_id,
      room_number: booking.room_number,
      room_type: booking.room_type,
      booking_status: booking.booking_status,
      payment_status: booking.payment_status || 'Unpaid',
      payment_slip_url: booking.payment_slip_url ? `/api/payments/${booking.booking_id}/slip` : null,
      promptpay_id: promptPayTarget,
      amount,
      qr_payload: payload,
      qr_data_url: qrDataUrl,
      qr_svg: qrSvg
    });
  } catch (err) {
    return sendServerError(res, 'payments.generatePromptPayQR Error', 'Failed to generate PromptPay QR code', err);
  }
}

// POST /api/payments/confirm
// - Pet Owner ('User'): Must upload a valid transfer slip image -> marks payment_status = 'Pending_Verification' (NEVER self-confirms booking_status!)
// - Staff / Developer ('Admin', 'Developer'): Verifies slip/payment inside a row-locked transaction -> marks booking_status = 'Confirmed' & payment_status = 'Paid'
async function confirmPayment(req, res) {
  const bookingId = Number(req.body && req.body.booking_id);
  if (Number.isNaN(bookingId) || bookingId <= 0) {
    if (req.file) removePrivateSlipFile(req.file.filename);
    return res.status(400).json({ error: 'Valid booking_id is required.' });
  }

  // Branch A: Pet Owner ('User') submits transfer slip for Staff verification
  if (req.user.role === 'User') {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'กรุณาแนบรูปสลิปการโอนเงิน (JPG, PNG, WEBP) เพื่อแจ้งชำระเงินให้เจ้าหน้าที่ตรวจสอบ (Customers cannot self-approve reservations without uploading a transfer slip).'
        });
      }

      const [rows] = await pool.execute(
        'SELECT b.booking_id, b.user_id, b.room_id, b.total_price, b.booking_status, b.payment_slip_url, r.room_number FROM bookings b JOIN rooms r ON b.room_id = r.room_id WHERE b.booking_id = ?',
        [bookingId]
      );

      if (rows.length === 0) {
        removePrivateSlipFile(req.file.filename);
        return res.status(404).json({ error: 'Booking not found.' });
      }

      const booking = rows[0];
      if (booking.user_id !== req.user.user_id) {
        removePrivateSlipFile(req.file.filename);
        return res.status(403).json({ error: 'Forbidden: You can only submit payment slips for your own booking.' });
      }

      if (booking.booking_status !== 'Pending') {
        removePrivateSlipFile(req.file.filename);
        return res.status(400).json({
          error: `Cannot submit payment slip for a '${booking.booking_status}' booking.`
        });
      }

      await pool.execute(
        'UPDATE bookings SET payment_status = ?, payment_slip_url = ? WHERE booking_id = ?',
        ['Pending_Verification', req.file.filename, bookingId]
      );

      if (booking.payment_slip_url) {
        removePrivateSlipFile(booking.payment_slip_url);
      }

      emitEvent(
        'booking:created',
        {
          event: 'slip_submitted',
          booking_id: bookingId,
          room_number: booking.room_number,
          total_price: booking.total_price,
          booking_status: 'Pending',
          payment_status: 'Pending_Verification'
        },
        ['role:Admin', 'role:Developer']
      );

      return res.json({
        message: `ส่งสลิปโอนเงินสำหรับ Booking #${bookingId} เรียบร้อยแล้ว! กรุณารอเจ้าหน้าที่ตรวจสอบและอนุมัติเข้าพัก`,
        booking_id: bookingId,
        booking_status: 'Pending',
        payment_status: 'Pending_Verification',
        payment_slip_url: `/api/payments/${bookingId}/slip`,
        amount_submitted: Number(booking.total_price)
      });
    } catch (err) {
      if (req.file) removePrivateSlipFile(req.file.filename);
      return sendServerError(res, 'payments.confirmPayment(UserSlip) Error', 'Failed to submit payment slip', err);
    }
  }

  // Branch B: Staff ('Admin') or 'Developer' verifies payment and confirms stay inside row-locked transaction
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      'SELECT b.booking_id, b.user_id, b.room_id, b.check_in_date, b.check_out_date, b.total_price, b.booking_status, b.payment_slip_url, r.room_number, r.max_capacity, r.status AS room_status FROM bookings b JOIN rooms r ON b.room_id = r.room_id WHERE b.booking_id = ? FOR UPDATE',
      [bookingId]
    );

    if (rows.length === 0) {
      await conn.rollback();
      if (req.file) removePrivateSlipFile(req.file.filename);
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = rows[0];
    if (booking.booking_status === 'Cancelled' || booking.booking_status === 'Completed') {
      await conn.rollback();
      if (req.file) removePrivateSlipFile(req.file.filename);
      return res.status(400).json({
        error: `Cannot confirm payment for a '${booking.booking_status}' booking.`
      });
    }

    if (booking.room_status === 'Maintenance') {
      await conn.rollback();
      if (req.file) removePrivateSlipFile(req.file.filename);
      return res.status(409).json({
        error: `Room #${booking.room_number} is currently in Maintenance mode.`
      });
    }

    if (booking.booking_status !== 'Confirmed') {
      const [overlappingStays] = await conn.execute(
        'SELECT booking_id, user_id, check_in_date, check_out_date FROM bookings WHERE room_id = ? AND booking_id != ? AND booking_status = ? AND check_in_date < ? AND check_out_date > ? FOR UPDATE',
        [booking.room_id, bookingId, 'Confirmed', booking.check_out_date, booking.check_in_date]
      );

      const otherGuestStay = overlappingStays.find((s) => s.user_id !== booking.user_id);
      if (otherGuestStay) {
        await conn.rollback();
        if (req.file) removePrivateSlipFile(req.file.filename);
        return res.status(409).json({
          error: `Room #${booking.room_number} already has an overlapping Checked-In stay from another guest (#${otherGuestStay.booking_id}).`
        });
      }

      const [thisPetRows] = await conn.execute(
        'SELECT COUNT(pet_id) AS cnt FROM booking_pets WHERE booking_id = ?',
        [bookingId]
      );
      const thisPetCount = Number(thisPetRows[0]?.cnt || 0);

      let peakConfirmedPets = 0;
      if (overlappingStays.length > 0) {
        const stayIds = overlappingStays.map((s) => s.booking_id);
        const placeholders = stayIds.map(() => '?').join(', ');
        const [stayCountRows] = await conn.execute(
          `SELECT booking_id, COUNT(pet_id) AS pet_count FROM booking_pets WHERE booking_id IN (${placeholders}) GROUP BY booking_id`,
          stayIds
        );
        const countMap = new Map(stayCountRows.map((r) => [r.booking_id, Number(r.pet_count)]));
        const intervals = overlappingStays.map((s) => ({
          ...s,
          pet_count: countMap.get(s.booking_id) || 0
        }));
        peakConfirmedPets = computePeakConcurrentPets(intervals, booking.check_in_date, booking.check_out_date);
      }

      const maxCap = Number(booking.max_capacity);
      if (peakConfirmedPets + thisPetCount > maxCap) {
        await conn.rollback();
        if (req.file) removePrivateSlipFile(req.file.filename);
        return res.status(409).json({
          error: `Cannot check in: Room #${booking.room_number} max capacity is ${maxCap} pet(s), and ${peakConfirmedPets} pet(s) are already checked in during these dates.`
        });
      }
    }

    const updatedSlipRef = req.file ? req.file.filename : booking.payment_slip_url;

    // Update status to 'Confirmed' -> Fires trg_after_booking_status_change -> marks room 'Occupied' only when max_capacity is reached
    await conn.execute(
      'UPDATE bookings SET booking_status = ?, payment_status = ?, payment_slip_url = ? WHERE booking_id = ?',
      ['Confirmed', 'Paid', updatedSlipRef, bookingId]
    );

    const [roomRows] = await conn.execute(
      'SELECT room_id, room_number, status FROM rooms WHERE room_id = ?',
      [booking.room_id]
    );

    await conn.commit();

    if (req.file && booking.payment_slip_url) {
      removePrivateSlipFile(booking.payment_slip_url);
    }

    const updatedRoom = roomRows[0] || null;

    // Public availability refresh
    emitEvent('room:status_changed', {
      reason: 'room_availability_updated',
      room: updatedRoom
    });

    // Scoped confirmation alert to owner & staff
    emitEvent(
      'room:status_changed',
      {
        reason: 'booking_status_updated',
        booking_id: bookingId,
        booking_status: 'Confirmed',
        room: updatedRoom
      },
      [`user:${booking.user_id}`, 'role:Admin', 'role:Developer']
    );

    emitEvent(
      'booking:created',
      {
        event: 'payment_confirmed',
        booking_id: bookingId,
        room_number: booking.room_number,
        total_price: booking.total_price,
        booking_status: 'Confirmed',
        payment_status: 'Paid'
      },
      ['role:Admin', 'role:Developer']
    );

    const roomStateNote =
      updatedRoom && updatedRoom.status === 'Occupied'
        ? `Room #${booking.room_number} is now at full capacity (Occupied).`
        : `Room #${booking.room_number} remains Available for remaining owner pet slots.`;

    return res.json({
      message: `Payment verified by staff! Booking #${bookingId} is now Confirmed (${roomStateNote})`,
      booking_id: bookingId,
      booking_status: 'Confirmed',
      payment_status: 'Paid',
      amount_paid: Number(booking.total_price),
      room: updatedRoom
    });
  } catch (err) {
    await conn.rollback();
    if (req.file) removePrivateSlipFile(req.file.filename);
    return sendServerError(res, 'payments.confirmPayment Error', 'Failed to confirm payment', err);
  } finally {
    conn.release();
  }
}

// GET /api/payments/:booking_id/slip (Authenticated & Ownership/RBAC-Protected Slip Stream)
async function getPaymentSlip(req, res) {
  try {
    const bookingId = Number(req.params.booking_id);
    if (Number.isNaN(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: 'Invalid booking_id.' });
    }

    const [rows] = await pool.execute(
      'SELECT booking_id, user_id, payment_slip_url FROM bookings WHERE booking_id = ?',
      [bookingId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    const booking = rows[0];
    if (req.user.role === 'User' && booking.user_id !== req.user.user_id) {
      return res.status(403).json({
        error: 'Forbidden: You do not have permission to view this payment slip.'
      });
    }

    if (!booking.payment_slip_url) {
      return res.status(404).json({ error: 'No payment slip has been uploaded for this booking.' });
    }

    const safeFilename = path.basename(String(booking.payment_slip_url));
    const filePath = path.join(PRIVATE_SLIP_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Payment slip file not found on server.' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.sendFile(filePath);
  } catch (err) {
    return sendServerError(res, 'payments.getPaymentSlip Error', 'Failed to retrieve payment slip', err);
  }
}

module.exports = {
  generatePromptPayQR,
  confirmPayment,
  getPaymentSlip
};
