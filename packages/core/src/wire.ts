// Request and response shapes for the directory API, shared by the extension
// (client) and the worker (server). Keep them stable: other directory servers
// implement the same routes.

import type { CompanyFacts } from './linkedin/company/facts';
import type { JobFacts } from './linkedin/job/facts';
import type { FactChange } from './linkedin/diff';
import type { RiskLevel, Score } from './scam/signals';

export type ApiError = { error: string; retryAfterMs?: number };

/** POST /api/snapshots[?report=1] — body is a RawSnapshot, JSON or gzipped JSON. */
export interface SnapshotResponse {
  ok: true;
  memberId: number;
  slug: string | null;
  score: Score;
  changes: FactChange[];
  reported: boolean;
}

/** POST /api/entities */
export type EntityRequest =
  | { kind: 'company'; id: string; facts: CompanyFacts; report: boolean }
  | { kind: 'job'; id: string; facts: JobFacts; company: CompanyFacts | null; report: boolean };

export interface EntityResponse {
  ok: true;
  kind: 'company' | 'job';
  id: string;
  reported: boolean;
  score: Score;
}

/** GET /api/entities/:kind/:id */
export interface EntityRecord {
  kind: 'company' | 'job';
  id: string;
  name: string | null;
  url: string;
  score: Score;
  facts: CompanyFacts | JobFacts;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  reports: number;
}

/** GET /api/leaderboard: reported profiles, ranked by reports, then score. */
export interface LeaderboardRow {
  memberId: number;
  url: string;
  slug: string | null;
  name: string;
  headline: string | null;
  reports: number;
  score: number;
  level: RiskLevel;
  lastReported: number;
}

export interface LeaderboardResponse {
  stats: { reports: number; accounts: number };
  rows: LeaderboardRow[];
}
