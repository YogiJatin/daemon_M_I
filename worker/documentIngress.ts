/**
 * worker/documentIngress.ts — Document Ingress Pipeline
 *
 * Ingests PDF, DOCX, Markdown, and TXT documents:
 * - Content-addressed storage in D1 attachments table
 * - Chunks text for retrieval and AI context
 * - Dispatches through swappable DocumentProvider interface
 */

import { DocumentProvider, ExtractionResult, DocumentExtractionOptions, AttachmentRecord, AttachmentChunk } from './inputTypes';
import { AttachmentService } from './attachmentService';
import { StandardTextExtractor } from './providers/document/textExtractor';
import { MockDocumentProvider } from './providers/mock/mockIngressProviders';

export class DocumentIngress {
  private provider: DocumentProvider;

  constructor(provider?: DocumentProvider) {
    this.provider = provider || new StandardTextExtractor();
  }

  static createDefault(isMock: boolean = false): DocumentIngress {
    if (isMock) {
      return new DocumentIngress(new MockDocumentProvider());
    }
    return new DocumentIngress(new StandardTextExtractor());
  }

  async processDocument(
    db: D1Database,
    filename: string,
    mimeType: string,
    docData: Uint8Array | ArrayBuffer | string,
    options?: DocumentExtractionOptions,
    now: Date = new Date()
  ): Promise<{
    extraction: ExtractionResult;
    attachment: AttachmentRecord;
    chunks: AttachmentChunk[];
    isDuplicate: boolean;
  }> {
    // 1. Content-addressed storage & deduplication
    const { attachment, isDuplicate } = await AttachmentService.getOrCreateAttachment(
      db,
      filename,
      mimeType,
      docData,
      { source: 'document_ingress' },
      now
    );

    // 2. Extract plain text
    const extraction = await this.provider.extractDocument(docData, mimeType, options);

    // 3. Chunk text if not duplicate or chunks not present
    let chunks: AttachmentChunk[] = [];
    if (isDuplicate) {
      chunks = await AttachmentService.getChunks(db, attachment.id);
    }

    if (chunks.length === 0 && extraction.text) {
      chunks = await AttachmentService.createChunks(db, attachment.id, extraction.text, 600, 100, now);
    }

    return {
      extraction,
      attachment,
      chunks,
      isDuplicate,
    };
  }
}
