const { google } = require('googleapis');
const { getAccount } = require('./db.js');

// Per-account OAuth2 clients are cached in-memory keyed by email. We re-check
// the database every CACHE_TTL_MS so re-enrollments / token rotation propagate.
const CACHE_TTL_MS = 60 * 1000;
const clientCache = new Map(); // email -> { client, refreshToken, fetchedAt }

let envAccountsConfig = undefined;

function getEnvAccountsConfig() {
  if (envAccountsConfig !== undefined) return envAccountsConfig;
  envAccountsConfig = process.env.ACCOUNTS_CONFIG
    ? JSON.parse(process.env.ACCOUNTS_CONFIG)
    : null;
  return envAccountsConfig;
}

async function resolveRefreshToken(emailAddress) {
  const key = emailAddress.toLowerCase();

  const row = await getAccount(key);
  if (row && row.refresh_token) {
    if (row.disabled) {
      throw new Error(`Account ${key} is disabled. The owner can re-enable it from their dashboard.`);
    }
    return row.refresh_token;
  }

  // Backwards-compatibility: legacy deployments may still keep tokens in
  // ACCOUNTS_CONFIG. Fall back to that if the DB has no entry.
  const envConf = getEnvAccountsConfig();
  if (envConf && envConf[key] && envConf[key].refreshToken) {
    return envConf[key].refreshToken;
  }

  throw new Error(`No configuration found for account: ${emailAddress}. The owner must sign in at this service to grant access.`);
}

async function getAuthClient(emailAddress) {
  const key = emailAddress.toLowerCase();
  const refreshToken = await resolveRefreshToken(key);

  const cached = clientCache.get(key);
  if (cached && cached.refreshToken === refreshToken && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.client;
  }

  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: refreshToken });

  clientCache.set(key, { client, refreshToken, fetchedAt: Date.now() });
  return client;
}

async function getGmailService(emailAddress) {
  return google.gmail({ version: 'v1', auth: await getAuthClient(emailAddress) });
}

function invalidateAuthCache(emailAddress) {
  clientCache.delete(emailAddress.toLowerCase());
}

module.exports = { getGmailService, invalidateAuthCache };
