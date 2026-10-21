/**
 * worker/auditService.ts
 *
 * Central Append-Only Audit Ledger Service & Fire-and-Forget Event Bus.
 *
 * Invariants:
 * - Append-only: Ledger entries are never updated or deleted.
 * - Pure fire-and-forget: Emitting audit events never blocks or throws in business logic.
 * - O(1) Head Tracking: Reads and writes singleton audit_metadata row.
 * - Configurable Merkle Snapshots: Snapshot generated every AUDIT_SNAPSHOT_INTERVAL (default 100).
 * - Desktop Agent Ready: Pre-registers execution and rollback events for Block 9.
 */

import { canonicalizeJson, sanitizeAuditMetadata } from "./auditSerializer";
import {
  generateULID,
  computePayloadHash,
  computeRecordHash,
  computeMerkleRoot,
} from "./auditHasher";

export const AUDIT_SCHEMA_VERSION = "1.0.0";
export const DEFAULT_SNAPSHOT_INTERVAL = 100;

export type AuditEventType =
  // Task Events
  | "TASK_CREATED"
  | "TASK_UPDATED"
  | "TASK_COMPLETED"
  | "TASK_DELETED"
  | "TASK_RESTORED"
  // Proposal Events
  | "PROPOSAL_CREATED"
  | "PROPOSAL_APPROVED"
  | "PROPOSAL_REJECTED"
  // Timetable Events
  | "TIMETABLE_IMPORTED"
  | "SEMESTER_CREATED"
  | "CLASS_UPDATED"
  // Recurrence Events
  | "RECURRENCE_CREATED"
  | "RECURRENCE_UPDATED"
  | "RECURRENCE_PAUSED"
  // Auth Events
  | "LOGIN"
  | "PAIRING"
  | "LOGOUT"
  // Export & System Events
  | "EXPORT_CREATED"
  | "BACKUP_CREATED"
  | "SETTINGS_CHANGED"
  // AI Events
  | "AI_REQUEST"
  | "AI_RESPONSE"
  | "AI_VERIFICATION_FAILED"
  | "PROVIDER_FAILED"
  // Desktop Agent Events (Block 9 prep)
  | "EXECUTION_APPROVED"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_FAILED"
  | "ROLLBACK_STARTED"
  | "ROLLBACK_COMPLETED"
  // Multimodal Ingress Events (Block 7)
  | "INPUT_RECEIVED"
  | "VOICE_TRANSCRIBED"
  | "OCR_COMPLETED"
  | "DOCUMENT_PARSED"
  | "INTERPRETATION_COMPLETED"
  | "OWNER_APPROVED"
  | "OWNER_REJECTED";

export interface AuditEventInput {
  eventType: AuditEventType;
  eventVersion?: string; // Default: '1.0.0'
  entityType: "task" | "proposal" | "timetable" | "recurrence" | "auth" | "export" | "ai" | "desktop" | "system" | "attachment" | "input_session";
  entityId: string;
  actor?: string; // Default: 'system'
  payload: Record<string, any>;
  metadata?: Record<string, any>;
  timestamp?: Date;
}

export interface AuditRecord {
  id: string;
  sequence_number: number;
  event_type: AuditEventType;
  event_version: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  timestamp_utc: string;
  payload_hash: string;
  previous_hash: string;
  current_hash: string;
  metadata_json: string;
  integrity_status: "VALID" | "WARNING" | "LEGACY";
  schema_version: string;
  created_at: string;
}

export interface AuditMetadata {
  key: string;
  head_sequence: number;
  head_hash: string;
  last_snapshot_sequence: number;
  schema_version: string;
  created_at: string;
  updated_at: string;
}

export class AuditService {
  /**
   * Pure Fire-and-Forget Event Bus (Rule 11).
   * Business callers invoke this without awaiting or catching.
   * Never throws, never alters business execution flow.
   */
  public static emit(db: D1Database, event: AuditEventInput, env?: any): void {
    if (!db) return;
    // Launch append asynchronously, completely decoupled from caller
    this.append(db, event, env).catch((err) => {
      console.warn("[AuditService Warning: Audit event dropped]", err?.message || err);
    });
  }

