// Track, report, or withdraw a report on a scan: keep it in this browser, and
// send it to the server when Settings › Save to points at one.

import type { ReportRequest } from '@fpr/core/wire';
import { isError } from '@/lib/runtime';
import { getSettings, serverBase } from '@/lib/saves/settings';
import { localSaves, type LocalReport, type SavedItem, type SavedPayload } from '@/lib/saves/store';
import { ALREADY, sendReport, upload, withdrawReport } from '@/lib/saves/upload';
import type { ScanResult, SubmitResponse, WithdrawResult } from './messages';
import { cachedScan, cachedSnapshot } from './scan';

/** Save the scan; with `report`, also say something about it (it replaces any earlier report). */
export async function submit(key: string, report?: ReportRequest): Promise<SubmitResponse> {
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
  const newReport: LocalReport | null = report
    ? { stance: report.stance, reasons: report.reasons, confidence: report.stance === 'report' ? (report.confidence ?? 'suspected') : null, note: report.note?.trim() || null, at: now, sentTo: [] }
    : null;
  let item: SavedItem = {
    key,
    ...describe(scan),
    score: scan.score.score,
    level: scan.score.level,
    savedAt: now,
    report: newReport ?? prev?.report ?? null,
    uploadedTo: [],
    payload,
  };
  await saves.put(item);

  const base = serverBase(await getSettings());
  if (!base) return { ok: true, server: null };

  const saved = await upload(base, item);
  // Saved here a few minutes ago: the server has it, so a report can still go.
  if (isError(saved) && !ALREADY.has(saved.error)) return { ...saved, savedLocally: true };
  await saves.markUploaded(key, base);
  if (!isError(saved) && saved.targetId) await saves.setTargetId(key, saved.targetId);
  item = (await saves.get(key)) ?? item;

  let counts = null;
  if (item.report && !item.report.sentTo.includes(base)) {
    const res = await sendReport(base, item, item.report);
    if (isError(res)) return { ...res, savedLocally: true };
    await saves.markReportSent(key, base, item.report.at);
    counts = res.counts;
  }
  return { ok: true, server: { score: isError(saved) ? null : saved.score, counts } };
}

/** Take back what you said: here, and on the server saves go to if it has it. */
export async function withdraw(key: string): Promise<WithdrawResult> {
  const saves = localSaves();
  const item = await saves.get(key);
  if (!item?.report) return { error: 'not_reported', message: 'There is nothing to withdraw.' };
  const base = serverBase(await getSettings());
  let counts = null;
  if (base && item.report.sentTo.includes(base)) {
    const res = await withdrawReport(base, item);
    // Already gone on the server: fine.
    if (isError(res) && res.error !== 'not_reported') return res;
    if (!isError(res)) counts = res.counts;
  }
  await saves.setReport(key, null);
  // Servers it went to before Save to changed keep it; say where.
  const elsewhere = item.report.sentTo.filter((s) => s !== base);
  return { ok: true, counts, elsewhere };
}

function describe(r: ScanResult): Pick<SavedItem, 'kind' | 'targetId' | 'url' | 'name' | 'detail'> {
  if (r.kind === 'profile') {
    const name = [r.facts.firstName, r.facts.lastName].filter(Boolean).join(' ') || r.slug;
    return {
      kind: 'profile',
      targetId: r.facts.memberId ? String(r.facts.memberId) : null,
      url: `https://www.linkedin.com/in/${encodeURIComponent(r.slug)}/`,
      name,
      detail: r.facts.headline,
    };
  }
  if (r.kind === 'company') {
    return {
      kind: 'company',
      targetId: String(r.facts.companyId ?? r.slug),
      url: `https://www.linkedin.com/company/${encodeURIComponent(r.slug)}/`,
      name: r.facts.name ?? r.slug,
      detail: r.facts.industry,
    };
  }
  return { kind: 'job', targetId: r.id, url: `https://www.linkedin.com/jobs/view/${encodeURIComponent(r.id)}/`, name: r.facts.title ?? `Job ${r.id}`, detail: r.facts.company.name };
}
