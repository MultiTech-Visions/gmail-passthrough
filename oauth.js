const crypto = require('crypto');
const { google } = require('googleapis');

// Scopes we request during enrollment. gmail.send is the minimum to send;
// gmail.modify lets us look up thread metadata for in-thread replies.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VALID_ACTIONS = new Set(['enroll', 'unenroll-self']);

function getStateSecret() {
  const secret = process.env.STATE_SECRET || process.env.API_KEY;
  if (!secret) throw new Error('Neither STATE_SECRET nor API_KEY is set');
  return secret;
}

function getRedirectUri() {
  const uri = process.env.OAUTH_REDIRECT_URI;
  if (!uri) throw new Error('OAUTH_REDIRECT_URI env var not set');
  return uri;
}

function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    getRedirectUri()
  );
}

// Stateless signed state token: base64url(payload).hex(hmac(payload)).
// Payload is JSON: { action, target?, exp, nonce }.
function signState(payload) {
  const json = JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') });
  const b64 = Buffer.from(json, 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verifyState(token) {
  if (!token || typeof token !== 'string') throw new Error('Missing state');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Malformed state');
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', getStateSecret()).update(b64).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('Invalid state signature');
  }
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
  if (!payload.exp || Date.now() > payload.exp) throw new Error('State expired');
  return payload;
}

function buildAuthUrl(state) {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',  // force Google to return a refresh_token even if user has consented before
    scope: SCOPES,
    state,
    include_granted_scopes: true
  });
}

async function exchangeCode(code) {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token. The account may have already granted access; revoke at https://myaccount.google.com/permissions and try again.');
  }
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = (profile.data.emailAddress || '').toLowerCase();
  if (!email) throw new Error('Could not determine email address from Google profile');
  return { email, refreshToken: tokens.refresh_token };
}

async function revokeToken(refreshToken) {
  // Returns true if Google accepts the revoke; otherwise logs and returns false.
  const params = new URLSearchParams({ token: refreshToken });
  const resp = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  return resp.ok;
}

// HMAC of a fixed string with STATE_SECRET. Embedded in admin forms to defend
// against CSRF: a cross-origin page can't read the dashboard HTML to lift this
// value, but a logged-in admin's browser will submit it correctly.
function getAdminCsrfToken() {
  return crypto.createHmac('sha256', getStateSecret()).update('admin-csrf').digest('hex');
}

function verifyAdminCsrfToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = getAdminCsrfToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  signState,
  verifyState,
  buildAuthUrl,
  exchangeCode,
  revokeToken,
  getRedirectUri,
  getAdminCsrfToken,
  verifyAdminCsrfToken,
  VALID_ACTIONS
};