  /**
   * Appends an immutable cryptographic event record to the ledger.
   */
  public static async append(
    db: D1Database,
    event: AuditEventInput,
    env?: any
  ): Promise<AuditRecord | null> {
    if (!db) return null;

    const snapshotInterval = env?.AUDIT_SNAPSHOT_INTERVAL
      ? parseInt(String(env.AUDIT_SNAPSHOT_INTERVAL), 10)
      : DEFAULT_SNAPSHOT_INTERVAL;

    const now = event.timestamp || new Date();
    const timestampUtc = now.toISOString();
    const eventVersion = event.eventVersion || "1.0.0";
    const actor = event.actor || "system";

    // 1. Compute canonical payload hash
    const canonicalPayload = canonicalizeJson(event.payload);
    const payloadHash = await computePayloadHash(canonicalPayload);

    // 2. Sanitize metadata (NO raw prompt/message bodies, NO secrets)
    const sanitizedMeta = sanitizeAuditMetadata(event.metadata || event.payload);
    const metadataJson = JSON.stringify(sanitizedMeta);

    // 3. Fetch O(1) chain metadata
    let meta = await db
      .prepare("SELECT * FROM audit_metadata WHERE key = 'singleton'")
      .first<AuditMetadata>();

    if (!meta) {
      // Initialize if missing
      await db
        .prepare(
          "INSERT OR IGNORE INTO audit_metadata (key, head_sequence, head_hash, last_snapshot_sequence, schema_version) VALUES ('singleton', 0, 'GENESIS', 0, ?)"
        )
        .bind(AUDIT_SCHEMA_VERSION)
        .run();
      meta = {
        key: "singleton",
        head_sequence: 0,
        head_hash: "GENESIS",
        last_snapshot_sequence: 0,
        schema_version: AUDIT_SCHEMA_VERSION,
        created_at: timestampUtc,
        updated_at: timestampUtc,
      };
    }

    const nextSeq = meta.head_sequence + 1;
    const previousHash = meta.head_sequence === 0 ? "GENESIS" : meta.head_hash;

    // 4. Compute chained record hash including schema_version
    const currentHash = await computeRecordHash(
      AUDIT_SCHEMA_VERSION,
      previousHash,
      payloadHash,
      nextSeq,
      timestampUtc
    );

    const recordId = generateULID(now.getTime());

    // 5. Atomic Sequence Write in D1
    const insertStmt = db
      .prepare(
        `INSERT INTO audit_chain (
          id, sequence_number, event_type, event_version, entity_type, entity_id,
          actor, timestamp_utc, payload_hash, previous_hash, current_hash,
          metadata_json, integrity_status, schema_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALID', ?, ?)`
      )
      .bind(
        recordId,
        nextSeq,
        event.eventType,
        eventVersion,
        event.entityType,
        event.entityId,
        actor,
        timestampUtc,
        payloadHash,
        previousHash,
        currentHash,
        metadataJson,
        AUDIT_SCHEMA_VERSION,
        timestampUtc
      );

    const updateMetaStmt = db
      .prepare(
        `UPDATE audit_metadata
         SET head_sequence = ?, head_hash = ?, updated_at = ?
         WHERE key = 'singleton'`
      )
      .bind(nextSeq, currentHash, timestampUtc);

    // Commit ledger append and head update atomically
    await db.batch([insertStmt, updateMetaStmt]);

    // 6. Check if snapshot window threshold reached
    if (nextSeq % snapshotInterval === 0) {
      await this.generateSnapshot(db, meta.last_snapshot_sequence + 1, nextSeq, timestampUtc);
    }

    return {
      id: recordId,
      sequence_number: nextSeq,
      event_type: event.eventType,
      event_version: eventVersion,
      entity_type: event.entityType,
      entity_id: event.entityId,
      actor,
      timestamp_utc: timestampUtc,
      payload_hash: payloadHash,
      previous_hash: previousHash,
      current_hash: currentHash,
      metadata_json: metadataJson,
      integrity_status: "VALID",
      schema_version: AUDIT_SCHEMA_VERSION,
      created_at: timestampUtc,
    };
  }

  /**
   * Generates a Merkle snapshot over a bounded window of records.
   */
  public static async generateSnapshot(
    db: D1Database,
    firstSeq: number,
    lastSeq: number,
    nowIso: string = new Date().toISOString()
  ): Promise<string> {
    const records = await db
      .prepare(
        `SELECT current_hash FROM audit_chain
         WHERE sequence_number BETWEEN ? AND ?
         ORDER BY sequence_number ASC`
      )
      .bind(firstSeq, lastSeq)
      .all<{ current_hash: string }>();

    const leafHashes = (records.results || []).map((r) => r.current_hash);
    const merkleRoot = await computeMerkleRoot(leafHashes);
    const snapshotId = generateULID();

    const insertSnap = db
      .prepare(
        `INSERT INTO audit_snapshots (snapshot_id, first_sequence, last_sequence, merkle_root, entry_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(snapshotId, firstSeq, lastSeq, merkleRoot, leafHashes.length, nowIso);

    const updateMeta = db
      .prepare(
        `UPDATE audit_metadata
         SET last_snapshot_sequence = ?, updated_at = ?
         WHERE key = 'singleton'`
      )
      .bind(lastSeq, nowIso);

    await db.batch([insertSnap, updateMeta]);
    return merkleRoot;
  }

  /**
   * O(1) Head Retrieval for monitoring and sync.
   */
  public static async getLatest(db: D1Database): Promise<{
    head_sequence: number;
    head_hash: string;
    last_snapshot_sequence: number;
    schema_version: string;
    latest_snapshot?: any;
  } | null> {
    if (!db) return null;

    const meta = await db
      .prepare("SELECT * FROM audit_metadata WHERE key = 'singleton'")
      .first<AuditMetadata>();

    if (!meta) {
      return {
        head_sequence: 0,
        head_hash: "GENESIS",
        last_snapshot_sequence: 0,
        schema_version: AUDIT_SCHEMA_VERSION,
      };
    }

    let latestSnapshot = null;
    if (meta.last_snapshot_sequence > 0) {
      latestSnapshot = await db
        .prepare("SELECT * FROM audit_snapshots ORDER BY last_sequence DESC LIMIT 1")
        .first();
    }

    return {
      head_sequence: meta.head_sequence,
      head_hash: meta.head_hash,
      last_snapshot_sequence: meta.last_snapshot_sequence,
      schema_version: meta.schema_version,
      latest_snapshot: latestSnapshot,
    };
  }

  /**
   * Retrieves full chronological audit entries for a specific entity.
   */
  public static async getEntityHistory(
    db: D1Database,
    entityType: string,
    entityId: string
  ): Promise<AuditRecord[]> {
    if (!db) return [];

    const res = await db
      .prepare(
        `SELECT * FROM audit_chain
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY sequence_number ASC`
      )
      .bind(entityType, entityId)
      .all<AuditRecord>();

    return res.results || [];
  }
}
