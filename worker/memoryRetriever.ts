/**
 * worker/memoryRetriever.ts — Grounded Explainable Memory Retrieval Layer
 *
 * Implements:
 * - Top-K retrieval bounded by token budgets
 * - Automatic citation generation with explicit selection reasons
 * - Graph relationship expansion (1-hop neighbors)
 * - Summary fallback to prevent context overflow
 */

import { MemoryCitation, MemoryObjectRecord, MemoryRelationshipRecord } from './memoryTypes';
import { MemorySearchEngine } from './memorySearch';
import { MemoryRelationshipService } from './memoryRelationshipService';

export interface RetrievedMemoryBundle {
  primaryObjects: MemoryObjectRecord[];
  citations: MemoryCitation[];
  supportingRelationships: MemoryRelationshipRecord[];
  totalTokensEstimated: number;
}

export class MemoryRetriever {
  /**
   * Retrieves relevant memory objects with citations and 1-hop relationship context.
   */
  static async retrieve(
    db: D1Database,
    queryText: string,
    options: {
      maxItems?: number;
      maxTokens?: number;
      includeRelationships?: boolean;
    } = {}
  ): Promise<RetrievedMemoryBundle> {
    const maxItems = options.maxItems || 3;
    const maxTokens = options.maxTokens || 1200;
    const includeRels = options.includeRelationships !== false;

    // 1. Search relevant memory objects
    const searchResults = await MemorySearchEngine.search(db, {
      keyword: queryText,
      limit: maxItems,
    });

    const primaryObjects: MemoryObjectRecord[] = [];
    const citations: MemoryCitation[] = [];
    const relationships: MemoryRelationshipRecord[] = [];
    const seenRelIds = new Set<string>();

    let currentTokens = 0;

    for (const res of searchResults) {
      const obj = res.object;
      const textToInject = obj.summary || obj.canonicalText.slice(0, 300);
      const estTokens = Math.ceil(textToInject.length / 4);

      if (currentTokens + estTokens > maxTokens && primaryObjects.length > 0) {
        break; // Respect token budget ceiling
      }

      currentTokens += estTokens;
      primaryObjects.push(obj);

      // Generate Explainable Citation
      citations.push({
        memoryId: obj.id,
        title: obj.title,
        type: obj.type,
        excerpt: textToInject,
        confidence: res.relevanceScore,
        source: obj.source,
        timestamp: obj.createdAt,
        reasonSelected: `Matched keyword/topic query '${queryText}' with relevance score ${res.relevanceScore}`,
      });

      // Expand 1-hop relationships
      if (includeRels) {
        const rels = await MemoryRelationshipService.getRelationships(db, obj.id, 'both');
        for (const r of rels.slice(0, 3)) {
          if (!seenRelIds.has(r.id)) {
            seenRelIds.add(r.id);
            relationships.push(r);
          }
        }
      }
    }

    return {
      primaryObjects,
      citations,
      supportingRelationships: relationships,
      totalTokensEstimated: currentTokens,
    };
  }
}
