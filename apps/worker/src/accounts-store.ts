// D1 storage for accounts (keyed by member ID): their snapshot history, slug
// history, and reports.

import type { FactChange, LeaderboardRow, ProfileFacts, RiskLevel, Score } from '@flr/core';
import { safeJson } from './json';

export interface AccountRow {
  member_id: number;
  profile_id: string | null;
  slug: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  country_code: string | null;
  geo_name: string | null;
  industry: string | null;
  joined_at: number | null;
  joined_source: string | null;
  connections: number | null;
  connections_capped: number | null;
  followers: number | null;
  post_count: number | null;
  last_activity_at: number | null;
  verified: number | null;
  premium: number | null;
  photo_uploaded_at: number | null;
  position_count: number | null;
  score: number;
  level: string;
  score_version: number;
  version_tag: string | null;
  first_captured_at: number;
  last_captured_at: number;
  snapshot_count: number;
}

export interface SnapshotRow {
  id: number;
  captured_at: number;
  version_tag: string | null;
  score: number;
  changes_json: string;
}

export interface NewSnapshot {
  facts: ProfileFacts & { memberId: number };
  score: Score;
  changes: FactChange[];
  r2Key: string;
  capturedAt: number;
  ipHash: string;
}

const bool = (b: boolean | null | undefined) => (b == null ? null : b ? 1 : 0);

