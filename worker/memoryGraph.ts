/**
 * worker/memoryGraph.ts — Cycle-Safe Deterministic Knowledge Graph Engine
 *
 * Implements:
 * - Cycle detection via visited sets
 * - Bounded depth traversal (ceiling = 3)
 * - Deterministic, stable ordering
 * - Canonical graph serialization
 */

import { MemoryGraphData, MemoryGraphNode, MemoryGraphEdge } from './memoryTypes';
import { MemoryObjectService } from './memoryObjectService';

export class MemoryGraphEngine {
  /**
   * Traverses the graph from a starting memory object up to maxDepth.
   * Guaranteed cycle-free and deterministically sorted.
   */
  static async getSubgraph(
    db: D1Database,
    startObjectId: string,
    maxDepth: number = 2
  ): Promise<MemoryGraphData> {
    const depthLimit = Math.min(Math.max(1, maxDepth), 3);
    const visited = new Set<string>();
    const nodeMap = new Map<string, MemoryGraphNode>();
    const edges: MemoryGraphEdge[] = [];
    const edgeKeys = new Set<string>();

    let currentLevel = [startObjectId];
    let depth = 0;

    while (currentLevel.length > 0 && depth <= depthLimit) {
      const nextLevel: string[] = [];

      for (const objId of currentLevel) {
        if (visited.has(objId)) continue;
        visited.add(objId);

        const obj = await MemoryObjectService.getObject(db, objId);
        if (obj) {
          nodeMap.set(obj.id, {
            id: obj.id,
            title: obj.title,
            type: obj.type,
            summary: obj.summary,
          });
        }

        if (depth < depthLimit) {
          // Fetch outgoing and incoming edges
          const rels = await db
            .prepare(
              `SELECT id, from_object, to_object, relationship_type, confidence
               FROM memory_relationships
               WHERE from_object = ? OR to_object = ?
               ORDER BY confidence DESC, id ASC`
            )
            .bind(objId, objId)
            .all<any>();

          for (const r of rels.results || []) {
            const edgeKey = `${r.from_object}->${r.to_object}:${r.relationship_type}`;
            if (!edgeKeys.has(edgeKey)) {
              edgeKeys.add(edgeKey);
              edges.push({
                id: r.id,
                from: r.from_object,
                to: r.to_object,
                type: r.relationship_type,
                confidence: r.confidence,
              });

              const neighborId = r.from_object === objId ? r.to_object : r.from_object;
              if (!visited.has(neighborId)) {
                nextLevel.push(neighborId);
              }
            }
          }
        }
      }

      currentLevel = nextLevel;
      depth++;
    }

    // Deterministic sorting
    const nodes = Array.from(nodeMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

    return {
      nodes,
      edges,
      depth: depthLimit,
    };
  }

  /**
   * Deterministically formats a subgraph into a canonical human/AI-readable text block.
   */
  static formatCanonicalGraph(graph: MemoryGraphData): string {
    const lines: string[] = [];
    lines.push(`GRAPH_NODES (${graph.nodes.length}):`);
    for (const n of graph.nodes) {
      lines.push(`- [${n.type}] "${n.title}" (id: ${n.id})${n.summary ? ` — ${n.summary.slice(0, 100)}` : ''}`);
    }

    lines.push(`\nGRAPH_EDGES (${graph.edges.length}):`);
    for (const e of graph.edges) {
      lines.push(`- ${e.from} --(${e.type}, conf: ${e.confidence})--> ${e.to}`);
    }

    return lines.join('\n');
  }
}
