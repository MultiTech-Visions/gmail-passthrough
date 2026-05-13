# Gmail Sender — Cloud Run

A Cloud Run service that sends mail through the Gmail API on behalf of
users who connect their Google accounts. Each user signs in with Google,
sees their own dashboard, and can connect or disconnect their Gmail.


## How it works

1. A user visits the site and clicks **Sign in with Google**. The single
   OAuth flow requests both identity scopes (`openid`, `email`, `profile`)
   and send scopes (`gmail.send`, `gmail.modify`) at once. Google returns
   both an id_token (for identifying the user) and a refresh_token (saved
   to the database for sending).
2. They land on their own dashboard with full stats and two controls:
   - **Pause sending** — sets a `disabled` flag. The refresh token is kept,
     but `/send` refuses to use the account. The user can resume any time
     with a single click.
   - **Remove account** — revokes the refresh token at Google and deletes
     the row. The user is signed out.
3. On the same dashboard the user creates one or more **API keys**, each
   scoped to their account only. Your other services hit `POST /send` with
   one of these keys to send mail. Each key is shown in plaintext once at
   creation time; only an HMAC hash is stored, so a DB dump doesn't expose
   live keys. The user can revoke any leaked key without affecting the
   others.

A user can only manage their own Gmail. There's no separate "connect" step —
sign-in grants everything in one OAuth dance.


## Files

| File             | Purpose                                                |
|------------------|--------------------------------------------------------|
| `index.js`       | HTTP entry point and route dispatch                    |
| `session.js`     | Signed-cookie session + CSRF token helpers             |
| `oauth.js`       | OAuth start / login / connect / revoke                 |
| `pages.js`       | Server-rendered HTML (login, dashboard, success pages) |
| `google-auth.js` | Per-account OAuth2 clients (DB-backed, cached)         |
| `sender.js`      | Builds and sends Gmail messages                        |
| `db.js`          | MySQL pool, schema, queries                            |
| `stats.js`       | Per-account totals, recent sends, error breakdown      |
| `helpers.js`     | Structured logging                                     |


## Routes

| Method | Path                  | Auth          | Description                                       |
|--------|-----------------------|---------------|---------------------------------------------------|
| GET    | `/healthz`            | none          | Health check                                      |
| GET    | `/`                   | none          | Login page (if signed out) or dashboard           |
| GET    | `/login`              | none          | "Sign in with Google" page                        |
| GET    | `/login/start`        | none          | Begins the single Google OAuth flow               |
| GET    | `/oauth/callback`     | none          | Google redirects here; sets session + saves token |
| POST   | `/disable`            | session+CSRF  | Pause sending (keeps the refresh token)           |
| POST   | `/enable`             | session+CSRF  | Resume sending                                    |
| POST   | `/remove`             | session+CSRF  | Revoke + delete + sign out                        |
| POST   | `/logout`             | session+CSRF  | Clear the session cookie                          |
| POST   | `/keys/create`        | session+CSRF  | Create a new API key for the signed-in user       |
| POST   | `/keys/revoke`        | session+CSRF  | Revoke one of the signed-in user's API keys       |
| GET    | `/admin/accounts`     | admin         | All-accounts dashboard (operations view)          |
| POST   | `/admin/unenroll`     | admin+CSRF    | Admin force-removes any account                   |
| GET    | `/api/stats`          | admin         | JSON stats — all accounts or one                  |
| POST   | `/send`               | user key      | Send an email (reply in-thread or new)            |

### Auth

- **Session.** A signed cookie (`gms_session`, HttpOnly, Secure, SameSite=Lax,
  30-day TTL) tracks the signed-in user's email. Issued after a successful
  Google sign-in; verified via HMAC of `STATE_SECRET`.
- **Admin.** `/admin/*` and `/api/stats` accept either:
  - HTTP **Basic** auth with `ADMIN_USER` / `ADMIN_PASS` env vars (browsers
    prompt automatically), or
  - `Authorization: Bearer <API_KEY>` / `X-API-Key: <API_KEY>` (for scripts).
- **`POST /send`** requires a **per-user API key** (prefix `gms_…`) in
  `Authorization: Bearer …` or `X-API-Key: …`. The key identifies which
  Gmail account the caller can send as — there is no way to act as a
  different account.


## Setup

### 1. Enable the Gmail API

1. **Google Cloud Console** → select your project
2. **APIs & Services → Library** → enable **Gmail API**

### 2. Create OAuth2 credentials

1. **APIs & Services → Credentials**
2. **+ Create Credentials → OAuth client ID**, type **Web application**
3. **Authorized redirect URIs** → add `https://YOUR-CLOUD-RUN-URL.run.app/oauth/callback`
4. Copy the **Client ID** and **Client Secret**.

### 3. Configure the OAuth consent screen

Add the scopes the app uses:
- `openid`, `email`, `profile` (sign-in)
- `https://www.googleapis.com/auth/gmail.send` (sending)
- `https://www.googleapis.com/auth/gmail.modify` (in-thread replies)

If you keep the app in "Testing" mode, add the users you want to allow on
the test-user list. Otherwise publish it.

### 4. Create the Cloud SQL (MySQL) instance

