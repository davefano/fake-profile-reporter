// Get a job posting's facts and its company's: public pages, plus the
// signed-in extras when asked.

import type { CompanyFacts } from '../company/facts';
import { getCompany } from '../company/get';
import { endpoints } from '../endpoints';
import { sessionFrom, type LinkedInSession, type SessionOptions } from '../session';
import { fetchJobExtras } from './extras';
import { parseJobPosting, type JobFacts } from './facts';

export interface GetJobOptions extends SessionOptions {
  session?: LinkedInSession;
  signedIn?: boolean;
  /** Also get the company page the posting links to (default true). */
  includeCompany?: boolean;
}

export interface JobWithCompany {
  job: JobFacts;
  company: CompanyFacts | null;
  errors: Record<string, string>;
}

/** Public posting only: 1 logged-out request. */
export async function fetchJob(jobId: string, opts: GetJobOptions = {}): Promise<JobFacts> {
  const facts = parseJobPosting(await sessionFrom(opts).publicHtml(endpoints.jobPosting(jobId)), jobId);
  if (!facts.title) throw new Error('Job posting not found');
  return facts;
}

/** Posting + company, with extras when signed in. Public: 2 requests; signed in: up to 6. */
export async function getJob(jobId: string, opts: GetJobOptions = {}): Promise<JobWithCompany> {
  const session = sessionFrom(opts);
  const job = await fetchJob(jobId, { session });
  const errors: Record<string, string> = {};
  if (opts.signedIn) job.extras = await fetchJobExtras(jobId, { session }).catch((e) => ((errors.extras = String(e)), null));
  let company: CompanyFacts | null = null;
  if (opts.includeCompany !== false && job.company.slug) {
    try {
      company = await getCompany(job.company.slug, { session, signedIn: opts.signedIn });
    } catch (e) {
      errors.company = e instanceof Error ? e.message : String(e);
    }
  }
  return { job, company, errors };
}
