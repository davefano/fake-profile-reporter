// A company page's facts, parsed from the public (logged-out) page.

import { byClass, decodeEntities, firstText, htmlText, mediaUploadedAt, parseCount } from '../html';
import type { CompanyExtras } from './extras';

export interface CompanyFacts {
  /** Numeric organization ID. Stable across name and URL changes. */
  companyId: number | null;
  slug: string;
  name: string | null;
  tagline: string | null;
  industry: string | null;
  headquarters: string | null;
  /** "Privately Held", "Public Company", "Self-Employed", … */
  type: string | null;
  foundedYear: number | null;
  /** The size range the page claims, e.g. 501–1,000 employees. */
  claimedSize: { min: number; max: number | null; label: string } | null;
  /** People whose profile lists this company ("View all 650 employees"). */
  employeesOnLinkedIn: number | null;
  followers: number | null;
  website: string | null;
  specialties: string[];
  logo: { present: boolean; uploadedAt: number | null };
  /** Logo image URL for display. Signed and short-lived, so kept out of `logo` and not diffed. */
  logoUrl: string | null;
  /** Recent page posts visible to logged-out visitors. */
  posts: { count: number; newestAt: number | null };
  /** Logged-in extras, when the viewer was signed in (see extras.ts). */
  extras?: CompanyExtras | null;
}

export function parseCompanyPage(html: string, slug: string): CompanyFacts {
  // The About block is a list of <div data-test-id="about-us__<key>"><dt>Label</dt><dd>Value</dd></div>.
  const about = new Map<string, string>();
  const aboutHtml = new Map<string, string>();
  for (const m of html.matchAll(/data-test-id="about-us__([a-zA-Z]+)"[^>]*>(?:(?!data-test-id=)[\s\S])*?<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    aboutHtml.set(m[1]!, m[2]!);
    about.set(m[1]!, htmlText(m[2]!.replace(/<div[^>]*sr-only[\s\S]*?<\/div>/g, '')).replace(/\s*External link.*$/i, '').trim());
  }
  // The website link goes through LinkedIn's redirector; the real URL is its `url` parameter.
  const redirect = /href="[^"]*\/redir\/redirect\?url=([^&"]+)/.exec(aboutHtml.get('website') ?? '')?.[1];

  const subline = firstText(html, 'top-card-layout__first-subline') ?? '';
  // The top card shows followers only sometimes; the meta description always does.
  const metaDesc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  const followers = parseCount((subline.match(/([\d,.]+[KkMm]?)\s+followers/) ?? metaDesc.match(/([\d,.]+[KkMm]?)\s+followers/))?.[1]);
  const employees = parseCount(firstText(html, 'face-pile__text')?.match(/([\d,.]+[KkMm]?)\s+employees/)?.[1]);

  const sizeLabel = about.get('size') ?? null;
  const sizeNums = sizeLabel?.replace(/,/g, '').match(/(\d+)(?:\s*-\s*(\d+)|\+)?/);
  const claimedSize =
    sizeLabel && sizeNums ? { min: Number(sizeNums[1]), max: sizeNums[2] ? Number(sizeNums[2]) : null, label: sizeLabel } : null;

  const logoUrl = /<img[^>]+(?:data-delayed-url|src)="([^"]*company-logo[^"]*)"/.exec(html)?.[1] ?? null;
  const postTimes: number[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]!);
      for (const item of data['@graph'] ?? [data]) {
        if (item?.['@type'] === 'SocialMediaPosting' && item.datePublished) postTimes.push(Date.parse(item.datePublished));
      }
    } catch {
      // not JSON we understand
    }
  }
  postTimes.sort((a, b) => b - a);

  const id = /urn:li:(?:organization|company|fsd_company):(\d+)/.exec(html)?.[1];
  const founded = Number(about.get('foundedOn'));
  return {
    companyId: id ? Number(id) : null,
    slug,
    name: firstText(html, 'top-card-layout__title', 'h1'),
    tagline: firstText(html, 'top-card-layout__second-subline'),
    industry: about.get('industry') ?? null,
    headquarters: about.get('headquarters') ?? null,
    type: about.get('organizationType') ?? null,
    foundedYear: Number.isInteger(founded) && founded > 1600 ? founded : null,
    claimedSize,
    employeesOnLinkedIn: employees,
    followers,
    website: normalizeWebsite(redirect ? safeDecode(redirect) : (about.get('website') ?? null)),
    specialties: (about.get('specialties') ?? '').split(/,\s*(?:and\s+)?/).map((x) => x.trim()).filter(Boolean),
    logo: { present: !!logoUrl, uploadedAt: mediaUploadedAt(logoUrl) },
    logoUrl: logoUrl ? decodeEntities(logoUrl) : null,
    posts: { count: postTimes.length, newestAt: postTimes[0] ?? null },
  };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeWebsite(s: string | null): string | null {
  const m = s?.match(/https?:\/\/[^\s"<>]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"<>]*/i);
  return m ? m[0] : null;
}
