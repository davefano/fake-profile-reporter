// The extension UI. Mounted by the Chrome side panel, the Firefox sidebar, and
// the Safari popup (Safari has no sidebar API).

import type { LeaderboardRow, RiskLevel } from '@flr/core';
import { siteDomain, type CompanyFacts, type FactChange, type ProfileFacts } from '@flr/core/linkedin';
import { levelFor, type Score, type Signal } from '@flr/core/scam';
import {
  isError,
  linkedInTarget,
  scanKey,
  sendMessage,
  targetKey,
  type CompanyScan,
  type ErrorResponse,
  type JobScan,
  type ProfileScan,
  type ScanResult,
} from '@/lib/messages';
import './panel.css';

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 4.5 7v8.2c0 7.1 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.2 11.5-14.3V7z" fill="currentColor" opacity=".14"/><path d="M16 2.5 4.5 7v8.2c0 7.1 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.2 11.5-14.3V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15" cy="14.5" r="4.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m18.4 18 3.6 3.6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const CHECK = `<svg viewBox="0 0 16 16" aria-label="Work email verified"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const MARKUP = `
<header class="top">
  <div class="brand">
    <span class="mark">${LOGO}</span>
    <div class="brand-text">
      <div class="title">Fake LinkedIn Reporter</div>
      <div class="subtitle" id="apiBase">Side Panel</div>
    </div>
    <button class="icon-btn" id="rescan" title="Scan again" aria-label="Scan again">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 10a6.5 6.5 0 1 1-2-4.7M16.5 3.5v3.8h-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="scan" role="tab">This page</button>
    <button class="tab" data-tab="board" role="tab">Leaderboard</button>
  </nav>
</header>

<main>
  <section id="view-scan" class="view active">
    <div id="state-loading" class="hidden">
      <div class="skel-hero"><div class="skel circle"></div><div class="skel-lines"><div class="skel w70"></div><div class="skel w90"></div><div class="skel w40"></div></div></div>
      <div class="skel-score"><div class="skel num"></div><div class="skel-lines"><div class="skel w40"></div><div class="skel w90"></div></div></div>
      <div class="skel bar"></div>
      <div class="skel-grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>
      <p class="loading-step" id="loadingStep" role="status">Reading the page…</p>
    </div>

    <div id="state-empty" class="hidden">
      <div class="empty">
        <svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true">
          <rect x="14" y="14" width="76" height="62" rx="10" fill="var(--sunken)" stroke="var(--line)" stroke-width="2"/>
          <circle cx="38" cy="38" r="10" fill="var(--line)"/>
          <rect x="54" y="32" width="26" height="5" rx="2.5" fill="var(--line)"/>
          <rect x="54" y="42" width="18" height="5" rx="2.5" fill="var(--line)"/>
          <rect x="26" y="58" width="52" height="5" rx="2.5" fill="var(--line)"/>
          <circle cx="86" cy="62" r="14" fill="var(--bg)" stroke="var(--accent)" stroke-width="3.5"/>
          <path d="m96 72 10 10" stroke="var(--accent)" stroke-width="4.5" stroke-linecap="round"/>
        </svg>
        <h2>Open a profile, company, or job</h2>
        <p>Go to a LinkedIn profile, company page, or job posting. This panel follows your tab and checks each one you open.</p>
      </div>
    </div>

    <div id="state-error" class="hidden">
      <div class="empty">
        <h2 id="errorTitle">Couldn't read this profile</h2>
        <p id="errorText"></p>
        <button id="retry" class="btn secondary">Try again</button>
      </div>
    </div>

    <div id="result" class="hidden"></div>
  </section>

  <section id="view-board" class="view">
    <div id="boardList"></div>
  </section>
