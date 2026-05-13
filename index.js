const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { getGmailService, invalidateAuthCache } = require('./google-auth.js');
const { sendEmail } = require('./sender.js');
const { log } = require('./helpers.js');
const { getAccount, listAccounts, upsertAccount, deleteAccount, recordSend } = require('./db.js');
const {
  signState, verifyState, buildAuthUrl, exchangeCode, revokeToken,
  getAdminCsrfToken, verifyAdminCsrfToken
} = require('./oauth.js');
const { getAccountStats, getRecentSends, getErrorBreakdown } = require('./stats.js');
const pages = require('./pages.js');


functions.http('gmailSender', async (req, res) => {
  try {
    const path = req.path || '/';
    const method = req.method;

    // Health check
    if (method === 'GET' && path === '/') {
      return res.status(200).send('OK');
    }

    // ---- Public routes (self-serve) -----------------------------------------
    if (method === 'GET' && path === '/enroll')           return handleEnrollLanding(req, res);
    if (method === 'GET' && path === '/oauth/start')      return handleOAuthStart(req, res);
    if (method === 'GET' && path === '/oauth/callback')   return handleOAuthCallback(req, res);

    // ---- Admin-only routes --------------------------------------------------
    if (method === 'GET' && path === '/accounts') {
      if (!requireAdmin(req, res)) return;
      return handleAccountsDashboard(req, res);
    }
    if (method === 'GET' && path === '/account') {
      if (!requireAdmin(req, res)) return;
      return handleAccountDetail(req, res);
    }
    if (method === 'GET' && path === '/api/stats') {
      if (!requireAdmin(req, res)) return;
      return handleApiStats(req, res);
    }
    if (method === 'POST' && path === '/admin/unenroll') {
      if (!requireAdmin(req, res)) return;
      return handleAdminUnenroll(req, res);
    }

    // ---- /send (existing API_KEY) ------------------------------------------
    if (path === '/send') {
      if (!isApiKeyAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
      return handleSend(req, res);
    }

    return res.status(404).json({ error: `Unknown route: ${path}` });
  } catch (e) {
    log("Error", `Top-level error: ${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});


// ---- Auth -------------------------------------------------------------------

function timingSafeEqStr(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// `Authorization: Bearer <key>` or `X-API-Key: <key>`. Used by /send.
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

// Admin auth accepts API_KEY via Bearer / X-API-Key (for scripts) OR HTTP Basic
// auth (so a browser prompts the user for credentials when they visit the
// dashboard). On failure, sets WWW-Authenticate so the browser shows the login
// dialog. Returns true if authorized; on false the response has been sent and
// the caller should stop processing.
function requireAdmin(req, res) {
  const expected = process.env.API_KEY;
  if (!expected) {
    log("Error", "API_KEY env var not set — rejecting admin request.");
    res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
    return false;
  }

  if (isApiKeyAuthorized(req)) return true;

  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    if (pass && timingSafeEqStr(pass, expected)) return true;
  }

  res.set('WWW-Authenticate', 'Basic realm="Gmail Sender Admin", charset="UTF-8"');
  res.status(401).type('text/plain').send('Authentication required.');
  return false;
}


// ---- /enroll landing --------------------------------------------------------

function handleEnrollLanding(req, res) {
  res.status(200).type('html').send(pages.landingPage());
}


// ---- OAuth start ------------------------------------------------------------
// GET /oauth/start?action=enroll
// GET /oauth/start?action=unenroll-self
//
// `enroll` and `unenroll-self` are the only valid actions. Both are public:
// `enroll` upserts whatever account Google authenticates as, and
// `unenroll-self` removes whatever account Google authenticates as. Neither
// lets the caller act on someone else's account.

function handleOAuthStart(req, res) {
  const action = (req.query.action || 'enroll').toString();
  if (action !== 'enroll' && action !== 'unenroll-self') {
    return res.status(400).type('html').send(pages.errorPage(`Unknown action: ${action}`));
  }

  try {
    const state = signState({ action });
    const url = buildAuthUrl(state);
    return res.redirect(302, url);
  } catch (e) {
    log("Error", `OAuth start failed: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(e.message));
  }
}


// ---- OAuth callback ---------------------------------------------------------

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

  let state;
  try {
    state = verifyState(stateStr);
  } catch (e) {
    return res.status(400).type('html').send(pages.errorPage(`Invalid state: ${e.message}`));
  }

  let result;
  try {
    result = await exchangeCode(code);
  } catch (e) {
    log("Error", `Code exchange failed: ${e.message}`);
    return res.status(400).type('html').send(pages.errorPage(`Could not complete sign-in: ${e.message}`));
  }

  const { email, refreshToken } = result;

  if (state.action === 'enroll') {
    try {
      await upsertAccount(email, refreshToken);
      invalidateAuthCache(email);
      log("Info", `Enrolled account ${email}`);
      return res.status(200).type('html').send(pages.enrollSuccessPage(email));
    } catch (e) {
      log("Error", `Enroll save failed for ${email}: ${e.message}`);
      return res.status(500).type('html').send(pages.errorPage(`Could not save enrollment: ${e.message}`));
    }
  }

  if (state.action === 'unenroll-self') {
    try {
      const existing = await getAccount(email);
      if (existing) {
        const ok = await revokeToken(existing.refresh_token);
        if (!ok) log("Info", `Token revoke for ${email} returned non-OK; deleting row anyway.`);
        await deleteAccount(email);
        invalidateAuthCache(email);
        log("Info", `Self-unenrolled account ${email}`);
      } else {
        log("Info", `Self-unenroll: ${email} was not enrolled.`);
      }
      // Also revoke the brand-new refresh token we just received, so the
      // grant we just created doesn't linger on Google's side.
      await revokeToken(refreshToken).catch(() => {});
      return res.status(200).type('html').send(pages.unenrollSuccessPage(email));
    } catch (e) {
      log("Error", `Self-unenroll failed for ${email}: ${e.message}`);
      return res.status(500).type('html').send(pages.errorPage(`Could not unenroll: ${e.message}`));
    }
  }

  return res.status(400).type('html').send(pages.errorPage(`Unknown action: ${state.action}`));
}


// ---- Admin: direct unenroll (POST /admin/unenroll) -------------------------
// Admin is already authenticated; we just need to defend against CSRF. The
// hidden `csrf` form field is an HMAC of STATE_SECRET — a cross-origin page
// can't read the dashboard HTML to lift it.

async function handleAdminUnenroll(req, res) {
  const body = req.body || {};
  const email = (body.email || '').toString().toLowerCase();
  const csrf  = (body.csrf  || '').toString();

  if (!email) {
    return res.status(400).type('html').send(pages.errorPage('Missing email.'));
  }
  if (!verifyAdminCsrfToken(csrf)) {
    return res.status(403).type('html').send(pages.errorPage('Invalid CSRF token. Reload the dashboard and try again.'));
  }

  try {
    const existing = await getAccount(email);
    if (!existing) {
      return res.status(404).type('html').send(pages.errorPage(`No such account: ${email}`));
    }
    const ok = await revokeToken(existing.refresh_token);
    if (!ok) log("Info", `Token revoke for ${email} returned non-OK; deleting row anyway.`);
    await deleteAccount(email);
    invalidateAuthCache(email);
    log("Info", `Admin-unenrolled account ${email}`);
    return res.status(200).type('html').send(pages.unenrollSuccessPage(email));
  } catch (e) {
    log("Error", `Admin unenroll failed for ${email}: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(`Could not unenroll: ${e.message}`));
  }
}


// ---- Admin dashboard --------------------------------------------------------

async function handleAccountsDashboard(req, res) {
  try {
    const stats = await getAccountStats();
    res.status(200).type('html').send(pages.accountsDashboard(stats, getAdminCsrfToken()));
  } catch (e) {
    log("Error", `Dashboard failed: ${e.message}`);
    res.status(500).type('html').send(pages.errorPage(`Could not load accounts: ${e.message}`));
  }
}

async function handleAccountDetail(req, res) {
  const email = (req.query.email || '').toString().toLowerCase();
  if (!email) {
    return res.status(400).type('html').send(pages.errorPage('Missing email.'));
  }
  try {
    const allStats = await getAccountStats();
    const summary = allStats.find((s) => s.email === email);
    if (!summary) {
      return res.status(404).type('html').send(pages.errorPage(`No such account: ${email}`));
    }
    const [recent, errors] = await Promise.all([
      getRecentSends(email, 50),
      getErrorBreakdown(email, 30)
    ]);
    res.status(200).type('html').send(pages.accountDetailPage(email, summary, recent, errors, getAdminCsrfToken()));
  } catch (e) {
    log("Error", `Account detail failed for ${email}: ${e.message}`);
    res.status(500).type('html').send(pages.errorPage(`Could not load account: ${e.message}`));
  }
}


// ---- Stats API (admin-only) -------------------------------------------------

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

async function handleSend(req, res) {
  const body = req.body || {};
  const { accountEmail, threadId, recipientEmail, subject, htmlBody } = body;
  const emailBody = body.body;

  if (!accountEmail) return res.status(400).json({ error: "Missing required field: accountEmail" });
  if (!emailBody)    return res.status(400).json({ error: "Missing required field: body" });
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
