-- Migration 0007: Block 4 — Authentication, Sessions, Inbox & OS Service Foundations
--
-- Features:
-- - One-use pairing challenge ledger with 5-minute expiry
-- - Secure authenticated sessions storing SHA-256 hashed tokens at rest
-- - Generic Inbox items table for share-target / multi-modal captures
-- - Workspace compatibility foundation (defaulting to 'default')

-- 1. Pairing Challenges (One-use 5-minute Telegram authentication challenge)
CREATE TABLE IF NOT EXISTS pairing_challenges (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  owner_user_id   TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_code 
  ON pairing_challenges(code, expires_at);

-- 2. Auth Sessions (Owner browser/client sessions, tokens hashed at rest)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE, -- SHA-256 hex digest of session token
  owner_user_id   TEXT NOT NULL,
  workspace_id    TEXT NOT NULL DEFAULT 'default',
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  user_agent      TEXT,
  ip_address      TEXT,
  last_seen_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_hash 
  ON auth_sessions(token_hash, revoked_at, expires_at);

-- 3. Generic Inbox Items (Capture / Share Target Abstraction)
CREATE TABLE IF NOT EXISTS inbox_items (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL DEFAULT 'default',
  content_type                TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'url', 'image', 'voice', 'clipboard', 'file', 'email', 'screenshot', 'other')),
  raw_payload                 TEXT NOT NULL,
  parsed_title                TEXT,
  parsed_deadline_local_date  TEXT,
  parsed_deadline_time_local  TEXT,
  parsed_category             TEXT,
  status                      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded', 'archived')),
  task_id                     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source                      TEXT NOT NULL DEFAULT 'web_share',
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_status
  ON inbox_items(status, created_at);
