-- Migration 0016: Block 1 - Conversational Telegram AI Assistant
-- Creates chat_messages (audit log), capture_feedback (implicit capture learning),
-- and per-chat lease tracking.

CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,          -- msg_<ulid>
  update_id       INTEGER NOT NULL,
  chat_id         TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'assistant', 'system')),
  text            TEXT,
  intent          TEXT,
  confidence      REAL,
  provider        TEXT,
  latency_ms      INTEGER,
  outcome         TEXT,
  status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'sent', 'failed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_update_id ON chat_messages(update_id);

CREATE TABLE IF NOT EXISTS capture_feedback (
  id                  TEXT PRIMARY KEY,
  normalized_phrase   TEXT NOT NULL UNIQUE,
  rejection_count     INTEGER NOT NULL DEFAULT 1,
  last_rejected_at    TEXT NOT NULL,
  decay_factor        REAL NOT NULL DEFAULT 1.0,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_feedback_phrase ON capture_feedback(normalized_phrase);

-- Per-chat conversation lease (serialises rapid incoming messages per chat)
CREATE TABLE IF NOT EXISTS chat_leases (
  chat_id         TEXT PRIMARY KEY,
  update_id       INTEGER NOT NULL,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
