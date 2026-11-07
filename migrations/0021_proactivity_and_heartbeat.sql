-- 0021_proactivity_and_heartbeat.sql
-- Migration for Phase 1: Attention budget ledger, briefing runs, heartbeat state, and web push subscriptions

CREATE TABLE IF NOT EXISTS attention_log (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'telegram',
  pool TEXT NOT NULL, -- 'pool_a', 'pool_b'
  reason TEXT NOT NULL, -- 'first_fire', 're_nudge', 'briefing', 'urgent_ping', 'heartbeat', 'system'
  message_id TEXT,
  chat_id TEXT NOT NULL,
  text_snippet TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attention_log_date ON attention_log (created_at);
CREATE INDEX IF NOT EXISTS idx_attention_log_pool_date ON attention_log (pool, created_at);

CREATE TABLE IF NOT EXISTS briefing_runs (
  id TEXT PRIMARY KEY,
  briefing_type TEXT NOT NULL, -- 'morning', 'evening'
  run_date TEXT NOT NULL, -- 'YYYY-MM-DD' in IST
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL, -- 'sent', 'failed', 'suppressed'
  UNIQUE(briefing_type, run_date)
);

CREATE TABLE IF NOT EXISTS heartbeat_state (
  key TEXT PRIMARY KEY,
  last_checked_at TEXT NOT NULL,
  last_alert_at TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
