// Save a scan to the directory ("Track"), optionally reporting it. The server
// re-scores everything itself. For profiles it re-parses the raw snapshot; for
// companies and jobs it re-scores the facts we send (it can't fetch LinkedIn
// pages itself), after checking their shape.

import type { EntityRequest, EntityResponse, SnapshotResponse } from '@flr/core';
import { api } from '@/lib/api';
import { isError } from '@/lib/runtime';
import type { SubmitResponse } from './messages';
import { cachedScan, cachedSnapshot } from './scan';

export async function submit(key: string, report: boolean): Promise<SubmitResponse> {
  const scan = await cachedScan(key);
  if (!scan) return { error: 'no_scan', message: 'Scan this page again first.' };

  if (scan.kind === 'profile') {
    const gz = await cachedSnapshot(key);
    if (!gz) return { error: 'no_snapshot', message: 'Scan this profile again first.' };
    const bytes = Uint8Array.from(atob(gz), (c) => c.charCodeAt(0));
    const res = await api<SnapshotResponse>('POST', `/api/snapshots${report ? '?report=1' : ''}`, bytes);
    return isError(res) ? res : { ok: true, reported: res.reported, score: res.score.score };
  }

  const body: EntityRequest =
    scan.kind === 'company'
      ? { kind: 'company', id: String(scan.facts.companyId ?? scan.slug), facts: scan.facts, report }
      : { kind: 'job', id: scan.id, facts: scan.facts, company: scan.company?.facts ?? null, report };
  const res = await api<EntityResponse>('POST', '/api/entities', body);
  return isError(res) ? res : { ok: true, reported: res.reported, score: res.score.score };
}
