/**
 * worker/attachmentService.ts — Content-Addressed Attachment & Chunking Service
 *
 * Implements content-addressed storage (SHA-256) and token-bounded chunking:
 * - SHA-256 deduplication: duplicate files reuse the same attachment row
 * - Document chunking: splits extracted text into indexed token-bounded chunks
 * - D1 persistence without duplicating raw payloads in multiple tables
 */

import { AttachmentRecord, AttachmentChunk } from './inputTypes';

export class AttachmentService {
  /**
   * Computes SHA-256 hash of a string or binary buffer.
   */
  static async computeHash(data: Uint8Array | ArrayBuffer | string): Promise<string> {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as ArrayBufferView<ArrayBuffer>);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Stores an attachment or reuses existing one if SHA-256 matches (deduplication).
   */
  static async getOrCreateAttachment(
    db: D1Database,
    filename: string,
    mimeType: string,
    data: Uint8Array | ArrayBuffer | string,
    metadata: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<{ attachment: AttachmentRecord; isDuplicate: boolean }> {
    const sha256 = await this.computeHash(data);
    const byteSize = typeof data === 'string'
      ? new TextEncoder().encode(data).length
      : data.byteLength;

    // Check existing attachment
    const existing = await db
      .prepare('SELECT * FROM attachments WHERE sha256_hash = ?')
      .bind(sha256)
      .first<any>();

    if (existing) {
      return {
        attachment: {
          id: existing.id,
          filename: existing.filename,
          mimeType: existing.mime_type,
          byteSize: existing.byte_size,
          sha256Hash: existing.sha256_hash,
          storagePath: existing.storage_path,
          metadata: existing.metadata_json ? JSON.parse(existing.metadata_json) : undefined,
          createdAt: existing.created_at,
        },
        isDuplicate: true,
      };
    }

    const id = `att_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    await db
      .prepare(
        `INSERT INTO attachments (id, filename, mime_type, byte_size, sha256_hash, storage_path, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        filename,
        mimeType,
        byteSize,
        sha256,
        null,
        JSON.stringify(metadata),
        nowIso
      )
      .run();

    return {
      attachment: {
        id,
        filename,
        mimeType,
        byteSize,
        sha256Hash: sha256,
        storagePath: null,
        metadata,
        createdAt: nowIso,
      },
      isDuplicate: false,
    };
  }

  /**
   * Chunks document text into indexed slices (default 500 characters, ~125 tokens).
   */
  static async createChunks(
    db: D1Database,
    attachmentId: string,
    fullText: string,
    chunkSizeChars: number = 600,
    overlapChars: number = 100,
    now: Date = new Date()
  ): Promise<AttachmentChunk[]> {
    if (!fullText || fullText.trim().length === 0) return [];

    const chunks: AttachmentChunk[] = [];
    const text = fullText.trim();
    let start = 0;
    let index = 0;
    const nowIso = now.toISOString();

    while (start < text.length) {
      let end = start + chunkSizeChars;
      if (end < text.length) {
        // Try to break at a paragraph or sentence boundary
        const newlineBreak = text.lastIndexOf('\n', end);
        if (newlineBreak > start + 200) {
          end = newlineBreak + 1;
        } else {
          const sentenceBreak = text.lastIndexOf('. ', end);
          if (sentenceBreak > start + 200) {
            end = sentenceBreak + 2;
          }
        }
      } else {
        end = text.length;
      }

      const chunkText = text.slice(start, end).trim();
      if (chunkText.length > 0) {
        const chunkId = `chk_${crypto.randomUUID()}`;
        // Approximate token count: 1 token ~ 4 chars
        const tokenCount = Math.ceil(chunkText.length / 4);

        chunks.push({
          id: chunkId,
          attachmentId,
          chunkIndex: index,
          chunkText,
          tokenCount,
          createdAt: nowIso,
        });

        index++;
      }

      start = end - (end < text.length ? overlapChars : 0);
      if (start >= text.length) break;
    }

    // Persist chunks in batch
    if (chunks.length > 0) {
      const stmts = chunks.map((c) =>
        db
          .prepare(
            `INSERT INTO attachment_chunks (id, attachment_id, chunk_index, chunk_text, token_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(c.id, c.attachmentId, c.chunkIndex, c.chunkText, c.tokenCount, c.createdAt)
      );
      await db.batch(stmts);
    }

    return chunks;
  }

  /**
   * Loads chunks for an attachment in strict deterministic index order.
   */
  static async getChunks(db: D1Database, attachmentId: string): Promise<AttachmentChunk[]> {
    const rows = await db
      .prepare('SELECT * FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index ASC')
      .bind(attachmentId)
      .all<any>();

    return (rows.results || []).map((r) => ({
      id: r.id,
      attachmentId: r.attachment_id,
      chunkIndex: r.chunk_index,
      chunkText: r.chunk_text,
      tokenCount: r.token_count,
      createdAt: r.created_at,
    }));
  }
}
