const crypto = require('crypto');
const {
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  findAccountForApiKeyHash
} = require('./db.js');

const PREFIX = 'gms_';
const BYTES = 24; // 48 hex chars after the prefix

function getSecret() {
  const secret = process.env.STATE_SECRET || process.env.API_KEY;
  if (!secret) throw new Error('Neither STATE_SECRET nor API_KEY is set');
  return secret;
}

function hashKey(plaintext) {
  return crypto.createHmac('sha256', getSecret()).update(plaintext).digest('hex');
}

function looksLikeUserKey(token) {
  return typeof token === 'string' && token.startsWith(PREFIX);
}

async function createKey({ accountEmail, label }) {
  const plaintext = PREFIX + crypto.randomBytes(BYTES).toString('hex');
  const hash = hashKey(plaintext);
  const last4 = plaintext.slice(-4);
  const id = await insertApiKey({ accountEmail, label, hash, last4 });
  return { id, plaintext, last4 };
}

async function listKeys(accountEmail) {
  return listApiKeys(accountEmail);
}

async function revokeKey({ id, accountEmail }) {
  return revokeApiKey(id, accountEmail);
}

// Returns the account_email the token belongs to, or null. Also bumps
// last_used_at on a hit.
async function resolveAccountForKey(plaintext) {
  if (!looksLikeUserKey(plaintext)) return null;
  return findAccountForApiKeyHash(hashKey(plaintext));
}

module.exports = {
  PREFIX,
  looksLikeUserKey,
  createKey,
  listKeys,
  revokeKey,
  resolveAccountForKey
};
