/**
 * worker/memoryIndexer.ts — Ingress Memory Indexer & Auto-Relationship Discovery
 *
 * Implements:
 * - Automatic conversion from Ingress observations to canonical Memory Objects
 * - Automated relationship linking (belongs_to_subject, references, duplicate_of)
 * - Automatic tag extraction
 */

import { MemoryObjectType } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';
import { MemoryRelationshipService } from './memoryRelationshipService';

export class MemoryIndexer {
  /**
   * Indexes a normalized ingress item into the Memory OS.
   */
  static async indexFromIngress(
    db: D1Database,
    input: {
      type: MemoryObjectType;
      title: string;
      text: string;
      attachmentId?: string;
      source: string;
      metadata?: Record<string, any>;
    },
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ memoryObjectId: string; isDuplicate: boolean; relationshipsCreated: number }> {
    const rawText = input.text.trim();
    const title = input.title.trim();

    // 1. Extract automated tags from content
    const tags = this.extractTags(title + ' ' + rawText);

    // 2. Create canonical object
    const { object, isDuplicate } = await MemoryObjectService.getOrCreateCanonicalObject(
      db,
      {
        type: input.type,
        title,
        canonicalText: rawText,
        attachmentId: input.attachmentId,
        source: input.source,
        metadata: input.metadata,
        tags,
      },
      env,
      now
    );

    let relCount = 0;

    // 3. Automated relationship discovery (if not duplicate)
    if (!isDuplicate) {
      relCount = await this.discoverRelationships(db, object.id, title, rawText, env, now);
    }

    return {
      memoryObjectId: object.id,
      isDuplicate,
      relationshipsCreated: relCount,
    };
  }

  /**
   * Extracts tags from hashtags and common academic/system keywords.
   */
  private static extractTags(text: string): string[] {
    const tags = new Set<string>();
    const lower = text.toLowerCase();

    // Hashtags
    const hashMatches = text.match(/#([a-zA-Z0-9_]{2,20})/g);
    if (hashMatches) {
      for (const m of hashMatches) {
        tags.add(m.slice(1).toLowerCase());
      }
    }

    // Common semantic tags
    const keywords = ['exam', 'syllabus', 'lecture', 'assignment', 'research', 'lab', 'tutorial', 'operating_systems', 'discrete_math', 'project'];
    for (const kw of keywords) {
      if (lower.includes(kw.replace('_', ' '))) {
        tags.add(kw);
      }
    }

    return Array.from(tags);
  }

  /**
   * Discovers connections to existing subjects or referenced memory objects.
   */
  private static async discoverRelationships(
    db: D1Database,
    objectId: string,
    title: string,
    text: string,
    env: Record<string, any>,
    now: Date
  ): Promise<number> {
    let createdCount = 0;
    const lower = (title + ' ' + text).toLowerCase();

    // 1. Link to known Timetable Subjects
    const subjects = await db.prepare('SELECT id, name, code FROM timetable_subjects').all<{ id: string; name: string; code?: string }>();
    for (const sub of subjects.results || []) {
      if (lower.includes(sub.name.toLowerCase()) || (sub.code && lower.includes(sub.code.toLowerCase()))) {
        // Find or create subject memory reference
        const subMem = await MemoryObjectService.getOrCreateCanonicalObject(
          db,
          {
            type: 'reference',
            title: `Subject: ${sub.name}`,
            canonicalText: `Academic curriculum subject reference: ${sub.name} (${sub.code || ''})`,
            source: 'timetable_engine',
          },
          env,
          now
        );

        await MemoryRelationshipService.link(
          db,
          {
            fromObject: objectId,
            toObject: subMem.object.id,
            relationshipType: 'belongs_to_subject',
            confidence: 0.95,
            origin: 'auto',
          },
          env,
          now
        );
        createdCount++;
      }
    }

    // 2. Discover references to existing memory objects by title match
    const recentObjects = await db
      .prepare('SELECT id, title FROM memory_objects WHERE id != ? ORDER BY created_at DESC LIMIT 30')
      .bind(objectId)
      .all<{ id: string; title: string }>();

    for (const ro of recentObjects.results || []) {
      if (ro.title.length > 5 && lower.includes(ro.title.toLowerCase())) {
        await MemoryRelationshipService.link(
          db,
          {
            fromObject: objectId,
            toObject: ro.id,
            relationshipType: 'references',
            confidence: 0.85,
            origin: 'auto',
          },
          env,
          now
        );
        createdCount++;
      }
    }

    return createdCount;
  }
}
