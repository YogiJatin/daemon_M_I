-- Migration 0004: Block 2B — daily attention budget, caps, and pause episodes
--
-- 1. Daily notification counters for atomic cap reservation
CREATE TABLE IF NOT EXISTS daily_notification_counters (
  local_date TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reserved_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_date, channel)
);

-- 2. Cap reservation tracking on notification_log
ALTER TABLE notification_log ADD COLUMN cap_reservation_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE notification_log ADD COLUMN cap_reservation_local_date TEXT;

-- 3. Pause episodes for unique incident IDs and catch-up digests
CREATE TABLE IF NOT EXISTS pause_episodes (
  id TEXT PRIMARY KEY,
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  catchup_status TEXT NOT NULL DEFAULT 'pending' CHECK (catchup_status IN ('pending', 'planned', 'sent', 'none')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
