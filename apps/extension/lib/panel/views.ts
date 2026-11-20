// HTML for a scan result. Pure functions of the scan; all text is escaped.

import { siteDomain, verifiedEmployers, type CompanyFacts, type FactChange, type ProfileFacts } from '@flr/core/linkedin';
import type { RiskLevel, Score, Signal } from '@flr/core/scam';
import type { CompanyScan, JobScan, ProfileScan, ScanResult } from '@/lib/scan/messages';
import { ago, ageText, compact, esc, monthDay, monthYear } from './format';

const CHECK = `<svg viewBox="0 0 16 16" aria-label="Work email verified"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// --- rendering -------------------------------------------------------------------
export function renderResult(r: ScanResult): string {
  const body = r.kind === 'company' ? renderCompany(r) : r.kind === 'job' ? renderJob(r) : renderProfile(r);
  return `${body}
  <p class="foot"><span>Checked ${r.cached ? ago(r.capturedAt) : 'just now'}${r.cached ? ' (cached)' : ''}</span><span>Score v${r.score.version}. A suspicion score, not a verdict.</span></p>
  ${actions(r)}`;
}

const NOUN = { profile: 'profile', company: 'company page', job: 'job posting' } as const;

const TITLE: Record<RiskLevel, string> = { high: 'High suspicion', medium: 'Some concerns', low: 'Low suspicion' };

function verdictText(level: RiskLevel, kind: ScanResult['kind']): string {
  if (level === 'high') return `Several things on this ${NOUN[kind]} don't add up. Verify it before you share anything or move forward.`;
  if (level === 'medium') return `A few things are worth checking. Plenty of real ${NOUN[kind]}s look like this too.`;
  // A real profile can still be used by someone else (impersonation).
  return kind === 'profile'
    ? "Nothing major stands out. This can't confirm that the person contacting you owns this profile."
    : 'Nothing major stands out.';
}

function scoreBlock(s: Score, kind: ScanResult['kind']) {
  const v = { title: TITLE[s.level], text: verdictText(s.level, kind) };
  return `<section class="score level-${s.level}" aria-label="Suspicion score ${s.score} out of 100, ${v.title}">
    <div class="score-head">
      <div class="score-num"><strong>${s.score}</strong><span>/100</span></div>
      <div class="verdict">
        <h2>${v.title}</h2>
        <p>${v.text}</p>
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
  const track = `Save this ${NOUN[r.kind]} to the shared directory, without reporting it`;
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

  ${r.changes.length ? renderChanges(r.kind, r.changes, r.previousCheckAt) : ''}
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
    ${avatar(c.logoUrl, name, 'square')}
    <div class="who">
      <h1 class="name">${esc(name)}</h1>
      ${c.tagline ? `<p class="headline">${esc(c.tagline)}</p>` : ''}
      <p class="meta">
        ${[c.industry, c.headquarters].filter(Boolean).map((x) => `<span>${esc(x!)}</span>`).join('')}
        ${c.companyId ? `<span class="mono" title="LinkedIn company ID. Stays the same when the page is renamed.">#${c.companyId}</span>` : ''}
      </p>
    </div>
  </article>

  ${r.changes.length ? renderChanges(r.kind, r.changes, r.previousCheckAt) : ''}
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
    ${avatar(c?.facts.logoUrl ?? null, j.company.name ?? j.title ?? '?', 'square')}
    <div class="who">
      <h1 class="name">${esc(j.title ?? 'Job posting')}</h1>
      <p class="headline">${esc(meta.join(' · '))}</p>
      <p class="meta">
        ${j.postedText ? `<span>${esc(j.reposted ? j.postedText : `Posted ${j.postedText}`)}</span>` : ''}
        ${j.applicants ? `<span>${j.applicants.over ? 'Over ' : ''}${j.applicants.count.toLocaleString()} applicants</span>` : ''}
      </p>
    </div>
  </article>

  ${r.changes.length ? renderChanges(r.kind, r.changes, r.previousCheckAt) : ''}
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

export function avatar(photoUrl: string | null, name: string, cls = '') {
  const initials = esc(name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase());
  const url = photoUrl && /^https:\/\//.test(photoUrl) ? photoUrl : null;
  return `<div class="avatar${cls ? ` ${cls}` : ''}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : ''}<span>${initials}</span></div>`;
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
  const verified = verifiedEmployers(f.about);

  const rows = pos
    .map((p) => {
      const a = toYears(p.start!.year, p.start!.month);
      const b = p.end?.year ? toYears(p.end.year, p.end.month) : nowY;
      const ok = !!p.company && verified.includes(p.company.toLowerCase());
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

const CHANGE_LABEL: Record<ScanResult['kind'], Record<string, string>> = {
  profile: {
    slug: 'Profile URL', firstName: 'First name', lastName: 'Last name', headline: 'Headline', summary: 'About',
    geoName: 'Location', countryCode: 'Country', industry: 'Industry', photo: 'Photo', background: 'Banner',
    positions: 'Experience', educations: 'Education', about: 'Account history', connections: 'Connections',
    premium: 'Premium', creator: 'Creator mode', influencer: 'Top Voice',
  },
  company: {
    slug: 'Page URL', name: 'Name', tagline: 'Tagline', website: 'Website', industry: 'Industry', headquarters: 'Headquarters',
    type: 'Type', foundedYear: 'Founded', claimedSize: 'Company size', logo: 'Logo',
  },
  job: { title: 'Title', company: 'Company', location: 'Location', salary: 'Pay', apply: 'How to apply', description: 'Description' },
};

function renderChanges(kind: ScanResult['kind'], changes: FactChange[], since: number | null) {
  const items = changes.map((c) => CHANGE_LABEL[kind][c.field] ?? c.field);
  return `<section class="changes"><strong>Changed since you last checked${since ? ` (${ago(since)})` : ''}:</strong> ${esc(items.join(', '))}</section>`;
}


function verifiedText(f: ProfileFacts): { value: string; note: string } {
  if (!f.about) return { value: '—', note: '' };
  const v = f.about.verifications;
  if (!v.length) return { value: 'None', note: '' };
  if (v.some((x) => /^identity/i.test(x))) return { value: 'Identity', note: v.length > 1 ? `+${v.length - 1} more` : '' };
  const work = v.find((x) => /work email/i.test(x));
  return work ? { value: 'Work email', note: work.split(':')[0]! } : { value: v[0]!.split(':')[0]!, note: '' };
}
