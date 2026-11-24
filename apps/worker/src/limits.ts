// Rate limits. Cooldowns and the snapshot and entity daily limits are in KV,
// where a lost race costs nothing: check every limit first, then commit them
// once the write succeeded, so a rejected request doesn't use up the
// allowance. Daily caps that must hold under parallel requests (reports) are
// counted in D1 by countDaily. The reporter is a salted IP hash; raw IPs are
// never stored.

import { clientIp, hashIp } from './ip';

export interface Check {
  ok: boolean;
  commit(): Promise<void>;
}

export async function reporterLimits(c: { env: { RATE_KV: KVNamespace; IP_SALT: string }; req: { raw: Request } }, now = Date.now()) {
  const kv = c.env.RATE_KV;
  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  return {
    ipHash,
    /** At most `max` per UTC day for this reporter, counted per scope. */
    async daily(scope: string, max: number): Promise<Check> {
      const key = `day:${scope}:${ipHash}:${new Date(now).toISOString().slice(0, 10)}`;
      const count = Number((await kv.get(key)) || 0);
      return { ok: count < max, commit: () => kv.put(key, String(count + 1), { expirationTtl: 60 * 60 * 48 }) };
    },
    /** At most once per `ms` for this reporter and key. */
    async cooldown(key: string, ms: number): Promise<Check> {
      const k = `cd:${key}:${ipHash}`;
      const last = Number((await kv.get(k)) || 0);
      return { ok: now - last >= ms, commit: () => kv.put(k, String(now), { expirationTtl: Math.ceil(ms / 1000) }) };
    },
  };
}

export interface DailyCap {
  /** Which cap and whose, e.g. 'reports.reporter'. */
  scope: string;
  /** The reporter hash or IP hash it counts for. */
  subject: string;
  max: number;
}

/**
 * Counts one attempt against each cap for today (UTC) and says whether all are
 * still within. One D1 batch deletes earlier days and increments and returns
 * each count, so parallel requests can't both slip under a cap. The count goes
 * up before the check, so refused attempts count too.
 */
export async function countDaily(db: D1Database, caps: DailyCap[], now = Date.now()): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const [, ...counts] = await db.batch([
    db.prepare('DELETE FROM daily_counts WHERE day < ?1').bind(day),
    ...caps.map((cap) =>
      db
        .prepare(
          `INSERT INTO daily_counts (scope, subject, day, count) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT (scope, subject, day) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(cap.scope, cap.subject, day),
    ),
  ]);
  return caps.every((cap, i) => Number((counts[i]?.results[0] as { count: number } | undefined)?.count ?? Infinity) <= cap.max);
}
