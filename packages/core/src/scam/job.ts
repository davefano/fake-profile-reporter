// Suspicion score for a job posting. Job scams show their hand in the text
// (chat apps, personal inboxes, equipment checks) and in the company behind
// the posting, which is scored separately and folded in.

import type { CompanyFacts } from '../linkedin/company/facts';
import type { JobFacts } from '../linkedin/job/facts';
import { sameSite, siteDomain } from '../linkedin/url';
import { FREE_HOSTS } from './company';
import { finishScore, signalAdder, type Score, type Signal } from './signals';

// --- red flags in the posting text ---------------------------------------------

const PERSONAL_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|aol|icloud|me|proton(mail)?|gmx|mail|yandex|zoho)\.[a-z.]+$/i;

interface TextFlag {
  id: string;
  label: string;
  weight: number;
  kind: Signal['kind'];
  re: RegExp;
}

const TEXT_FLAGS: TextFlag[] = [
  {
    id: 'job.chat-app',
    label: 'Moves the conversation to a chat app',
    weight: 20,
    kind: 'discrepancy',
    re: /\b(telegram|whats\s?app|signal app|wechat|wickr|google hangouts?|text (?:me|us) (?:at|on)|kik messenger)\b/i,
  },
  {
    id: 'job.pay-to-work',
    label: 'Mentions buying equipment, checks, or fees you pay',
    weight: 25,
    kind: 'discrepancy',
    re: /\b((?:purchase|buy)(?:\s+your)?\s+(?:own\s+)?(?:equipment|laptop|software|supplies)|(?:send|mail) you a check|deposit (?:the|a) check|(?:training|registration|application|onboarding) fee|starter kit|reimburse(?:d|ment)? (?:you )?for (?:the )?equipment|gift cards?)\b/i,
  },
  {
    id: 'job.reshipping',
    label: 'Describes receiving or reshipping packages from home',
    weight: 20,
    kind: 'discrepancy',
    re: /\b(reship\w*|receive (?:and )?(?:inspect |forward )?(?:packages|parcels)|package (?:handler|inspector|forwarding)|parcel forwarding)\b/i,
  },
  {
    id: 'job.money-transfer',
    label: 'Involves moving money for the employer',
    weight: 20,
    kind: 'discrepancy',
    re: /\b(process(?:ing)? payments? (?:for|on behalf)|transfer funds|money (?:transfer|mule)|payment (?:processing )?agent|financial (?:transfer )?agent|bitcoin atm)\b/i,
  },
  { id: 'job.no-experience', label: 'No experience required', weight: 6, kind: 'weak', re: /\bno (?:prior |previous )?experience (?:is )?(?:required|needed|necessary)\b/i },
  { id: 'job.urgent', label: 'Urgent or immediate hiring language', weight: 4, kind: 'weak', re: /\b(urgent(?:ly)? (?:hiring|needed)|hiring immediately|immediate (?:start|hire)|start (?:today|tomorrow))\b/i },
  { id: 'job.easy-money', label: 'Easy-money language', weight: 6, kind: 'weak', re: /\b(earn up to|unlimited (?:income|earning)|work (?:only )?\d+ hours? (?:a|per) (?:week|day)|(?:\$\d+|\d+ dollars) (?:per|a) (?:day|week) guaranteed|weekly pay(?:ment)?s? guaranteed)\b/i },
  { id: 'job.crypto', label: 'Crypto or trading terms', weight: 6, kind: 'weak', re: /\b(crypto(?:currency)?|bitcoin|usdt|forex|trading signals?|binance)\b/i },
  { id: 'job.chat-interview', label: 'Interview by text or chat', weight: 12, kind: 'discrepancy', re: /\b((?:text|chat|instant message)[- ]based interview|interview (?:will be )?(?:conducted )?(?:via|over|on) (?:text|chat|telegram|whatsapp|teams chat|skype chat))\b/i },
];

const ENTRY_LEVEL = /entry|intern|associate|not applicable/i;

// Applicant tracking systems: an apply link on one of these is normal for any employer.
const ATS = /(^|\.)(greenhouse\.io|lever\.co|myworkdayjobs\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|ashbyhq\.com|bamboohr\.com|workable\.com|breezy\.hr|taleo\.net|successfactors\.(com|eu)|adp\.com|paylocity\.com|ultipro\.com|ukg\.net|applytojob\.com|recruitee\.com|teamtailor\.com|personio\.(de|com)|rippling\.com|dayforcehcm\.com|oraclecloud\.com|jazzhr\.com|pinpointhq\.com|gem\.com|dover\.com|wellfound\.com|indeed\.com|ziprecruiter\.com|hirebridge\.com|paycomonline\.net|paycor\.com|applicantpro\.com|isolvedhire\.com|careerplug\.com|recruiting\.com)$/i;
// Links that hide or replace a real application system.
const FORM_OR_SHORTENER = /(^|\.)(bit\.ly|tinyurl\.com|t\.co|rb\.gy|cutt\.ly|forms\.gle|docs\.google\.com|typeform\.com|jotform\.com|surveymonkey\.com|tally\.so|t\.me|wa\.me|telegram\.me)$/i;

