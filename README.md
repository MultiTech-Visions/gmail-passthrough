# Gmail Sender — Cloud Run

A minimal Cloud Run service that sends emails via the Gmail API. Supports
multiple Gmail accounts from a single deployment.


## Files

| File             | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `index.js`       | HTTP entry point and `/send` route                         |
| `google-auth.js` | Per-account OAuth2 clients, account config parsing         |
| `sender.js`      | Sends email replies (in-thread) or new emails via Gmail    |
| `helpers.js`     | Structured logging                                         |
| `package.json`   | Dependencies and start script                              |


## Setup

### 1. Enable the Gmail API

1. Go to **Google Cloud Console** → select your project (or create one)
2. Go to **APIs & Services** → **Library**
3. Enable the **Gmail API**


### 2. Create OAuth2 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Under **Authorized redirect URIs**, click **+ Add URI** and enter:
   `https://developers.google.com/oauthplayground`
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**


### 3. Get a Refresh Token (repeat for each Gmail account)

1. Go to https://developers.google.com/oauthplayground
2. Click the **gear icon** (top right) → check **Use your own OAuth credentials**
3. Paste in your Client ID and Client Secret
4. In the left panel under **Step 1**, find and check this scope:
   - `https://www.googleapis.com/auth/gmail.send`

   (If you also want to reply in-thread, add `https://www.googleapis.com/auth/gmail.modify`
   so the service can look up the thread's headers.)
5. Click **Authorize APIs** — sign in with the Gmail account you want to connect
6. Click **Exchange authorization code for tokens**
7. Copy the **Refresh Token**


### 4. Deploy to Cloud Run

1. Go to **Google Cloud Console** → **Cloud Run**
2. Click **+ Create Function**
3. Configure:
   - **Function name**: `gmail-sender` (or whatever you want)
   - **Region**: pick one close to you
   - **Trigger type**: **HTTPS**
   - **Authentication**: pick based on your security preference
4. Under **Runtime, build, connections and security settings**:
   - **Memory**: 256 MB is plenty
   - **Timeout**: 60 seconds
5. Add the environment variables listed below
6. Set the **Runtime** to Node.js 20+
7. Set the **Entry point** to `gmailSender`
8. Paste in or upload all source files
9. Click **Deploy**


## Environment Variables

| Variable              | Description                                                    |
|-----------------------|----------------------------------------------------------------|
| `API_KEY`             | Shared secret required on every `/send` request (see below)    |
| `GMAIL_CLIENT_ID`     | OAuth2 Client ID                                               |
| `GMAIL_CLIENT_SECRET` | OAuth2 Client Secret                                           |
| `ACCOUNTS_CONFIG`     | JSON object with per-account refresh tokens (see below)        |

Generate an `API_KEY` and store it in your caller (and in the Cloud Run env
var). If `API_KEY` is unset the service rejects every request, so a
misconfigured deploy can't leak sending.

Pick whichever is handiest:

- **Browser dev console** (open dev tools → Console tab, paste, hit enter):
  ```js
  Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  ```
- **Terminal / Cloud Shell:** `openssl rand -hex 32`
- **Node:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**`ACCOUNTS_CONFIG`** — a JSON object keyed by email address:

```json
{
  "inbox@yourdomain.com": {
    "refreshToken": "1//0xxxxxxxxxxxxx"
  },
  "referrals@yourdomain.com": {
    "refreshToken": "1//0yyyyyyyyyyyyy"
  }
}
```

To add a new account later, add another entry and redeploy.


## Routes

| Method | Path    | Description                                |
|--------|---------|--------------------------------------------|
| GET    | `/`     | Health check — returns 200 OK              |
| POST   | `/send` | Send an email (reply in-thread or new)     |


### `POST /send`

**Authentication.** `/send` requires the configured `API_KEY`, sent in
either of these headers:

- `Authorization: Bearer <API_KEY>`
- `X-API-Key: <API_KEY>`

Missing or wrong key → `401 Unauthorized`.

If `threadId` matches a real Gmail thread on the account, the service replies
in-thread (with `In-Reply-To` / `References` headers set so the recipient's
client threads it). Otherwise a brand-new email is sent to `recipientEmail`.

Request body:

```json
{
  "accountEmail":   "inbox@yourdomain.com",
  "body":           "The plain-text body",
  "htmlBody":       "<p>The HTML body</p>",
  "recipientEmail": "patient@example.com",
  "threadId":       "abc123...",
  "subject":        "Your Subject"
}
```

| Field            | Required? | Notes                                                           |
|------------------|-----------|-----------------------------------------------------------------|
| `accountEmail`   | yes       | Which Gmail account to send from (must exist in `ACCOUNTS_CONFIG`) |
| `body`           | yes       | Plain-text body (newlines preserved)                            |
| `htmlBody`       | no        | HTML body. If omitted, an HTML part is auto-generated from `body` (escaped, newlines → `<br>`) |
| `recipientEmail` | see notes | Required if no `threadId`. If `threadId` is also given, overrides the auto-detected reply-to |
| `threadId`       | no        | Gmail thread ID; if found, reply goes in-thread                 |
| `subject`        | no        | On replies, defaults to `Re: <original subject>`                |

Every email is sent as `multipart/alternative` with both a `text/plain` and a
`text/html` part, so clients that can render HTML will, and clients that
can't will fall back to the plain text.

**Simple case — just plain text:**
```json
{
  "accountEmail": "inbox@yourdomain.com",
  "recipientEmail": "patient@example.com",
  "subject": "Hello",
  "body": "Hi there,\n\nJust checking in.\n\n— The Team"
}
```
The service generates the HTML version automatically.

**Complex case — custom HTML + plain-text summary:**
```json
{
  "accountEmail": "inbox@yourdomain.com",
  "recipientEmail": "patient@example.com",
  "subject": "Your report",
  "body": "Summary: 3 new items this week. Open in a browser for the full table.",
  "htmlBody": "<h1>Your report</h1><table>...</table>"
}
```

Success response:

```json
{
  "status": "ok",
  "mode": "reply",
  "threadId": "...",
  "messageId": "...",
  "to": "...",
  "subject": "..."
}
```

`mode` is `"reply"` when the message went in-thread, `"new"` when it was a
fresh email.

Error response:

```json
{ "status": "error", "error": "..." }
```


## Testing from Google Apps Script

Drop this into a new Apps Script project, fill in the four constants at the
top, and run `runTest`. It sends a fresh email, then immediately replies
in-thread using the returned `threadId` — so you verify both the new-email
path and the in-thread reply path in one shot.

```js
const GMAIL_SENDER_URL = 'https://YOUR-CLOUD-RUN-URL.run.app'; // no trailing slash
const API_KEY          = 'YOUR_API_KEY';
const FROM_ACCOUNT     = 'inbox@yourdomain.com';   // must be in ACCOUNTS_CONFIG
const TO_ADDRESS       = 'you@yourdomain.com';     // who receives the test

function runTest() {
  // Step 1: send a brand-new email.
  const newResult = post({
    accountEmail:   FROM_ACCOUNT,
    recipientEmail: TO_ADDRESS,
    subject:        'Hello World from Gmail Sender',
    body:           'Hello, world!\n\nThis is a test email.\n\n— sent ' + new Date().toISOString()
    // htmlBody: '<h1>Hello, world!</h1><p>Optional — omit to auto-generate from body.</p>'
  });
  Logger.log('New email sent. threadId=%s', newResult.threadId);

  // Step 2: reply in-thread to the email we just sent.
  const replyResult = post({
    accountEmail: FROM_ACCOUNT,
    threadId:     newResult.threadId,
    body:         'Replying in-thread!\n\n— sent ' + new Date().toISOString()
  });
  Logger.log('Reply sent. threadId=%s mode=%s', replyResult.threadId, replyResult.mode);
}

function post(payload) {
  const response = UrlFetchApp.fetch(GMAIL_SENDER_URL + '/send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  Logger.log('HTTP %s\n%s', code, text);

  if (code !== 200) throw new Error('Request failed (' + code + '): ' + text);
  return JSON.parse(text);
}
```

Notes:
- `muteHttpExceptions: true` lets you see the real error body on 4xx/5xx
  responses instead of a generic Apps Script exception.
- The first call logs `"mode":"new"`; the second call should log `"mode":"reply"`
  with the same `threadId`.
- Uncomment the `htmlBody` line to also exercise the custom-HTML path.
