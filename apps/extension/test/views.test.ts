import { describe, expect, test } from 'bun:test';
import type { CompanyFacts, JobFacts, ProfileFacts } from '@fpr/core/linkedin';
import { SCORE_VERSION, type Score, type Signal } from '@fpr/core/scam';
import type { CompanyScan, JobScan, ProfileScan } from '../lib/scan/messages';
import { renderResult } from '../lib/panel/views';

// Synthetic people and pages only.
const NOW = Date.now();
const YEAR = 365 * 86_400_000;

function facts(o: Partial<ProfileFacts> = {}): ProfileFacts {
  return {
    profileLoaded: true, photoUrl: null, memberId: 700_000_001, profileId: null, slug: 'jordan-sample-0a1b2c', versionTag: null,
    firstName: 'Jordan', lastName: 'Sample', headline: 'Platform engineer', summary: null, countryCode: 'us', geoName: 'Ohio, United States',
    industry: null, premium: false, creator: false, influencer: false, memorialized: false,
    photo: { present: true, uploadedAt: NOW - YEAR }, background: null, positions: [], educations: [], skills: [],
    followers: 120, connections: { count: 500, capped: true }, mutualConnections: null,
    joined: { at: NOW - 10 * YEAR, source: 'about' }, about: { contactInfoUpdated: null, photoUpdated: null, verifications: [] },
    activity: { postCount: 0, newestAt: null, oldestAt: null },
    ...o,
  };
}

const sig = (id: string, label: string, weight: number, extra: Partial<Signal> = {}): Signal => ({
  id, label, weight, kind: weight < 0 ? 'trust' : id.startsWith('pattern.') ? 'discrepancy' : 'weak', ...extra,
});

const score = (o: Partial<Score> = {}): Score => ({ version: SCORE_VERSION, score: 20, level: 'low', signals: [], missing: [], ...o });

function profile(o: Partial<ProfileScan> = {}): ProfileScan {
  return {
    kind: 'profile', slug: 'jordan-sample-0a1b2c', facts: facts(), capturedAt: NOW, errors: {}, carried: [],
    changes: [], previousCheckAt: null, cached: false, score: score(), ...o,
  };
}

const MIXED = score({
  score: 40,
  level: 'medium',
  signals: [
    sig('pattern.career-vs-age', 'Claims 12 years of work history on a new account', 10, { strength: 'minor' }),
    sig('pattern.recruiter-new', 'Recruiter/HR persona on an account under a year old', 15, { strength: 'major', detail: 'a common shape for job scams' }),
    sig('verified.other', 'Work email verified', -12, { strength: 'major' }),
    sig('connections.many', '500+ connections', -8),
  ],
  missing: ['Recent activity'],
});

// Four changed-hands signs: the number says Medium, the pattern floors it at High (AE1, AE3).
const FLOORED = score({
  score: 33,
  level: 'high',
  signals: [
    sig('pattern.aged-resale', 'Several signs this old account changed hands: banner; industry; default URL; initial', 18, { strength: 'major', floor: 'high' }),
    sig('aged.default-url', 'Never customized its profile URL in all these years', 3),
    sig('verified.other', 'Work email verified', -6, { strength: 'minor', detail: 'may predate a change of owner' }),
  ],
});

/** The markup between two markers, so a test can look inside one block. */
const section = (html: string, cls: string) => {
  const m = new RegExp(`<section class="col ${cls}"[\\s\\S]*?</section>`).exec(html);
  return m?.[0] ?? '';
};

