// socket.js
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { JWT_SECRET } = require('./middleware/auth');

let ioInstance = null;

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const key = pair.slice(0, idx).trim();
      const rawVal = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(rawVal);
      } catch (_) {
        cookies[key] = rawVal;
      }
    }
  }
  return cookies;
}

function initSocket(httpServer, allowedOrigins) {
  ioInstance = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true
    }
  });

  // Authenticate WebSocket handshake via HttpOnly JWT Cookie + Live MySQL User/Role Check
  ioInstance.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = cookies.token;
      if (!token) {
        return next(new Error('Unauthorized socket connection'));
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded || !decoded.user_id) {
        return next(new Error('Invalid socket token payload'));
      }

      const [rows] = await pool.execute(
        'SELECT user_id, name, email, role FROM users WHERE user_id = ?',
        [Number(decoded.user_id)]
      );

      if (rows.length === 0) {
        return next(new Error('Account no longer exists'));
      }

      socket.user = rows[0];
      return next();
    } catch (_) {
      return next(new Error('Invalid or expired socket token'));
    }
  });

  ioInstance.on('connection', (socket) => {
    const { user_id, role } = socket.user || {};
    if (user_id) {
      socket.join(`user:${user_id}`);
    }
    if (role) {
      socket.join(`role:${role}`);
    }

    // Enforce strict booking ownership / RBAC check before joining booking room (Prevents IDOR)
    socket.on('join:booking', async (bookingId, ack) => {
      try {
        const numericBookingId = Number(bookingId);
        if (!numericBookingId || Number.isNaN(numericBookingId) || numericBookingId <= 0) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Invalid booking_id' });
          return;
        }

        const [rows] = await pool.execute(
          'SELECT booking_id, user_id FROM bookings WHERE booking_id = ?',
          [numericBookingId]
        );

        if (rows.length === 0) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Booking not found' });
          return;
        }

        const currentRole = socket.user && socket.user.role;
        const currentUserId = socket.user && socket.user.user_id;
        const isStaffOrDev = currentRole === 'Admin' || currentRole === 'Developer';

        if (!isStaffOrDev && rows[0].user_id !== currentUserId) {
          if (typeof ack === 'function') ack({ ok: false, error: 'Forbidden: Not your booking' });
          return;
        }

        socket.join(`booking:${numericBookingId}`);
        if (typeof ack === 'function') ack({ ok: true, booking_id: numericBookingId });
      } catch (_) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Failed to join booking channel' });
      }
    });
  });

  return ioInstance;
}

function getIO() {
  return ioInstance;
}

/**
 * Synchronizes active socket room memberships immediately when a user's RBAC role changes.
 */
async function syncUserSocketsRole(userId, newRole) {
  if (!ioInstance) return;
  try {
    const sockets = await ioInstance.in(`user:${Number(userId)}`).fetchSockets();
    for (const sock of sockets) {
      const prevRole = sock.user && sock.user.role;
      if (prevRole) {
        sock.leave(`role:${prevRole}`);
      }
      if (sock.user) {
        sock.user.role = newRole;
      }
      sock.join(`role:${newRole}`);
    }
  } catch (_) {}
}

/**
 * Safely emits a Socket.IO event globally or to specific rooms.
 */
function emitEvent(eventName, payload, targetRooms = null) {
  if (!ioInstance) return;
  if (Array.isArray(targetRooms) && targetRooms.length > 0) {
    ioInstance.to(targetRooms).emit(eventName, payload);
  } else if (typeof targetRooms === 'string' && targetRooms) {
    ioInstance.to(targetRooms).emit(eventName, payload);
  } else {
    ioInstance.emit(eventName, payload);
  }
}

module.exports = {
  initSocket,
  getIO,
  syncUserSocketsRole,
  emitEvent
};
