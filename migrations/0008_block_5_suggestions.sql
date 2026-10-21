-- Migration 0008: Block 5 — Suggestion Dismissals
--
-- Features:
-- - Tracks dismissals of deterministic suggestions by stable key and context version hash
-- - Resurfaces suggestion when context/version materially changes or when expires_at passes

CREATE TABLE IF NOT EXISTS suggestion_dismissals (
  id                TEXT PRIMARY KEY,
  suggestion_key    TEXT NOT NULL UNIQUE,
  dismissed_version TEXT NOT NULL,
  dismissed_at      TEXT NOT NULL,
  expires_at        TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggestion_dismissals_expires
  ON suggestion_dismissals(expires_at);