describe('layout A', () => {
  test('renders red flags and genuine lists with major/minor tags and no signed weights', () => {
    const html = renderResult(profile({ score: MIXED }));
    const against = section(html, 'against');
    const favor = section(html, 'for');
    expect(against).toContain('Recruiter/HR persona on an account under a year old');
    expect(against).toContain('a common shape for job scams');
    expect(against).toMatch(/<li class="major">[\s\S]*Recruiter[\s\S]*>major</);
    expect(against).toMatch(/<li class="minor">[\s\S]*Claims 12 years[\s\S]*>minor</);
    expect(favor).toContain('Work email verified');
    expect(favor).not.toContain('Recruiter');
    expect(html).not.toMatch(/[+−-]\d+<\/span>/); // no +15 / −12 weights
    // Level by its word as well as colour; gauges carry a text label.
    expect(html).toContain('<h2>Some concerns</h2>');
    expect(html).toContain('aria-label="Red flags: 1 major, 1 minor"');
    expect(html).toContain('aria-label="Signs it&#39;s genuine: 1 major, 1 minor"');
  });

  test('blocks come in layout A order', () => {
    const html = renderResult(profile({ score: MIXED, changes: [{ field: 'headline' } as any] }));
    const at = (s: string) => html.indexOf(s);
    const order = ['class="hero"', 'class="lvl', 'class="bal"', 'class="facts"', 'class="col against"', 'class="col for"', 'class="nc"', 'class="changes"', 'class="foot"', 'class="actions"'];
    for (const s of order) expect(at(s)).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual(order.map(at).sort((a, b) => a - b));
  });

  test('a signal without strength (old stored score) uses the ≥ 12 fallback', () => {
    const old = score({ signals: [sig('connections.few', 'Few connections (20)', 12), sig('activity.stale', 'No activity since 2024-01-01', 4)] });
    const against = section(renderResult(profile({ score: old })), 'against');
    expect(against).toMatch(/<li class="major">[\s\S]*Few connections/);
    expect(against).toMatch(/<li class="minor">[\s\S]*No activity since/);
  });

  test('a floored High result: the lead and the score detail name the changed-hands pattern (AE3)', () => {
    const html = renderResult(profile({ score: FLOORED }));
    expect(html).toContain('<h2>High suspicion</h2>');
    expect(/<section class="lvl[\s\S]*?<\/section>/.exec(html)![0]).toContain('old account re-dressed for a new persona');
    const detail = /<span id="scoreDetail"[\s\S]*?<\/span>/.exec(html)![0];
    expect(detail).toContain('33/100');
    expect(detail).toContain(`rules v${SCORE_VERSION}`);
    expect(detail).toContain('changed-hands pattern raised the level');
    expect(html).toContain('id="scoreBtn"');
  });

  test('an unfloored score detail has no pattern line', () => {
    const detail = /<span id="scoreDetail"[\s\S]*?<\/span>/.exec(renderResult(profile({ score: MIXED })))![0];
    expect(detail).toContain('40/100');
    expect(detail).not.toContain('raised the level');
  });

  test('photo: hidden from you is not "None"', () => {
    const photoFact = (html: string) => /<dt>Photo<\/dt><dd>([\s\S]*?)<\/dd>/.exec(html)![1];
    expect(photoFact(renderResult(profile({ facts: facts({ photo: null }) })))).toBe('Hidden<small>from you</small>');
    expect(photoFact(renderResult(profile({ facts: facts({ photo: { present: false, uploadedAt: null } }) })))).toBe('None');
    // Without the profile record the photo wasn't checked at all.
    expect(photoFact(renderResult(profile({ facts: facts({ photo: null, profileLoaded: false }) })))).toBe('—');
  });

  test('the real photo shows with the pixel avatar behind it', () => {
    const html = renderResult(profile({ facts: facts({ photoUrl: 'https://media.example.test/p.jpg' }) }));
    expect(html).toContain('<img src="https://media.example.test/p.jpg"');
    expect(html).toContain('<canvas class="pxav" data-seed="Jordan Sample"');
    expect(renderResult(profile())).not.toContain('<img');
  });

  test('"Not checked" items never appear in the red flags list', () => {
    const html = renderResult(profile({ score: MIXED }));
    expect(section(html, 'against')).not.toContain('Recent activity');
    expect(/<p class="nc">[\s\S]*?<\/p>/.exec(html)![0]).toContain('Recent activity');
  });

  test('no genuine signs: a muted line and a 0 gauge count', () => {
    const html = renderResult(profile({ score: score({ signals: [sig('activity.none', 'No public activity', 8)] }) }));
    expect(section(html, 'for')).toContain('Nothing found on this side');
    expect(html).toMatch(/<canvas class="dz" data-frac="0" data-c="ok"[^>]*aria-label="Signs it&#39;s genuine: none"/);
    expect(html).toMatch(/<div class="bal-row fv">[\s\S]*?<b>0<\/b>/);
  });

  test('carried parts render "About this read"', () => {
    const html = renderResult(profile({ carried: ['activity'], previousCheckAt: NOW - 86_400_000 }));
    expect(html).toContain('About this read');
    expect(html).toContain('recent activity');
  });

  test('profile results end with a quiet "This is my profile" link for your own profile only (R17)', () => {
    const html = renderResult(profile());
    expect(html).toContain('id="meBtn"');
    expect(html).toMatch(/This is my profile<\/button> <span>[^<]*Only for your own profile/);
    expect(html.indexOf('id="removal"')).toBeGreaterThan(html.indexOf('class="foot"'));
  });

  test('copy never says someone is fake', () => {
    for (const s of [MIXED, FLOORED, score(), score({ level: 'high', score: 80, signals: MIXED.signals })]) {
      expect(renderResult(profile({ score: s })).toLowerCase()).not.toMatch(/is fake|are fake|fake profile|fake account/);
    }
  });
});

const company = (): CompanyFacts => ({
  companyId: 4242, slug: 'example-brand-careers', name: 'Example Brand Careers', tagline: null, industry: 'Software Development',
  headquarters: null, type: null, foundedYear: 2025, claimedSize: null, employeesOnLinkedIn: 3, followers: 10, website: null,
  specialties: [], logo: { present: false, uploadedAt: null }, logoUrl: null, posts: { count: 0, newestAt: null },
});

describe('company and job', () => {
  test('a company result renders layout A', () => {
    const r: CompanyScan = {
      kind: 'company', slug: 'example-brand-careers', facts: company(), capturedAt: NOW, errors: {}, changes: [], previousCheckAt: null, cached: false,
      score: score({ score: 45, level: 'medium', signals: [sig('company.no-website', 'No website listed', 8)] }),
    };
    const html = renderResult(r);
    expect(html).toContain('Example Brand Careers');
    expect(html).toContain('<h2>Some concerns</h2>');
    expect(section(html, 'against')).toContain('No website listed');
    expect(html).toContain('<dt>Founded</dt>');
  });

  test('only profile results with a member ID get the "This is my profile" link', () => {
    const c: CompanyScan = { kind: 'company', slug: 'example-brand-careers', facts: company(), capturedAt: NOW, errors: {}, changes: [], previousCheckAt: null, cached: false, score: score() };
    expect(renderResult(c)).not.toContain('This is my profile');
    expect(renderResult(profile({ facts: facts({ memberId: null }) }))).not.toContain('This is my profile');
  });

  test('a job result renders the hiring team and the company block', () => {
    const job: JobFacts = {
      jobId: '4100000001', title: 'Remote Data Entry Clerk', company: { name: 'Example Brand Careers', slug: 'example-brand-careers' },
      location: 'Remote', postedText: '2 days ago', postedAt: null, reposted: false, applicants: null, seniority: null,
      employmentType: 'Part-time', jobFunction: null, industries: null, salary: null, apply: 'offsite', description: '',
      contacts: { emails: [], phones: [], urls: [] },
      extras: { hiringTeam: [{ slug: 'casey-sample-1x2y3z', name: 'Casey Sample' }], verified: false, errors: {} } as any,
    };
    const r: JobScan = {
      kind: 'job', id: '4100000001', facts: job, capturedAt: NOW, errors: {}, changes: [], previousCheckAt: null, cached: false,
      score: score({ score: 62, level: 'high', signals: [sig('job.no-pay', 'No pay range', 4)] }),
      company: { facts: company(), score: score({ score: 45, level: 'medium', signals: [sig('company.new', 'Page created this year', 10)] }) },
    };
    const html = renderResult(r);
    expect(html).toContain('Hiring team');
    expect(html).toContain('href="https://www.linkedin.com/in/casey-sample-1x2y3z/"');
    expect(html).toContain('Company page');
    expect(html).toContain('Page created this year');
    expect(html).not.toMatch(/\+10</);
  });
});
