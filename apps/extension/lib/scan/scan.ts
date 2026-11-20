// Scan the active tab: read it through the LinkedIn client, score it, and
// compare with this browser's history of the same profile, company, or job.

import {
  carryForwardProfile,
  compactJobFacts,
  diffCompanyFacts,
  diffJobFacts,
  diffProfileFacts,
  type FactChange,
  type ProfileFacts,
} from '@flr/core/linkedin';
import { scoreCompany, scoreJob, scoreProfile } from '@flr/core/scam';
import { activeLinkedInTab, linkedin } from '@/lib/linkedin/client';
import { targetKey, type ScanResponse, type ScanResult } from './messages';

// A profile read is 6 requests to LinkedIn, a job up to 6. Reuse results for a
// while so flipping between tabs or reopening the panel doesn't repeat them.
const CACHE_MS = 15 * 60_000;

/**
 * A key-value area that keeps only the `limit` most recently written entries,
 * tracked in an index entry. Storage quotas are small (10 MB).
 */
function bounded(area: Browser.storage.StorageArea, prefix: string, limit: number) {
  const indexKey = `${prefix}:index`;
  const keyOf = (key: string) => `${prefix}:${key}`;
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await area.get(keyOf(key)))[keyOf(key)] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      const index = ((await area.get(indexKey))[indexKey] as string[] | undefined) ?? [];
      const next = [key, ...index.filter((k) => k !== key)];
      await area.set({ [keyOf(key)]: value, [indexKey]: next.slice(0, limit) });
      await area.remove(next.slice(limit).map(keyOf));
    },
  };
}

const scans = bounded(browser.storage.session, 'scan', 20);
// Raw profile snapshots for Track/Report (a few hundred KB each).
const snapshots = bounded(browser.storage.session, 'snap', 5);
const history = bounded(browser.storage.local, 'hist', 300);

export const cachedScan = (key: string) => scans.get<ScanResult>(key);
/** The gzipped raw snapshot behind a cached profile scan, if still kept. */
export const cachedSnapshot = (key: string) => snapshots.get<string>(key);

/**
 * Compare with what this browser saw last time, then remember the new
 * observation (`remember` says what to keep). Never fails a scan.
 */
async function compare<T>(key: string, facts: T, at: number, diff: (a: T, b: T) => FactChange[], remember: (prev: T | null, next: T) => T = (_, n) => n) {
  try {
    const prev = await history.get<{ facts: T; checkedAt: number }>(key);
    await history.set(key, { facts: remember(prev?.facts ?? null, facts), checkedAt: at });
    return { changes: prev ? diff(prev.facts, facts) : [], previousCheckAt: prev?.checkedAt ?? null, cached: false };
  } catch {
    return { changes: [], previousCheckAt: null, cached: false };
  }
}

export async function scan(force: boolean): Promise<ScanResponse> {
  const tab = await activeLinkedInTab();
  if (!tab?.target) return { error: 'not_linkedin_target', tabUrl: tab?.url ?? null };
  const target = tab.target;

  const key = targetKey(target)!;
  if (!force) {
    const hit = await cachedScan(key);
    if (hit && Date.now() - hit.capturedAt < CACHE_MS) return { ...hit, cached: true };
  }

  let result: ScanResult;
  const now = Date.now();
  try {
    if (target.kind === 'company') {
      const { facts, errors } = await linkedin.company(target.slug, { tab });
      const hist = await compare(`company:${facts.companyId ?? facts.slug}`, facts, now, diffCompanyFacts);
      result = { kind: 'company', slug: target.slug, facts, score: scoreCompany(facts, now), capturedAt: now, errors, ...hist };
    } else if (target.kind === 'job') {
      const { job, company, errors } = await linkedin.job(target.id, { tab });
      const companyScore = company ? scoreCompany(company, now) : null;
      const hist = await compare(`job:${target.id}`, compactJobFacts(job), now, diffJobFacts);
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
      const { snapshotGzipBase64, ...p } = await linkedin.profile(target.slug, { tab, includeSnapshot: true });
      if (snapshotGzipBase64) await snapshots.set(key, snapshotGzipBase64).catch(() => {});
      // History per member ID, so renamed profiles still match. Parts that
      // failed to load keep their last good values.
      const hist = await compare<ProfileFacts>(`acct:${p.facts.memberId}`, p.facts, p.capturedAt, diffProfileFacts, carryForwardProfile);
      result = { kind: 'profile', ...p, score: scoreProfile(p.facts, p.capturedAt), ...hist };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    return { error: code ?? (/not found/i.test(message) ? 'not_found' : 'capture_failed'), message };
  }
  await scans.set(key, result).catch(() => {});
  return result;
}
