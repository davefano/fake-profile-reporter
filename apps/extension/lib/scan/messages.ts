// Messages for the scam-check feature: the panel asks the background to scan
// the active tab and to save or report what it found.

import type { CompanyFacts, FactChange, JobFacts, LinkedInTarget, ProfilePart } from '@fpr/core/linkedin';
import type { Score } from '@fpr/core/scam';
import type { ReportCounts } from '@fpr/core/scam';
import type { LeaderboardResponse, RemovalRequest, RemovalResponse, ReportRequest, VerifyResponse } from '@fpr/core/wire';
import type { ApiError } from '@/lib/api';
import type { ProfileResult } from '@/lib/linkedin/protocol';
import { send, type ErrorResponse } from '@/lib/runtime';
import type { UploadResult } from '@/lib/saves/upload';

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
  /** Parts this read couldn't load, shown from the previous check instead. */
  carried: ProfilePart[];
}

export interface CompanyScan extends History {
  kind: 'company';
  slug: string;
  facts: CompanyFacts;
  score: Score;
  capturedAt: number;
  errors: Record<string, string>;
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

/** Stable key for "the thing this tab shows", to notice navigation and to cache scans. */
export const targetKey = (t: LinkedInTarget) => `${t.kind}:${t.kind === 'job' ? t.id : t.slug}`;
export const scanKey = (r: ScanResult) => targetKey(r.kind === 'job' ? { kind: 'job', id: r.id } : { kind: r.kind, slug: r.slug });

export type ScanResponse = ScanResult | ErrorResponse;
/**
 * Saved in this browser, and on the server when one is set. `server.score` is
 * the server's own score (it can differ from the panel's: see scoreProfile's
 * mutual connections; null when it already had this save), and `counts` its
 * report counts after this report. `unsent`: servers that still don't match
 * what you said (each is updated the next time it's sent to). An error after
 * the local save says so in `savedLocally`, and names the `server` it came
 * from; `verification_required` carries the bot check's `verifyUrl`.
 */
export type SubmitResponse =
  | { ok: true; server: { score: number | null; counts: ReportCounts | null } | null; unsent: string[] }
  | (ApiError & { savedLocally?: boolean; server?: string | null; unsent?: string[] });

/** Withdrawn here, and wherever it was sent. `unsent`: servers that didn't get the withdrawal yet. */
export type WithdrawResult = { ok: true; counts: ReportCounts | null; unsent: string[] } | ErrorResponse;

/** The bot check done in a tab: whether it passed, and the send that followed when a key was given. */
export interface VerifyWaitResult {
  verified: boolean;
  sync: SubmitResponse | null;
}

export interface AppMessages {
  /** Scan the active tab's profile, company, or job. */
  FPR_SCAN: { req: { type: 'FPR_SCAN'; force?: boolean }; res: ScanResponse };
  /** Save it (see Settings › Save to), with a report, vouch or impersonation flag if given. `key` is scanKey(). */
  FPR_SUBMIT: { req: { type: 'FPR_SUBMIT'; key: string; report?: ReportRequest }; res: SubmitResponse };
  /** Take back this browser's report on it. */
  FPR_WITHDRAW: { req: { type: 'FPR_WITHDRAW'; key: string }; res: WithdrawResult };
  /** Send what you said about it wherever it hasn't gone yet: "Send now", and the retry after the bot check. */
  FPR_SYNC: { req: { type: 'FPR_SYNC'; key: string }; res: SubmitResponse };
  /** The bot check's token (from the framed /verify page) for `server`, which must be the current one. */
  FPR_VERIFY: { req: { type: 'FPR_VERIFY'; server: string; token: string; challenge: string }; res: VerifyResponse | ErrorResponse };
  /** The bot check runs in a tab: wait until `server` says it passed, then send `key` if given. */
  FPR_VERIFY_WAIT: { req: { type: 'FPR_VERIFY_WAIT'; server: string; key?: string }; res: VerifyWaitResult | ErrorResponse };
  /** Ask the server Save to points at to remove this profile (the panel checked the code first). */
  FPR_REMOVAL: { req: { type: 'FPR_REMOVAL' } & RemovalRequest; res: RemovalResponse | ApiError };
  /** Reported profiles on the server saves go to. */
  FPR_LEADERBOARD: { req: { type: 'FPR_LEADERBOARD' }; res: LeaderboardResponse | ErrorResponse };
  /** Send saves the server doesn't have yet. */
  FPR_UPLOAD: { req: { type: 'FPR_UPLOAD' }; res: UploadResult | ErrorResponse };
}

export const sendMessage = <K extends keyof AppMessages>(msg: AppMessages[K]['req']) => send<AppMessages, K>(msg);
