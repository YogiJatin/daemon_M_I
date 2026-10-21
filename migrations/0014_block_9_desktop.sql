-- Migration 0014: Block 9 — Desktop Intelligence, Teach Mode, Safe Browser & Obsidian Mirror
--
-- Features:
-- - teach_sessions: explicit arming and recording of user demonstrations
-- - teach_steps: structured sanitized step events (no secrets/passwords)
-- - workflow_recipes: compiled reusable intent-based workflows (canonical store)
-- - workflow_versions: version history of approved workflows
-- - browser_policies: domain-level isolation and security policy rules
-- - execution_plans: typed execution proposals requiring owner approval
-- - execution_steps: individual steps bound to typed adapters
-- - execution_sessions: audit tracking of execution dispatch
-- - camera_captures: permission-gated image, document, and whiteboard captures

-- 1. Teach Sessions
CREATE TABLE IF NOT EXISTS teach_sessions (
  id              TEXT PRIMARY KEY,                     -- teach_<ulid>
  status          TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'compiling', 'completed', 'cancelled')),
  title           TEXT NOT NULL,
  app_context     TEXT,                                 -- e.g. 'browser:chrome', 'app:spotify'
  started_at      TEXT NOT NULL,                        -- ISO-8601 UTC
  ended_at        TEXT,                                 -- ISO-8601 UTC
  metadata_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_teach_status ON teach_sessions(status);
CREATE INDEX IF NOT EXISTS idx_teach_started ON teach_sessions(started_at);

-- 2. Teach Steps (Trace of actions)
CREATE TABLE IF NOT EXISTS teach_steps (
  id              TEXT PRIMARY KEY,                     -- tstep_<ulid>
  session_id      TEXT NOT NULL REFERENCES teach_sessions(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  action_type     TEXT NOT NULL,                        -- app_launch, window_focus, browser_navigate, click, keypress, clipboard, file_move, terminal_cmd, ocr_label
  intent_summary  TEXT NOT NULL,
  target_selector TEXT,
  input_sanitized TEXT,                                 -- Passwords & secrets stripped
  timestamp       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tstep_session ON teach_steps(session_id, step_index);

-- 3. Workflow Recipes (Canonical store for approved workflows)
CREATE TABLE IF NOT EXISTS workflow_recipes (
  id                TEXT PRIMARY KEY,                   -- recipe_<ulid>
  title             TEXT NOT NULL,
  intent            TEXT NOT NULL,
  trigger_type      TEXT NOT NULL DEFAULT 'manual',     -- manual, voice_command, shortcut
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'archived')),
  confidence        REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  steps_json        TEXT NOT NULL,                      -- Serialized JSON array of structured steps
  memory_object_id  TEXT REFERENCES memory_objects(id) ON DELETE SET NULL,
  approved_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipe_status ON workflow_recipes(status);
CREATE INDEX IF NOT EXISTS idx_recipe_memory ON workflow_recipes(memory_object_id);

-- 4. Workflow Versions
CREATE TABLE IF NOT EXISTS workflow_versions (
  id              TEXT PRIMARY KEY,                     -- wver_<ulid>
  recipe_id       TEXT NOT NULL REFERENCES workflow_recipes(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  steps_json      TEXT NOT NULL,
  diff_summary    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wver_recipe ON workflow_versions(recipe_id, version_number);

-- 5. Browser Policies
CREATE TABLE IF NOT EXISTS browser_policies (
  id              TEXT PRIMARY KEY,                     -- bpol_<ulid>
  pattern         TEXT NOT NULL UNIQUE,                 -- e.g. '*.streaming.to', 'github.com', 'trusted.internal'
  policy          TEXT NOT NULL CHECK (policy IN ('trusted', 'restricted', 'read-only', 'safe-browser-only', 'blocked', 'owner-approved-only')),
  isolation_level TEXT NOT NULL DEFAULT 'standard' CHECK (isolation_level IN ('standard', 'incognito_profile', 'disposable_sandbox')),
  reason          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bpol_policy ON browser_policies(policy);

-- 6. Execution Plans & Steps
CREATE TABLE IF NOT EXISTS execution_plans (
  id              TEXT PRIMARY KEY,                     -- exec_<ulid>
  intent          TEXT NOT NULL,
  risk_tier       TEXT NOT NULL DEFAULT 'tier_1_safe' CHECK (risk_tier IN ('tier_1_safe', 'tier_2_moderate', 'tier_3_restricted')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'executing', 'completed', 'failed', 'rolled_back')),
  approval_hash   TEXT,                                 -- SHA-256 of canonical step payload for single-use approval
  approved_at     TEXT,
  result_summary  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exec_status ON execution_plans(status);
CREATE INDEX IF NOT EXISTS idx_exec_created ON execution_plans(created_at);

CREATE TABLE IF NOT EXISTS execution_steps (
  id              TEXT PRIMARY KEY,                     -- estep_<ulid>
  plan_id         TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  adapter         TEXT NOT NULL CHECK (adapter IN ('desktop', 'browser', 'filesystem', 'terminal', 'clipboard', 'window')),
  action          TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped')),
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_estep_plan ON execution_steps(plan_id, step_index);

CREATE TABLE IF NOT EXISTS execution_sessions (
  id              TEXT PRIMARY KEY,                     -- esess_<ulid>
  device_id       TEXT NOT NULL,
  plan_id         TEXT NOT NULL REFERENCES execution_plans(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active',
  started_at      TEXT NOT NULL,
  completed_at    TEXT
);

-- 7. Camera Captures
CREATE TABLE IF NOT EXISTS camera_captures (
  id              TEXT PRIMARY KEY,                     -- cam_<ulid>
  mode            TEXT NOT NULL CHECK (mode IN ('still', 'document', 'whiteboard', 'burst')),
  attachment_id   TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  proposal_id     TEXT REFERENCES task_proposals(id) ON DELETE SET NULL,
  device_info     TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cam_mode ON camera_captures(mode);
