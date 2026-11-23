// Sending saves and reports to a server. The server re-scores everything
// itself: for profiles it re-parses the raw snapshot; for companies and jobs it
// re-scores the facts (it can't fetch LinkedIn pages), after checking their
// shape. A report goes separately, once the thing it's about is saved there.

import type { EntityResponse, ReportRequest, ReportResponse, SnapshotResponse, WithdrawResponse } from '@fpr/core/wire';
import { api } from '@/lib/api';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { reporterKey } from './reporter';
import { localSaves, type LocalReport, type SavedItem } from './store';

/** The server already has it from this browser recently: count it as sent. */
export const ALREADY = new Set(['captured_recently', 'observed_recently']);
/** No point trying the rest. */
const STOP = new Set(['network_error', 'daily_limit_reached']);

/** Save the item itself. `targetId` is the server's ID for it (the member ID, for profiles). */
export async function upload(base: string, item: SavedItem): Promise<{ score: number; targetId: string | null } | ErrorResponse> {
  const p = item.payload;
  if (p.kind === 'profile') {
    const res = await api<SnapshotResponse>(base, 'POST', '/api/snapshots', Uint8Array.from(atob(p.snapshotGzipBase64), (c) => c.charCodeAt(0)));
    return isError(res) ? res : { score: res.score.score, targetId: String(res.memberId) };
  }
  const res = await api<EntityResponse>(base, 'POST', '/api/entities', p);
  return isError(res) ? res : { score: res.score.score, targetId: res.id };
}

const reportPath = (item: SavedItem) => `/api/reports/${item.kind}/${encodeURIComponent(item.targetId!)}`;

export async function sendReport(base: string, item: SavedItem, report: LocalReport): Promise<ReportResponse | ErrorResponse> {
  if (!item.targetId) return { error: 'no_target', message: 'Scan this page again first.' };
  const body: ReportRequest = { stance: report.stance, reasons: report.reasons, ...(report.confidence && { confidence: report.confidence }), ...(report.note && { note: report.note }) };
  return api<ReportResponse>(base, 'PUT', reportPath(item), body, await reporterKey());
}

export async function withdrawReport(base: string, item: SavedItem): Promise<WithdrawResponse | ErrorResponse> {
  if (!item.targetId) return { error: 'not_reported' };
  return api<WithdrawResponse>(base, 'DELETE', reportPath(item), undefined, await reporterKey());
}

export interface UploadResult {
  uploaded: number;
  failed: number;
  /** Why the last one failed. */
  error: string | null;
}

/** Send every save and report the server doesn't have yet, one at a time. */
export async function uploadPending(base: string): Promise<UploadResult> {
  const saves = localSaves();
  const result: UploadResult = { uploaded: 0, failed: 0, error: null };
  const fail = (res: ErrorResponse) => {
    result.failed++;
    result.error = res.message ?? res.error;
    return STOP.has(res.error);
  };
  for (let item of await saves.list()) {
    const needsSave = !item.uploadedTo.includes(base);
    const needsReport = !!item.report && !item.report.sentTo.includes(base);
    if (!needsSave && !needsReport) continue;
    if (needsSave) {
      const res = await upload(base, item);
      if (isError(res) && !ALREADY.has(res.error)) {
        if (fail(res)) break;
        continue;
      }
      await saves.markUploaded(item.key, base);
      if (!isError(res) && res.targetId) await saves.setTargetId(item.key, res.targetId);
      item = (await saves.get(item.key)) ?? item;
    }
    if (item.report && needsReport) {
      const res = await sendReport(base, item, item.report);
      if (isError(res)) {
        if (fail(res)) break;
        continue;
      }
      await saves.markReportSent(item.key, base, item.report.at);
    }
    result.uploaded++;
  }
  return result;
}
