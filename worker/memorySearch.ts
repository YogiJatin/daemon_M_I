/**
 * worker/memorySearch.ts — Multi-Faceted Memory Search Engine
 *
 * Implements:
 * - Keyword matching over title, canonical text, summary
 * - Faceted filtering by tag, type, source, attachment, date range
 * - Multi-criteria scoring:
 *   Relevance Score = KeywordWeight (50%) + RelationshipStrength (25%) + RecencyWeight (25%)
 */

import { MemorySearchQuery, MemorySearchResult, MemoryObjectRecord } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';

export class MemorySearchEngine {
  static async search(db: D1Database, query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const limit = Math.min(query.limit || 20, 50);
    const offset = query.offset || 0;

    let sql = `
      SELECT m.*,
             COUNT(DISTINCT r.id) as rel_count,
             GROUP_CONCAT(DISTINCT t.tag) as tags_list
      FROM memory_objects m
      LEFT JOIN memory_relationships r ON (m.id = r.from_object OR m.id = r.to_object)
      LEFT JOIN memory_tags t ON m.id = t.memory_object_id
    `;

    const whereClauses: string[] = [];
    const params: any[] = [];

    // Keyword filter: match all keyword tokens across title, canonical_text, or summary
    if (query.keyword && query.keyword.trim()) {
      const tokens = query.keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const kw = `%${token}%`;
        whereClauses.push("(LOWER(m.title) LIKE ? OR LOWER(m.canonical_text) LIKE ? OR LOWER(COALESCE(m.summary, '')) LIKE ?)");
        params.push(kw, kw, kw);
      }
    }

    // Type filter
    if (query.type) {
      whereClauses.push('m.type = ?');
      params.push(query.type);
    }

    // Source filter
    if (query.source) {
      whereClauses.push('m.source = ?');
      params.push(query.source);
    }

    // Attachment filter
    if (query.attachmentId) {
      whereClauses.push('m.attachment_id = ?');
      params.push(query.attachmentId);
    }

    // Date range
    if (query.fromDate) {
      whereClauses.push('m.created_at >= ?');
      params.push(query.fromDate);
    }
    if (query.toDate) {
      whereClauses.push('m.created_at <= ?');
      params.push(query.toDate);
    }

    // Tag filter
    if (query.tag) {
      whereClauses.push('m.id IN (SELECT memory_object_id FROM memory_tags WHERE tag = ?)');
      params.push(query.tag.trim().toLowerCase());
    }

    // Relationship type filter
    if (query.relationship) {
      whereClauses.push('m.id IN (SELECT from_object FROM memory_relationships WHERE relationship_type = ? UNION SELECT to_object FROM memory_relationships WHERE relationship_type = ?)');
      params.push(query.relationship, query.relationship);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' GROUP BY m.id';

    const rawRows = await db.prepare(sql).bind(...params).all<any>();
    const rows = rawRows.results || [];

    // Calculate ranking scores
    const now = Date.now();
    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      const obj: MemoryObjectRecord = {
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

      const tags = row.tags_list ? (row.tags_list as string).split(',').filter(Boolean) : [];
      const relCount = row.rel_count ? Number(row.rel_count) : 0;

      // Scoring
      let kwScore = 0.5;
      if (query.keyword) {
        const kw = query.keyword.toLowerCase();
        const inTitle = obj.title.toLowerCase().includes(kw);
        const inSummary = (obj.summary || '').toLowerCase().includes(kw);
        const inText = obj.canonicalText.toLowerCase().includes(kw);
        if (inTitle) kwScore = 1.0;
        else if (inSummary) kwScore = 0.8;
        else if (inText) kwScore = 0.6;
      }

      // Graph density score
      const graphScore = Math.min(relCount * 0.1, 1.0);

      // Recency score (decays over 30 days)
      const ageMs = now - new Date(obj.createdAt).getTime();
      const recencyScore = Math.max(0.1, 1.0 - ageMs / (30 * 24 * 3600 * 1000));

      const relevanceScore = Math.round((kwScore * 0.5 + graphScore * 0.25 + recencyScore * 0.25) * 100) / 100;

      // Snippet generator
      let snippet: string | undefined;
      if (obj.summary) {
        snippet = obj.summary.slice(0, 160);
      } else {
        snippet = obj.canonicalText.slice(0, 160);
      }

      results.push({
        object: obj,
        relevanceScore,
        matchedTags: tags,
        relationshipsCount: relCount,
        snippet,
      });
    }

    // Sort by relevanceScore DESC, recency DESC
    results.sort((a, b) => b.relevanceScore - a.relevanceScore || b.object.createdAt.localeCompare(a.object.createdAt));

    return results.slice(offset, offset + limit);
  }
}
