const crypto = require('crypto');
const { google } = require('googleapis');

const LOGIN_SCOPES   = ['openid', 'email', 'profile'];
const CONNECT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VALID_ACTIONS = new Set(['login', 'connect']);

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
// Payload: { action: 'login' | 'connect', exp, nonce, returnTo? }.
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
  if (!VALID_ACTIONS.has(payload.action)) throw new Error(`Invalid action: ${payload.action}`);
  return payload;
}

function buildAuthUrl(action, extraStatePayload = {}) {
  if (!VALID_ACTIONS.has(action)) throw new Error(`Invalid action: ${action}`);
  const client = buildOAuthClient();
  const state = signState({ action, ...extraStatePayload });
  const scope = action === 'login' ? LOGIN_SCOPES : CONNECT_SCOPES;

  const opts = {
    access_type: 'offline',
    scope,
    state,
    include_granted_scopes: true
  };
  // For `connect` we must force the consent screen so Google always returns a
  // refresh_token. For `login` we don't need a refresh_token, so we can skip
  // the prompt for a smoother UX.
  if (action === 'connect') opts.prompt = 'consent';

  return client.generateAuthUrl(opts);
}

// Login: verify the id_token Google returned and pull the email claim out of
// it. No Gmail scopes needed.
async function exchangeLoginCode(code) {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error('Google did not return an id_token; cannot identify user.');
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
  return { email: payload.email.toLowerCase() };
}

// Connect: exchange the code for a refresh_token and look up the email via
// gmail.users.getProfile (we have the gmail scopes here).
async function exchangeConnectCode(code) {
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
  exchangeLoginCode,
  exchangeConnectCode,
  revokeToken,
  getRedirectUri
};
