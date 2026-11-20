// D1 storage for accounts (keyed by member ID): their current facts, snapshot
// history, slug history, and reports.

import { observeProfile, type AccountResponse, type FactChange, type LeaderboardRow, type ProfileFacts, type RiskLevel, type Score } from '@flr/core';
import { safeJson } from './json';

interface AccountRow {
  member_id: number;
  slug: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  score: number;
  level: string;
  score_version: number;
  first_captured_at: number;
  last_captured_at: number;
  snapshot_count: number;
}

interface SnapshotRow {
  id: number;
  captured_at: number;
  score: number;
  changes_json: string;
  facts_json: string;
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

export interface CurrentFacts {
  facts: ProfileFacts;
  capturedAt: number;
}

export interface NewSnapshot {
  /** What this capture observed: stored as the snapshot. */
  observed: ProfileFacts & { memberId: number };
  /** The account after this capture, when it is the newest one; null for a backfill. */
  account: { facts: ProfileFacts; score: Score } | null;
  /** The snapshot's own score. */
  score: Score;
  changes: FactChange[];
  r2Key: string;
  capturedAt: number;
  ipHash: string;
}

/** The columns the leaderboard needs, from an account's facts and score. */
const listing = (f: ProfileFacts, s: Score) => [f.slug, f.firstName, f.lastName, f.headline, s.score, s.level, s.version];

export function createAccountStore(db: D1Database) {
  const store = {
    /**
     * What the account looks like now, if it's been seen. Accounts stored
     * before account_current existed are rebuilt from their snapshots once.
     */
    async current(memberId: number): Promise<CurrentFacts | null> {
      const row = await db.prepare(`SELECT facts_json, captured_at FROM account_current WHERE member_id = ?`).bind(memberId).first<{ facts_json: string; captured_at: number }>();
      const facts = row ? safeJson<ProfileFacts | null>(row.facts_json, null) : null;
      if (facts) return { facts, capturedAt: row!.captured_at };

      const rows = await db
        .prepare(`SELECT facts_json, captured_at FROM account_snapshots WHERE member_id = ? ORDER BY captured_at, id`)
        .bind(memberId)
        .all<{ facts_json: string; captured_at: number }>();
      let rebuilt = null as CurrentFacts | null;
      for (const r of rows.results) {
        const next = safeJson<ProfileFacts | null>(r.facts_json, null);
        if (next) rebuilt = { facts: observeProfile(rebuilt?.facts ?? null, next).current, capturedAt: r.captured_at };
      }
      if (rebuilt) await store.setCurrent(memberId, null, rebuilt);
      return rebuilt;
    },

    /** Make sure the account row exists, so facts and snapshots can reference it. */
    async ensureAccount(memberId: number, facts: ProfileFacts, score: Score, capturedAt: number): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO accounts (member_id, slug, first_name, last_name, headline, score, level, score_version,
             first_captured_at, last_captured_at, snapshot_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(memberId, ...listing(facts, score), capturedAt, capturedAt)
        .run();
    },

    /**
     * Move the current facts, but only from the version this upload read
     * (`prevCapturedAt`, or none). False when another upload got there first.
     */
    async setCurrent(memberId: number, prevCapturedAt: number | null, next: CurrentFacts): Promise<boolean> {
      const r =
        prevCapturedAt == null
          ? await db
              .prepare(`INSERT INTO account_current (member_id, captured_at, facts_json) VALUES (?, ?, ?) ON CONFLICT(member_id) DO NOTHING`)
              .bind(memberId, next.capturedAt, JSON.stringify(next.facts))
              .run()
          : await db
              .prepare(`UPDATE account_current SET captured_at = ?, facts_json = ? WHERE member_id = ? AND captured_at = ?`)
              .bind(next.capturedAt, JSON.stringify(next.facts), memberId, prevCapturedAt)
              .run();
      return (r.meta?.changes ?? 0) === 1;
    },

    async addSnapshot(s: NewSnapshot): Promise<void> {
      const memberId = s.observed.memberId;
      await db.batch([
        db
          .prepare(
            `UPDATE accounts SET first_captured_at = MIN(first_captured_at, ?), last_captured_at = MAX(last_captured_at, ?),
               snapshot_count = snapshot_count + 1 WHERE member_id = ?`,
          )
          .bind(s.capturedAt, s.capturedAt, memberId),
        ...(s.account
          ? [
              db
                .prepare(`UPDATE accounts SET slug = ?, first_name = ?, last_name = ?, headline = ?, score = ?, level = ?, score_version = ? WHERE member_id = ?`)
                .bind(...listing(s.account.facts, s.account.score), memberId),
            ]
          : []),
        db
          .prepare(
            `INSERT INTO account_snapshots (member_id, captured_at, r2_key, version_tag, score, facts_json, signals_json, changes_json, ip_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(memberId, s.capturedAt, s.r2Key, s.observed.versionTag, s.score.score, JSON.stringify(s.observed), JSON.stringify(s.score), JSON.stringify(s.changes), s.ipHash),
        ...(s.observed.slug
          ? [
              db
                .prepare(
                  `INSERT INTO account_slugs (member_id, slug, first_seen, last_seen) VALUES (?, ?, ?, ?)
                   ON CONFLICT(member_id, slug) DO UPDATE SET
                     first_seen = MIN(account_slugs.first_seen, excluded.first_seen),
                     last_seen = MAX(account_slugs.last_seen, excluded.last_seen)`,
                )
                .bind(memberId, s.observed.slug.toLowerCase(), s.capturedAt, s.capturedAt),
            ]
          : []),
      ]);
    },

    async addReport(r: { memberId: number; score: number; ipHash: string; createdAt: number }): Promise<void> {
      await db.prepare(`INSERT INTO account_reports (member_id, score, ip_hash, created_at) VALUES (?, ?, ?, ?)`).bind(r.memberId, r.score, r.ipHash, r.createdAt).run();
    },

    /** Reported accounts, most reports first, then highest current score. */
    async leaderboard(limit: number): Promise<{ rows: LeaderboardRow[]; stats: { reports: number; accounts: number } }> {
      const [rows, stats] = await Promise.all([
        db
          .prepare(
            `SELECT a.member_id, a.slug, a.first_name, a.last_name, a.headline, a.score, a.level, r.reports, r.last_reported
             FROM (SELECT member_id, COUNT(*) AS reports, MAX(created_at) AS last_reported FROM account_reports GROUP BY member_id) r
             JOIN accounts a ON a.member_id = r.member_id
             ORDER BY r.reports DESC, a.score DESC, r.last_reported DESC
             LIMIT ?`,
          )
          .bind(limit)
          .all<LeaderboardDbRow>(),
        db.prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT member_id) AS accounts FROM account_reports`).first<{ reports: number; accounts: number }>(),
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
      const [current, slugs, snapshots, reports] = await Promise.all([
        store.current(memberId),
        db
          .prepare(`SELECT slug, first_seen, last_seen FROM account_slugs WHERE member_id = ? ORDER BY first_seen`)
          .bind(memberId)
          .all<{ slug: string; first_seen: number; last_seen: number }>(),
        db
          .prepare(`SELECT id, captured_at, score, changes_json FROM account_snapshots WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 50`)
          .bind(memberId)
          .all<Omit<SnapshotRow, 'facts_json'>>(),
        db.prepare(`SELECT COUNT(*) AS n FROM account_reports WHERE member_id = ?`).bind(memberId).first<{ n: number }>(),
      ]);
      const f = current?.facts;
      return {
        memberId,
        profileId: f?.profileId ?? null,
        slug: a.slug,
        name: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
        headline: a.headline,
        location: f?.geoName ?? null,
        industry: f?.industry ?? null,
        joined: f?.joined ?? null,
        connections: f?.connections ?? null,
        followers: f?.followers ?? null,
        postCount: f?.activity?.postCount ?? null,
        lastActivityAt: f?.activity?.newestAt ?? null,
        verified: f?.about ? f.about.verifications.length > 0 : null,
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
      const row = await db.prepare(`SELECT member_id FROM account_slugs WHERE slug = ? ORDER BY last_seen DESC LIMIT 1`).bind(slug.toLowerCase()).first<{ member_id: number }>();
      return row?.member_id ?? null;
    },
  };
  return store;
}
