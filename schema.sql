-- CC Medical Inventory — D1 schema
-- Run once:  npx wrangler d1 execute cc-inventory --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'standard',   -- 'admin' (can add/remove access) or 'standard'
  pw_hash      TEXT NOT NULL,
  pw_salt      TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  failed       INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT '',
  facility   TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,                   -- tag number, e.g. CC-261003-7K2Q
  kind         TEXT NOT NULL,                      -- 'stock', 'repair', 'return' (customer return) or 'core' (core return)
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  cond         TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  part_number  TEXT NOT NULL DEFAULT '',
  serial       TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',          -- RMA / order number for repairs, returns and cores
  cost         REAL,                              -- unit cost in dollars (blank = unknown)
  dom          TEXT NOT NULL DEFAULT '',          -- date of manufacture, 'YYYY-MM' or 'YYYY'
  source       TEXT NOT NULL DEFAULT 'app',       -- 'app', or 'import:<row>' for spreadsheet rows
  qty          INTEGER NOT NULL DEFAULT 1,
  location     TEXT NOT NULL DEFAULT '',
  customer_id  TEXT,
  status       TEXT NOT NULL,
  problems     TEXT NOT NULL DEFAULT '',          -- repair problems or return reasons
  notes        TEXT NOT NULL DEFAULT '',
  received_by  TEXT NOT NULL DEFAULT '',
  received_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_customer ON items(customer_id);
CREATE INDEX IF NOT EXISTS items_updated  ON items(updated_at);
CREATE INDEX IF NOT EXISTS items_part     ON items(part_number);
CREATE INDEX IF NOT EXISTS items_serial   ON items(serial COLLATE NOCASE);

-- Serial number registry: one permanent row per physical unit. Every intake with a serial
-- adds to it, and it stays even if an item record is deleted. Its full story is every item
-- with this serial plus their history.
CREATE TABLE IF NOT EXISTS serials (
  serial         TEXT PRIMARY KEY COLLATE NOCASE,
  manufacturer   TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  part_number    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT '',
  times_received INTEGER NOT NULL DEFAULT 0,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  last_item_id   TEXT,
  dom            TEXT NOT NULL DEFAULT '',          -- date of manufacture
  notes          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS serials_seen ON serials(last_seen);

-- Everything that ever happened to a serial-numbered unit. Never deleted.
CREATE TABLE IF NOT EXISTS serial_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  serial  TEXT NOT NULL COLLATE NOCASE,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL DEFAULT '',
  item_id TEXT,
  kind    TEXT NOT NULL DEFAULT '',
  what    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS serial_events_serial ON serial_events(serial);

CREATE TABLE IF NOT EXISTS history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL DEFAULT '',
  what    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_item ON history(item_id);
CREATE INDEX IF NOT EXISTS customers_updated ON customers(updated_at);

-- Deleted records, so open devices can drop them on their next refresh.
CREATE TABLE IF NOT EXISTS deletions (
  kind TEXT NOT NULL,        -- 'item', 'customer' or 'option'
  ref  TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deletions_at ON deletions(at);

-- Button choices. A value typed once becomes a button for everyone.
-- kind: category | condition | manufacturer | model (parent = manufacturer) | location | problem | reason
CREATE TABLE IF NOT EXISTS options (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL COLLATE NOCASE,
  parent     TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value, parent)
);
CREATE INDEX IF NOT EXISTS options_created ON options(created_at);

INSERT OR IGNORE INTO options (kind, value, parent, created_at) VALUES
  ('category','Ultrasound probe','',datetime('now')),
  ('category','Ultrasound system','',datetime('now')),
  ('category','System part','',datetime('now')),
  ('category','Accessory','',datetime('now')),
  ('condition','New','',datetime('now')),
  ('condition','Refurbished','',datetime('now')),
  ('condition','Used','',datetime('now')),
  ('condition','New - open box','',datetime('now')),
  ('condition','Demo','',datetime('now')),
  ('condition','Compatible','',datetime('now')),
  ('condition','Damaged / for parts','',datetime('now')),
  ('manufacturer','GE Healthcare','',datetime('now')),
  ('manufacturer','Philips','',datetime('now')),
  ('manufacturer','Siemens','',datetime('now')),
  ('manufacturer','Canon / Toshiba','',datetime('now')),
  ('manufacturer','Mindray / Zonare','',datetime('now')),
  ('manufacturer','Samsung','',datetime('now')),
  ('manufacturer','SonoSite / Fujifilm','',datetime('now')),
  ('manufacturer','BK Medical','',datetime('now')),
  ('manufacturer','Hitachi','',datetime('now')),
  ('problem','No image','',datetime('now')),
  ('problem','Dropout / dead elements','',datetime('now')),
  ('problem','Cracked or damaged lens','',datetime('now')),
  ('problem','Cable damage','',datetime('now')),
  ('problem','Delamination','',datetime('now')),
  ('problem','Not recognized by system','',datetime('now')),
  ('problem','Housing crack','',datetime('now')),
  ('reason','Rental ended','',datetime('now')),
  ('reason','Defective / not working','',datetime('now')),
  ('reason','Wrong item shipped','',datetime('now')),
  ('reason','No longer needed','',datetime('now')),
  ('reason','Warranty claim','',datetime('now'));
