-- Migration 0001: system_health singleton
CREATE TABLE IF NOT EXISTS system_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scheduler_start_at TEXT,
  last_scheduler_success_at TEXT,
  last_morning_digest_result TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  last_telegram_delivery_at TEXT,
  last_monitor_ping_at TEXT,
  recent_failure_codes TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_health (id, consecutive_failures, paused, updated_at)
VALUES (1, 0, 0, datetime('now'));
