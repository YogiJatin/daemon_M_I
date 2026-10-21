-- Migration 0013: Block 8 — Memory OS (Knowledge Graph & Long-Term Context)
--
-- Features:
-- - memory_objects: Canonical representation of all long-term OS concepts
-- - memory_relationships: Graph edges connecting concepts with confidence and origin
-- - memory_tags: Tag indexing for fast faceted lookup
-- - memory_embeddings: Provider-agnostic vector metadata placeholder
-- - memory_views: Materialized read models for high-frequency queries

-- 1. Canonical Memory Objects
CREATE TABLE IF NOT EXISTS memory_objects (
  id              TEXT PRIMARY KEY,                     -- mem_<ulid>
  type            TEXT NOT NULL,                        -- document, lecture, note, research, etc.
  title           TEXT NOT NULL,
  canonical_text  TEXT NOT NULL,
  summary         TEXT,
  attachment_id   TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,                        -- web, telegram, api, ingress, desktop
  metadata_json   TEXT,
  created_at      TEXT NOT NULL,                        -- ISO-8601 UTC
  updated_at      TEXT NOT NULL                         -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_mem_type ON memory_objects(type);
CREATE INDEX IF NOT EXISTS idx_mem_attachment ON memory_objects(attachment_id);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memory_objects(created_at);

-- 2. Memory Relationship Graph
CREATE TABLE IF NOT EXISTS memory_relationships (
  id                TEXT PRIMARY KEY,                   -- mrel_<ulid>
  from_object       TEXT NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  to_object         TEXT NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,                      -- references, summarizes, derived_from, supports, contradicts, mentions, related_to, belongs_to_subject, generated_from, duplicate_of
  confidence        REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  origin            TEXT NOT NULL DEFAULT 'auto',       -- auto, user, ai_inferred
  created_at        TEXT NOT NULL                       -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_mrel_from ON memory_relationships(from_object);
CREATE INDEX IF NOT EXISTS idx_mrel_to ON memory_relationships(to_object);
CREATE INDEX IF NOT EXISTS idx_mrel_type ON memory_relationships(relationship_type);

-- 3. Memory Tags
CREATE TABLE IF NOT EXISTS memory_tags (
  id                TEXT PRIMARY KEY,                   -- mtag_<ulid>
  memory_object_id  TEXT NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  tag               TEXT NOT NULL,
  created_at        TEXT NOT NULL                       -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_mtags_obj ON memory_tags(memory_object_id);
CREATE INDEX IF NOT EXISTS idx_mtags_tag ON memory_tags(tag);

-- 4. Memory Embeddings (Vendor-agnostic placeholder)
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id                TEXT PRIMARY KEY,
  memory_object_id  TEXT NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,                      -- workers_ai, mock, local
  embedding_version TEXT NOT NULL,
  vector_hash       TEXT NOT NULL,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL
);

-- 5. Materialized Memory Views (Fast read model)
CREATE TABLE IF NOT EXISTS memory_views (
  view_key          TEXT PRIMARY KEY,                   -- e.g. recent:all, subject:<id>
  payload_json      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
