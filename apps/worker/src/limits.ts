// Per-reporter rate limits in KV. The reporter is a salted IP hash; raw IPs are
// never stored. Check every limit first, then commit them once the write
// succeeded, so a rejected request doesn't use up the reporter's allowance.

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
