// Storage for reports and profiles on Cloudflare D1 (SQLite). Local dev uses
// wrangler's local D1; tests run the same SQL against bun:sqlite.

import type { GradeResult, ProfileObservation } from '@flr/core';

export interface NewReport {
  url: string;
  handle: string;
  grader: GradeResult;
  profile: ProfileObservation;
  ipHash: string;
  createdAt: number;
}

export interface ProfileRow {
  profile_url: string;
  handle: string;
  name: string;
  headline: string;
  photo_url: string;
  first_seen: number;
  last_reported: number;
}

export interface LeaderboardDbRow {
  profile_url: string;
  handle: string;
  name: string;
  headline: string;
  photo_url: string;
  reports: number;
  avg_score: number;
  last_reported: number;
}

export interface ReportDbRow {
  score: number;
  level: string;
  reasons_json: string;
  created_at: number;
}

export function createD1Store(db: D1Database) {
  return {
    async addReport(r: NewReport): Promise<void> {
      await db.batch([
        // Profile first: reports.profile_url references profiles (D1 enforces FKs).
        db
          .prepare(
            `INSERT INTO profiles (profile_url, handle, name, headline, photo_url, first_seen, last_reported)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_url) DO UPDATE SET
               last_reported = excluded.last_reported,
               name = COALESCE(NULLIF(excluded.name, ''), profiles.name),
               headline = COALESCE(NULLIF(excluded.headline, ''), profiles.headline),
               photo_url = COALESCE(NULLIF(excluded.photo_url, ''), profiles.photo_url)`,
          )
          .bind(
            r.url,
            r.handle,
            r.profile.name || '',
            r.profile.headline || '',
            r.profile.photoUrl || '',
            r.createdAt,
            r.createdAt,
          ),
        db
          .prepare(
            `INSERT INTO reports (profile_url, ip_hash, score, level, reasons_json, profile_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            r.url,
            r.ipHash,
            r.grader.score,
            r.grader.level,
            JSON.stringify(r.grader.reasons),
            JSON.stringify(r.profile),
            r.createdAt,
          ),
      ]);
    },

    async listLeaderboard({ limit = 100 }: { limit?: number } = {}): Promise<LeaderboardDbRow[]> {
      const { results } = await db
        .prepare(
          `SELECT p.profile_url, p.handle, p.name, p.headline, p.photo_url,
                  COUNT(r.id) AS reports,
                  ROUND(AVG(r.score), 0) AS avg_score,
                  MAX(r.created_at) AS last_reported
           FROM profiles p
           JOIN reports r ON r.profile_url = p.profile_url
           GROUP BY p.profile_url
           ORDER BY reports DESC, avg_score DESC, last_reported DESC
           LIMIT ?`,
        )
        .bind(limit)
        .all<LeaderboardDbRow>();
      return results;
    },

    async getProfile(url: string): Promise<{ profile: ProfileRow; reports: ReportDbRow[] } | null> {
      const profile = await db
        .prepare(`SELECT * FROM profiles WHERE profile_url = ?`)
        .bind(url)
        .first<ProfileRow>();
      if (!profile) return null;
      const reports = await db
        .prepare(
          `SELECT score, level, reasons_json, created_at
           FROM reports WHERE profile_url = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(url)
        .all<ReportDbRow>();
      return { profile, reports: reports.results };
    },

    async stats(): Promise<{ reports: number; profiles: number }> {
      const a = await db.prepare(`SELECT COUNT(*) AS n FROM reports`).first<{ n: number }>();
      const b = await db.prepare(`SELECT COUNT(DISTINCT profile_url) AS n FROM profiles`).first<{ n: number }>();
      return { reports: a?.n || 0, profiles: b?.n || 0 };
    },
  };
}
