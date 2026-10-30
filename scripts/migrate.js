// scripts/migrate.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function splitSqlStatements(sqlText) {
  const lines = sqlText.split(/\r?\n/);
  let delimiter = ';';
  let buffer = '';
  const statements = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) {
      continue;
    }

    const delimMatch = trimmed.match(/^DELIMITER\s+(\S+)$/i);
    if (delimMatch) {
      delimiter = delimMatch[1];
      continue;
    }

    buffer += (buffer ? '\n' : '') + line;
    if (buffer.trimEnd().endsWith(delimiter)) {
      const stmt = buffer.trimEnd().slice(0, -delimiter.length).trim();
      if (stmt) {
        statements.push(stmt);
      }
      buffer = '';
    }
  }

  if (buffer.trim()) {
    statements.push(buffer.trim());
  }

  return statements;
}

async function runMigration() {
  const dbName = process.env.DB_NAME || 'pet_hotel';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName
  });

  try {
    // 001: Pet upload columns
    const [petCols] = await conn.execute(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, 'pets']
    );
    const existingPetCols = new Set(petCols.map((c) => c.COLUMN_NAME));

    if (!existingPetCols.has('photo_url')) {
      await conn.execute('ALTER TABLE pets ADD COLUMN photo_url VARCHAR(255) DEFAULT NULL AFTER medical_notes');
      console.log('Added column pets.photo_url');
    }

    if (!existingPetCols.has('vaccine_card_url')) {
      await conn.execute('ALTER TABLE pets ADD COLUMN vaccine_card_url VARCHAR(255) DEFAULT NULL AFTER photo_url');
      console.log('Added column pets.vaccine_card_url');
    }

    // Normalize legacy '/uploads/sample-vaccine-*' paths to filename
    await conn.execute(
      "UPDATE pets SET vaccine_card_url = REPLACE(vaccine_card_url, '/uploads/', '') WHERE vaccine_card_url LIKE '/uploads/%'"
    );

    // 002: Booking payment verification columns + Hardened Triggers & Stored Procedure
    const [bookingCols] = await conn.execute(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, 'bookings']
    );
    const existingBookingCols = new Set(bookingCols.map((c) => c.COLUMN_NAME));

    if (!existingBookingCols.has('payment_status')) {
      await conn.execute(
        "ALTER TABLE bookings ADD COLUMN payment_status ENUM('Unpaid', 'Pending_Verification', 'Paid') NOT NULL DEFAULT 'Unpaid' AFTER booking_status"
      );
      await conn.execute(
        "UPDATE bookings SET payment_status = 'Paid' WHERE booking_status IN ('Confirmed', 'Completed')"
      );
      console.log('Added column bookings.payment_status');
    }

    if (!existingBookingCols.has('payment_slip_url')) {
      await conn.execute(
        'ALTER TABLE bookings ADD COLUMN payment_slip_url VARCHAR(255) DEFAULT NULL AFTER payment_status'
      );
      console.log('Added column bookings.payment_slip_url');
    }

    // Re-apply hardened triggers & stored procedure from migration 002
    const mig002Path = path.join(__dirname, '..', 'sql', 'migrations', '002_security_and_logic_hardening.sql');
    const mig002Sql = fs.readFileSync(mig002Path, 'utf8');
    const routineStatements = splitSqlStatements(mig002Sql).filter(
      (stmt) => !/^ALTER\s+TABLE/i.test(stmt) && !/^UPDATE\s+bookings/i.test(stmt) && !/^USE\s+/i.test(stmt)
    );

    for (const stmt of routineStatements) {
      await conn.query(stmt);
    }

    console.log('Migrations 001 & 002 (schema + hardened triggers + idempotent stored procedure) completed successfully!');
  } finally {
    await conn.end();
  }
}

runMigration().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