</main>
`;

const VERDICT: Record<RiskLevel, { title: string; text: string }> = {
  high: { title: 'High suspicion', text: "Several things on this profile don't add up. Verify the person before you share anything or move forward." },
  medium: { title: 'Some concerns', text: 'A few things are worth checking. Plenty of real profiles look like this too.' },
  low: {
    title: 'Low suspicion',
    text: "Nothing major stands out. This can't confirm that the person contacting you owns this profile.",
  },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATES = ['state-loading', 'state-empty', 'state-error', 'result'] as const;

let current: ScanResult | null = null;
let scanSeq = 0;
let lastKey: string | null = null;
let loadingTimer: ReturnType<typeof setInterval> | undefined;

// --- state ---------------------------------------------------------------------
function showState(id: (typeof STATES)[number]) {
  for (const s of STATES) $(s).classList.toggle('hidden', s !== id);
  clearInterval(loadingTimer);
  if (id === 'state-loading') {
    const steps = ['Reading the page…', 'Checking history…', 'Looking at activity…', 'Scoring…'];
    let i = 0;
    $('loadingStep').textContent = steps[0]!;
    loadingTimer = setInterval(() => ($('loadingStep').textContent = steps[Math.min(++i, steps.length - 1)]!), 900);
  }
}

async function scan(force = false) {
  const seq = ++scanSeq;
  showState('state-loading');
  $('rescan').classList.add('spinning');
  const res = await sendMessage<'FLR_SCAN'>({ type: 'FLR_SCAN', force }).catch((e): ErrorResponse => ({ error: 'panel_error', message: String(e) }));
  if (seq !== scanSeq) return; // a newer scan started
  $('rescan').classList.remove('spinning');

  if (isError(res)) {
    if (res.error === 'not_linkedin_profile') return showState('state-empty');
    const gone = res.error === 'profile_unavailable' || res.error === 'not_found';
    $('errorTitle').textContent = gone ? 'Nothing to check here' : "Couldn't read this page";
    $('errorText').textContent = gone
      ? 'LinkedIn returned nothing for this page. It may have been removed or restricted, or its URL changed. That is not evidence either way.'
      : res.message || res.error;
    return showState('state-error');
  }
  current = res;
  lastKey = scanKey(res);
  $('result').innerHTML = renderResult(res);
  bindResult();
  showState('result');
}

// --- rendering -------------------------------------------------------------------
function renderResult(r: ScanResult): string {
  const body = r.kind === 'company' ? renderCompany(r) : r.kind === 'job' ? renderJob(r) : renderProfile(r);
  return `${body}
  <p class="foot"><span>Checked ${r.cached ? ago(r.capturedAt) : 'just now'}${r.cached ? ' (cached)' : ''}</span><span>Score v${r.score.version}. A suspicion score, not a verdict.</span></p>
  ${actions(r)}`;
}

const NOUN = { profile: 'profile', company: 'company page', job: 'job posting' } as const;

function scoreBlock(s: Score, kind: ScanResult['kind']) {
  const v = VERDICT[s.level];
  const text = kind === 'profile' ? v.text : v.text.replace('this profile', `this ${NOUN[kind]}`).replace(/ This can't confirm.*$/, '');
  return `<section class="score level-${s.level}" aria-label="Suspicion score ${s.score} out of 100, ${v.title}">
    <div class="score-head">
      <div class="score-num"><strong>${s.score}</strong><span>/100</span></div>
      <div class="verdict">
        <h2>${v.title}</h2>
        <p>${text}</p>
      </div>
    </div>
    ${meter(s.score)}
  </section>`;
}

function signalsBlock(s: Score) {
  const groups = groupSignals(s.signals);
  return `${groups.discrepancy.length ? signalGroup("Doesn't add up", 'discrepancy', groups.discrepancy) : ''}
  ${groups.weak.length ? signalGroup('Weak signals', 'weak', groups.weak) : ''}
  ${groups.trust.length ? signalGroup('In their favor', 'trust', groups.trust) : ''}
  ${s.missing.length ? `<section class="group missing"><h3>Not checked</h3><ul>${s.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></section>` : ''}`;
}

function actions(r: ScanResult) {
  const track = r.kind === 'profile' ? 'Save this snapshot so future checks show what changed' : `Save this ${NOUN[r.kind]} to the directory`;
  return `<div class="actions">
    <p class="status" id="submitStatus" role="status"></p>
    <div class="btn-row">
      <button class="btn secondary" id="trackBtn" title="${track}">Track</button>
      <button class="btn danger" id="reportBtn">Report ${r.kind === 'job' ? 'this job' : r.kind === 'company' ? 'this company' : 'as suspicious'}</button>
    </div>
  </div>`;
}

function renderProfile(r: ProfileScan): string {
  const f = r.facts;
  const name = [f.firstName, f.lastName].filter(Boolean).join(' ') || r.slug;
  const s = r.score;
  return `
  <article class="hero">
    ${avatar(f.photoUrl, name)}
    <div class="who">
      <h1 class="name">${esc(name)}</h1>
      ${f.headline ? `<p class="headline">${esc(f.headline)}</p>` : ''}
      <p class="meta">
        ${f.geoName ? `<span>${esc(f.geoName)}</span>` : ''}
        <span class="mono" title="LinkedIn member ID. Stays the same when the profile URL changes.">#${f.memberId}</span>
      </p>
    </div>
  </article>

  ${r.changes.length ? renderChanges(r.changes, r.previousCheckAt) : ''}
  ${scoreBlock(s, 'profile')}

  <dl class="facts">
    ${fact('Joined', f.joined ? monthYear(f.joined.at) : '—', f.joined ? `${ageText(f.joined.at)}${f.joined.source === 'memberId' ? ' · est.' : ''}` : '')}
    ${fact('Connections', f.connections ? `${f.connections.count.toLocaleString()}${f.connections.capped ? '+' : ''}` : 'Hidden')}
    ${fact('Followers', f.followers != null ? compact(f.followers) : '—')}
    ${fact('Last post', f.activity ? (f.activity.newestAt ? ago(f.activity.newestAt) : 'Never') : '—', f.activity?.postCount ? `${f.activity.postCount} recent` : '')}
    ${fact('Verified', verifiedText(f).value, verifiedText(f).note)}
    ${fact('Photo', f.photo?.present ? (f.photo.uploadedAt ? monthYear(f.photo.uploadedAt) : 'Yes') : 'None', f.photo?.present && f.photo.uploadedAt ? 'uploaded' : '')}
  </dl>

  ${signalsBlock(s)}
  ${renderTimeline(f, s.signals.some((x) => x.id === 'pattern.career-vs-age'))}`;
}

function employeeNote(c: CompanyFacts) {
  const e = c.extras?.employees;
  const visible = e ? e.sampled - e.hidden : 0;
  if (e && visible >= 5) return `${e.newAccounts} of ${visible} sampled are new`;
  return c.employeesOnLinkedIn != null ? 'employees' : '';
}

function companyFacts(c: CompanyFacts) {
  const domain = siteDomain(c.website);
  return `<dl class="facts">
    ${fact('Founded', c.foundedYear ? String(c.foundedYear) : '—', c.foundedYear ? `${new Date().getUTCFullYear() - c.foundedYear} years ago` : '')}
    ${fact('Claims', c.claimedSize ? c.claimedSize.label.replace(/ employees$/, '') : '—', c.claimedSize ? 'employees' : '')}
    ${fact('On LinkedIn', c.employeesOnLinkedIn != null ? compact(c.employeesOnLinkedIn) : '—', employeeNote(c))}
    ${fact('Followers', c.followers != null ? compact(c.followers) : '—')}
    ${fact('Website', domain ?? 'None')}
    ${fact('Last post', c.posts.newestAt ? ago(c.posts.newestAt) : 'None')}
  </dl>`;
}

function renderCompany(r: CompanyScan): string {
  const c = r.facts;
  const name = c.name ?? r.slug;
  return `
  <article class="hero">
    ${avatar(c.logo.url, name, true)}
    <div class="who">
      <h1 class="name">${esc(name)}</h1>
      ${c.tagline ? `<p class="headline">${esc(c.tagline)}</p>` : ''}
      <p class="meta">
        ${[c.industry, c.headquarters].filter(Boolean).map((x) => `<span>${esc(x!)}</span>`).join('')}
        ${c.companyId ? `<span class="mono" title="LinkedIn company ID. Stays the same when the page is renamed.">#${c.companyId}</span>` : ''}
      </p>
    </div>
  </article>

  ${r.changes.length ? renderChanges(r.changes, r.previousCheckAt) : ''}
  ${scoreBlock(r.score, 'company')}
  ${companyFacts(c)}
  ${signalsBlock(r.score)}`;
}

function renderJob(r: JobScan): string {
  const j = r.facts;
  const c = r.company;
  const x = j.extras;
  const pay = j.salary ? j.salary.text.replace(/\.00/g, '') : 'Not listed';
  const meta = [j.company.name, j.location].filter(Boolean) as string[];
  return `
  <article class="hero">
    ${avatar(c?.facts.logo.url ?? null, j.company.name ?? j.title ?? '?', true)}
    <div class="who">
      <h1 class="name">${esc(j.title ?? 'Job posting')}</h1>
      <p class="headline">${esc(meta.join(' · '))}</p>
      <p class="meta">
        ${j.postedText ? `<span>${esc(j.reposted ? j.postedText : `Posted ${j.postedText}`)}</span>` : ''}
        ${j.applicants ? `<span>${j.applicants.over ? 'Over ' : ''}${j.applicants.count.toLocaleString()} applicants</span>` : ''}
      </p>
    </div>
  </article>

  ${r.changes.length ? renderChanges(r.changes, r.previousCheckAt) : ''}
  ${scoreBlock(r.score, 'job')}

  <dl class="facts">
    ${fact('Pay', pay)}
    ${fact('Type', j.employmentType ?? '—', [j.extras?.remote ? 'Remote' : null, j.seniority && j.seniority !== 'Not Applicable' ? j.seniority : null].filter(Boolean).join(' · '))}
    ${fact('Apply', j.apply === 'easy' ? 'Easy Apply' : (siteDomain(x?.applyUrl) ?? (j.apply === 'offsite' ? 'Company site' : '—')), j.apply === 'offsite' && x?.applyUrl ? 'external site' : '')}
    ${x?.listedAt ? fact('Listed', monthDay(x.listedAt), x.originalListedAt && x.listedAt - x.originalListedAt > 86_400_000 ? `first ${monthDay(x.originalListedAt)}` : '') : ''}
    ${x ? fact('Verified job', x.verified ? 'Yes' : x.verified === false ? 'No' : '—') : ''}
    ${x?.expireAt ? fact('Closes', monthDay(x.expireAt), x.state && x.state !== 'LISTED' ? x.state.toLowerCase() : '') : ''}
  </dl>

  ${signalsBlock(r.score)}
  ${
    x?.hiringTeam.length
      ? `<section class="group"><h3>Hiring team<span class="count">${x.hiringTeam.length}</span></h3><ul class="signals">${x.hiringTeam
          .map((p) => `<li><a class="link" href="https://www.linkedin.com/in/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener">${esc(p.name ?? p.slug)}</a><span class="count">check profile</span></li>`)
          .join('')}</ul></section>`
      : ''
  }
  ${
    c
      ? `<section class="group company-sub level-${c.score.level}">
      <h3>Company page<span class="count">${esc(c.facts.name ?? '')}</span><span class="sub-score">${c.score.score}<small>/100</small></span></h3>
      ${companyFacts(c.facts)}
      ${c.score.signals.filter((x) => x.weight > 0).slice(0, 4).length ? `<ul class="signals compact">${c.score.signals.filter((x) => x.weight > 0).slice(0, 4).map((x) => `<li><span>${esc(x.label)}</span><span class="w">+${Math.round(x.weight)}</span></li>`).join('')}</ul>` : ''}
    </section>`
      : ''
  }`;
}

function avatar(photoUrl: string | null, name: string, square = false) {
  const initials = esc(name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase());
  const url = photoUrl && /^https:\/\//.test(photoUrl) ? photoUrl : null;
  return `<div class="avatar${square ? ' square' : ''}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : ''}<span>${initials}</span></div>`;
}

