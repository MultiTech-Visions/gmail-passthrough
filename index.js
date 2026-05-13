const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { getGmailService, invalidateAuthCache } = require('./google-auth.js');
const { sendEmail } = require('./sender.js');
const { log } = require('./helpers.js');
const { getAccount, listAccounts, upsertAccount, deleteAccount, recordSend } = require('./db.js');
const { signState, verifyState, buildAuthUrl, exchangeCode, revokeToken } = require('./oauth.js');
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

    // Self-serve pages — public (OAuth itself proves account ownership)
    if (method === 'GET' && path === '/enroll')           return handleEnrollLanding(req, res);
    if (method === 'GET' && path === '/oauth/start')      return handleOAuthStart(req, res);
    if (method === 'GET' && path === '/oauth/callback')   return handleOAuthCallback(req, res);
    if (method === 'GET' && path === '/accounts')         return handleAccountsDashboard(req, res);
    if (method === 'GET' && path === '/account')          return handleAccountDetail(req, res);
    if (method === 'GET' && path === '/unenroll/start')   return handleUnenrollStart(req, res);
    if (method === 'GET' && path === '/api/stats')        return handleApiStats(req, res);

    // API endpoints — require shared-secret API_KEY
    if (path === '/send') {
      if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
      return handleSend(req, res);
    }

    return res.status(404).json({ error: `Unknown route: ${path}` });
  } catch (e) {
    log("Error", `Top-level error: ${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});


function isAuthorized(req) {
  const expected = process.env.API_KEY;
  if (!expected) {
    log("Error", "API_KEY env var not set — rejecting request.");
    return false;
  }
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const provided = bearer || req.get('x-api-key') || '';
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}


// ---- /enroll landing -------------------------------------------------------

function handleEnrollLanding(req, res) {
  res.status(200).type('html').send(pages.landingPage());
}


// ---- OAuth start -----------------------------------------------------------
// GET /oauth/start?action=enroll               (action defaults to enroll)
// GET /oauth/start?action=unenroll&email=...   (used by the unenroll flow)
//
// Builds a signed state token, then redirects the browser to Google's consent
// screen. The state token is verified on the callback so neither the action
// nor the target email can be tampered with.

function handleOAuthStart(req, res) {
  const action = (req.query.action || 'enroll').toString();
  if (action !== 'enroll' && action !== 'unenroll') {
    return res.status(400).type('html').send(pages.errorPage(`Unknown action: ${action}`));
  }

  const target = req.query.email ? req.query.email.toString().toLowerCase() : undefined;
  if (action === 'unenroll' && !target) {
    return res.status(400).type('html').send(pages.errorPage('Missing email for unenroll.'));
  }

  try {
    const state = signState({ action, target });
    const url = buildAuthUrl(state);
    return res.redirect(302, url);
  } catch (e) {
    log("Error", `OAuth start failed: ${e.message}`);
    return res.status(500).type('html').send(pages.errorPage(e.message));
  }
}


function handleUnenrollStart(req, res) {
  const email = (req.query.email || '').toString().toLowerCase();
  if (!email) {
    return res.status(400).type('html').send(pages.errorPage('Missing email.'));
  }
  // Redirect through the same OAuth start handler so the flow is identical.
  return res.redirect(302, `/oauth/start?action=unenroll&email=${encodeURIComponent(email)}`);
}


// ---- OAuth callback --------------------------------------------------------
// GET /oauth/callback?code=...&state=...
// On enroll: upsert refresh token into accounts table.
// On unenroll: only succeed if Google's profile email matches the target, then
//              revoke the refresh token at Google and delete the row.

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

  if (state.action === 'unenroll') {
    if (!state.target || state.target !== email) {
      return res.status(403).type('html').send(pages.errorPage(
        `You signed in as ${email}, but the unenroll request was for ${state.target}. ` +
        `Sign in with that account to unenroll it.`
      ));
    }
    try {
      const existing = await getAccount(email);
      if (existing) {
        const ok = await revokeToken(existing.refresh_token);
        if (!ok) log("Info", `Token revoke for ${email} returned non-OK; deleting row anyway.`);
        await deleteAccount(email);
        invalidateAuthCache(email);
        log("Info", `Unenrolled account ${email}`);
      }
      // Also revoke whatever token we just got back from this flow, so the
      // grant we just created doesn't linger on Google's side.
      await revokeToken(refreshToken).catch(() => {});
      return res.status(200).type('html').send(pages.unenrollSuccessPage(email));
    } catch (e) {
      log("Error", `Unenroll failed for ${email}: ${e.message}`);
      return res.status(500).type('html').send(pages.errorPage(`Could not unenroll: ${e.message}`));
    }
  }

  return res.status(400).type('html').send(pages.errorPage(`Unknown action: ${state.action}`));
}


// ---- Dashboard -------------------------------------------------------------

async function handleAccountsDashboard(req, res) {
  try {
    const stats = await getAccountStats();
    res.status(200).type('html').send(pages.accountsDashboard(stats));
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
    res.status(200).type('html').send(pages.accountDetailPage(email, summary, recent, errors));
  } catch (e) {
    log("Error", `Account detail failed for ${email}: ${e.message}`);
    res.status(500).type('html').send(pages.errorPage(`Could not load account: ${e.message}`));
  }
}


// ---- Stats API -------------------------------------------------------------
// GET /api/stats                — totals for all accounts
// GET /api/stats?email=...      — totals + recent + error breakdown for one

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


// ---- /send -----------------------------------------------------------------
// Same shape as before, but tokens come from the DB (with env-var fallback) and
// every attempt is logged to send_logs.

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
