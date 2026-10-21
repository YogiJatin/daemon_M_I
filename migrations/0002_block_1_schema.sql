-- Migration 0002: Block 1 manual tasks schema
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  project TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'done', 'dismissed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  deadline_kind TEXT NOT NULL DEFAULT 'none' CHECK (deadline_kind IN ('none', 'date_only', 'timed')),
  deadline_local_date TEXT,
  deadline_time_local TEXT,
  deadline_at_utc TEXT,
  deadline_version INTEGER NOT NULL DEFAULT 1,
  source_event_id TEXT,
  recurrence_rule_id TEXT,
  occurrence_local_date TEXT,
  snoozed_until TEXT,
  snooze_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_date
  ON tasks(status, deadline_local_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deadline_utc
  ON tasks(status, deadline_at_utc);
CREATE INDEX IF NOT EXISTS idx_tasks_snooze
  ON tasks(status, snoozed_until);

CREATE TABLE IF NOT EXISTS source_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'telegram', 'pwa_share', 'future_connector')),
  source_ref TEXT,
  sender_hint TEXT,
  excerpt TEXT,
  dedup_hash TEXT,
  received_at TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'new' CHECK (processing_status IN ('new', 'processed', 'no_candidate', 'excluded', 'failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  lease_expires_at TEXT,
  outcome TEXT,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('owner:telegram', 'owner:web', 'system:scheduler', 'system:ai')),
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
