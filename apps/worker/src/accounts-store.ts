// D1 storage for accounts (keyed by member ID): their current facts, snapshot
// history and slug history, and the report counts shown with them.

import { type AccountResponse, type FactChange, type LeaderboardRow, type ProfileFacts, type RiskLevel, type Score } from '@fpr/core';
import { safeJson } from './json';
import { countsFrom, reportCounts } from './reports-store';

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
  impersonated: number;
  vouches: number;
  last_reported: number;
}

export interface CurrentFacts {
  facts: ProfileFacts;
  capturedAt: number;
  /** The version token this was read at, for compare-and-swap. */
  rev: string;
}

interface SnapshotWrite {
  observed: ProfileFacts & { memberId: number };
  /** The snapshot's own score: of its observed facts. */
  score: Score;
  changes: FactChange[];
  r2Key: string;
  capturedAt: number;
  ipHash: string;
}

/** The columns the leaderboard needs, from an account's facts and score. */
const listing = (f: ProfileFacts, s: Score) => [f.slug, f.firstName, f.lastName, f.headline, s.score, s.level, s.version];

/** True while the member hasn't been removed at its owner's request (removals.ts). */
const NOT_REMOVED = 'NOT EXISTS (SELECT 1 FROM removed_members WHERE member_id = ?)';

/**
 * The condition every snapshot write carries, checked inside its batch: the
 * member isn't removed, so an upload already in flight when a removal is
 * approved writes nothing; and, after a compare-and-swap, this upload's rev
 * is the stored one, so a lost swap writes nothing.
 */
const writeGuard = (memberId: number, rev: string | null) =>
  rev
    ? { sql: `${NOT_REMOVED} AND EXISTS (SELECT 1 FROM account_current WHERE member_id = ? AND rev = ?)`, params: [memberId, memberId, rev] }
    : { sql: NOT_REMOVED, params: [memberId] };

