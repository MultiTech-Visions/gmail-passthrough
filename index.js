const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { getGmailService } = require('./google-auth.js');
const { sendEmail } = require('./sender.js');
const { log } = require('./helpers.js');


functions.http('gmailSender', async (req, res) => {
  try {
    const path = req.path || '/';

    if (req.method === 'GET' && path === '/') {
      return res.status(200).send('OK');
    }

    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (path === '/send') {
      return handleSend(req, res);
    }

    return res.status(404).json({ error: `Unknown route: ${path}` });
  } catch (e) {
    log("Error", `Top-level error: ${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});


// Shared-secret auth. Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
// Fails closed if API_KEY is not set so an unconfigured deploy can't accept traffic.
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


// POST /send
//
// Sends an email from one of the configured Gmail accounts. If threadId
// matches a real thread on that account, replies in-thread; otherwise sends
// a new email to recipientEmail.
//
// Body: {
//   accountEmail:   "inbox@yourdomain.com"  // required — which Gmail account to send from
//   body:           "The email body"        // required — plain text
//   htmlBody:       "<p>The email body</p>" // optional — HTML; auto-generated from body if omitted
//   recipientEmail: "patient@example.com"   // required if no threadId (or fallback)
//   threadId:       "abc123..."             // optional — Gmail thread ID to reply to
//   subject:        "Your Subject"          // optional (auto "Re: ..." on replies)
// }

async function handleSend(req, res) {
  const body = req.body || {};
  const { accountEmail, threadId, recipientEmail, subject, htmlBody } = body;
  const emailBody = body.body;

  if (!accountEmail) {
    return res.status(400).json({ error: "Missing required field: accountEmail" });
  }
  if (!emailBody) {
    return res.status(400).json({ error: "Missing required field: body" });
  }
  if (!threadId && !recipientEmail) {
    return res.status(400).json({ error: "Must provide threadId or recipientEmail" });
  }

  let gmail;
  try {
    gmail = getGmailService(accountEmail);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const result = await sendEmail({ gmail, threadId, recipientEmail, subject, body: emailBody, htmlBody });
    return res.status(200).json({ status: "ok", ...result });
  } catch (e) {
    log("Error", `[${accountEmail}] Send failed: ${e.stack}`);
    return res.status(500).json({ status: "error", error: e.message });
  }
}
