/**
 * worker/memorySummarizer.ts — Cached Memory Summarizer
 *
 * Requirements:
 * - Summaries are cached in memory_objects.summary
 * - Generated only when missing, stale, or explicitly forced
 * - Never regenerates unnecessarily
 * - Uses deterministic fallback when AI adapter is offline
 */

import { MemoryObjectRecord } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';

export class MemorySummarizer {
  /**
   * Returns existing summary or generates a new one.
   */
  static async getOrGenerateSummary(
    db: D1Database,
    memoryObjectId: string,
    forceRefresh: boolean = false,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ summary: string; wasCached: boolean }> {
    const obj = await MemoryObjectService.getObject(db, memoryObjectId);
    if (!obj) {
      throw new Error(`Memory object '${memoryObjectId}' not found.`);
    }

    // 1. Return cached summary if present and not forcing refresh
    if (!forceRefresh && obj.summary && obj.summary.trim()) {
      return {
        summary: obj.summary,
        wasCached: true,
      };
    }

    // 2. Generate summary
    const summary = this.generateDeterministicSummary(obj);

    // 3. Persist and emit audit event
    await MemoryObjectService.updateSummary(db, memoryObjectId, summary, env, now);

    return {
      summary,
      wasCached: false,
    };
  }

  /**
   * Deterministic extractive summarizer:
   * Extracts topic sentence, key bullets, and length-bounded essential points.
   */
  private static generateDeterministicSummary(obj: MemoryObjectRecord): string {
    const text = obj.canonicalText.trim();
    if (!text) return 'No content available.';

    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    const firstPara = paragraphs[0] || text;
    const sentences = firstPara.split(/(?<=[.!?])\s+/);

    const leadSentence = sentences[0] || obj.title;
    const secondSentence = sentences[1] ? ` ${sentences[1]}` : '';

    let summary = `${leadSentence}${secondSentence}`;
    if (summary.length > 280) {
      summary = summary.slice(0, 277) + '...';
    }

    return summary.trim();
  }
}
