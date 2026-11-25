// Sending saves and reports to servers. The server re-scores everything
// itself: for profiles it re-parses the raw snapshot; for companies and jobs it
// re-scores the facts (it can't fetch LinkedIn pages), after checking their
// shape. A report goes separately, once the thing it's about is saved there.
//
// Reports are reconciled per item: every server in `heldBy` is brought
// to what you last said, a PUT for a report or a DELETE for a withdrawal, one
// server at a time under one serialized writer per item. What you said is
// written here before any request goes out.

import type { ReportCounts } from '@fpr/core/scam';
import { CHALLENGE_MS, type EntityResponse, type ReportRequest, type ReportResponse, type SnapshotResponse, type VerifyRequest, type VerifyResponse, type VerifyStatusResponse, type WithdrawResponse } from '@fpr/core/wire';
import { api, type ApiError } from '@/lib/api';
import { isError } from '@/lib/runtime';
import { reporterKeyFor } from './reporter';
import { localSaves, needsSync, type LocalReport, type SavedItem } from './store';

/** The server already has it from this browser recently: count it as sent. */
export const ALREADY = new Set(['captured_recently', 'observed_recently']);
/** No point trying the rest. */
const STOP = new Set(['network_error', 'daily_limit_reached']);
/** A DELETE that finds nothing there is done. */
const GONE = new Set(['not_reported', 'removed']);

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier serial() for `key` has finished: the one writer per item. */
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

/** Save the item itself. `targetId` is the server's ID for it (the member ID, for profiles). */
export async function upload(base: string, item: SavedItem): Promise<{ score: number; targetId: string | null } | ApiError> {
  const p = item.payload;
  if (p.kind === 'profile') {
    const res = await api<SnapshotResponse>(base, 'POST', '/api/snapshots', Uint8Array.from(atob(p.snapshotGzipBase64), (c) => c.charCodeAt(0)));
    return isError(res) ? res : { score: res.score.score, targetId: String(res.memberId) };
  }
  const res = await api<EntityResponse>(base, 'POST', '/api/entities', p);
  return isError(res) ? res : { score: res.score.score, targetId: res.id };
}

const reportPath = (item: SavedItem) => `/api/reports/${item.kind}/${encodeURIComponent(item.targetId!)}`;

function sendReport(base: string, item: SavedItem, report: LocalReport, key: string) {
  const body: ReportRequest = { stance: report.stance, reasons: report.reasons, ...(report.confidence && { confidence: report.confidence }), ...(report.note && { note: report.note }) };
  return api<ReportResponse>(base, 'PUT', reportPath(item), body, key);
}

/** Save the item on `base` unless this version is there already; the item as stored after. */
export async function saveOn(base: string, item: SavedItem): Promise<SavedItem | ApiError> {
  if (item.uploadedTo.includes(base)) return item;
  const res = await upload(base, item);
  if (isError(res) && !ALREADY.has(res.error)) return res;
  return (await localSaves().markUploaded(item.key, base, isError(res) ? null : res.targetId)) ?? item;
}

/** What one server said: its counts after the change, or why it didn't take it. */
export type ServerResult = { ok: true; counts: ReportCounts | null } | ApiError;
const done = (counts: ReportCounts | null = null): ServerResult => ({ ok: true, counts });

/** Bring one server to what you last said about `key`. Call under serial(key). */
async function syncServer(base: string, key: string): Promise<ServerResult> {
  const saves = localSaves();
  let item = await saves.get(key);
  if (!item || !needsSync(item, base)) return done();
  const report = item.report;

  if (!report) {
    const res = item.targetId ? await api<WithdrawResponse>(base, 'DELETE', reportPath(item), undefined, await reporterKeyFor(base)) : null;
    if (res && isError(res) && !GONE.has(res.error)) return res;
    await saves.update(key, (i) => {
      if (i.report || !(base in i.heldBy)) return i;
      const { [base]: _gone, ...rest } = i.heldBy;
      return { ...i, heldBy: rest };
    });
    return done(res && !isError(res) ? res.counts : null);
  }

  // A server that never had it needs the save first; one that held it has it.
  if (!(base in item.heldBy)) {
    const saved = await saveOn(base, item);
    if (isError(saved)) return saved;
    item = saved;
  }
  if (!item.targetId) return { error: 'no_target', message: 'Scan this page again first.' };
  // It may hold it from here on, whatever the answer: join first.
  if (!(base in item.heldBy)) item = (await saves.update(key, (i) => ({ ...i, heldBy: { ...i.heldBy, [base]: null } }))) ?? item;
  const res = await sendReport(base, item, report, await reporterKeyFor(base));
  if (isError(res)) return res;
  // An import in the panel may have written a newer version meanwhile: confirm only the one sent.
  await saves.update(key, (i) => (i.report?.at === report.at ? { ...i, heldBy: { ...i.heldBy, [base]: report.at } } : i));
  return done(res.counts);
}

