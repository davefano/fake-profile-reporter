-- Reports you can edit and withdraw, with reasons and vouches. Replaces
-- account_reports, entity_reports and entities.report_count. Written for the
-- live database while those tables are still empty: it doesn't copy rows.
-- Apply once with:
--   wrangler d1 execute fpr --remote --file=./migrations/0001-reports.sql

DROP TABLE IF EXISTS account_reports;
DROP TABLE IF EXISTS entity_reports;
DROP INDEX IF EXISTS idx_entities_reports;
ALTER TABLE entities DROP COLUMN report_count;

CREATE TABLE IF NOT EXISTS reports (
  kind          TEXT NOT NULL CHECK (kind IN ('profile', 'company', 'job')),
  target_id     TEXT NOT NULL,
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