export function createAccountStore(db: D1Database) {
  /** Statements recording one snapshot, each only if the member isn't removed and, with `rev`, that rev is current. */
  const snapshotStatements = (s: SnapshotWrite, rev: string | null) => {
    const memberId = s.observed.memberId;
    const { sql: guard, params: g } = writeGuard(memberId, rev);
    return [
      db
        .prepare(
          `INSERT INTO account_snapshots (member_id, captured_at, r2_key, version_tag, score, facts_json, signals_json, changes_json, ip_hash)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(memberId, s.capturedAt, s.r2Key, s.observed.versionTag, s.score.score, JSON.stringify(s.observed), JSON.stringify(s.score), JSON.stringify(s.changes), s.ipHash, ...g),
      ...(s.observed.slug
        ? [
            db
              .prepare(
                `INSERT INTO account_slugs (member_id, slug, first_seen, last_seen) SELECT ?, ?, ?, ? WHERE ${guard}
                 ON CONFLICT(member_id, slug) DO UPDATE SET
                   first_seen = MIN(account_slugs.first_seen, excluded.first_seen),
                   last_seen = MAX(account_slugs.last_seen, excluded.last_seen)`,
              )
              .bind(memberId, s.observed.slug.toLowerCase(), s.capturedAt, s.capturedAt, ...g),
          ]
        : []),
    ];
  };

  return {
    /** What the account looks like now, if it's been seen. */
    async current(memberId: number): Promise<CurrentFacts | null> {
      const row = await db
        .prepare(`SELECT rev, facts_json, captured_at FROM account_current WHERE member_id = ?`)
        .bind(memberId)
        .first<{ rev: string; facts_json: string; captured_at: number }>();
      const facts = row ? safeJson<ProfileFacts | null>(row.facts_json, null) : null;
      return facts ? { facts, capturedAt: row!.captured_at, rev: row!.rev } : null;
    },

    /** Whether the member was removed at its owner's request: its saves and reports are refused. */
    async isRemoved(memberId: number): Promise<boolean> {
      return !!(await db.prepare(`SELECT 1 AS x FROM removed_members WHERE member_id = ?`).bind(memberId).first());
    },

    /** Whether this archived capture is already on record (keys are content hashes). */
    async hasSnapshot(r2Key: string): Promise<boolean> {
      return !!(await db.prepare(`SELECT 1 AS x FROM account_snapshots WHERE r2_key = ?`).bind(r2Key).first());
    },

    /**
     * Record the newest capture: move the current facts from `prevRev` (or
     * none) to a new rev, and in the same transaction update the listing and
     * counts and store the snapshot, each only if the move happened. False when
     * another upload moved the account first: nothing was written; merge again.
     */
    async commitNewest(s: SnapshotWrite, prevRev: string | null, account: { facts: ProfileFacts; score: Score }): Promise<boolean> {
      const memberId = s.observed.memberId;
      const rev = crypto.randomUUID();
      const guard = writeGuard(memberId, rev);
      const results = await db.batch([
        // A first capture creates the account row in the same transaction (the
        // facts reference it). Of two first uploads, whichever batch runs first
        // creates both rows; the other's inserts are no-ops. A removed member gets neither.
        db
          .prepare(
            `INSERT OR IGNORE INTO accounts (member_id, slug, first_name, last_name, headline, score, level, score_version,
               first_captured_at, last_captured_at, snapshot_count)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0 WHERE ${NOT_REMOVED}`,
          )
          .bind(memberId, ...listing(account.facts, account.score), s.capturedAt, s.capturedAt, memberId),
        prevRev == null
          ? db
              .prepare(`INSERT INTO account_current (member_id, rev, captured_at, facts_json) SELECT ?, ?, ?, ? WHERE ${NOT_REMOVED} ON CONFLICT(member_id) DO NOTHING`)
              .bind(memberId, rev, s.capturedAt, JSON.stringify(account.facts), memberId)
          : db
              .prepare(`UPDATE account_current SET rev = ?, captured_at = ?, facts_json = ? WHERE member_id = ? AND rev = ? AND ${NOT_REMOVED}`)
              .bind(rev, s.capturedAt, JSON.stringify(account.facts), memberId, prevRev, memberId),
        db
          .prepare(
            `UPDATE accounts SET slug = ?, first_name = ?, last_name = ?, headline = ?, score = ?, level = ?, score_version = ?,
               first_captured_at = MIN(first_captured_at, ?), last_captured_at = MAX(last_captured_at, ?), snapshot_count = snapshot_count + 1
             WHERE member_id = ? AND ${guard.sql}`,
          )
          .bind(...listing(account.facts, account.score), s.capturedAt, s.capturedAt, memberId, ...guard.params),
        ...snapshotStatements(s, rev),
      ]);
      return (results[1]?.meta?.changes ?? 0) === 1;
    },

    /** Record an older capture (a backfill): stored, but the account doesn't move. */
    async commitBackfill(s: SnapshotWrite): Promise<void> {
      await db.batch([
        db
          .prepare(
            `UPDATE accounts SET first_captured_at = MIN(first_captured_at, ?), last_captured_at = MAX(last_captured_at, ?),
               snapshot_count = snapshot_count + 1 WHERE member_id = ? AND ${NOT_REMOVED}`,
          )
          .bind(s.capturedAt, s.capturedAt, s.observed.memberId, s.observed.memberId),
        ...snapshotStatements(s, null),
      ]);
    },

    /** Accounts with an active "looks suspicious" report: most reports first, then highest current score. */
    async leaderboard(limit: number): Promise<{ rows: LeaderboardRow[]; stats: { reports: number; accounts: number } }> {
      const [rows, stats] = await Promise.all([
        db
          .prepare(
            `SELECT a.member_id, a.slug, a.first_name, a.last_name, a.headline, a.score, a.level, r.reports, r.impersonated, r.vouches, r.last_reported
             FROM (SELECT target_id,
                          SUM(stance = 'report') AS reports,
                          SUM(stance = 'impersonated') AS impersonated,
                          SUM(stance = 'vouch') AS vouches,
                          MAX(CASE WHEN stance = 'report' THEN updated_at END) AS last_reported
                   FROM reports WHERE kind = 'profile' AND withdrawn_at IS NULL GROUP BY target_id) r
             JOIN accounts a ON a.member_id = CAST(r.target_id AS INTEGER)
             WHERE r.reports > 0
             ORDER BY r.reports DESC, a.score DESC, r.last_reported DESC
             LIMIT ?`,
          )
          .bind(limit)
          .all<LeaderboardDbRow>(),
        db
          .prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT target_id) AS accounts FROM reports WHERE kind = 'profile' AND stance = 'report' AND withdrawn_at IS NULL`)
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
          impersonated: Number(r.impersonated),
          vouches: Number(r.vouches),
          score: Number(r.score),
          level: r.level as RiskLevel,
          lastReported: Number(r.last_reported),
        })),
      };
    },

    async getAccount(memberId: number): Promise<AccountResponse | null> {
      // One batch is one transaction: every part of the answer comes from the same moment.
      // A removed member reads as not found.
      const [accountRows, currentRows, slugRows, snapshotRows, reportRows] = await db.batch([
        db.prepare(`SELECT * FROM accounts WHERE member_id = ? AND ${NOT_REMOVED}`).bind(memberId, memberId),
        db.prepare(`SELECT facts_json FROM account_current WHERE member_id = ?`).bind(memberId),
        db.prepare(`SELECT slug, first_seen, last_seen FROM account_slugs WHERE member_id = ? ORDER BY first_seen`).bind(memberId),
        db.prepare(`SELECT id, captured_at, score, changes_json FROM account_snapshots WHERE member_id = ? ORDER BY captured_at DESC, id DESC LIMIT 50`).bind(memberId),
        reportCounts(db, 'profile', String(memberId)),
      ]);
      const a = accountRows?.results[0] as AccountRow | undefined;
      if (!a) return null;
      const currentRow = currentRows?.results[0] as { facts_json: string } | undefined;
      const current = currentRow ? { facts: safeJson<ProfileFacts | null>(currentRow.facts_json, null) } : null;
      const slugs = { results: (slugRows?.results ?? []) as Array<{ slug: string; first_seen: number; last_seen: number }> };
      const snapshots = { results: (snapshotRows?.results ?? []) as SnapshotRow[] };
      const counts = countsFrom(reportRows?.results[0]);
      // Everything about the profile from its current facts; the accounts row only adds counts and the score.
      const f = current?.facts ?? null;
      return {
        memberId,
        profileId: f?.profileId ?? null,
        slug: f?.slug ?? a.slug,
        name: [f?.firstName, f?.lastName].filter(Boolean).join(' ') || null,
        headline: f?.headline ?? null,
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
        counts,
        slugs: slugs.results.map((x) => ({ slug: x.slug, firstSeen: x.first_seen, lastSeen: x.last_seen })),
        snapshots: snapshots.results.map((x) => ({ id: x.id, capturedAt: x.captured_at, score: x.score, changes: safeJson<FactChange[]>(x.changes_json, []) })),
      };
    },

    async memberIdForSlug(slug: string): Promise<number | null> {
      const row = await db
        .prepare(`SELECT member_id FROM account_slugs s WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM removed_members r WHERE r.member_id = s.member_id) ORDER BY last_seen DESC LIMIT 1`)
        .bind(slug.toLowerCase())
        .first<{ member_id: number }>();
      return row?.member_id ?? null;
    },
  };
}
