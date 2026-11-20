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

  async run() {
    // Like D1: meta.changes counts the rows the statement wrote.
    const r = this.db.query(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: r.changes } };
  }
}

export function createTestD1(): D1Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys
  db.exec(readFileSync(join(import.meta.dir, '../schema.sql'), 'utf8'));
  return {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => db.transaction(() => stmts.map((s) => s.run()))(),
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
  } as unknown as R2Bucket & { objects: typeof objects };
}
