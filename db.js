const mysql = require('mysql2/promise');
const { log } = require('./helpers.js');

let pool = null;
let schemaReady = null;

function getPool() {
  if (pool) return pool;

  const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    timezone: 'Z'
  };

  if (instanceConnectionName) {
    config.socketPath = `/cloudsql/${instanceConnectionName}`;
  } else {
    config.host = process.env.DB_HOST || '127.0.0.1';
    config.port = Number(process.env.DB_PORT || 3306);
  }

  pool = mysql.createPool(config);
  return pool;
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const conn = getPool();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        email VARCHAR(255) NOT NULL PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME NULL,
        total_sends BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Idempotent migration for pre-existing deployments that have an accounts
    // table without the `disabled` column.
    const [cols] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'accounts' AND column_name = 'disabled'`
    );
    if (Number(cols[0].c) === 0) {
      await conn.query(`ALTER TABLE accounts ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT FALSE`);
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS send_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        recipient VARCHAR(255) NULL,
        subject TEXT NULL,
        thread_id VARCHAR(255) NULL,
        mode ENUM('new','reply') NULL,
        status ENUM('ok','error') NOT NULL,
        error_message TEXT NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_account_sent (account_email, sent_at),
        INDEX idx_status_sent (status, sent_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  })().catch((e) => {
    schemaReady = null;
    log("Error", `Schema init failed: ${e.message}`);
    throw e;
  });
  return schemaReady;
}

async function getAccount(email) {
  await ensureSchema();
  const [rows] = await getPool().query(
    'SELECT email, refresh_token, disabled, enrolled_at, last_used_at, total_sends FROM accounts WHERE email = ?',
    [email.toLowerCase()]
  );
  const row = rows[0];
  if (!row) return null;
  row.disabled = !!row.disabled;
  return row;
}

async function listAccounts() {
  await ensureSchema();
  const [rows] = await getPool().query(
    'SELECT email, disabled, enrolled_at, last_used_at, total_sends FROM accounts ORDER BY email ASC'
  );
  return rows.map((r) => ({ ...r, disabled: !!r.disabled }));
}

async function setAccountDisabled(email, disabled) {
  await ensureSchema();
  const [result] = await getPool().query(
    'UPDATE accounts SET disabled = ? WHERE email = ?',
    [disabled ? 1 : 0, email.toLowerCase()]
  );
  return result.affectedRows > 0;
}

async function upsertAccount(email, refreshToken) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO accounts (email, refresh_token) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE refresh_token = VALUES(refresh_token)`,
    [email.toLowerCase(), refreshToken]
  );
}

async function deleteAccount(email) {
  await ensureSchema();
  const [result] = await getPool().query(
    'DELETE FROM accounts WHERE email = ?',
    [email.toLowerCase()]
  );
  return result.affectedRows > 0;
}

async function recordSend({ accountEmail, recipient, subject, threadId, mode, status, errorMessage }) {
  await ensureSchema();
  const conn = await getPool().getConnection();
  try {
    await conn.query(
      `INSERT INTO send_logs (account_email, recipient, subject, thread_id, mode, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountEmail.toLowerCase(), recipient || null, subject || null, threadId || null, mode || null, status, errorMessage || null]
    );
    if (status === 'ok') {
      await conn.query(
        `UPDATE accounts SET total_sends = total_sends + 1, last_used_at = CURRENT_TIMESTAMP WHERE email = ?`,
        [accountEmail.toLowerCase()]
      );
    }
  } finally {
    conn.release();
  }
}

module.exports = {
  getPool,
  ensureSchema,
  getAccount,
  listAccounts,
  upsertAccount,
  setAccountDisabled,
  deleteAccount,
  recordSend
};
