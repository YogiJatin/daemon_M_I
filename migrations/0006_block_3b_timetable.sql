-- Migration 0006: Block 3B — College Timetable & Preparation Engine
--
-- Features:
-- - Normalized timetable tables: semesters, subjects, slots, materials, exceptions, holiday calendar
-- - Dedicated class_occurrences table for planned/attended/cancelled status and analytics
-- - Section support, external_id for calendar/ERP sync, subject color, material types & orders
-- - Extensible exception types and holiday scopes

-- 1. Timetable Semesters
CREATE TABLE IF NOT EXISTS timetable_semesters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  start_date      TEXT NOT NULL,                -- YYYY-MM-DD IST
  end_date        TEXT NOT NULL,                -- YYYY-MM-DD IST
  is_active       INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  external_id     TEXT,                         -- for external ERP/calendar sync
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timetable_semesters_active
  ON timetable_semesters(is_active);

-- 2. Timetable Subjects
CREATE TABLE IF NOT EXISTS timetable_subjects (
  id                    TEXT PRIMARY KEY,
  semester_id           TEXT NOT NULL REFERENCES timetable_semesters(id) ON DELETE CASCADE,
  code                  TEXT,
  name                  TEXT NOT NULL,
  faculty               TEXT,
  default_room          TEXT,
  color                 TEXT DEFAULT '#3b82f6', -- hex color for dashboards & calendar
  section_name          TEXT,                   -- optional section/batch
  preparation_minutes   INTEGER NOT NULL DEFAULT 45, -- reminder lead time
  external_id           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timetable_subjects_sem
  ON timetable_subjects(semester_id);

-- 3. Timetable Slots
CREATE TABLE IF NOT EXISTS timetable_slots (
  id                  TEXT PRIMARY KEY,
  semester_id         TEXT NOT NULL REFERENCES timetable_semesters(id) ON DELETE CASCADE,
  subject_id          TEXT NOT NULL REFERENCES timetable_subjects(id) ON DELETE CASCADE,
  weekday             INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1=Mon .. 7=Sun
  start_time          TEXT NOT NULL,            -- HH:mm IST
  end_time            TEXT NOT NULL,            -- HH:mm IST
  room                TEXT,
  week_pattern        TEXT NOT NULL DEFAULT 'every_week' CHECK (week_pattern IN ('every_week', 'alternate_a', 'alternate_b')),
  lab_batch           TEXT,                     -- e.g. "Batch A", "Batch B"
  week_anchor_monday  TEXT,                     -- YYYY-MM-DD IST anchor for A/B weeks
  section_name        TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  external_id         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timetable_slots_sem_active
  ON timetable_slots(semester_id, active, weekday);

-- 4. Timetable Preparation Materials
CREATE TABLE IF NOT EXISTS timetable_materials (
  id              TEXT PRIMARY KEY,
  slot_id         TEXT NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  material_type   TEXT NOT NULL DEFAULT 'other', -- 'calculator', 'lab_manual', 'observation_book', 'drawing_sheet', 'id_card', 'laptop', 'other'
  title           TEXT NOT NULL,
  notes           TEXT,
  required        INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  display_order   INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  external_id     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timetable_materials_slot
  ON timetable_materials(slot_id, active);

-- 5. Timetable Exceptions
CREATE TABLE IF NOT EXISTS timetable_exceptions (
  id              TEXT PRIMARY KEY,
  slot_id         TEXT REFERENCES timetable_slots(id) ON DELETE CASCADE, -- NULL for global/semester-wide
  exception_type  TEXT NOT NULL CHECK (exception_type IN ('cancelled', 'holiday', 'moved', 'extra_class', 'exam', 'special_event', 'no_classes', 'skip', 'move')),
  start_date      TEXT NOT NULL,                -- YYYY-MM-DD IST
  end_date        TEXT NOT NULL,                -- YYYY-MM-DD IST
  new_date        TEXT,                         -- for 'moved'
  new_start_time  TEXT,                         -- for 'moved'
  new_end_time    TEXT,                         -- for 'moved'
  reason          TEXT,
  external_id     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timetable_exceptions_dates
  ON timetable_exceptions(start_date, end_date);

-- 6. Holiday Calendar
CREATE TABLE IF NOT EXISTS holiday_calendar (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  holiday_date    TEXT NOT NULL UNIQUE,         -- YYYY-MM-DD IST
  is_full_day     INTEGER NOT NULL DEFAULT 1 CHECK (is_full_day IN (0, 1)),
  holiday_scope   TEXT NOT NULL DEFAULT 'college' CHECK (holiday_scope IN ('national', 'college', 'semester', 'department')),
  external_id     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holiday_date
  ON holiday_calendar(holiday_date);

-- 7. Dedicated Class Occurrences Table (immutable operational record for attendance/analytics)
CREATE TABLE IF NOT EXISTS class_occurrences (
  id                    TEXT PRIMARY KEY,
  slot_id               TEXT NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
  semester_id           TEXT NOT NULL REFERENCES timetable_semesters(id) ON DELETE CASCADE,
  subject_id            TEXT NOT NULL REFERENCES timetable_subjects(id) ON DELETE CASCADE,
  occurrence_date       TEXT NOT NULL,          -- YYYY-MM-DD IST
  start_time            TEXT NOT NULL,          -- HH:mm IST
  end_time              TEXT NOT NULL,          -- HH:mm IST
  room                  TEXT,
  status                TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'attended', 'cancelled', 'missed')),
  task_id               TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  prep_notification_id  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CONSTRAINT uq_slot_occurrence UNIQUE (slot_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_class_occurrences_date
  ON class_occurrences(occurrence_date, status);

CREATE INDEX IF NOT EXISTS idx_class_occurrences_subj
  ON class_occurrences(subject_id, occurrence_date);