/** Score on a fixed low / medium / high scale, so the number has context. */
function meter(score: number) {
  const pct = Math.max(0, Math.min(100, score));
  return `<div class="meter" aria-hidden="true">
    <div class="meter-track"><i class="z-low"></i><i class="z-med"></i><i class="z-high"></i><b style="left:${pct}%"></b></div>
    <div class="meter-labels"><span>Low</span><span>Medium</span><span>High</span></div>
  </div>`;
}

function fact(label: string, value: string, note = '') {
  return `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
}

function groupSignals(signals: Signal[]) {
  return {
    discrepancy: signals.filter((x) => x.kind === 'discrepancy'),
    weak: signals.filter((x) => x.kind === 'weak'),
    trust: signals.filter((x) => x.kind === 'trust'),
  };
}

function signalGroup(title: string, kind: Signal['kind'], list: Signal[]) {
  return `<section class="group ${kind}"><h3>${title}<span class="count">${list.length}</span></h3><ul class="signals">${list
    .map((x) => {
      const w = Math.round(x.weight * 10) / 10;
      return `<li><span>${esc(x.label)}</span><span class="w">${w > 0 ? '+' : '−'}${Math.abs(w)}</span></li>`;
    })
    .join('')}</ul></section>`;
}

/** Career spans against the account's join date: the mismatch is visible at a glance. */
function renderTimeline(f: ProfileFacts, mismatch: boolean) {
  const key = (p: (typeof f.positions)[number]) => (p.start?.year ?? 0) * 12 + (p.start?.month ?? 1);
  const pos = f.positions.filter((p) => p.start?.year).sort((a, b) => key(b) - key(a)).slice(0, 6);
  if (!pos.length) return '';
  const now = new Date();
  const toYears = (y: number, m = 1) => y + (m - 1) / 12;
  const nowY = toYears(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const joinY = f.joined ? toYears(new Date(f.joined.at).getUTCFullYear(), new Date(f.joined.at).getUTCMonth() + 1) : null;
  const minY = Math.floor(Math.min(...pos.map((p) => toYears(p.start!.year, p.start!.month)), joinY ?? nowY));
  const span = Math.max(1, nowY - minY);
  const x = (y: number) => ((y - minY) / span) * 100;
  const verified = (f.about?.verifications ?? []).map((v) => v.toLowerCase());

  const rows = pos
    .map((p) => {
      const a = toYears(p.start!.year, p.start!.month);
      const b = p.end?.year ? toYears(p.end.year, p.end.month) : nowY;
      const ok = !!p.company && verified.some((v) => v.startsWith(p.company!.toLowerCase()));
      const years = `${p.start!.year}–${p.end?.year ?? 'now'}`;
      return `<li>
        <div class="tl-label"><span class="tl-title">${esc(p.title ?? 'Untitled')}${p.company ? ` <span class="tl-co">· ${esc(p.company)}</span>` : ''}${ok ? ` <span class="tick" title="Work email verified">${CHECK}</span>` : ''}</span><span class="tl-years">${years}</span></div>
        <div class="tl-track"><i class="${p.end ? '' : 'current'}" style="left:${x(a)}%;width:${Math.max(1.5, x(b) - x(a))}%"></i></div>
      </li>`;
    })
    .join('');

  // The join date is marked inside each track only, so it never crosses the titles.
  const jx = joinY != null ? x(joinY) : null;
  const joinLabel =
    jx != null
      ? `<div class="tl-joined"><span class="${jx < 30 ? 'start' : jx > 70 ? 'end' : ''}" style="left:${jx}%">Joined LinkedIn ${monthYear(f.joined!.at)}</span></div>`
      : '';
  return `<section class="group timeline"><h3>Career vs. account age</h3>
    <div class="tl-wrap${jx != null ? ' has-join' : ''}${mismatch ? ' bad' : ''}" style="${jx != null ? `--join:${jx}%` : ''}"><ul>${rows}</ul>${joinLabel}</div>
    <div class="tl-axis"><span>${minY}</span><span>${now.getUTCFullYear()}</span></div></section>`;
}

function renderChanges(changes: FactChange[], since: number | null) {
  const LABEL: Record<string, string> = {
    slug: 'Profile URL', firstName: 'First name', lastName: 'Last name', headline: 'Headline', summary: 'About',
    geoName: 'Location', countryCode: 'Country', industry: 'Industry', photo: 'Photo', background: 'Banner',
    positions: 'Experience', educations: 'Education', about: 'Account history', connections: 'Connections',
    premium: 'Premium', creator: 'Creator mode', influencer: 'Top Voice',
  };
  const items = changes.map((c) => LABEL[c.field] ?? c.field);
  return `<section class="changes"><strong>Changed since you last checked${since ? ` (${ago(since)})` : ''}:</strong> ${esc(items.join(', '))}</section>`;
}

// --- actions ---------------------------------------------------------------------
function bindResult() {
  $('trackBtn').addEventListener('click', () => submit(false));
  $('reportBtn').addEventListener('click', () => submit(true));
  $('result').querySelectorAll<HTMLImageElement>('.avatar img').forEach((img) =>
    img.addEventListener('error', () => img.remove(), { once: true }),
  );
}

async function submit(report: boolean) {
  if (!current) return;
  const btn = $<HTMLButtonElement>(report ? 'reportBtn' : 'trackBtn');
  const other = $<HTMLButtonElement>(report ? 'trackBtn' : 'reportBtn');
  const status = $('submitStatus');
  const label = btn.textContent;
  btn.disabled = other.disabled = true;
  btn.textContent = report ? 'Reporting…' : 'Saving…';
  status.className = 'status';
  status.textContent = '';

  const res = await sendMessage<'FLR_SUBMIT'>({ type: 'FLR_SUBMIT', key: scanKey(current), report }).catch((e): ErrorResponse => ({
    error: 'panel_error',
    message: String(e),
  }));
  if (!isError(res)) {
    btn.textContent = report ? 'Reported ✓' : 'Tracked ✓';
    other.disabled = report; // can still report after tracking
    status.className = 'status ok';
    status.textContent = report ? 'Reported and saved to the directory. Thank you.' : 'Snapshot saved. Future checks will show what changed.';
    return;
  }
  btn.disabled = other.disabled = false;
  btn.textContent = label;
  status.className = 'status err';
  const MSG: Record<string, string> = {
    already_reported_recently: 'You reported this profile recently.',
    daily_limit_reached: 'Daily limit reached. Try again tomorrow.',
    captured_recently: 'This profile was saved a few minutes ago.',
  };
  status.textContent = MSG[res.error] ?? res.message ?? res.error;
}

// --- leaderboard -----------------------------------------------------------------
let boardLoaded = false;
async function loadLeaderboard() {
  if (boardLoaded) return;
  const list = $('boardList');
  list.innerHTML = '<div class="skel row"></div>'.repeat(5);
  const res = await sendMessage<'FLR_LEADERBOARD'>({ type: 'FLR_LEADERBOARD' }).catch(() => undefined);
  const rows: LeaderboardRow[] | undefined = res && !isError(res) ? res.data.rows : undefined;
  if (!rows) {
    list.innerHTML = `<div class="empty"><h2>Leaderboard unavailable</h2><p>${esc(res && isError(res) ? (res.message ?? res.error) : 'Could not load it.')}</p></div>`;
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><h2>No reports yet</h2><p>Profiles you report show up here.</p></div>';
    return;
  }
  list.innerHTML = `<ol class="board">${rows
    .map((r, i) => {
      const lvl = levelFor(r.avgScore);
      const name = r.name || r.handle;
      const initials = esc(name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase());
      const img = r.photoUrl && /^https:\/\//.test(r.photoUrl) ? `<img src="${esc(r.photoUrl)}" alt="" referrerpolicy="no-referrer">` : '';
      return `<li>
        <span class="rank">${i + 1}</span>
        <div class="avatar sm">${img}<span>${initials}</span></div>
        <a class="b-name" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(name)}<small>${r.reports} report${r.reports === 1 ? '' : 's'}</small></a>
        <span class="b-score level-${lvl}">${r.avgScore}</span>
      </li>`;
    })
    .join('')}</ol>`;
  list.querySelectorAll<HTMLImageElement>('.avatar img').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  boardLoaded = true;
}

// --- formatting ------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthYear(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = s / 86400;
  if (d < 45) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return monthYear(ms);
}
function monthDay(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${d.getUTCFullYear() !== new Date().getUTCFullYear() ? `, ${d.getUTCFullYear()}` : ''}`;
}
function ageText(ms: number) {
  const days = (Date.now() - ms) / 86_400_000;
  return days < 60 ? `${Math.floor(days)} days old` : days < 730 ? `${Math.floor(days / 30)} months old` : `${Math.floor(days / 365.25)} years old`;
}
function verifiedText(f: ProfileFacts): { value: string; note: string } {
  if (!f.about) return { value: '—', note: '' };
  const v = f.about.verifications;
  if (!v.length) return { value: 'None', note: '' };
  if (v.some((x) => /^identity/i.test(x))) return { value: 'Identity', note: v.length > 1 ? `+${v.length - 1} more` : '' };
  const work = v.find((x) => /work email/i.test(x));
  return work ? { value: 'Work email', note: work.split(':')[0]! } : { value: v[0]!.split(':')[0]!, note: '' };
}
function compact(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString();
}
function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// --- mount -----------------------------------------------------------------------
function bindTabs() {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.tab));
      if (btn.dataset.tab === 'board') loadLeaderboard();
    });
  });
}

