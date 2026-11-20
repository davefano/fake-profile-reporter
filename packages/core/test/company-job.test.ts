import { describe, expect, test } from 'bun:test';
import { byClass, parseAgo, parseCount, parseCompanyPage, siteDomain, extractContacts, parseJobPosting, parseSalary, linkedInTarget } from '../src/linkedin';
import { scoreCompany, scoreJob } from '../src/scam';

const NOW = Date.UTC(2026, 10, 18);
const DAY = 86_400_000;

// Synthetic pages in the shape of LinkedIn's logged-out HTML.
function companyHtml(o: {
  name?: string;
  id?: number;
  followers?: string;
  employees?: number | null;
  size?: string | null;
  website?: string | null;
  industry?: string;
  founded?: number | null;
  logoAt?: number | null;
  posts?: number[];
}) {
  const row = (key: string, label: string, value: string) =>
    `<div class="mb-2 flex" data-test-id="about-us__${key}"><dt class="font-sans"> ${label} </dt><dd class="font-sans"> ${value} </dd></div>`;
  return `<html><head><title>${o.name ?? 'Example Co'} | LinkedIn</title>
    <meta name="description" content="${o.name ?? 'Example Co'} | ${o.followers ?? '1,200'} followers on LinkedIn."></head><body>
    <code>urn:li:organization:${o.id ?? 123456}</code>
    ${o.logoAt === null ? '' : `<img class="top-card-layout__entity-image" data-delayed-url="https://media.example/dms/image/company-logo_200_200/0/${o.logoAt ?? NOW - 900 * DAY}?e=1&amp;t=x">`}
    <h1 class="top-card-layout__title font-sans"> ${o.name ?? 'Example Co'} </h1>
    <h4 class="top-card-layout__first-subline"> Springfield, IL   ${o.followers ?? '1,200'} followers </h4>
    ${o.employees === null ? '' : `<p class="face-pile__text">View all ${o.employees ?? 120} employees</p>`}
    <div data-test-id="about-us__description"><p>We make things.</p></div>
    ${o.website === null ? '' : row('website', 'Website', `<a href="https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(o.website ?? 'https://www.example.com')}&amp;urlhash=x">${o.website ?? 'https://www.example.com'}<div class="sr-only">External link for ${o.name}</div></a>`)}
    ${row('industry', 'Industry', o.industry ?? 'Software Development')}
    ${o.size === null ? '' : row('size', 'Company size', o.size ?? '51-200 employees')}
    ${row('organizationType', 'Type', 'Privately Held')}
    ${o.founded === null ? '' : row('foundedOn', 'Founded', String(o.founded ?? 2009))}
    ${row('specialties', 'Specialties', 'Widgets, Gadgets, and Research and Development')}
    <script type="application/ld+json">${JSON.stringify({ '@graph': (o.posts ?? [NOW - 5 * DAY]).map((t) => ({ '@type': 'SocialMediaPosting', datePublished: new Date(t).toISOString() })) })}</script>
    </body></html>`;
}

