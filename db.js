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
        reply_to VARCHAR(255) NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_account_sent (account_email, sent_at),
        INDEX idx_status_sent (status, sent_at),
        INDEX idx_account_replyto (account_email, reply_to)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migration for pre-existing deployments missing reply_to.
    const [logCols] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'send_logs' AND column_name = 'reply_to'`
    );
    if (Number(logCols[0].c) === 0) {
      await conn.query(`ALTER TABLE send_logs ADD COLUMN reply_to VARCHAR(255) NULL`);
      await conn.query(`ALTER TABLE send_logs ADD INDEX idx_account_replyto (account_email, reply_to)`);
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_email VARCHAR(255) NOT NULL,
        label VARCHAR(255) NULL,
        hash CHAR(64) NOT NULL,
        last4 VARCHAR(4) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME NULL,
        UNIQUE KEY uniq_hash (hash),
        INDEX idx_account (account_email)
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

// ---- API keys --------------------------------------------------------------
// Keys are looked up by their HMAC hash; the plaintext is never stored.

async function insertApiKey({ accountEmail, label, hash, last4 }) {
  await ensureSchema();
  const [result] = await getPool().query(
    `INSERT INTO api_keys (account_email, label, hash, last4) VALUES (?, ?, ?, ?)`,
    [accountEmail.toLowerCase(), label || null, hash, last4]
  );
  return result.insertId;
}

async function listApiKeys(accountEmail) {
  await ensureSchema();
  const [rows] = await getPool().query(
    `SELECT id, label, last4, created_at, last_used_at
     FROM api_keys
     WHERE account_email = ?
     ORDER BY created_at DESC`,
    [accountEmail.toLowerCase()]
  );
  return rows;
}

async function revokeApiKey(id, accountEmail) {
  await ensureSchema();
  const [result] = await getPool().query(
    `DELETE FROM api_keys WHERE id = ? AND account_email = ?`,
    [Number(id), accountEmail.toLowerCase()]
  );
  return result.affectedRows > 0;
}

// Look up an API key by its hash and bump last_used_at. Returns the account
// email the key belongs to, or null if not found.
async function findAccountForApiKeyHash(hash) {
  await ensureSchema();
  const conn = await getPool().getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT id, account_email FROM api_keys WHERE hash = ?`,
      [hash]
    );
    if (rows.length === 0) return null;
    const { id, account_email } = rows[0];
    await conn.query(
      `UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    ).catch(() => {}); // not fatal
    return account_email;
  } finally {
    conn.release();
  }
}

async function deleteApiKeysForAccount(accountEmail) {
  await ensureSchema();
  await getPool().query(
    `DELETE FROM api_keys WHERE account_email = ?`,
    [accountEmail.toLowerCase()]
  );
}

async function recordSend({ accountEmail, recipient, subject, threadId, mode, status, errorMessage, replyTo }) {
  await ensureSchema();
  const conn = await getPool().getConnection();
  try {
    await conn.query(
      `INSERT INTO send_logs (account_email, recipient, subject, thread_id, mode, status, error_message, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountEmail.toLowerCase(), recipient || null, subject || null, threadId || null, mode || null, status, errorMessage || null, replyTo || null]
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
  recordSend,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  findAccountForApiKeyHash,
  deleteApiKeysForAccount
};
