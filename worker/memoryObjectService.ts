/**
 * worker/memoryObjectService.ts — Canonical Memory Object Management
 *
 * Implements Rule 3 (Memory is Canonical) & Audit Integration:
 * - Deduplication via attachment references or content matching
 * - Emits MEMORY_CREATED, MEMORY_UPDATED, SUMMARY_GENERATED audit events
 * - Never mutates tasks or schedules directly (Rule 1)
 */

import { MemoryObjectType, MemoryObjectRecord } from './memoryTypes';
import { AuditService } from './auditService';

export class MemoryObjectService {
  /**
   * Retrieves or creates a canonical memory object.
   * If an attachmentId is provided, reuses existing memory object linking to it.
   */
  static async getOrCreateCanonicalObject(
    db: D1Database,
    input: {
      type: MemoryObjectType;
      title: string;
      canonicalText: string;
      summary?: string;
      attachmentId?: string;
      source: string;
      metadata?: Record<string, any>;
      tags?: string[];
    },
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ object: MemoryObjectRecord; isDuplicate: boolean }> {
    const nowIso = now.toISOString();

    // 1. Deduplication via attachment reference
    if (input.attachmentId) {
      const existing = await db
        .prepare('SELECT * FROM memory_objects WHERE attachment_id = ?')
        .bind(input.attachmentId)
        .first<any>();

      if (existing) {
        return {
          object: this.mapRow(existing),
          isDuplicate: true,
        };
      }
    }

    // 2. Exact Title + Source deduplication for notes/bookmarks
    const existingByContent = await db
      .prepare('SELECT * FROM memory_objects WHERE title = ? AND source = ? AND type = ?')
      .bind(input.title.trim(), input.source, input.type)
      .first<any>();

    if (existingByContent) {
      return {
        object: this.mapRow(existingByContent),
        isDuplicate: true,
      };
    }

    // 3. Create fresh canonical object
    const id = `mem_${crypto.randomUUID()}`;
    const title = input.title.trim();
    const canonicalText = input.canonicalText.trim();
    const summary = input.summary ? input.summary.trim() : null;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const insertStmt = db
      .prepare(
        `INSERT INTO memory_objects (
          id, type, title, canonical_text, summary, attachment_id, source, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.type,
        title,
        canonicalText,
        summary,
        input.attachmentId || null,
        input.source,
        metadataJson,
        nowIso,
        nowIso
      );

    const statements: any[] = [insertStmt];

    // Optional tags
    if (input.tags && input.tags.length > 0) {
      for (const t of input.tags) {
        const cleanTag = t.trim().toLowerCase();
        if (cleanTag) {
          statements.push(
            db
              .prepare('INSERT INTO memory_tags (id, memory_object_id, tag, created_at) VALUES (?, ?, ?, ?)')
              .bind(`mtag_${crypto.randomUUID()}`, id, cleanTag, nowIso)
          );
        }
      }
    }

    await db.batch(statements);

    // Audit: MEMORY_CREATED
    await AuditService.emit(
      db,
      {
        eventType: 'MEMORY_CREATED',
        entityType: 'memory_object',
        entityId: id,
        actor: `system:${input.source}`,
        payload: { id, type: input.type, title, source: input.source, has_attachment: Boolean(input.attachmentId) },
        metadata: { memory_id: id, type: input.type },
      },
      env
    );

    const created = await this.getObject(db, id);
    return {
      object: created!,
      isDuplicate: false,
    };
  }

  static async getObject(db: D1Database, id: string): Promise<MemoryObjectRecord | null> {
    const row = await db
      .prepare('SELECT * FROM memory_objects WHERE id = ?')
      .bind(id)
      .first<any>();

    return row ? this.mapRow(row) : null;
  }

  static async listObjects(
    db: D1Database,
    filter: { type?: MemoryObjectType; source?: string; tag?: string } = {},
    limit: number = 20,
    offset: number = 0
  ): Promise<{ objects: MemoryObjectRecord[]; total: number }> {
    let query = 'SELECT m.* FROM memory_objects m';
    let countQuery = 'SELECT COUNT(DISTINCT m.id) as count FROM memory_objects m';
    const params: any[] = [];
    const countParams: any[] = [];
    const conditions: string[] = [];

    if (filter.tag) {
      query += ' JOIN memory_tags t ON m.id = t.memory_object_id';
      countQuery += ' JOIN memory_tags t ON m.id = t.memory_object_id';
      conditions.push('t.tag = ?');
      params.push(filter.tag.toLowerCase().trim());
      countParams.push(filter.tag.toLowerCase().trim());
    }

    if (filter.type) {
      conditions.push('m.type = ?');
      params.push(filter.type);
      countParams.push(filter.type);
    }

    if (filter.source) {
      conditions.push('m.source = ?');
      params.push(filter.source);
      countParams.push(filter.source);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      query += whereClause;
      countQuery += whereClause;
    }

    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      db.prepare(query).bind(...params).all<any>(),
      db.prepare(countQuery).bind(...countParams).first<{ count: number }>(),
    ]);

    return {
      objects: (rowsRes.results || []).map((r: any) => this.mapRow(r)),
      total: countRes?.count || 0,
    };
  }

  static async updateSummary(
    db: D1Database,
    id: string,
    summary: string,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<MemoryObjectRecord> {
    const nowIso = now.toISOString();

    await db
      .prepare('UPDATE memory_objects SET summary = ?, updated_at = ? WHERE id = ?')
      .bind(summary.trim(), nowIso, id)
      .run();

    // Audit: SUMMARY_GENERATED
    await AuditService.emit(
      db,
      {
        eventType: 'SUMMARY_GENERATED',
        entityType: 'memory_object',
        entityId: id,
        actor: 'system:summarizer',
        payload: { memory_id: id, summary_length: summary.length },
        metadata: { memory_id: id },
      },
      env
    );

    const updated = await this.getObject(db, id);
    if (!updated) throw new Error(`Memory object not found: ${id}`);
    return updated;
  }

  static async addTag(db: D1Database, memoryObjectId: string, tag: string, now: Date = new Date()): Promise<void> {
    const cleanTag = tag.trim().toLowerCase();
    if (!cleanTag) return;

    const existing = await db
      .prepare('SELECT id FROM memory_tags WHERE memory_object_id = ? AND tag = ?')
      .bind(memoryObjectId, cleanTag)
      .first();

    if (!existing) {
      await db
        .prepare('INSERT INTO memory_tags (id, memory_object_id, tag, created_at) VALUES (?, ?, ?, ?)')
        .bind(`mtag_${crypto.randomUUID()}`, memoryObjectId, cleanTag, now.toISOString())
        .run();
    }
  }

  static async getTags(db: D1Database, memoryObjectId: string): Promise<string[]> {
    const rows = await db
      .prepare('SELECT tag FROM memory_tags WHERE memory_object_id = ? ORDER BY tag ASC')
      .bind(memoryObjectId)
      .all<{ tag: string }>();

    return (rows.results || []).map((r) => r.tag);
  }

  private static mapRow(row: any): MemoryObjectRecord {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      canonicalText: row.canonical_text,
      summary: row.summary,
      attachmentId: row.attachment_id,
      source: row.source,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
