export interface Env {
  DB: D1Database;
  RATE_KV: KVNamespace;
  SNAPSHOTS: R2Bucket;
  IP_SALT: string;
}
