export interface Env {
  DB: D1Database;
  RATE_KV: KVNamespace;
  SNAPSHOTS: R2Bucket;
  IP_SALT: string;
  /** Host that serves /verify, e.g. api.example.com. Unset: no bot check and no verify routes. */
  VERIFY_HOST?: string;
  /** Turnstile widget keys. With VERIFY_HOST set, both are required or gated routes answer 503. */
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
}
