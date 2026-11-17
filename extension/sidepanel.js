const $ = (id) => document.getElementById(id);

let current = null; // last extracted + graded result
let reported = false;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));
}

function levelClass(score) {
  return score >= 60 ? 'high' : score >= 30 ? 'med' : 'low';
}
function levelLabel(score) {
  return score >= 60 ? 'High risk' : score >= 30 ? 'Medium risk' : 'Low risk';
}

// --- tab switching -----------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.tab));
    if (btn.dataset.tab === 'board') loadLeaderboard();
  });
});

// --- grade flow --------------------------------------------------------------
async function grade() {
  hide('state-empty'); hide('state-error'); hide('result');
  show('loading');
  const res = await send({ type: 'FLR_GRADE_ACTIVE' });
  hide('loading');

  if (!res || res.error === 'not_linkedin_profile') return show('state-empty');
  if (!res || res.error) {
    $('errorText').textContent = 'Could not read the profile. ' + (res.message || res.error || '');
    return show('state-error');
  }

  current = res;
  reported = false;
  render(res);
  show('result');
  $('reportStatus').textContent = '';
  $('reportStatus').className = 'status';
  $('reportBtn').disabled = false;
  $('reportBtn').textContent = 'Report to leaderboard';
}

function render(res) {
  const p = res.profile || {};
  const g = res.grader || { score: 0, level: 'low', reasons: [], signals: {} };

  $('name').textContent = p.name || res.normalized?.handle || 'Unknown';
  $('headline').textContent = p.headline || '—';
  $('profileLink').href = res.normalized?.url || res.url || '#';

  const av = $('avatar');
  if (p.photoUrl) { av.src = p.photoUrl; av.style.display = ''; }
  else { av.removeAttribute('src'); av.style.display = 'none'; }

  // gauge
  const card = $('scorecard');
  card.querySelector('.gauge').style.setProperty('--pct', g.score);
  $('scoreNum').textContent = g.score;
  const lvl = $('levelBadge');
  lvl.className = 'level ' + levelClass(g.score);
  lvl.textContent = levelLabel(g.score);

  // signals
  const s = g.signals || {};
  const sigs = [
    ['Connections', s.connections != null ? s.connections : '—'],
    ['Photo', s.hasPhoto ? 'Yes' : 'No'],
    ['Experience', s.experienceCount != null ? s.experienceCount : '—'],
    ['Endorsements', s.endorsements != null ? s.endorsements : '—'],
  ];
  $('signals').innerHTML = sigs
    .map(([k, v]) => `<div class="sig"><div class="k">${k}</div><div class="v">${esc(String(v))}</div></div>`)
    .join('');

  // reasons
  const ul = $('reasons');
  if (!g.reasons.length) {
    ul.innerHTML = '<li class="none">No suspicious signals detected 🎉</li>';
  } else {
    ul.innerHTML = g.reasons
      .map((r) => `<li><span>${esc(r.label)}</span><span class="w">+${r.weight}</span></li>`)
      .join('');
  }
}

$('reportBtn').addEventListener('click', async () => {
  if (!current || reported) return;
  const btn = $('reportBtn');
  btn.disabled = true;
  btn.textContent = 'Reporting…';
  const status = $('reportStatus');
  status.textContent = '';
  status.className = 'status';

  const res = await send({ type: 'FLR_REPORT', url: current.url, profile: current.profile });
  if (res && res.data && res.data.ok) {
    reported = true;
    btn.textContent = 'Reported ✓';
    status.textContent = 'Added to the leaderboard. Thanks!';
    status.className = 'status ok';
  } else {
    const err = res?.data?.error || res?.error || 'unknown_error';
    btn.disabled = false;
    btn.textContent = 'Report to leaderboard';
    if (err === 'already_reported_recently') {
      status.textContent = 'You already reported this profile recently.';
    } else if (err === 'daily_limit_reached') {
      status.textContent = 'Daily report limit reached. Try again tomorrow.';
    } else {
      status.textContent = 'Report failed: ' + err;
    }
    status.className = 'status err';
  }
});

// --- leaderboard -------------------------------------------------------------
let boardLoaded = false;
async function loadLeaderboard(force = false) {
  if (boardLoaded && !force) return;
  show('boardLoading', true);
  const res = await send({ type: 'FLR_LEADERBOARD' });
  hide('boardLoading');
  const list = $('boardList');
  const rows = res?.data?.rows;
  if (!rows) { list.innerHTML = '<div class="empty">Could not load leaderboard.</div>'; return; }
  if (!rows.length) { list.innerHTML = '<div class="empty">No reports yet. Be the first!</div>'; return; }
  list.innerHTML = rows.map((r, i) => {
    const cls = levelClass(r.avgScore);
    const initial = esc((r.name || r.handle || '?').slice(0, 1).toUpperCase());
    const avatar = r.photoUrl
      ? `<img class="bavatar" src="${esc(r.photoUrl)}" alt="" onerror="this.style.display='none'"/>`
      : `<div class="bavatar" style="display:grid;place-items:center;color:#64748b;font-weight:700">${initial}</div>`;
    return `<div class="brow">
      <div class="rank ${i < 3 ? 'top' : ''}">#${i + 1}</div>
      ${avatar}
      <div class="binfo">
        <div class="bname"><a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${esc(r.name || r.handle)}</a></div>
        <div class="bmeta">${r.reports} report${r.reports === 1 ? '' : 's'}</div>
      </div>
      <div class="bscore ${cls}">${r.avgScore}</div>
    </div>`;
  }).join('');
  boardLoaded = true;
}

// --- helpers -----------------------------------------------------------------
function show(id, inline) { const el = $(id); el.classList.remove('hidden'); if (inline) el.classList.add('pad'); }
function hide(id) { $(id).classList.add('hidden'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('retry').addEventListener('click', grade);
$('retry2').addEventListener('click', grade);
chrome.tabs?.onActivated?.addListener(() => { boardLoaded = false; });

// show API base + initial grade
(async () => {
  const cfg = await send({ type: 'FLR_CONFIG' });
  if (cfg?.API_BASE) $('apiBase').textContent = '→ ' + cfg.API_BASE;
  grade();
})();
