// scripts/seed.js
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

async function runSeed() {
  const sqlFile = path.join(__dirname, '..', 'sql', 'schema_and_seed.sql');
  const sqlContent = fs.readFileSync(sqlFile, 'utf8');
  const statements = splitSqlStatements(sqlContent);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  });

  try {
    console.log(`Executing ${statements.length} SQL statements from sql/schema_and_seed.sql...`);
    for (const stmt of statements) {
      await connection.query(stmt);
    }
    console.log('Database "pet_hotel" schema, trigger, stored procedure, and seed data initialized successfully!');
  } finally {
    await connection.end();
  }
}

runSeed().catch((err) => {
  console.error('Database seed failed:', err.message);
  process.exit(1);
});
