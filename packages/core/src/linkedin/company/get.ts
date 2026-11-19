// Get a company page's facts: the public page, plus the signed-in extras when asked.

import { endpoints } from '../endpoints';
import { sessionFrom, type LinkedInSession, type SessionOptions } from '../session';
import { fetchCompanyExtras } from './extras';
import { parseCompanyPage, type CompanyFacts } from './facts';

export interface GetOptions extends SessionOptions {
  session?: LinkedInSession;
  /** Also fetch the signed-in extras (needs a logged-in linkedin.com page context). */
  signedIn?: boolean;
}

/** Public company page only: 1 logged-out request. */
export async function fetchCompany(slug: string, opts: GetOptions = {}): Promise<CompanyFacts> {
  const facts = parseCompanyPage(await sessionFrom(opts).publicHtml(endpoints.companyPage(slug)), slug);
  if (!facts.name) throw new Error('Company page not found');
  return facts;
}

/** Company facts, with `extras` filled in when signed in (null if that failed). */
export async function getCompany(slug: string, opts: GetOptions = {}): Promise<CompanyFacts> {
  const session = sessionFrom(opts);
  const facts = await fetchCompany(slug, { session });
  if (opts.signedIn) facts.extras = await fetchCompanyExtras(slug, { session }).catch(() => null);
  return facts;
}
