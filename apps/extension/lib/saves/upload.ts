// Sending saves to a server. The server re-scores everything itself: for
// profiles it re-parses the raw snapshot; for companies and jobs it re-scores
// the facts (it can't fetch LinkedIn pages), after checking their shape.

import type { EntityResponse, SnapshotResponse } from '@flr/core/wire';
import { api } from '@/lib/api';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { localSaves, pendingFor, type SavedItem } from './store';

export async function upload(base: string, item: SavedItem, report: boolean): Promise<{ score: number; reported: boolean } | ErrorResponse> {
  const p = item.payload;
  const res =
    p.kind === 'profile'
      ? await api<SnapshotResponse>(base, 'POST', `/api/snapshots${report ? '?report=1' : ''}`, Uint8Array.from(atob(p.snapshotGzipBase64), (c) => c.charCodeAt(0)))
      : await api<EntityResponse>(base, 'POST', '/api/entities', { ...p, report });
  return isError(res) ? res : { score: res.score.score, reported: res.reported };
}

/** The server already has it from this browser recently: count it as sent. */
const ALREADY = new Set(['captured_recently', 'observed_recently', 'already_reported_recently']);
/** No point trying the rest. */
const STOP = new Set(['network_error', 'daily_limit_reached']);

export interface UploadResult {
  uploaded: number;
  failed: number;
  /** Why the last one failed. */
  error: string | null;
}

/** Send every save the server doesn't have yet, one at a time, reports as reports. */
export async function uploadPending(base: string): Promise<UploadResult> {
  const saves = localSaves();
  const result: UploadResult = { uploaded: 0, failed: 0, error: null };
  for (const item of pendingFor(await saves.list(), base)) {
    const res = await upload(base, item, item.reportedAt !== null);
    if (!isError(res) || ALREADY.has(res.error)) {
      await saves.markUploaded(item.key, base);
      result.uploaded++;
      continue;
    }
    result.failed++;
    result.error = res.message ?? res.error;
    if (STOP.has(res.error)) break;
  }
  return result;
}
