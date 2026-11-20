// Server-rendered public leaderboard. Everything from the API is user-supplied,
// so every interpolated value goes through esc().
export function leaderboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fake LinkedIn Profiles — Leaderboard</title>
<style>
  :root {
    --bg: #0f172a; --panel: #1e293b; --panel-2: #273449; --text: #e2e8f0;
    --muted: #94a3b8; --accent: #38bdf8; --high: #f87171; --med: #fbbf24; --low: #4ade80;
    --border: #334155;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1e293b, var(--bg)); color: var(--text); }
  header { padding: 48px 24px 24px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: clamp(24px, 4vw, 40px); letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0; }
  .stats { margin: 20px auto 0; display: flex; gap: 28px; justify-content: center; }
  .stat { text-align: center; }
  .stat b { display: block; font-size: 28px; color: var(--accent); }
  .stat span { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
  main { max-width: 900px; margin: 24px auto 80px; padding: 0 16px; }
  .row { display: grid; grid-template-columns: 48px 1fr auto; gap: 14px; align-items: center;
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
    padding: 14px 16px; margin-bottom: 10px; transition: background .15s, transform .15s; }
  .row:hover { background: var(--panel-2); transform: translateY(-1px); }
  .rank { font-size: 18px; font-weight: 700; color: var(--muted); text-align: center; }
  .rank.top { color: var(--accent); }
  .who { display: flex; gap: 12px; align-items: center; min-width: 0; }
  .avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #0b1220; flex: none;
    border: 1px solid var(--border); }
  .avatar.initial { display: grid; place-items: center; color: #64748b; font-weight: 700; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name a { color: inherit; text-decoration: none; }
  .name a:hover { color: var(--accent); }
  .headline { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scores { text-align: right; flex: none; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .badge.high { background: rgba(248,113,113,.15); color: var(--high); }
  .badge.med { background: rgba(251,191,36,.15); color: var(--med); }
  .badge.low { background: rgba(74,222,128,.15); color: var(--low); }
  .reports { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .empty, .err { text-align: center; color: var(--muted); padding: 60px 0; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding-bottom: 40px; }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>🚩 Fake LinkedIn Profiles</h1>
  <p class="sub">Community-reported profiles, ranked by number of reports.</p>
  <div class="stats" id="stats"></div>
</header>
<main id="board"><p class="empty">Loading…</p></main>
<footer>Reported via the browser extension · <a href="/api/leaderboard">API</a></footer>
<script>
  const board = document.getElementById('board');
  const stats = document.getElementById('stats');
  const fmt = (n) => new Intl.NumberFormat().format(n);
  const LEVEL = { high: ['high', 'High'], medium: ['med', 'Medium'], low: ['low', 'Low'] };
  const ago = (ts) => {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  };

  async function load() {
    try {
      const res = await fetch('/api/leaderboard?limit=100');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      stats.innerHTML = [
        ['Profiles flagged', fmt(data.stats.accounts)],
        ['Total reports', fmt(data.stats.reports)],
      ].map(([label, val]) => '<div class="stat"><b>' + val + '</b><span>' + label + '</span></div>').join('');

      if (!data.rows.length) {
        board.innerHTML = '<p class="empty">No reports yet. Be the first to flag a profile.</p>';
        return;
      }
      board.innerHTML = data.rows.map((r, i) => {
        const [cls, label] = LEVEL[r.level] || LEVEL.low;
        const initial = esc((r.name || '?').slice(0, 1).toUpperCase());
        const avatar = '<div class="avatar initial">' + initial + '</div>';
        return '<div class="row">' +
          '<div class="rank' + (i < 3 ? ' top' : '') + '">#' + (i + 1) + '</div>' +
          '<div class="who">' + avatar +
            '<div style="min-width:0">' +
              '<div class="name"><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.name) + '</a></div>' +
              '<div class="headline">' + esc(r.headline || '—') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="scores">' +
            '<span class="badge ' + cls + '">' + r.score + ' · ' + label + '</span>' +
            '<div class="reports">' + r.reports + ' report' + (r.reports === 1 ? '' : 's') + ' · ' + ago(r.lastReported) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      board.innerHTML = '<p class="err">Could not load leaderboard: ' + esc(e.message) + '</p>';
    }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  load();
  setInterval(load, 60000);
</script>
</body>
</html>`;
}
