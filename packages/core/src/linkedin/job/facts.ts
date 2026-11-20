// A job posting's facts, parsed from the public (logged-out) posting.

import { byClass, firstText, htmlText, parseAgo, parseCount, safeDecode } from '../html';
import type { JobExtras } from './extras';

export interface JobFacts {
  jobId: string;
  title: string | null;
  company: { name: string | null; slug: string | null };
  location: string | null;
  /** As shown, e.g. "6 days ago" or "Reposted 2 weeks ago". */
  postedText: string | null;
  postedAt: number | null;
  reposted: boolean;
  applicants: { count: number; over: boolean } | null;
  seniority: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  salary: { text: string; min: number | null; max: number | null; period: 'hour' | 'year' | 'month' | 'week' | null } | null;
  /** "easy": LinkedIn Easy Apply; "offsite": the company's own site. */
  apply: 'easy' | 'offsite' | null;
  description: string;
  /** Contact details found in the description. */
  contacts: { emails: string[]; phones: string[]; urls: string[] };
  /** Logged-in extras, when the viewer was signed in (see extras.ts). */
  extras?: JobExtras | null;
}

export function parseJobPosting(html: string, jobId: string, now = Date.now()): JobFacts {
  const criteria = new Map<string, string>();
  for (const li of byClass(html, 'description__job-criteria-item', 'li')) {
    const k = firstText(li, 'description__job-criteria-subheader');
    const v = firstText(li, 'description__job-criteria-text');
    if (k && v) criteria.set(k.toLowerCase(), v);
  }

  // Country subdomains (uk.linkedin.com) appear too.
  const orgLink = /class="[^"]*topcard__org-name-link[^"]*"[^>]*href="https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|showcase)\/([^?"/]+)/.exec(html)
    ?? /href="https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|showcase)\/([^?"/]+)[^"]*"[^>]*class="[^"]*topcard__org-name-link/.exec(html);
  const posted = firstText(html, 'posted-time-ago__text');
  const applicantsText = firstText(html, 'num-applicants__caption') ?? firstText(html, 'num-applicants__figure');
  const salaryText = firstText(html, 'compensation__salary');
  const descHtml = byClass(html, 'show-more-less-html__markup', 'div')[0] ?? '';
  const description = htmlText(descHtml);

  return {
    jobId,
    title: firstText(html, 'top-card-layout__title'),
    company: { name: firstText(html, 'topcard__org-name-link', 'a'), slug: orgLink ? safeDecode(orgLink[1]!) : null },
    location: firstText(html, 'topcard__flavor--bullet'),
    postedText: posted,
    postedAt: parseAgo(posted, now),
    reposted: /reposted/i.test(posted ?? ''),
    applicants: applicantsText ? { count: parseCount(applicantsText) ?? 0, over: /over|\+/i.test(applicantsText) } : null,
    seniority: criteria.get('seniority level') ?? null,
    employmentType: criteria.get('employment type') ?? null,
    jobFunction: criteria.get('job function') ?? null,
    industries: criteria.get('industries') ?? null,
    salary: salaryText ? parseSalary(salaryText) : null,
    apply: /apply-link-offsite/.test(html) ? 'offsite' : /apply-link-simple|easy apply/i.test(html) ? 'easy' : null,
    description,
    contacts: extractContacts(description),
  };
}

export function parseSalary(text: string): NonNullable<JobFacts['salary']> {
  const nums = [...text.replace(/,/g, '').matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*([Kk])?/g)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1));
  const period = /\/\s*hr|hour/i.test(text) ? 'hour' : /\/\s*yr|year|annual/i.test(text) ? 'year' : /\/\s*mo|month/i.test(text) ? 'month' : /week/i.test(text) ? 'week' : null;
  return { text, min: nums[0] ?? null, max: nums[1] ?? nums[0] ?? null, period };
}

export function extractContacts(text: string) {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
  return {
    emails: uniq(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []),
    phones: uniq((text.match(/(?:\+?\d[\d\s().-]{8,}\d)/g) ?? []).filter((p) => p.replace(/\D/g, '').length >= 10)),
    urls: uniq(text.match(/\bhttps?:\/\/[^\s)<>"']+/gi) ?? []),
  };
}
