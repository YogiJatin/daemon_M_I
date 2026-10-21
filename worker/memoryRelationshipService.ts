/**
 * worker/memoryRelationshipService.ts — Graph Edge Management
 *
 * Implements Graph instead of folders:
 * - Typed edges: references, summarizes, derived_from, supports, contradicts, mentions, related_to, belongs_to_subject, generated_from, duplicate_of
 * - Bidirectional traversal
 * - Confidence and origin tracking
 * - Emits RELATIONSHIP_CREATED and MEMORY_LINKED audit events
 */

import { MemoryRelationshipType, MemoryRelationshipRecord } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';
import { AuditService } from './auditService';

export class MemoryRelationshipService {
  /**
   * Creates or updates a graph edge between two canonical memory objects.
   */
  static async link(
    db: D1Database,
    input: {
      fromObject: string;
      toObject: string;
      relationshipType: MemoryRelationshipType;
      confidence?: number;
      origin?: 'auto' | 'user' | 'ai_inferred';
    },
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<MemoryRelationshipRecord> {
    if (input.fromObject === input.toObject) {
      throw new Error('Self-referencing memory relationships are not permitted.');
    }

    const [fromObj, toObj] = await Promise.all([
      MemoryObjectService.getObject(db, input.fromObject),
      MemoryObjectService.getObject(db, input.toObject),
    ]);

    if (!fromObj) throw new Error(`Source memory object '${input.fromObject}' not found.`);
    if (!toObj) throw new Error(`Target memory object '${input.toObject}' not found.`);

    const confidence = input.confidence !== undefined ? Math.max(0.0, Math.min(1.0, input.confidence)) : 1.0;
    const origin = input.origin || 'auto';
    const nowIso = now.toISOString();

    // Check duplicate edge
    const existing = await db
      .prepare(
        'SELECT * FROM memory_relationships WHERE from_object = ? AND to_object = ? AND relationship_type = ?'
      )
      .bind(input.fromObject, input.toObject, input.relationshipType)
      .first<any>();

    if (existing) {
      if (confidence > existing.confidence) {
        await db
          .prepare('UPDATE memory_relationships SET confidence = ?, origin = ? WHERE id = ?')
          .bind(confidence, origin, existing.id)
          .run();
      }
      return {
        id: existing.id,
        fromObject: existing.from_object,
        toObject: existing.to_object,
        relationshipType: existing.relationship_type,
        confidence: Math.max(existing.confidence, confidence),
        origin,
        createdAt: existing.created_at,
        targetObject: toObj,
      };
    }

    const id = `mrel_${crypto.randomUUID()}`;

    await db
      .prepare(
        `INSERT INTO memory_relationships (id, from_object, to_object, relationship_type, confidence, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, input.fromObject, input.toObject, input.relationshipType, confidence, origin, nowIso)
      .run();

    // Audit: RELATIONSHIP_CREATED
    await AuditService.emit(
      db,
      {
        eventType: 'RELATIONSHIP_CREATED',
        entityType: 'memory_relationship',
        entityId: id,
        actor: `system:${origin}`,
        payload: {
          id,
          from_object: input.fromObject,
          to_object: input.toObject,
          type: input.relationshipType,
          confidence,
        },
        metadata: { from_object: input.fromObject, to_object: input.toObject },
      },
      env
    );

    return {
      id,
      fromObject: input.fromObject,
      toObject: input.toObject,
      relationshipType: input.relationshipType,
      confidence,
      origin,
      createdAt: nowIso,
      targetObject: toObj,
    };
  }

  /**
   * Retrieves relationships for a memory object with attached target objects.
   */
  static async getRelationships(
    db: D1Database,
    memoryObjectId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both'
  ): Promise<MemoryRelationshipRecord[]> {
    const records: MemoryRelationshipRecord[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outRows = await db
        .prepare(
          `SELECT r.*, m.id as m_id, m.type as m_type, m.title as m_title, m.canonical_text as m_text,
                  m.summary as m_summary, m.attachment_id as m_att, m.source as m_source,
                  m.metadata_json as m_meta, m.created_at as m_created, m.updated_at as m_updated
           FROM memory_relationships r
           JOIN memory_objects m ON r.to_object = m.id
           WHERE r.from_object = ?
           ORDER BY r.confidence DESC, r.created_at DESC`
        )
        .bind(memoryObjectId)
        .all<any>();

      for (const row of outRows.results || []) {
        records.push({
          id: row.id,
          fromObject: row.from_object,
          toObject: row.to_object,
          relationshipType: row.relationship_type,
          confidence: row.confidence,
          origin: row.origin,
          createdAt: row.created_at,
          targetObject: {
            id: row.m_id,
            type: row.m_type,
            title: row.m_title,
            canonicalText: row.m_text,
            summary: row.m_summary,
            attachmentId: row.m_att,
            source: row.m_source,
            metadata: row.m_meta ? JSON.parse(row.m_meta) : undefined,
            createdAt: row.m_created,
            updatedAt: row.m_updated,
          },
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inRows = await db
        .prepare(
          `SELECT r.*, m.id as m_id, m.type as m_type, m.title as m_title, m.canonical_text as m_text,
                  m.summary as m_summary, m.attachment_id as m_att, m.source as m_source,
                  m.metadata_json as m_meta, m.created_at as m_created, m.updated_at as m_updated
           FROM memory_relationships r
           JOIN memory_objects m ON r.from_object = m.id
           WHERE r.to_object = ?
           ORDER BY r.confidence DESC, r.created_at DESC`
        )
        .bind(memoryObjectId)
        .all<any>();

      for (const row of inRows.results || []) {
        records.push({
          id: row.id,
          fromObject: row.from_object,
          toObject: row.to_object,
          relationshipType: row.relationship_type,
          confidence: row.confidence,
          origin: row.origin,
          createdAt: row.created_at,
          targetObject: {
            id: row.m_id,
            type: row.m_type,
            title: row.m_title,
            canonicalText: row.m_text,
            summary: row.m_summary,
            attachmentId: row.m_att,
            source: row.m_source,
            metadata: row.m_meta ? JSON.parse(row.m_meta) : undefined,
            createdAt: row.m_created,
            updatedAt: row.m_updated,
          },
        });
      }
    }

    return records;
  }
}
