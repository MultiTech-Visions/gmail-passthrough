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
         max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
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
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin: 0.5rem 0 1rem; }
  .stat { padding: 0.75rem; border: 1px solid #e5e5e5; border-radius: 6px; }
  .stat .n { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { color: #666; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .empty { color: #888; padding: 1.25rem; text-align: center; border: 1px dashed #ddd; border-radius: 8px; }
  form.inline { display: inline; }
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
      <p class="sub">Sign in with Google to connect your Gmail account.</p>
      <p><a class="btn" href="/login/start">Sign in with Google</a></p>
    </div>
  `);
}

function fmtDate(d) {
  if (!d) return '<span class="muted">never</span>';
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return esc(String(d));
  return `<span title="${esc(date.toISOString())}">${esc(date.toISOString().replace('T', ' ').slice(0, 16))} UTC</span>`;
}


// Logged-in dashboard for a single user. `summary` may be null when the user
// hasn't connected their Gmail yet (i.e. they signed in but never granted
// gmail.send scope).
function userDashboard({ email, csrfToken, summary, recent, errors }) {
  const notConnected = !summary;

  const connectCard = notConnected
    ? `
      <div class="card">
        <h2 style="margin-top:0">Your Gmail isn't connected yet</h2>
        <p class="muted">Grant this service permission to send mail as <code>${esc(email)}</code>. You can disconnect anytime.</p>
        <p><a class="btn" href="/connect/start">Connect ${esc(email)}</a></p>
      </div>`
    : `
      <div class="card">
        <div class="row">
          <div class="grow">
            <strong><code>${esc(email)}</code></strong>
            <span class="pill ok">connected</span>
            <div class="muted" style="margin-top:0.25rem">
              Connected ${fmtDate(summary.enrolledAt)} · Last used ${fmtDate(summary.lastUsedAt)}
            </div>
          </div>
          <form class="inline" method="POST" action="/disconnect"
                onsubmit="return confirm('Disconnect ${esc(email)}? The service will lose permission to send as this account.');">
            <input type="hidden" name="csrf" value="${esc(csrfToken)}">
            <button class="btn danger" type="submit">Disconnect</button>
          </form>
        </div>
      </div>`;

  const statsBlock = notConnected ? '' : `
    <div class="grid">
      <div class="stat"><div class="n">${summary.totalSends}</div><div class="l">Total sends</div></div>
      <div class="stat"><div class="n">${summary.sends24h}</div><div class="l">Last 24h</div></div>
      <div class="stat"><div class="n">${summary.sends7d}</div><div class="l">Last 7 days</div></div>
      <div class="stat"><div class="n">${summary.sends30d}</div><div class="l">Last 30 days</div></div>
    </div>
  `;

  const recentBlock = notConnected ? '' : (() => {
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

  const errorBlock = notConnected ? '' : (() => {
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

  return layout('Your account', `
    ${userHeader(email, csrfToken)}
    <h1>Your account</h1>
    ${connectCard}
    ${statsBlock}
    ${errorBlock}
    ${recentBlock}
  `);
}

function connectedPage(email) {
  return layout('Connected', `
    <div style="margin-top: 4rem; text-align: center;">
      <h1>Connected</h1>
      <p class="sub"><code>${esc(email)}</code> can now send mail through this service.</p>
      <p><a class="btn" href="/">Back to your account</a></p>
    </div>
  `);
}

function disconnectedPage(email) {
  return layout('Disconnected', `
    <div style="margin-top: 4rem; text-align: center;">
      <h1>Disconnected</h1>
      <p class="sub"><code>${esc(email)}</code> has been removed.</p>
      <p><a class="btn" href="/">Back to your account</a></p>
    </div>
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
  connectedPage,
  disconnectedPage,
  errorPage,
  adminDashboard
};
