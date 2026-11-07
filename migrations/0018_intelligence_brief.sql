-- 0018_intelligence_brief.sql
-- Fixes & Intelligence Upgrade: Chat messages status update, reply_markup, telegram_message_id

CREATE TABLE IF NOT EXISTS chat_messages_new (
  id                  TEXT PRIMARY KEY,
  update_id           INTEGER NOT NULL,
  chat_id             TEXT NOT NULL,
  message_id          INTEGER NOT NULL,
  role                TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'assistant', 'system')),
  text                TEXT,
  intent              TEXT,
  confidence          REAL,
  provider            TEXT,
  latency_ms          INTEGER,
  outcome             TEXT,
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'processing', 'sent', 'done', 'failed')),
  reply_markup        TEXT,
  telegram_message_id INTEGER,
  reply_to_message_id INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

INSERT OR IGNORE INTO chat_messages_new (id, update_id, chat_id, message_id, role, text, intent, confidence, provider, latency_ms, outcome, status, created_at, updated_at)
  SELECT id, update_id, chat_id, message_id, role, text, intent, confidence, provider, latency_ms, outcome, status, created_at, updated_at FROM chat_messages;

DROP TABLE IF EXISTS chat_messages;
ALTER TABLE chat_messages_new RENAME TO chat_messages;

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_update_id ON chat_messages(update_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_status ON chat_messages(status, updated_at);

-- Default settings seed
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('home_city', 'Hyderabad', datetime('now')),
  ('home_lat', '17.3850', datetime('now')),
  ('home_lon', '78.4867', datetime('now')),
  ('morning_anchor_time', '08:00', datetime('now')),
  ('evening_anchor_time', '20:00', datetime('now')),
  ('buffer_after_class_min', '15', datetime('now')),
  ('commute_home_min', '40', datetime('now')),
  ('classifier_order', 'groq_primary,groq_secondary,gemini_primary,gemini_secondary,workers_ai', datetime('now')),
  ('answer_order', 'groq_primary,groq_secondary,gemini_primary,gemini_secondary', datetime('now')),
  ('search_provider_order', 'gemini_grounding,google,mock', datetime('now')),
  ('daily_capture_calls_limit', '50', datetime('now')),
  ('daily_chat_calls_limit', '100', datetime('now')),
  ('daily_lookup_calls_limit', '50', datetime('now'));
