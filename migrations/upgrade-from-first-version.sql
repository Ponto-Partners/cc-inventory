-- Only needed if you set up the database with an EARLIER schema.sql
-- (before part numbers, returns, cost and the serial registry). New installs: just run schema.sql.
--   npx wrangler d1 execute cc-inventory --remote --file=migrations/upgrade-from-first-version.sql
-- then run schema.sql again (it only adds what's missing).
-- If a line fails with "duplicate column name", that column already exists: delete the line and run again.
ALTER TABLE items ADD COLUMN part_number TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN ref TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN cost REAL;
ALTER TABLE items ADD COLUMN dom TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'app';
UPDATE items SET status = 'Pending' WHERE status = 'Reserved';
