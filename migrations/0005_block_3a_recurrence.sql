-- Migration 0005: Block 3A — Recurrence rules and occurrence tracking
--
-- Requirements:
-- - Dedicated recurrence_rules template table
-- - JSON array for weekdays (no CSV)
-- - Unique constraint on (recurrence_rule_id, occurrence_local_date) for duplicate prevention
-- - Monotonic occurrence_number and series_version tracking
-- - Generation lease with generation_claimed_at and generation_lease_until

CREATE TABLE IF NOT EXISTS recurrence_rules (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  description             TEXT,
  category                TEXT,
  pattern                 TEXT NOT NULL CHECK (pattern IN ('daily', 'weekly', 'selected_weekdays', 'alternate_week_a', 'alternate_week_b', 'monthly', 'yearly')),
  interval                INTEGER NOT NULL DEFAULT 1,
  weekdays_json           TEXT,                           -- JSON array of integers: [1..7] where 1=Mon, 7=Sun
  month_day               INTEGER,                        -- 1..31, or -1 for last day of month
  year_month              INTEGER,                        -- 1..12 for yearly rules
  local_time              TEXT,                           -- Optional "HH:mm" in IST
  timezone                TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  start_date              TEXT NOT NULL,                  -- "YYYY-MM-DD" IST
  end_date                TEXT,                           -- Optional "YYYY-MM-DD" IST
  week_anchor_monday      TEXT,                           -- Mandatory for alternating weeks ("YYYY-MM-DD")
  next_generation_date    TEXT,                           -- "YYYY-MM-DD" IST
  active                  INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  series_version          INTEGER NOT NULL DEFAULT 1,
  generation_claimed_at   TEXT,                           -- UTC ISO
  generation_lease_until  TEXT,                           -- UTC ISO
  last_occurrence_number  INTEGER NOT NULL DEFAULT 0,
  default_priority        TEXT NOT NULL DEFAULT 'normal' CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rec_rules_active_next
  ON recurrence_rules(active, next_generation_date);

CREATE INDEX IF NOT EXISTS idx_rec_rules_lease
  ON recurrence_rules(generation_lease_until);

ALTER TABLE tasks ADD COLUMN occurrence_number INTEGER;
ALTER TABLE tasks ADD COLUMN series_version INTEGER DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_occurrence
  ON tasks(recurrence_rule_id, occurrence_local_date)
  WHERE recurrence_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_rec_rule
  ON tasks(recurrence_rule_id, status);
