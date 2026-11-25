// The live database moves from the 2026.11.23.1 schema to schema.sql in two
// steps (see migrations/): 0001 only adds, so the old worker keeps running on
// it; 0002 drops the old report tables once old builds have aged out.

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(dir, path), 'utf8');
const OLD = read('test/schema-2026.11.23.1.sql');
const ADDITIVE = read('migrations/0001-additive.sql');
const DROP = read('migrations/later/0002-drop-old-reports.sql');
const END = read('schema.sql');

const NEW_TABLES = ['reports', 'verified_reporters', 'verify_challenges', 'removal_requests', 'removed_members', 'removal_log', 'daily_counts'];
const OLD_TABLES = ['account_reports', 'entity_reports'];

function open(...sql: string[]) {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const s of sql) db.exec(s);
  return db;
}

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

/** Tables, columns, indexes and foreign keys as SQLite reports them, not as the SQL text spells them. */
function shape(db: Database) {
  return Object.fromEntries(
    tables(db).map((t) => [
      t,
      {
        columns: db.query(`PRAGMA table_info(${t})`).all(),
        indexes: (db.query(`PRAGMA index_list(${t})`).all() as { name: string }[])
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((i) => ({ ...i, seq: undefined, columns: db.query(`PRAGMA index_xinfo(${i.name})`).all() })),
        foreignKeys: db.query(`PRAGMA foreign_key_list(${t})`).all(),
      },
    ]),
  );
}

/** Every row of every table, to show a migration left the data alone. */
const rows = (db: Database) => Object.fromEntries(tables(db).map((t) => [t, db.query(`SELECT * FROM ${t}`).all()]));

/** The old database with old-style reports in it. */
function oldWithRows() {
  const db = open(OLD);
  db.exec(`
    INSERT INTO accounts (member_id, slug, score, level, score_version, first_captured_at, last_captured_at) VALUES (700000001, 'jordan-sample', 40, 'medium', 5, 1, 1);
    INSERT INTO account_reports (member_id, score, ip_hash, created_at) VALUES (700000001, 40, 'h', 1);
    INSERT INTO entities (kind, entity_id, url, score, level, score_version, facts_json, signals_json, first_seen, last_seen, report_count) VALUES ('company', '4242', 'u', 60, 'high', 5, '{}', '{}', 1, 1, 1);
    INSERT INTO entity_reports (kind, entity_id, score, ip_hash, created_at) VALUES ('company', '4242', 60, 'h', 1);
  `);
  return db;
}

/** SQL without its comments. */
const code = (sql: string) => sql.replace(/--.*$/gm, '');
const statements = (sql: string) => code(sql).split(';').map((s) => s.trim()).filter(Boolean);

describe('0001-additive', () => {
  test('on the old database, keeps the old report tables and their rows, and adds every new table', () => {
    const db = oldWithRows();
    const before = rows(db);
    db.exec(ADDITIVE);
    for (const t of NEW_TABLES) expect(tables(db)).toContain(t);
    expect(rows(db)).toEqual({ ...before, ...Object.fromEntries(NEW_TABLES.map((t) => [t, []])) });
    expect(db.query('SELECT report_count FROM entities').all()).toEqual([{ report_count: 1 }]);
  });

  test('applied twice, the second run changes nothing', () => {
    const db = oldWithRows();
    db.exec(ADDITIVE);
    db.exec("INSERT INTO daily_counts (scope, subject, day, count) VALUES ('reports.reporter', 'h', '2026-11-24', 3)");
    const [s, r] = [shape(db), rows(db)];
    db.exec(ADDITIVE);
    expect(shape(db)).toEqual(s);
    expect(rows(db)).toEqual(r);
  });

  test('every statement in the default migrations folder only creates', () => {
    const files = readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(files).toEqual(['0001-additive.sql']);
    for (const f of files) {
      for (const s of statements(read(`migrations/${f}`))) expect(s).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
    }
  });
});

describe('0002-drop-old-reports', () => {
  test('old schema, then 0001, then 0002 matches schema.sql', () => {
    const db = oldWithRows();
    db.exec(ADDITIVE);
    db.exec(DROP);
    expect(shape(db)).toEqual(shape(open(END)));
    for (const t of OLD_TABLES) expect(tables(db)).not.toContain(t);
  });

  test('re-run after a partial run that dropped the old tables, it still reaches schema.sql', () => {
    const db = oldWithRows();
    db.exec(ADDITIVE);
    const drops = statements(DROP);
    expect(drops.at(-1)).toStartWith('ALTER TABLE entities DROP COLUMN report_count');
    for (const s of drops.slice(0, 2)) db.exec(s); // stopped before the index and the column
    db.exec(DROP);
    expect(shape(db)).toEqual(shape(open(END)));
  });

  test('run again after it finished, only the last statement fails, and the database is already at the end state', () => {
    const db = oldWithRows();
    db.exec(ADDITIVE);
    db.exec(DROP);
    const drops = statements(DROP);
    for (const s of drops.slice(0, -1)) db.exec(s);
    expect(() => db.exec(drops.at(-1)!)).toThrow(/no such column/);
    expect(shape(db)).toEqual(shape(open(END)));
  });
});

test('schema.sql is the full end state: it applies on its own and twice', () => {
  const db = open(END, END);
  for (const t of NEW_TABLES) expect(tables(db)).toContain(t);
  for (const t of OLD_TABLES) expect(tables(db)).not.toContain(t);
});
