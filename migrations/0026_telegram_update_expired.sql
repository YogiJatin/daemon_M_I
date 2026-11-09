-- 0026_telegram_update_expired.sql
--
-- The ledger only allowed received/processing/processed/failed. Chat turns were never
-- moved to a terminal state, so they sat at 'received' forever and looked like work still
-- in progress. 'expired' is a real terminal state: the update was accepted, is too old to
-- act on, and must never be replayed.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt with the same columns.

CREATE TABLE telegram_updates_new (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'processed', 'failed', 'expired')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  lease_expires_at TEXT,
  outcome TEXT,
  error_code TEXT
);

INSERT INTO telegram_updates_new (update_id, status, received_at, processed_at, lease_expires_at, outcome, error_code)
SELECT update_id, status, received_at, processed_at, lease_expires_at, outcome, error_code
FROM telegram_updates;

DROP TABLE telegram_updates;

ALTER TABLE telegram_updates_new RENAME TO telegram_updates;

CREATE INDEX IF NOT EXISTS idx_telegram_updates_status ON telegram_updates(status, received_at);
