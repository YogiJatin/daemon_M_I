-- Migration 0019: Telegram Resilience & Fix Brief 0
-- Adds attempts and last_attempt_at to chat_messages
-- Persists provider_alerts for deduplicating provider state alerts
-- Creates outbound_telegram_stubs for recording test calls

ALTER TABLE chat_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN last_attempt_at TEXT;

CREATE TABLE IF NOT EXISTS provider_alerts (
  provider TEXT PRIMARY KEY,
  last_state TEXT NOT NULL,
  last_alert_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_telegram_stubs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_markup TEXT,
  created_at TEXT NOT NULL
);
