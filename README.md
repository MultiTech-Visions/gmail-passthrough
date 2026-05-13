# Gmail Sender — Cloud Run

A minimal Cloud Run service that sends emails via the Gmail API. Supports
multiple Gmail accounts from a single deployment, with **self-serve OAuth
enrollment**, an enrolled-accounts dashboard, and per-account send stats.


## Files

| File             | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `index.js`       | HTTP entry point and route dispatch                        |
| `google-auth.js` | Per-account OAuth2 clients (DB-backed, with env fallback)  |
| `sender.js`      | Sends email replies (in-thread) or new emails via Gmail    |
| `oauth.js`       | OAuth start/callback + signed state tokens + revoke        |
| `pages.js`       | Server-rendered HTML (enroll page, dashboard, detail)      |
| `db.js`          | MySQL connection pool, schema, accounts/log queries        |
| `stats.js`       | Per-account totals, recent sends, error breakdown          |
| `helpers.js`     | Structured logging                                         |
| `package.json`   | Dependencies and start script                              |


## Routes

| Method | Path                | Auth     | Description                                  |
|--------|---------------------|----------|----------------------------------------------|
| GET    | `/`                 | none     | Health check                                 |
| GET    | `/enroll`           | none     | Landing page — "Connect" / "Disconnect"      |
| GET    | `/oauth/start`      | none     | Begins Google OAuth flow                     |
| GET    | `/oauth/callback`   | none     | Google redirects here with the auth code     |
| GET    | `/accounts`         | admin    | Dashboard listing every enrolled account     |
| GET    | `/account?email=…`  | admin    | Detail view for one account                  |
| GET    | `/api/stats`        | admin    | JSON stats — all accounts or one             |
| POST   | `/admin/unenroll`   | admin    | Admin removes an account (revokes + deletes) |
| POST   | `/send`             | API_KEY  | Send an email (reply in-thread or new)       |

### Auth

- **API_KEY** routes (`/send`): send the key in `Authorization: Bearer <key>`
  or `X-API-Key: <key>`.
- **Admin** routes (the dashboard, account detail, stats API, admin unenroll):
  protected by the same shared secret as `API_KEY`. Three accepted forms:
  - HTTP **Basic** auth (browsers will prompt automatically): any username,
    password = `API_KEY`.
  - `Authorization: Bearer <API_KEY>`
  - `X-API-Key: <API_KEY>`

The **enrollment** flow (`/enroll`, `/oauth/*`) is intentionally public —
Google's OAuth flow guarantees that whoever clicks "Connect" can only
enroll a Gmail account they own. The same is true of the self-serve
"Disconnect my account" button: it removes whatever account Google
authenticates them as, and nothing else.


## Setup

### 1. Enable the Gmail API

1. Go to **Google Cloud Console** → select your project
2. **APIs & Services** → **Library** → enable **Gmail API**

### 2. Create OAuth2 Credentials

1. **APIs & Services** → **Credentials**
2. **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Under **Authorized redirect URIs**, add the URL where this service will
   handle the OAuth callback:
   `https://YOUR-CLOUD-RUN-URL.run.app/oauth/callback`
5. **Create**, then copy the **Client ID** and **Client Secret**.

(You no longer need to use the OAuth Playground per account — enrollment is
self-serve via `/enroll`.)

### 3. Create the Cloud SQL (MySQL) instance

1. **Cloud SQL** → **+ Create Instance** → **MySQL**
2. Pick a region close to your Cloud Run service
3. Set a strong password for the `root` user (or create a dedicated user)
4. Create a database, e.g. `gmail_sender`
5. Note the **Connection name** (format: `project:region:instance`)
6. Under **Connections**, enable the Cloud SQL Admin API (link is in the UI)

The service runs `CREATE TABLE IF NOT EXISTS` on first request, so you don't
need to apply a schema manually.

### 4. Deploy to Cloud Run

1. **Cloud Run** → **+ Create Service**
2. Configure:
   - Region: same as your Cloud SQL instance
   - Authentication: **Allow unauthenticated** (the OAuth flow + dashboard
     are public; `/send` enforces its own API_KEY)
   - Memory: 256 MB
   - Timeout: 60s
   - Runtime: Node.js 20+
   - Entry point: `gmailSender`
3. Under **Cloud SQL connections**, attach your instance — this exposes a
   Unix socket at `/cloudsql/<connection name>`.
4. Add the environment variables listed below.
5. **Deploy**.


## Environment Variables