export interface SyncResult {
  /** What `current` said, or null when nothing needed sending there. */
  current: ServerResult | null;
  /** Servers that still don't match what you last said. */
  unsent: string[];
}

/**
 * Reconcile `key` on `current` (the server Save to points at, if any) and on
 * every server in its heldBy, one at a time. Call under serial(key).
 */
export async function reconcile(key: string, current: string | null): Promise<SyncResult> {
  const saves = localSaves();
  const item = await saves.get(key);
  if (!item) return { current: null, unsent: [] };
  const servers = [...new Set([...(current ? [current] : []), ...Object.keys(item.heldBy)])];
  let here: ServerResult | null = null;
  for (const s of servers) {
    const before = await saves.get(key);
    if (!before || !needsSync(before, s)) continue;
    const res = await syncServer(s, key);
    if (s === current) here = res;
  }
  const after = await saves.get(key);
  return { current: here, unsent: after ? servers.filter((s) => needsSync(after, s)) : [] };
}

/** reconcile() under the item's writer. */
export const syncItem = (key: string, current: string | null) => serial(key, () => reconcile(key, current));

/** Withdraw `key`: a tombstone here first, then a DELETE to every server that may hold it. */
export function withdrawItem(key: string, current: string | null): Promise<{ ok: true; counts: ReportCounts | null; unsent: string[] } | ApiError> {
  return serial(key, async () => {
    const item = await localSaves().update(key, (i) => (i.report ? { ...i, report: null, withdrawnAt: Date.now() } : i));
    if (!item || item.report) return { error: 'not_reported', message: 'There is nothing to withdraw.' };
    const res = await reconcile(key, current);
    return { ok: true, counts: res.current && !isError(res.current) ? res.current.counts : null, unsent: res.unsent };
  });
}

export interface UploadResult {
  uploaded: number;
  failed: number;
  /** Why the last one failed. */
  error: string | null;
  /** Reports held back for the bot check: pass it at `verifyUrl`, then upload again. */
  waiting: number;
  verifyUrl: string | null;
}

/**
 * Send every save, report and withdrawal the server doesn't have yet, one at
 * a time. The first report that needs the bot check holds back the reports,
 * not the saves: the check is asked for once, and nothing counts as failed.
 */
export async function uploadPending(base: string): Promise<UploadResult> {
  const saves = localSaves();
  const result: UploadResult = { uploaded: 0, failed: 0, error: null, waiting: 0, verifyUrl: null };
  const fail = (res: ApiError) => {
    result.failed++;
    result.error = res.message ?? res.error;
    return STOP.has(res.error);
  };
  for (const { key } of await saves.list()) {
    const stop = await serial(key, async () => {
      const item = await saves.get(key);
      if (!item) return false;
      const needsReport = needsSync(item, base);
      if (item.uploadedTo.includes(base) && !needsReport) return false;
      const saved = await saveOn(base, item);
      if (isError(saved)) return fail(saved);
      if (needsReport && result.verifyUrl) {
        result.waiting++;
        return false;
      }
      const res = needsReport ? await syncServer(base, key) : done();
      if (isError(res) && res.error === 'verification_required' && res.verifyUrl) {
        result.verifyUrl = res.verifyUrl;
        result.waiting++;
        return false;
      }
      if (isError(res)) return fail(res);
      result.uploaded++;
      return false;
    });
    if (stop) break;
  }
  return result;
}

// --- the bot check -----------------------------------------------------------

/** Send the check's token for this browser's key on `base` (POST /api/verify). */
export async function verifyToken(base: string, token: string, challenge: string): Promise<VerifyResponse | ApiError> {
  const body: VerifyRequest = { token, challenge };
  return api<VerifyResponse>(base, 'POST', '/api/verify', body, await reporterKeyFor(base));
}

/**
 * Poll GET /api/verify/status until the check done in a tab has passed for
 * this browser's key on `base`, or the challenge has expired.
 */
export async function waitForVerified(base: string, every = 3_000, within = CHALLENGE_MS): Promise<boolean> {
  const key = await reporterKeyFor(base);
  const until = Date.now() + within;
  while (Date.now() < until) {
    const res = await api<VerifyStatusResponse>(base, 'GET', '/api/verify/status', undefined, key);
    if (!isError(res) && res.verified) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}
