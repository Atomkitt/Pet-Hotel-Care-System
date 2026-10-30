// app.js
require('dotenv').config({ quiet: true });
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { initSocket } = require('./socket');
const { UPLOAD_DIR } = require('./middleware/upload');
const { createCsrfOriginGuard } = require('./middleware/security');

const authRoutes = require('./routes/auth.routes');
const petsRoutes = require('./routes/pets.routes');
const roomsRoutes = require('./routes/rooms.routes');
const bookingsRoutes = require('./routes/bookings.routes');
const logsRoutes = require('./routes/logs.routes');
const paymentsRoutes = require('./routes/payments.routes');
const devRoutes = require('./routes/dev.routes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Configure reverse-proxy IP trust so rate limiting keys per client IP behind Nginx/Cloudflare/Render
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// 1. Strict Security HTTP Headers (No 'unsafe-inline' scripts or inline event attributes)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    }
  })
);

// 2. CORS with Cookie Credential Support
const allowedOrigins = (process.env.CORS_ORIGIN || `http://localhost:${PORT}`)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const corsErr = new Error('Not allowed by CORS policy');
      corsErr.status = 403;
      return callback(corsErr);
    },
    credentials: true
  })
);

// 3. Body & Cookie Parsers
app.use(cookieParser());
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

// 4. Defense-in-depth CSRF Origin / Referer Verification for state-changing API calls
app.use('/api', createCsrfOriginGuard(allowedOrigins));

// 5. Rate Limiting on /api/auth/*
const authRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to auth service. Please wait and try again.' }
});
app.use('/api/auth', authRouteLimiter);

// 6. Static Pet Avatar Images & Fallback Route (/uploads/*)
// Sensitive files (vaccine certificates & payment slips) are stored outside public/ and served via authenticated APIs
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1d' }));
app.use('/uploads', (req, res) => {
  res.status(404).json({ error: 'Requested uploaded image was not found.' });
});

// 7. Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 8. REST API Routes
app.use('/api/auth', authRoutes);
app.use('/api/pets', petsRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api', devRoutes);

// Global error fallback (Hides internal stack/driver details in production)
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error('[Unhandled Server Error]:', err.message);
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
  return res.status(status).json({
    error: err.message || 'Internal Server Error'
  });
});

// 9. HTTP Server + Socket.IO Real-Time Engine
const server = http.createServer(app);
initSocket(server, allowedOrigins);
app.server = server;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`PawStay Real-Time Server is running at: http://localhost:${PORT}`);
  });
}

module.exports = app;