function jobHtml(o: { title?: string; company?: string; slug?: string | null; posted?: string; salary?: string | null; description?: string; offsite?: boolean }) {
  const slug = o.slug === undefined ? 'example-co' : o.slug;
  return `<section>
    <h2 class="top-card-layout__title font-sans">${o.title ?? 'Customer Support Specialist'}</h2>
    <div class="topcard__flavor-row"><span class="topcard__flavor">${slug ? `<a class="topcard__org-name-link topcard__flavor--black-link" href="https://uk.linkedin.com/company/${slug}?trk=x">${o.company ?? 'Example Co'}</a>` : `${o.company ?? 'Example Co'}`}</span>
      <span class="topcard__flavor topcard__flavor--bullet"> Remote </span></div>
    <div class="topcard__flavor-row"><span class="posted-time-ago__text topcard__flavor--metadata"> ${o.posted ?? '3 days ago'} </span>
      <span class="num-applicants__caption topcard__flavor--metadata"> Over 200 applicants </span></div>
    <button data-tracking-control-name="public_jobs_apply-link-${o.offsite ? 'offsite_sign-in' : 'simple_onsite'}">Apply</button>
    ${o.salary === null ? '' : `<div class="compensation__salary-range"><h3 class="compensation__heading">Base pay range</h3><div class="salary compensation__salary"> ${o.salary ?? '$20.00/hr - $24.00/hr'} </div></div>`}
    <div class="show-more-less-html__markup relative">${o.description ?? '<p>Help our customers by answering questions about orders and accounts. You will work with a supportive team, use our ticketing tools, and learn our products in a paid four-week training. Requirements include clear written English, patience, and two years of support experience. Benefits include health insurance, paid leave, and a home-office stipend after ninety days.</p>'}</div>
    <ul class="description__job-criteria-list">
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader"> Seniority level </h3><span class="description__job-criteria-text description__job-criteria-text--criteria"> Entry level </span></li>
      <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader"> Employment type </h3><span class="description__job-criteria-text"> Full-time </span></li>
    </ul></section>`;
}

describe('html helpers', () => {
  test('class matching is by whole token', () => {
    const html = '<div class="salary-range">A</div><div class="x salary y">B</div>';
    expect(byClass(html, 'salary')).toEqual(['B']);
  });
  test('counts and relative times', () => {
    expect(parseCount('418,670 followers')).toBe(418670);
    expect(parseCount('12K')).toBe(12000);
    expect(parseAgo('Reposted 2 weeks ago', NOW)).toBe(NOW - 14 * DAY);
    expect(parseAgo('just now', NOW)).toBeNull();
  });
});

describe('linkedInTarget', () => {
  test('recognizes profiles, companies and jobs', () => {
    expect(linkedInTarget('https://www.linkedin.com/in/jordan-sample/')).toEqual({ kind: 'profile', slug: 'jordan-sample' });
    expect(linkedInTarget('https://www.linkedin.com/company/example-co/about/')).toEqual({ kind: 'company', slug: 'example-co' });
    expect(linkedInTarget('https://www.linkedin.com/jobs/view/support-specialist-at-example-4400000001/')).toEqual({ kind: 'job', id: '4400000001' });
    expect(linkedInTarget('https://www.linkedin.com/jobs/search/?currentJobId=4400000002&keywords=x')).toEqual({ kind: 'job', id: '4400000002' });
    expect(linkedInTarget('https://www.linkedin.com/feed/')).toBeNull();
    expect(linkedInTarget('https://example.com/in/x')).toBeNull();
  });
});

describe('company pages', () => {
  test('parses the public page', () => {
    const c = parseCompanyPage(companyHtml({}), 'example-co');
    expect(c).toMatchObject({
      companyId: 123456,
      name: 'Example Co',
      followers: 1200,
      employeesOnLinkedIn: 120,
      claimedSize: { min: 51, max: 200 },
      website: 'https://www.example.com',
      industry: 'Software Development',
      foundedYear: 2009,
      posts: { count: 1 },
    });
    expect(c.specialties).toEqual(['Widgets', 'Gadgets', 'Research and Development']);
    expect(siteDomain(c.website)).toBe('example.com');
  });

  test('an established page scores low', () => {
    const s = scoreCompany(parseCompanyPage(companyHtml({ followers: '25,000' }), 'example-co'), NOW);
    expect(s.level).toBe('low');
    expect(s.signals.some((x) => x.id === 'company.employees')).toBe(true);
  });

  test('a big claim with nobody behind it, on a hiring-style name, scores high', () => {
    const c = parseCompanyPage(
      companyHtml({ name: 'Example Brand Careers', followers: '14', employees: 2, size: '1,001-5,000 employees', website: 'https://examplebrand.wixsite.com/jobs', posts: [], logoAt: null }),
      'example-brand-careers',
    );
    const s = scoreCompany(c, NOW);
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['company.size-mismatch', 'company.hiring-name', 'company.free-website', 'company.few-followers', 'company.no-logo']) {
      expect(ids).toContain(id);
    }
  });

  test('staffing firms are not flagged for recruiting names', () => {
    const c = parseCompanyPage(companyHtml({ name: 'Acme Recruiting', industry: 'Staffing and Recruiting' }), 'acme-recruiting');
    expect(scoreCompany(c, NOW).signals.map((x) => x.id)).not.toContain('company.hiring-name');
  });
});

