// HTML for a scan result, in layout A: identity, the assessment, the balance
// of evidence, facts, the two lists, what wasn't checked, the kept pieces and
// the footer. Pure functions of the scan; all text is escaped. Canvases are
// drawn afterwards by dither.ts.

import { removalMarkup } from './removal';
import { reportMarkup } from './report-form';
import { siteDomain, verifiedEmployers, type CompanyFacts, type FactChange, type ProfileFacts, type ProfilePart } from '@fpr/core/linkedin';
import { levelFor, type RiskLevel, type Score, type Signal } from '@fpr/core/scam';
import type { CompanyScan, JobScan, ProfileScan, ScanResult } from '@/lib/scan/messages';
import { ago, ageText, compact, esc, monthDay, monthYear } from './format';

const CHECK = `<svg viewBox="0 0 16 16" aria-label="Work email verified"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// --- rendering -------------------------------------------------------------------
export function renderResult(r: ScanResult): string {
  const body = r.kind === 'company' ? renderCompany(r) : r.kind === 'job' ? renderJob(r) : renderProfile(r);
  return `${body}
  ${footer(r)}
  ${r.kind === 'profile' && r.facts.memberId ? removalMarkup() : ''}
  ${actions(r)}`;
}

const NOUN = { profile: 'profile', company: 'company page', job: 'job posting' } as const;

const TITLE: Record<RiskLevel, string> = { high: 'High suspicion', medium: 'Some concerns', low: 'Low suspicion' };
const TAG: Record<RiskLevel, string> = { high: 'HI', medium: 'MED', low: 'LO' };
export const LEVEL: Record<RiskLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// --- signals ---------------------------------------------------------------------
type Strength = 'major' | 'minor' | 'none';

/** Stored scores before rules v6 have no strength: |weight| ≥ 12 reads as major. A zero weight earns nothing. */
function strengthOf(x: Signal): Strength {
  if (x.strength) return x.strength;
  if (x.weight === 0) return 'none';
  return Math.abs(x.weight) >= 12 ? 'major' : 'minor';
}

const GAUGE: Record<Strength, number> = { major: 3, minor: 1, none: 0 };
const byStrength = (a: Signal, b: Signal) => GAUGE[strengthOf(b)] - GAUGE[strengthOf(a)] || Math.abs(b.weight) - Math.abs(a.weight);

function sides(s: Score) {
  return {
    against: s.signals.filter((x) => x.kind !== 'trust').sort(byStrength),
    favor: s.signals.filter((x) => x.kind === 'trust').sort(byStrength),
  };
}

/** The signal whose floor lifted the level above what the number alone gives, if any. */
function raisedBy(s: Score): Signal | null {
  if (RANK[s.level] <= RANK[levelFor(s.score)]) return null;
  return s.signals.find((x) => x.floor === s.level) ?? null;
}

/** Names for patterns, in suspicion wording, used where the lead and the score detail mention them. */
const PATTERN: Record<string, { lead: string; name: string }> = {
  'pattern.aged-resale': { lead: 'Several details look like an old account re-dressed for a new persona.', name: 'changed-hands pattern' },
  'pattern.career-vs-age': { lead: 'The career it claims is longer than the account has existed.', name: 'career-vs-account-age pattern' },
  'pattern.recruiter-new': { lead: 'A recruiter persona on a new account, a shape often seen in job scams.', name: 'new-recruiter pattern' },
  'pattern.senior-no-network': { lead: 'A senior title with almost no network.', name: 'senior-title-no-network pattern' },
};

const sentence = (label: string) => (/[.!?]$/.test(label) ? label : `${label}.`);

/** One or two sentences from the strongest red flags; a floor's pattern comes first. */
function lead(s: Score, kind: ScanResult['kind']) {
  const raised = raisedBy(s);
  const top = [raised, ...sides(s).against.filter((x) => x !== raised && strengthOf(x) !== 'none')].filter(Boolean).slice(0, 2) as Signal[];
  const parts = top.map((x) => PATTERN[x.id]?.lead ?? sentence(x.label));
  if (!parts.length) parts.push('Nothing major stands out.');
  // A genuine profile can still be used by someone else (impersonation).
  if (kind === 'profile' && s.level === 'low') parts.push("This can't confirm that the person contacting you owns this profile.");
  return parts.join(' ');
}

// --- blocks ----------------------------------------------------------------------
function identity(seed: string, photoUrl: string | null, title: string, headline: string | null, meta: string[]) {
  return `<article class="hero">
    ${face(photoUrl, seed)}
    <div class="who">
      <h1 class="name">${esc(title)}</h1>
      ${headline ? `<p class="headline">${esc(headline)}</p>` : ''}
      ${meta.length ? `<p class="meta">${meta.join('')}</p>` : ''}
    </div>
  </article>`;
}

/** The real photo when there is one, over a pixel avatar that shows if it's missing or fails to load. */
function face(photoUrl: string | null, seed: string) {
  const url = photoUrl && /^https:\/\//.test(photoUrl) ? photoUrl : null;
  return `<div class="avatar" aria-hidden="true"><canvas class="pxav" data-seed="${esc(seed)}"></canvas>${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : ''}</div>`;
}

function assessment(s: Score, kind: ScanResult['kind']) {
  return `<section class="lvl level-${s.level}">
    <canvas class="wash" data-level="${s.level}" aria-hidden="true"></canvas>
    <span class="tag" aria-hidden="true">${TAG[s.level]}</span>
    <h2>${TITLE[s.level]}</h2>
    <p>${esc(lead(s, kind))}</p>
  </section>`;
}

function strengthCount(list: Signal[], sep: string) {
  const n = (k: Strength) => list.filter((x) => strengthOf(x) === k).length;
  return [n('major') && `${n('major')} major`, n('minor') && `${n('minor')} minor`].filter(Boolean).join(sep);
}

/** Two dithered gauges: major signs weigh 3, minor 1, on a shared scale of at least 10. */
function balance(s: Score) {
  const { against, favor } = sides(s);
  const weight = (l: Signal[]) => l.reduce((n, x) => n + GAUGE[strengthOf(x)], 0);
  const max = Math.max(10, weight(against), weight(favor));
  const row = (cls: string, tone: string, label: string, list: Signal[]) => {
    const frac = Math.round((weight(list) / max) * 1000) / 1000;
    return `<div class="bal-row ${cls}">
      <div class="top-l" aria-hidden="true"><span>${esc(label)}</span><b>${strengthCount(list, ' · ') || '0'}</b></div>
      <canvas class="dz" data-frac="${frac}" data-c="${tone}" role="img" aria-label="${esc(`${label}: ${strengthCount(list, ', ') || 'none'}`)}"></canvas>
    </div>`;
  };
  return `<div class="bal">${row('fl', 'flag', 'Red flags', against)}${row('fv', 'ok', "Signs it's genuine", favor)}</div>`;
}

function signalItem(x: Signal, mark: string) {
  const st = strengthOf(x);
  return `<li class="${st}"><span class="mk" aria-hidden="true">${st === 'none' ? '·' : mark}</span><span class="t">${esc(x.label)}${x.detail ? `<span class="why">${esc(x.detail)}</span>` : ''}</span><span class="str">${st === 'none' ? '' : st}</span></li>`;
}

function heading(title: string, count?: number | string) {
  return `<h3>${esc(title)}<span class="rule" aria-hidden="true"></span><small>${count ?? ''}</small></h3>`;
}

function lists(s: Score) {
  const { against, favor } = sides(s);
  const list = (cls: string, title: string, mark: string, items: Signal[]) =>
    `<section class="col ${cls}">${heading(title, items.length)}${
      items.length ? `<ul>${items.map((x) => signalItem(x, mark)).join('')}</ul>` : '<p class="none">Nothing found on this side</p>'
    }</section>`;
  return `${list('against', 'Red flags', '✕', against)}${list('for', "Signs it's genuine", '✓', favor)}`;
}

function notChecked(s: Score) {
  if (!s.missing.length) return '';
  return `<p class="nc"><span class="mk" aria-hidden="true">–</span>Not checked: ${esc(s.missing.join('; '))}. Missing evidence adds no suspicion.</p>`;
}

function footer(r: ScanResult) {
  const s = r.score;
  const raised = raisedBy(s);
  const why = raised
    ? ` The ${esc(PATTERN[raised.id]?.name ?? `“${raised.label}” pattern`)} raised the level to ${LEVEL[s.level]}; the number alone gives ${LEVEL[levelFor(s.score)]}.`
    : '';
  return `<p class="foot">
    <span>Checked ${r.cached ? `${ago(r.capturedAt)} (cached)` : 'just now'} · a suspicion score, not a verdict</span>
    <button type="button" class="lnk" id="scoreBtn" aria-expanded="false" aria-controls="scoreDetail">Show the score</button>
    <span id="scoreDetail" hidden>${s.score}/100, rules v${s.version}.${why}</span>
  </p>`;
}

const PART_LABEL: Record<ProfilePart, string> = {
  profile: 'experience, education and photo',
  about: 'join date and verifications',
  connections: 'connections',
  followers: 'followers',
  activity: 'recent activity',
};

/** What this read couldn't load, and errors from parts that failed. */
function readNotes(r: ScanResult) {
  const notes: string[] = [];
  if (r.kind === 'profile' && r.carried?.length) { // older cached scans have none
    const when = r.previousCheckAt ? ` (${ago(r.previousCheckAt)})` : '';
    notes.push(`Couldn't read ${r.carried.map((p) => PART_LABEL[p]).join(', ')} this time; shown from your earlier check${when}.`);
  }
  // Errors for parts already shown from an earlier check would only repeat that note.
  const carriedFrom: Record<string, ProfilePart> = { fullProfile: 'profile', about: 'about', followingState: 'followers', activity: 'activity', profilePageCounts: 'connections' };
  const shown = new Set(r.kind === 'profile' ? (r.carried ?? []) : []);
  const errors = Object.entries(r.errors ?? {}).filter(([k]) => !shown.has(carriedFrom[k]!));
  if (errors.length) notes.push(`Failed to load: ${errors.map(([k, v]) => `${k} (${v})`).join('; ')}`);
  return notes.length ? `<section class="sec notes">${heading('About this read')}<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : '';
}

function actions(r: ScanResult) {
  const save = `Save this ${NOUN[r.kind]} without saying anything about it`;
  const know = { profile: ['Know this person?', "Vouch that they're real"], company: ['Know this company?', "Vouch that it's real"], job: ['Know this job?', "Vouch that it's real"] }[r.kind];
  return `<div class="actions">
    ${reportMarkup(r.kind)}
    <p class="status" id="submitStatus" role="status"></p>
    <div id="actionIdle">
      <div class="btn-row">
        <button class="btn secondary" id="trackBtn" title="${save}">Save</button>
        <button class="btn danger" id="reportBtn">Report…</button>
      </div>
      <p class="alt">${know[0]} <button type="button" class="lnk" id="vouchBtn">${know[1]}</button></p>
    </div>
  </div>`;
}

/** Everything from the assessment to the kept pieces, shared by the three kinds. */
function body(r: ScanResult, factsHtml: string, kept: string) {
  return `${assessment(r.score, r.kind)}
  ${balance(r.score)}
  ${factsHtml}
  ${lists(r.score)}
  ${notChecked(r.score)}
  ${readNotes(r)}
  ${r.changes.length ? renderChanges(r.kind, r.changes, r.previousCheckAt) : ''}
  ${kept}`;
}

const metaSpan = (text: string) => `<span>${esc(text)}</span>`;

function renderProfile(r: ProfileScan): string {
  const f = r.facts;
  const name = [f.firstName, f.lastName].filter(Boolean).join(' ') || r.slug;
  const meta = [
    ...(f.geoName ? [metaSpan(f.geoName)] : []),
    `<span title="LinkedIn member ID. Stays the same when the profile URL changes.">#${f.memberId}</span>`,
  ];
  const facts = `<dl class="facts">
    ${fact('Joined', f.joined ? monthYear(f.joined.at) : '—', f.joined ? `${ageText(f.joined.at)}${f.joined.source === 'memberId' ? ' · est.' : ''}` : '')}
    ${fact('Connections', f.connections ? `${f.connections.count.toLocaleString()}${f.connections.capped ? '+' : ''}` : 'Hidden')}
    ${fact('Followers', f.followers != null ? compact(f.followers) : '—')}
    ${fact('Last post', f.activity ? (f.activity.newestAt ? ago(f.activity.newestAt) : 'Never') : '—', f.activity?.postCount ? `${f.activity.postCount} recent` : '')}
    ${fact('Verified', verifiedText(f).value, verifiedText(f).note)}
    ${fact('Photo', ...photoText(f))}
  </dl>`;
  return `${identity(name, f.photoUrl, name, f.headline, meta)}
  ${body(r, facts, renderTimeline(f, r.score.signals.some((x) => x.id === 'pattern.career-vs-age')))}`;
}

