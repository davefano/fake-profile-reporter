// Get a company page's facts: the public page, plus the signed-in extras.

import { endpoints } from '../endpoints';
import { sessionFrom, type ReaderOptions } from '../session';
import { fetchCompanyExtras, type CompanyExtras } from './extras';
import { parseCompanyPage, type CompanyFacts } from './facts';

/**
 * How to read the signed-in extras. `true` reads them through the reader's own
 * session (a logged-in linkedin.com page context). Callers that reach the
 * signed-in session some other way (a browser tab, an automated browser)
 * pass their own function.
 */
export type SignedIn<T> = true | ((key: string) => Promise<T>);

export interface CompanyOptions extends ReaderOptions {
  signedIn?: SignedIn<CompanyExtras>;
}

export interface CompanyResult {
  facts: CompanyFacts;
  /** What failed, e.g. { extras: "HTTP 403" }. The facts that did load are kept. */
  errors: Record<string, string>;
}

/** Public company page only: 1 logged-out request. */
export async function fetchCompany(slug: string, opts: ReaderOptions = {}): Promise<CompanyFacts> {
  const facts = parseCompanyPage(await sessionFrom(opts).publicHtml(endpoints.companyPage(slug)), slug);
  if (!facts.name) throw new Error('Company page not found');
  return facts;
}

/** Company facts with `extras` filled in when signed in. Throws only if the public page fails. */
export async function getCompany(slug: string, opts: CompanyOptions = {}): Promise<CompanyResult> {
  const session = sessionFrom(opts);
  const facts = await fetchCompany(slug, { session });
  const errors: Record<string, string> = {};
  if (opts.signedIn) {
    const read = opts.signedIn === true ? (s: string) => fetchCompanyExtras(s, { session }) : opts.signedIn;
    facts.extras = await read(slug).catch((e) => ((errors.extras = message(e)), null));
  }
  return { facts, errors };
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