const DAY = 86_400_000;

export function scoreJob(job: JobFacts, company: CompanyFacts | null, companyScore: Score | null): Score {
  const signals: Signal[] = [];
  const missing: string[] = [];
  const add = signalAdder(signals);
  const text = `${job.title ?? ''}\n${job.description}`;

  for (const f of TEXT_FLAGS) {
    const m = f.re.exec(text);
    if (m) add(f.id, `${f.label} (“${m[0].trim()}”)`, f.weight, f.kind);
  }

  // Contact details.
  const personal = job.contacts.emails.filter((e) => PERSONAL_MAIL.test(e));
  if (personal.length) add('job.personal-email', `Asks you to contact a personal email address (${personal[0]})`, 15, 'discrepancy');
  const companyDomain = siteDomain(company?.website);
  const otherDomain = job.contacts.emails
    .filter((e) => !PERSONAL_MAIL.test(e))
    .map((e) => e.split('@')[1]!)
    .find((d) => companyDomain && !sameSite(d, companyDomain));
  if (otherDomain) add('job.email-domain', `Email domain ${otherDomain} doesn't match the company website (${companyDomain})`, 12, 'discrepancy');
  if (job.contacts.phones.length) add('job.phone', 'Lists a phone number to contact directly', 4);

  // Pay.
  const s = job.salary;
  if (s?.min && s.max && s.max / s.min >= 3) add('job.salary-range', `Very wide pay range (${s.text})`, 4);
  if (s?.period === 'hour' && (s.max ?? 0) >= 45 && ENTRY_LEVEL.test(job.seniority ?? '') && /remote/i.test(`${job.location} ${job.description}`)) {
    add('job.too-good', `High hourly pay for a remote entry-level role (${s.text})`, 10, 'discrepancy');
  }

  // Thin postings.
  if (job.description.length < 400) add('job.short-description', 'Very short description', 8);
  if (!job.salary) missing.push('Pay range');
  if (!job.apply) missing.push('How to apply');

  // The company that posted it.
  if (!job.company.slug) {
    add('job.no-company-page', 'Not linked to a company page', 15, 'discrepancy');
  } else if (!company || !companyScore) {
    missing.push('Company page');
  } else if (companyScore.level !== 'low') {
    add('job.company-suspicious', `Posted by a company page with ${companyScore.level} suspicion (${companyScore.score}/100)`, Math.min(30, Math.round(companyScore.score * 0.4)), companyScore.level === 'high' ? 'discrepancy' : 'weak');
  } else if ((company.employeesOnLinkedIn ?? 0) >= 50) {
    add('job.company-established', `Posted by an established company page (${company.employeesOnLinkedIn!.toLocaleString('en-US')} people on LinkedIn)`, -10);
  }

  // Logged-in extras.
  const x = job.extras;
  if (!x) {
    missing.push('Apply link, posting history and verification (needs signed-in LinkedIn)');
  } else {
    if (x.verified) add('job.verified', 'LinkedIn marked this as a verified job', -12);
    const applyDomain = siteDomain(x.applyUrl);
    if (applyDomain) {
      if (FORM_OR_SHORTENER.test(applyDomain) || FREE_HOSTS.test(applyDomain)) {
        add('job.apply-form', `Apply link goes to a form, chat, or link shortener (${applyDomain})`, 20, 'discrepancy');
      } else if (companyDomain && !ATS.test(applyDomain) && !sameSite(applyDomain, companyDomain)) {
        add('job.apply-domain', `Apply link goes to ${applyDomain}, not the company's site (${companyDomain})`, 12, 'discrepancy');
      }
    }
    if (x.listedAt && x.originalListedAt && x.listedAt - x.originalListedAt > 60 * DAY) {
      add('job.reposted', `Reposted; first listed ${Math.round((x.listedAt - x.originalListedAt) / DAY)} days earlier`, 4);
    }
    if (x.hiringTeam.length) add('job.hiring-team', `Names a hiring team (${x.hiringTeam.map((p) => p.name ?? p.slug).join(', ')})`, -4);
  }

  // Company name in the posting text that isn't the posting company.
  if (company?.name && job.company.name && company.name.toLowerCase() !== job.company.name.toLowerCase()) {
    add('job.company-name-mismatch', `Posting names ${job.company.name} but links to ${company.name}`, 10, 'discrepancy');
  }

  return finishScore(signals, missing);
}
