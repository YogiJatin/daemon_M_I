-- migrations/0011_block_6_2_audit_chain.sql
-- Block 6.2: Append-Only Cryptographic Audit Ledger & Chain Metadata

-- 1. Main Tamper-Evident Audit Chain Table
CREATE TABLE IF NOT EXISTS audit_chain (
  id TEXT PRIMARY KEY,                       -- ULID (chronologically sortable)
  sequence_number INTEGER UNIQUE NOT NULL,   -- Strictly monotonic sequence (1, 2, 3...)
  event_type TEXT NOT NULL,                  -- Typed event (e.g. TASK_CREATED, PROPOSAL_APPROVED)
  event_version TEXT NOT NULL DEFAULT '1.0.0', -- Schema version of event contract
  entity_type TEXT NOT NULL,                 -- Domain entity (task, proposal, auth, ai, timetable, system)
  entity_id TEXT NOT NULL,                   -- Target entity identifier
  actor TEXT NOT NULL,                       -- Actor identifier ('owner', 'telegram', 'system', 'ai')
  timestamp_utc TEXT NOT NULL,               -- ISO-8601 UTC timestamp of occurrence
  payload_hash TEXT NOT NULL,                -- Deterministic SHA-256 of canonical event payload
  previous_hash TEXT NOT NULL,               -- SHA-256 of preceding entry ('GENESIS' for sequence 1)
  current_hash TEXT NOT NULL,                -- SHA-256(schema_version + previous_hash + payload_hash + sequence + timestamp)
  metadata_json TEXT NOT NULL DEFAULT '{}',  -- Strictly sanitized metadata (NO raw bodies, tokens, or PII)
  integrity_status TEXT NOT NULL DEFAULT 'VALID', -- 'VALID' | 'WARNING' | 'LEGACY'
  schema_version TEXT NOT NULL DEFAULT '1.0.0',   -- Ledger schema version
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_chain_seq ON audit_chain(sequence_number);
CREATE INDEX IF NOT EXISTS idx_audit_chain_ts ON audit_chain(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_audit_chain_entity ON audit_chain(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_chain_type ON audit_chain(event_type);

-- 2. Merkle Root Snapshots Table (Periodically computed every AUDIT_SNAPSHOT_INTERVAL entries)
CREATE TABLE IF NOT EXISTS audit_snapshots (
  snapshot_id TEXT PRIMARY KEY,              -- ULID
  first_sequence INTEGER NOT NULL,           -- Starting sequence in snapshot window
  last_sequence INTEGER NOT NULL,            -- Ending sequence in snapshot window
  merkle_root TEXT NOT NULL,                 -- Computed Merkle tree root of window entries
  entry_count INTEGER NOT NULL,              -- Number of entries included
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_snapshots_seq ON audit_snapshots(first_sequence, last_sequence);

-- 3. Chain Metadata Table (Singleton table for O(1) head lookups without full table scans)
CREATE TABLE IF NOT EXISTS audit_metadata (
  key TEXT PRIMARY KEY DEFAULT 'singleton',
  head_sequence INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT NOT NULL DEFAULT 'GENESIS',
  last_snapshot_sequence INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL DEFAULT '1.0.0',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize singleton metadata row if not exists
INSERT OR IGNORE INTO audit_metadata (key, head_sequence, head_hash, last_snapshot_sequence, schema_version)
VALUES ('singleton', 0, 'GENESIS', 0, '1.0.0');