export function createAccountStore(db: D1Database) {
  return {
    /** The newest stored snapshot's facts and capture time. */
    async latest(memberId: number): Promise<{ facts: ProfileFacts; capturedAt: number } | null> {
      const row = await db
        .prepare(`SELECT facts_json, captured_at FROM account_snapshots WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`)
        .bind(memberId)
        .first<{ facts_json: string; captured_at: number }>();
      const facts = row ? safeJson<ProfileFacts | null>(row.facts_json, null) : null;
      return facts ? { facts, capturedAt: row!.captured_at } : null;
    },

    async addSnapshot(s: NewSnapshot): Promise<void> {
      const f = s.facts;
      const current = [
        f.profileId, f.slug, f.firstName, f.lastName, f.headline, f.countryCode, f.geoName, f.industry,
        f.joined?.at ?? null, f.joined?.source ?? null, f.connections?.count ?? null, f.connections ? bool(f.connections.capped) : null,
        f.followers, f.activity?.postCount ?? null, f.activity?.newestAt ?? null, f.about ? bool(f.about.verifications.length > 0) : null,
        bool(f.premium), f.photo?.uploadedAt ?? null, f.positions.length, s.score.score, s.score.level, s.score.version, f.versionTag,
      ];
      // Account first: snapshots and slugs reference it (D1 enforces FKs). The
      // insert only creates the row and keeps counts; the update then moves the
      // current facts, and only when this is the newest capture, so a late
      // upload of an older snapshot can't roll the account back.
      await db.batch([
        db
          .prepare(
            `INSERT INTO accounts (member_id, profile_id, slug, first_name, last_name, headline, country_code, geo_name,
               industry, joined_at, joined_source, connections, connections_capped, followers, post_count, last_activity_at,
               verified, premium, photo_uploaded_at, position_count, score, level, score_version, version_tag,
               first_captured_at, last_captured_at, snapshot_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(member_id) DO UPDATE SET
               first_captured_at = MIN(accounts.first_captured_at, excluded.first_captured_at),
               last_captured_at = MAX(accounts.last_captured_at, excluded.last_captured_at),
               snapshot_count = accounts.snapshot_count + 1`,
          )
          .bind(f.memberId, ...current, s.capturedAt, s.capturedAt),
        db
          .prepare(
            `UPDATE accounts SET
               profile_id = ?, slug = ?, first_name = ?, last_name = ?, headline = ?, country_code = ?, geo_name = ?,
               industry = ?, joined_at = COALESCE(?, joined_at), joined_source = COALESCE(?, joined_source),
               connections = COALESCE(?, connections), connections_capped = COALESCE(?, connections_capped),
               followers = COALESCE(?, followers), post_count = COALESCE(?, post_count),
               last_activity_at = COALESCE(?, last_activity_at), verified = COALESCE(?, verified),
               premium = ?, photo_uploaded_at = ?, position_count = ?, score = ?, level = ?, score_version = ?, version_tag = ?
             WHERE member_id = ? AND last_captured_at = ?`,
          )
          .bind(...current, f.memberId, s.capturedAt),
        db
          .prepare(
            `INSERT INTO account_snapshots (member_id, captured_at, r2_key, version_tag, score, facts_json, signals_json, changes_json, ip_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(f.memberId, s.capturedAt, s.r2Key, f.versionTag, s.score.score, JSON.stringify(f), JSON.stringify(s.score), JSON.stringify(s.changes), s.ipHash),
        db
          .prepare(
            `INSERT INTO account_slugs (member_id, slug, first_seen, last_seen) VALUES (?, ?, ?, ?)
             ON CONFLICT(member_id, slug) DO UPDATE SET last_seen = MAX(account_slugs.last_seen, excluded.last_seen)`,
          )
          .bind(f.memberId, (f.slug ?? '').toLowerCase(), s.capturedAt, s.capturedAt),
      ]);
    },

    async addReport(r: { memberId: number; score: number; ipHash: string; createdAt: number }): Promise<void> {
      await db
        .prepare(`INSERT INTO account_reports (member_id, score, ip_hash, created_at) VALUES (?, ?, ?, ?)`)
        .bind(r.memberId, r.score, r.ipHash, r.createdAt)
        .run();
    },

    async currentScore(memberId: number): Promise<number | null> {
      const row = await db.prepare(`SELECT score FROM accounts WHERE member_id = ?`).bind(memberId).first<{ score: number }>();
      return row?.score ?? null;
    },

    /** Reported accounts, most reports first, then highest current score. */
    async leaderboard(limit: number): Promise<{ rows: LeaderboardRow[]; stats: { reports: number; accounts: number } }> {
      const [rows, stats] = await Promise.all([
        db
          .prepare(
            `SELECT a.member_id, a.slug, a.first_name, a.last_name, a.headline, a.score, a.level,
                    r.reports, r.last_reported
             FROM (SELECT member_id, COUNT(*) AS reports, MAX(created_at) AS last_reported
                   FROM account_reports GROUP BY member_id) r
             JOIN accounts a ON a.member_id = r.member_id
             ORDER BY r.reports DESC, a.score DESC, r.last_reported DESC
             LIMIT ?`,
          )
          .bind(limit)
          .all<Record<string, any>>(),
        db
          .prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT member_id) AS accounts FROM account_reports`)
          .first<{ reports: number; accounts: number }>(),
      ]);
      return {
        stats: { reports: Number(stats?.reports ?? 0), accounts: Number(stats?.accounts ?? 0) },
        rows: rows.results.map((r) => ({
          memberId: Number(r.member_id),
          url: r.slug ? `https://www.linkedin.com/in/${r.slug}/` : `https://www.linkedin.com/`,
          slug: r.slug,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.slug || `Member ${r.member_id}`,
          headline: r.headline,
          reports: Number(r.reports),
          score: Number(r.score),
          level: r.level as RiskLevel,
          lastReported: Number(r.last_reported),
        })),
      };
    },

    async getAccount(memberId: number) {
      const account = await db.prepare(`SELECT * FROM accounts WHERE member_id = ?`).bind(memberId).first<AccountRow>();
      if (!account) return null;
      const [slugs, snapshots, reports] = await Promise.all([
        db
          .prepare(`SELECT slug, first_seen, last_seen FROM account_slugs WHERE member_id = ? ORDER BY first_seen`)
          .bind(memberId)
          .all<{ slug: string; first_seen: number; last_seen: number }>(),
        db
          .prepare(
            `SELECT id, captured_at, version_tag, score, changes_json FROM account_snapshots
             WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 50`,
          )
          .bind(memberId)
          .all<SnapshotRow>(),
        db.prepare(`SELECT COUNT(*) AS n FROM account_reports WHERE member_id = ?`).bind(memberId).first<{ n: number }>(),
      ]);
      return { account, slugs: slugs.results, snapshots: snapshots.results, reports: Number(reports?.n ?? 0) };
    },

    async memberIdForSlug(slug: string): Promise<number | null> {
      const row = await db
        .prepare(`SELECT member_id FROM account_slugs WHERE slug = ? ORDER BY last_seen DESC LIMIT 1`)
        .bind(slug.toLowerCase())
        .first<{ member_id: number }>();
      return row?.member_id ?? null;
    },
  };
}
