-- D1 schema for Fake LinkedIn Reporter.
-- Apply with: wrangler d1 execute flr --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS profiles (
  profile_url   TEXT PRIMARY KEY,
  handle        TEXT,
  name          TEXT,
  headline      TEXT,
  photo_url     TEXT,
  first_seen    INTEGER NOT NULL,
  last_reported INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_url   TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  score         INTEGER NOT NULL,
  level         TEXT NOT NULL,
  reasons_json  TEXT NOT NULL,
  profile_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (profile_url) REFERENCES profiles(profile_url)
);

CREATE INDEX IF NOT EXISTS idx_reports_profile ON reports(profile_url);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
