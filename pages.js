// Server-side HTML rendering for the self-serve enrollment / dashboard pages.
// Plain HTML + inline CSS — no build step, no client framework.

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
         max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
  h2 { margin: 2rem 0 0.5rem; font-size: 1.2rem; }
  .sub { color: #666; margin-bottom: 1.5rem; }
  .btn { display: inline-block; padding: 0.6rem 1rem; border-radius: 6px;
         background: #1a73e8; color: white; text-decoration: none; border: 0;
         font-size: 0.95rem; cursor: pointer; }
  .btn.secondary { background: transparent; color: #1a73e8; border: 1px solid #1a73e8; }
  .btn.danger { background: #d93025; }
  .btn:hover { opacity: 0.92; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: 0.8rem; color: #666; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #888; }
  .card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 99px;
          font-size: 0.75rem; background: #eef; color: #335; }
  .pill.err { background: #fee; color: #a00; }
  .pill.ok { background: #efe; color: #050; }
  .row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .grow { flex: 1; }
  code { background: #f4f4f4; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.9em; }
  .empty { color: #888; padding: 2rem; text-align: center; border: 1px dashed #ddd; border-radius: 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #ddd; }
    .card, th, td { border-color: #333; }
    th { color: #999; }
    .sub, .muted { color: #999; }
    code { background: #2a2a2a; }
    .pill { background: #234; color: #cdf; }
    .pill.err { background: #422; color: #fcc; }
    .pill.ok { background: #242; color: #cfc; }
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

function landingPage() {
  return layout('Gmail Sender — Enroll', `
    <h1>Gmail Sender</h1>
    <p class="sub">Connect a Gmail account so this service can send mail on its behalf.</p>
    <p><a class="btn" href="/oauth/start?action=enroll">Connect a Gmail account</a></p>
    <p><a href="/accounts">View enrolled accounts &rarr;</a></p>
  `);
}

function enrollSuccessPage(email) {
  return layout('Enrolled', `
    <h1>Connected</h1>
    <p class="sub"><code>${esc(email)}</code> is now enrolled and can send mail through this service.</p>
    <p><a class="btn" href="/accounts">View enrolled accounts</a> <a class="btn secondary" href="/enroll">Enroll another</a></p>
  `);
}

function unenrollSuccessPage(email) {
  return layout('Unenrolled', `
    <h1>Disconnected</h1>
    <p class="sub"><code>${esc(email)}</code> has been removed and its refresh token revoked at Google.</p>
    <p><a class="btn secondary" href="/accounts">Back to accounts</a></p>
  `);
}

function errorPage(message) {
  return layout('Error', `
    <h1>Something went wrong</h1>
    <p class="sub">${esc(message)}</p>
    <p><a class="btn secondary" href="/enroll">Back to start</a></p>
  `);
}

function fmtDate(d) {
  if (!d) return '<span class="muted">never</span>';
  const date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return esc(String(d));
  return `<span title="${esc(date.toISOString())}">${esc(date.toISOString().replace('T', ' ').slice(0, 16))} UTC</span>`;
}

function accountsDashboard(stats) {
  const rows = stats.length === 0
    ? `<tr><td colspan="7"><div class="empty">No accounts enrolled yet. <a href="/enroll">Enroll one &rarr;</a></div></td></tr>`
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
            <a class="btn secondary" href="/account?email=${encodeURIComponent(s.email)}">Details</a>
            <a class="btn danger" href="/unenroll/start?email=${encodeURIComponent(s.email)}"
               onclick="return confirm('Unenroll ${esc(s.email)}? You will need to sign in with that Google account to confirm.')">Unenroll</a>
          </td>
        </tr>
      `).join('');

  return layout('Enrolled accounts', `
    <div class="row">
      <div class="grow"><h1>Enrolled accounts</h1>
      <p class="sub">${stats.length} account${stats.length === 1 ? '' : 's'} connected.</p></div>
      <a class="btn" href="/enroll">+ Enroll account</a>
    </div>
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

function accountDetailPage(email, summary, recent, errors) {
  const recentRows = recent.length === 0
    ? `<tr><td colspan="5"><div class="empty">No sends recorded yet.</div></td></tr>`
    : recent.map((r) => `
        <tr>
          <td>${fmtDate(r.sent_at)}</td>
          <td><span class="pill ${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span> ${r.mode ? `<span class="muted">${esc(r.mode)}</span>` : ''}</td>
          <td><code>${esc(r.recipient || '—')}</code></td>
          <td>${esc(r.subject || '')}</td>
          <td class="muted">${esc(r.error_message || '')}</td>
        </tr>
      `).join('');

  const errorRows = errors.length === 0
    ? `<p class="muted">No errors in the last 30 days.</p>`
    : `<table>
        <thead><tr><th class="num">Count</th><th>Error</th><th>Last seen</th></tr></thead>
        <tbody>
          ${errors.map((e) => `
            <tr>
              <td class="num">${Number(e.count)}</td>
              <td><code>${esc(e.error_message || '(no message)')}</code></td>
              <td>${fmtDate(e.last_seen)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

  return layout(`Account — ${email}`, `
    <p><a href="/accounts">&larr; All accounts</a></p>
    <h1><code>${esc(email)}</code></h1>
    <p class="sub">
      Enrolled ${fmtDate(summary.enrolledAt)} ·
      Last used ${fmtDate(summary.lastUsedAt)} ·
      ${summary.totalSends} total sends
    </p>

    <div class="card">
      <div class="row">
        <div class="grow"><strong>Quick stats</strong></div>
        <div>24h: <strong>${summary.sends24h}</strong></div>
        <div>7d: <strong>${summary.sends7d}</strong></div>
        <div>30d: <strong>${summary.sends30d}</strong></div>
        <div>Errors 30d: <strong>${summary.errors30d}</strong></div>
      </div>
    </div>

    <h2>Error breakdown (30d)</h2>
    ${errorRows}

    <h2>Recent sends</h2>
    <table>
      <thead><tr><th>When</th><th>Status</th><th>Recipient</th><th>Subject</th><th>Error</th></tr></thead>
      <tbody>${recentRows}</tbody>
    </table>

    <p>
      <a class="btn danger" href="/unenroll/start?email=${encodeURIComponent(email)}"
         onclick="return confirm('Unenroll ${esc(email)}?')">Unenroll this account</a>
    </p>
  `);
}

module.exports = {
  landingPage,
  enrollSuccessPage,
  unenrollSuccessPage,
  errorPage,
  accountsDashboard,
  accountDetailPage
};
