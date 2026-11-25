// Just enough of the D1 API over bun:sqlite to run the real schema and queries
// in tests. Not a full D1 implementation.

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Param = string | number | null;

class Statement {
  constructor(
    private db: Database,
    private sql: string,
    private params: Param[] = [],
  ) {}

  bind(...params: Param[]) {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>() {
    return (this.db.query(this.sql).get(...this.params) as T | null) ?? null;
  }

  async all<T>() {
    return { results: this.db.query(this.sql).all(...this.params) as T[], success: true, meta: {} };
  }

  /** Like D1: meta.changes counts the rows the statement wrote. */
  runSync() {
    const q = this.db.query(this.sql);
    // In a batch, D1 returns rows for SELECTs and change counts for writes.
    if (/^\s*select/i.test(this.sql)) return { results: q.all(...this.params), success: true, meta: { changes: 0 } };
    // A write with RETURNING returns its rows too.
    if (/\breturning\b/i.test(this.sql)) {
      const results = q.all(...this.params);
      return { results, success: true, meta: { changes: results.length } };
    }
    const r = q.run(...this.params);
    return { results: [], success: true, meta: { changes: r.changes } };
  }

  async run() {
    return this.runSync();
  }
}

/** A fresh database built from `schemas` in order (default: schema.sql). */
export function createTestD1(schemas: string[] = [readFileSync(join(import.meta.dir, '../schema.sql'), 'utf8')]): D1Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys
  for (const sql of schemas) db.exec(sql);
  return {
    prepare: (sql: string) => new Statement(db, sql),
    // One transaction, results in order, as D1 returns them.
    batch: async (stmts: Statement[]) => db.transaction(() => stmts.map((s) => s.runSync()))(),
  } as unknown as D1Database;
}

export function createTestKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  } as unknown as KVNamespace;
}

export function createTestR2(): R2Bucket & { objects: Map<string, { body: Uint8Array; options: unknown }> } {
  const objects = new Map<string, { body: Uint8Array; options: unknown }>();
  return {
    objects,
    put: async (key: string, body: Uint8Array, options: unknown) => {
      objects.set(key, { body: new Uint8Array(body), options });
      return { key } as unknown as R2Object;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    // Like R2: keys in order, at most `limit` (default and max 1000) per page, with a cursor while truncated.
    list: async ({ prefix = '', cursor, limit = 1000 }: R2ListOptions = {}) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
      const page = start < 0 ? [] : keys.slice(start, start + Math.min(limit, 1000));
      const truncated = start >= 0 && start + page.length < keys.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: page.at(-1) } : {}), delimitedPrefixes: [] } as unknown as R2Objects;
    },
  } as unknown as R2Bucket & { objects: typeof objects };
}
