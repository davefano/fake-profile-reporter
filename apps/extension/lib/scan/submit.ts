// Save a scan to the directory ("Track"), optionally reporting it.

import type { ProfileFacts } from '@flr/core/linkedin';
import type { ProfileObservation } from '@flr/core';
import { api } from '@/lib/api';
import { activeLinkedInTab, linkedin } from '@/lib/linkedin/client';
import { isError, type ProfileScan, type SubmitResponse } from '@/lib/messages';
import { cachedScan } from './scan';

export async function submit(key: string, report: boolean): Promise<SubmitResponse> {
  const cached = await cachedScan(key);
  if (!cached) return { error: 'no_scan', message: 'Scan this page again first.' };
  if (cached.kind === 'profile') return submitProfile(cached, report);

  // Companies and jobs: the server re-scores from the facts; it doesn't trust ours.
  const body =
    cached.kind === 'company'
      ? { kind: 'company', id: String(cached.facts.companyId ?? cached.slug), url: `https://www.linkedin.com/company/${cached.slug}/`, facts: cached.facts, report }
      : { kind: 'job', id: cached.id, url: `https://www.linkedin.com/jobs/view/${cached.id}/`, facts: cached.facts, company: cached.company?.facts ?? null, report };
  const res = await api('POST', '/api/entities', body);
  if (isError(res)) return res;
  const err = res.data?.error;
  if (res.status >= 400 && !(err === 'observed_recently' && report)) return { error: String(err ?? `HTTP ${res.status}`) };
  return { ok: true, reported: report, score: res.data?.score?.score };
}

async function submitProfile(cached: ProfileScan, report: boolean): Promise<SubmitResponse> {
  const tab = await activeLinkedInTab();
  if (tab?.target?.kind !== 'profile' || tab.target.slug !== cached.slug) {
    return { error: 'tab_changed', message: 'The active tab is showing a different profile now.' };
  }
  let bytes: Uint8Array;
  try {
    bytes = await linkedin.profileSnapshot(tab.tabId, cached.slug);
  } catch (e) {
    return { error: 'snapshot_failed', message: String(e) };
  }
  const saved = await api('POST', '/api/snapshots', bytes);
  if (isError(saved)) return saved;
  // Saved within the cooldown already (e.g. Track, then Report): that's fine.
  if (saved.status >= 400 && saved.data?.error !== 'captured_recently') return { error: String(saved.data?.error ?? `HTTP ${saved.status}`) };

  if (report) {
    const res = await api('POST', '/api/report', { url: `https://www.linkedin.com/in/${cached.slug}/`, profile: observation(cached.facts) });
    if (isError(res)) return res;
    if (res.status >= 400) return { error: String(res.data?.error ?? `HTTP ${res.status}`) };
  }
  return { ok: true, reported: report, score: saved.data?.score?.score };
}

/** The leaderboard's older report format, filled from profile facts. */
function observation(f: ProfileFacts): ProfileObservation {
  return {
    name: [f.firstName, f.lastName].filter(Boolean).join(' '),
    headline: f.headline ?? undefined,
    about: f.summary ?? undefined,
    photoUrl: f.photoUrl ?? undefined,
    hasPhoto: f.photo?.present ?? false,
    connections: f.connections?.count ?? null,
    connectionsText: f.connections ? `${f.connections.count}${f.connections.capped ? '+' : ''}` : null,
    followers: f.followers,
    endorsements: null,
    experienceCount: f.positions.length,
    accountAgeDays: f.joined ? Math.floor((Date.now() - f.joined.at) / 86_400_000) : null,
  };
}
