// db.js
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const { performance } = require('perf_hooks');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pet_hotel',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

// In-memory rolling query audit log & latency tracker for Developer Console
const MAX_AUDIT_LOGS = 50;
const auditLogs = [];

function maskEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return '[REDACTED_EMAIL]';
  const local = parts[0];
  const maskedLocal = local.length <= 2 ? `${local[0] || '*'}*` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}@${parts[1]}`;
}

function sanitizeParams(sql, params) {
  if (!Array.isArray(params)) return [];
  const lowerSql = String(sql).toLowerCase();

  return params.map((val) => {
    if (typeof val !== 'string') return val;

    // Redact bcrypt hashes
    if (/^\$2[aby]\$\d{2}\$/.test(val)) {
      return '[BCRYPT_HASH]';
    }

    // Mask emails in audit memory
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      return maskEmail(val);
    }

    // Mask phone numbers in user queries
    if (lowerSql.includes('users') && /^[0-9+\-\s()]{8,20}$/.test(val)) {
      return `${val.slice(0, 3)}-***-${val.slice(-2)}`;
    }

    return val;
  });
}

function recordAudit(sql, params, latencyMs, isError = false) {
  const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
  const verbMatch = normalizedSql.match(/^([A-Z]+)/i);
  const type = verbMatch ? verbMatch[1].toUpperCase() : 'SQL';

  let status = '200 OK';
  if (isError) {
    status = 'ERROR';
  } else if (type === 'CALL') {
    status = 'SUCCESS';
  } else if (type === 'UPDATE' && /bookings/i.test(normalizedSql) && /booking_status/i.test(normalizedSql)) {
    status = 'TRIGGERED';
  }

  const now = new Date();
  const timestamp = now.toTimeString().split(' ')[0];

  auditLogs.unshift({
    timestamp,
    type,
    statement: normalizedSql,
    params: sanitizeParams(normalizedSql, params),
    latencyMs: Number(latencyMs.toFixed(2)),
    status
  });

  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.pop();
  }
}

const rawExecute = pool.execute.bind(pool);
const rawQuery = pool.query.bind(pool);
const rawGetConnection = pool.getConnection.bind(pool);

pool.execute = async function instrumentedExecute(sql, params = []) {
  const start = performance.now();
  try {
    const result = await rawExecute(sql, params);
    recordAudit(sql, params, performance.now() - start, false);
    return result;
  } catch (err) {
    recordAudit(sql, params, performance.now() - start, true);
    throw err;
  }
};

pool.query = async function instrumentedQuery(sql, params = []) {
  const start = performance.now();
  try {
    const result = await rawQuery(sql, params);
    recordAudit(sql, params, performance.now() - start, false);
    return result;
  } catch (err) {
    recordAudit(sql, params, performance.now() - start, true);
    throw err;
  }
};

pool.getConnection = async function instrumentedGetConnection() {
  const conn = await rawGetConnection();
  const connRawExecute = conn.execute.bind(conn);
  const connRawQuery = conn.query.bind(conn);

  conn.execute = async function wrappedConnExecute(sql, params = []) {
    const start = performance.now();
    try {
      const result = await connRawExecute(sql, params);
      recordAudit(sql, params, performance.now() - start, false);
      return result;
    } catch (err) {
      recordAudit(sql, params, performance.now() - start, true);
      throw err;
    }
  };

  conn.query = async function wrappedConnQuery(sql, params = []) {
    const start = performance.now();
    try {
      const result = await connRawQuery(sql, params);
      recordAudit(sql, params, performance.now() - start, false);
      return result;
    } catch (err) {
      recordAudit(sql, params, performance.now() - start, true);
      throw err;
    }
  };

  return conn;
};

pool.getPoolMetrics = function getPoolMetrics() {
  const internalPool = pool.pool || {};
  const maxPoolSize = (internalPool.config && internalPool.config.connectionLimit) || 10;
  const allConns = Array.isArray(internalPool._allConnections) ? internalPool._allConnections.length : 0;
  const freeConns = Array.isArray(internalPool._freeConnections) ? internalPool._freeConnections.length : 0;
  const activeConnections = Math.max(0, allConns - freeConns);
  const idleConnections = freeConns;

  const avgLatencyMs = auditLogs.length > 0
    ? Number((auditLogs.reduce((acc, item) => acc + item.latencyMs, 0) / auditLogs.length).toFixed(1))
    : 0.0;

  return {
    maxPoolSize,
    totalConnections: allConns,
    activeConnections,
    idleConnections,
    avgLatencyMs,
    auditLogs
  };
};

module.exports = pool;
