/**
 * worker/auditReplay.ts
 *
 * Forensic Event Replay Engine for Audit Ledger.
 *
 * Requirements (Requirement 6):
 * - Pure read-only forensic inspection.
 * - Replay emits chronological Timeline Events, NEVER domain business objects.
 * - Reconstructs entity lifecycles, task history, proposal reviews, and AI decision traces.
 * - Zero execution, zero mutation side effects.
 */

import { AuditRecord, AuditService } from "./auditService";

export interface TimelineEvent {
  sequence: number;
  id: string;
  timestamp: string;
  eventType: string;
  eventVersion: string;
  actor: string;
  summary: string;
  metadata: Record<string, any>;
}

export interface EntityReplayReport {
  entityType: string;
  entityId: string;
  totalEvents: number;
  initialRecordedAt: string | null;
  latestRecordedAt: string | null;
  timeline: TimelineEvent[];
}

export class AuditReplay {
  /**
   * Reconstructs forensic chronological timeline for a given entity.
   */
  public static async replayEntityTimeline(
    db: D1Database,
    entityType: string,
    entityId: string
  ): Promise<EntityReplayReport> {
    const records = await AuditService.getEntityHistory(db, entityType, entityId);

    const timeline: TimelineEvent[] = records.map((rec) => {
      let meta: Record<string, any> = {};
      try {
        meta = JSON.parse(rec.metadata_json || "{}");
      } catch {
        meta = {};
      }

      return {
        sequence: rec.sequence_number,
        id: rec.id,
        timestamp: rec.timestamp_utc,
        eventType: rec.event_type,
        eventVersion: rec.event_version,
        actor: rec.actor,
        summary: this.generateSummary(rec.event_type, rec.entity_type, rec.entity_id, meta),
        metadata: meta,
      };
    });

    return {
      entityType,
      entityId,
      totalEvents: timeline.length,
      initialRecordedAt: timeline.length > 0 ? timeline[0].timestamp : null,
      latestRecordedAt: timeline.length > 0 ? timeline[timeline.length - 1].timestamp : null,
      timeline,
    };
  }

  /**
   * Replays forensic lifecycle of a task proposal.
   */
  public static async replayProposalLifecycle(
    db: D1Database,
    proposalId: string
  ): Promise<EntityReplayReport> {
    return this.replayEntityTimeline(db, "proposal", proposalId);
  }

  /**
   * Replays forensic trace of AI operations across capabilities.
   */
  public static async replayAIDecisions(
    db: D1Database,
    capabilityFilter?: string,
    limit: number = 50
  ): Promise<TimelineEvent[]> {
    if (!db) return [];

    let query = `SELECT * FROM audit_chain WHERE entity_type = 'ai'`;
    const params: any[] = [];

    if (capabilityFilter) {
      query += ` AND entity_id = ?`;
      params.push(capabilityFilter);
    }

    query += ` ORDER BY sequence_number DESC LIMIT ?`;
    params.push(limit);

    const stmt = db.prepare(query);
    const res = await (params.length === 1 ? stmt.bind(params[0]) : stmt.bind(params[0], params[1])).all<AuditRecord>();

    return (res.results || []).reverse().map((rec) => {
      let meta: Record<string, any> = {};
      try {
        meta = JSON.parse(rec.metadata_json || "{}");
      } catch {
        meta = {};
      }

      return {
        sequence: rec.sequence_number,
        id: rec.id,
        timestamp: rec.timestamp_utc,
        eventType: rec.event_type,
        eventVersion: rec.event_version,
        actor: rec.actor,
        summary: this.generateSummary(rec.event_type, rec.entity_type, rec.entity_id, meta),
        metadata: meta,
      };
    });
  }

  /**
   * Generates readable forensic summaries for timeline rendering.
   */
  private static generateSummary(
    eventType: string,
    entityType: string,
    entityId: string,
    meta: Record<string, any>
  ): string {
    switch (eventType) {
      case "TASK_CREATED":
        return `Task '${meta.title || entityId}' created`;
      case "TASK_UPDATED":
        return `Task '${entityId}' updated (changes: ${Object.keys(meta).filter((k) => k !== "task_id").join(", ") || "status"})`;
      case "TASK_COMPLETED":
        return `Task '${entityId}' marked completed`;
      case "TASK_DELETED":
        return `Task '${entityId}' deleted`;
      case "PROPOSAL_CREATED":
        return `Proposal '${meta.title || entityId}' created by AI engine`;
      case "PROPOSAL_APPROVED":
        return `Proposal '${entityId}' confirmed by owner into task '${meta.created_task_id || "new"}'`;
      case "PROPOSAL_REJECTED":
        return `Proposal '${entityId}' rejected by owner`;
      case "AI_REQUEST":
        return `AI request dispatched for capability '${meta.capability || entityId}'`;
      case "AI_RESPONSE":
        return `AI response returned by provider '${meta.provider || "unknown"}' in ${meta.duration_ms || meta.latency_ms || 0}ms`;
      case "AI_VERIFICATION_FAILED":
        return `AI verification failed for capability '${meta.capability || entityId}': ${meta.error || "schema violation"}`;
      case "LOGIN":
        return `User authenticated`;
      case "PAIRING":
        return `Device paired via challenge code`;
      case "EXPORT_CREATED":
        return `Data export generated (format: ${meta.format || "json"})`;
      default:
        return `${eventType} on ${entityType} '${entityId}'`;
    }
  }
}
