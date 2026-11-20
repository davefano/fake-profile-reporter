// Synthetic pages in the shape of LinkedIn's logged-out HTML, for tests.

const NOW = Date.UTC(2026, 10, 18);
const DAY = 86_400_000;

export function companyHtml(o: {
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

export function jobHtml(o: { title?: string; company?: string; slug?: string | null; posted?: string; salary?: string | null; description?: string; offsite?: boolean }) {
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

