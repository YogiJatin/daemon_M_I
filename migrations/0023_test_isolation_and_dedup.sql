-- Migration 0023: Test Isolation, Deduplication, and Bulk Action Auditing
-- SRS & Fix Pass 2 (F3, F4, F6)

-- 1. Test run isolation columns
ALTER TABLE tasks ADD COLUMN test_run_id TEXT;
ALTER TABLE tasks ADD COLUMN batch_id TEXT;
ALTER TABLE tasks ADD COLUMN completed_via TEXT;

ALTER TABLE notification_log ADD COLUMN test_run_id TEXT;
ALTER TABLE task_proposals ADD COLUMN test_run_id TEXT;
ALTER TABLE chat_messages ADD COLUMN test_run_id TEXT;
ALTER TABLE chat_messages ADD COLUMN offline_reason TEXT;
ALTER TABLE daily_overrides ADD COLUMN test_run_id TEXT;

-- 2. Indexes for test cleanup
CREATE INDEX IF NOT EXISTS idx_tasks_test_run_id ON tasks(test_run_id);
CREATE INDEX IF NOT EXISTS idx_notif_test_run_id ON notification_log(test_run_id);
CREATE INDEX IF NOT EXISTS idx_proposals_test_run_id ON task_proposals(test_run_id);
CREATE INDEX IF NOT EXISTS idx_chat_test_run_id ON chat_messages(test_run_id);
CREATE INDEX IF NOT EXISTS idx_overrides_test_run_id ON daily_overrides(test_run_id);

-- 3. Unique deduplication indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_task_stage_scheduled 
  ON notification_log(task_id, stage, scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_occurrences_slot_date 
  ON class_occurrences(slot_id, occurrence_date);

-- 4. Bulk operations and batch tables
CREATE TABLE IF NOT EXISTS bulk_batches (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  affected_ids_json TEXT NOT NULL,
  snapshot_hash TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT
);

CREATE TABLE IF NOT EXISTS bulk_pending_operations (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  filter_type TEXT NOT NULL,
  id_snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