describe('job postings', () => {
  const company = parseCompanyPage(companyHtml({ followers: '25,000' }), 'example-co');
  const companyScore = scoreCompany(company, NOW);

  test('parses the public posting', () => {
    const j = parseJobPosting(jobHtml({}), '4400000001', NOW);
    expect(j).toMatchObject({
      title: 'Customer Support Specialist',
      company: { name: 'Example Co', slug: 'example-co' },
      location: 'Remote',
      postedAt: NOW - 3 * DAY,
      applicants: { count: 200, over: true },
      seniority: 'Entry level',
      employmentType: 'Full-time',
      salary: { text: '$20.00/hr - $24.00/hr', min: 20, max: 24, period: 'hour' },
      apply: 'easy',
    });
  });

  test('an ordinary posting from an established company scores low', () => {
    const j = parseJobPosting(jobHtml({}), '1', NOW);
    expect(scoreJob(j, company, companyScore).level).toBe('low');
  });

  test('chat apps, personal email and equipment checks score high', () => {
    const j = parseJobPosting(
      jobHtml({
        title: 'Remote Data Entry Clerk',
        salary: '$45.00/hr - $60.00/hr',
        description:
          '<p>No experience required! Interview will be conducted via Telegram. We will send you a check to purchase equipment for your home office. Send your resume to hiring.team.example@gmail.com</p>',
      }),
      '2',
      NOW,
    );
    const s = scoreJob(j, company, companyScore);
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['job.chat-app', 'job.pay-to-work', 'job.personal-email', 'job.no-experience', 'job.too-good', 'job.chat-interview']) {
      expect(ids).toContain(id);
    }
  });

  test('an email on another company domain is a discrepancy', () => {
    const j = parseJobPosting(jobHtml({ description: '<p>Apply by emailing jobs@example-co-hr.net with your resume and availability for a short call this week. '.padEnd(500, 'x') + '</p>' }), '3', NOW);
    expect(scoreJob(j, company, companyScore).signals.map((x) => x.id)).toContain('job.email-domain');
  });

  test('a posting with no company page, or a suspicious one, is flagged', () => {
    const orphan = parseJobPosting(jobHtml({ slug: null }), '4', NOW);
    expect(scoreJob(orphan, null, null).signals.map((x) => x.id)).toContain('job.no-company-page');

    const shady = parseCompanyPage(companyHtml({ name: 'Brand Hiring', followers: '9', employees: 1, size: '5,001-10,000 employees', website: null, posts: [] }), 'brand-hiring');
    const j = parseJobPosting(jobHtml({ slug: 'brand-hiring', company: 'Brand Hiring' }), '5', NOW);
    const s = scoreJob(j, shady, scoreCompany(shady, NOW));
    expect(s.signals.find((x) => x.id === 'job.company-suspicious')?.kind).toBe('discrepancy');
  });

  test('salary and contact extraction', () => {
    expect(parseSalary('$36,000.00/yr - $150,000.00/yr')).toEqual({ text: '$36,000.00/yr - $150,000.00/yr', min: 36000, max: 150000, period: 'year' });
    expect(extractContacts('Call +1 (555) 010-2000 or mail A@B.example')).toEqual({ emails: ['a@b.example'], phones: ['+1 (555) 010-2000'], urls: [] });
  });
});
