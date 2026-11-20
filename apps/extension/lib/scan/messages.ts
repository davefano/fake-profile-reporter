// Messages for the scam-check feature: the panel asks the background to scan
// the active tab and to save or report what it found.

import type { CompanyFacts, FactChange, JobFacts, LinkedInTarget } from '@flr/core/linkedin';
import type { Score } from '@flr/core/scam';
import type { LeaderboardResponse } from '@flr/core';
import type { ProfileResult } from '@/lib/linkedin/protocol';
import { send, type ErrorResponse } from '@/lib/runtime';

/** Local history the panel shows next to any scan. */
interface History {
  /** Changes since the last time this browser checked it. */
  changes: FactChange[];
  /** When this browser last checked it before now, if ever. */
  previousCheckAt: number | null;
  /** True when served from the short-lived cache instead of a fresh read. */
  cached: boolean;
}

export interface ProfileScan extends Omit<ProfileResult, 'snapshotGzipBase64'>, History {
  kind: 'profile';
  score: Score;
}

export interface CompanyScan extends History {
  kind: 'company';
  slug: string;
  facts: CompanyFacts;
  score: Score;
  capturedAt: number;
}

export interface JobScan extends History {
  kind: 'job';
  id: string;
  facts: JobFacts;
  score: Score;
  company: { facts: CompanyFacts; score: Score } | null;
  capturedAt: number;
  errors: Record<string, string>;
}

/** What the panel shows for the active tab. */
export type ScanResult = ProfileScan | CompanyScan | JobScan;

/** Stable key for "the thing this tab shows", to notice navigation. */
export const targetKey = (t: LinkedInTarget | null) => (t ? `${t.kind}:${t.kind === 'job' ? t.id : t.slug}` : null);
export const scanKey = (r: ScanResult) => (r.kind === 'job' ? `job:${r.id}` : `${r.kind}:${r.slug}`);

export type ScanResponse = ScanResult | ErrorResponse;
export type SubmitResponse = { ok: true; reported: boolean; score?: number } | ErrorResponse;

export interface AppMessages {
  /** Scan the active tab's profile, company, or job. */
  FLR_SCAN: { req: { type: 'FLR_SCAN'; force?: boolean }; res: ScanResponse };
  /** Save to the directory, optionally reporting it. `key` is scanKey(). */
  FLR_SUBMIT: { req: { type: 'FLR_SUBMIT'; key: string; report: boolean }; res: SubmitResponse };
  FLR_LEADERBOARD: { req: { type: 'FLR_LEADERBOARD' }; res: LeaderboardResponse | ErrorResponse };
}

export const sendMessage = <K extends keyof AppMessages>(msg: AppMessages[K]['req']) => send<AppMessages, K>(msg);
