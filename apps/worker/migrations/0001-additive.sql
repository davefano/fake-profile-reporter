-- Step 1 of 2 to reports v2: adds every new table, and nothing else. The
-- worker running before it ignores these tables, and the one after it needs
-- them, so this runs before the deploy. Each statement only creates if
-- missing, so it is safe to re-run, whole or in part. The old report tables
-- stay until migrations/later/0002-drop-old-reports.sql.
-- Apply once with:
--   wrangler d1 execute fpr --remote --file=./migrations/0001-additive.sql

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