1. **Cloud SQL** → **+ Create Instance** → **MySQL**
2. Region: match your Cloud Run service
3. Create a database, e.g. `gmail_sender`
4. Note the **Connection name** (`project:region:instance`)

The schema is auto-applied on first request via `CREATE TABLE IF NOT EXISTS`.

### 5. Deploy to Cloud Run

- Authentication: **Allow unauthenticated** (the app gates itself)
- Runtime: Node.js 20+
- Entry point: `gmailSender`
- Attach your Cloud SQL instance under **Cloud SQL connections**
- Set the env vars below


## Environment Variables

| Variable                   | Description                                                                 |
|----------------------------|-----------------------------------------------------------------------------|
| `API_KEY`                  | Shared secret for `POST /send` (also accepted on admin endpoints as Bearer / X-API-Key) |
| `ADMIN_USER`               | Username for the admin login dialog at `/admin/*`                           |
| `ADMIN_PASS`               | Password for the admin login dialog at `/admin/*`                           |
| `STATE_SECRET`             | (optional) HMAC secret for session + OAuth state. Defaults to `API_KEY`.    |
| `GMAIL_CLIENT_ID`          | OAuth2 Client ID                                                            |
| `GMAIL_CLIENT_SECRET`      | OAuth2 Client Secret                                                        |
| `OAUTH_REDIRECT_URI`       | Must match the URI registered above (ends `/oauth/callback`)                |
| `INSTANCE_CONNECTION_NAME` | Cloud SQL connection name `project:region:instance` (socket mode)           |
| `DB_HOST` / `DB_PORT`      | Alternative to `INSTANCE_CONNECTION_NAME` for direct TCP (local dev)        |
| `DB_USER` / `DB_PASS` / `DB_NAME` | MySQL credentials                                                    |
| `ACCOUNTS_CONFIG`          | (legacy) Pre-DB JSON-keyed accounts; used as a fallback if DB has no row.   |

Generate `API_KEY` / `STATE_SECRET` with `openssl rand -hex 32`.


## `POST /send`

Authentication: send a per-user API key (created from the dashboard, shaped
`gms_<48 hex chars>`) in either `Authorization: Bearer <key>` or
`X-API-Key: <key>`. The key identifies which Gmail account the call will
send as — there is no way to override that from the request. Missing or
wrong key → `401`.

If `threadId` matches a real Gmail thread on the account, the service
replies in-thread; otherwise sends a brand-new email to `recipientEmail`.

Request body:

```json
{
  "body":           "The plain-text body",
  "htmlBody":       "<p>The HTML body</p>",
  "recipientEmail": "patient@example.com",
  "threadId":       "abc123...",
  "subject":        "Your Subject"
}
```

| Field            | Required? | Notes                                                           |
|------------------|-----------|-----------------------------------------------------------------|
| `body`           | yes       | Plain-text body (newlines preserved)                            |
| `htmlBody`       | no        | HTML body. If omitted, auto-generated from `body`               |
| `recipientEmail` | see notes | Required if no `threadId`. Overrides the auto-detected reply-to |
| `threadId`       | no        | Gmail thread ID; if found, reply goes in-thread                 |
| `subject`        | no        | On replies, defaults to `Re: <original subject>`                |

Every email is sent as `multipart/alternative` with both a `text/plain` and a
`text/html` part. Every attempt — success or error — is logged to
`send_logs`.

Success response:

```json
{ "status": "ok", "mode": "reply", "threadId": "...", "messageId": "...", "to": "...", "subject": "..." }
```

`mode` is `"reply"` when the message went in-thread, `"new"` otherwise.


## Schema

```sql
CREATE TABLE accounts (
  email          VARCHAR(255) PRIMARY KEY,
  refresh_token  TEXT         NOT NULL,
  disabled       BOOLEAN      NOT NULL DEFAULT FALSE,
  enrolled_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME     NULL,
  total_sends    BIGINT       NOT NULL DEFAULT 0
);

CREATE TABLE api_keys (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_email  VARCHAR(255) NOT NULL,
  label          VARCHAR(255) NULL,
  hash           CHAR(64)     NOT NULL,         -- HMAC of the plaintext key
  last4          VARCHAR(4)   NOT NULL,         -- displayed in the UI
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME     NULL,
  UNIQUE KEY uniq_hash (hash),
  INDEX idx_account (account_email)
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

For a soft cutover: keep `ACCOUNTS_CONFIG` set during the first deploy. The
DB is checked first; if no row exists, the legacy env var is used as a
fallback. Once each user has signed in and connected their Gmail via the UI,
drop the env var and redeploy.


## Testing `/send` from Google Apps Script

```js
const GMAIL_SENDER_URL = 'https://YOUR-CLOUD-RUN-URL.run.app';
const API_KEY          = 'gms_...';                  // your per-user API key
const TO_ADDRESS       = 'you@yourdomain.com';

function runTest() {
  const r = post({
    recipientEmail: TO_ADDRESS,
    subject:        'Hello from Gmail Sender',
    body:           'Hello, world!\n\n— ' + new Date().toISOString()
  });
  Logger.log('threadId=%s', r.threadId);
}

function post(payload) {
  const r = UrlFetchApp.fetch(GMAIL_SENDER_URL + '/send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + API_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = r.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + r.getContentText());
  return JSON.parse(r.getContentText());
}
```
