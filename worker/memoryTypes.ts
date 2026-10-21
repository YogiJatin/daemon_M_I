/**
 * worker/memoryTypes.ts — Memory OS Type Definitions
 *
 * Implements canonical memory architecture:
 * - 18 Canonical Memory Object Types
 * - 10 Graph Edge Relationship Types
 * - Explainable retrieval and citation models
 * - Token-bounded context representations
 */

export type MemoryObjectType =
  | 'document'
  | 'lecture'
  | 'note'
  | 'research'
  | 'voice_note'
  | 'screenshot'
  | 'image'
  | 'question'
  | 'answer'
  | 'summary'
  | 'bookmark'
  | 'website'
  | 'email'
  | 'task_reference'
  | 'conversation'
  | 'desktop_capture'
  | 'browser_capture'
  | 'reference';

export type MemoryRelationshipType =
  | 'references'
  | 'summarizes'
  | 'derived_from'
  | 'supports'
  | 'contradicts'
  | 'mentions'
  | 'related_to'
  | 'belongs_to_subject'
  | 'generated_from'
  | 'duplicate_of';

export interface MemoryObjectRecord {
  id: string;
  type: MemoryObjectType;
  title: string;
  canonicalText: string;
  summary: string | null;
  attachmentId: string | null;
  source: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRelationshipRecord {
  id: string;
  fromObject: string;
  toObject: string;
  relationshipType: MemoryRelationshipType;
  confidence: number;
  origin: 'auto' | 'user' | 'ai_inferred';
  createdAt: string;
  targetObject?: MemoryObjectRecord;
}

export interface MemoryTagRecord {
  id: string;
  memoryObjectId: string;
  tag: string;
  createdAt: string;
}

export interface MemorySearchQuery {
  keyword?: string;
  tag?: string;
  type?: MemoryObjectType;
  relationship?: MemoryRelationshipType;
  source?: string;
  attachmentId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult {
  object: MemoryObjectRecord;
  relevanceScore: number;
  matchedTags: string[];
  relationshipsCount: number;
  snippet?: string;
}

export interface MemoryCitation {
  memoryId: string;
  title: string;
  type: MemoryObjectType;
  excerpt: string;
  confidence: number;
  source: string;
  timestamp: string;
  reasonSelected: string;
}

export interface MemoryTimelineEvent {
  id: string;
  timestamp: string;
  eventType: 'object_created' | 'summary_generated' | 'relationship_linked' | 'task_associated' | 'tag_added';
  description: string;
  memoryObjectId: string;
  relatedObjectId?: string;
  confidence?: number;
  source?: string;
}

export interface MemoryGraphNode {
  id: string;
  title: string;
  type: MemoryObjectType;
  summary: string | null;
}

export interface MemoryGraphEdge {
  id: string;
  from: string;
  to: string;
  type: MemoryRelationshipType;
  confidence: number;
}

export interface MemoryGraphData {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  depth: number;
}
