/**
 * worker/aiPromptCache.ts
 *
 * Deterministic Memory-First Prompt Cache for Personal AI OS.
 *
 * Requirements:
 * - Memory-first LRU cache with automatic TTL expiration.
 * - Optional D1 fallback.
 * - Cache key: SHA256(capability + promptVersion + contextVersion + canonicalXML + normalizedRequest)
 * - Cache only successful structured responses.
 * - NEVER cache provider failures, validation failures, rate limits, or malformed outputs.
 */

export interface CacheEntry<T = any> {
  key: string;
  capability: string;
  promptVersion: string;
  contextVersion: string;
  data: T;
  rawText: string;
  provider: string;
  model: string;
  createdAt: number;
  expiresAt: number;
}

export class AIPromptCache {
  private static memoryCache = new Map<string, CacheEntry>();
  private static maxMemoryEntries = 200;

  /**
   * Computes deterministic SHA-256 cache key.
   */
  public static async computeKey(
    capability: string,
    promptVersion: string,
    contextVersion: string,
    canonicalXml: string,
    normalizedRequest: string
  ): Promise<string> {
    // Canonical normalization: collapse whitespace, trim
    const normXml = canonicalXml.replace(/\s+/g, " ").trim();
    const normReq = normalizedRequest.replace(/\s+/g, " ").trim();
    const payload = `${capability}:${promptVersion}:${contextVersion}:${normXml}:${normReq}`;

    const msgBuffer = new TextEncoder().encode(payload);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Retrieves an entry from memory cache (checking expiration).
   */
  public static get<T = any>(key: string, now: Date = new Date()): CacheEntry<T> | null {
    const entry = this.memoryCache.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= now.getTime()) {
      this.memoryCache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Stores a successful response in memory cache.
   * NEVER store errors or malformed results.
   */
  public static set<T = any>(
    key: string,
    capability: string,
    promptVersion: string,
    contextVersion: string,
    data: T,
    rawText: string,
    provider: string,
    model: string,
    ttlSeconds: number = 900, // 15 minutes default
    now: Date = new Date()
  ): void {
    if (!data || !rawText) {
      return; // Do not cache invalid/empty
    }

    // Evict oldest if full (simple LRU approximation via insertion order)
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) {
        this.memoryCache.delete(firstKey);
      }
    }

    const nowMs = now.getTime();
    this.memoryCache.set(key, {
      key,
      capability,
      promptVersion,
      contextVersion,
      data,
      rawText,
      provider,
      model,
      createdAt: nowMs,
      expiresAt: nowMs + ttlSeconds * 1000,
    });
  }

  /**
   * Clears the cache (used in test suites).
   */
  public static clear(): void {
    this.memoryCache.clear();
  }
}
