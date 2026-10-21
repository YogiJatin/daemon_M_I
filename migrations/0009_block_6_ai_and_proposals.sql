-- Migration 0009: Block 6 — AI Capabilities, Task Proposals & Provider Health
--
-- Features:
-- - task_proposals table for human-in-the-loop review of AI-generated tasks (SRS §8.4)
-- - provider_health table tracking circuit breakers, latency, and failure rates (SRS §8.12)
-- - ai_evaluations table for opt-in owner feedback logging (SRS §7.8 FR-AI-010)

-- 1. Task Proposals (SRS §8.4)
CREATE TABLE IF NOT EXISTS task_proposals (
  id                  TEXT PRIMARY KEY,
  source_event_id     TEXT REFERENCES source_events(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  category            TEXT DEFAULT 'general',
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  date_role           TEXT NOT NULL DEFAULT 'deadline' CHECK (date_role IN ('deadline', 'event_start', 'event_end', 'reminder_time', 'unknown')),
  proposed_local_date TEXT,                        -- YYYY-MM-DD IST
  proposed_local_time TEXT,                        -- HH:mm IST
  evidence_quote      TEXT,                        -- Citation from user prompt/context
  ambiguity_reasons   TEXT,                        -- Explanation if prompt was vague
  advisory_confidence REAL NOT NULL DEFAULT 1.0,   -- 0.0 to 1.0
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed')),
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL, -- Populated upon confirmation
  reviewed_at         TEXT,                        -- UTC ISO
  created_at          TEXT NOT NULL,               -- UTC ISO
  updated_at          TEXT NOT NULL                -- UTC ISO
);

CREATE INDEX IF NOT EXISTS idx_task_proposals_status
  ON task_proposals(status, created_at);

-- 2. Provider Health & Circuit State (SRS §8.12)
CREATE TABLE IF NOT EXISTS provider_health (
  provider            TEXT PRIMARY KEY,            -- e.g. 'groq', 'workers_ai', 'gemini', 'mock'
  model               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'cooldown', 'degraded', 'offline')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until      TEXT,                        -- UTC ISO
  last_success_at     TEXT,                        -- UTC ISO
  last_failure_at     TEXT,                        -- UTC ISO
  last_failure_code   TEXT,                        -- e.g. '429', '503', 'timeout'
  total_requests      INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms      INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL                -- UTC ISO
);

-- 3. AI Evaluations (SRS §7.8 FR-AI-010, opt-in feedback)
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id                  TEXT PRIMARY KEY,
  capability          TEXT NOT NULL,
  proposal_id         TEXT REFERENCES task_proposals(id) ON DELETE SET NULL,
  action              TEXT NOT NULL CHECK (action IN ('accepted', 'edited', 'rejected')),
  owner_edits_json    TEXT,                        -- Field differences if edited
  feedback_notes      TEXT,
  created_at          TEXT NOT NULL                -- UTC ISO
);

CREATE INDEX IF NOT EXISTS idx_ai_evaluations_cap
  ON ai_evaluations(capability, action);
