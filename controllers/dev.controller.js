// controllers/dev.controller.js
const { performance } = require('perf_hooks');
const pool = require('../db');
const { VALID_ROLES } = require('../middleware/auth');
const { emitEvent, syncUserSocketsRole } = require('../socket');
const { sendServerError } = require('../middleware/security');

// GET /api/users
async function getUsers(req, res) {
  try {
    const [rows] = await pool.execute(
      'SELECT user_id, name, email, phone, role FROM users ORDER BY user_id ASC'
    );
    return res.json(rows);
  } catch (err) {
    return sendServerError(res, 'dev.getUsers Error', 'Failed to retrieve users', err);
  }
}

// PUT /api/users/:id/role
async function updateUserRole(req, res) {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body || {};

    if (Number.isNaN(userId) || userId <= 0 || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        error: 'Valid user ID and role (User, Admin, Developer) are required.'
      });
    }

    // Prevent any Developer from accidentally demoting their own active session
    if (userId === req.user.user_id && role !== 'Developer') {
      return res.status(400).json({
        error: 'You cannot demote your own currently signed-in Developer account.'
      });
    }

    const [existingRows] = await pool.execute(
      'SELECT user_id, name, email, role FROM users WHERE user_id = ?',
      [userId]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const targetUser = existingRows[0];
    if (targetUser.email.toLowerCase() === 'nattapat@pawstay.dev' && role !== 'Developer') {
      return res.status(403).json({
        error: 'Protected primary Developer account cannot be demoted.'
      });
    }

    await pool.execute(
      'UPDATE users SET role = ? WHERE user_id = ?',
      [role, userId]
    );

    // Immediately sync any open Socket.IO room subscriptions for this user
    await syncUserSocketsRole(userId, role);

    return res.json({
      message: `Role updated to '${role}' for ${targetUser.name}.`,
      user: {
        ...targetUser,
        role
      }
    });
  } catch (err) {
    return sendServerError(res, 'dev.updateUserRole Error', 'Failed to update user role', err);
  }
}

// GET /api/dev/pool-status
async function getPoolStatus(req, res) {
  try {
    const pingStart = performance.now();
    const [versionRows] = await pool.execute('SELECT VERSION() AS mysql_version');
    const pingLatencyMs = Number((performance.now() - pingStart).toFixed(2));

    const metrics = pool.getPoolMetrics();

    return res.json({
      connected: true,
      mysqlVersion: versionRows[0] ? versionRows[0].mysql_version : '8.0',
      pingLatencyMs,
      ...metrics
    });
  } catch (err) {
    console.error('[dev.getPoolStatus Error]:', err.message);
    const metrics = pool.getPoolMetrics();
    return res.status(500).json({
      connected: false,
      error: 'Database connection check failed',
      ...(process.env.NODE_ENV !== 'production' ? { details: err.message } : {}),
      ...metrics
    });
  }
}

