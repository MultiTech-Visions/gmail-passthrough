const { log } = require('./helpers.js');

// If threadId refers to a real Gmail thread for this account: reply in-thread
// (with proper In-Reply-To / References headers so it threads in the recipient's
// client). Otherwise: send a brand-new email to recipientEmail.
//
// Every email goes out as multipart/alternative with both a text/plain and
// text/html part. If htmlBody is omitted, an HTML part is auto-generated from
// body (HTML-escaped, newlines -> <br>).

async function sendEmail({ gmail, threadId, recipientEmail, subject, body, htmlBody }) {
  if (!body) {
    throw new Error("Missing required field: body");
  }

  let thread = null;
  if (threadId) {
    try {
      const resp = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'References']
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
    return await replyToThread({ gmail, thread, recipientEmail, subject, body, htmlBody });
  }

  if (!recipientEmail) {
    throw new Error("No thread found and no recipientEmail provided — cannot send.");
  }

  return await sendNewEmail({ gmail, recipientEmail, subject, body, htmlBody });
}


async function replyToThread({ gmail, thread, recipientEmail, subject, body, htmlBody }) {
  const lastMessage = thread.messages[thread.messages.length - 1];
  const headers = lastMessage.payload.headers;

  const getHeader = (name) => {
    const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  };

  const originalSubject = getHeader('Subject');
  const originalMessageId = getHeader('Message-ID');
  const originalReferences = getHeader('References');
  const fromHeader = getHeader('From');

  let to = recipientEmail;
  if (!to) {
    const match = fromHeader.match(/<(.+?)>/);
    to = match ? match[1] : fromHeader;
  }

  const replySubject = subject
    ? subject
    : (originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`);

  const references = [originalReferences, originalMessageId].filter(Boolean).join(' ');

  const raw = buildRawEmail({
    to,
    subject: replySubject,
    body,
    htmlBody,
    inReplyTo: originalMessageId || undefined,
    references: references || undefined
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
    subject: replySubject
  };
}


async function sendNewEmail({ gmail, recipientEmail, subject, body, htmlBody }) {
  const raw = buildRawEmail({
    to: recipientEmail,
    subject: subject || '(no subject)',
    body,
    htmlBody
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
    subject: subject || '(no subject)'
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


// RFC 2822 raw message builder — always multipart/alternative with both a
// text/plain and text/html part. Parts are base64-encoded so UTF-8 is safe.
function buildRawEmail({ to, subject, body, htmlBody, inReplyTo, references }) {
  const effectiveHtml = htmlBody || textToSimpleHtml(body);
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

  lines.push(
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(body),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(effectiveHtml),
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
