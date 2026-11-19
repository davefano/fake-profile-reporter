// Read LinkedIn from any extension context that has the tabs API (background,
// side panel). Public company and job pages are fetched directly, logged out;
// anything signed in goes through the user's LinkedIn tab (serve.ts).
//
//   const tab = await activeLinkedInTab();
//   const company = await linkedin.company('example-co', { tabId: tab?.tabId });

import { fetchCompany, fetchJob, linkedInTarget, type CompanyFacts, type JobWithCompany, type LinkedInTarget } from '@flr/core/linkedin';
import { isError, sendToTab } from '@/lib/runtime';
import type { LinkedInMessages, ProfileResult } from './protocol';

const PUBLIC = { base: 'https://www.linkedin.com' };

export interface LinkedInTab {
  tabId: number;
  url: string;
  target: LinkedInTarget | null;
}

/** The active tab, if it's on LinkedIn, with what it shows. */
export async function activeLinkedInTab(): Promise<LinkedInTab | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/www\.linkedin\.com\//.test(tab.url ?? '')) return null;
  return { tabId: tab.id, url: tab.url!, target: linkedInTarget(tab.url) };
}

// Tabs opened before the extension was installed or reloaded have no content
// script yet: inject it and retry once.
async function ask<K extends keyof LinkedInMessages>(tabId: number, msg: LinkedInMessages[K]['req']): Promise<LinkedInMessages[K]['res']> {
  try {
    return await sendToTab<LinkedInMessages, K>(tabId, msg);
  } catch {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    return sendToTab<LinkedInMessages, K>(tabId, msg);
  }
}

/** Signed-in extras, or null when they can't be had (signed out, no tab). */
async function extras<K extends 'LI_COMPANY_EXTRAS' | 'LI_JOB_EXTRAS'>(tabId: number | undefined, msg: LinkedInMessages[K]['req']) {
  if (tabId == null) return null;
  const r = await ask<K>(tabId, msg).catch(() => null);
  return r && !isError(r) ? (r as Exclude<LinkedInMessages[K]['res'], { error: string }>) : null;
}

export const linkedin = {
  /** A profile's facts, read in the LinkedIn tab (signed in, about 6 requests). */
  async profile(tabId: number, slug: string, opts: { includeActivity?: boolean } = {}): Promise<ProfileResult> {
    const r = await ask<'LI_PROFILE'>(tabId, { type: 'LI_PROFILE', slug, includeActivity: opts.includeActivity });
    if (isError(r)) throw Object.assign(new Error(r.message ?? r.error), { code: r.error });
    return r;
  },

  /** The raw snapshot behind the last profile() call in that tab, gzipped. */
  async profileSnapshot(tabId: number, slug: string): Promise<Uint8Array> {
    const r = await ask<'LI_PROFILE_SNAPSHOT'>(tabId, { type: 'LI_PROFILE_SNAPSHOT', slug });
    if (isError(r)) throw Object.assign(new Error(r.message ?? r.error), { code: r.error });
    return Uint8Array.from(atob(r.gzipBase64), (c) => c.charCodeAt(0));
  },

  /** A company page's facts. Pass a LinkedIn tabId to add the signed-in extras. */
  async company(slug: string, opts: { tabId?: number } = {}): Promise<CompanyFacts> {
    const facts = await fetchCompany(slug, PUBLIC);
    facts.extras = await extras<'LI_COMPANY_EXTRAS'>(opts.tabId, { type: 'LI_COMPANY_EXTRAS', slug });
    return facts;
  },

  /** A job posting and its company. Pass a LinkedIn tabId to add the signed-in extras. */
  async job(jobId: string, opts: { tabId?: number } = {}): Promise<JobWithCompany> {
    const job = await fetchJob(jobId, PUBLIC);
    job.extras = await extras<'LI_JOB_EXTRAS'>(opts.tabId, { type: 'LI_JOB_EXTRAS', jobId });
    const errors: Record<string, string> = {};
    let company: CompanyFacts | null = null;
    if (job.company.slug) {
      try {
        company = await linkedin.company(job.company.slug, opts);
      } catch (e) {
        errors.company = e instanceof Error ? e.message : String(e);
      }
    }
    return { job, company, errors };
  },
};
