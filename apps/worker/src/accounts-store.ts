// D1 storage for accounts (keyed by member ID): their snapshot history, slug
// history, and reports.

import { carryForwardProfile, type AccountResponse, type FactChange, type LeaderboardRow, type ProfileFacts, type RiskLevel, type Score } from '@flr/core';
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
  score: number;
  changes_json: string;
}

export interface NewSnapshot {
  /** What this capture observed: stored as the snapshot. */
  facts: ProfileFacts & { memberId: number };
  /** The account's facts after this capture (failed parts carried forward); only written when this is the newest capture. */
  current: ProfileFacts;
  score: Score;
  changes: FactChange[];
  r2Key: string;
  capturedAt: number;
  ipHash: string;
}

interface LeaderboardDbRow {
  member_id: number;
  slug: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  score: number;
  level: string;
  reports: number;
  last_reported: number;
}

const bool = (b: boolean | null | undefined) => (b == null ? null : b ? 1 : 0);

export function createAccountStore(db: D1Database) {
  return {
    /** What the account looks like now (see account_current), if it's been seen. */
    async current(memberId: number): Promise<{ facts: ProfileFacts; capturedAt: number } | null> {
      const row = await db
        .prepare(`SELECT facts_json, captured_at FROM account_current WHERE member_id = ?`)
        .bind(memberId)
        .first<{ facts_json: string; captured_at: number }>();
      const facts = row ? safeJson<ProfileFacts | null>(row.facts_json, null) : null;
      return facts ? { facts, capturedAt: row!.captured_at } : null;
    },

    async addSnapshot(s: NewSnapshot): Promise<void> {
      const f = s.current;
      const current = [
        f.profileId, f.slug, f.firstName, f.lastName, f.headline, f.countryCode, f.geoName, f.industry,
        f.joined?.at ?? null, f.joined?.source ?? null, f.connections?.count ?? null, f.connections ? bool(f.connections.capped) : null,
        f.followers, f.activity?.postCount ?? null, f.activity?.newestAt ?? null, f.about ? bool(f.about.verifications.length > 0) : null,
        bool(f.premium), f.photo?.uploadedAt ?? null, f.positions.length, s.score.score, s.score.level, s.score.version, f.versionTag,
      ];
      // Account first: snapshots and slugs reference it (D1 enforces FKs). The
      // insert only creates the row and keeps counts; the updates then move the
      // current facts, and only when this is the newest capture, so a late
      // upload of an older snapshot can't roll the account back. `current` has
      // failed parts carried forward already, so columns are set directly.
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
          .bind(s.facts.memberId, ...current, s.capturedAt, s.capturedAt),
        db
          .prepare(
            `UPDATE accounts SET
               profile_id = ?, slug = ?, first_name = ?, last_name = ?, headline = ?, country_code = ?, geo_name = ?,
               industry = ?, joined_at = ?, joined_source = ?, connections = ?, connections_capped = ?,
               followers = ?, post_count = ?, last_activity_at = ?, verified = ?,
               premium = ?, photo_uploaded_at = ?, position_count = ?, score = ?, level = ?, score_version = ?, version_tag = ?
             WHERE member_id = ? AND last_captured_at = ?`,
          )
          .bind(...current, s.facts.memberId, s.capturedAt),
        db
          .prepare(
            `INSERT INTO account_current (member_id, captured_at, facts_json) VALUES (?, ?, ?)
             ON CONFLICT(member_id) DO UPDATE SET captured_at = excluded.captured_at, facts_json = excluded.facts_json
             WHERE excluded.captured_at >= account_current.captured_at`,
          )
          .bind(s.facts.memberId, s.capturedAt, JSON.stringify(s.current)),
        db
          .prepare(
            `INSERT INTO account_snapshots (member_id, captured_at, r2_key, version_tag, score, facts_json, signals_json, changes_json, ip_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(s.facts.memberId, s.capturedAt, s.r2Key, s.facts.versionTag, s.score.score, JSON.stringify(s.facts), JSON.stringify(s.score), JSON.stringify(s.changes), s.ipHash),
        ...(s.facts.slug
          ? [
              db
                .prepare(
                  `INSERT INTO account_slugs (member_id, slug, first_seen, last_seen) VALUES (?, ?, ?, ?)
                   ON CONFLICT(member_id, slug) DO UPDATE SET
                     first_seen = MIN(account_slugs.first_seen, excluded.first_seen),
                     last_seen = MAX(account_slugs.last_seen, excluded.last_seen)`,
                )
                .bind(s.facts.memberId, s.facts.slug.toLowerCase(), s.capturedAt, s.capturedAt),
            ]
          : []),
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
          .all<LeaderboardDbRow>(),
        db
          .prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT member_id) AS accounts FROM account_reports`)
          .first<{ reports: number; accounts: number }>(),
      ]);
      return {
        stats: { reports: Number(stats?.reports ?? 0), accounts: Number(stats?.accounts ?? 0) },
        rows: rows.results.map((r) => ({
          memberId: Number(r.member_id),
          url: r.slug ? `https://www.linkedin.com/in/${encodeURIComponent(r.slug)}/` : `https://www.linkedin.com/`,
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

    async getAccount(memberId: number): Promise<AccountResponse | null> {
      const a = await db.prepare(`SELECT * FROM accounts WHERE member_id = ?`).bind(memberId).first<AccountRow>();
      if (!a) return null;
      const [slugs, snapshots, reports] = await Promise.all([
        db
          .prepare(`SELECT slug, first_seen, last_seen FROM account_slugs WHERE member_id = ? ORDER BY first_seen`)
          .bind(memberId)
          .all<{ slug: string; first_seen: number; last_seen: number }>(),
        db
          .prepare(
            `SELECT id, captured_at, score, changes_json FROM account_snapshots
             WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 50`,
          )
          .bind(memberId)
          .all<SnapshotRow>(),
        db.prepare(`SELECT COUNT(*) AS n FROM account_reports WHERE member_id = ?`).bind(memberId).first<{ n: number }>(),
      ]);
      const flag = (n: number | null) => (n == null ? null : n === 1);
      return {
        memberId: a.member_id,
        profileId: a.profile_id,
        slug: a.slug,
        name: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
        headline: a.headline,
        location: a.geo_name,
        industry: a.industry,
        joined: a.joined_at != null ? { at: a.joined_at, source: a.joined_source === 'about' ? 'about' : 'memberId' } : null,
        connections: a.connections != null ? { count: a.connections, capped: a.connections_capped === 1 } : null,
        followers: a.followers,
        postCount: a.post_count,
        lastActivityAt: a.last_activity_at,
        verified: flag(a.verified),
        score: a.score,
        level: a.level as RiskLevel,
        scoreVersion: a.score_version,
        firstCapturedAt: a.first_captured_at,
        lastCapturedAt: a.last_captured_at,
        snapshotCount: a.snapshot_count,
        reports: Number(reports?.n ?? 0),
        slugs: slugs.results.map((x) => ({ slug: x.slug, firstSeen: x.first_seen, lastSeen: x.last_seen })),
        snapshots: snapshots.results.map((x) => ({ id: x.id, capturedAt: x.captured_at, score: x.score, changes: safeJson<FactChange[]>(x.changes_json, []) })),
      };
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
