// Server-side HTML rendering. No build step.

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: min(1920px, 95vw); margin: 2rem auto; padding: 0 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
  h2 { margin: 2rem 0 0.5rem; font-size: 1.15rem; }
  .sub { color: #666; margin-bottom: 1.5rem; }
  .btn { display: inline-block; padding: 0.6rem 1rem; border-radius: 6px;
         background: #1a73e8; color: white; text-decoration: none; border: 0;
         font-size: 0.95rem; cursor: pointer; }
  .btn.secondary { background: transparent; color: #1a73e8; border: 1px solid #1a73e8; }
  .btn.danger { background: #d93025; }
  .btn:hover { opacity: 0.92; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.55rem 0.5rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: 0.78rem; color: #666; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #888; }
  .card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 99px;
          font-size: 0.75rem; background: #eef; color: #335; }
  .pill.err { background: #fee; color: #a00; }
  .pill.ok  { background: #efe; color: #050; }
  .row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .grow { flex: 1; }
  code { background: #f4f4f4; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.9em; }
  header.top { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
  header.top .who { color: #666; font-size: 0.9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 0.75rem; margin: 0.5rem 0 1rem; }
  .stat { padding: 0.75rem; border: 1px solid #e5e5e5; border-radius: 6px; }
  .stat .n { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { color: #666; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .empty { color: #888; padding: 1.25rem; text-align: center; border: 1px dashed #ddd; border-radius: 8px; }
  form.inline { display: inline; }
  dl.fields { margin: 0.5rem 0 0; }
  dl.fields dt { margin-top: 0.75rem; }
  dl.fields dt:first-child { margin-top: 0; }
  dl.fields dt .req { color: #888; font-size: 0.78rem; margin-left: 0.4rem;
                      text-transform: uppercase; letter-spacing: 0.04em; }
  dl.fields dd { margin: 0.15rem 0 0; color: #555; }
  @media (prefers-color-scheme: dark) {
    dl.fields dd { color: #aaa; }
    dl.fields dt .req { color: #777; }
  }
  .two-col { display: grid; gap: 1.5rem;
             grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); align-items: start; }
  .two-col > section > h2:first-child { margin-top: 0.5rem; }
  .main-layout { display: grid; gap: 1.5rem; grid-template-columns: 1fr; align-items: start; }
  .main-layout > section { min-width: 0; }
  @media (min-width: 1280px) {
    .main-layout { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #ddd; }
    .card, .stat, th, td { border-color: #333; }
    th { color: #999; }
    .sub, .muted, .stat .l, header.top .who { color: #999; }
    code { background: #2a2a2a; }
    .pill { background: #234; color: #cdf; }
    .pill.err { background: #422; color: #fcc; }
    .pill.ok  { background: #242; color: #cfc; }
    .empty { border-color: #333; color: #999; }
  }
`;

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function userHeader(email, csrfToken) {
  return `<header class="top">
    <div class="grow"><strong>Gmail Sender</strong></div>
    <div class="who">Signed in as <code>${esc(email)}</code></div>
    <form class="inline" method="POST" action="/logout">
      <input type="hidden" name="csrf" value="${esc(csrfToken)}">
      <button class="btn secondary" type="submit">Sign out</button>
    </form>
  </header>`;
}

function loginPage() {
  return layout('Gmail Sender — Sign in', `
    <div style="margin-top: 4rem; text-align: center;">
      <h1>Gmail Sender</h1>
      <p class="sub">Sign in with Google to let this service send mail on behalf of your Gmail account.</p>
      <p><a class="btn" href="/login/start">Sign in with Google</a></p>
      <p class="muted" style="font-size:0.85rem; margin-top:1rem; max-width:32rem; margin-left:auto; margin-right:auto;">
        Signing in requests permission to send mail as your account. You can pause sending or remove the connection at any time.
      </p>
    </div>
  `);
}

function fmtDate(d) {
  if (!d) return '<span class="muted">never</span>';
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return esc(String(d));
  return `<span title="${esc(date.toISOString())}">${esc(date.toISOString().replace('T', ' ').slice(0, 16))} UTC</span>`;
}


// Logged-in dashboard for a single user. After sign-in, the row always
// exists — there's no separate "connect" step. `summary` is null only in
// the unusual case where the cookie outlived the DB row (e.g. the account
// was removed via /admin/unenroll); in that case we show a re-sign-in card.
function userDashboard({ email, csrfToken, summary, recent, errors, keys = [], newKey = null, sendUrl = '' }) {
  const missing = !summary;
  const disabled = !!(summary && summary.disabled);

  const stateCard = missing
    ? `
      <div class="card">
        <h2 style="margin-top:0">Your account is gone</h2>
        <p class="muted">Your session is still valid but no Gmail connection is on file. Sign in again to set things up.</p>
        <p><a class="btn" href="/login/start">Sign in with Google</a></p>
      </div>`
    : `
      <div class="card">
        <div class="row">
          <div class="grow">
            <strong><code>${esc(email)}</code></strong>
            ${disabled ? '<span class="pill err">sending paused</span>' : '<span class="pill ok">sending enabled</span>'}
            <div class="muted" style="margin-top:0.25rem">
              Connected ${fmtDate(summary.enrolledAt)} · Last used ${fmtDate(summary.lastUsedAt)}
            </div>
          </div>
          ${disabled
            ? `<form class="inline" method="POST" action="/enable">
                 <input type="hidden" name="csrf" value="${esc(csrfToken)}">
                 <button class="btn" type="submit">Resume sending</button>
               </form>`
            : `<form class="inline" method="POST" action="/disable"
                     onsubmit="return confirm('Pause sending for ${esc(email)}? The connection is kept; you can resume any time.');">
                 <input type="hidden" name="csrf" value="${esc(csrfToken)}">
                 <button class="btn secondary" type="submit">Pause sending</button>
               </form>`}
          <form class="inline" method="POST" action="/remove"
                onsubmit="return confirm('Remove ${esc(email)} completely? This revokes access at Google and deletes all stored data. This cannot be undone.');">
            <input type="hidden" name="csrf" value="${esc(csrfToken)}">
            <button class="btn danger" type="submit">Remove account</button>
          </form>
        </div>
        ${disabled
          ? `<p class="muted" style="margin: 0.75rem 0 0;">Sending is paused. /send requests for this account return an error. The refresh token is kept so you can resume instantly.</p>`
          : ''}
      </div>`;

  const statsBlock = missing ? '' : `
    <div class="grid">
      <div class="stat"><div class="n">${summary.totalSends}</div><div class="l">Total sends</div></div>
      <div class="stat"><div class="n">${summary.sends24h}</div><div class="l">Last 24h</div></div>
      <div class="stat"><div class="n">${summary.sends7d}</div><div class="l">Last 7 days</div></div>
      <div class="stat"><div class="n">${summary.sends30d}</div><div class="l">Last 30 days</div></div>
    </div>
  `;

  const recentBlock = missing ? '' : (() => {
    if (!recent || recent.length === 0) {
      return `<h2>Recent sends</h2><div class="empty">No sends recorded yet.</div>`;
    }
    const rows = recent.map((r) => `
      <tr>
        <td>${fmtDate(r.sent_at)}</td>
        <td><span class="pill ${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span> ${r.mode ? `<span class="muted">${esc(r.mode)}</span>` : ''}</td>
        <td><code>${esc(r.recipient || '—')}</code></td>
        <td>${esc(r.subject || '')}</td>
        <td class="muted">${esc(r.error_message || '')}</td>
      </tr>`).join('');
    return `
      <h2>Recent sends</h2>
      <table>
        <thead><tr><th>When</th><th>Status</th><th>Recipient</th><th>Subject</th><th>Error</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  })();

  const errorBlock = missing ? '' : (() => {
    if (!errors || errors.length === 0) return '';
    const rows = errors.map((e) => `
      <tr>
        <td class="num">${Number(e.count)}</td>
        <td><code>${esc(e.error_message || '(no message)')}</code></td>
        <td>${fmtDate(e.last_seen)}</td>
      </tr>`).join('');
    return `
      <h2>Errors (last 30 days)</h2>
      <table>
        <thead><tr><th class="num">Count</th><th>Error</th><th>Last seen</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  })();

  const keysBlock = missing ? '' : (() => {
    const newKeyCallout = newKey ? `
      <div class="card" style="border-color:#f0a500; background: #fff8e1;">
        <strong>Copy this key now — it won't be shown again.</strong>
        ${newKey.label ? `<div class="muted">Label: ${esc(newKey.label)}</div>` : ''}
        <pre style="background:#fff; padding:0.75rem; border:1px solid #e5e5e5; border-radius:6px; overflow:auto; user-select:all; margin:0.5rem 0 0;"><code>${esc(newKey.plaintext)}</code></pre>
      </div>` : '';

    const listRows = keys.length === 0
      ? `<tr><td colspan="5"><div class="empty">No API keys yet. Create one to send mail through <code>POST /send</code>.</div></td></tr>`
      : keys.map((k) => `
          <tr>
            <td>${esc(k.label || '(no label)')}</td>
            <td><code>gms_…${esc(k.last4)}</code></td>
            <td>${fmtDate(k.created_at)}</td>
            <td>${fmtDate(k.last_used_at)}</td>
            <td>
              <form class="inline" method="POST" action="/keys/revoke"
                    onsubmit="return confirm('Revoke this key? Any caller still using it will start getting 401s.');">
                <input type="hidden" name="csrf" value="${esc(csrfToken)}">
                <input type="hidden" name="id" value="${esc(String(k.id))}">
                <button class="btn danger" type="submit">Revoke</button>
              </form>
            </td>
          </tr>`).join('');

    return `
      <h2>API keys</h2>
      <p class="muted" style="margin-top:0;">Each key sends mail as <code>${esc(email)}</code> only. If a key leaks, revoke it — your other keys keep working.</p>
      ${newKeyCallout}
      <div class="card">
        <form method="POST" action="/keys/create" class="row" style="margin:0;">
          <input type="hidden" name="csrf" value="${esc(csrfToken)}">
          <label class="grow">
            <div class="muted" style="font-size:0.8rem;">Label (optional)</div>
            <input name="label" type="text" maxlength="255" placeholder="e.g. notifications-cron"
                   style="width:100%; padding:0.55rem; border:1px solid #ccc; border-radius:6px; font:inherit;">
          </label>
          <button class="btn" type="submit">Create key</button>
        </form>
      </div>
      <table>
        <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>${listRows}</tbody>
      </table>`;
  })();

  const usageBlock = missing ? '' : (() => {
    const exampleBody = {
      recipientEmail: 'someone@example.com',
      subject: 'Hello from Gmail Sender',
      body: 'Hi there,\n\nThis is a test.\n\n— sent via /send'
    };
    const exampleBodyJson = JSON.stringify(exampleBody, null, 2);
    const curl =
      `curl -X POST ${sendUrl} \\\n` +
      `  -H "Authorization: Bearer gms_..." \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '${exampleBodyJson.replace(/'/g, `'\\''`)}'`;
    return `
      <h2>Sending mail</h2>
      <p class="muted" style="margin-top:0;">
        POST a JSON body to <code>${esc(sendUrl)}</code> with your API key.
        Mail is sent as <code>${esc(email)}</code>.
      </p>
      <div class="card">
        <strong>Example request</strong>
        <pre style="background:#0b1020; color:#e6e6e6; padding:0.75rem; border-radius:6px; overflow:auto; margin:0.5rem 0 0; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;"><code>${esc(curl)}</code></pre>
      </div>
      <div class="card">
        <strong>Body fields</strong>
        <dl class="fields">
          <dt><code>body</code><span class="req">required</span></dt>
          <dd>Plain-text body (newlines preserved).</dd>
          <dt><code>recipientEmail</code><span class="req">conditional</span></dt>
          <dd>Required unless <code>threadId</code> is provided (in which case the reply-to address is read from the thread).</dd>
          <dt><code>threadId</code><span class="req">optional</span></dt>
          <dd>Gmail thread ID. If found, the message is sent as an in-thread reply with the right <code>In-Reply-To</code> / <code>References</code> headers.</dd>
          <dt><code>subject</code><span class="req">optional</span></dt>
          <dd>Defaults to <code>Re: &lt;original subject&gt;</code> on replies, <code>(no subject)</code> otherwise.</dd>
          <dt><code>htmlBody</code><span class="req">optional</span></dt>
          <dd>HTML alternative. Auto-generated from <code>body</code> if omitted (escaped, newlines &rarr; &lt;br&gt;).</dd>
          <dt><code>accountEmail</code><span class="req">optional</span></dt>
          <dd>Optional when using a per-user API key (the key already binds the call to <code>${esc(email)}</code>). If you do include it, it must match.</dd>
        </dl>
      </div>
      <div class="card">
        <strong>Success response</strong>
        <pre style="background:#f4f4f4; padding:0.75rem; border-radius:6px; overflow:auto; margin:0.5rem 0 0; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;"><code>${esc('{ "status": "ok", "mode": "new", "threadId": "...", "messageId": "...", "to": "...", "subject": "..." }')}</code></pre>
        <p class="muted" style="margin: 0.5rem 0 0;"><code>mode</code> is <code>"reply"</code> when the message went in-thread, <code>"new"</code> otherwise.</p>
      </div>`;
  })();

  return layout('Your account', `
    ${userHeader(email, csrfToken)}
    <h1>Your account</h1>
    ${missing ? stateCard : `
      <div class="main-layout">
        <section>
          ${stateCard}
          ${statsBlock}
          <div class="two-col">
            <section>${keysBlock}</section>
            <section>${usageBlock}</section>
          </div>
          ${errorBlock}
        </section>
        <section>${recentBlock}</section>
      </div>
    `}
  `);
}

function errorPage(message, { signedIn = false } = {}) {
  return layout('Error', `
    <div style="margin-top: 4rem; text-align: center;">
      <h1>Something went wrong</h1>
      <p class="sub">${esc(message)}</p>
      <p><a class="btn" href="${signedIn ? '/' : '/login'}">${signedIn ? 'Back to your account' : 'Back to sign in'}</a></p>
    </div>
  `);
}


// --- Admin (kept as a separate URL space behind admin auth) ----------------

function adminDashboard(stats, csrfToken) {
  const rows = stats.length === 0
    ? `<tr><td colspan="8"><div class="empty">No accounts enrolled yet.</div></td></tr>`
    : stats.map((s) => `
        <tr>
          <td><code>${esc(s.email)}</code></td>
          <td class="num">${s.totalSends}</td>
          <td class="num">${s.sends24h}</td>
          <td class="num">${s.sends7d}</td>
          <td class="num">${s.sends30d}</td>
          <td class="num">${s.errors30d > 0 ? `<span class="pill err">${s.errors30d}</span>` : '0'}</td>
          <td>${fmtDate(s.lastUsedAt)}</td>
          <td>
            <form class="inline" method="POST" action="/admin/unenroll"
                  onsubmit="return confirm('Unenroll ${esc(s.email)}?');">
              <input type="hidden" name="email" value="${esc(s.email)}">
              <input type="hidden" name="csrf" value="${esc(csrfToken)}">
              <button class="btn danger" type="submit">Unenroll</button>
            </form>
          </td>
        </tr>
      `).join('');
  return layout('Admin — All accounts', `
    <h1>Admin · All accounts</h1>
    <p class="sub">${stats.length} account${stats.length === 1 ? '' : 's'} connected.</p>
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th class="num">Total</th>
          <th class="num">24h</th>
          <th class="num">7d</th>
          <th class="num">30d</th>
          <th class="num">Errors 30d</th>
          <th>Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `);
}

module.exports = {
  loginPage,
  userDashboard,
  errorPage,
  adminDashboard
};
