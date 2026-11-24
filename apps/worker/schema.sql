-- D1 schema for Fake Profile Reporter.
-- Apply with: wrangler d1 execute fpr --remote --file=./schema.sql


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
  changes_json  TEXT NOT NULL,        -- diff vs. the account's current facts when recorded; [] for backfills
  ip_hash       TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_member ON account_snapshots(member_id, captured_at);
-- Keys are content hashes: the same capture is stored once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_r2_key ON account_snapshots(r2_key);

-- What each account looks like now: the newest capture, with parts it failed
-- to load carried forward from earlier ones (see observeProfile). Moves by
-- compare-and-swap on rev, in one transaction with everything that depends on
-- it, so concurrent uploads can't lose facts or leave the listing stale.
CREATE TABLE IF NOT EXISTS account_current (
  member_id    INTEGER PRIMARY KEY,
  rev          TEXT NOT NULL,         -- random per write: the compare-and-swap token
  captured_at  INTEGER NOT NULL,      -- for ordering captures, not for concurrency
  facts_json   TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES accounts(member_id)
);

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
  PRIMARY KEY (kind, entity_id)
);

-- What people say about a saved profile, company or job: one row per reporter
-- per target, which they can edit or withdraw. The reporter is a hash of a
-- secret key the extension keeps, so only its holder can change the row.
-- stance: 'report' (looks suspicious), 'impersonated' (someone used this
-- person's identity; never counts against the profile), 'vouch' (real).
-- note is private: stored for building heuristics, never returned by the API.
-- score_json is the target's Score when the report was last written.
CREATE TABLE IF NOT EXISTS reports (
  kind          TEXT NOT NULL CHECK (kind IN ('profile', 'company', 'job')),
  target_id     TEXT NOT NULL,        -- member ID for profiles, LinkedIn ID for companies and jobs
  reporter      TEXT NOT NULL,
  stance        TEXT NOT NULL CHECK (stance IN ('report', 'impersonated', 'vouch')),
  reasons_json  TEXT NOT NULL,
  confidence    TEXT CHECK (confidence IN ('suspected', 'confirmed')),
  note          TEXT,
  score_json    TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  withdrawn_at  INTEGER,
  PRIMARY KEY (kind, target_id, reporter)
);

CREATE INDEX IF NOT EXISTS idx_reports_active ON reports(kind, target_id, stance) WHERE withdrawn_at IS NULL;

-- Reporter keys that passed the bot check, by reporter hash. Good until expires_at.
CREATE TABLE IF NOT EXISTS verified_reporters (
  reporter     TEXT PRIMARY KEY,
  verified_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verified_reporters_expires ON verified_reporters(expires_at);

-- Bot checks handed out and not yet used. The random ID travels in the
-- verify URL and as the widget's cData, so the key never does. Used once:
-- verifying deletes the row and returns it in one statement.
CREATE TABLE IF NOT EXISTS verify_challenges (
  id          TEXT PRIMARY KEY,
  reporter    TEXT NOT NULL,          -- reporter hash it was issued to
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verify_challenges_expires ON verify_challenges(expires_at);

-- Requests from people to have their own profile removed, for the maintainer
-- to review. No foreign key: approving deletes the account the request names.
-- status: 'pending', 'approved_r2_pending' (D1 rows deleted, R2 sweep not yet
-- finished), 'approved', 'denied_code' (code not found: blocks only this
-- requester), 'denied_merits' (blocks the profile for 90 days), 'restored'.
-- contact is cleared on any decision, and after 90 days pending.
CREATE TABLE IF NOT EXISTS removal_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL,
  reporter    TEXT NOT NULL,          -- reporter hash of the requester
  ip_hash     TEXT NOT NULL,
  code        TEXT NOT NULL,          -- what the requester placed in their headline or About
  contact     TEXT,                   -- optional, at most 200 characters
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_removal_requests_member ON removal_requests(member_id, status);
CREATE INDEX IF NOT EXISTS idx_removal_requests_status ON removal_requests(status, created_at);

-- Profiles removed at their owner's request. Saves and reports of them are
-- refused; reads answer not found.
CREATE TABLE IF NOT EXISTS removed_members (
  member_id   INTEGER PRIMARY KEY,
  request_id  INTEGER,
  removed_at  INTEGER NOT NULL
);

-- One row per maintainer decision. Never holds the contact.
-- action: 'approve', 'deny_code', 'deny_merits', 'restore'.
CREATE TABLE IF NOT EXISTS removal_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER,                -- null for a restore, which acts on the member
  member_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Daily caps, counted atomically: one increment-and-return per check.
-- scope names the cap and whose it is, e.g. 'reports.reporter' or 'reports.ip';
-- subject is the reporter hash or IP hash; day is the UTC date (YYYY-MM-DD).
-- Earlier days are deleted on increment.
CREATE TABLE IF NOT EXISTS daily_counts (
  scope    TEXT NOT NULL,
  subject  TEXT NOT NULL,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (scope, subject, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_counts_day ON daily_counts(day);
