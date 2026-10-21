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
export const DEFAULT_MAX_APPEND_RETRIES = 5;
export const BASE_RETRY_DELAY_MS = 10;
export const MAX_RETRY_DELAY_MS = 100;

/**
 * Checks whether an audit append failure is a retryable concurrency conflict.
 * Non-retryable errors (schema, validation, fatal inconsistency) must throw immediately.
 */
export function isRetryableAuditError(err: any): boolean {
  if (!err) return false;
  const msg = (typeof err === "string" ? err : err.message || "").toLowerCase();
  if (msg.includes("fatal_inconsistency") || msg.includes("indeterminate_batch_outcome")) return false;
  return (
    msg.includes("unique constraint failed: audit_chain.sequence_number") ||
    msg.includes("constraint failed: audit_chain.sequence_number") ||
    msg.includes("precondition_failed") ||
    msg.includes("sqlite_busy") ||
    msg.includes("database is locked") ||
    (msg.includes("d1_error") && msg.includes("lock"))
  );
}



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
  | "OWNER_REJECTED"
  // Block 8 Memory OS Events
  | "MEMORY_CREATED"
  | "MEMORY_UPDATED"
  | "SUMMARY_GENERATED"
  | "RELATIONSHIP_CREATED"
  | "MEMORY_LINKED"
  // Block 9 Desktop Intelligence & Teach Mode Events
  | "TEACH_MODE_STARTED"
  | "TEACH_STEP_RECORDED"
  | "TEACH_RECIPE_COMPILED"
  | "TEACH_RECIPE_APPROVED"
  | "SAFE_BROWSER_OPENED"
  | "BROWSER_POLICY_APPLIED"
  | "CAMERA_CAPTURE_STARTED"
  | "CAMERA_CAPTURE_COMPLETED"
  | "EXECUTION_PLAN_CREATED"
  | "EXECUTION_VERIFIED"
  | "EXECUTION_ROLLED_BACK";

export interface AuditEventInput {
  eventType: AuditEventType;
  eventVersion?: string; // Default: '1.0.0'
  entityType: "task" | "proposal" | "timetable" | "recurrence" | "auth" | "export" | "ai" | "desktop" | "system" | "attachment" | "input_session" | "memory_object" | "memory_relationship" | "teach_session" | "teach_step" | "workflow_recipe" | "browser_policy" | "browser_session" | "camera_capture" | "execution_plan";
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


const ALLOWED_ENTITY_TYPES = new Set([
  "task",
  "proposal",
  "timetable",
  "recurrence",
  "auth",
  "export",
  "ai",
  "desktop",
  "system",
  "attachment",
  "input_session",
  "memory_object",
  "memory_relationship",
  "teach_session",
  "teach_step",
  "workflow_recipe",
  "browser_policy",
  "browser_session",
  "camera_capture",
  "execution_plan",
]);

export type AuditErrorCategory =
  | "write_contention"
  | "indeterminate_outcome"
  | "precondition_failed"
  | "database_failure";

export function classifyAuditErrorCategory(err: unknown): AuditErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("contention") ||
    msg.includes("concurrency") ||
    msg.includes("unique constraint") ||
    msg.includes("slot after") ||
    msg.includes("busy") ||
    msg.includes("locked")
  ) {
    return "write_contention";
  }
  if (
    msg.includes("indeterminate") ||
    msg.includes("unexpected shape") ||
    msg.includes("fatal_inconsistency")
  ) {
    return "indeterminate_outcome";
  }
  if (msg.includes("precondition") || msg.includes("0 changes")) {
    return "precondition_failed";
  }
  return "database_failure";
}

function sanitizeEventType(eventType: any): string {
  if (typeof eventType === "string" && /^[A-Z0-9_]{3,64}$/.test(eventType)) {
    return eventType;
  }
  return "UNKNOWN_EVENT";
}