| Variable                   | Description                                                                 |
|----------------------------|-----------------------------------------------------------------------------|
| `API_KEY`                  | Shared secret required on every `POST /send` request                        |
| `STATE_SECRET`             | (optional) HMAC secret for OAuth state tokens. Defaults to `API_KEY`.       |
| `GMAIL_CLIENT_ID`          | OAuth2 Client ID                                                            |
| `GMAIL_CLIENT_SECRET`      | OAuth2 Client Secret                                                        |
| `OAUTH_REDIRECT_URI`       | Must match the URI you registered in the OAuth client (ends `/oauth/callback`) |
| `INSTANCE_CONNECTION_NAME` | Cloud SQL connection name `project:region:instance` (Cloud Run socket mode) |
| `DB_HOST` / `DB_PORT`      | Alternative to `INSTANCE_CONNECTION_NAME` for direct TCP (local dev)        |
| `DB_USER`                  | MySQL user                                                                  |
| `DB_PASS`                  | MySQL password                                                              |
| `DB_NAME`                  | MySQL database name (e.g. `gmail_sender`)                                   |
| `ACCOUNTS_CONFIG`          | (legacy) Pre-DB JSON-keyed accounts; used as a fallback if DB has no row.   |

Generate `API_KEY` / `STATE_SECRET` with `openssl rand -hex 32` (or any of):

- **Browser dev console:**
  ```js
  Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  ```
- **Node:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`


## Enrolling an account (self-serve)

1. Send the user to `https://YOUR-CLOUD-RUN-URL.run.app/enroll`
2. They click **Connect a Gmail account**, sign in with Google, and grant
   the requested scopes (`gmail.send`, `gmail.modify`).
3. Google redirects back to `/oauth/callback`; the service exchanges the
   code, looks up the account's email via `users.getProfile`, and upserts a
   row into `accounts` with the refresh token.

Re-running enrollment for the same email simply rotates the stored refresh
token.


## Unenrolling

There are two paths, depending on who's doing it:

- **Self-serve.** Send the user to `/enroll` and have them click **Disconnect
  my account**. They sign in with Google, and the service removes whichever
  account Google authenticates them as — they can only remove their own.
- **Admin.** From `/accounts`, click **Unenroll** next to the row. The
  service revokes the refresh token at Google's `/revoke` endpoint and
  deletes the row. No OAuth round-trip required (admin already proved
  identity by signing in to the dashboard).


## Stats

The dashboard at `/accounts` shows, per account:

- Total sends (lifetime)
- Sends in the last 24 hours / 7 days / 30 days
- Error count (30 days)
- Last-used timestamp

`/account?email=…` adds a recent-sends log (last 50) and an error breakdown
grouped by error message. The same data is available as JSON at
`/api/stats` (all) or `/api/stats?email=…` (one).


## `POST /send`

Authentication: send the configured `API_KEY` in either of:

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
| `accountEmail`   | yes       | Which Gmail account to send from (must be enrolled)             |
| `body`           | yes       | Plain-text body (newlines preserved)                            |
| `htmlBody`       | no        | HTML body. If omitted, auto-generated from `body`               |
| `recipientEmail` | see notes | Required if no `threadId`. Overrides the auto-detected reply-to |
| `threadId`       | no        | Gmail thread ID; if found, reply goes in-thread                 |
| `subject`        | no        | On replies, defaults to `Re: <original subject>`                |

Every email is sent as `multipart/alternative` with both a `text/plain` and a
`text/html` part.

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

Error response: `{ "status": "error", "error": "..." }`

Every attempt — success or failure — is recorded to `send_logs` and shows up
in the dashboard.


## Schema

The two tables are created on demand:

```sql
CREATE TABLE accounts (
  email          VARCHAR(255) PRIMARY KEY,
  refresh_token  TEXT         NOT NULL,
  enrolled_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME     NULL,
  total_sends    BIGINT       NOT NULL DEFAULT 0
);

CREATE TABLE send_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_email  VARCHAR(255) NOT NULL,
  recipient      VARCHAR(255) NULL,
  subject        TEXT         NULL,
  thread_id      VARCHAR(255) NULL,
  mode           ENUM('new','reply') NULL,
  status         ENUM('ok','error')  NOT NULL,
  error_message  TEXT         NULL,
  sent_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_account_sent (account_email, sent_at),
  INDEX idx_status_sent  (status, sent_at)
);
```


## Migrating from `ACCOUNTS_CONFIG`

For a soft cutover: keep `ACCOUNTS_CONFIG` set during the first deploy.
The DB is checked first; if no row exists, the legacy env var is used as a
fallback. Once each account has re-enrolled via `/enroll`, drop the env var
and redeploy.


## Testing from Google Apps Script

Drop this into a new Apps Script project, fill in the four constants at the
top, and run `runTest`.

```js
const GMAIL_SENDER_URL = 'https://YOUR-CLOUD-RUN-URL.run.app';
const API_KEY          = 'YOUR_API_KEY';
const FROM_ACCOUNT     = 'inbox@yourdomain.com';
const TO_ADDRESS       = 'you@yourdomain.com';

function runTest() {
  const newResult = post({
    accountEmail:   FROM_ACCOUNT,
    recipientEmail: TO_ADDRESS,
    subject:        'Hello World from Gmail Sender',
    body:           'Hello, world!\n\n— sent ' + new Date().toISOString()
  });
  Logger.log('New email sent. threadId=%s', newResult.threadId);

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
  if (code !== 200) throw new Error('Request failed (' + code + '): ' + text);
  return JSON.parse(text);
}
```
