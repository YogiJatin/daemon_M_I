-- Migration 0012: Block 7 — Multimodal Ingress Layer & Content-Addressed Attachments
--
-- Features:
-- - attachments table: SHA-256 content-addressing and deduplication
-- - attachment_chunks table: token-bounded excerpts for retrieval and AI context
-- - input_sessions table: lifecycle tracking for all external multimodal input

-- 1. Ingestion Attachments (Content-Addressed via SHA-256)
CREATE TABLE IF NOT EXISTS attachments (
  id                  TEXT PRIMARY KEY,
  filename            TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  byte_size           INTEGER NOT NULL,
  sha256_hash         TEXT NOT NULL UNIQUE,
  storage_path        TEXT,
  metadata_json       TEXT,
  created_at          TEXT NOT NULL -- UTC ISO
);

CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(sha256_hash);

-- 2. Attachment Chunks (Indexed excerpts for search & AI context)
CREATE TABLE IF NOT EXISTS attachment_chunks (
  id                  TEXT PRIMARY KEY,
  attachment_id       TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  chunk_index         INTEGER NOT NULL,
  chunk_text          TEXT NOT NULL,
  token_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL -- UTC ISO
);

CREATE INDEX IF NOT EXISTS idx_attachment_chunks_lookup ON attachment_chunks(attachment_id, chunk_index);

-- 3. Input Ingestion Sessions (Lifecycle tracking)
CREATE TABLE IF NOT EXISTS input_sessions (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL, -- 'telegram', 'web_mic', 'web_upload', 'share_target', 'api', 'command_bar'
  raw_type            TEXT NOT NULL, -- 'text', 'audio', 'image', 'document'
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'normalizing', 'extracting', 'interpreting', 'proposed', 'failed')),
  extracted_text      TEXT,
  attachment_id       TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  proposal_id         TEXT REFERENCES task_proposals(id) ON DELETE SET NULL,
  error_message       TEXT,
  metadata_json       TEXT,
  created_at          TEXT NOT NULL, -- UTC ISO
  updated_at          TEXT NOT NULL  -- UTC ISO
);

CREATE INDEX IF NOT EXISTS idx_input_sessions_status ON input_sessions(status, created_at);
