const crypto = require('crypto');

// Signed, HttpOnly session cookie. Payload is small: { email, exp }. We trust
// the cookie because the signature is HMAC'd with STATE_SECRET; no server-side
// session store needed.

const COOKIE_NAME = 'gms_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret() {
  const secret = process.env.STATE_SECRET || process.env.API_KEY;
  if (!secret) throw new Error('Neither STATE_SECRET nor API_KEY is set');
  return secret;
}

function sign(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(b64).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  if (!payload.email) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verify(cookies[COOKIE_NAME]);
}

function setSession(res, email) {
  const token = sign({ email: email.toLowerCase(), exp: Date.now() + TTL_MS });
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`
  ];
  res.set('Set-Cookie', attrs.join('; '));
}

function clearSession(res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  res.set('Set-Cookie', attrs.join('; '));
}

// Static CSRF token derived from STATE_SECRET; embedded in user-facing forms.
// Same pattern as the admin one but in a different namespace so the values
// don't collide.
function getCsrfToken() {
  return crypto.createHmac('sha256', getSecret()).update('user-csrf').digest('hex');
}

function verifyCsrfToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = getCsrfToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  getSession,
  setSession,
  clearSession,
  getCsrfToken,
  verifyCsrfToken
};
