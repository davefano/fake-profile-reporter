// Request and response shapes for the directory API, shared by the extension
// (client) and the worker (server). Keep them stable: other directory servers
// implement the same routes.

import type { CompanyFacts } from './linkedin/company/facts';
import type { JobFacts } from './linkedin/job/facts';
import type { ProfileFacts } from './linkedin/profile/facts';
import type { FactChange } from './linkedin/diff';
import type { ReportConfidence, ReportCounts, ReportKind, ReportStance } from './scam/reports';
import type { RiskLevel, Score } from './scam/signals';

export type ApiError = { error: string };

/**
 * HTTP 410 error codes. `upgrade_required`: a build up to 2026.11.23.1 sent a
 * report the old way (`?report=1` or `report: true`); nothing was stored.
 * `removed`: the profile was removed at its owner's request.
 */
export type GoneError = 'upgrade_required' | 'removed';

/**
 * A Score as read back from storage (entity rows, snapshot `signals_json`,
 * report `score_json`, a scan cache): it may come from older rules, so its
 * version is any number and its signals may lack the newer optional fields.
 * Show its stored level; never re-derive it.
 */
export type StoredScore = Omit<Score, 'version'> & { version: number };

/** POST /api/snapshots — body is a RawSnapshot, JSON or gzipped JSON. */
export interface SnapshotResponse {
  ok: true;
  memberId: number;
  slug: string | null;
  score: Score;
  changes: FactChange[];
}

/** POST /api/entities */
export type EntityRequest =
  | { kind: 'company'; id: string; facts: CompanyFacts }
  | { kind: 'job'; id: string; facts: JobFacts; company: CompanyFacts | null };

export interface EntityResponse {
  ok: true;
  kind: 'company' | 'job';
  id: string;
  score: Score;
}

/**
 * PUT /api/reports/:kind/:id with header x-reporter-key: create or replace
 * this reporter's report on a saved profile (id = member ID), company or job.
 * DELETE on the same path withdraws it. The note is stored, never shown.
 */
export interface ReportRequest {
  stance: ReportStance;
  reasons: string[];
  confidence?: ReportConfidence;
  note?: string;
}

export interface ReportResponse {
  ok: true;
  kind: ReportKind;
  id: string;
  stance: ReportStance;
  reasons: string[];
  confidence: ReportConfidence | null;
  createdAt: number;
  updatedAt: number;
  counts: ReportCounts;
}

/**
 * HTTP 403 from a gated route (PUT /api/reports, removal requests) when this
 * reporter key hasn't passed the bot check on this server. Frame `verifyUrl`
 * with `&parentOrigin=<extension origin>` added (or open it with `&mode=tab`),
 * then send the token to POST /api/verify and retry. Other codes: 403
 * `verify_failed` from POST /api/verify, 503 `verify_unconfigured` when the
 * server is set up for the check but missing a key.
 */
/** How long a bot-check challenge ID stays valid on the server. */
export const CHALLENGE_MS = 10 * 60_000;

export interface VerificationRequired {
  error: 'verification_required';
  /** https://<verify host>/verify?challenge=<id>. Carries no key material. */
  verifyUrl: string;
}

/**
 * Posted by the /verify page to `parentOrigin` (never `*`) once the widget
 * passes. Accept it only from the framed page's origin and iframe.
 */
export interface VerifyMessage {
  type: 'fpr-verify';
  challenge: string;
  token: string;
}

/**
 * POST /api/verify, JSON only. With header x-reporter-key, the challenge must
 * have been issued to that key. Without it (tab mode), the challenge's own
 * reporter is verified.
 */
export interface VerifyRequest {
  token: string;
  challenge: string;
}

export interface VerifyResponse {
  ok: true;
  verifiedUntil: number;
}

/** GET /api/verify/status with header x-reporter-key (tab mode polls it). */
export interface VerifyStatusResponse {
  verified: boolean;
  verifiedUntil: number | null;
}

/** DELETE /api/reports/:kind/:id: withdrawn, and the target's counts now. */
export interface WithdrawResponse {
  ok: true;
  counts: ReportCounts;
}

/** GET /api/entities/:kind/:id. A job keeps the company facts its score used. */
interface EntityRecordBase {
  id: string;
  name: string | null;
  url: string;
  score: StoredScore;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  counts: ReportCounts;
}

