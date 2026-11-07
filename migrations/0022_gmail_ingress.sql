-- Migration 0022: Gmail Read-Only Ingress (Phase 4 / Block 5)
-- Rule 26 Amendment: Read-only mailbox access solely to draft task_proposals.
-- No send, delete, label or modify.
-- No raw email bodies stored.
-- Tokens encrypted at rest with AES-256-GCM.

CREATE TABLE IF NOT EXISTS gmail_auth (
  id TEXT PRIMARY KEY DEFAULT 'primary',
  status TEXT NOT NULL DEFAULT 'disconnected', -- 'disconnected', 'connected', 'revoked', 'disabled_invalid_grant'
  encrypted_refresh_token TEXT,
  scopes TEXT NOT NULL DEFAULT 'https://www.googleapis.com/auth/gmail.readonly',
  email_address TEXT,
  last_polled_at TEXT,
  history_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gmail_ingress_seen (
  message_id TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  subject_truncated TEXT NOT NULL,
  proposal_ids_json TEXT NOT NULL DEFAULT '[]',
  dkim_status TEXT NOT NULL DEFAULT 'unknown',
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_seen_domain ON gmail_ingress_seen(sender_domain);
CREATE INDEX IF NOT EXISTS idx_gmail_seen_processed ON gmail_ingress_seen(processed_at);

-- Default row in gmail_auth
INSERT OR IGNORE INTO gmail_auth (id, status, is_active, updated_at)
VALUES ('primary', 'disconnected', 1, datetime('now'));
