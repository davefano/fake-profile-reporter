// Scan the active tab: read it through the LinkedIn client, score it, and
// compare with this browser's history of the same profile, company, or job.

import { compactJobFacts, diffCompanyFacts, diffJobFacts, observeProfile, type FactChange, type ProfileFacts, type ProfilePart } from '@flr/core/linkedin';
import { scoreCompany, scoreJob, scoreProfile } from '@flr/core/scam';
import { activeLinkedInTab, linkedin } from '@/lib/linkedin/client';
import { CodedError, errorText } from '@/lib/runtime';
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

// Session storage is MV3 only; Firefox and Safari (MV2) fall back to local,
// where both stores are bounded and scans expire anyway.
const sessionArea = browser.storage.session ?? browser.storage.local;
const scans = bounded(sessionArea, 'scan', 20);
// Raw profile snapshots for Track/Report (a few hundred KB each).
const snapshots = bounded(sessionArea, 'snap', 5);
const history = bounded(browser.storage.local, 'hist', 300);

export const cachedScan = (key: string) => scans.get<ScanResult>(key).catch(() => undefined);
/** The gzipped raw snapshot behind a cached profile scan, if still kept. */
export const cachedSnapshot = (key: string) => snapshots.get<string>(key).catch(() => undefined);

type Observe<T> = (prev: T | null, next: T) => { current: T; changes: FactChange[]; carried?: ProfilePart[] };
/** Plain comparison: keep the new observation as it is. */
const by = <T>(diff: (a: T, b: T) => FactChange[]): Observe<T> => (prev, next) => ({ current: next, changes: prev ? diff(prev, next) : [] });

/**
 * Compare with what this browser saw last time, remember the result, and
 * return the current facts. Never fails a scan: without storage it just
 * reports no history.
 */
async function compare<T>(key: string, facts: T, at: number, observe: Observe<T>) {
  try {
    const prev = await history.get<{ facts: T; checkedAt: number }>(key);
    const { current, changes, carried = [] } = observe(prev?.facts ?? null, facts);
    await history.set(key, { facts: current, checkedAt: at });
    return { current, carried, hist: { changes, previousCheckAt: prev?.checkedAt ?? null, cached: false } };
  } catch {
    return { current: facts, carried: [] as ProfilePart[], hist: { changes: [], previousCheckAt: null, cached: false } };
  }
}

export async function scan(force: boolean): Promise<ScanResponse> {
  const tab = await activeLinkedInTab();
  if (!tab?.target) return { error: 'not_linkedin_target', tabUrl: tab?.url ?? null };
  const target = tab.target;

  const key = targetKey(target);
  if (!force) {
    const hit = await cachedScan(key);
    if (hit && Date.now() - hit.capturedAt < CACHE_MS) return { ...hit, cached: true };
  }

  let result: ScanResult;
  const now = Date.now();
  try {
    if (target.kind === 'company') {
      const { facts, errors } = await linkedin.company(target.slug, { tab });
      const { hist } = await compare(`company:${facts.companyId ?? facts.slug}`, facts, now, by(diffCompanyFacts));
      result = { kind: 'company', slug: target.slug, facts, score: scoreCompany(facts, now), capturedAt: now, errors, ...hist };
    } else if (target.kind === 'job') {
      const { job, company, errors } = await linkedin.job(target.id, { tab });
      const companyScore = company ? scoreCompany(company, now) : null;
      const { hist } = await compare(`job:${target.id}`, compactJobFacts(job), now, by(diffJobFacts));
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
      // failed to load keep their last good values, and the score uses those,
      // the same way the directory does.
      const { current, carried, hist } = await compare<ProfileFacts>(`acct:${p.facts.memberId}`, p.facts, p.capturedAt, observeProfile);
      result = { kind: 'profile', ...p, facts: current, score: scoreProfile(current, p.capturedAt), carried, ...hist };
    }
  } catch (e) {
    const message = errorText(e);
    return { error: e instanceof CodedError ? e.code : /not found/i.test(message) ? 'not_found' : 'capture_failed', message };
  }
  await scans.set(key, result).catch(() => {});
  return result;
}
