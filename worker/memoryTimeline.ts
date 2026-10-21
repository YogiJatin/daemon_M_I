/**
 * worker/memoryTimeline.ts — Chronological Knowledge Evolution Engine
 *
 * Implements Memory Timeline (Distinct from Audit):
 * - Audit answers: "Did this happen?" (Forensic cryptographic proof)
 * - Memory Timeline answers: "What do we know? How did our understanding evolve?"
 */

import { MemoryTimelineEvent } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';

export class MemoryTimelineEngine {
  /**
   * Constructs the chronological evolution timeline for a specific memory object.
   */
  static async getTimeline(db: D1Database, memoryObjectId: string): Promise<MemoryTimelineEvent[]> {
    const events: MemoryTimelineEvent[] = [];
    const root = await MemoryObjectService.getObject(db, memoryObjectId);
    if (!root) return [];

    // 1. Initial creation
    events.push({
      id: `evt_init_${root.id}`,
      timestamp: root.createdAt,
      eventType: 'object_created',
      description: `Canonical memory object '${root.title}' registered via ${root.source}.`,
      memoryObjectId: root.id,
      source: root.source,
    });

    // 2. Summary generation (if present)
    if (root.summary) {
      events.push({
        id: `evt_sum_${root.id}`,
        timestamp: root.updatedAt,
        eventType: 'summary_generated',
        description: `Executive summary synthesized for '${root.title}'.`,
        memoryObjectId: root.id,
      });
    }

    // 3. Tags added
    const tags = await db
      .prepare('SELECT id, tag, created_at FROM memory_tags WHERE memory_object_id = ? ORDER BY created_at ASC')
      .bind(memoryObjectId)
      .all<{ id: string; tag: string; created_at: string }>();

    for (const t of tags.results || []) {
      events.push({
        id: `evt_tag_${t.id}`,
        timestamp: t.created_at,
        eventType: 'tag_added',
        description: `Tagged with '#${t.tag}'.`,
        memoryObjectId: root.id,
      });
    }

    // 4. Relationships linked (outgoing and incoming)
    const rels = await db
      .prepare(
        `SELECT r.id, r.from_object, r.to_object, r.relationship_type, r.confidence, r.created_at,
                m.title as target_title
         FROM memory_relationships r
         JOIN memory_objects m ON (CASE WHEN r.from_object = ? THEN r.to_object ELSE r.from_object END) = m.id
         WHERE r.from_object = ? OR r.to_object = ?
         ORDER BY r.created_at ASC`
      )
      .bind(memoryObjectId, memoryObjectId, memoryObjectId)
      .all<any>();

    for (const r of rels.results || []) {
      const isOutgoing = r.from_object === memoryObjectId;
      const otherId = isOutgoing ? r.to_object : r.from_object;
      const desc = isOutgoing
        ? `Linked as ${r.relationship_type} -> '${r.target_title}' (confidence: ${r.confidence}).`
        : `Connected by '${r.target_title}' (${r.relationship_type}) -> this object.`;

      events.push({
        id: `evt_rel_${r.id}`,
        timestamp: r.created_at,
        eventType: 'relationship_linked',
        description: desc,
        memoryObjectId: root.id,
        relatedObjectId: otherId,
        confidence: r.confidence,
      });
    }

    // Sort chronologically ascending
    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
