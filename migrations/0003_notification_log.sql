-- Migration 0003: Block 2A — notification_log and due-query indexes
--
-- State machine: pending → claimed → sent | failed | unknown | dead | suppressed
-- One row per dedup_key: {task_id}:{stage}:{deadline_version}
-- Claim pattern: conditional UPDATE … WHERE status='pending' AND scheduled_at <= now
-- Bounded batch: default 3, ceiling 5
-- Recovery: claimed rows with expired lease_expires_at are recovered to pending.

CREATE TABLE IF NOT EXISTS notification_log (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  deadline_version    INTEGER NOT NULL DEFAULT 1,
  stage               TEXT NOT NULL DEFAULT 'due',
  dedup_key           TEXT UNIQUE NOT NULL,
  notification_kind   TEXT NOT NULL DEFAULT 'individual'
                      CHECK (notification_kind IN ('individual', 'reminder', 'overdue')),
  scheduled_at        TEXT NOT NULL,                  -- UTC ISO instant
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','claimed','sent','failed','unknown','dead','suppressed')),
  claimed_at          TEXT,                           -- UTC ISO, set when cron claims this row
  lease_expires_at    TEXT,                           -- UTC ISO, claim expires if Worker crashes
  sent_at             TEXT,                           -- UTC ISO, confirmed delivery time
  retry_count         INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  details_json        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Primary cron query: find claimable due rows
CREATE INDEX IF NOT EXISTS idx_notif_due
  ON notification_log (status, scheduled_at)
  WHERE status = 'pending';

-- Recovery query: find stale claimed rows (expired lease)
CREATE INDEX IF NOT EXISTS idx_notif_stale_claims
  ON notification_log (status, lease_expires_at)
  WHERE status = 'claimed';

-- Lookup by task for suppression on deadline change
CREATE INDEX IF NOT EXISTS idx_notif_task
  ON notification_log (task_id, deadline_version, status);
