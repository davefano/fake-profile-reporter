-- D1 schema for Fake LinkedIn Reporter.
-- Apply with: wrangler d1 execute flr --remote --file=./schema.sql


-- Accounts keyed by LinkedIn's stable member ID (slugs change; member IDs don't).
-- Only what the leaderboard lists and sorts by; the full current facts are in
-- account_current, and history in account_snapshots.
CREATE TABLE IF NOT EXISTS accounts (
  member_id          INTEGER PRIMARY KEY,
  slug               TEXT,
  first_name         TEXT,
  last_name          TEXT,
  headline           TEXT,
  score              INTEGER NOT NULL,
  level              TEXT NOT NULL,
  score_version      INTEGER NOT NULL,
  first_captured_at  INTEGER NOT NULL,
  last_captured_at   INTEGER NOT NULL,
  snapshot_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_accounts_score ON accounts(score);

-- One row per captured snapshot. The raw payload is in R2 at r2_key.
CREATE TABLE IF NOT EXISTS account_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL,
  captured_at   INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  version_tag   TEXT,
  score         INTEGER NOT NULL,
  facts_json    TEXT NOT NULL,
  signals_json  TEXT NOT NULL,        -- the full Score: { signals, missing, ... }
  changes_json  TEXT NOT NULL,        -- diff vs. the previous snapshot
  ip_hash       TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_member ON account_snapshots(member_id, captured_at);

-- What each account looks like now: the newest capture, with parts it failed
-- to load carried forward from earlier ones (see observeProfile). Moves by
-- compare-and-swap on captured_at, so concurrent uploads can't lose facts.
CREATE TABLE IF NOT EXISTS account_current (
  member_id    INTEGER PRIMARY KEY,
  captured_at  INTEGER NOT NULL,
  facts_json   TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

-- Reports that an account looks suspicious, one per reporter per day. The
-- score is the account's score at report time.
CREATE TABLE IF NOT EXISTS account_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

CREATE INDEX IF NOT EXISTS idx_account_reports_member ON account_reports(member_id, created_at);

-- Every slug an account has been seen under.
CREATE TABLE IF NOT EXISTS account_slugs (
  member_id   INTEGER NOT NULL,
  slug        TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (member_id, slug),
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

-- Company pages and job postings. One row per thing, keyed by kind + LinkedIn ID
-- (numeric company ID, or job ID). Facts come from LinkedIn's public pages; the
-- score is recomputed here from those facts, never taken from the client.
CREATE TABLE IF NOT EXISTS entities (
  kind TEXT NOT NULL CHECK (kind IN ('company', 'job')),
  entity_id TEXT NOT NULL,
  name TEXT,
  url TEXT NOT NULL,
  score INTEGER NOT NULL,
  level TEXT NOT NULL,
  score_version INTEGER NOT NULL,
  facts_json TEXT NOT NULL,
  signals_json TEXT NOT NULL, -- the full Score: { signals, missing, ... }
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_reports ON entities (kind, report_count DESC);

CREATE TABLE IF NOT EXISTS entity_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (kind, entity_id) REFERENCES entities (kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_reports_entity ON entity_reports (kind, entity_id, created_at DESC);
