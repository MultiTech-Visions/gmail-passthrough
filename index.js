const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { getGmailService, invalidateAuthCache } = require('./google-auth.js');
const { sendEmail } = require('./sender.js');
const { log } = require('./helpers.js');
const { getAccount, upsertAccount, setAccountDisabled, deleteAccount, recordSend, deleteApiKeysForAccount } = require('./db.js');
const { verifyState, buildAuthUrl, exchangeCode, revokeToken } = require('./oauth.js');
const { getAccountStats, getRecentSends, getErrorBreakdown } = require('./stats.js');
const { getSession, setSession, clearSession, getCsrfToken, verifyCsrfToken } = require('./session.js');
const apikeys = require('./apikeys.js');
const pages = require('./pages.js');


functions.http('gmailSender', async (req, res) => {
  try {
    const path = req.path || '/';
    const method = req.method;

    if (method === 'GET' && path === '/healthz') {
      return res.status(200).send('OK');
    }

    // ---- User-facing -------------------------------------------------------
    if (method === 'GET'  && path === '/')                return handleHome(req, res);
    if (method === 'GET'  && path === '/login')           return handleLoginPage(req, res);
    if (method === 'GET'  && path === '/login/start')     return handleOAuthStart(req, res);
    if (method === 'GET'  && path === '/oauth/callback')  return handleOAuthCallback(req, res);
    if (method === 'POST' && path === '/disable')         return handleDisable(req, res);
    if (method === 'POST' && path === '/enable')          return handleEnable(req, res);
    if (method === 'POST' && path === '/remove')          return handleRemove(req, res);
    if (method === 'POST' && path === '/logout')          return handleLogout(req, res);
    if (method === 'POST' && path === '/keys/create')     return handleCreateKey(req, res);
    if (method === 'POST' && path === '/keys/revoke')     return handleRevokeKey(req, res);

    // ---- Admin (Basic / Bearer / X-API-Key) --------------------------------
    if (method === 'GET'  && path === '/admin/accounts') {
      if (!requireAdmin(req, res)) return;
      return handleAdminDashboard(req, res);
    }
    if (method === 'POST' && path === '/admin/unenroll') {
      if (!requireAdmin(req, res)) return;
      return handleAdminUnenroll(req, res);
    }
    if (method === 'GET'  && path === '/api/stats') {
      if (!requireAdmin(req, res)) return;
      return handleApiStats(req, res);
    }

    // ---- /send -------------------------------------------------------------
    if (path === '/send') {
      return handleSend(req, res);
    }

    return res.status(404).json({ error: `Unknown route: ${path}` });
  } catch (e) {
    log("Error", `Top-level error: ${e.stack}`);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});


// ---- Auth helpers -----------------------------------------------------------

function timingSafeEqStr(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isApiKeyAuthorized(req) {
  const expected = process.env.API_KEY;
  if (!expected) {
    log("Error", "API_KEY env var not set — rejecting request.");
    return false;
  }
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const provided = bearer || req.get('x-api-key') || '';
  if (!provided) return false;
  return timingSafeEqStr(provided, expected);
}

function requireAdmin(req, res) {
  const expected = process.env.API_KEY;
  if (!expected) {
    res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
    return false;
  }
  if (isApiKeyAuthorized(req)) return true;

  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ') && adminUser && adminPass) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (timingSafeEqStr(user, adminUser) && timingSafeEqStr(pass, adminPass)) return true;
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Gmail Sender Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required.');
  return false;
}


// ---- Home / login -----------------------------------------------------------

async function handleHome(req, res) {
  const session = getSession(req);
  if (!session) return res.status(200).type('html').send(pages.loginPage());
  return renderUserDashboard(req, res, session.email);
}

function handleLoginPage(req, res) {
  const session = getSession(req);
  if (session) return res.redirect(302, '/');
  return res.status(200).type('html').send(pages.loginPage());
}

function handleLogout(req, res) {
  const csrf = (req.body && req.body.csrf) || '';
  if (!verifyCsrfToken(csrf)) {
    return res.status(403).type('html').send(pages.errorPage('Invalid CSRF token. Reload and try again.', { signedIn: !!getSession(req) }));
  }
  clearSession(res);
  return res.redirect(302, '/login');
}


// ---- OAuth ------------------------------------------------------------------
// One flow: openid+profile+gmail.send+gmail.modify scopes, prompt=consent so
// Google always returns a fresh refresh_token. The callback verifies the
// id_token for identity AND saves the refresh_token for sending.

function handleOAuthStart(req, res) {
  try {
    return res.redirect(302, buildAuthUrl());
  } catch (e) {
    log("Error", `OAuth start failed: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(e.message));
  }
}

async function handleOAuthCallback(req, res) {
  const code = req.query.code ? req.query.code.toString() : '';
  const stateStr = req.query.state ? req.query.state.toString() : '';
  const oauthError = req.query.error ? req.query.error.toString() : '';

  if (oauthError) {
    return res.status(400).type('html').send(pages.errorPage(`Google returned an error: ${oauthError}`));
  }
  if (!code) {
    return res.status(400).type('html').send(pages.errorPage('Missing authorization code.'));
  }

  try {
    verifyState(stateStr);
  } catch (e) {
    return res.status(400).type('html').send(pages.errorPage(`Invalid state: ${e.message}`));
  }

  let result;
  try {
    result = await exchangeCode(code);
  } catch (e) {
    log("Error", `Code exchange failed: ${e.message}`);
    return res.status(400).type('html').send(pages.errorPage(`Sign-in failed: ${e.message}`));
  }

  const { email, refreshToken } = result;

  try {
    // upsert: keeps existing `disabled` flag for returning users, rotates token
    await upsertAccount(email, refreshToken);
    invalidateAuthCache(email);
    setSession(res, email);
    log("Info", `Signed in: ${email}`);
    return res.redirect(302, '/');
  } catch (e) {
    log("Error", `Could not save sign-in for ${email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not complete sign-in: ${e.message}`));
  }
}


// ---- Disable / Enable / Remove ----------------------------------------------

function requireUserCsrf(req, res) {
  const session = getSession(req);
  if (!session) {
    res.redirect(302, '/login');
    return null;
  }
  const csrf = (req.body && req.body.csrf) || '';
  if (!verifyCsrfToken(csrf)) {
    res.status(403).type('html').send(pages.errorPage('Invalid CSRF token. Reload and try again.', { signedIn: true }));
    return null;
  }
  return session;
}

async function handleDisable(req, res) {
  const session = requireUserCsrf(req, res);
  if (!session) return;
  try {
    await setAccountDisabled(session.email, true);
    invalidateAuthCache(session.email);
    log("Info", `Disabled ${session.email}`);
    return res.redirect(302, '/');
  } catch (e) {
    log("Error", `Disable failed for ${session.email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not pause sending: ${e.message}`, { signedIn: true }));
  }
}

async function handleEnable(req, res) {
  const session = requireUserCsrf(req, res);
  if (!session) return;
  try {
    await setAccountDisabled(session.email, false);
    invalidateAuthCache(session.email);
    log("Info", `Enabled ${session.email}`);
    return res.redirect(302, '/');
  } catch (e) {
    log("Error", `Enable failed for ${session.email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not resume sending: ${e.message}`, { signedIn: true }));
  }
}

async function handleRemove(req, res) {
  const session = requireUserCsrf(req, res);
  if (!session) return;
  try {
    const existing = await getAccount(session.email);
    if (existing) {
      const ok = await revokeToken(existing.refresh_token);
      if (!ok) log("Info", `Token revoke for ${session.email} returned non-OK; deleting row anyway.`);
      await deleteApiKeysForAccount(session.email);
      await deleteAccount(session.email);
      invalidateAuthCache(session.email);
      log("Info", `Removed ${session.email}`);
    }
    clearSession(res);
    return res.redirect(302, '/login');
  } catch (e) {
    log("Error", `Remove failed for ${session.email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not remove account: ${e.message}`, { signedIn: true }));
  }
}


// ---- API keys (user) -------------------------------------------------------

async function handleCreateKey(req, res) {
  const session = requireUserCsrf(req, res);
  if (!session) return;
  const rawLabel = (req.body && req.body.label) || '';
  const label = rawLabel.toString().slice(0, 255).trim() || null;
  try {
    const { plaintext, last4 } = await apikeys.createKey({ accountEmail: session.email, label });
    log("Info", `Created API key for ${session.email} (last4=${last4})`);
    // Re-render the dashboard with the plaintext shown once.
    return renderUserDashboard(req, res, session.email, { newKey: { plaintext, label } });
  } catch (e) {
    log("Error", `Create key failed for ${session.email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not create key: ${e.message}`, { signedIn: true }));
  }
}

async function handleRevokeKey(req, res) {
  const session = requireUserCsrf(req, res);
  if (!session) return;
  const id = (req.body && req.body.id) || '';
  if (!id) return res.status(400).type('html').send(pages.errorPage('Missing key id.', { signedIn: true }));
  try {
    const ok = await apikeys.revokeKey({ id, accountEmail: session.email });
    if (!ok) return res.status(404).type('html').send(pages.errorPage('Key not found.', { signedIn: true }));
    log("Info", `Revoked API key id=${id} for ${session.email}`);
    return res.redirect(302, '/');
  } catch (e) {
    log("Error", `Revoke key failed for ${session.email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not revoke key: ${e.message}`, { signedIn: true }));
  }
}


// ---- User dashboard ---------------------------------------------------------

async function renderUserDashboard(req, res, email, opts = {}) {
  try {
    const [allStats, keys] = await Promise.all([
      getAccountStats(),
      apikeys.listKeys(email)
    ]);
    const summary = allStats.find((s) => s.email === email) || null;

    let recent = [], errors = [];
    if (summary) {
      [recent, errors] = await Promise.all([
        getRecentSends(email, 50),
        getErrorBreakdown(email, 30)
      ]);
    }

    res.status(200).type('html').send(pages.userDashboard({
      email,
      csrfToken: getCsrfToken(),
      summary,
      recent,
      errors,
      keys,
      newKey: opts.newKey || null
    }));
  } catch (e) {
    log("Error", `User dashboard failed for ${email}: ${e.message}`);
    res.status(500).type('html').send(pages.errorPage(`Could not load your account: ${e.message}`, { signedIn: true }));
  }
}


// ---- Admin ------------------------------------------------------------------

async function handleAdminDashboard(req, res) {
  try {
    const stats = await getAccountStats();
    res.status(200).type('html').send(pages.adminDashboard(stats, getAdminCsrf()));
  } catch (e) {
    log("Error", `Admin dashboard failed: ${e.message}`);
    res.status(500).type('html').send(pages.errorPage(`Could not load accounts: ${e.message}`));
  }
}

async function handleAdminUnenroll(req, res) {
  const body = req.body || {};
  const email = (body.email || '').toString().toLowerCase();
  const csrf  = (body.csrf  || '').toString();

  if (!email) return res.status(400).type('html').send(pages.errorPage('Missing email.'));
  if (!verifyAdminCsrf(csrf)) return res.status(403).type('html').send(pages.errorPage('Invalid CSRF token.'));

  try {
    const existing = await getAccount(email);
    if (!existing) return res.status(404).type('html').send(pages.errorPage(`No such account: ${email}`));
    const ok = await revokeToken(existing.refresh_token);
    if (!ok) log("Info", `Token revoke for ${email} returned non-OK; deleting row anyway.`);
    await deleteApiKeysForAccount(email);
    await deleteAccount(email);
    invalidateAuthCache(email);
    log("Info", `Admin-unenrolled ${email}`);
    return res.redirect(302, '/admin/accounts');
  } catch (e) {
    log("Error", `Admin unenroll failed for ${email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not unenroll: ${e.message}`));
  }
}

function getAdminCsrf() {
  return crypto.createHmac('sha256', process.env.STATE_SECRET || process.env.API_KEY).update('admin-csrf').digest('hex');
}
function verifyAdminCsrf(token) {
  if (!token) return false;
  const expected = getAdminCsrf();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}


// ---- Stats API (admin) -----------------------------------------------------

async function handleApiStats(req, res) {
  const email = req.query.email ? req.query.email.toString().toLowerCase() : '';
  try {
    const all = await getAccountStats();
    if (!email) return res.status(200).json({ accounts: all });

    const summary = all.find((s) => s.email === email);
    if (!summary) return res.status(404).json({ error: `No such account: ${email}` });

    const [recent, errors] = await Promise.all([
      getRecentSends(email, 50),
      getErrorBreakdown(email, 30)
    ]);
    return res.status(200).json({ summary, recent, errors });
  } catch (e) {
    log("Error", `Stats API failed: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}


// ---- /send ------------------------------------------------------------------

// Extracts the bearer-style credential from either Authorization: Bearer …
// or X-API-Key: … . Returns null if missing.
function extractSendCredential(req) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return bearer || req.get('x-api-key') || null;
}

// Resolves which Gmail account a /send request is allowed to act as.
// Returns { accountEmail } on success, { error, status } on failure.
async function resolveSendAuth(req) {
  const credential = extractSendCredential(req);
  if (!credential) return { error: 'Unauthorized', status: 401 };

  // Per-user API keys (preferred). The key identifies the account.
  if (apikeys.looksLikeUserKey(credential)) {
    const keyAccount = await apikeys.resolveAccountForKey(credential);
    if (!keyAccount) return { error: 'Unauthorized', status: 401 };

    const bodyEmail = (req.body && req.body.accountEmail || '').toString().toLowerCase();
    if (bodyEmail && bodyEmail !== keyAccount) {
      return { error: `API key does not have permission to send as ${bodyEmail}`, status: 403 };
    }
    return { accountEmail: keyAccount };
  }

  // Legacy fallback: shared API_KEY. Caller must specify accountEmail in body.
  if (isApiKeyAuthorized(req)) {
    const bodyEmail = (req.body && req.body.accountEmail || '').toString().toLowerCase();
    if (!bodyEmail) return { error: 'Missing required field: accountEmail', status: 400 };
    return { accountEmail: bodyEmail };
  }

  return { error: 'Unauthorized', status: 401 };
}

async function handleSend(req, res) {
  const auth = await resolveSendAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const body = req.body || {};
  const { threadId, recipientEmail, subject, htmlBody } = body;
  const emailBody = body.body;
  const accountEmail = auth.accountEmail;

  if (!emailBody) return res.status(400).json({ error: "Missing required field: body" });
  if (!threadId && !recipientEmail) {
    return res.status(400).json({ error: "Must provide threadId or recipientEmail" });
  }

  let gmail;
  try {
    gmail = await getGmailService(accountEmail);
  } catch (e) {
    await recordSend({
      accountEmail, recipient: recipientEmail, subject, threadId,
      mode: null, status: 'error', errorMessage: e.message
    }).catch(() => {});
    return res.status(400).json({ error: e.message });
  }

  try {
    const result = await sendEmail({ gmail, threadId, recipientEmail, subject, body: emailBody, htmlBody });
    await recordSend({
      accountEmail,
      recipient: result.to,
      subject: result.subject,
      threadId: result.threadId,
      mode: result.mode,
      status: 'ok'
    }).catch((e) => log("Error", `Failed to record send log: ${e.message}`));
    return res.status(200).json({ status: "ok", ...result });
  } catch (e) {
    log("Error", `[${accountEmail}] Send failed: ${e.stack}`);
    await recordSend({
      accountEmail,
      recipient: recipientEmail,
      subject,
      threadId,
      mode: null,
      status: 'error',
      errorMessage: e.message
    }).catch(() => {});
    return res.status(500).json({ status: "error", error: e.message });
  }
}
