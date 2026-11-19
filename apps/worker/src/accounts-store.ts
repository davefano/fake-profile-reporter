// D1 storage for accounts (keyed by member ID), their snapshot history, and slug history.

import type { ProfileFacts, Score, FactChange } from '@flr/core';

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
    async latestFacts(memberId: number): Promise<ProfileFacts | null> {
      const row = await db
        .prepare(`SELECT facts_json FROM account_snapshots WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`)
        .bind(memberId)
        .first<{ facts_json: string }>();
      return row ? (JSON.parse(row.facts_json) as ProfileFacts) : null;
    },

    async addSnapshot(s: NewSnapshot): Promise<void> {
      const f = s.facts;
      // Account first: snapshots and slugs reference it (D1 enforces FKs).
      await db.batch([
        db
          .prepare(
            `INSERT INTO accounts (member_id, profile_id, slug, first_name, last_name, headline, country_code, geo_name,
               industry, joined_at, joined_source, connections, connections_capped, followers, post_count, last_activity_at,
               verified, premium, photo_uploaded_at, position_count, score, level, score_version, version_tag,
               first_captured_at, last_captured_at, snapshot_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(member_id) DO UPDATE SET
               profile_id = excluded.profile_id, slug = excluded.slug, first_name = excluded.first_name,
               last_name = excluded.last_name, headline = excluded.headline, country_code = excluded.country_code,
               geo_name = excluded.geo_name, industry = excluded.industry,
               joined_at = COALESCE(excluded.joined_at, accounts.joined_at),
               joined_source = COALESCE(excluded.joined_source, accounts.joined_source),
               connections = COALESCE(excluded.connections, accounts.connections),
               connections_capped = COALESCE(excluded.connections_capped, accounts.connections_capped),
               followers = COALESCE(excluded.followers, accounts.followers),
               post_count = COALESCE(excluded.post_count, accounts.post_count),
               last_activity_at = COALESCE(excluded.last_activity_at, accounts.last_activity_at),
               verified = COALESCE(excluded.verified, accounts.verified),
               premium = excluded.premium, photo_uploaded_at = excluded.photo_uploaded_at,
               position_count = excluded.position_count, score = excluded.score, level = excluded.level,
               score_version = excluded.score_version, version_tag = excluded.version_tag,
               last_captured_at = MAX(accounts.last_captured_at, excluded.last_captured_at),
               snapshot_count = accounts.snapshot_count + 1`,
          )
          .bind(
            f.memberId,
            f.profileId,
            f.slug,
            f.firstName,
            f.lastName,
            f.headline,
            f.countryCode,
            f.geoName,
            f.industry,
            f.joined?.at ?? null,
            f.joined?.source ?? null,
            f.connections?.count ?? null,
            f.connections ? bool(f.connections.capped) : null,
            f.followers,
            f.activity?.postCount ?? null,
            f.activity?.newestAt ?? null,
            f.about ? bool(f.about.verifications.length > 0) : null,
            bool(f.premium),
            f.photo?.uploadedAt ?? null,
            f.positions.length,
            s.score.score,
            s.score.level,
            s.score.version,
            f.versionTag,
            s.capturedAt,
            s.capturedAt,
          ),
        db
          .prepare(
            `INSERT INTO account_snapshots (member_id, captured_at, r2_key, version_tag, score, facts_json, signals_json, changes_json, ip_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            f.memberId,
            s.capturedAt,
            s.r2Key,
            f.versionTag,
            s.score.score,
            JSON.stringify(f),
            JSON.stringify(s.score.signals),
            JSON.stringify(s.changes),
            s.ipHash,
          ),
        db
          .prepare(
            `INSERT INTO account_slugs (member_id, slug, first_seen, last_seen) VALUES (?, ?, ?, ?)
             ON CONFLICT(member_id, slug) DO UPDATE SET last_seen = MAX(account_slugs.last_seen, excluded.last_seen)`,
          )
          .bind(f.memberId, (f.slug ?? '').toLowerCase(), s.capturedAt, s.capturedAt),
      ]);
    },

    async getAccount(memberId: number) {
      const account = await db.prepare(`SELECT * FROM accounts WHERE member_id = ?`).bind(memberId).first<AccountRow>();
      if (!account) return null;
      const [slugs, snapshots] = await Promise.all([
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
      ]);
      return { account, slugs: slugs.results, snapshots: snapshots.results };
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
