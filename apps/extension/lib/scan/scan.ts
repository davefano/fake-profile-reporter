// Scan the active tab: read it through the LinkedIn client, score it, and
// compare with this browser's history of the same profile, company, or job.

import { diffFields, diffProfileFacts, type CompanyFacts, type JobFacts } from '@flr/core/linkedin';
import { scoreCompany, scoreJob, scoreProfile } from '@flr/core/scam';
import { activeLinkedInTab, linkedin } from '@/lib/linkedin/client';
import { targetKey, type ScanResponse, type ScanResult } from '@/lib/messages';

// A profile read is 6 requests to LinkedIn, a job up to 6. Reuse results for a
// while so flipping between tabs or reopening the panel doesn't repeat them.
const CACHE_MS = 15 * 60_000;

const COMPANY_FIELDS: Array<keyof CompanyFacts> = ['slug', 'name', 'tagline', 'website', 'industry', 'headquarters', 'type', 'foundedYear', 'claimedSize', 'logo'];
const JOB_FIELDS: Array<keyof JobFacts> = ['title', 'company', 'location', 'salary', 'apply', 'description'];

export const scanCacheKey = (key: string) => `scan:${key}`;

export async function cachedScan(key: string): Promise<ScanResult | undefined> {
  return (await browser.storage.session.get(scanCacheKey(key)))[scanCacheKey(key)] as ScanResult | undefined;
}

/** Compare with the last observation of the same thing, then replace it. */
async function history<T extends object>(key: string, facts: T, capturedAt: number, diff: (a: T, b: T) => ScanResult['changes']) {
  const prev = (await browser.storage.local.get(key))[key] as { facts: T; checkedAt: number } | undefined;
  await browser.storage.local.set({ [key]: { facts, checkedAt: capturedAt } });
  return { changes: prev ? diff(prev.facts, facts) : [], previousCheckAt: prev?.checkedAt ?? null, cached: false };
}

export async function scan(force: boolean): Promise<ScanResponse> {
  const tab = await activeLinkedInTab();
  if (!tab?.target) return { error: 'not_linkedin_profile', tabUrl: tab?.url ?? null };
  const { tabId, target } = tab;

  const key = targetKey(target)!;
  if (!force) {
    const hit = await cachedScan(key);
    if (hit && Date.now() - hit.capturedAt < CACHE_MS) return { ...hit, cached: true };
  }

  let result: ScanResult;
  const now = Date.now();
  try {
    if (target.kind === 'company') {
      const facts = await linkedin.company(target.slug, { tabId });
      const hist = await history(`company:${facts.companyId ?? facts.slug}`, facts, now, (a, b) => diffFields(a, b, COMPANY_FIELDS));
      result = { kind: 'company', slug: target.slug, facts, score: scoreCompany(facts, now), capturedAt: now, ...hist };
    } else if (target.kind === 'job') {
      const { job, company, errors } = await linkedin.job(target.id, { tabId });
      const companyScore = company ? scoreCompany(company, now) : null;
      const hist = await history(`job:${target.id}`, job, now, (a, b) => diffFields(a, b, JOB_FIELDS));
      result = {
        kind: 'job',
        id: target.id,
        facts: job,
        score: scoreJob(job, company, companyScore),
        company: company && companyScore ? { facts: company, score: companyScore } : null,
        capturedAt: now,
        errors,
        ...hist,
      };
    } else {
      const p = await linkedin.profile(tabId, target.slug);
      // History per member ID, so renamed profiles still match.
      const hist = await history(`acct:${p.facts.memberId}`, p.facts, p.capturedAt, diffProfileFacts);
      result = { kind: 'profile', ...p, score: scoreProfile(p.facts, p.capturedAt), ...hist };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    return { error: code ?? (/not found/i.test(message) ? 'not_found' : 'capture_failed'), message };
  }
  await browser.storage.session.set({ [scanCacheKey(key)]: result }).catch(() => {});
  return result;
}
