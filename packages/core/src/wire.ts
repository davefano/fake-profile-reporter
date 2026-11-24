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
