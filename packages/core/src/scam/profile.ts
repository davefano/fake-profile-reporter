// Suspicion score for a LinkedIn profile from its facts. A heuristic, not a
// verdict: each signal is explained so a person can judge.
// Positive weights raise suspicion; negative weights are trust signals.

import { verifiedEmployers, type ProfileFacts } from '../linkedin/profile/facts';
import { finishScore, signalAdder, type Score, type Signal } from './signals';
import { BUZZ, CRYPTO, GURU, countMatches } from './wordlists';

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
// Job scams mostly run through recruiter and HR personas.
const RECRUITER = /\b(recruit\w*|talent acquisition|talent partner|hr|human resources|hiring|staffing|headhunter|people (?:ops|operations|partner))\b/i;
// Roles that belong to tech, and the industries such people actually pick.
const TECH_ROLE = /\b(software|developer|programmer|full[- ]?stack|front[- ]?end|back[- ]?end|devops|site reliability|data scientist|machine learning|ml engineer|ai engineer|cloud engineer)\b/i;
const TECH_INDUSTRY = /software|it services|information|internet|computer|technolog|tech\b|telecom|wireless|data|cyber|network|semiconductor|electronic|automation|robotics|financial|bank|insurance|investment|venture capital|health|hospital|medical|pharma|biotech|research|education|e-learning|university|consult|engineering|defense|aerospace|government|retail|e-commerce|media|entertainment|gam(?:e|ing)|automotive|staffing|marketing|advertising|energy|utilities|logistics|transportation/i;
// LinkedIn's generated URL suffix ("jane-doe-09722924", "jane-doe-a1b2c3d4"): never customized.
const DEFAULT_SLUG = /-(?=[0-9a-f]*\d)[0-9a-f]{6,10}$/i;
const SENIOR = /\b(ceo|cto|cfo|coo|founder|co-founder|director|vp|vice president|head of|chief|partner|president|senior|principal|lead|manager)\b/i;

/** "Microsoft: Verified using work email in June 2024" → "Work email verified at Microsoft (June 2024)". */
function verificationLabel(v: string) {
  const m = /^(.+?): Verified using work email in (.+)$/i.exec(v);
  return m ? `Work email verified at ${m[1]} (${m[2]})` : `Verified: ${v}`;
}

function fmtAge(ms: number) {
  const days = Math.floor(ms / DAY);
  if (days < 60) return `${days} days`;
  if (days < 730) return `${Math.floor(days / 30)} months`;
  return `${(ms / YEAR).toFixed(1)} years`;
}

