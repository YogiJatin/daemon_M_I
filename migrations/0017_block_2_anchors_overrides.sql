-- Migration 0017: Block 2 - Daily Rhythm Profile, Extended Anchors & Daily Overrides
-- Extends task_proposals and tasks with reminder anchor metadata.
-- Creates daily_overrides and anchor_corrections.

ALTER TABLE task_proposals ADD COLUMN remind_local_date TEXT;
ALTER TABLE task_proposals ADD COLUMN remind_local_time TEXT;
ALTER TABLE task_proposals ADD COLUMN remind_anchor TEXT;
ALTER TABLE task_proposals ADD COLUMN remind_offset_min INTEGER;
ALTER TABLE task_proposals ADD COLUMN remind_resolution_source TEXT;

ALTER TABLE tasks ADD COLUMN remind_anchor TEXT;
ALTER TABLE tasks ADD COLUMN remind_offset_min INTEGER;
ALTER TABLE tasks ADD COLUMN remind_resolution_source TEXT DEFAULT 'static';

-- Backfill existing rows as non-recomputable
UPDATE tasks SET remind_resolution_source = 'static' WHERE remind_resolution_source IS NULL;

-- Daily Overrides (schedule_exception)
CREATE TABLE IF NOT EXISTS daily_overrides (
  id                      TEXT PRIMARY KEY,
  date_ist                TEXT NOT NULL,
  anchor_key              TEXT NOT NULL CHECK (anchor_key IN ('leaving_college', 'class_end', 'first_class_start', 'cancel_class')),
  mode                    TEXT NOT NULL CHECK (mode IN ('absolute', 'delta')),
  value                   TEXT NOT NULL,
  source_chat_message_id  TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_overrides_date ON daily_overrides(date_ist, status);

-- Anchor Corrections Learning Log
CREATE TABLE IF NOT EXISTS anchor_corrections (
  id              TEXT PRIMARY KEY,
  anchor_key      TEXT NOT NULL,
  requested_time  TEXT NOT NULL,
  chosen_time     TEXT NOT NULL,
  delta_min       INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anchor_corrections_key ON anchor_corrections(anchor_key, created_at DESC);
