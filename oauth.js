const crypto = require('crypto');
const { google } = require('googleapis');

// One OAuth flow grants everything we need at sign-in time:
//   - openid / email / profile  → identify the user, get a signed id_token
//   - gmail.send / gmail.modify → send mail and look up thread metadata
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const STATE_TTL_MS = 10 * 60 * 1000;

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

function signState() {
  const payload = { exp: Date.now() + STATE_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
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

function buildAuthUrl() {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // Force the consent screen on every sign-in so Google always returns a
    // fresh refresh_token (otherwise returning users would get only an
    // id_token, with no way to rotate the stored token).
    prompt: 'consent',
    scope: SCOPES,
    state: signState(),
    include_granted_scopes: true
  });
}

// Exchange the authorization code for both:
//   - an id_token  → email of the signed-in user (verified)
//   - a refresh_token → ability to send as that user later
async function exchangeCode(code) {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error('Google did not return an id_token; cannot identify user.');
  }
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. The account may already have an active grant; ' +
      'remove it at https://myaccount.google.com/permissions and try again.'
    );
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GMAIL_CLIENT_ID
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error('Google id_token did not include an email claim.');
  }
  if (payload.email_verified === false) {
    throw new Error('Google reports this email is not verified.');
  }

  return {
    email: payload.email.toLowerCase(),
    refreshToken: tokens.refresh_token
  };
}

async function revokeToken(refreshToken) {
  const params = new URLSearchParams({ token: refreshToken });
  const resp = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  return resp.ok;
}

module.exports = {
  signState,
  verifyState,
  buildAuthUrl,
  exchangeCode,
  revokeToken,
  getRedirectUri
};
