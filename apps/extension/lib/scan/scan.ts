// Scan the active tab: read it through the LinkedIn client, score it, and
// compare with this browser's history of the same profile, company, or job.

import { diffCompanyFacts, diffJobFacts, diffProfileFacts, type FactChange, type JobFacts } from '@flr/core/linkedin';
import { scoreCompany, scoreJob, scoreProfile } from '@flr/core/scam';
import { activeLinkedInTab, linkedin } from '@/lib/linkedin/client';
import { targetKey, type ScanResponse, type ScanResult } from './messages';

// A profile read is 6 requests to LinkedIn, a job up to 6. Reuse results for a
// while so flipping between tabs or reopening the panel doesn't repeat them.
const CACHE_MS = 15 * 60_000;
// Raw profile snapshots kept for Track/Report (a few hundred KB each).
const SNAPSHOTS_KEPT = 5;
// Things whose local history is kept; the least recently checked go first.
const HISTORY_KEPT = 300;

const scanKey = (key: string) => `scan:${key}`;
const snapKey = (key: string) => `snap:${key}`;

export async function cachedScan(key: string): Promise<ScanResult | undefined> {
  return (await browser.storage.session.get(scanKey(key)))[scanKey(key)] as ScanResult | undefined;
}

/** The gzipped raw snapshot behind a cached profile scan, if still kept. */
export async function cachedSnapshot(key: string): Promise<string | undefined> {
  return (await browser.storage.session.get(snapKey(key)))[snapKey(key)] as string | undefined;
}

async function keepSnapshot(key: string, gzipBase64: string) {
  const index = ((await browser.storage.session.get('snap:index'))['snap:index'] as string[] | undefined) ?? [];
  const next = [key, ...index.filter((k) => k !== key)];
  await browser.storage.session.set({ [snapKey(key)]: gzipBase64, 'snap:index': next.slice(0, SNAPSHOTS_KEPT) });
  await browser.storage.session.remove(next.slice(SNAPSHOTS_KEPT).map(snapKey));
}

/** Compare with the last observation of the same thing, then replace it. Never fails a scan. */
async function history<T>(key: string, facts: T, at: number, diff: (a: T, b: T) => FactChange[]) {
  try {
    const store = browser.storage.local;
    const prev = (await store.get(key))[key] as { facts: T; checkedAt: number } | undefined;
    const index = ((await store.get('hist:index'))['hist:index'] as string[] | undefined) ?? [];
    const next = [key, ...index.filter((k) => k !== key)];
    await store.set({ [key]: { facts, checkedAt: at }, 'hist:index': next.slice(0, HISTORY_KEPT) });
    await store.remove(next.slice(HISTORY_KEPT));
    return { changes: prev ? diff(prev.facts, facts) : [], previousCheckAt: prev?.checkedAt ?? null, cached: false };
  } catch {
    return { changes: [], previousCheckAt: null, cached: false };
  }
}

/** Job history keeps a hash of the description, not the text (it can be 30 KB). */
function forHistory(job: JobFacts): JobFacts {
  let h = 5381;
  for (let i = 0; i < job.description.length; i++) h = ((h << 5) + h + job.description.charCodeAt(i)) | 0;
  return { ...job, description: `#${(h >>> 0).toString(36)}:${job.description.length}` };
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
      const { facts } = await linkedin.company(target.slug, { tab });
      const hist = await history(`company:${facts.companyId ?? facts.slug}`, facts, now, diffCompanyFacts);
      result = { kind: 'company', slug: target.slug, facts, score: scoreCompany(facts, now), capturedAt: now, ...hist };
    } else if (target.kind === 'job') {
      const { job, company, errors } = await linkedin.job(target.id, { tab });
      const companyScore = company ? scoreCompany(company, now) : null;
      const hist = await history(`job:${target.id}`, forHistory(job), now, diffJobFacts);
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
      if (!tab.signedInReachable) return { error: 'capture_failed', message: 'Open this profile on www.linkedin.com to check it.' };
      const { snapshotGzipBase64, ...p } = await linkedin.profile(tab.tabId, target.slug);
      await keepSnapshot(key, snapshotGzipBase64).catch(() => {});
      // History per member ID, so renamed profiles still match.
      const hist = await history(`acct:${p.facts.memberId}`, p.facts, p.capturedAt, diffProfileFacts);
      result = { kind: 'profile', ...p, score: scoreProfile(p.facts, p.capturedAt), ...hist };
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    const message = e instanceof Error ? e.message : String(e);
    return { error: code ?? (/not found/i.test(message) ? 'not_found' : 'capture_failed'), message };
  }
  await browser.storage.session.set({ [scanKey(key)]: result }).catch(() => {});
  return result;
}
