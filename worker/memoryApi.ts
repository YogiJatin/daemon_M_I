/**
 * worker/memoryApi.ts — Memory OS API Service Router
 *
 * Exposes:
 * - GET  /api/v1/memory
 * - GET  /api/v1/memory/:id
 * - GET  /api/v1/memory/search
 * - GET  /api/v1/memory/:id/relationships (and related/:id)
 * - GET  /api/v1/memory/:id/timeline (and timeline/:id)
 * - GET  /api/v1/memory/:id/graph
 * - POST /api/v1/memory/:id/summarize
 * - POST /api/v1/memory/link
 *
 * Backward-compatible aliases:
 * - All /api/v1/knowledge/* routes transparently alias to /api/v1/memory/*
 */

import { MemoryObjectService } from './memoryObjectService';
import { MemoryRelationshipService } from './memoryRelationshipService';
import { MemorySearchEngine } from './memorySearch';
import { MemoryTimelineEngine } from './memoryTimeline';
import { MemoryGraphEngine } from './memoryGraph';
import { MemorySummarizer } from './memorySummarizer';
import { MemoryObjectType, MemoryRelationshipType } from './memoryTypes';

export async function handleMemoryApi(
  request: Request,
  env: Record<string, any>,
  now: Date = new Date()
): Promise<Response | null> {
  const url = new URL(request.url);
  let path = url.pathname;
  const method = request.method;

  // Transparent alias: /api/v1/knowledge/* -> /api/v1/memory/*
  if (path.startsWith('/api/v1/knowledge')) {
    path = path.replace('/api/v1/knowledge', '/api/v1/memory');
  }

  if (!path.startsWith('/api/v1/memory')) {
    return null;
  }

  const jsonSuccess = (data: any, status: number = 200) =>
    Response.json({ ok: true, data }, { status });
  const jsonError = (code: string, message: string, status: number = 400) =>
    Response.json({ ok: false, error: { code, message } }, { status });

  // 1. GET /api/v1/memory/search
  if (method === 'GET' && path === '/api/v1/memory/search') {
    const keyword = url.searchParams.get('q') || url.searchParams.get('keyword') || undefined;
    const tag = url.searchParams.get('tag') || undefined;
    const type = (url.searchParams.get('type') as MemoryObjectType) || undefined;
    const relationship = (url.searchParams.get('relationship') as MemoryRelationshipType) || undefined;
    const source = url.searchParams.get('source') || undefined;
    const attachmentId = url.searchParams.get('attachment_id') || undefined;
    const fromDate = url.searchParams.get('from') || undefined;
    const toDate = url.searchParams.get('to') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const results = await MemorySearchEngine.search(env.DB, {
      keyword,
      tag,
      type,
      relationship,
      source,
      attachmentId,
      fromDate,
      toDate,
      limit,
      offset,
    });

    return jsonSuccess({
      results,
      count: results.length,
      limit,
      offset,
    });
  }

  // 1B. POST /api/v1/memory (Canonical Object Ingestion)
  if (method === 'POST' && path === '/api/v1/memory') {
    const body = await request.json<any>().catch(() => ({}));
    const canonicalText = body.canonicalText || body.canonical_text;
    if (!body.title || !body.type || !canonicalText) {
      return jsonError('bad_request', "Missing 'title', 'type', or 'canonicalText'.", 400);
    }
    const result = await MemoryObjectService.getOrCreateCanonicalObject(
      env.DB,
      {
        type: body.type,
        title: body.title,
        canonicalText,
        summary: body.summary,
        attachmentId: body.attachmentId || body.attachment_id,
        source: body.source || 'api',
        tags: body.tags,
        metadata: body.metadata,
      },
      env,
      now
    );
    return jsonSuccess({ object: result.object, isDuplicate: result.isDuplicate, ...result.object }, result.isDuplicate ? 200 : 201);
  }

  // 2. GET /api/v1/memory
  if (method === 'GET' && path === '/api/v1/memory') {
    const type = (url.searchParams.get('type') as MemoryObjectType) || undefined;
    const source = url.searchParams.get('source') || undefined;
    const tag = url.searchParams.get('tag') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const data = await MemoryObjectService.listObjects(env.DB, { type, source, tag }, limit, offset);
    return jsonSuccess({
      objects: data.objects,
      total: data.total,
      limit,
      offset,
    });
  }

  // 3. POST /api/v1/memory/link
  if (method === 'POST' && path === '/api/v1/memory/link') {
    const body = await request.json<any>().catch(() => ({}));
    if (!body.from_object || !body.to_object || !body.relationship_type) {
      return jsonError('bad_request', "Missing 'from_object', 'to_object', or 'relationship_type'.", 400);
    }

    try {
      const rel = await MemoryRelationshipService.link(
        env.DB,
        {
          fromObject: body.from_object,
          toObject: body.to_object,
          relationshipType: body.relationship_type,
          confidence: body.confidence,
          origin: body.origin || 'user',
        },
        env,
        now
      );
      return jsonSuccess({ relationship: rel, ...rel }, 201);
    } catch (err: any) {
      return jsonError('link_failed', err.message, 400);
    }
  }

  // 4. POST /api/v1/memory/:id/summarize
  if (method === 'POST' && path.match(/^\/api\/v1\/memory\/[^/]+\/summarize$/)) {
    const memoryId = path.split('/')[4];
    const body = await request.json<any>().catch(() => ({}));
    const forceRefresh = Boolean(body.force);

    try {
      const res = await MemorySummarizer.getOrGenerateSummary(env.DB, memoryId, forceRefresh, env, now);
      return jsonSuccess({
        summary: res.summary,
        wasCached: res.wasCached,
        cached: res.wasCached,
      });
    } catch (err: any) {
      return jsonError('summarize_failed', err.message, 404);
    }
  }

  // 5. GET /api/v1/memory/:id/relationships & GET /api/v1/memory/related/:id
  if (
    method === 'GET' &&
    (path.match(/^\/api\/v1\/memory\/[^/]+\/relationships$/) || path.match(/^\/api\/v1\/memory\/related\/[^/]+$/))
  ) {
    const memoryId = path.startsWith('/api/v1/memory/related/')
      ? path.replace('/api/v1/memory/related/', '')
      : path.split('/')[4];

    const direction = (url.searchParams.get('direction') as any) || 'both';
    const rels = await MemoryRelationshipService.getRelationships(env.DB, memoryId, direction);
    return jsonSuccess({
      memory_id: memoryId,
      relationships: rels,
      count: rels.length,
    });
  }

  // 6. GET /api/v1/memory/:id/timeline & GET /api/v1/memory/timeline/:id
  if (
    method === 'GET' &&
    (path.match(/^\/api\/v1\/memory\/[^/]+\/timeline$/) || path.match(/^\/api\/v1\/memory\/timeline\/[^/]+$/))
  ) {
    const memoryId = path.startsWith('/api/v1/memory/timeline/')
      ? path.replace('/api/v1/memory/timeline/', '')
      : path.split('/')[4];

    const events = await MemoryTimelineEngine.getTimeline(env.DB, memoryId);
    return jsonSuccess({
      memory_id: memoryId,
      timeline: events,
      count: events.length,
    });
  }

  // 7. GET /api/v1/memory/:id/graph
  if (method === 'GET' && path.match(/^\/api\/v1\/memory\/[^/]+\/graph$/)) {
    const memoryId = path.split('/')[4];
    const depth = parseInt(url.searchParams.get('depth') || '2', 10);
    const graph = await MemoryGraphEngine.getSubgraph(env.DB, memoryId, depth);
    return jsonSuccess({
      root_id: memoryId,
      graph,
    });
  }

  // 8. GET /api/v1/memory/:id
  if (method === 'GET' && path.match(/^\/api\/v1\/memory\/[^/]+$/)) {
    const memoryId = path.replace('/api/v1/memory/', '');
    const obj = await MemoryObjectService.getObject(env.DB, memoryId);
    if (!obj) {
      return jsonError('not_found', `Memory object '${memoryId}' not found.`, 404);
    }

    const [tags, rels] = await Promise.all([
      MemoryObjectService.getTags(env.DB, memoryId),
      MemoryRelationshipService.getRelationships(env.DB, memoryId, 'both'),
    ]);

    return jsonSuccess({
      object: obj,
      ...obj,
      tags,
      relationship_count: rels.length,
      relationships_count: rels.length,
    });
  }

  return null;
}
