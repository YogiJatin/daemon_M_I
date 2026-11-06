-- Migration 0015: Block 0 Hygiene — Drop orphaned/superseded tables
-- Pre-migration Time Travel bookmark: 00000079-00000004-0000511b-dc41c73a91ddb475186c62f3fa55653c
-- Export verified in: backup_pre_block0.sql

DROP TABLE IF EXISTS inbox_items;
DROP TABLE IF EXISTS execution_sessions;
DROP TABLE IF EXISTS memory_embeddings;
DROP TABLE IF EXISTS memory_views;
