// Track or Report a scan: keep it in this browser, and send it to the server
// when Settings › Save to points at one.

import { isError } from '@/lib/runtime';
import { getSettings, serverBase } from '@/lib/saves/settings';
import { localSaves, type SavedItem, type SavedPayload } from '@/lib/saves/store';
import { upload } from '@/lib/saves/upload';
import type { ScanResult, SubmitResponse } from './messages';
import { cachedScan, cachedSnapshot } from './scan';

export async function submit(key: string, report: boolean): Promise<SubmitResponse> {
  const scan = await cachedScan(key);
  if (!scan) return { error: 'no_scan', message: 'Scan this page again first.' };

  let payload: SavedPayload;
  if (scan.kind === 'profile') {
    const gz = await cachedSnapshot(key);
    if (!gz) return { error: 'no_snapshot', message: 'Scan this profile again first.' };
    payload = { kind: 'profile', snapshotGzipBase64: gz };
  } else {
    payload =
      scan.kind === 'company'
        ? { kind: 'company', id: String(scan.facts.companyId ?? scan.slug), facts: scan.facts }
        : { kind: 'job', id: scan.id, facts: scan.facts, company: scan.company?.facts ?? null };
  }

  const saves = localSaves();
  const now = Date.now();
  const prev = await saves.get(key);
  const item: SavedItem = {
    key,
    ...describe(scan),
    score: scan.score.score,
    level: scan.score.level,
    savedAt: now,
    reportedAt: report ? now : (prev?.reportedAt ?? null),
    uploadedTo: [],
    payload,
  };
  await saves.put(item);

  const base = serverBase(await getSettings());
  if (!base) return { ok: true, reported: report, server: null };
  const res = await upload(base, item, report);
  if (isError(res)) return { ...res, savedLocally: true };
  await saves.markUploaded(key, base);
  return { ok: true, reported: res.reported, server: { score: res.score } };
}

function describe(r: ScanResult): Pick<SavedItem, 'kind' | 'url' | 'name' | 'detail'> {
  if (r.kind === 'profile') {
    const name = [r.facts.firstName, r.facts.lastName].filter(Boolean).join(' ') || r.slug;
    return { kind: 'profile', url: `https://www.linkedin.com/in/${encodeURIComponent(r.slug)}/`, name, detail: r.facts.headline };
  }
  if (r.kind === 'company') {
    return { kind: 'company', url: `https://www.linkedin.com/company/${encodeURIComponent(r.slug)}/`, name: r.facts.name ?? r.slug, detail: r.facts.industry };
  }
  return { kind: 'job', url: `https://www.linkedin.com/jobs/view/${encodeURIComponent(r.id)}/`, name: r.facts.title ?? `Job ${r.id}`, detail: r.facts.company.name };
}
