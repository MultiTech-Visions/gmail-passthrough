const { getPool, ensureSchema, listAccounts } = require('./db.js');

// Returns one row per enrolled account with totals + windowed counts + error counts.
async function getAccountStats() {
  await ensureSchema();
  const accounts = await listAccounts();
  if (accounts.length === 0) return [];

  const [windowed] = await getPool().query(`
    SELECT
      account_email,
      SUM(CASE WHEN status = 'ok'    AND sent_at >= NOW() - INTERVAL 1 DAY    THEN 1 ELSE 0 END) AS sends_24h,
      SUM(CASE WHEN status = 'ok'    AND sent_at >= NOW() - INTERVAL 7 DAY    THEN 1 ELSE 0 END) AS sends_7d,
      SUM(CASE WHEN status = 'ok'    AND sent_at >= NOW() - INTERVAL 30 DAY   THEN 1 ELSE 0 END) AS sends_30d,
      SUM(CASE WHEN status = 'error' AND sent_at >= NOW() - INTERVAL 30 DAY   THEN 1 ELSE 0 END) AS errors_30d
    FROM send_logs
    WHERE sent_at >= NOW() - INTERVAL 30 DAY
    GROUP BY account_email
  `);

  const byEmail = new Map();
  for (const row of windowed) byEmail.set(row.account_email, row);

  return accounts.map((a) => {
    const w = byEmail.get(a.email) || {};
    return {
      email: a.email,
      disabled: !!a.disabled,
      enrolledAt: a.enrolled_at,
      lastUsedAt: a.last_used_at,
      totalSends: Number(a.total_sends || 0),
      sends24h: Number(w.sends_24h || 0),
      sends7d: Number(w.sends_7d || 0),
      sends30d: Number(w.sends_30d || 0),
      errors30d: Number(w.errors_30d || 0)
    };
  });
}

async function getRecentSends(email, limit = 50) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 50));
  const [rows] = await getPool().query(
    `SELECT sent_at, recipient, subject, thread_id, mode, status, error_message
     FROM send_logs
     WHERE account_email = ?
     ORDER BY sent_at DESC
     LIMIT ${safeLimit}`,
    [email.toLowerCase()]
  );
  return rows;
}

async function getErrorBreakdown(email, days = 30) {
  await ensureSchema();
  const safeDays = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 30));
  const [rows] = await getPool().query(
    `SELECT error_message, COUNT(*) AS count, MAX(sent_at) AS last_seen
     FROM send_logs
     WHERE account_email = ?
       AND status = 'error'
       AND sent_at >= NOW() - INTERVAL ${safeDays} DAY
     GROUP BY error_message
     ORDER BY count DESC
     LIMIT 20`,
    [email.toLowerCase()]
  );
  return rows;
}

module.exports = { getAccountStats, getRecentSends, getErrorBreakdown };
