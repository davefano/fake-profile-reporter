// Save, report, or withdraw a report on a scan: keep it in this browser, and
// send it to the server Settings › Save to points at, and to every server
// that holds an earlier version of the report (lib/saves/upload.ts).

import type { ReportRequest, VerifyResponse } from '@fpr/core/wire';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { getSettings, serverBase } from '@/lib/saves/settings';
import { localSaves, type LocalReport, type SavedItem, type SavedPayload } from '@/lib/saves/store';
import { ALREADY, reconcile, saveOn, serial, upload, verifyToken, waitForVerified, withdrawItem, type SyncResult } from '@/lib/saves/upload';
import type { ScanResult, SubmitResponse, VerifyWaitResult, WithdrawResult } from './messages';
import { cachedScan, cachedSnapshot } from './scan';

const currentServer = async () => serverBase(await getSettings());

/** A SyncResult as the panel gets it. `score` is the server's own, when this save went there. */
function answer(base: string | null, res: SyncResult, score: number | null = null): SubmitResponse {
  if (res.current && isError(res.current)) return { ...res.current, savedLocally: true, server: base, unsent: res.unsent };
  return { ok: true, server: base ? { score, counts: res.current?.counts ?? null } : null, unsent: res.unsent };
}

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
  const base = await currentServer();

  return serial(key, async () => {
    const saves = localSaves();
    const now = Date.now();
    const prev = await saves.get(key);
    const said: LocalReport | null = report
      ? { stance: report.stance, reasons: report.reasons, confidence: report.stance === 'report' ? (report.confidence ?? 'suspected') : null, note: report.note?.trim() || null, at: now }
      : null;
    const described = describe(scan);
    // What you said goes in first, before any request.
    const item: SavedItem = {
      key,
      ...described,
      targetId: described.targetId ?? prev?.targetId ?? null,
      score: scan.score.score,
      level: scan.score.level,
      savedAt: now,
      report: said ?? prev?.report ?? null,
      withdrawnAt: said ? null : (prev?.withdrawnAt ?? null),
      heldBy: prev?.heldBy ?? {},
      uploadedTo: [],
      payload,
    };
    await saves.put(item);
    if (!base) return answer(null, await reconcile(key, null));

    // This version of the save goes to the current server, report or not.
    const saved = await upload(base, item);
    // Saved here a few minutes ago: the server has it, so a report can still go.
    if (isError(saved) && !ALREADY.has(saved.error)) {
      const others = await reconcile(key, null);
      return { ...saved, savedLocally: true, server: base, unsent: [...new Set([base, ...others.unsent])] };
    }
    await saves.markUploaded(key, base, isError(saved) ? null : saved.targetId);
    return answer(base, await reconcile(key, base), isError(saved) ? null : saved.score);
  });
}

/** Send what you said about `key` wherever it hasn't gone yet ("Send now", and the retry after the bot check). */
export async function sync(key: string): Promise<SubmitResponse> {
  const base = await currentServer();
  return serial(key, async () => {
    const item = await localSaves().get(key);
    if (!item) return { error: 'not_saved', message: 'Save this page again first.' };
    const saved = base ? await saveOn(base, item) : item;
    if (isError(saved)) return { ...saved, savedLocally: true, server: base, unsent: [base!] };
    return answer(base, await reconcile(key, base));
  });
}

/** Take back what you said: here first, then on every server that may hold it. */
export async function withdraw(key: string): Promise<WithdrawResult> {
  return withdrawItem(key, await currentServer());
}

/** The bot check only ever goes to the server Save to points at. */
async function checkServer(server: string): Promise<ErrorResponse | null> {
  return server === (await currentServer()) ? null : { error: 'server_changed', message: 'Save to changed. Try again.' };
}

/** Hand the bot check's token to the server. */
export async function verify(server: string, token: string, challenge: string): Promise<VerifyResponse | ErrorResponse> {
  return (await checkServer(server)) ?? verifyToken(server, token, challenge);
}

/** The check runs in a tab (Safari): wait for the server to say it passed, then send `key` if given. */
export async function verifyWait(server: string, key?: string): Promise<VerifyWaitResult | ErrorResponse> {
  const wrong = await checkServer(server);
  if (wrong) return wrong;
  const verified = await waitForVerified(server);
  return { verified, sync: verified && key ? await sync(key) : null };
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