function sanitizeEntityType(entityType: any): string {
  if (typeof entityType === "string" && ALLOWED_ENTITY_TYPES.has(entityType)) {
    return entityType;
  }
  return "unknown_entity";
}

function extractChanges(result: any): number | null {
  if (result === null || result === undefined) return null;
  if (typeof result.meta?.changes === "number") return result.meta.changes;
  if (typeof result.changes === "number") return result.changes;
  if (typeof result.rows_written === "number") return result.rows_written;
  return null;
}

export class AuditService {
  /** In-process serialization queue (optimization to reduce contention within single isolate). */
  private static _queue: Promise<any> = Promise.resolve();

  /** Last captured emit error for observability / test assertions without process crashing. */
  private static _lastEmitError: Error | null = null;
  private static _emitErrorHandler: ((err: any, event: AuditEventInput) => void) | null = null;

  /** Last captured post-commit snapshot generation error. */
  private static _lastSnapshotError: Error | null = null;

  /**
   * Safely enqueues a task onto the in-memory queue without allowing a failure
   * to poison future tasks.
   */
  private static enqueue<T>(task: () => Promise<T>): Promise<T> {
    const resultPromise = this._queue.catch(() => {}).then(task);
    this._queue = resultPromise.then(() => {}, () => {});
    return resultPromise;
  }

  /**
   * Observability helper: retrieve last emit error (if any).
   */
  public static getLastError(): Error | null {
    return this._lastEmitError;
  }

  /**
   * Observability helper: clear last emit error.
   */
  public static clearLastError(): void {
    this._lastEmitError = null;
  }

  /**
   * Observability helper: retrieve last post-commit snapshot error (if any).
   */
  public static getLastSnapshotError(): Error | null {
    return this._lastSnapshotError;
  }

  /**
   * Observability helper: clear last snapshot error.
   */
  public static clearLastSnapshotError(): void {
    this._lastSnapshotError = null;
  }

  /**
   * Register optional error handler for audit emit failures.
   */
  public static setEmitErrorHandler(handler: ((err: any, event: AuditEventInput) => void) | null): void {
    this._emitErrorHandler = handler;
  }

  /**
   * Event Bus Ingress.
   * Returns Promise<AuditRecord | null> so callers that await it can observe completion,
   * while attaching a safe catch handler so unawaited fire-and-forget callers
   * never trigger unhandled rejections or crash business flow.
   */
  public static emit(db: D1Database, event: AuditEventInput, env?: any): Promise<AuditRecord | null> {
    if (!db) return Promise.resolve(null);
    const p = this.append(db, event, env);
    p.catch((err) => {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this._lastEmitError = errorObj;

      // Safe structured operational logging: NO payloads, NO metadata, NO entityId, NO raw database error messages
      const safeEventType = sanitizeEventType(event?.eventType);
      const safeEntityType = sanitizeEntityType(event?.entityType);
      const errorCategory = classifyAuditErrorCategory(errorObj);

      console.error(
        `[AuditService Error: Audit event append failed] eventType=${safeEventType} entityType=${safeEntityType} errorCategory=${errorCategory}`
      );

      if (this._emitErrorHandler) {
        try {
          this._emitErrorHandler(errorObj, event);
        } catch {
          // Keep custom error-handler exceptions isolated without logging raw error messages
          console.error("[AuditService] Custom emit error handler execution failed");
        }
      }
    });
    return p;
  }

  /**
   * Appends an immutable cryptographic event record to the ledger.
   * In-process queue serializes calls within a single isolate to minimize local contention.
   */
  public static async append(
    db: D1Database,
    event: AuditEventInput,
    env?: any
  ): Promise<AuditRecord | null> {
    if (!db) return null;
    return this.enqueue(() => this._appendWithRetry(db, event, env));
  }

  /**
   * Direct append bypassing the in-process serialization queue.
   * Enables testing cross-writer / independent isolate database-level contention and retries.
   */
  public static async appendDirect(
    db: D1Database,
    event: AuditEventInput,
    env?: any
  ): Promise<AuditRecord> {
    return this._appendWithRetry(db, event, env);
  }

