-- Step 2 of 2 to reports v2: drops the reports that builds up to 2026.11.23.1
-- wrote. Kept out of migrations/ so nobody applies it by habit. Run it only
-- after those builds have aged out, after comparing the old tables' row
-- counts by hand (their rows aren't copied into reports), and after a Time
-- Travel bookmark. There is no going back from it.
--   wrangler d1 execute fpr --remote --file=./migrations/later/0002-drop-old-reports.sql
--
-- Re-runnable: every step but the last skips what's already gone. If only the
-- last statement fails ("no such column: report_count"), the database is
-- already at the end state.

DROP TABLE IF EXISTS account_reports;
DROP TABLE IF EXISTS entity_reports;
DROP INDEX IF EXISTS idx_entities_reports;
ALTER TABLE entities DROP COLUMN report_count;
