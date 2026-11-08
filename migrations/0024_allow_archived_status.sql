-- Migration 0024: Safe rebuild of tasks to allow 'archived' and 'completed' statuses

-- 1. Backup referencing tables to temp
CREATE TABLE _backup_notif AS SELECT * FROM notification_log;
CREATE TABLE _backup_class_occ AS SELECT * FROM class_occurrences;
CREATE TABLE _backup_proposals AS SELECT * FROM task_proposals;

-- 2. Drop referencing tables so tasks has zero foreign key inbound references
DROP TABLE notification_log;
DROP TABLE class_occurrences;
DROP TABLE task_proposals;

-- 3. Create tasks_new with expanded status CHECK constraint
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  project TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'done', 'dismissed', 'archived', 'completed')),
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
  updated_at TEXT NOT NULL,
  occurrence_number INTEGER,
  series_version INTEGER DEFAULT 1,
  remind_anchor TEXT,
  remind_offset_min INTEGER,
  remind_resolution_source TEXT DEFAULT 'static',
  test_run_id TEXT,
  batch_id TEXT,
  completed_via TEXT
);

-- 4. Copy existing task rows
INSERT INTO tasks_new SELECT * FROM tasks;

-- 5. Drop old tasks table and rename tasks_new to tasks
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- 6. Recreate tasks indexes
CREATE INDEX idx_tasks_status_date ON tasks(status, deadline_local_date);
CREATE INDEX idx_tasks_status_deadline_utc ON tasks(status, deadline_at_utc);
CREATE INDEX idx_tasks_snooze ON tasks(status, snoozed_until);
CREATE UNIQUE INDEX uq_task_occurrence ON tasks(recurrence_rule_id, occurrence_local_date) WHERE recurrence_rule_id IS NOT NULL;
CREATE INDEX idx_tasks_rec_rule ON tasks(recurrence_rule_id, status);
CREATE INDEX idx_tasks_test_run_id ON tasks(test_run_id);

-- 7. Recreate notification_log table and indexes
CREATE TABLE notification_log (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  deadline_version    INTEGER NOT NULL DEFAULT 1,
  stage               TEXT NOT NULL DEFAULT 'due',
  dedup_key           TEXT UNIQUE NOT NULL,
  notification_kind   TEXT NOT NULL DEFAULT 'individual'
                      CHECK (notification_kind IN ('individual', 'reminder', 'overdue')),
  scheduled_at        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','claimed','sent','failed','unknown','dead','suppressed')),
  claimed_at          TEXT,
  lease_expires_at    TEXT,
  sent_at             TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  details_json        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  cap_reservation_state TEXT NOT NULL DEFAULT 'none',
  cap_reservation_local_date TEXT,
  test_run_id         TEXT
);

INSERT INTO notification_log SELECT * FROM _backup_notif;
DROP TABLE _backup_notif;

CREATE INDEX idx_notif_due ON notification_log (status, scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_notif_stale_claims ON notification_log (status, lease_expires_at) WHERE status = 'claimed';
CREATE INDEX idx_notif_task ON notification_log (task_id, deadline_version, status);
CREATE INDEX idx_notif_test_run_id ON notification_log(test_run_id);
CREATE UNIQUE INDEX idx_notification_task_stage_scheduled ON notification_log(task_id, stage, scheduled_at);

-- 8. Recreate class_occurrences table and indexes
CREATE TABLE class_occurrences (
  id                    TEXT PRIMARY KEY,
  slot_id               TEXT NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  semester_id           TEXT NOT NULL REFERENCES timetable_semesters(id) ON DELETE CASCADE,
  subject_id            TEXT NOT NULL REFERENCES timetable_subjects(id) ON DELETE CASCADE,
  occurrence_date       TEXT NOT NULL,
  start_time            TEXT NOT NULL,
  end_time              TEXT NOT NULL,
  room                  TEXT,
  status                TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'attended', 'cancelled', 'missed')),
  task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  prep_notification_id  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CONSTRAINT uq_slot_occurrence UNIQUE (slot_id, occurrence_date)
);

INSERT INTO class_occurrences SELECT * FROM _backup_class_occ;
DROP TABLE _backup_class_occ;

CREATE INDEX idx_class_occurrences_date ON class_occurrences(occurrence_date, status);
CREATE INDEX idx_class_occurrences_subj ON class_occurrences(subject_id, occurrence_date);
CREATE UNIQUE INDEX idx_class_occurrences_slot_date ON class_occurrences(slot_id, occurrence_date);

-- 9. Recreate task_proposals table and indexes
CREATE TABLE task_proposals (
  id                  TEXT PRIMARY KEY,
  source_event_id     TEXT REFERENCES source_events(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  category            TEXT DEFAULT 'general',
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  date_role           TEXT NOT NULL DEFAULT 'deadline' CHECK (date_role IN ('deadline', 'event_start', 'event_end', 'reminder_time', 'unknown')),
  proposed_local_date TEXT,
  proposed_local_time TEXT,
  evidence_quote      TEXT,
  ambiguity_reasons   TEXT,
  advisory_confidence REAL NOT NULL DEFAULT 1.0,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed')),
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  reviewed_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  remind_local_date   TEXT,
  remind_local_time   TEXT,
  remind_anchor       TEXT,
  remind_offset_min   INTEGER,
  remind_resolution_source TEXT,
  test_run_id         TEXT
);

INSERT INTO task_proposals SELECT * FROM _backup_proposals;
DROP TABLE _backup_proposals;

CREATE INDEX idx_task_proposals_status ON task_proposals(status, created_at);
CREATE INDEX idx_proposals_test_run_id ON task_proposals(test_run_id);

-- 10. Update the 157 residue tasks to 'archived'
UPDATE tasks 
SET status = 'archived' 
WHERE batch_id = 'batch_d5_residue_archival_20261108';
