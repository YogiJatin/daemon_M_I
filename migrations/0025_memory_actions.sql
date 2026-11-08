-- migrations/0025_memory_actions.sql
-- Stage 2: memory forget/remember actions, soft delete, and mirror job actions.
--
-- NOTE: SQLite has no "ADD COLUMN IF NOT EXISTS". A fresh database applies every
-- ALTER below. An already-drifted database must use scripts/apply_migration_0025.ts,
-- which checks PRAGMA table_info first and applies only what is missing.

CREATE TABLE IF NOT EXISTS memory_proposals (
  id              TEXT PRIMARY KEY,
  canonical_text  TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'telegram_ai_suggested',
  trust           TEXT NOT NULL DEFAULT 'medium',
  sensitivity     TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'pending',
  replaces_id     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status);

ALTER TABLE memory_objects ADD COLUMN trust TEXT NOT NULL DEFAULT 'high';
ALTER TABLE memory_objects ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE memory_objects ADD COLUMN expires_at TEXT;
ALTER TABLE memory_objects ADD COLUMN last_used_at TEXT;
ALTER TABLE memory_objects ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_objects_deleted ON memory_objects(deleted_at);

ALTER TABLE mirror_outbox ADD COLUMN action TEXT NOT NULL DEFAULT 'upsert';

CREATE INDEX IF NOT EXISTS idx_mirror_outbox_action ON mirror_outbox(action);
