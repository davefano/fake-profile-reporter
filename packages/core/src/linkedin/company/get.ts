// Get a company page's facts: the public page, plus the signed-in extras.

import { endpoints } from '../endpoints';
import { errorText } from '../errors';
import { sessionFrom, type ReaderOptions, type SignedIn } from '../session';
import { fetchCompanyExtras, type CompanyExtras } from './extras';
import { parseCompanyPage, type CompanyFacts } from './facts';

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
    facts.extras = await read(slug).catch((e) => ((errors.extras = errorText(e)), null));
    for (const [k, v] of Object.entries(facts.extras?.errors ?? {})) errors[`extras.${k}`] = v;
  }
  return { facts, errors };
}