export type EntityRecord =
  | (EntityRecordBase & { kind: 'company'; facts: CompanyFacts })
  | (EntityRecordBase & { kind: 'job'; facts: JobFacts; company: CompanyFacts | null });

/** GET /api/accounts/:memberId and GET /api/accounts?slug=… */
export interface AccountResponse {
  memberId: number;
  profileId: string | null;
  slug: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  industry: string | null;
  joined: ProfileFacts['joined'];
  connections: ProfileFacts['connections'];
  followers: number | null;
  postCount: number | null;
  lastActivityAt: number | null;
  verified: boolean | null;
  score: number;
  level: RiskLevel;
  scoreVersion: number;
  firstCapturedAt: number;
  lastCapturedAt: number;
  snapshotCount: number;
  counts: ReportCounts;
  slugs: Array<{ slug: string; firstSeen: number; lastSeen: number }>;
  snapshots: Array<{ id: number; capturedAt: number; score: number; changes: FactChange[] }>;
}

/**
 * GET /api/leaderboard: profiles with at least one active "looks suspicious"
 * report, ranked by those reports, then score.
 */
export interface LeaderboardRow {
  memberId: number;
  url: string;
  slug: string | null;
  name: string;
  headline: string | null;
  reports: number;
  impersonated: number;
  vouches: number;
  score: number;
  level: RiskLevel;
  lastReported: number;
}

export interface LeaderboardResponse {
  stats: { reports: number; accounts: number };
  rows: LeaderboardRow[];
}

/**
 * POST /api/removals with header x-reporter-key: the person asks for their
 * own profile to be removed. They placed `code` (6 to 64 of A-Z a-z 0-9 _ -)
 * in their headline or About first; the maintainer reads the profile to check
 * it, and nothing changes until they approve. Needs the bot check where the
 * server has one. Answers 201 RemovalResponse, or RemovalError.
 */
export interface RemovalRequest {
  memberId: number;
  code: string;
  /** How to reach the person, at most 200 characters. Cleared once decided. */
  contact?: string;
}

export interface RemovalResponse {
  ok: true;
}

/**
 * Error codes from POST /api/removals besides the usual ones
 * (`verification_required`, `reporter_key_required`, `bad_request`):
 * 404 `not_found` (the server doesn't hold the profile), 409 `already_pending`
 * (this key or IP already has a request pending for it), 429 `recently_denied`
 * (denied on the merits in the last 90 days, or this key's code wasn't found),
 * 429 `daily_limit_reached`, 503 `queue_full` (too many requests pending).
 */
export type RemovalError = 'not_found' | 'already_pending' | 'recently_denied' | 'daily_limit_reached' | 'queue_full';

/** A removal request's state. `approved_r2_pending`: D1 rows deleted, archived snapshots not yet. */
export type RemovalStatus = 'pending' | 'approved_r2_pending' | 'approved' | 'denied_code' | 'denied_merits' | 'restored';

/**
 * GET /api/admin/removals (header authorization: Bearer <ADMIN_TOKEN>):
 * pending requests grouped by member, with what the server itself stores for
 * that member (never anything the request supplied besides code and contact).
 */
export interface AdminRemovalsResponse {
  members: Array<{
    memberId: number;
    /** Slugs this server has seen the member under, newest first. */
    slugs: string[];
    /** The member's score now, from its current facts; null if none are stored. */
    score: StoredScore | null;
    counts: ReportCounts;
    requests: Array<{ id: number; code: string; contact: string | null; createdAt: number }>;
  }>;
  /** Approved requests whose archived snapshots aren't all deleted yet: approve them again. */
  unfinished: Array<{ requestId: number; memberId: number }>;
}

/** POST /api/admin/removals/:id/approve: the member ID of the profile the maintainer read, typed back. */
export interface AdminApproveRequest {
  memberId: number;
}

/** POST /api/admin/removals/:id/deny. `code`: the code wasn't on the profile. `merits`: blocks the profile for 90 days. */
export interface AdminDenyRequest {
  reason: 'code' | 'merits';
}

/** Approve (200, or 202 while `approved_r2_pending`), deny and restore (POST /api/admin/removed/:memberId/restore). */
export interface AdminDecisionResponse {
  ok: true;
  status: RemovalStatus;
}