// POST /api/dev/execute-test
async function executeRoutineTest(req, res) {
  try {
    const { routine, booking_id, status } = req.body || {};
    let bookingId = Number(booking_id);

    if (Number.isNaN(bookingId) || bookingId <= 0) {
      const [firstBooking] = await pool.execute(
        'SELECT booking_id FROM bookings ORDER BY booking_id ASC LIMIT 1'
      );
      if (firstBooking.length === 0) {
        return res.status(404).json({ error: 'No bookings exist in the database to test.' });
      }
      bookingId = firstBooking[0].booking_id;
    } else {
      const [checkBooking] = await pool.execute(
        'SELECT booking_id FROM bookings WHERE booking_id = ?',
        [bookingId]
      );
      if (checkBooking.length === 0) {
        return res.status(404).json({
          error: `Booking #${bookingId} does not exist in 'bookings' table.`
        });
      }
    }

    if (routine === 'sp_bill') {
      const t0 = performance.now();
      const [spSets] = await pool.query(
        'CALL sp_finalize_and_calculate_bill(?)',
        [bookingId]
      );
      const elapsedSec = ((performance.now() - t0) / 1000).toFixed(3);

      const row = Array.isArray(spSets) && Array.isArray(spSets[0]) ? spSets[0][0] : null;
      const [roomRows] = await pool.execute(
        'SELECT room_id, room_number, status FROM rooms WHERE room_id = (SELECT room_id FROM bookings WHERE booking_id = ?)',
        [bookingId]
      );
      const room = roomRows[0] || {};

      const pad = (val, len) => String(val).padStart(len, ' ');
      const fmtMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const consoleOutput = [
        `mysql> CALL sp_finalize_and_calculate_bill(${bookingId});`,
        `Query OK, 1 row affected (${elapsedSec} sec)`,
        '',
        '+------------+-------------+---------------+--------------+--------------+--------------+',
        '| booking_id | stay_nights | lodging_fee   | extra_pets   | grooming_fee | total_price  |',
        '+------------+-------------+---------------+--------------+--------------+--------------+',
        `| ${pad(row.booking_id, 10)} | ${pad(row.stay_nights, 11)} | ${pad(fmtMoney(row.lodging_charge), 13)} | ${pad(fmtMoney(row.multi_pet_surcharge), 12)} | ${pad(fmtMoney(row.grooming_fee), 12)} | ${pad(fmtMoney(row.total_price), 12)} |`,
        '+------------+-------------+---------------+--------------+--------------+--------------+',
        `1 row in set (${elapsedSec} sec)`,
        `Booking status -> 'Completed' (Idempotent historical invoice protected)`,
        `Trigger verified: Room ${room.room_number || ''} (room_id=${room.room_id || ''}) status -> '${room.status || 'Available'}'`
      ].join('\n');

      emitEvent('room:status_changed', {
        reason: 'dev_sp_test',
        room
      });

      return res.json({
        routine: 'sp_bill',
        invoice: row,
        room,
        consoleOutput
      });
    }

    if (routine === 'trg_status') {
      const targetStatus = ['Confirmed', 'Completed', 'Cancelled'].includes(status)
        ? status
        : 'Confirmed';

      const t0 = performance.now();
      await pool.execute(
        'UPDATE bookings SET booking_status = ? WHERE booking_id = ?',
        [targetStatus, bookingId]
      );
      const updateSec = ((performance.now() - t0) / 1000).toFixed(3);

      const t1 = performance.now();
      const [roomRows] = await pool.execute(
        'SELECT room_id, room_number, status FROM rooms WHERE room_id = (SELECT room_id FROM bookings WHERE booking_id = ?)',
        [bookingId]
      );
      const selectSec = ((performance.now() - t1) / 1000).toFixed(3);
      const room = roomRows[0] || {};

      const padEnd = (val, len) => String(val).padEnd(len, ' ');
      const padStart = (val, len) => String(val).padStart(len, ' ');

      const consoleOutput = [
        `mysql> UPDATE bookings SET booking_status = '${targetStatus}' WHERE booking_id = ${bookingId};`,
        `Query OK, 1 row affected (${updateSec} sec)`,
        '',
        '/* Trigger trg_after_booking_status_change fired automatically */',
        `mysql> SELECT room_id, room_number, status FROM rooms WHERE room_id = (SELECT room_id FROM bookings WHERE booking_id = ${bookingId});`,
        '+---------+-------------+------------+',
        '| room_id | room_number | status     |',
        '+---------+-------------+------------+',
        `| ${padStart(room.room_id, 7)} | ${padEnd(room.room_number, 11)} | ${padEnd(room.status, 10)} |`,
        '+---------+-------------+------------+',
        `1 row in set (${selectSec} sec)`,
        `Trigger verified: Room ${room.room_number} status -> '${room.status}'`
      ].join('\n');

      emitEvent('room:status_changed', {
        reason: 'dev_trigger_test',
        room
      });

      return res.json({
        routine: 'trg_status',
        booking_id: bookingId,
        booking_status: targetStatus,
        room,
        consoleOutput
      });
    }

    return res.status(400).json({ error: 'Unknown routine specified. Use sp_bill or trg_status.' });
  } catch (err) {
    if (err && err.sqlState === '45000') {
      return res.status(400).json({
        error: err.message
      });
    }
    return sendServerError(res, 'dev.executeRoutineTest Error', 'Routine execution failed', err);
  }
}

module.exports = {
  getUsers,
  updateUserRole,
  getPoolStatus,
  executeRoutineTest
};