export function scoreProfile(f: ProfileFacts, now = Date.now()): Score {
  const signals: Signal[] = [];
  const missing: string[] = [];
  const add = signalAdder(signals);

  // Account age. LinkedIn's own "Joined" date is authoritative; the member-ID
  // estimate is rough, so it counts for half.
  // Month-precision join dates sit mid-month, so a brand-new account can read as
  // slightly in the future: floor at zero.
  const ageMs = f.joined ? Math.max(0, now - f.joined.at) : null;
  if (f.joined && ageMs != null) {
    const est = f.joined.source === 'memberId';
    const k = est ? 0.5 : 1;
    const age = fmtAge(ageMs);
    const how = est ? ', estimated from member ID' : '';
    if (ageMs < 30 * DAY) add('age.new', `Account created very recently (${age}${how})`, 35 * k);
    else if (ageMs < 180 * DAY) add('age.recent', `Account is under 6 months old (${age}${how})`, 22 * k);
    else if (ageMs < YEAR) add('age.young', `Account is under a year old (${age}${how})`, 12 * k);
    // Modest credit: aged accounts are bought and sold for scams.
    // Credit is added after the resale checks below: age is what gets sold.
  } else {
    missing.push('Account age');
  }

  // Verification is the strongest trust signal LinkedIn exposes. Work-email
  // verification is added after the resale checks: an old one can belong to a
  // previous owner of the account.
  const verifications = f.about?.verifications ?? [];
  if (f.about) {
    if (verifications.some((s) => /^identity/i.test(s))) add('verified.identity', 'Identity verified by LinkedIn', -30);
    else if (!verifications.length) add('verified.none', 'No LinkedIn verifications', 6);
  } else {
    missing.push('Join date and verifications (About this member)');
  }

  // Network size.
  const conns = f.connections;
  if (conns) {
    if (conns.capped) add('connections.many', `${conns.count}+ connections`, -8);
    else if (conns.count <= 10) add('connections.tiny', `Only ${conns.count} connections`, 22);
    else if (conns.count < 50) add('connections.few', `Few connections (${conns.count})`, 12);
    else if (conns.count < 150) add('connections.low', `Low connection count (${conns.count})`, 4);
  } else {
    missing.push('Connection count (hidden or unavailable)');
  }

  // A senior title with almost no network is a classic fake-recruiter pattern.
  const title = [f.headline, f.positions[0]?.title].filter(Boolean).join(' ');
  if (SENIOR.test(title) && conns && !conns.capped && conns.count < 50) {
    add('pattern.senior-no-network', 'Senior title but almost no network', 12);
  }

  // Claimed career vs. the account and network it comes with.
  const starts = f.positions.map((p) => p.start?.year).filter((y): y is number => !!y);
  const careerYears = starts.length ? new Date(now).getUTCFullYear() - Math.min(...starts) : 0;
  if (careerYears >= 10 && ageMs != null && ageMs < YEAR) {
    add('pattern.career-vs-age', `Claims ${careerYears} years of work history on an account under a year old`, 18);
  } else if (careerYears >= 8 && ageMs != null && ageMs < 2 * YEAR) {
    add('pattern.career-vs-age', `Claims ${careerYears} years of work history on a new account`, 10);
  }

  // Recruiter/HR persona. Most job scams use one, so an unproven one matters
  // more. Only when verifications were actually read: unknown is not "none".
  if (RECRUITER.test(title) && f.about && !f.about.verifications.length) {
    if (ageMs != null && ageMs < YEAR) add('pattern.recruiter-new', 'Recruiter/HR persona on an account under a year old', 15);
    else add('pattern.recruiter-unverified', 'Recruiter/HR persona with no verification', 6);
  }

  // Claims a current job at a real company page but has no work-email
  // verification for it. Many genuine employees never verify, so this only
  // counts on newer accounts.
  const current = f.positions.find((p) => !p.end && p.companyId && p.company);
  if (current && f.about && ageMs != null && ageMs < 2 * YEAR) {
    const name = current.company!.toLowerCase();
    if (!verifiedEmployers(f.about).includes(name)) {
      add('pattern.employer-unverified', `Claims to work at ${current.company} without workplace verification`, 8);
    }
  }

  // An audience with nothing to show for it suggests bought or farmed followers.
  if (f.followers != null && f.followers >= 300 && f.activity?.postCount === 0 && ageMs != null && ageMs < YEAR) {
    add('pattern.followers-no-activity', `${f.followers.toLocaleString('en-US')} followers on a new account that has never posted`, 8);
  }
  if (careerYears >= 5 && conns && !conns.capped && conns.count < 50) {
    add('pattern.career-no-network', `${careerYears}-year career but only ${conns.count} connections`, 10);
  }

  // Activity.
  if (f.activity) {
    if (f.activity.postCount === 0) add('activity.none', 'No public activity', 8);
    else if (f.activity.newestAt && now - f.activity.newestAt > YEAR) {
      add('activity.stale', `No activity since ${new Date(f.activity.newestAt).toISOString().slice(0, 10)}`, 4);
    }
  }

  if (!f.activity) missing.push('Recent activity');

  // Bought or dormant accounts. Age is the thing being sold, so an old account
  // gets checked for signs that nobody has really lived in it, or that it was
  // recently taken over and re-dressed for a new persona.
  const resale: string[] = [];
  if (f.profileLoaded && ageMs != null && ageMs > 3 * YEAR) {
    // Only when activity was actually checked: unknown is not the same as none.
    const quiet = f.activity?.postCount === 0;
    if (quiet && f.photo && !f.photo.present) {
      add('aged.shell', 'Old account with no photo that has never posted (common in bought accounts, and easy to impersonate)', 6);
      resale.push('no photo, never posted');
    }
    const recent = (ms: number | null | undefined) => ms != null && now - ms < 180 * DAY;
    const recentText = (t: string | null | undefined) => !!t && /less than (?:\d+ (?:days?|weeks?)|[1-6] months?)/i.test(t);
    const refreshed = [
      recent(f.photo?.uploadedAt) || recentText(f.about?.photoUpdated) ? 'photo' : null,
      recent(f.background?.uploadedAt) ? 'banner' : null,
      recentText(f.about?.contactInfoUpdated) ? 'contact info' : null,
    ].filter(Boolean);
    if (refreshed.length && quiet) {
      add('aged.refreshed', `Old, inactive account with recently changed ${refreshed.join(' and ')} (possible resale or takeover)`, 6);
      resale.push(`${refreshed.join(' and ')} changed recently`);
    }
    // The industry is set early and rarely revisited, so it can outlive a persona.
    const role = [f.headline, f.positions[0]?.title].filter(Boolean).join(' ');
    if (f.industry && TECH_ROLE.test(role) && !TECH_INDUSTRY.test(f.industry)) {
      add('aged.industry-mismatch', `Industry "${f.industry}" doesn't fit a tech role (can be left over from an earlier persona)`, 5);
      resale.push('industry left over');
    }
    // Plenty of real people never customize it, so only on accounts nobody uses.
    if (quiet && f.slug && DEFAULT_SLUG.test(f.slug) && ageMs > 5 * YEAR) {
      add('aged.default-url', 'Never customized its profile URL in all these years', 3);
      resale.push('default URL');
    }
  }
  const initialOnly = (n: string | null) => (n ?? '').replace(/\./g, '').trim().length <= 1;
  if (f.profileLoaded && initialOnly(f.lastName) && resale.length) resale.push('surname reduced to an initial');
  // One sign means little; several together describe an account that changed hands.
  const resold = resale.length >= 3;
  // 3 signs: 12; each more: +6. From 4 up it also keeps the level at least medium.
  if (resold) add('pattern.aged-resale', `Several signs this old account changed hands: ${resale.join('; ')}`, 12 + 6 * (resale.length - 3));

  // Trust that resale would carry over: deferred from above, and discounted when it looks resold.
  if (f.joined && ageMs != null && ageMs > 5 * YEAR) {
    const k = f.joined.source === 'memberId' ? 0.5 : 1;
    const label = `Account is ${fmtAge(ageMs)} old${f.joined.source === 'memberId' ? ' (estimated from member ID)' : ''}`;
    if (resold) add('age.established', `${label}, but age is what a resold account is bought for`, 0, 'trust');
    else add('age.established', label, -8 * k);
  }
  const workEmail = verifications.filter((v) => !/^identity/i.test(v));
  if (workEmail.length && !verifications.some((v) => /^identity/i.test(v))) {
    const label = workEmail.map(verificationLabel).join('; ');
    if (resold) add('verified.other', `${label} (may predate a change of owner)`, -6);
    else add('verified.other', label, -12);
  }

  // Profile completeness. If the record didn't load, these are unknown, not empty.
  if (!f.profileLoaded) {
    missing.push('Profile record (experience, education, skills, photo)');
  } else {
    if (f.photo && !f.photo.present) add('photo.none', 'No profile photo', 8);
    if (f.positions.length === 0) add('profile.no-experience', 'No experience listed', 10);
    else if (f.positions.length === 1) add('profile.one-position', 'Only one position listed', 3);
    if (f.educations.length === 0) add('profile.no-education', 'No education listed', 4);
    if (!f.summary?.trim()) add('profile.no-about', 'Empty About section', 4);
    if (f.skills.length === 0) add('profile.no-skills', 'No skills listed', 3);
    if (initialOnly(f.firstName) || initialOnly(f.lastName)) {
      add('profile.short-name', 'First or last name is just an initial, or missing', 5);
    }
  }

  // Language. Weak on its own; real people use buzzwords too.
  const text = [f.headline, f.summary].filter(Boolean).join('\n');
  for (const [id, label, list, per, cap] of [
    ['text.crypto', 'Crypto/web3 terms', CRYPTO, 4, 12],
    ['text.guru', 'Guru/self-promo language', GURU, 3, 9],
    ['text.buzz', 'Generic buzzphrases', BUZZ, 2, 6],
  ] as const) {
    const m = countMatches(text, [...list]);
    if (m.n) add(id, `${label} (${m.hits.join(', ')})`, Math.min(cap, m.n * per));
  }

  // Connections you share. Relative to the viewer: real to *you*, not proof in general.
  if (f.mutualConnections) add('trust.mutual', `${f.mutualConnections} mutual connection${f.mutualConnections === 1 ? '' : 's'} with you (relative to you; not in the shared score)`, -Math.min(10, 3 + f.mutualConnections));

  // Other trust signals.
  if (f.premium) add('trust.premium', 'Premium subscriber', -4);
  if (f.influencer) add('trust.influencer', 'LinkedIn Top Voice / influencer', -10);
  if (f.followers != null && f.followers > 10_000) add('trust.followers', `${f.followers.toLocaleString('en-US')} followers`, -6);

  return finishScore(signals, missing);
}

