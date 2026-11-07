-- migrations/0020_desktop_outbox.sql
-- Block 3: Desktop Outbox Mirror & Device Pairing Schema

CREATE TABLE IF NOT EXISTS mirror_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  target_folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'claimed', 'delivered', 'conflict', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_until TEXT,
  written_path TEXT,
  last_error TEXT,
  conflict_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mirror_outbox_status ON mirror_outbox(status);
CREATE INDEX IF NOT EXISTS idx_mirror_outbox_dedupe ON mirror_outbox(dedupe_key);

CREATE TABLE IF NOT EXISTS desktop_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  agent_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_desktop_devices_token ON desktop_devices(token_sha256);

CREATE TABLE IF NOT EXISTS desktop_pairing_codes (
  code_sha256 TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