  /**
   * Core append implementation with bounded optimistic concurrency retry.
   */
  private static async _appendWithRetry(
    db: D1Database,
    event: AuditEventInput,
    env?: any
  ): Promise<AuditRecord> {
    const snapshotInterval = env?.AUDIT_SNAPSHOT_INTERVAL
      ? parseInt(String(env.AUDIT_SNAPSHOT_INTERVAL), 10)
      : DEFAULT_SNAPSHOT_INTERVAL;

    // Strict retry configuration validation: must be positive integer bounded to max 10
    const rawRetries = env?.AUDIT_MAX_RETRIES
      ? parseInt(String(env.AUDIT_MAX_RETRIES), 10)
      : DEFAULT_MAX_APPEND_RETRIES;
    const maxRetries =
      Number.isInteger(rawRetries) && rawRetries > 0
        ? Math.min(rawRetries, 10)
        : DEFAULT_MAX_APPEND_RETRIES;

    const now = event.timestamp || new Date();
    const timestampUtc = now.toISOString();
    const eventVersion = event.eventVersion || "1.0.0";
    const actor = event.actor || "system";

    // 1. Identity & deterministic hashes computed ONCE to preserve event identity across retries
    const recordId = generateULID(now.getTime());
    const canonicalPayload = canonicalizeJson(event.payload);
    const payloadHash = await computePayloadHash(canonicalPayload);

    // 2. Sanitize metadata (NO raw prompt/message bodies, NO secrets)
    const sanitizedMeta = sanitizeAuditMetadata(event.metadata || event.payload);
    const metadataJson = JSON.stringify(sanitizedMeta);

    let lastError: any = null;
    let committedRecord: AuditRecord | null = null;
    let committedMeta: AuditMetadata | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 3. Fresh read of current committed head metadata
        let meta = await db
          .prepare("SELECT * FROM audit_metadata WHERE key = 'singleton'")
          .first<AuditMetadata>();

        if (!meta) {
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

        const expectedPrevSeq = meta.head_sequence;
        const nextSeq = expectedPrevSeq + 1;
        const previousHash = expectedPrevSeq === 0 ? "GENESIS" : meta.head_hash;

        // 4. Recalculate chained record hash with fresh previousHash and nextSeq
        const currentHash = await computeRecordHash(
          AUDIT_SCHEMA_VERSION,
          previousHash,
          payloadHash,
          nextSeq,
          timestampUtc
        );

        // 5. Build statements with optimistic concurrency preconditions
        // Statement 1: Only inserts if audit_metadata currently matches expectedPrevSeq
        const insertStmt = db
          .prepare(
            `INSERT INTO audit_chain (
              id, sequence_number, event_type, event_version, entity_type, entity_id,
              actor, timestamp_utc, payload_hash, previous_hash, current_hash,
              metadata_json, integrity_status, schema_version, created_at
            )
            SELECT
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALID', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM audit_metadata WHERE key = 'singleton' AND head_sequence = ?
            )`
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
            timestampUtc,
            expectedPrevSeq
          );

        // Statement 2: Only advances head if current head_sequence matches expectedPrevSeq
        const updateMetaStmt = db
          .prepare(
            `UPDATE audit_metadata
             SET head_sequence = ?, head_hash = ?, updated_at = ?
             WHERE key = 'singleton' AND head_sequence = ?`
          )
          .bind(nextSeq, currentHash, timestampUtc, expectedPrevSeq);

        // Commit ledger append and head update atomically in D1
        const batchResults = await db.batch([insertStmt, updateMetaStmt]);

        // Inspect affected row counts from batch execution results
        const insertChanges = extractChanges(batchResults?.[0]);
        const updateChanges = extractChanges(batchResults?.[1]);

        let isCommitted = false;

        if (insertChanges === 1 && updateChanges === 1) {
          isCommitted = true;
        } else if (insertChanges === 0 && updateChanges === 0) {
          // Clean sequence contention: another writer advanced head. Safe to retry with fresh read.
          throw new Error(`precondition_failed: sequence contention (expected sequence ${expectedPrevSeq}, conflicting writer advanced head)`);
        } else if (insertChanges !== null && updateChanges !== null) {
          // Fatal one-sided mutation (e.g. 1 inserted but 0 updated, or 0 inserted but 1 updated).
          // Must NOT be retried as a routine conflict; surfaces immediately.
          throw new Error(`fatal_inconsistency: one-sided audit batch commit (insertChanges=${insertChanges}, updateChanges=${updateChanges})`);
        } else {
          // Driver omitted affected row counts (insertChanges === null || updateChanges === null).
          // Do not automatically assume failure: reconcile using stable recordId and metadata table.
          const existingRow = await db
            .prepare("SELECT id, sequence_number, current_hash FROM audit_chain WHERE id = ?")
            .bind(recordId)
            .first<{ id: string; sequence_number: number; current_hash: string }>();

          const currentMeta = await db
            .prepare("SELECT head_sequence, head_hash FROM audit_metadata WHERE key = 'singleton'")
            .first<{ head_sequence: number; head_hash: string }>();

          if (
            existingRow &&
            currentMeta &&
            existingRow.sequence_number === nextSeq &&
            currentMeta.head_sequence === nextSeq &&
            existingRow.current_hash === currentHash
          ) {
            // Reconciled: the batch successfully committed despite missing driver metadata.
            isCommitted = true;
          } else if (!existingRow && currentMeta && currentMeta.head_sequence > expectedPrevSeq) {
            // Record definitely not committed and another writer advanced head. Safe to retry.
            throw new Error(`precondition_failed: sequence contention (expected sequence ${expectedPrevSeq}, conflicting writer advanced head; reconciled missing metadata)`);
          } else {
            // Outcome remains indeterminate: do NOT blindly resubmit.
            throw new Error(`indeterminate_batch_outcome: unable to verify whether audit record '${recordId}' committed due to missing driver metadata`);
          }
        }

        if (isCommitted) {
          committedRecord = {
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
          committedMeta = meta;
          break; // Exit retry loop immediately upon confirmed commit
        }
      } catch (err: any) {
        lastError = err;
        if (isRetryableAuditError(err) && attempt < maxRetries - 1) {
          // Bounded jittered exponential backoff
          const delay =
            Math.min(MAX_RETRY_DELAY_MS, Math.pow(2, attempt) * BASE_RETRY_DELAY_MS) +
            Math.random() * 15;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (isRetryableAuditError(err)) {
          throw new Error(
            `AuditService: append failed after ${maxRetries} attempts due to write contention: ${err?.message || err}`
          );
        }
        // Non-retryable error: surface immediate failure without retrying
        throw (err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (!committedRecord || !committedMeta) {
      throw new Error(
        `AuditService: append failed after ${maxRetries} attempts due to write contention: ${lastError?.message || lastError}`
      );
    }

    // 6. Post-commit snapshot check (Strictly OUTSIDE append retry loop)
    // Snapshot generation failures NEVER cause the committed audit event to retry.
    if (committedRecord.sequence_number % snapshotInterval === 0) {
      try {
        await this.generateSnapshot(
          db,
          committedMeta.last_snapshot_sequence + 1,
          committedRecord.sequence_number,
          timestampUtc
        );
      } catch (snapshotErr: any) {
        this._lastSnapshotError = snapshotErr instanceof Error ? snapshotErr : new Error(String(snapshotErr));
        console.error(
          `[AuditService Warning: Snapshot generation failed at sequence ${committedRecord.sequence_number}]`,
          snapshotErr?.message || snapshotErr
        );
      }
    }

    return committedRecord;
  }

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
