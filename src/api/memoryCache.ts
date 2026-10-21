/**
 * src/api/memoryCache.ts — Client-Side Memory Cache & Offline Search
 *
 * Implements PWA Offline Memory Architecture:
 * - Caches: summaries, metadata, relationships, search index
 * - Strictly NEVER caches: large binaries, raw PDFs, large images
 * - Uses in-memory / local storage index for instant search during network degradation
 */

export interface CachedMemoryItem {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  snippet: string;
  tags: string[];
  relationshipsCount: number;
  updatedAt: string;
}

const CACHE_KEY = 'personal_ai_os_memory_index_v1';
const MAX_CACHED_ITEMS = 200;

class MemoryCacheStore {
  private inMemoryIndex = new Map<string, CachedMemoryItem>();

  constructor() {
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const serialized = sessionStorage.getItem(CACHE_KEY);
      if (serialized) {
        const parsed = JSON.parse(serialized);
        for (const item of parsed) {
          this.inMemoryIndex.set(item.id, item);
        }
      }
    } catch {
      // Ignore cache hydration errors
    }
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const items = Array.from(this.inMemoryIndex.values()).slice(-MAX_CACHED_ITEMS);
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(items));
    } catch {
      // Ignore storage quota errors
    }
  }

  public put(item: CachedMemoryItem): void {
    this.inMemoryIndex.set(item.id, item);
    this.persistToStorage();
  }

  public putBatch(items: CachedMemoryItem[]): void {
    for (const it of items) {
      this.inMemoryIndex.set(it.id, it);
    }
    this.persistToStorage();
  }

  public get(id: string): CachedMemoryItem | undefined {
    return this.inMemoryIndex.get(id);
  }

  public searchOffline(keyword: string): CachedMemoryItem[] {
    const kw = keyword.toLowerCase().trim();
    if (!kw) return Array.from(this.inMemoryIndex.values()).slice(0, 20);

    const matches: { item: CachedMemoryItem; score: number }[] = [];

    for (const item of this.inMemoryIndex.values()) {
      let score = 0;
      if (item.title.toLowerCase().includes(kw)) score += 3;
      if (item.summary && item.summary.toLowerCase().includes(kw)) score += 2;
      if (item.snippet && item.snippet.toLowerCase().includes(kw)) score += 1;
      if (item.tags.some((t) => t.toLowerCase().includes(kw))) score += 2;

      if (score > 0) {
        matches.push({ item, score });
      }
    }

    matches.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
    return matches.slice(0, 20).map((m) => m.item);
  }

  public clear(): void {
    this.inMemoryIndex.clear();
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }
}

export const memoryCache = new MemoryCacheStore();