/** A photo LinkedIn hides from this viewer arrives as null; without the profile record it wasn't checked. */
function photoText(f: ProfileFacts): [string, string] {
  if (!f.profileLoaded) return ['—', ''];
  if (f.photo === null) return ['Hidden', 'from you'];
  if (!f.photo.present) return ['None', ''];
  return f.photo.uploadedAt ? [monthYear(f.photo.uploadedAt), 'uploaded'] : ['Yes', ''];
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
  const meta = [
    ...[c.industry, c.headquarters].filter((x): x is string => !!x).map(metaSpan),
    ...(c.companyId ? [`<span title="LinkedIn company ID. Stays the same when the page is renamed.">#${c.companyId}</span>`] : []),
  ];
  return `${identity(name, c.logoUrl, name, c.tagline, meta)}
  ${body(r, companyFacts(c), '')}`;
}

function renderJob(r: JobScan): string {
  const j = r.facts;
  const c = r.company;
  const x = j.extras;
  const pay = j.salary ? j.salary.text.replace(/\.00/g, '') : 'Not listed';
  const meta = [
    ...(j.postedText ? [metaSpan(j.reposted ? j.postedText : `Posted ${j.postedText}`)] : []),
    ...(j.applicants ? [metaSpan(`${j.applicants.over ? 'Over ' : ''}${j.applicants.count.toLocaleString()} applicants`)] : []),
  ];
  const facts = `<dl class="facts">
    ${fact('Pay', pay)}
    ${fact('Type', j.employmentType ?? '—', [j.extras?.remote ? 'Remote' : null, j.seniority && j.seniority !== 'Not Applicable' ? j.seniority : null].filter(Boolean).join(' · '))}
    ${fact('Apply', j.apply === 'easy' ? 'Easy Apply' : (siteDomain(x?.applyUrl) ?? (j.apply === 'offsite' ? 'Company site' : '—')), j.apply === 'offsite' && x?.applyUrl ? 'external site' : '')}
    ${x?.listedAt ? fact('Listed', monthDay(x.listedAt), x.originalListedAt && x.listedAt - x.originalListedAt > 86_400_000 ? `first ${monthDay(x.originalListedAt)}` : '') : ''}
    ${x ? fact('Verified job', x.verified ? 'Yes' : x.verified === false ? 'No' : '—') : ''}
    ${x?.expireAt ? fact('Closes', monthDay(x.expireAt), x.state && x.state !== 'LISTED' ? x.state.toLowerCase() : '') : ''}
  </dl>`;
  const team = x?.hiringTeam.length
    ? `<section class="sec team">${heading('Hiring team', x.hiringTeam.length)}<ul>${x.hiringTeam
        .map((p) => `<li><a class="link" href="https://www.linkedin.com/in/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener">${esc(p.name ?? p.slug)}</a><span>check profile</span></li>`)
        .join('')}</ul></section>`
    : '';
  const flags = c ? sides(c.score).against.slice(0, 4) : [];
  const companyBlock = c
    ? `<section class="sec company-sub">${heading('Company page')}
      <div class="sub-lvl level-${c.score.level}"><span class="tag" aria-hidden="true">${TAG[c.score.level]}</span><b>${esc(c.facts.name ?? j.company.name ?? 'This company')}</b><span>${TITLE[c.score.level]}</span></div>
      ${companyFacts(c.facts)}
      ${flags.length ? `<div class="col against"><ul>${flags.map((s) => signalItem(s, '✕')).join('')}</ul></div>` : ''}
    </section>`
    : '';
  return `${identity(j.company.name ?? j.title ?? '?', c?.facts.logoUrl ?? null, j.title ?? 'Job posting', [j.company.name, j.location].filter(Boolean).join(' · ') || null, meta)}
  ${body(r, facts, team + companyBlock)}`;
}

/** A small avatar with initials, for list rows (Saved, Reports). */
export function avatar(photoUrl: string | null, name: string, cls = '') {
  const initials = esc(name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase());
  const url = photoUrl && /^https:\/\//.test(photoUrl) ? photoUrl : null;
  return `<div class="avatar${cls ? ` ${cls}` : ''}">${url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : ''}<span>${initials}</span></div>`;
}

function fact(label: string, value: string, note = '') {
  return `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
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
  return `<section class="sec timeline">${heading('Career vs. account age')}
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
