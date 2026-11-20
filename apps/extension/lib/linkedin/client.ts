// Read LinkedIn from any extension context that has the tabs API (background,
// side panel). Public company and job pages are fetched directly, logged out;
// anything signed in goes through the user's LinkedIn tab (serve.ts).
//
//   const tab = await activeLinkedInTab();
//   const { facts } = await linkedin.company('example-co', { tab });

import { getCompany, getJob, linkedInTarget, type CompanyResult, type JobWithCompany, type LinkedInTarget } from '@flr/core/linkedin';
import { isError, sendToTab, type ErrorResponse } from '@/lib/runtime';
import type { LinkedInMessages, ProfileResult } from './protocol';

const PUBLIC = { base: 'https://www.linkedin.com' };

export interface LinkedInTab {
  tabId: number;
  url: string;
  target: LinkedInTarget | null;
  /** The content script (and so the signed-in session) runs on www.linkedin.com only. */
  signedInReachable: boolean;
}

/** The active tab, if it's on LinkedIn, with what it shows. */
export async function activeLinkedInTab(): Promise<LinkedInTab | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab?.url ?? '').hostname;
  } catch {
    return null;
  }
  if (!tab?.id || !/(^|\.)linkedin\.com$/.test(host)) return null;
  return { tabId: tab.id, url: tab.url!, target: linkedInTarget(tab.url), signedInReachable: host === 'www.linkedin.com' };
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

/** Turn an error answer into a thrown Error carrying its code. */
function unwrap<T>(r: T | ErrorResponse): T {
  if (isError(r)) throw Object.assign(new Error(r.message ?? r.error), { code: r.error });
  return r;
}

/** Signed-in readers that go through a tab, for the core getters. */
function viaTab(tabId: number) {
  return {
    company: async (slug: string) => unwrap(await ask<'LI_COMPANY_EXTRAS'>(tabId, { type: 'LI_COMPANY_EXTRAS', slug })),
    job: async (jobId: string) => unwrap(await ask<'LI_JOB_EXTRAS'>(tabId, { type: 'LI_JOB_EXTRAS', jobId })),
  };
}

export const linkedin = {
  /** A profile's facts and raw snapshot, read in the LinkedIn tab (signed in, about 6 requests). */
  async profile(tabId: number, slug: string, opts: { includeActivity?: boolean } = {}): Promise<ProfileResult> {
    return unwrap(await ask<'LI_PROFILE'>(tabId, { type: 'LI_PROFILE', slug, includeActivity: opts.includeActivity }));
  },

  /** A company page's facts. With a signed-in LinkedIn tab, the extras too. */
  company(slug: string, opts: { tab?: LinkedInTab | null } = {}): Promise<CompanyResult> {
    const tab = opts.tab?.signedInReachable ? opts.tab : null;
    return getCompany(slug, { ...PUBLIC, signedIn: tab ? viaTab(tab.tabId).company : undefined });
  },

  /** A job posting and its company. With a signed-in LinkedIn tab, the extras too. */
  job(jobId: string, opts: { tab?: LinkedInTab | null } = {}): Promise<JobWithCompany> {
    const tab = opts.tab?.signedInReachable ? opts.tab : null;
    return getJob(jobId, { ...PUBLIC, signedIn: tab ? viaTab(tab.tabId) : undefined });
  },
};
