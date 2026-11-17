// Storage abstraction. Production uses Cloudflare D1 (SQL). Local dev uses a
// JSON file via the shim in scripts/dev-server.mjs. Both expose the same tiny
// interface the API routes rely on, so app code never cares which is active.
//
// Interface:
//   addReport({ url, handle, grader, profile, ipHash, createdAt })
//   listLeaderboard({ limit })
//   getProfile(url)
//   stats()

export function createD1Store(db) {
  return {
    async addReport(r) {
      await db.batch([
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
            JSON.stringify(r.grader.reasons || []),
            JSON.stringify(r.profile || {}),
            r.createdAt,
          ),
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
            r.profile?.name || '',
            r.profile?.headline || '',
            r.profile?.photoUrl || '',
            r.createdAt,
            r.createdAt,
          ),
      ]);
    },

    async listLeaderboard({ limit = 100 } = {}) {
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
        .all();
      return results;
    },

    async getProfile(url) {
      const profile = await db
        .prepare(`SELECT * FROM profiles WHERE profile_url = ?`)
        .bind(url)
        .first();
      if (!profile) return null;
      const reports = await db
        .prepare(
          `SELECT score, level, reasons_json, created_at
           FROM reports WHERE profile_url = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(url)
        .all();
      return { profile, reports: reports.results };
    },

    async stats() {
      const a = await db.prepare(`SELECT COUNT(*) AS n FROM reports`).first();
      const b = await db.prepare(`SELECT COUNT(DISTINCT profile_url) AS n FROM profiles`).first();
      return { reports: a?.n || 0, profiles: b?.n || 0 };
    },
  };
}
