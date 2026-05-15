const { log } = require('./helpers.js');

// If threadId refers to a real Gmail thread for this account: reply in-thread
// (with proper In-Reply-To / References headers so it threads in the recipient's
// client). Otherwise: send a brand-new email to recipientEmail.
//
// Callers send a single `body`. If it contains HTML tags it's treated as HTML
// and a plain-text counterpart is derived; otherwise it's treated as plain
// text and a simple HTML counterpart is generated. Either way the wire format
// is multipart/alternative with both parts.

async function sendEmail({ gmail, accountEmail, threadId, recipientEmail, subject, body, replyTo }) {
  if (!body) {
    throw new Error("Missing required field: body");
  }

  const cleanReplyTo = sanitizeHeaderValue(replyTo);

  let thread = null;
  if (threadId) {
    try {
      const resp = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Reply-To', 'Subject', 'Message-ID', 'References']
      });
      thread = resp.data;
    } catch (e) {
      if (e.code === 404 || (e.response && e.response.status === 404)) {
        log("Info", `Thread ${threadId} not found — falling back to new email.`);
      } else {
        throw e;
      }
    }
  }

  if (thread && thread.messages && thread.messages.length > 0) {
    return await replyToThread({ gmail, accountEmail, thread, recipientEmail, subject, body, replyTo: cleanReplyTo });
  }

  if (!recipientEmail) {
    throw new Error("No thread found and no recipientEmail provided — cannot send.");
  }

  return await sendNewEmail({ gmail, recipientEmail, subject, body, replyTo: cleanReplyTo });
}

// Strip CR/LF (and surrounding whitespace) to prevent header injection.
// Returns null if the result is empty.
function sanitizeHeaderValue(v) {
  if (!v) return null;
  const cleaned = String(v).replace(/[\r\n]+/g, ' ').trim();
  return cleaned || null;
}


// Pulls the first email address out of an RFC 2822 address header, which can
// be `"Name" <addr@host>`, `addr@host`, or a comma-separated list.
function parseFirstAddress(header) {
  if (!header) return '';
  const angle = header.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  return header.split(',')[0].trim();
}

async function replyToThread({ gmail, accountEmail, thread, recipientEmail, subject, body, replyTo }) {
  const lastMessage = thread.messages[thread.messages.length - 1];
  const headers = lastMessage.payload.headers;

  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  const originalSubject = getHeader('Subject');
  const originalMessageId = getHeader('Message-ID');
  const originalReferences = getHeader('References');

  let to = recipientEmail;
  if (!to) {
    // Prefer Reply-To, fall back to From. If that address is the authenticated
    // account itself (i.e. we sent the last message in the thread), reply to
    // the original recipient instead — otherwise we'd just email ourselves.
    const replyToHeader = getHeader('Reply-To');
    const fromHeader    = getHeader('From');
    const target = parseFirstAddress(replyToHeader || fromHeader);
    if (target && accountEmail && target.toLowerCase() === accountEmail.toLowerCase()) {
      to = parseFirstAddress(getHeader('To'));
    } else {
      to = target;
    }
  }

  if (!to) {
    throw new Error("Could not determine reply-to address from the thread; pass recipientEmail explicitly.");
  }

  const replySubject = subject
    ? subject
    : (originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`);

  const references = [originalReferences, originalMessageId].filter(Boolean).join(' ');

  const raw = buildRawEmail({
    to,
    subject: replySubject,
    body,
    inReplyTo: originalMessageId || undefined,
    references: references || undefined,
    replyTo: replyTo || undefined
  });

  const sendResp = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: thread.id
    }
  });

  log("Info", `Reply sent to ${to} on thread ${thread.id}`);

  return {
    mode: 'reply',
    threadId: thread.id,
    messageId: sendResp.data.id,
    to,
    subject: replySubject,
    replyTo: replyTo || null
  };
}


async function sendNewEmail({ gmail, recipientEmail, subject, body, replyTo }) {
  const raw = buildRawEmail({
    to: recipientEmail,
    subject: subject || '(no subject)',
    body,
    replyTo: replyTo || undefined
  });

  const sendResp = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  log("Info", `New email sent to ${recipientEmail}`);

  return {
    mode: 'new',
    threadId: sendResp.data.threadId,
    messageId: sendResp.data.id,
    to: recipientEmail,
    subject: subject || '(no subject)',
    replyTo: replyTo || null
  };
}


function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToSimpleHtml(text) {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>\n');
}

// Heuristic: treat input as HTML if it contains a recognizable tag.
function looksLikeHtml(s) {
  return /<\/?[a-z][\s\S]*?>/i.test(s);
}

// Strip tags + decode the handful of entities we emit ourselves. Good enough
// for deriving a readable text/plain alternative from an HTML body — not a
// general-purpose HTML-to-text converter.
function htmlToSimpleText(html) {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// RFC 2822 raw message builder — always multipart/alternative with both a
// text/plain and text/html part. Parts are base64-encoded so UTF-8 is safe.
function buildRawEmail({ to, subject, body, inReplyTo, references, replyTo }) {
  const isHtml = looksLikeHtml(body);
  const textPart = isHtml ? htmlToSimpleText(body) : body;
  const htmlPart = isHtml ? body : textToSimpleHtml(body);
  const boundary = '=_alt_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  const encode = (s) => Buffer.from(s, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');

  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);

  lines.push(
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(textPart),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(htmlPart),
    `--${boundary}--`,
    ''
  );

  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}


module.exports = { sendEmail };