/** Follow the active tab: rescan when it lands on a different profile. */
function followTabs() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const key = targetKey(linkedInTarget(tab?.url));
      if (key !== lastKey) {
        lastKey = key;
        scan();
      }
    }, 400);
  };
  browser.tabs.onActivated.addListener(check);
  browser.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.url || info.status === 'complete')) check();
  });
}

/**
 * Tell the background this window's panel is open, so the toolbar button can
 * close it. Reconnects if the service worker restarts.
 */
async function announcePanel() {
  if (!(browser as any).sidePanel) return; // Chrome only; Firefox/Safari toggle natively.
  const win = await browser.windows.getCurrent().catch(() => null);
  if (!win?.id) return;
  const connect = () => {
    let port: Browser.runtime.Port;
    try {
      port = browser.runtime.connect({ name: `panel:${win.id}` });
    } catch {
      return; // extension was reloaded or removed; this page is orphaned
    }
    port.onMessage.addListener((msg) => {
      if (msg === 'close') window.close();
    });
    port.onDisconnect.addListener(() => setTimeout(connect, 250));
  };
  connect();
}

export async function mountPanel() {
  document.body.innerHTML = MARKUP;
  bindTabs();
  $('rescan').addEventListener('click', () => scan(true));
  $('retry').addEventListener('click', () => scan(true));
  followTabs();
  announcePanel();

  // Scan first so the loading state shows at once; the config label can follow.
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  lastKey = targetKey(linkedInTarget(tab?.url));
  scan();
  const cfg = await sendMessage<'FLR_CONFIG'>({ type: 'FLR_CONFIG' }).catch(() => undefined);
  if (cfg?.API_BASE) $('apiBase').textContent = `Side Panel · ${new URL(cfg.API_BASE).host}`;
}
