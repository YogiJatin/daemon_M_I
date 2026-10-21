/**
 * worker/memoryContextProvider.ts — Canonical Memory Context Provider
 *
 * Implements Rule 5 & Memory Context Architecture:
 * - AI receives Memory Objects -> Summaries -> Supporting relationships -> Citations
 * - Never injects entire raw PDFs or storage blobs
 * - Produces canonical deterministic XML for AIContextBuilder
 */

import { MemoryRetriever, RetrievedMemoryBundle } from './memoryRetriever';
import { AIContextBuilder, escapeXml } from './aiContextBuilder';

export class MemoryContextProvider {
  /**
   * Retrieves relevant memory bundle and injects it into AIContextBuilder.
   */
  static async injectMemoryContext(
    db: D1Database,
    query: string,
    builder: AIContextBuilder,
    options: { maxItems?: number; maxTokens?: number } = {}
  ): Promise<RetrievedMemoryBundle> {
    const bundle = await MemoryRetriever.retrieve(db, query, options);

    for (const obj of bundle.primaryObjects) {
      builder.addEntity(
        obj.id,
        'knowledge',
        {
          id: obj.id,
          title: obj.title,
          type: obj.type,
          summary: obj.summary,
          excerpt: obj.canonicalText.slice(0, 300),
          source: obj.source,
        },
        'high'
      );
    }

    return bundle;
  }

  /**
   * Formats a retrieved memory bundle into a structured canonical XML block.
   */
  static formatXml(bundle: RetrievedMemoryBundle): string {
    const lines: string[] = ['<memory_context>'];

    // 1. Objects
    lines.push('  <memory_objects>');
    for (const obj of bundle.primaryObjects) {
      lines.push(
        `    <object id="${escapeXml(obj.id)}" type="${escapeXml(obj.type)}" title="${escapeXml(obj.title)}" source="${escapeXml(obj.source)}">`
      );
      if (obj.summary) {
        lines.push(`      <summary>${escapeXml(obj.summary)}</summary>`);
      } else {
        lines.push(`      <excerpt>${escapeXml(obj.canonicalText.slice(0, 300))}</excerpt>`);
      }
      lines.push('    </object>');
    }
    lines.push('  </memory_objects>');

    // 2. Supporting Relationships
    if (bundle.supportingRelationships.length > 0) {
      lines.push('  <relationships>');
      for (const r of bundle.supportingRelationships) {
        lines.push(
          `    <relationship from="${escapeXml(r.fromObject)}" to="${escapeXml(r.toObject)}" type="${escapeXml(r.relationshipType)}" confidence="${escapeXml(r.confidence)}"/>`
        );
      }
      lines.push('  </relationships>');
    }

    // 3. Explainable Citations
    if (bundle.citations.length > 0) {
      lines.push('  <citations>');
      for (const c of bundle.citations) {
        lines.push(
          `    <citation id="${escapeXml(c.memoryId)}" confidence="${escapeXml(c.confidence)}" reason="${escapeXml(c.reasonSelected)}">${escapeXml(c.title)}</citation>`
        );
      }
      lines.push('  </citations>');
    }

    lines.push('</memory_context>');
    return lines.join('\n');
  }
}
