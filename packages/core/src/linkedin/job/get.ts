// Get a job posting's facts and its company's: public pages, plus the
// signed-in extras.

import type { CompanyExtras } from '../company/extras';
import type { CompanyFacts } from '../company/facts';
import { getCompany, message, type SignedIn } from '../company/get';
import { endpoints } from '../endpoints';
import { sessionFrom, type ReaderOptions } from '../session';
import { fetchJobExtras, type JobExtras } from './extras';
import { parseJobPosting, type JobFacts } from './facts';

export interface JobOptions extends ReaderOptions {
  signedIn?: true | { job: (jobId: string) => Promise<JobExtras>; company: (slug: string) => Promise<CompanyExtras> };
  /** Also get the company page the posting links to (default true). */
  includeCompany?: boolean;
}

export interface JobWithCompany {
  job: JobFacts;
  company: CompanyFacts | null;
  /** What failed: "extras", "company", "company.extras". The facts that did load are kept. */
  errors: Record<string, string>;
}

/** Public posting only: 1 logged-out request. */
export async function fetchJob(jobId: string, opts: ReaderOptions = {}): Promise<JobFacts> {
  const facts = parseJobPosting(await sessionFrom(opts).publicHtml(endpoints.jobPosting(jobId)), jobId);
  if (!facts.title) throw new Error('Job posting not found');
  return facts;
}

/** Posting + company, with extras when signed in. Throws only if the posting itself fails. */
export async function getJob(jobId: string, opts: JobOptions = {}): Promise<JobWithCompany> {
  const session = sessionFrom(opts);
  const job = await fetchJob(jobId, { session });
  const errors: Record<string, string> = {};
  const signedIn = opts.signedIn;
  if (signedIn) {
    const read = signedIn === true ? (id: string) => fetchJobExtras(id, { session }) : signedIn.job;
    job.extras = await read(jobId).catch((e) => ((errors.extras = message(e)), null));
  }
  let company: CompanyFacts | null = null;
  if (opts.includeCompany !== false && job.company.slug) {
    const companySignedIn: SignedIn<CompanyExtras> | undefined = signedIn === true ? true : signedIn?.company;
    try {
      const r = await getCompany(job.company.slug, { session, signedIn: companySignedIn });
      company = r.facts;
      if (r.errors.extras) errors['company.extras'] = r.errors.extras;
    } catch (e) {
      errors.company = message(e);
    }
  }
  return { job, company, errors };
}
